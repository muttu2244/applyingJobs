/* dashboard-relay.js — the dashboard page's only channel to the extension.
 *
 * The dashboard (http://127.0.0.1:8357) is a plain page: it cannot open a
 * background tab, and it has no chrome.* API. This content script runs inside
 * that page, so one-click Apply can stay behind the scenes — the page posts an
 * intent, this relays it to the service worker, and the worker opens the job
 * page without stealing the user's tab.
 *
 * It also marks the document (`data-job-agent-ext`), which is the flag app.js
 * reads to decide between a background tab and a visible one. A DOM attribute,
 * not a window property: content scripts live in their own JS world, and only
 * the DOM is shared with the page.
 */
(() => {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;

  /* Mark first — but document_start can fire before <html> exists, and the old
   * `try { documentElement.setAttribute } catch { return }` then bailed out of
   * the WHOLE script: no mark, no listener, and the dashboard reports "extension
   * isn't loaded" forever. Mark now if we can, and as soon as <html> appears if
   * we cannot. */
  const mark = () => {
    try {
      document.documentElement.setAttribute("data-job-agent-ext", "1");
      return true;
    } catch { return false; }
  };
  if (!mark()) {
    try {
      const obs = new MutationObserver(() => { if (mark()) obs.disconnect(); });
      obs.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", () => { mark(); obs.disconnect(); }, { once: true });
    } catch { /* last resort: the dashboard reads the attribute live on render */ }
  }

  /* Only the two intents the dashboard legitimately has — anything else a page
   * or a compromised script posts is dropped rather than relayed to the worker. */
  const ALLOWED = new Set(["apply:open"]);

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;                 // not this page talking to itself
    if (e.origin !== location.origin) return;        // an embedded frame must not relay
    const m = e.data;
    if (!m || m.source !== "job-agent-dashboard") return;
    if (!ALLOWED.has(m.type)) return;
    if (m.type === "apply:open" && (typeof m.url !== "string" || !/^https?:/i.test(m.url))) return;
    try {
      chrome.runtime.sendMessage({ type: m.type, url: m.url });
    } catch { /* worker asleep — the user can open the job from the card */ }
  });
})();
