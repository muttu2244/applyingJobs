/* session.test.js — connecting a board requires PROOF of login.
 *
 * The complaint this exists for: "I may just click 'I'm signed in — connect',
 * but you should verify whether I'm actually logged in — if not, ask me to
 * log in." So connect is only a claim:
 *   1. POST connect {connected:true} does NOT connect — the board enters
 *      `pending`, /api/harvest keeps refusing it (403), and the dashboard
 *      says it is verifying;
 *   2. the extension posts /api/boards/:id/session from the board tab:
 *      ok:true  -> connected (log: "session verified in your browser");
 *      ok:false -> refused / disconnected (log tells you to log in);
 *      ok:null  -> stays pending ("no clear login signal");
 *   3. force:true is the user's explicit override, shown only after the
 *      unverified state is visible;
 *   4. a signed-out verdict on a CONNECTED board disconnects it — the
 *      dashboard never claims a session the site itself denies.
 *
 * Runs against the live server (start `node ../server.js` first).
 * Safety: snapshots state.json and restores it byte-for-byte.
 * Exit code 0 only if every assertion passes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "state.json");
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

const bootstrap = async () => (await req("GET", "/api/bootstrap")).body;
const boardOf = (b, id) => b.boards.find((x) => x.id === id);

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  const original = JSON.parse(stateSnap.toString("utf8"));

  try {
    const allIds = original.boards.map((b) => b.id);
    const ID = "naukri";
    for (const id of allIds) await req("POST", `/api/boards/${id}/connect`, { connected: false });

    /* --- 1. connect is a claim, not a connection --- */
    let r = await req("POST", `/api/boards/${ID}/connect`, { connected: true });
    check("connect returns pending, not connected", r.body.pending === true && r.body.board.connected === false, r.body);
    let b = await bootstrap();
    let nb = boardOf(b, ID);
    check("bootstrap: board NOT connected while unverified", nb.connected === false, nb);
    check("bootstrap: session.pending set for the dashboard", nb.session.pending === true && nb.session.ok === false, nb.session);
    check("verify step logged to the timeline", b.log.some((l) => l.type === "verify" && /verifying your session/.test(l.text)), b.log[0]);

    /* --- 2. while pending, jobs still do not flow --- */
    r = await req("POST", "/api/harvest", {
      board: ID,
      jobs: [{ title: "MLOps Engineer", company: "Acme", location: "Bengaluru", url: "https://www.naukri.com/mlops-engineer-pending-1212121212" }],
    });
    check("harvest refused while session unverified", r.status === 403, r.status);

    /* --- 3. extension says NOT logged in --- */
    r = await req("POST", `/api/boards/${ID}/session`, { ok: false, detail: "{in:false,out:true,form:true}" });
    check("verdict false -> still disconnected", r.body.connected === false, r.body);
    b = await bootstrap();
    nb = boardOf(b, ID);
    check("pending cleared, session.ok=false recorded", nb.session.pending === false && nb.session.ok === false, nb.session);
    check("timeline says to log in first", b.log.some((l) => /not signed in/.test(l.text)), b.log.slice(0, 2));

    /* --- 4. repeat false verdicts do not spam the timeline --- */
    const logLen = b.log.length;
    await req("POST", `/api/boards/${ID}/session`, { ok: false });
    await req("POST", `/api/boards/${ID}/session`, { ok: false });
    b = await bootstrap();
    check("transition-only logging (no repeats)", b.log.length === logLen, { before: logLen, after: b.log.length });

    /* --- 5. extension says logged in -> NOW it connects --- */
    await req("POST", `/api/boards/${ID}/connect`, { connected: true });   // user clicks again
    r = await req("POST", `/api/boards/${ID}/session`, { ok: true, detail: "{in:true,out:false,form:false}" });
    check("verdict true -> connected", r.body.connected === true, r.body);
    b = await bootstrap();
    nb = boardOf(b, ID);
    check("bootstrap: connected with verified session", nb.connected === true && nb.session.ok === true && nb.session.pending === false, nb.session);
    check("timeline: 'session verified in your browser'", b.log.some((l) => /session verified in your browser/.test(l.text)), b.log[0]);
    check("its card counts its jobs again (base gated set)", Number.isFinite(nb.jobs), nb.jobs);

    /* --- 6. signed out later -> session lost, disconnected --- */
    r = await req("POST", `/api/boards/${ID}/session`, { ok: false });
    check("signed-out verdict disconnects a connected board", r.body.connected === false, r.body);
    b = await bootstrap();
    check("timeline: 'signed out on the site'", b.log.some((l) => /signed out on the site/.test(l.text)), b.log[0]);

    /* --- 7. ambiguous page: stays pending, says why --- */
    await req("POST", `/api/boards/${ID}/connect`, { connected: true });
    await req("POST", `/api/boards/${ID}/session`, { ok: null });
    b = await bootstrap();
    nb = boardOf(b, ID);
    check("null verdict: pending, never connected", nb.connected === false && nb.session.pending === true, nb.session);
    check("null verdict records why", /no clear login signal/.test(nb.session.detail || ""), nb.session);

    /* --- 8. force is the user's explicit override --- */
    r = await req("POST", `/api/boards/${ID}/connect`, { connected: true, force: true });
    check("force connects immediately", r.body.board.connected === true && !r.body.pending, r.body);
    b = await bootstrap();
    nb = boardOf(b, ID);
    check("forced session marked unverified-by-choice", /your choice/.test(nb.session.detail || ""), nb.session);
    check("timeline says verification was skipped", b.log.some((l) => /skip session verification/.test(l.text)), b.log[0]);

    /* --- 9. disconnect is immediate and clears the session state --- */
    r = await req("POST", `/api/boards/${ID}/connect`, { connected: false });
    check("disconnect immediate", r.body.board.connected === false, r.body.board);
    b = await bootstrap();
    nb = boardOf(b, ID);
    check("session state cleared on disconnect", nb.session.ok === false && nb.session.pending === false && nb.session.at === null, nb.session);
  } finally {
    fs.writeFileSync(STATE, stateSnap);
  }

  check("state.json restored byte-for-byte", fs.readFileSync(STATE).equals(stateSnap));
  const b = await bootstrap();
  check("post-restore connection flags match the original",
    JSON.stringify(b.boards.map((x) => [x.id, x.connected])) ===
    JSON.stringify(original.boards.map((x) => [x.id, x.connected])),
    b.boards.map((x) => [x.id, x.connected]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
