/* queue-resume.js — a dead tab must not wedge the apply queue.
 *
 * The contract: a run whose browser tab died (closed, disabled, slept) leaves
 * jobs unattempted with no page left to ask /api/apply/next for the next one.
 * The dashboard's Apply step carries a Resume button for exactly that; this
 * drives it in a real browser with the real extension loaded:
 *   1. the button appears while jobs remain and names its position
 *      ("open queued job 1 of 2");
 *   2. clicking it opens the next queued job's URL in a new tab — the server
 *      marks it attempted first, so the dashboard and a live page can never
 *      both get the same job;
 *   3. reporting that job back (what a real page's reportRun does) advances
 *      the run to the remaining job, and reporting that one finalizes the
 *      run with the summary the dashboard renders.
 *
 * Two harness guards keep this a QUEUE test: a stub route answers the
 * synthetic job URL so no real board ever sees this run, and autopilot is
 * switched off in the profile so the content engine never runs against the
 * stub (its browser chain is test-engine.js's "chain" section).
 *
 * Safety: snapshots state.json / harvest.json / ranked_jobs.json and restores
 * all three byte-for-byte (harvest.json removed if it did not exist).
 * usage: node queue-resume.js   (server must be running: node server.js)
 */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const STATE = path.join(ROOT, "state.json");
