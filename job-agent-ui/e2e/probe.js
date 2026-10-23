/* Probe: which captcha selectors match on the Lever apply page, and what do
 * they look like? Also why greenhouse/naukri engines were "not injected". */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  // 1. captcha selector matches on lever-apply
  let page = await ctx.newPage();
  await page.goto("https://jobs.lever.co/artera/cc5cbc4d-c7e7-4573-993f-526cb33f5a81/apply", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const cap = await page.evaluate(() => {
    const SELS = [
      "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[title*='reCAPTCHA' i]",
      ".g-recaptcha", ".h-captcha", "[data-hcaptcha-widget-id]",
      "[id*='captcha' i]", "div[class*='captcha' i]",
    ];
    const out = [];
    for (const s of SELS) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        out.push({ sel: s, tag: el.tagName, id: el.id || "", cls: String(el.className || "").slice(0, 60),
          w: Math.round(r.width), h: Math.round(r.height),
          src: (el.getAttribute && el.getAttribute("src") || "").slice(0, 90) });
      }
    }
    return out;
  });
  console.log("=== LEVER captcha matches: " + JSON.stringify(cap, null, 1));
  await page.close();

  // 2. greenhouse: what URL does it land on?
  page = await ctx.newPage();
  await page.goto("https://boards.greenhouse.io/coupang/jobs/8204842", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("gh goto: " + e.message));
  await page.waitForTimeout(4000);
  console.log("=== GREENHOUSE final url: " + page.url() + " | title: " + await page.title());
  const ghFrame = await page.evaluate(() => ({ frames: [...document.querySelectorAll("iframe")].map(f => (f.src || "").slice(0, 80)), inputs: document.querySelectorAll("input,textarea,select").length }));
  console.log("=== GREENHOUSE frames/inputs: " + JSON.stringify(ghFrame));
  await page.close();

  // 3. naukri: does it even load?
  page = await ctx.newPage();
  const resp = await page.goto("https://www.naukri.com/python-jobs", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => null);
  await page.waitForTimeout(4000);
  console.log("=== NAUKRI status: " + (resp && resp.status()) + " url: " + page.url() + " title: " + await page.title().catch(() => ""));
  await page.close();

  await ctx.close();
})();
