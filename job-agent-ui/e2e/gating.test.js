/* gating.test.js — connection gates jobs, for EVERY board.
 *
 * The bug: /api/bootstrap served every job in ranked_jobs.json regardless of a
 * board's `connected` flag, so LinkedIn jobs were "matched" while the card said
 * "not connected". This asserts the fix across all 16 boards.
 *
 * Safety: snapshots state.json and ranked_jobs.json first, appends synthetic
 * jobs (one per board + one unknown host), runs the connect/disconnect matrix,
 * then restores both files byte-for-byte and re-verifies the restore. The user's
 * real decisions, log and job data survive untouched.
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

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const rankedSnap = fs.readFileSync(RANKED);
  const harvestExisted = fs.existsSync(HARVEST);
  const harvestSnap = harvestExisted ? fs.readFileSync(HARVEST) : null;
  /* The pre-test board table, taken from the server itself BEFORE the harvest
   * file is cleared: harvest.json legitimately holds live listings now, so
   * counting them by hand (the old LinkedIn-only arithmetic) would misread a
   * correctly restored state as a failure. */
  const bootBefore = (await req("GET", "/api/bootstrap")).body;
  fs.writeFileSync(HARVEST, JSON.stringify({ entries: [], fetchedAt: {} }));
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

    /* baseline: everything disconnected */
    for (const id of boardIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });
    let b = (await req("GET", "/api/bootstrap")).body;
    check("baseline: all boards disconnected", b.boards.every((x) => !x.connected),
      b.boards.filter((x) => x.connected).map((x) => x.id));
    check("baseline: no jobs flow at all", b.jobs.length === 0, b.jobs.length);
    check("baseline: every board card count is 0", b.boards.every((x) => x.jobs === 0),
      b.boards.map((x) => `${x.id}:${x.jobs}`));

    /* expected per-board totals: real ranked jobs mapped to it + 1 synthetic.
     * Mirrors server.js boardOf(): exact host or "." + domain suffix. */
    const DOMS = {
      linkedin: "linkedin.com", indeed: "indeed.com", naukri: "naukri.com",
      foundit: "foundit.in", hirist: "hirist.tech", instahyre: "instahyre.com",
      wellfound: "wellfound.com", cutshort: "cutshort.io", tophire: "tophire.co",
      internshala: "internshala.com", unstop: "unstop.com",
      glassdoor: "glassdoor.co.in", leetcode: "leetcode.com",
      geeksforgeeks: "geeksforgeeks.org", ambitionbox: "ambitionbox.com",
      hackerearth: "hackerearth.com",
    };
    const counts = {};
    for (const j of originalRanked) {
      let h = "";
      try { h = new URL(j.job_detail_url).hostname.toLowerCase(); } catch {}
      const id = boardIds.find((bid) => h === DOMS[bid] || h.endsWith("." + DOMS[bid]));
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
    console.log(`(real ranked jobs per board: ${JSON.stringify(counts)})`);

    /* --- matrix: connect one board at a time ---
     * connect is a claim; the extension's session verdict is what connects
     * (session.test.js owns that contract — here we play the extension). */
    for (const id of boardIds) {
      await req("POST", `/api/boards/${id}/connect`, { connected: true });
      await req("POST", `/api/boards/${id}/session`, { ok: true });
      b = (await req("GET", "/api/bootstrap")).body;
      const jobs = b.jobs;
      const boards = Object.fromEntries(b.boards.map((x) => [x.id, x]));
      const foreign = jobs.filter((j) => j.board !== id);
      const expectedReal = id === "linkedin" ? (counts.linkedin || 0) : 0;
      const expectedTotal = expectedReal + 1; // + the synthetic job
      check(`${id}: connected -> jobs visible (${expectedTotal})`, jobs.length === expectedTotal,
        { got: jobs.length, want: expectedTotal });
      check(`${id}: every visible job belongs to it`, foreign.length === 0,
        foreign.slice(0, 3).map((j) => j.board));
      check(`${id}: its card count = ${expectedTotal}`, boards[id].jobs === expectedTotal, boards[id].jobs);
      const otherCounts = Object.entries(boards).filter(([k]) => k !== id && k !== "UNKNOWN")
        .filter(([, v]) => v.jobs !== 0);
      check(`${id}: all other cards read 0`, otherCounts.length === 0, otherCounts);
      check(`${id}: unknown-host job never visible`, !jobs.some((j) => j.board == null), null);

      await req("POST", `/api/boards/${id}/connect`, { connected: false });
      b = (await req("GET", "/api/bootstrap")).body;
      check(`${id}: disconnected -> hidden again`, b.jobs.length === 0, b.jobs.length);
    }

    /* report/action endpoints must still resolve jobs while their board is
     * disconnected — an in-flight application never 404s mid-report. */
    b = (await req("GET", "/api/bootstrap")).body;
    const linkedinJobs = originalRanked.length; // first real job id = 0
    const act = await req("POST", `/api/jobs/0/action`, { action: "approve" });
    check("action endpoint resolves a hidden job (no 404)", act.status === 200, act);
    const rep = await req("POST", `/api/jobs/0/report`, { status: "captcha", message: "gating-test" });
    check("report endpoint resolves a hidden job (no 404)", rep.status === 200, rep);
    check("job count sanity: original ranked size", Number.isInteger(linkedinJobs) && linkedinJobs > 0);
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
  const after = (await req("GET", "/api/bootstrap")).body;
  check("post-restore bootstrap matches original connection flags",
    JSON.stringify(after.boards.map((x) => [x.id, x.connected, x.jobs])) ===
    JSON.stringify(bootBefore.boards.map((x) => [x.id, x.connected, x.jobs])),
    { after: after.boards.map((x) => [x.id, x.connected, x.jobs]),
      before: bootBefore.boards.map((x) => [x.id, x.connected, x.jobs]) });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
