/* workday-apply.js — the external-ATS leg of "once connected, it applies".
 *
 * Proven with the REAL extension in real Chromium, against a live Workday
 * tenant whose application form sits behind a cookie-consent wall:
 *   1. job detail  -> engine preview() MUST see the bare <a href="…/apply">
 *                     opener (the autopilot's own gate),
 *   2. /apply page -> engine run({submit:false}) itself: dismisses the consent
 *                     banner (DECLINE preferred), fills the real form,
 *                     submits NOTHING.
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "extension");
const ARG_JOB = process.argv[2];
if (!ARG_JOB) { console.error("usage: node workday-apply.js <job-detail-url>"); process.exit(2); }

async function probeEngine(page) {
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
    } catch { /* context gone */ }
  }
  await cdp.detach();
  return null;
}

/* run({submit:false}) in the isolated world — consent + opener + fill, no submit */
async function engineFill(page, contextId) {
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp.send("Runtime.evaluate", {
    contextId,
    expression:
      "__JOB_AGENT__.run({submit:false}).then(r => ({ok: r.ok, " +
      "n: (r.filled||[]).length, keys: (r.filled||[]).map(f => f.key), " +
      "open: r.openQuestions || [], failed: (r.failed||[]).map(f => f.key), " +
      "submitted: !!r.submitted, note: r.note || \"\"}))",
    awaitPromise: true,
    returnByValue: true,
  }).catch((e) => ({ error: String(e) }));
  await cdp.detach();
  return r && r.result ? r.result.value : r;
}

async function readInputs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter((el) => el.value && !["hidden", "file", "password"].includes(el.type || "text"))
      .slice(0, 20)
      .map((el) => ({ field: el.name || el.id || el.type || el.tagName.toLowerCase(),
                      value: String(el.value).slice(0, 40) }))
  );
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();
  const log = (s) => console.log("=== " + s);
  let failed = false;

  try {
    // 1. job detail — engine must see the bare-anchor Apply opener
    await page.goto(ARG_JOB, { waitUntil: "domcontentloaded", timeout: 45000 });
    const applyHref = await (async function pollApply() {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        try {
          const h = await page.evaluate(() => {
            const a = [...document.querySelectorAll("a[href]")].find((x) =>
              /\/(apply|application)(\/|$)/i.test(x.href) &&
              /^apply( now)?$/i.test((x.innerText || "").trim()));
            return a ? a.href : null;
          });
          if (h) return h;
        } catch { /* nav race */ }
        await page.waitForTimeout(700);
      }
      return null;
    })();
    log("JOB " + page.url());
    log("DETAIL title: " + JSON.stringify(await page.title()));
    if (!applyHref) { log("FAIL: no apply anchor on detail page"); process.exit(1); }

    const eng1 = await probeEngine(page);
    const openerSeen = !!(eng1 && eng1.prev && eng1.prev.openerControl);
    log("PREVIEW(detail): " + JSON.stringify(eng1 && eng1.prev));
    log(openerSeen ? "OPENER DETECTED by engine (autopilot can start the apply)"
                   : "FAIL: engine cannot see the apply opener");
    if (!openerSeen) failed = true;

    // 2. the application route (behind the tenant's consent wall)
    await page.goto(applyHref, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    log("FORM url: " + page.url());

    // 2b. tenants can put a chooser in front of the form ("Start Your
    // Application" / "Apply Manually"). The autopilot's SUBMIT mode clicks
    // exactly this opener — fill-only mode by contract never opens, so the
    // harness plays that one click here, then lets the engine do the rest.
    const chooser = await page.evaluate(() => {
      const re = /^(start( your)? application|apply manually( to this job)?)$/i;
      const el = [...document.querySelectorAll("button, a, [role=button], input[type=submit]")]
        .find((e) => re.test((e.innerText || e.value || "").trim()));
      if (!el) return null;
      const label = (el.innerText || el.value || "").trim();
      el.click();
      return label;
    });
    if (chooser) {
      log("CHOOSER: clicked " + JSON.stringify(chooser) + " — waiting for the form to render");
      // Workday's React app mounts the wizard slowly (seen at ~8s) and one
      // hop deeper (…/apply/applyManually). Wait for real inputs, not a clock.
      const end = Date.now() + 25000;
      for (;;) {
        const n = await page.evaluate(
          () => document.querySelectorAll("input, textarea, select").length
        ).catch(() => 0);
        if (n > 0 || Date.now() > end) break;
        await page.waitForTimeout(700);
      }
      log("FORM rendered at: " + page.url());
    } else {
      log("CHOOSER: none on this page (form expected directly)");
    }

    const eng2 = await probeEngine(page);
    if (!eng2) { log("FAIL: engine not injected on form page"); process.exit(1); }

    // 3. engine's OWN run: dismiss consent, fill, never submit
    const res = await engineFill(page, eng2.contextId);
    log("ENGINE run({submit:false}): " + JSON.stringify(res));
    const inputs = await readInputs(page);
    log("DOM after run: " + JSON.stringify(inputs.slice(0, 12)));

    const consentGone = await page.evaluate(() =>
      !([...document.querySelectorAll("button")].some((b) => /^(decline|accept cookies)$/i.test((b.innerText || "").trim()))));
    log("CONSENT banner dismissed: " + consentGone);

    if (!res || res.error) { log("FAIL: engine run errored: " + JSON.stringify(res)); failed = true; }
    else if (res.submitted) { log("FAIL: submit:false still submitted!"); failed = true; }
    else if (!(res.n >= 1)) { log("FAIL: engine filled nothing"); failed = true; }
    else if (!consentGone) { log("FAIL: consent banner still up"); failed = true; }
    else log(`RESULT: PASS — engine filled ${res.n} field(s) on Workday's own form
              (keys: ${res.keys.join(", ")}), consent declined, nothing submitted`);

    if (failed) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();
