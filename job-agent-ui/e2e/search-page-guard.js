/* search-page-guard.js — the engine must refuse a board's SEARCH page.
 *
 * The report this fixes, verbatim:
 *   "Stuck on step 3: clicking \"Next\" did not advance the form — fields it
 *    couldn't place: \"Enter keyword, designation, or companies\" (text),
 *    \"Select experience\" [experienceDD] (text), \"Enter location\" (text);
 *    controls here: \"Next\" (advances the form), \"Search jobs here\", ..."
 *
 * The wizard had typed into a Naukri search box and clicked pagination. This
 * runs the REAL engine on a REAL Naukri results page and asserts it refuses
 * with not-an-application, clicks nothing, and stays on the same URL.
 *
 * Read-only: no form is filled, nothing is submitted, no state is written.
 * usage: node search-page-guard.js [list-url]
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "extension");
const URL_ = process.argv[2] || "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore";

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
};

async function inEngine(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => ctxs.push(context));
  await cdp.send("Runtime.enable");
  await page.waitForTimeout(400);
  for (const c of ctxs) {
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    try {
      const r = await cdp.send("Runtime.evaluate", {
        contextId: c.id, expression, returnByValue: true, awaitPromise: true,
      });
      if (r && r.result && r.result.value !== undefined && r.result.value !== null) {
        await cdp.detach();
        return r.result.value;
      }
    } catch { /* context gone */ }
  }
  await cdp.detach();
  return null;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile-scrape"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let res = null, before = "", after = "";
  try {
    const page = await ctx.newPage();
    await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    before = page.url();
    res = await inEngine(page, "__JOB_AGENT__.run({ submit: true })");
    await page.waitForTimeout(1500);
    after = page.url();
    console.log("=== engine verdict: " + JSON.stringify(res));

    check("engine answered on a live search page", !!res, res);
    check("refused as not-an-application", res && res.reason === "not-an-application", res);
    check("message says it clicked nothing", /not an application form — nothing was clicked/.test((res && res.message) || ""), res && res.message);
    check("message points at a specific job", /open a specific job/i.test((res && res.message) || ""), res && res.message);
    check("filled nothing", !res || !(res.filled || []).length, res && res.filled);
    check("page never navigated", before === after, { before, after });
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
    fail++;
  } finally {
    await ctx.close().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
