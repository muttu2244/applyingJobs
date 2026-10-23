/* board-sweep.js — real-extension, real-sites verification.
 *
 * Loads the unpacked extension from ../extension into a persistent Chromium,
 * opens one page per job board, and for each:
 *   1. finds the extension's ISOLATED world (page-world evaluate cannot see
 *      it) and reads the engine's build stamp + preview() — opener detection,
 *      fields it would fill, CAPTCHA state;
 *   2. if preview says fields are fillable, runs fill() — submit:false, never
 *      clicks submit — and reads the values back from the shared DOM;
 *   3. correlates with dashboard access log lines (origin=<board>) to prove
 *      the content script's fetch to 127.0.0.1:8357 survives the page's CSP.
 *
 * Runs headed (extension support), closes when done. Never submits anything.
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const EXT = path.resolve(__dirname, "..", "extension");
const SERVER_LOG = path.resolve(__dirname, "..", "server.log");

const BOARDS = [
  { id: "indeed-viewjob", url: "https://www.indeed.com/viewjob?jk=d60d1f21a4e182da&tk=1k502oemmj57n800&from=serp&vjs=3" },
  { id: "lever-apply", url: "https://jobs.lever.co/artera/cc5cbc4d-c7e7-4573-993f-526cb33f5a81/apply" },
  { id: "lever-job", url: "https://jobs.lever.co/zimperium/5b35759a-d445-4fcb-b255-d719330af055" },
  { id: "greenhouse-job", url: "https://job-boards.greenhouse.io/discord/jobs/8815116002" },
  { id: "ashby-job", url: "https://jobs.ashbyhq.com/range/c065eea6-197a-45f1-81c8-4e03af60e641" },
  { id: "naukri-list", url: "https://www.naukri.com/python-jobs" },
  { id: "foundit-list", url: "https://www.foundit.in/srch/python-jobs" },
  { id: "hirist-home", url: "https://www.hirist.tech/" },
  /* --- boards added in 2.8.0 (from the myjobbs-style image) --- */
  { id: "wellfound-list", url: "https://wellfound.com/jobs" },
  { id: "cutshort-list", url: "https://cutshort.io/jobs" },
  { id: "tophire-home", url: "https://tophire.co/" },
  { id: "internshala-list", url: "https://internshala.com/jobs" },
  { id: "unstop-list", url: "https://unstop.com/jobs" },
  { id: "glassdoor-list", url: "https://www.glassdoor.com/Jobs/" },
  { id: "leetcode-jobs", url: "https://leetcode.com/jobs/" },
  { id: "gfg-jobs", url: "https://www.geeksforgeeks.org/jobs/" },
  { id: "ambitionbox-list", url: "https://www.ambitionbox.com/jobs" },
  { id: "hackerearth-list", url: "https://www.hackerearth.com/jobs/" },
  /* external-ATS leg: board Apply routes into Workday's own application form */
  { id: "workday-job", waitMs: 11000, url: "https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Software-Development-Engineer_JR-0110318" },
];

/* Optional id-substring filter: `node board-sweep.js wellfound unstop` runs
 * only those boards — used to verify one cohort without re-running all. */
const FILTER = process.argv.slice(2);
const RUN = FILTER.length ? BOARDS.filter((b) => FILTER.some((f) => b.id.includes(f))) : BOARDS;
if (!RUN.length) {
  console.error("no boards match " + JSON.stringify(FILTER));
  process.exit(2);
}

/* Probe every execution context until the engine answers. The content script
 * lives in an extension isolated world — main-world evaluate returns null. */
async function probeEngine(page) {
  const cdp = await page.context().newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => ctxs.push(context));
  await cdp.send("Runtime.enable");
  for (const c of ctxs) {
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    try {
      const r = await cdp.send("Runtime.evaluate", {
        contextId: c.id,
        expression:
          "typeof __JOB_AGENT__ !== 'undefined' && __JOB_AGENT__ ? " +
          "{guard: String(__JOB_AGENT_LOADED__), prev: __JOB_AGENT__.preview()} : null",
        returnByValue: true,
      });
      if (r && r.result && r.result.value) {
        const val = r.result.value;
        val.contextId = c.id;
        await cdp.detach();
        return val;
      }
    } catch { /* context gone — keep looking */ }
  }
  await cdp.detach();
  return null;
}

/* fill() in the isolated world (submit:false), then read values back from the
 * shared DOM in the main world — proof the typing landed on real inputs. */