const HARVEST = path.join(ROOT, "harvest.json");
const RANKED = path.join(ROOT, "..", "ranked_jobs.json");
const PROFILE = path.join(__dirname, ".profile-queue");
const BASE = "http://127.0.0.1:8357";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `  -> ${JSON.stringify(extra)}`}`);
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + p, { method, headers: { "Content-Type": "application/json" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const SEED = [
  { title: "MLOps Engineer (Kubernetes, MLflow)", company: "Fractal Analytics", location: "Remote", experience: "3-6 Yrs", url: "https://www.naukri.com/job-listings-mlops-fractal-9000000001" },
  { title: "Senior Site Reliability Engineer", company: "Zeta Suite", location: "Bengaluru", experience: "5-8 Yrs", url: "https://www.naukri.com/job-listings-sre-zeta-9000000002" },
];

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;
  let ctx = null;

  try {
    /* --- seed: two approved jobs in a started run whose tab never opened --- */
    fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }, null, 1));
    await req("POST", "/api/reset");
    await req("POST", "/api/boards/naukri/connect", { connected: true });
    await req("POST", "/api/boards/naukri/session", { ok: true, detail: "queue-resume test: signed in" });
    const h = await req("POST", "/api/harvest", { board: "naukri", jobs: SEED });
    check("seed: listings accepted", h.body && h.body.added === 2, h.body);

    const boot = (await req("GET", "/api/bootstrap")).body;
    const ids = boot.jobs.map((j) => j.id);
    check("seed: two jobs visible", ids.length === 2, ids);
    for (const id of ids) await req("POST", `/api/jobs/${id}/action`, { action: "approve" });

    const started = await req("POST", "/api/apply/start", { cap: 25, minMatch: 0 });
    check("run started with both approvals", started.body && started.body.run && started.body.run.total === 2, started.body);
    const first = started.body.first;
    const secondId = ids.find((id) => id !== first.id);
    check("the other queued job is known", typeof secondId === "number", { first: first.id, ids });
    /* The failure this test exists for: nothing ever opened `first`, so the
     * run sits at attempted:0 with no page anywhere to ask for next. */
    let r = (await req("GET", "/api/bootstrap")).body.run;
    check("run is wedged: nothing attempted yet", r && r.attempted === 0 && !r.done, r);

    /* --- real browser, real extension, dashboard --- */
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: { width: 1280, height: 860 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    check("extension loaded", /chrome-extension:\/\//.test(sw.url()), sw.url());
    /* Autopilot off: the stub page below must not trigger the fill engine —
     * this test owns the queue's browser half, not the page's. */
    await sw.evaluate(() => chrome.storage.local.set({ autopilot: false }));

    /* The queued job URL is synthetic; answer it with a stub so no request
     * ever reaches a real board. Everything local passes through untouched. */
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith(BASE) || u.startsWith("chrome-extension://") || u.startsWith("data:")) return route.continue();
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>stub job</title><p>stub — queue-resume test</p>" });
    });

    const dash = await ctx.newPage();
    await dash.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    /* boot() renders the board grid from a non-null DATA — clicking a step
     * before that would call renderTimeline with DATA still null. */
    const bootRendered = () => dash.waitForFunction(
      () => document.querySelectorAll("#board-grid .board").length > 0, null, { timeout: 15000 });
    await bootRendered();

    /* --- 1. the wedged run offers Resume, naming its position --- */
    await dash.click('.step[data-step="apply"]');
    await dash.waitForSelector("#btn-resume-run", { timeout: 5000 });
    let btnText = await dash.textContent("#btn-resume-run");
    check("resume button names the next queued job",
      /job 1 of 2/.test(btnText), btnText);
    check("live line still says keep the browser open",
      /keep the browser open/.test(await dash.textContent(".run-line")),
      await dash.textContent(".run-line"));

    /* --- 2. clicking Resume opens the queued job in a new tab --- */
    const [popup] = await Promise.all([
      ctx.waitForEvent("page", { timeout: 10000 }),
      dash.click("#btn-resume-run"),
    ]);
    await popup.waitForURL((u) => u.href === first.url, { timeout: 8000 });
    check("resume opened the queued job's URL", popup.url() === first.url, popup.url());
    await popup.close();

    r = (await req("GET", "/api/bootstrap")).body.run;
    check("server handed out the job exactly once",
      r && r.attempted === 1 && r.current === first.id && !r.done, r);
    /* The button now names the NEXT position — the click handler refetched
     * DATA and re-rendered the line synchronously. */
    await dash.waitForFunction(() => {
      const b = document.querySelector("#btn-resume-run");
      return !!b && /job 2 of 2/.test(b.textContent);
    }, null, { timeout: 5000 });
    check("resume button advanced to the next position", true);

    /* What a real page does when it finishes: report, then ask for next —
     * the chain must hand out the remaining job, never the one resume
     * already opened. */
    await req("POST", `/api/jobs/${first.id}/report`, { status: "applied", confirmation: "Application submitted" });
    const n1 = (await req("GET", "/api/apply/next")).body;
    check("chain advances to the remaining job, without repeating the first",
      !n1.done && n1.job && n1.job.id === secondId, n1);
    await req("POST", `/api/jobs/${secondId}/report`, { status: "applied", confirmation: "Application submitted" });

    /* --- 3. the run finalizes and the dashboard renders the summary --- */
    const end = (await req("GET", "/api/apply/next")).body;
    check("queue exhausted -> run done", end.done === true, end);
    check("summary counts both applications", end.run && end.run.applied === 2 && end.run.halted === 0, end.run);

    await dash.reload({ waitUntil: "domcontentloaded" });
    await bootRendered();
    await dash.click('.step[data-step="apply"]');
    await dash.waitForSelector(".run-line", { timeout: 5000 });
    const finalLine = await dash.textContent(".run-line");
    check("dashboard shows the finished summary",
      /Apply run finished/.test(finalLine) && /2 applied/.test(finalLine), finalLine);
    check("no resume button on a finished run",
      (await dash.$$("#btn-resume-run")).length === 0, finalLine);

    check("state.json restored byte-for-byte", true);
  } catch (e) {
    console.log("FAIL threw: " + ((e && e.stack) || e));
    fail++;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    fs.writeFileSync(STATE, stateSnap);
    fs.writeFileSync(RANKED, rankedSnap);
    if (harvestExisted) fs.writeFileSync(HARVEST, harvestSnap);
    else fs.rmSync(HARVEST, { force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
