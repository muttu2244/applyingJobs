/* popup-jobs.js — the boards and the jobs live in the EXTENSION now.
 *
 * Loads the real extension in real Chromium, seeds two connected boards with
 * listings that carry the details a card must show (experience, location,
 * pay, how old the post is), then opens the actual popup page
 * (chrome-extension://<id>/popup.html) and asserts:
 *   1. one card per job, each carrying the board it came from,
 *   2. experience / location / salary chips rendered from the scraped text,
 *   3. board chips reflect connection state (green = connected),
 *   4. Approve on a card reaches the dashboard and flips the button,
 *   5. the popup's fill controls still exist alongside the feed.
 *
 * Safety: snapshots state.json / harvest.json / ranked_jobs.json and restores
 * all three byte-for-byte (harvest.json removed if it did not exist).
 * usage: node popup-jobs.js   (server must be running: node server.js)
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
const PROFILE = path.join(__dirname, ".profile-popup");
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

const JOBS = [
  {
    title: "Senior Site Reliability Engineer", company: "Zeta Suite",
    location: "Bengaluru, Karnataka", experience: "5-8 Yrs", salary: "₹25-40 LPA",
    listed: "2 days ago", url: "https://www.naukri.com/senior-sre-zeta-suite-4000000001",
  },
  {
    title: "MLOps Engineer (Kubernetes, MLflow)", company: "Fractal Analytics",
    location: "Remote", experience: "0-3 Yrs",
    listed: "just posted", url: "https://www.naukri.com/mlops-engineer-fractal-4000000002",
  },
  {
    title: "Platform Engineer — AWS, Terraform", company: "Booking Holdings",
    location: "Hyderabad, Telangana", experience: "3-6 years",
    listed: "5 days ago", url: "https://in.indeed.com/viewjob?jk=platform-engineer-booking-01",
  },
];

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;
  let ctx = null;

  try {
    /* --- seed: two connected boards, three detailed listings --- */
    fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }, null, 1));
    const boardIds = JSON.parse(stateSnap.toString("utf8")).boards.map((b) => b.id);
    for (const id of boardIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });
    for (const id of ["naukri", "indeed"]) {
      await req("POST", `/api/boards/${id}/connect`, { connected: true });
      await req("POST", `/api/boards/${id}/session`, { ok: true, detail: "popup test: signed in" });
    }
    const h1 = await req("POST", "/api/harvest", { board: "naukri", jobs: JOBS.filter((j) => j.url.includes("naukri")) });
    const h2 = await req("POST", "/api/harvest", { board: "indeed", jobs: JOBS.filter((j) => j.url.includes("indeed")) });
    check("seed: naukri listings accepted", h1.body && h1.body.added === 2, h1.body);
    check("seed: indeed listing accepted", h2.body && h2.body.added === 1, h2.body);

    const boot = (await req("GET", "/api/bootstrap")).body;
    check("seed: bootstrap exposes experience", boot.jobs.every((j) => typeof j.experience === "string"), boot.jobs[0]);
    check("seed: bootstrap exposes 3 gated jobs", boot.jobs.length === 3, boot.jobs.length);

    /* --- real extension in a real browser --- */
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: { width: 400, height: 700 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    check("extension id resolved", /^[a-p]{32}$/.test(extId), extId);

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".job").length >= 3, null, { timeout: 15000 });

    const cards = await page.$$eval(".job", (els) => els.map((el) => ({
      board: (el.querySelector(".board") || {}).textContent || "",
      title: (el.querySelector("h3") || {}).textContent || "",
      company: (el.querySelector(".co") || {}).textContent || "",
      exp: (el.querySelector(".fact.exp") || {}).textContent || "",
      loc: (el.querySelector(".fact.loc") || {}).textContent || "",
      facts: [...el.querySelectorAll(".fact")].map((f) => f.textContent),
      approve: (el.querySelector(".mini") || {}).textContent || "",
    })));

    check("popup: one card per job", cards.length === 3, cards.length);
    check("popup: every card names its board",
      cards.every((c) => /naukri|indeed/i.test(c.board)), cards.map((c) => c.board));
    check("popup: both boards represented",
      new Set(cards.map((c) => c.board.toLowerCase())).size === 2, cards.map((c) => c.board));
    check("popup: every card shows years of experience",
      cards.every((c) => /\d/.test(c.exp)), cards.map((c) => c.exp));
    check("popup: every card shows a location", cards.every((c) => c.loc.length > 2), cards.map((c) => c.loc));
    check("popup: salary chip rendered where known",
      cards.some((c) => c.facts.some((f) => /₹|lpa/i.test(f))), cards.map((c) => c.facts));
    check("popup: titles and companies present",
      cards.every((c) => c.title.length > 5 && c.company.length > 1), cards);

    const status = await page.$eval("#status", (el) => el.textContent);
    check("popup: status counts connected boards", /2\s*boards connected/i.test(status), status);
    check("popup: status counts jobs", /3\s*jobs/i.test(status), status);

    const chip = await page.$eval('.chip[data-board="naukri"]', (el) => ({
      cls: el.className, text: el.textContent,
    }));
    check("popup: connected board chip is green", /\bon\b/.test(chip.cls), chip);
    const chipOff = await page.$eval('.chip[data-board="hirist"]', (el) => el.className).catch(() => null);
    check("popup: unconnected board chip is not green",
      chipOff === null || !/\bon\b/.test(chipOff), chipOff);

    /* Approve on the top card must reach the dashboard. */
    const firstId = await page.$eval(".job", (el) => Number(el.dataset.job));
    await page.click(".job .mini");
    await page.waitForFunction(
      () => /Approved/i.test(document.querySelector(".job .mini").textContent),
      null, { timeout: 8000 }
    );
    const after = (await req("GET", "/api/bootstrap")).body;
    check("popup: approve reached the dashboard",
      after.decisions[firstId] && after.decisions[firstId].action === "approve", after.decisions[firstId]);

    check("popup: fill controls still present",
      (await page.$$("footer #go, footer #fillonly, footer #autopilot")).length === 3);

    /* The agent actions: fetch-all lives here, and apply starts a real run. */
    const fetchBtn = await page.$eval("#cta button", (el) => ({ text: el.textContent, disabled: el.disabled }));
    check("popup: fetch-all action present and enabled", /Fetch all jobs/.test(fetchBtn.text) && !fetchBtn.disabled, fetchBtn);
    const applyState = await page.$$eval("#cta button", (els) => ({ disabled: els[1].disabled, text: els[1].textContent }));
    check("popup: approving enables apply with a count", !applyState.disabled && /\(\d+\)/.test(applyState.text), applyState);

    const pagesBefore = ctx.pages().length;
    await page.click("#cta button.go");
    const runStarted = await (async () => {
      for (let i = 0; i < 20; i++) {
        const b = (await req("GET", "/api/bootstrap")).body;
        if (b.run && b.run.total) return b.run;
        await page.waitForTimeout(400);
      }
      return null;
    })();
    check("popup: apply starts a queued run", !!runStarted && runStarted.total >= 1, runStarted);
    let tabOpened = false;
    for (let i = 0; i < 20; i++) {
      if (ctx.pages().length > pagesBefore) { tabOpened = true; break; }
      await page.waitForTimeout(300);
    }
    check("popup: run opens the first job in a tab", tabOpened, ctx.pages().length);
    const runText = await page.$eval("#runline", (el) => el.textContent);
    check("popup: run progress is shown", /Applying|Run finished/.test(runText), runText);
    await req("POST", "/api/apply/stop");                // leave no run running
    await page.waitForTimeout(600);

    /* Boards are managed here too: the × on a connected chip disconnects it,
     * and that board's jobs must leave the list immediately. */
    await page.click('.chip[data-board="indeed"] ~ .x');
    await page.waitForFunction(() => document.querySelectorAll(".job").length === 2, null, { timeout: 8000 });
    check("popup: disconnecting a board removes its jobs", true);
    const chipAfter = await page.$eval('.chip[data-board="indeed"]', (el) => el.className);
    check("popup: disconnected chip is no longer green", !/\bon\b/.test(chipAfter), chipAfter);
    const boot2 = (await req("GET", "/api/bootstrap")).body;
    check("popup: disconnect reached the dashboard",
      boot2.boards.find((b) => b.id === "indeed").connected === false,
      boot2.boards.find((b) => b.id === "indeed"));

    const shot = path.join(__dirname, "popup.png");
    await page.screenshot({ path: shot });
    console.log("=== screenshot: " + shot);
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
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
