/* yes-no-widget.js — the real screening widget, in a real browser.
 *
 * The report: "Do you have form 16 and P/F A/c of current & previous company"
 * with two pills reading only "yes" and "no" — previously "a field it couldn't
 * place", so the application stalled. The engine halves of this are unit-tested
 * against a fake DOM; this runs the SAME engine on a real DOM in Chromium and
 * asserts the radios end up checked.
 *
 * The fixture also carries a nameless variant (custom React widgets ship radios
 * with no name attribute), so the group-by-container fallback is exercised for
 * real, not just against a mock.
 *
 * usage: node yes-no-widget.js
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const EXT = path.resolve(__dirname, "..", "extension");
const FIXTURE = "file://" + path.join(__dirname, "fixtures", "yes-no-widget.html").replace(/\\/g, "/");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
};

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile-scrape"), {
    headless: false,
    viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let res = null;
  try {
    const page = await ctx.newPage();
    await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);

    /* The dashboard must not be consulted by this check: run() reports to it
     * when it can reach one. Track the Save click the same way. */
    await page.evaluate(() => {
      window.fetch = async () => ({ ok: false, json: async () => null });
      const save = document.getElementById("save");
      save.addEventListener("click", () => { window.__saveClicked = true; });
    });

    /* Load the engine the way the popup injects it: matcher, pack, engine. */
    for (const f of ["matcher.js", "fillpack.js", "content.js"]) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(EXT, f), "utf8") });
    }
    await page.waitForTimeout(300);

    res = await page.evaluate(() => window.__JOB_AGENT__.run({ submit: true }));
    console.log("=== engine verdict: " + JSON.stringify(res));
    await page.waitForTimeout(400);

    const state = await page.evaluate(() => {
      const groups = [...document.querySelectorAll(".opts")].map((g) => ({
        question: g.previousElementSibling.textContent.trim(),
        checked: [...g.querySelectorAll("input")].filter((i) => i.checked).map((i) => i.value),
      }));
      return {
        groups,
        saveClicked: !!window.__saveClicked,
        confirmed: /thank you for your application/i.test(document.body.innerText),
      };
    });

    const [form16, passport, notice] = state.groups;
    check("form 16 pair: the question is the one on the page",
      /form 16/i.test(form16.question), form16.question);
    check("form 16 pair: 'yes' is checked (the answer on record)",
      form16.checked.length === 1 && form16.checked[0] === "yes", form16.checked);
    check("passport pair: nameless radios resolved to one group",
      passport.checked.length === 1 && passport.checked[0] === "no", passport.checked);
    check("passport pair: answered 'no', not left blank or guessed 'yes'",
      passport.checked[0] === "no", passport.checked);
    check("notice period: the listed option on record is checked",
      notice.checked.length === 1 && notice.checked[0] === "2 Months", notice.checked);
    check("all three answers recorded against their wording",
      (res.filled || []).some((f) => /form 16/i.test(f.key)) &&
      (res.filled || []).some((f) => /passport/i.test(f.key)) &&
      (res.filled || []).some((f) => /notice period/i.test(f.key)), res.filled);
    check("Save advanced the questionnaire step", state.saveClicked === true, state.saveClicked);
    check("run submitted the form after Save", res.ok === true && res.submitted === true, res);
    check("confirmation seen", state.confirmed === true, state.confirmed);
  } catch (e) {
    console.log("FAIL threw: " + (e && e.stack || e));
    fail++;
  } finally {
    await ctx.close().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
