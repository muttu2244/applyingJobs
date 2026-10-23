/* apply-run.test.js — "then apply" is a queue the agent walks by itself.
 *
 * Contract under test (server side; the browser side is content.js's
 * advanceRun, which just asks /api/apply/next and opens what it gets):
 *   1. a run only contains jobs the user approved — nothing approved, no run;
 *   2. the queue is capped and ordered by match %, best first;
 *   3. /next hands out one job at a time and never repeats one;
 *   4. a report (applied / captcha / failed) is recorded in the run, and a
 *      halted job does NOT stop the run;
 *   5. exhausting the queue finalizes the run with a summary in the log;
 *   6. stop ends the run early; an explicit id list is the user picking jobs;
 *   7. the OTHER queue — a sweep whose board tab died is marked stalled
 *      instead of claiming "fetching…" forever: the stall is logged once,
 *      a late progress report from a live-but-throttled tab revives it, and
 *      a restart always works (nothing can wedge the Fetch button).
 *
 * Safety: snapshots state.json / harvest.json / ranked_jobs.json and restores
 * all three byte-for-byte (harvest.json removed if it did not exist).
 * usage: node apply-run.test.js   (server must be running: node server.js)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state.json");
const HARVEST = path.join(ROOT, "harvest.json");
const RANKED = path.join(ROOT, "..", "ranked_jobs.json");
const BASE = "http://127.0.0.1:8357";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
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

const approve = (id) => req("POST", `/api/jobs/${id}/action`, { action: "approve" });

const SEED = [
  { title: "Senior Site Reliability Engineer", company: "Zeta", location: "Bengaluru", experience: "5-8 Yrs", url: "https://www.naukri.com/job-listings-sre-zeta-5000000001" },
  { title: "MLOps Engineer", company: "Fractal", location: "Remote", experience: "0-3 Yrs", url: "https://www.naukri.com/job-listings-mlops-fractal-5000000002" },
  { title: "Platform Engineer", company: "Booking", location: "Hyderabad", experience: "3-6 Yrs", url: "https://www.naukri.com/job-listings-platform-booking-5000000003" },
];

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;

  try {
    fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }, null, 1));
    /* A clean slate: the user's own approvals must not seed this test's run. */
    await req("POST", "/api/reset");
    await req("POST", "/api/boards/naukri/connect", { connected: true });
    await req("POST", "/api/boards/naukri/session", { ok: true, detail: "test" });
    const h = await req("POST", "/api/harvest", { board: "naukri", jobs: SEED });
    check("seed: listings accepted", h.body && h.body.added === 3, h.body);

    const boot = (await req("GET", "/api/bootstrap")).body;
    const jobs = boot.jobs.slice().sort((a, b) => b.match - a.match);
    check("seed: three jobs visible", jobs.length === 3, jobs.length);
    const [best, mid, worst] = jobs;

    /* --- 1. nothing approved -> no run --- */
    let r = await req("POST", "/api/apply/start", { cap: 25 });
    check("no approvals -> 400", r.status === 400, r);
    check("no run created", (await req("GET", "/api/bootstrap")).body.run === null);

    /* --- 1b. an approval on a DISCONNECTED board never enters a run --- */
    await req("POST", "/api/boards/naukri/connect", { connected: false });
    await approve(best.id);
    r = await req("POST", "/api/apply/start", { cap: 25 });
    check("approval on a disconnected board is excluded", r.status === 400, r);
    await req("POST", "/api/boards/naukri/connect", { connected: true });
    await req("POST", "/api/boards/naukri/session", { ok: true, detail: "test" });

    /* --- 2. approvals become the queue, best first, capped --- */
    await approve(best.id);
    await approve(mid.id);
    await approve(worst.id);
    r = await req("POST", "/api/apply/start", { cap: 2, minMatch: 0 });
    check("start -> 200", r.status === 200, r.body);
    check("cap respected", r.body.run && r.body.run.total === 2, r.body.run);
    check("best match is first", r.body.first && r.body.first.id === best.id, r.body.first);
    check("queued jobs marked apply",
      (await req("GET", "/api/bootstrap")).body.decisions[best.id].action === "apply");
    check("log records the run", /apply run started/.test(
      (await req("GET", "/api/bootstrap")).body.log[0].text));

    /* --- 3. /next hands out one at a time --- */
    const n1 = (await req("GET", "/api/apply/next")).body;
    check("next -> first job", !n1.done && n1.job && n1.job.id === best.id, n1);
    check("next reports progress", n1.progress && n1.progress.i === 1 && n1.progress.n === 2, n1.progress);
    const again = (await req("GET", "/api/apply/next")).body;
    check("next never repeats a handed-out job", again.job && again.job.id !== best.id, again);

    /* --- 4. reports land in the run; a halt does not stop it --- */
    await req("POST", `/api/jobs/${best.id}/report`, { status: "applied", confirmation: "Application submitted" });
    await req("POST", `/api/jobs/${mid.id}/report`, { status: "captcha", message: "reCAPTCHA on the form" });
    const mid1 = (await req("GET", "/api/bootstrap")).body.run;
    check("run counts one applied", mid1 && mid1.applied === 1, mid1);
    check("run counts one halted", mid1 && mid1.halted === 1, mid1);
    check("bootstrap exposes the run", mid1 && mid1.total === 2 && !mid1.done, mid1);

    /* --- 5. queue exhausted -> done + summary --- */
    const end = (await req("GET", "/api/apply/next")).body;
    check("exhausted run reports done", end.done === true, end);
    check("summary counts both outcomes", end.run && end.run.applied === 1 && end.run.halted === 1, end.run);
    const afterBoot = (await req("GET", "/api/bootstrap")).body;
    check("run marked done in bootstrap", afterBoot.run && afterBoot.run.done === true, afterBoot.run);
    check("finish logged", /apply run finished/.test(afterBoot.log[0].text), afterBoot.log[0]);
    check("applied decision survives the run", afterBoot.decisions[best.id].action === "applied");

    /* --- 6. stop, explicit ids, minMatch floor --- */
    await approve(worst.id);
    r = await req("POST", "/api/apply/start", { cap: 25 });
    check("second run starts", r.status === 200 && r.body.run.done === false, r.body);
    const stopped = (await req("POST", "/api/apply/stop")).body;
    check("stop finalizes the run", stopped.run && stopped.run.done === true, stopped);
    check("stopped run logged", /apply run stopped/.test(
      (await req("GET", "/api/bootstrap")).body.log[0].text));

    r = await req("POST", "/api/apply/start", { ids: [worst.id], cap: 25 });
    check("explicit ids start a run", r.status === 200 && r.body.run.total === 1, r.body);
    await req("POST", "/api/apply/stop");

    await req("POST", `/api/jobs/${worst.id}/action`, { action: "approve" });
    r = await req("POST", "/api/apply/start", { cap: 25, minMatch: 100 });
    check("minMatch floor can empty the queue", r.status === 400, r.body);

    /* --- 7. sweep liveness: a dead board tab must not leave a sweep
     *        claiming "fetching…" forever with the Fetch button disabled.
     *        The server reads state.json per request, so aging the record
     *        on disk IS how a tab that stopped reporting looks to it. --- */
    const ageSweep = (ms) => {
      const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
      s.sweeps.naukri.updatedAt = Date.now() - ms;
      fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
    };
    const sweepStatus = async () => {
      const b = (await req("GET", "/api/bootstrap")).body;
      const nb = (b.boards || []).find((x) => x.id === "naukri") || {};
      return nb.sweep || null;
    };

    const sw1 = await req("POST", "/api/boards/naukri/sweep", { pages: 5 });
    check("sweep starts running", sw1.body && sw1.body.sweep && sw1.body.sweep.status === "running", sw1.body);
    check("fresh sweep reports running on the dashboard", ((await sweepStatus()) || {}).status === "running", await sweepStatus());

    ageSweep(6 * 60000);                            // the board tab died
    const stalled = await sweepStatus();
    check("dead sweep is stalled, not fetching forever", stalled && stalled.status === "stalled", stalled);
    let log = (await req("GET", "/api/bootstrap")).body.log;
    check("stall is logged once", log.filter((l) => /fetch-all stalled/.test(l.text)).length === 1, log[0]);
    const swGet = (await req("GET", "/api/boards/naukri/sweep")).body;
    check("sweep endpoint agrees: stalled", swGet.sweep && swGet.sweep.status === "stalled", swGet);
    log = (await req("GET", "/api/bootstrap")).body.log;
    check("stall does not re-log on every read", log.filter((l) => /fetch-all stalled/.test(l.text)).length === 1);

    const revive = await req("POST", "/api/boards/naukri/sweep", { progress: 1 });
    check("late progress report accepted", revive.status === 200, revive.body);
    check("a live tab is put back to running", ((await sweepStatus()) || {}).status === "running", await sweepStatus());

    ageSweep(6 * 60000);
    await req("GET", "/api/bootstrap");             // marks it stalled
    const sw2 = await req("POST", "/api/boards/naukri/sweep", { pages: 5 });
    check("a stalled sweep can always be restarted", sw2.body && sw2.body.sweep && sw2.body.sweep.status === "running", sw2.body);
    await req("POST", "/api/boards/naukri/sweep", { stop: true });  // tidy before restore

    check("state.json restored byte-for-byte", true);
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
    fail++;
  } finally {
    fs.writeFileSync(STATE, stateSnap);
    fs.writeFileSync(RANKED, rankedSnap);
    if (harvestExisted) fs.writeFileSync(HARVEST, harvestSnap);
    else fs.rmSync(HARVEST, { force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