async function fillAndRead(page, contextId) {
  const cdp = await page.context().newCDPSession(page);
  const fill = await cdp.send("Runtime.evaluate", {
    contextId,
    expression:
      "__JOB_AGENT__.fill().then(r => ({ok: r.ok, n: (r.filled||[]).length, " +
      "keys: (r.filled||[]).map(f => f.key), open: r.openQuestions || [], " +
      "failed: (r.failed||[]).map(f => f.key)}))",
    awaitPromise: true,
    returnByValue: true,
  }).catch((e) => ({ error: String(e) }));
  await cdp.detach();
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter((el) => el.value && !["hidden", "file", "password"].includes(el.type || ""))
      .slice(0, 25)
      .map((el) => ({
        field: el.name || el.id || el.type || el.tagName.toLowerCase(),
        value: String(el.value).slice(0, 48),
      }))
  );
  return { fill: fill && fill.result ? fill.result.value : fill, populatedInputs: inputs };
}

(async () => {
  const logStart = fs.existsSync(SERVER_LOG) ? fs.statSync(SERVER_LOG).size : 0;
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

  const results = [];
  for (const board of RUN) {
    const rec = { id: board.id, url: board.url };
    let page = null;
    try {
      page = await ctx.newPage();
      await page.goto(board.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(board.waitMs || 3500);   // document_idle + settle

      let eng = await probeEngine(page);
      if (!eng) {
        rec.engine = "NOT INJECTED (or no isolated world found)";
      } else {
        rec.engine = { guard: eng.guard, ...eng.prev };
        if (eng.prev && eng.prev.wouldFill && eng.prev.wouldFill.length) {
          rec.fill = await fillAndRead(page, eng.contextId);
        }
        /* Landing page with an opener and no form yet (Greenhouse job cards,
         * Indeed "Apply on company site"): click the opener and re-preview —
         * never a submit control, never a pay control. */
        if (eng.prev && eng.prev.openerControl &&
            (!eng.prev.wouldFill || !eng.prev.wouldFill.length)) {
          rec.openerClicked = await page.evaluate(() => {
            const re = /^(apply|apply now|easy apply|easily apply|apply on company site|start( your)? application|apply for this job)$/i;
            const els = [...document.querySelectorAll("button, a, [role=button], input[type=submit]")];
            const el = els.find((e) => re.test((e.innerText || e.value || "").trim()));
            if (!el) return false;
            el.click();
            return true;
          }).catch(() => false);
          if (rec.openerClicked) {
            await page.waitForTimeout(3500);
            const eng2 = await probeEngine(page);
            if (eng2) {
              rec.afterOpener = eng2.prev;
              if (eng2.prev && eng2.prev.wouldFill && eng2.prev.wouldFill.length) {
                rec.fill = await fillAndRead(page, eng2.contextId);
              }
            }
          }
        }
      }
      rec.title = await page.title().catch(() => "");
    } catch (e) {
      rec.error = String(e && e.message || e).slice(0, 200);
    } finally {
      if (page) await page.close().catch(() => {});
    }
    results.push(rec);
    console.log(JSON.stringify(rec));
  }

  await ctx.close();

  /* Which boards' content scripts actually reached the dashboard? */
  const tail = fs.existsSync(SERVER_LOG)
    ? fs.readFileSync(SERVER_LOG, "utf8").slice(logStart)
    : "";
  const origins = [...new Set(
    tail.split(/\r?\n/)
      .map((l) => (l.match(/origin=(\S+)/) || [])[1])
      .filter(Boolean)
  )];
  const bootstraps = tail.split(/\r?\n/).filter((l) => l.includes("/api/bootstrap")).length;
  console.log("\n=== dashboard saw fetches from origins: " + JSON.stringify(origins));
  console.log("=== /api/bootstrap requests from content scripts: " + bootstraps);
  console.log("=== summary: " + JSON.stringify(results.map((r) => ({
    id: r.id,
    guard: r.engine && r.engine.guard,
    opener: r.engine && r.engine.openerControl,
    opened: r.openerClicked,
    wouldFill: r.engine && r.engine.wouldFill ? r.engine.wouldFill.length : 0,
    afterOpenerFill: r.afterOpener && r.afterOpener.wouldFill ? r.afterOpener.wouldFill.length : 0,
    captcha: r.engine && r.engine.captcha,
    filled: r.fill && r.fill.fill && r.fill.fill.n,
    err: r.error || (r.engine === undefined ? "no engine" : undefined),
  })), null, 1));
})();
