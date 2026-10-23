/* session-board.js — live proof of the connect gate:
 *   real Chromium + the real extension on a real board page ->
 *   __JOB_AGENT__.session() reads login evidence ->
 *   POST /api/boards/:id/session ->
 *   dashboard's bootstrap reflects it (connected, or "not signed in").
 *
 * Either verdict (logged in / logged out) is a PASS for this script — the
 * point is that the verdict is REAL evidence from the page and it ARRIVES.
 * Never submits, never logs in, never clicks credential fields.
 *
 * usage: node session-board.js <board-id> <list-url>
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");

const EXT = path.resolve(__dirname, "..", "extension");
const BASE = "http://127.0.0.1:8357";
const BOARD = process.argv[2];
const URL_ = process.argv[3];
if (!BOARD || !URL_) {
  console.error("usage: node session-board.js <board-id> <list-url>");
  process.exit(2);
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function probe(page, expr) {
  const cdp = await page.context().newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => ctxs.push(context));
  await cdp.send("Runtime.enable");
  await page.waitForTimeout(500);
  for (const c of ctxs) {
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    try {
      const r = await cdp.send("Runtime.evaluate", {
        contextId: c.id, expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r && r.result && r.result.value) {
        const v = r.result.value;
        await cdp.detach();
        return v;
      }
    } catch { /* context gone */ }
  }
  await cdp.detach();
  return null;
}

(async () => {
  const before = (await get("/api/bootstrap")).boards.find((b) => b.id === BOARD);
  console.log("=== BEFORE: connected=" + before.connected +
    " session=" + JSON.stringify(before.session));

  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();
  let verdict = null;
  try {
    await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 });
    /* headers render late on SPA boards (~6s seen on naukri) — wait, then
     * keep polling until the verdict is decisive or time runs out */
    await page.waitForTimeout(7000);
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      verdict = await probe(page,
        "typeof __JOB_AGENT__ !== 'undefined' && __JOB_AGENT__ ? {v: String(__JOB_AGENT_LOADED__), s: __JOB_AGENT__.session()} : null");
      if (verdict && verdict.s && verdict.s.ok !== null) break;
      await page.waitForTimeout(3000);
    }
    console.log("=== engine: " + JSON.stringify(verdict));
    /* wait for the report round-trip (null verdicts re-check every 30s —
     * decisive ones fire within one DOM-quiet cycle) */
    await page.waitForTimeout(8000);
  } finally {
    await ctx.close().catch(() => {});
  }

  const after = (await get("/api/bootstrap")).boards.find((b) => b.id === BOARD);
  console.log("=== AFTER:  connected=" + after.connected +
    " session=" + JSON.stringify(after.session));

  let fail = 0;
  const check = (label, cond, extra) => {
    console.log((cond ? "ok   " : "FAIL ") + label + (cond ? "" : " -> " + JSON.stringify(extra)));
    if (!cond) fail++;
  };
  check("extension injected with a session() API", !!(verdict && verdict.v), verdict);
  check("verdict computed from page evidence", !!(verdict && verdict.s &&
    (verdict.s.ok === true || verdict.s.ok === false || verdict.s.ok === null)), verdict);
  if (verdict && verdict.s && verdict.s.ok === true) {
    check("logged-in verdict connected the board", after.connected === true, after.session);
    check("dashboard records the verified session", after.session.ok === true, after.session);
  } else if (verdict && verdict.s && verdict.s.ok === false) {
    check("logged-out verdict kept the board out", after.connected === false, after.session);
    check("dashboard says you must log in", after.session.ok === false, after.session);
  } else {
    /* ambiguous page: server must keep waiting, never guess */
    check("ambiguous page: still pending or untouched", after.connected === false, after.session);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
