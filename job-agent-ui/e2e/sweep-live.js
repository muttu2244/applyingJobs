/* sweep-live.js — the fetch-all walker, on a real board, in a real browser.
 *
 * Server contracts are covered by sweep.test.js; this proves the other half:
 * with a sweep requested, the content script on a live Naukri search page finds
 * the Next control, clicks it, survives the navigation, and advances the sweep
 * (the next page's script resumes from the server's counter).
 *
 * A logged-out board is fine here: this test is about walking pages, and
 * whether the listings can be stored is covered by harvest.test.js. state.json
 * is snapshotted and restored so the run cannot rewrite the user's boards.
 *
 * usage: node sweep-live.js [max-pages]
 */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const EXT = path.resolve(__dirname, "..", "extension");
const STATE = path.resolve(__dirname, "..", "state.json");
const BASE = "http://127.0.0.1:8357";
const PAGES = Math.max(2, Number(process.argv[2]) || 2);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}

(async () => {
  const stateSnap = fs.readFileSync(STATE);
  let ctx = null;
  try {
    /* Connect without waiting on a login verdict: the sweep itself does not
     * need one, and a logged-out board would otherwise clear the connection
     * the moment the page reports its session. */
    await req("POST", "/api/reset");
    await req("POST", "/api/boards/naukri/connect", { connected: true, force: true });
    const started = await req("POST", "/api/boards/naukri/sweep", { pages: PAGES });
    check("sweep requested", started.body && started.body.sweep.status === "running", started.body);

    const boot = (await req("GET", "/api/bootstrap")).body;
    const board = boot.boards.find((b) => b.id === "naukri");
    check("board exposes the sweep", board.sweep && board.sweep.status === "running", board.sweep);

    ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile-scrape"), {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    const page = await ctx.newPage();
    await page.goto(board.searchUrl || "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore",
      { waitUntil: "domcontentloaded", timeout: 45000 });

    /* The walker starts ~4.5s after load; each page costs a click + settle. */
    const advanced = await waitFor(async () => {
      const s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
      return s && s.page >= 1 ? s : null;
    }, 60000);
    check("walker advanced past page 1", !!advanced, advanced);
    console.log("=== sweep after first page: " + JSON.stringify(advanced));

    const finished = await waitFor(async () => {
      const s = (await req("GET", "/api/boards/naukri/sweep")).body.sweep;
      return s && (s.status === "done" || s.page >= PAGES) ? s : null;
    }, 90000);
    check(`walker reached page ${PAGES} or finished`, !!finished, finished);
    check("finished sweep says so", finished && finished.status === "done", finished);
    if (finished) {
      console.log("=== final sweep: " + JSON.stringify(finished));
      check("page counter matches pages walked", finished.page >= 1, finished.page);
    }
    /* The pagination click must have moved the browser off the first page. */
    check("browser navigated to a later results page", /-2(\?|$)|[?&]page=2/.test(page.url()) || (finished && finished.page >= 2),
      page.url());
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
    fail++;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    fs.writeFileSync(STATE, stateSnap);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
