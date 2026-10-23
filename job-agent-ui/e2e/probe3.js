/* probe3.js — find a Greenhouse board that does NOT redirect off a matched
 * domain, and an apply URL on it. Prints job + apply links for board-sweep. */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");

const CANDIDATES = [
  "https://job-boards.greenhouse.io/figma",
  "https://job-boards.greenhouse.io/ramp",
  "https://job-boards.greenhouse.io/anduril",
  "https://job-boards.greenhouse.io/discord",
];

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();

  for (const u of CANDIDATES) {
    try {
      const r = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      const finalUrl = page.url();
      const host = new URL(finalUrl).hostname;
      const matched = /greenhouse\.io|lever\.co|ashbyhq\.com/.test(host);
      const firstJob = await page.evaluate(() => {
        const a = document.querySelector("a[href*='/jobs/'], a[href*='/job/']");
        return a ? a.href : null;
      });
      console.log(JSON.stringify({
        candidate: u, status: r && r.status(), finalHost: host, matched,
        title: (await page.title()).slice(0, 60), firstJob,
      }));
      if (matched && firstJob) {
        // Does it have an apply form on the same matched domain?
        const applyUrl = /\/jobs\/\d+/.test(firstJob)
          ? firstJob.replace(/\/jobs\/(\d+).*/, "/jobs/$1/apply")
          : null;
        if (applyUrl) {
          const r2 = await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(2500);
          const info = await page.evaluate(() => ({
            inputs: document.querySelectorAll("input, textarea, select").length,
            iframes: document.querySelectorAll("iframe").length,
            submit: [...document.querySelectorAll("button, input[type=submit]")]
              .map((b) => (b.value || b.textContent || "").trim()).filter(Boolean).slice(0, 6),
          }));
          console.log(JSON.stringify({
            applyUrl, status: r2 && r2.status(), finalHost: new URL(page.url()).hostname,
            matched: /greenhouse\.io|lever\.co|ashbyhq\.com/.test(new URL(page.url()).hostname),
            ...info,
          }));
          if (/greenhouse\.io/.test(new URL(page.url()).hostname) && info.inputs > 0) {
            console.log("WINNER " + page.url());
            break;
          }
        }
      }
    } catch (e) {
      console.log(JSON.stringify({ candidate: u, error: String(e.message).slice(0, 120) }));
    }
  }
  await ctx.close();
})();
