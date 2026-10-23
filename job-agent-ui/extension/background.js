/* background.js — MV3 relay between content scripts and the local dashboard.
 *
 * Content scripts live on https job-board pages; a direct fetch from there to
 * http://127.0.0.1:8357 is subject to the PAGE's CSP and to Chrome's private
 * network access preflight, both of which can refuse it silently — no
 * board-origin request ever reached server.log (autopilot reports, harvest
 * and session verdicts all died client-side). Fetches made by THIS service
 * worker run on the extension's own origin; manifest.json grants it host
 * permission to http://127.0.0.1:8357/*, which exempts it from page CSP and
 * from the loopback preflight. Content scripts ask; this worker fetches.
 */
"use strict";
const DASHBOARD = "http://127.0.0.1:8357";

/* ---------- auto-continue the apply queue ----------
 * The chain moves only while a job page is alive: it reports back and the
 * server hands out the next job. When Chrome restarts mid-run there is no
 * page left to ask, and the dashboard may not be open either — the queue
 * would sit there until someone pressed Resume. This checks the dashboard
 * whenever the browser starts, whenever this worker wakes for a message
 * (a board tab harvesting, a page finishing a job, the popup opening — the
 * cheap always-available heartbeat), and asks for the next queued job when
 * NOTHING has reported for QUEUE_STALL_MS. The staleness rule is the same
 * one the dashboard's watchdog uses: any decision timestamp means a page is
 * (or just was) alive, so a running chain is never interrupted; a kicked
 * job arms its own quiet period so repeated wake-ups can't stack tabs. */
const QUEUE_STALL_MS = 150000;
let kickArmedAt = 0;
let kickChecking = false;

async function resumeIfStale() {
  if (kickChecking) return;
  if (Date.now() - kickArmedAt <= QUEUE_STALL_MS) return;
  kickChecking = true;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(DASHBOARD + "/api/bootstrap", { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return;
    const boot = await r.json();
    const run = boot && boot.run;
    if (!run || run.done || !(run.total > run.attempted)) return;
    const now = Date.now();
    let last = run.startedAt || 0;
    for (const d of Object.values(boot.decisions || {})) {
      if (d && typeof d.ts === "number" && d.ts > last) last = d.ts;
    }
    if (now - last <= QUEUE_STALL_MS) return;  // a page is reporting — hands off
    kickArmedAt = now;                         // armed before the handout so a
    const next = await fetch(DASHBOARD + "/api/apply/next", { signal: ctl.signal });
    if (!next.ok) return;
    const j = await next.json();
    if (j && j.job && j.job.url) {
      /* background, not focused: a resumed queue never steals the user's tab */
      await chrome.tabs.create({ url: j.job.url, active: false });
    }
  } catch { /* dashboard not running — nothing to continue */ }
  finally { kickChecking = false; }
}

chrome.runtime.onStartup.addListener(() => { resumeIfStale(); });
chrome.runtime.onInstalled.addListener(() => { resumeIfStale(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  /* Any message proves this worker's browser is awake — cheap enough to
   * piggyback the staleness check on it (the guard above makes it a no-op
   * while a chain is alive or a kick just happened). */
  if (msg) resumeIfStale();
  /* Apply-run handoff: the page that just finished its job asks for the next
   * one to be opened. The queue itself is the dashboard's — this worker only
   * opens the tab, in the background so it never steals the user's focus. */
  if (msg && msg.type === "apply:open" && typeof msg.url === "string" && /^https?:/i.test(msg.url)) {
    chrome.tabs.create({ url: msg.url, active: false })
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 120) }));
    return true;
  }

  if (!msg || msg.type !== "dashboard" || typeof msg.path !== "string") return false;

  const method = msg.method === "POST" ? "POST" : "GET";
  let body;
  if (method === "POST") {
    /* content scripts already hand us a JSON string — parse once so the
     * fetch below can re-serialize it cleanly */
    try { body = JSON.stringify(typeof msg.body === "string" ? JSON.parse(msg.body) : (msg.body || {})); }
    catch { body = "{}"; }
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  fetch(DASHBOARD + msg.path, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body,
    signal: ctl.signal,
  })
    .then(async (r) => {
      clearTimeout(t);
      let json = null;
      try { json = await r.json(); } catch {}
      sendResponse({ ok: r.ok, status: r.status, json });
    })
    .catch((e) => {
      clearTimeout(t);
      sendResponse({ ok: false, status: 0, json: null, error: String(e).slice(0, 120) });
    });
  return true;   // keep the channel open for the async response
});
