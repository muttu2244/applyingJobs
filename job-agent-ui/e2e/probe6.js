/* probe6.js — why doesn't workday.wd5 render in this browser?
 * Tries the job URL + a couple of alternatives with generous waits; dumps
 * HTTP status, title, body size, and console/page errors. */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");

const URLS = [
  "https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/Software-Development-Engineer_JR-0110318",
  "https://workday.wd5.myworkdayjobs.com/Workday",
  "https://kla.wd1.myworkdayjobs.com/en-US/Search",
];

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

  for (const u of URLS) {
    errors.length = 0;
    try {
      const r = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(12000);
      const info = await page.evaluate(() => ({
        title: document.title,
        ready: document.readyState,
        bodyLen: (document.body && document.body.innerText || "").length,
        applyBtns: [...document.querySelectorAll("button, a")]
          .map((e) => (e.innerText || "").trim())
          .filter((t) => /^apply/i.test(t)).slice(0, 5),
        inputs: document.querySelectorAll("input, textarea, select").length,
      }));
      console.log(JSON.stringify({ url: u, status: r && r.status(), final: page.url(), ...info, errs: errors.slice(0, 3) }));
    } catch (e) {
      console.log(JSON.stringify({ url: u, error: String(e.message).slice(0, 140), final: page.url() }));
    }
  }
  await ctx.close();
})();
