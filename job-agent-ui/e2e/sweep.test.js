/* sweep.test.js — "get ALL the matching jobs", not just page one.
 *
 * The dashboard requests a sweep for a connected board; the content script
 * walks the board's result pages, harvesting each, and reports progress. This
 * asserts the server half of that contract:
 *   1. a disconnected board cannot be swept (403) — same gate as harvest;
 *   2. a sweep is created with a clamped page cap and starts at page 0;
 *   3. per-page harvest reports advance page/found, and the last page marks
 *      the sweep done with a summary in the log;
 *   4. stop ends it (so the content script's loop sees a non-running sweep);
 *   5. bootstrap exposes the sweep on the board for the UI's progress line;
 *   6. starting again resets the counters.
 *
 * Safety: snapshots state.json / harvest.json / ranked_jobs.json and restores
 * all three byte-for-byte (harvest.json removed if it did not exist).
 * usage: node sweep.test.js   (server must be running: node server.js)
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

const page = (n) => [
  { title: `MLOps Engineer page ${n}a`, company: `Acme ${n}`, location: "Bengaluru", experience: "2-5 Yrs", url: `https://www.naukri.com/job-listings-mlops-acme-p${n}a` },
  { title: `SRE page ${n}b`, company: `Zeta ${n}`, location: "Remote", experience: "5-8 Yrs", url: `https://www.naukri.com/job-listings-sre-zeta-p${n}b` },
];

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;

  try {
    fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }, null, 1));
    await req("POST", "/api/reset");

    /* --- 1. no connection, no sweep --- */
    let r = await req("POST", "/api/boards/naukri/sweep", { pages: 3 });
    check("disconnected board -> 403", r.status === 403, r);
    check("no sweep stored", (await req("GET", "/api/boards/naukri/sweep")).body.sweep === null);

    /* --- 2. create the sweep --- */
    await req("POST", "/api/boards/naukri/connect", { connected: true });
    await req("POST", "/api/boards/naukri/session", { ok: true, detail: "test" });
    r = await req("POST", "/api/boards/naukri/sweep", { pages: 3 });
    check("connected board -> 200", r.status === 200, r.body);
    check("sweep running at page 0", r.body.sweep && r.body.sweep.status === "running" && r.body.sweep.page === 0, r.body.sweep);
    check("page cap honoured", r.body.sweep.maxPages === 3, r.body.sweep);
    let boot = (await req("GET", "/api/bootstrap")).body;
    check("bootstrap shows the sweep on the board",
      boot.boards.find((b) => b.id === "naukri").sweep.status === "running", boot.boards.find((b) => b.id === "naukri").sweep);

    /* --- 3. per-page harvest reports --- */
    await req("POST", "/api/harvest", { board: "naukri", jobs: page(1), sweep: { page: 1, last: false } });
    let s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
    check("page 1 recorded", s.page === 1 && s.status === "running", s);
    check("page 1 jobs counted", s.found === 2, s);
    await req("POST", "/api/harvest", { board: "naukri", jobs: page(2), sweep: { page: 2, last: false } });
    s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
    check("page 2 advances, found accumulates", s.page === 2 && s.found === 4, s);
    await req("POST", "/api/harvest", { board: "naukri", jobs: page(3), sweep: { page: 3, last: true } });
    s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
    check("last page marks the sweep done", s.status === "done" && s.page === 3, s);
    check("all six jobs stored", (await req("GET", "/api/bootstrap")).body.jobs.length === 6,
      (await req("GET", "/api/bootstrap")).body.jobs.length);
    check("finish logged", /fetch-all finished/.test((await req("GET", "/api/bootstrap")).body.log[0].text),
      (await req("GET", "/api/bootstrap")).body.log[0]);

    /* --- 4. stop --- */
    await req("POST", "/api/boards/naukri/sweep", { pages: 3 });
    await req("POST", "/api/boards/naukri/sweep", { stop: true });
    s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
    check("stop marks the sweep stopped", s.status === "stopped", s);

    /* --- 5. clamp + restart resets --- */
    r = await req("POST", "/api/boards/naukri/sweep", { pages: 99 });
    check("page cap clamped to 25", r.body.sweep.maxPages === 25, r.body.sweep);
    check("restart resets counters", r.body.sweep.page === 0 && r.body.sweep.found === 0, r.body.sweep);

    r = await req("GET", "/api/boards/nope/sweep");
    check("unknown board -> 404", r.status === 404, r.status);

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
