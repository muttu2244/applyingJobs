/* gating.test.js — the JOB-CARD contract, for every board.
 *
 * What this file used to assert (jobs hidden until their board was connected)
 * is gone: the dashboard is a list of real jobs, and the board connection is
 * established behind the scenes when the user presses Apply. So the contract
 * now is:
 *
 *   1. every matched job from every known board is served while NOTHING is
 *      connected — connection is not a filter on visibility;
 *   2. each served job is card-shaped: a board id + board name, a title, a
 *      description, a match %, and a usable URL;
 *   3. a listing whose URL maps to no known board is never served (nothing
 *      could ever be applied to it);
 *   4. a job reported APPLIED disappears from the list for good, and is kept
 *      in appliedJobs for the digest;
 *   5. connecting / disconnecting changes no card — it only decides whether
 *      /api/harvest accepts new listings;
 *   6. one-click Apply: queueing (action:"apply") creates the run ledger, and
 *      /api/apply/kick answers `needLogin` with the board the user must sign
 *      in on — then hands the queued job out exactly once after the session
 *      verdict arrives;
 *   7. action/report keep resolving jobs whose board is disconnected (an
 *      in-flight application never 404s mid-report).
 *
 * Safety: snapshots state.json and ranked_jobs.json first, appends synthetic
 * jobs (one per board + one unknown host), runs the matrix, then restores both
 * files byte-for-byte and re-verifies the restore. The user's real decisions,
 * log and job data survive untouched.
 *
 * Exit code 0 only if every assertion passes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state.json");
const RANKED = path.join(ROOT, "..", "ranked_jobs.json");
/* live fetches also flow through loadJobs() — isolate them so counts here
 * reflect the base index only (harvest.test.js owns the harvest contract) */
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

