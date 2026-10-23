/* harvest-details.js — the card details come from the REAL page.
 *
 * The popup shows board / experience / location / pay on every job card, and
 * those values are scraped from board listing cards. The unit suites prove the
 * plumbing with fixtures; this proves the scraper against live DOM: real
 * Chromium, real extension, a real board search page, then
 * __JOB_AGENT__.listings() — the exact function the harvester posts.
 *
 * Read-only in intent: the script never connects a board or POSTs. The
 * extension itself still reports the page's session verdict (that is its job),
 * so state.json is snapshotted and restored around the run — a test browsing a
 * logged-out board must not rewrite the user's connections. Exit 0 when at
 * least one listing carries detail text.
 *
 * usage: node harvest-details.js [list-url]
 */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "extension");
/* Guard: the engine lives at job-agent-ui/extension/content.js. An earlier
 * copy of this file at job-agent-ui/ext/ kept re-running the engine at
 * extension/content.js with its manifest still advertising 2.12.1 — a stale
 * build, since 2.12.2 fixes exactly this widget. Fail loudly rather than
 * measure an old engine. */
const ENGINE_SRC = path.join(EXT, "content.js");
if (!fs.existsSync(ENGINE_SRC)) {
  console.error(`FAIL engine not found at ${ENGINE_SRC} — wrong folder or the extension moved`);
  process.exit(1);
}
if (!fs.existsSync(path.join(EXT, "geo-shim.js"))) {
  console.error(`FAIL geo-shim.js missing at ${EXT} — extension build is older than 2.12.3`);
  process.exit(1);
}
const EXPECTED_ENGINE_VERSION = "2.12.3";
const engineVersion = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;
if (engineVersion !== EXPECTED_ENGINE_VERSION) {
  console.error(`FAIL engine manifest is v${engineVersion}, this test expects v${EXPECTED_ENGINE_VERSION}`);
  process.exit(1);
}

const STATE = path.resolve(__dirname, "..", "state.json");
const URL_ = process.argv[2] || "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
};

/* The content script lives in its own isolated world; CDP evaluates there. */
async function listingsFromExtension(page) {
  const cdp = await page.context().newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => ctxs.push(context));
  await cdp.send("Runtime.enable");
  await page.waitForTimeout(500);
  for (const c of ctxs) {
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    try {
      const r = await cdp.send("Runtime.evaluate", {
        contextId: c.id,
        expression: "typeof __JOB_AGENT__ !== 'undefined' && __JOB_AGENT__.listings ? __JOB_AGENT__.listings() : null",
        returnByValue: true,
      });
      if (r && r.result && Array.isArray(r.result.value)) {
        await cdp.detach();
        return r.result.value;
      }
    } catch { /* context gone */ }
  }
  await cdp.detach();
  return null;
}

(async () => {
  const stateSnap = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile-scrape"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let list = null;
  try {
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(7000);          // cards + late-rendered detail lines
    list = await listingsFromExtension(page);
    if (!list) {
      await page.waitForTimeout(5000);        // SPA boards can be slower
      list = await listingsFromExtension(page);
    }
    check("scraper found listings on the live page", Array.isArray(list) && list.length > 0,
      list && list.length);
    if (Array.isArray(list) && list.length) {
      const sample = list.slice(0, 6);
      console.log("=== sample: " + JSON.stringify(sample, null, 1).slice(0, 1600));
      check("listings carry titles", list.every((j) => j.title && j.title.length > 5));
      check("listings carry the board-relative URL", list.every((j) => /^https?:/.test(j.url)));
      /* Board navigation ("Data Science jobs", "Jobs in Mumbai") has a title
       * but no company/experience/location — it must never be harvested. */
      check("no navigation links harvested",
        list.every((j) => j.company || j.experience || j.location || j.listed),
        list.filter((j) => !(j.company || j.experience || j.location || j.listed)).map((j) => j.title));
      check("every listing URL points at a job detail page",
        list.every((j) => /job-listings|\/jobs\/view\/|viewjob|jk=|\/job\//i.test(j.url)),
        list.filter((j) => !/job-listings|\/jobs\/view\/|viewjob|jk=|\/job\//i.test(j.url)).map((j) => j.url));
      check("experience text captured on at least one card",
        list.some((j) => j.experience), list.filter((j) => j.experience).length);
      check("location text captured on at least one card",
        list.some((j) => j.location), list.filter((j) => j.location).length);
      check("posted/age text captured on at least one card",
        list.some((j) => j.listed), list.filter((j) => j.listed).length);
    }
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
    fail++;
  } finally {
    await ctx.close().catch(() => {});
    if (stateSnap) fs.writeFileSync(STATE, stateSnap);   // leave the user's boards as found
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
