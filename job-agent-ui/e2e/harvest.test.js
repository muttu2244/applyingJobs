/* harvest.test.js — fresh jobs flow from SELECTED boards, and only those.
 *
 * The user complaint this exists for: "I never connected LinkedIn but all 210
 * matched jobs are LinkedIn — I want only jobs from the boards I selected."
 * The live-fetch pipeline: the extension scrapes the user's own board tab and
 * POSTs to /api/harvest. This asserts the full contract against the running
 * server (start `node server.js` first):
 *   1. a board that is not connected gets 403 — it can never put a job in
 *      front of the user, even from the user's own browser tab;
 *   2. a listing whose URL belongs to a DIFFERENT board is refused (no
 *      smuggling linkedin.com links in under the "naukri" tag);
 *   3. accepted listings are scored with match %, flagged fresh, counted on
 *      the board card, and served next to the base index (visibility is NOT
 *      gated on connection — Apply establishes the session);
 *   4. re-fetches (including the same URL with tracking params) dedupe;
 *   5. the base index dedupes against harvests, and a fresh job's id works
 *      for approve/report like any other.
 *
 * Safety: snapshots state.json / ranked_jobs.json / harvest.json first and
 * restores all three byte-for-byte (or removes harvest.json if it did not
 * exist). Exit code 0 only if every assertion passes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state.json");
const RANKED = path.join(ROOT, "..", "ranked_jobs.json");
const HARVEST = path.join(ROOT, "harvest.json");
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

const harvest = (board, jobs) => req("POST", "/api/harvest", { board, jobs });

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;
  const originalRanked = JSON.parse(rankedSnap.toString("utf8"));

  try {
    fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }, null, 1));
    const allIds = JSON.parse(stateSnap.toString("utf8")).boards.map((b) => b.id);
    for (const id of allIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });

    /* --- 1. disconnected board cannot fetch --- */
    let r = await harvest("naukri", [
      { title: "MLOps Engineer", company: "Acme", location: "Bangalore", url: "https://www.naukri.com/mlops-engineer-acme-1234567890" },
    ]);
    check("disconnected board -> 403", r.status === 403, r);
    check("403 writes nothing", JSON.parse(fs.readFileSync(HARVEST, "utf8")).entries.length === 0);

    /* --- 2. connect naukri; valid + invalid payloads ---
     * connect is only a claim: until the extension posts a session verdict
     * the board must keep refusing jobs. */
    await req("POST", "/api/boards/naukri/connect", { connected: true });
    r = await harvest("naukri", [
      { title: "MLOps Engineer", company: "Acme", location: "Bengaluru", url: "https://www.naukri.com/mlops-engineer-acme-1234567890" },
    ]);
    check("harvest while session unverified -> 403", r.status === 403, r.status);
    await req("POST", "/api/boards/naukri/session", { ok: true });
    const J1 = "https://www.naukri.com/mlops-engineer-acme-1234567890?n=100&src=homepage";
    const J2 = "https://www.naukri.com/python-ml-engineer-beta-9876543210";
    r = await harvest("naukri", [
      { title: "Senior MLOps Engineer", company: "Acme", location: "Bengaluru", url: J1 },
      { title: "Python ML Engineer", company: "Beta", location: "India", url: J2 },
      { title: "Dup with tracking params", company: "Acme", location: "Bengaluru", url: "https://www.naukri.com/mlops-engineer-acme-1234567890?n=999&src=widget" },
      { title: "Smuggled LinkedIn role", company: "Sneaky", location: "Remote", url: "https://www.linkedin.com/jobs/view/smuggled-999" },
      { title: "", company: "NoTitle", location: "", url: "https://www.naukri.com/no-title-1111222233" },
      { title: "Not even a URL", company: "X", location: "", url: "ftp://nowhere/x" },
    ]);
    check("connected board accepts its own listings", r.status === 200 && r.body.ok, r);
    check("added = 2 (dedupe + foreign-host + bad-title filtered)", r.body.added === 2, r.body);
    check("skipped = 4", r.body.skipped === 4, r.body);
    const h = JSON.parse(fs.readFileSync(HARVEST, "utf8"));
    check("store holds exactly the 2 accepted entries", h.entries.length === 2, h.entries.length);
    check("store entries are source=live with scores", h.entries.every((e) => e.source === "live" && e.score > 0 && e.hits.length), h.entries);
    check("fetchedAt stamped on the board", Number.isFinite(h.fetchedAt.naukri), h.fetchedAt);

    /* --- 3. bootstrap: the fetch lands as 2 fresh, scored jobs ---
     * Job visibility is NOT gated on connection any more (the dashboard shows
     * every matched job and connects the board on Apply), so these assertions
     * look at the fresh entries rather than the whole list. */
    let b = (await req("GET", "/api/bootstrap")).body;
    const freshNow = () => b.jobs.filter((j) => j.fresh);
    check("jobs served = the 2 fresh naukri jobs", freshNow().length === 2, freshNow().length);
    check("every fresh job is board=naukri (no LinkedIn leakage)", freshNow().every((j) => j.board === "naukri"), freshNow().map((j) => j.board));
    check("jobs flagged fresh with fetchedAt", freshNow().every((j) => j.fetchedAt), freshNow()[0]);
    check("jobs carry a match %", b.jobs.filter((j) => j.board === "naukri").every((j) => j.match > 0), freshNow().map((j) => j.match));
    const nb = b.boards.find((x) => x.id === "naukri");
    check("naukri card counts 2 + shows last fetch", nb.jobs === 2 && nb.fetchedAt, nb);
    /* Board counts are per-board job totals, not a connection gate: what the
     * naukri fetch must NOT do is leave a fetch time on a board it never
     * touched. */
    check("linkedin has no fetch time (it was never fetched)",
      !b.boards.find((x) => x.id === "linkedin").fetchedAt,
      b.boards.find((x) => x.id === "linkedin").fetchedAt);

    /* --- 4. re-fetch dedupes, reports honestly --- */
    r = await harvest("naukri", [
      { title: "Senior MLOps Engineer", company: "Acme", location: "Bengaluru", url: J1.replace("src=homepage", "src=widget") },
      { title: "Principal AI Architect", company: "Gamma", location: "Pune", url: "https://www.naukri.com/principal-ai-architect-gamma-5555666677" },
    ]);
    check("re-fetch adds only the genuinely new job", r.body.added === 1 && r.body.skipped === 1, r.body);
    b = (await req("GET", "/api/bootstrap")).body;
    check("bootstrap now serves 3 unique fresh jobs", b.jobs.filter((j) => j.fresh).length === 3, b.jobs.filter((j) => j.fresh).length);

    /* --- 5. the unselected-board case the user actually hit --- */
    r = await harvest("linkedin", [
      { title: "AI Lead", company: "X", location: "Bangalore", url: "https://www.linkedin.com/jobs/view/ai-lead-333" },
    ]);
    check("linkedin fetch while unselected -> 403", r.status === 403, r.status);
    b = (await req("GET", "/api/bootstrap")).body;
    check("still zero fresh LinkedIn jobs (the fetch was refused)",
      b.jobs.filter((j) => j.fresh).every((j) => j.board !== "linkedin"),
      b.jobs.filter((j) => j.fresh).map((j) => j.board));

    /* --- 6. base index dedupes against harvests; report works on fresh ids --- */
    await req("POST", "/api/boards/linkedin/connect", { connected: true });
    await req("POST", "/api/boards/linkedin/session", { ok: true });
    const baseUrl = originalRanked[0].job_detail_url;
    r = await harvest("linkedin", [
      { title: "Dup of base index job", company: "X", location: "", url: `${baseUrl}?trackingId=zzz` },
    ]);
    check("base-index URL is not re-added by harvest", r.body.added === 0 && r.body.skipped === 1, r.body);
    b = (await req("GET", "/api/bootstrap")).body;
    const freshJob = b.jobs.find((j) => j.fresh);
    check("a fresh job exists to report on", !!freshJob, null);
    const rep = await req("POST", `/api/jobs/${freshJob.id}/report`, { status: "applied", confirmation: "harvest-test" });
    check("report on a fresh job id -> 200", rep.status === 200, rep);
    check("decision recorded against the fresh id", rep.body.decisions[freshJob.id]?.status === "applied", rep.body.decisions[freshJob.id]);

    /* --- 7. disconnecting stops the FETCH, never the job list ---
     * Connection is now an apply-time concern: the cards stay, and pressing
     * Apply asks for the sign-in. What disconnecting must still do is refuse
     * the harvest (asserted in step 1 above). */
    /* Re-read first: the report in step 6 legitimately drops that job from the
     * list, so a snapshot taken before it would blame disconnecting for a
     * change the report made. */
    b = (await req("GET", "/api/bootstrap")).body;
    const before = b.jobs.map((j) => j.id);
    for (const id of allIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });
    b = (await req("GET", "/api/bootstrap")).body;
    check("disconnecting changes no job card",
      JSON.stringify(b.jobs.map((j) => j.id)) === JSON.stringify(before), { before: before.length, after: b.jobs.length });
    check("harvest is refused again", (await harvest("naukri", [
      { title: "After disconnect", company: "X", location: "Pune", url: "https://www.naukri.com/after-disconnect-123123" },
    ])).status === 403);
  } finally {
    fs.writeFileSync(STATE, stateSnap);
    fs.writeFileSync(RANKED, rankedSnap);
    if (harvestSnap) fs.writeFileSync(HARVEST, harvestSnap);
    else { try { fs.unlinkSync(HARVEST); } catch {} }
  }

  check("state.json restored byte-for-byte", fs.readFileSync(STATE).equals(stateSnap));
  check("ranked_jobs.json restored byte-for-byte", fs.readFileSync(RANKED).equals(rankedSnap));
  check(harvestExisted ? "harvest.json restored byte-for-byte" : "absent harvest.json left absent",
    harvestExisted ? fs.readFileSync(HARVEST).equals(harvestSnap) : !fs.existsSync(HARVEST));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