const boot = async () => (await req("GET", "/api/bootstrap")).body;

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;
  /* The pre-test table, taken from the server itself BEFORE the harvest file
   * is cleared: harvest.json legitimately holds live listings now. */
  const bootBefore = await boot();
  fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }));
  /* Close whatever run the user's own session left open, so the queue this
   * test inspects is only the one it creates. */
  await req("POST", "/api/apply/stop");
  /* Base-index baseline: harvest cleared, synthetic jobs not added yet. */
  const bootCleared = await boot();
  const originalState = JSON.parse(stateSnap.toString("utf8"));
  const originalRanked = JSON.parse(rankedSnap.toString("utf8"));

  try {
    /* --- synthetic data: one job per board + one host nobody owns --- */
    const boardIds = originalState.boards.map((b) => b.id);
    const extra = boardIds.map((id) => ({
      job_title: `SYNTHETIC ${id} listing`,
      job_detail_url: `https://www.${id === "geeksforgeeks" ? "geeksforgeeks.org" : id + ".example-never"}/jobs/1`,
      company_name: "SynthCo", company_location: "Bengaluru",
      job_listed: "today", score: 30, hits: ["python"],
    }));
    /* proper URLs that boardOf() maps: one real-shaped URL per board */
    const hostFor = {
      linkedin: "https://www.linkedin.com/jobs/view/synth-1",
      indeed: "https://www.indeed.com/viewjob?jk=synth",
      naukri: "https://www.naukri.com/synth-jobs",
      foundit: "https://www.foundit.in/srp/job-detail/synth",
      hirist: "https://www.hirist.tech/job/synth",
      instahyre: "https://www.instahyre.com/job/synth/",
      wellfound: "https://wellfound.com/jobs/synth",
      cutshort: "https://cutshort.io/jobs/synth",
      tophire: "https://tophire.co/jobs/synth",
      internshala: "https://internshala.com/job/synth",
      unstop: "https://unstop.com/jobs/synth",
      glassdoor: "https://www.glassdoor.co.in/job/synth",
      leetcode: "https://leetcode.com/jobs/synth",
      geeksforgeeks: "https://www.geeksforgeeks.org/jobs/synth",
      ambitionbox: "https://www.ambitionbox.com/jobs/synth",
      hackerearth: "https://www.hackerearth.com/jobs/synth",
    };
    boardIds.forEach((id, i) => { extra[i].job_detail_url = hostFor[id] || extra[i].job_detail_url; });
    extra.push({
      job_title: "SYNTHETIC unknown-host listing",
      job_detail_url: "https://totally-unknown-board.example/jobs/1",
      company_name: "NoBoard Inc", company_location: "Remote",
      job_listed: "today", score: 30, hits: ["python"],
    });
    fs.writeFileSync(RANKED, JSON.stringify(originalRanked.concat(extra), null, 1));

    /* --- 1. nothing connected, jobs still served --- */
    for (const id of boardIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });
    let b = await boot();
    check("baseline: all boards disconnected", b.boards.every((x) => !x.connected),
      b.boards.filter((x) => x.connected).map((x) => x.id));
    const expected = bootCleared.jobs.length + boardIds.length;   // + one synthetic per board
    check(`baseline: every matched job is served (${expected}), connection is not a filter`,
      b.jobs.length === expected, { got: b.jobs.length, want: expected });
    check("every served job belongs to a known board", b.jobs.every((j) => !!j.board),
      b.jobs.filter((j) => !j.board).slice(0, 3));
    check("unknown-host job is never served",
      !b.jobs.some((j) => /totally-unknown-board/.test(j.url)), null);

    /* --- 2. cards carry what the UI renders --- */
    const shaped = b.jobs.filter((j) => typeof j.title === "string" && j.title.trim() &&
      typeof j.desc === "string" && j.desc.trim() &&
      typeof j.boardName === "string" && j.boardName.trim() &&
      Number.isFinite(j.match) && /^https?:\/\//i.test(j.url || ""));
    check("every job is card-shaped (title, desc, boardName, match, url)",
      shaped.length === b.jobs.length, { shaped: shaped.length, total: b.jobs.length, sample: b.jobs.find((j) => !j.desc || !j.boardName) });
    const boards = Object.fromEntries(b.boards.map((x) => [x.id, x]));
    const missingCardColor = b.jobs.filter((j) => !boards[j.board]);
    check("each card's board exists in the board table", missingCardColor.length === 0,
      missingCardColor.slice(0, 3).map((j) => j.board));

    /* --- 3. an applied job leaves the list for good --- */
    const applied = b.jobs[0];
    await req("POST", `/api/jobs/${applied.id}/action`, { action: "apply" });
    const rep = await req("POST", `/api/jobs/${applied.id}/report`, { status: "applied", confirmation: "gating-test" });
    check("report marks it applied", rep.status === 200 && rep.body.decisions[applied.id].action === "applied", rep.body && rep.body.decisions[applied.id]);
    b = await boot();
    check("applied job is gone from the card list", !b.jobs.some((j) => j.id === applied.id), applied.id);
    check("applied job is kept for the digest", b.appliedJobs.some((j) => j.id === applied.id),
      b.appliedJobs.slice(0, 3));

    /* --- 4. connecting/disconnecting changes no card --- */
    const beforeIds = b.jobs.map((j) => j.id);
    for (const id of boardIds) {
      await req("POST", `/api/boards/${id}/connect`, { connected: true });
      await req("POST", `/api/boards/${id}/session`, { ok: true });
      await req("POST", `/api/boards/${id}/connect`, { connected: false });
    }
    b = await boot();
    check("connect/disconnect matrix leaves every card untouched",
      JSON.stringify(b.jobs.map((j) => j.id)) === JSON.stringify(beforeIds),
      { before: beforeIds.length, after: b.jobs.length });

    /* --- 5. one-click Apply: queue -> needLogin -> handout --- */
    const target = b.jobs.find((j) => j.id !== applied.id);
    const q = await req("POST", `/api/jobs/${target.id}/action`, { action: "apply" });
    check("Apply queues the job and opens a run", q.status === 200 && q.body.run && q.body.run.total >= 1, q.body && q.body.run);
    check("decision is \"apply\" (never \"applied\")",
      (await boot()).decisions[target.id].action === "apply");
    let k = (await req("POST", "/api/apply/kick", {})).body;
    check("kick with no verified session -> needLogin for this job's board",
      k.needLogin === target.board && typeof k.boardName === "string" && !!k.open, k);
    check("kick opens no job while the board is not connected", !k.job, k.job);

    await req("POST", `/api/boards/${target.board}/connect`, { connected: true });
    await req("POST", `/api/boards/${target.board}/session`, { ok: true, detail: "gating-test" });
    k = (await req("POST", "/api/apply/kick", {})).body;
    check("verified session -> the queued job is handed out", k.job && k.job.id === target.id, k);
    check("handed-out job carries the card fields the page needs",
      k.job && k.job.title && k.job.url && k.job.board === target.board, k.job);
    const k2 = (await req("POST", "/api/apply/kick", {})).body;
    check("a second kick waits instead of stacking a tab", k2.waiting === true && !k2.job, k2);

    /* A report concludes it: the card disappears and the run records it. */
    await req("POST", `/api/jobs/${target.id}/report`, { status: "applied", confirmation: "gating-test" });
    b = await boot();
    check("applied via one-click -> card gone", !b.jobs.some((j) => j.id === target.id), target.id);
    check("run records the applied result", b.run && b.run.applied >= 1, b.run);

    /* --- 6. action/report never 404 mid-flight --- */
    await req("POST", `/api/boards/${target.board}/connect`, { connected: false });
    const act = await req("POST", `/api/jobs/${applied.id}/action`, { action: "approve" });
    check("action endpoint resolves a job whose board is disconnected (no 404)", act.status === 200, act);
    const rep2 = await req("POST", `/api/jobs/${applied.id}/report`, { status: "captcha", message: "gating-test" });
    check("report endpoint resolves it too (no 404)", rep2.status === 200, rep2);
    await req("POST", "/api/apply/stop");
  } finally {
    fs.writeFileSync(STATE, stateSnap);
    fs.writeFileSync(RANKED, rankedSnap);
    if (harvestSnap) fs.writeFileSync(HARVEST, harvestSnap);
    else { try { fs.unlinkSync(HARVEST); } catch {} }
  }
  check(harvestExisted ? "harvest.json restored byte-for-byte" : "absent harvest.json left absent",
    harvestExisted ? fs.readFileSync(HARVEST).equals(harvestSnap) : !fs.existsSync(HARVEST));

  /* restore verified byte-for-byte */
  check("state.json restored byte-for-byte", fs.readFileSync(STATE).equals(stateSnap));
  check("ranked_jobs.json restored byte-for-byte", fs.readFileSync(RANKED).equals(rankedSnap));
  const after = await boot();
  check("post-restore bootstrap matches the original job list",
    JSON.stringify(after.jobs.map((j) => j.id)) === JSON.stringify(bootBefore.jobs.map((j) => j.id)),
    { after: after.jobs.length, before: bootBefore.jobs.length });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
