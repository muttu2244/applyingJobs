/* probe4.js — which captcha element passes the visibility rule on the two
 * boards still reporting captcha:true (discord greenhouse, foundit)? */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const EXT = path.resolve(__dirname, "..", "extension");

const SELS = [
  "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[title*='reCAPTCHA' i]",
  ".g-recaptcha", ".h-captcha", "[data-hcaptcha-widget-id]",
  "[id*='captcha' i]", "div[class*='captcha' i]",
];

const RULE = `(function (sels) {
  function vis(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && (r.width === 0 || r.height === 0)) return { v: false, why: "own rect empty" };
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none") return { v: false, why: "display:none" };
      if (cs.visibility !== "visible") return { v: false, why: "visibility:" + cs.visibility };
      if (parseFloat(cs.opacity) === 0) return { v: false, why: "opacity:0" };
      if (n.clientWidth === 0 && cs.overflowX !== "visible") return { v: false, why: "clipped X" };
      if (n.clientHeight === 0 && cs.overflowY !== "visible") return { v: false, why: "clipped Y" };
    }
    return { v: true, why: "rendered" };
  }
  const out = [];
  for (const s of sels) {
    let els = [];
    try { els = document.querySelectorAll(s); } catch (e) { continue; }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      out.push({ sel: s, tag: el.tagName, cls: String(el.className).slice(0, 50),
                 id: el.id || "", src: (el.src || "").slice(0, 110),
                 title: el.getAttribute ? (el.getAttribute("title") || "") : "",
                 w: Math.round(r.width), h: Math.round(r.height),
                 x: Math.round(r.x), y: Math.round(r.y), vis: vis(el) });
    }
  }
  return out;
})(${JSON.stringify(SELS)})`;

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();

  for (const [name, u] of [
    ["GREENHOUSE", "https://job-boards.greenhouse.io/discord/jobs/8815116002"],
    ["FOUNDIT", "https://www.foundit.in/srch/python-jobs"],
  ]) {
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    console.log(`=== ${name} ${page.url()}`);
    const verdicts = await page.evaluate(RULE);
    console.log(JSON.stringify(verdicts.filter((x) => x.vis.v), null, 1));  // only the ones that PASS
    console.log("total matches:", verdicts.length, "rendered:", verdicts.filter((x) => x.vis.v).length);
    console.log("invisible sample:", JSON.stringify(verdicts.filter((x) => !x.vis.v).slice(0, 4)));
  }

  await ctx.close();
})();
