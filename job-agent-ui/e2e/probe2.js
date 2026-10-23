/* probe2.js — ground truth for the captcha-visibility rule + URL fixes.
 * Dumps computed styles up the ancestor chain of every captcha match on a
 * real Lever apply page, evaluates the candidate visibility rule, and checks
 * whether alternate board URLs resolve (foundit 404, greenhouse redirect).
 */
"use strict";
const { chromium } = require("playwright");
const path = require("path");

const EXT = path.resolve(__dirname, "..", "extension");

const SELS = [
  "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[title*='reCAPTCHA' i]",
  ".g-recaptcha", ".h-captcha", "[data-hcaptcha-widget-id]",
  "[id*='captcha' i]", "div[class*='captcha' i]",
];

/* Candidate rule: invisible if own rect is empty, or any ancestor-or-self is
 * display:none / visibility:hidden / opacity:0, or clips (overflow != visible)
 * while having a zero client size. */
const RULE = `(function (sels) {
  function vis(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && (r.width === 0 || r.height === 0)) return { v: false, why: "own rect empty" };
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none") return { v: false, why: "display:none on " + n.tagName + "." + n.className };
      if (cs.visibility !== "visible") return { v: false, why: "visibility " + cs.visibility + " on " + n.tagName + "." + n.className };
      if (parseFloat(cs.opacity) === 0) return { v: false, why: "opacity:0 on " + n.tagName + "." + n.className };
      const cw = n.clientWidth, ch = n.clientHeight;
      if (cw === 0 && cs.overflowX !== "visible") return { v: false, why: "clipped X (cw=0, overflow-x:" + cs.overflowX + ") on " + n.tagName + "." + n.className };
      if (ch === 0 && cs.overflowY !== "visible") return { v: false, why: "clipped Y (ch=0, overflow-y:" + cs.overflowY + ") on " + n.tagName + "." + n.className };
    }
    return { v: true, why: "rendered" };
  }
  const out = [];
  for (const s of sels) {
    let els = [];
    try { els = document.querySelectorAll(s); } catch (e) { continue; }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      out.push({ sel: s, tag: el.tagName, cls: String(el.className).slice(0, 60),
                 w: Math.round(r.width), h: Math.round(r.height), vis: vis(el) });
    }
  }
  return out;
})(${JSON.stringify(SELS)})`;

const STYLE_DUMP = `(function () {
  function chain(el) {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && out.length < 8; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      out.push({ tag: n.tagName, cls: String(n.className).slice(0, 50),
                 rect: Math.round(r.width) + "x" + Math.round(r.height),
                 client: n.clientWidth + "x" + n.clientHeight,
                 disp: cs.display, vis: cs.visibility, op: cs.opacity,
                 ox: cs.overflowX, oy: cs.overflowY, pos: cs.position });
    }
    return out;
  }
  const f = document.querySelector("iframe[src*='hcaptcha']");
  const d = document.querySelector(".h-captcha");
  return { iframe: f ? chain(f) : null, wrapper: d ? chain(d) : null };
})()`;

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, ".profile"), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const page = await ctx.newPage();

  // 1. Lever apply page: captcha structure + visibility verdict
  await page.goto("https://jobs.lever.co/artera/cc5cbc4d-c7e7-4573-993f-526cb33f5a81/apply",
    { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  console.log("=== LEVER rule verdict ===");
  console.log(JSON.stringify(await page.evaluate(RULE), null, 1));
  console.log("=== LEVER ancestor chain ===");
  console.log(JSON.stringify(await page.evaluate(STYLE_DUMP), null, 1));

  // 2. foundit alternate URLs
  for (const u of ["https://www.foundit.in/", "https://www.foundit.in/srch/python-jobs"]) {
    try {
      const r = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      console.log(`=== FOUNDIT ${u} -> status ${r && r.status()} final ${page.url()} title ${JSON.stringify(await page.title())}`);
    } catch (e) { console.log(`=== FOUNDIT ${u} ERR ${e.message.slice(0, 120)}`); }
  }

  // 3. greenhouse: does a non-redirecting board exist? try another company
  for (const u of ["https://boards.greenhouse.io/airbnb", "https://job-boards.greenhouse.io/spotify"]) {
    try {
      const r = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      console.log(`=== GH ${u} -> status ${r && r.status()} final ${page.url()} title ${JSON.stringify(await page.title())}`);
    } catch (e) { console.log(`=== GH ${u} ERR ${e.message.slice(0, 120)}`); }
  }

  // 4. naukri with manifest match fix pending: does the page even render in this browser?
  try {
    const r = await page.goto("https://www.naukri.com/python-jobs", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log(`=== NAUKRI status ${r && r.status()} final ${page.url()} title ${JSON.stringify(await page.title())}`);
    console.log(JSON.stringify(await page.evaluate(() => ({
      inputs: document.querySelectorAll("input").length,
      links: document.querySelectorAll("a").length,
      bodyLen: (document.body.innerText || "").length,
    }))));
  } catch (e) { console.log(`=== NAUKRI ERR ${e.message.slice(0, 120)}`); }

  await ctx.close();
})();
