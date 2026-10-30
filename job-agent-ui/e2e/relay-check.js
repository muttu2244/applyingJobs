/* relay-check.js — does dashboard-relay.js actually inject on the dashboard?
 *
 * The dashboard shows "extension isn't loaded" while chrome://extensions says
 * 2.13.1. This launches the SAME unpacked extension queue-resume.js uses
 * (Playwright's Chromium, fresh profile) and reads the mark the relay sets, on
 * BOTH supported origins. If the mark is absent here too, the extension side is
 * at fault; if it is present, the cause is the user's profile, site access or
 * enabled state.
 *
 * Starts `node server.js` itself if nothing answers, and stops ONLY the server
 * it started (one already running is left alone).
 *
 * usage: node relay-check.js
 */
"use strict";
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const PROFILE = path.join(__dirname, ".profile-relay");
const BASE = "http://127.0.0.1:8357";

function ping(url) {
  return new Promise((res) => {
    const r = http.get(url, { timeout: 2000 }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.on("timeout", () => { r.destroy(); res(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  if (await ping(BASE + "/")) return null;                 // already up: not ours to stop
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, stdio: "ignore", detached: false,
  });
  for (let i = 0; i < 40; i++) {                           // up to ~10s
    if (await ping(BASE + "/")) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error("server.js did not come up on " + BASE);
}

const read = (page) => page.evaluate(() => ({
  marked: document.documentElement.hasAttribute("data-job-agent-ext"),
  origin: location.origin,
  cards: document.querySelectorAll("#job-cards .jcard").length,
  title: document.title,
}));

(async () => {
  let server = null;
  let ctx = null;
  try {
    server = await ensureServer();
    console.log("dashboard: " + BASE + (server ? " (started by this script)" : " (already running)"));

    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    console.log("service worker:", sw.url());

    for (const origin of ["http://127.0.0.1:8357", "http://localhost:8357"]) {
      const page = await ctx.newPage();
      try {
        await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(2000);
        console.log(origin, "->", JSON.stringify(await read(page)));
      } catch (e) {
        console.log(origin, "-> nav error: " + e.message.split("\n")[0]);
      }
      await page.close().catch(() => {});
    }
    console.log("\nmarked:true on both origins -> extension + manifest are fine;\n" +
      "                               the cause is your browser profile / Site access.\n" +
      "marked:false                 -> the relay is not injecting; report this output.");
  } catch (e) {
    console.log("ERR " + e.message);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (server) server.kill();
  }
})();
