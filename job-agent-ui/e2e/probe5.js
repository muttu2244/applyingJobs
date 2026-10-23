/* probe5.js — why is the engine absent on leetcode.com/jobs?
 * Dumps every execution context (isolation + origin + type) and, in each
 * non-default world, the load-guard, engine object, and any thrown error. */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();

  const resp = await page.goto("https://leetcode.com/jobs/", { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("HTTP", resp && resp.status(), "url", page.url());
  await page.waitForTimeout(4000);

  const cdp = await ctx.newCDPSession(page);
  const ctxs = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => ctxs.push(context));
  await cdp.send("Runtime.enable");
  await page.waitForTimeout(1500);

  console.log("contexts:", ctxs.length);
  for (const c of ctxs) {
    const aux = c.auxData || {};
    const line = `#${c.id} name=${JSON.stringify(c.name)} origin=${JSON.stringify(c.origin)} isDefault=${aux.isDefault} frameId=${aux.frameId}`;
    if (aux.isDefault === false) {
      try {
        const r = await cdp.send("Runtime.evaluate", {
          contextId: c.id,
          expression: `(function(){
            const out = { guard: typeof __JOB_AGENT_LOADED__ !== 'undefined' ? String(__JOB_AGENT_LOADED__) : "(unset)",
                          engine: typeof __JOB_AGENT__ !== 'undefined' && __JOB_AGENT__ ? "object" : String(typeof __JOB_AGENT__),
                          hasChrome: typeof chrome !== 'undefined',
                          hasFillpack: typeof window.__FILLPACK__ !== 'undefined' || typeof FILLPACK__ !== 'undefined' };
            try { out.matcher = typeof M !== 'undefined' && M && M.RULES ? M.RULES.length : String(typeof M); } catch (e) { out.matcher = "err:" + e.message; }
            return out;
          })()`,
          returnByValue: true,
        });
        console.log(line, JSON.stringify(r && r.result && r.result.value));
      } catch (e) {
        console.log(line, "EVAL_ERR", String(e.message).slice(0, 140));
      }
    } else {
      console.log(line);
    }
  }

  // Any extension error visible via the main world's error state? Also check
  // whether the extension id/patterns registered by asking Chrome for the
  // extension's own view: use chrome.runtime in an isolated world (needs
  // externally_connectable — not available), so instead: did our content
  // script even MATCH? Query the manifest from the service worker context is
  // not reachable from a page. Print page errors captured so far instead.
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  console.log("pageerrors after reload:", JSON.stringify(errs));

  await cdp.detach();
  await ctx.close();
})();
