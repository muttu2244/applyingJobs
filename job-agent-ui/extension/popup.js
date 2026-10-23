/* Popup — the boards AND the matched jobs, right in the extension.
 *
 * Two halves:
 *   1. Board chips. Clicking one connects it: the board opens in a tab (in the
 *      background, so this popup stays up) and the content script reports
 *      whether you are REALLY signed in. A chip turns green only on evidence —
 *      a Sign out control or profile link. "Not signed in" stays red until you
 *      log in in that tab; the dashboard does not take your word for it.
 *   2. One card per job: which board it came from, experience, location, pay,
 *      how fresh it is. Card opens the posting; Approve feeds autopilot.
 *
 * All data comes from the local dashboard (/api/bootstrap); the extension has
 * host permission for it, so no page CSP can block this read.
 */
"use strict";

const BASE = "http://127.0.0.1:8357";
const PINNED = ["linkedin", "naukri", "indeed", "hirist", "foundit", "instahyre",
  "wellfound", "unstop", "internshala", "glassdoor", "cutshort", "tophire",
  "leetcode", "geeksforgeeks", "ambitionbox", "hackerearth"];
const CHIP_PREVIEW = 6;      // chips shown before "more"

const go = document.getElementById("go");
const fillOnly = document.getElementById("fillonly");
const autoToggle = document.getElementById("autopilot");
const out = document.getElementById("out");
const statusEl = document.getElementById("status");
const boardsEl = document.getElementById("boards");
const jobsEl = document.getElementById("jobs");
const ctaEl = document.getElementById("cta");
const runEl = document.getElementById("runline");

const say = (html) => { out.innerHTML = html; };
const ver = (() => {
  try { return chrome.runtime.getManifest().version; } catch { return ""; }
})();
document.getElementById("ver").textContent = ver ? `v${ver}` : "";

let data = null;                       // last /api/bootstrap
let offline = false;
let allBoards = false;                 // board chip expander
const boardTabs = new Map();           // board id -> tab id we opened

/* ---------- dashboard API ---------- */
async function api(path, opts) {
  try {
    const r = await fetch(BASE + path, Object.assign({ cache: "no-store" }, opts || {}));
    if (!r.ok) return { error: `dashboard said ${r.status}` };
    return await r.json();
  } catch {
    return null;                       // dashboard not running
  }
}
const post = (path, body) => api(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

/* ---------- state → chip appearance ---------- */
function boardState(b) {
  const s = b.session || {};
  if (b.connected) {
    return { cls: "on", tag: "", tip: `Connected — click to open ${b.name}'s jobs (refreshes listings)` };
  }
  if (s.pending) {
    return { cls: "wait", tag: " · verifying", tip: `Checking whether you're signed in to ${b.name} in the tab that just opened…` };
  }
  if (s.ok === false && !s.unknown) {
    return { cls: "bad", tag: " · log in", tip: `Not signed in to ${b.name} — log in in the opened tab, then click again` };
  }
  if (s.at) {
    return { cls: "wait", tag: " · unverified", tip: `No clear login signal on ${b.name}. Click to re-check, or skip the check.` };
  }
  return { cls: "", tag: "", tip: `Connect ${b.name} — opens the board and verifies your session` };
}

/* ---------- render ---------- */
function renderStatus() {
  if (offline) {
    statusEl.className = "notrun";
    statusEl.innerHTML = "Dashboard not running — start it: <b>node server.js</b> in job-agent-ui";
    return;
  }
  statusEl.className = "";
  const boards = (data && data.boards) || [];
  const connected = boards.filter((b) => b.connected).length;
  const pending = boards.filter((b) => !b.connected && b.session && b.session.pending).length;
  const jobs = (data && data.jobs) || [];
  const fresh = jobs.filter((j) => j.fresh).length;
  const bits = [`<b>${connected}</b> board${connected === 1 ? "" : "s"} connected`];
  if (pending) bits.push(`<b>${pending}</b> verifying`);
  bits.push(`<b>${jobs.length}</b> job${jobs.length === 1 ? "" : "s"}${fresh ? ` (<b>${fresh}</b> fresh)` : ""}`);
  statusEl.innerHTML = bits.join(" · ");
}

function renderBoards() {
  boardsEl.innerHTML = "";
  if (!data || !Array.isArray(data.boards)) return;
  const byId = new Map(data.boards.map((b) => [b.id, b]));
  const ordered = [
    ...data.boards.filter((b) => b.connected),
    ...PINNED.map((id) => byId.get(id)).filter((b) => b && !b.connected),
    ...data.boards.filter((b) => !b.connected && !PINNED.includes(b.id)),
  ];
  const shown = allBoards ? ordered : ordered.slice(0, Math.max(CHIP_PREVIEW, ordered.filter((b) => b.connected).length));
  for (const b of shown) {
    const st = boardState(b);
    const wrap = document.createElement("span");
    wrap.className = "bwrap";

    const chip = document.createElement("button");
    chip.className = "chip " + st.cls;
    chip.title = st.tip;
    chip.dataset.board = b.id;
    chip.innerHTML = `<span class="dot"></span>${esc(b.name)}<span class="k">${esc(st.tag)}</span>`;
    chip.addEventListener("click", () => chipClick(b, chip));
    wrap.appendChild(chip);

    if (b.connected) {
      const off = document.createElement("button");
      off.className = "x";
      off.textContent = "×";
      off.title = `Disconnect ${b.name} — its jobs disappear from this list`;
      off.addEventListener("click", () => disconnect(b));
      wrap.appendChild(off);
    }

    /* Ambiguous verdict: the board page showed no clear login signal. Never
     * connect on silence — but offer the explicit override the dashboard has. */
    if (!b.connected && b.session && b.session.unknown && b.session.at) {
      const skip = document.createElement("button");
      skip.className = "skip";
      skip.textContent = "skip check";
      skip.title = `Connect ${b.name} without verifying your session — recorded as your choice`;
      skip.addEventListener("click", () => forceConnect(b));
      wrap.appendChild(skip);
    }
    boardsEl.appendChild(wrap);
  }
  if (!allBoards && ordered.length > shown.length) {
    const more = document.createElement("button");
    more.className = "chip";
    more.textContent = `+${ordered.length - shown.length} more`;
    more.addEventListener("click", () => { allBoards = true; renderBoards(); });
    boardsEl.appendChild(more);
  } else if (allBoards && ordered.length > CHIP_PREVIEW) {
    const less = document.createElement("button");
    less.className = "chip";
    less.textContent = "− fewer";
    less.addEventListener("click", () => { allBoards = false; renderBoards(); });
    boardsEl.appendChild(less);
  }
}

function fact(text, cls) {
  const s = document.createElement("span");
  s.className = "fact" + (cls ? " " + cls : "");
  s.textContent = text;
  return s;
}

function jobCard(j) {
  const boardName = (data.boards.find((b) => b.id === j.board) || {}).name || j.board || "board";
  const d = (data.decisions || {})[j.id] || {};
  const approved = d.action === "approve" || d.action === "apply" || d.action === "applied";

  const card = document.createElement("article");
  card.className = "job";
  card.dataset.job = String(j.id);
  card.title = "Open this job posting";
  card.addEventListener("click", () => chrome.tabs.create({ url: j.url, active: true }));

  const top = document.createElement("div");
  top.className = "top";
  const board = document.createElement("span");
  board.className = "board";
  board.textContent = boardName;
  top.appendChild(board);
  if (j.fresh) {
    const fresh = document.createElement("span");
    fresh.className = "fresh";
    fresh.textContent = "⚡ fresh";
    top.appendChild(fresh);
  }
  if (d.status === "applied") {
    const done = document.createElement("span");
    done.className = "fresh";
    done.textContent = "applied ✓";
    top.appendChild(done);
  } else if (d.status === "captcha" || d.status === "failed") {
    const halt = document.createElement("span");
    halt.className = "fresh";
    halt.style.color = "#d29922";
    halt.textContent = "halted — needs you";
    top.appendChild(halt);
  } else if (d.action === "apply") {
    const queued = document.createElement("span");
    queued.className = "fresh";
    queued.style.color = "#a5d6ff";
    queued.textContent = "queued";
    top.appendChild(queued);
  }
  const match = document.createElement("span");
  match.className = "match";
  match.textContent = `${j.match}%`;
  match.title = j.matched && j.matched.length ? `Matched: ${j.matched.join(", ")}` : "Match score";
  top.appendChild(match);
  card.appendChild(top);

  const h = document.createElement("h3");
  h.textContent = j.title || "(untitled)";
  card.appendChild(h);

  const co = document.createElement("p");
  co.className = "co";
  co.textContent = j.company || "—";
  card.appendChild(co);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (j.experience) meta.appendChild(fact(j.experience, "exp"));
  if (j.location) meta.appendChild(fact(j.location, "loc"));
  if (j.salary) meta.appendChild(fact(j.salary));
  card.appendChild(meta);

  const foot = document.createElement("div");
  foot.className = "foot";
  const listed = document.createElement("span");
  listed.className = "listed";
  const stamp = String(j.listed || "").replace(/^posted\s+/i, "");
  /* "3 days ago" reads as "posted 3 days ago"; "just posted"/"today" already
   * say when, so they are shown as-is. */
  listed.textContent = stamp ? (/^\d+\s+\w+\s+ago$/i.test(stamp) ? `posted ${stamp}` : stamp) : "";
  foot.appendChild(listed);

  const acts = document.createElement("span");
  acts.className = "acts";
  const approve = document.createElement("button");
  approve.className = "mini" + (approved ? " ok" : "");
  approve.textContent = approved ? "Approved ✓" : "Approve";
  approve.title = approved ? "Remove approval" : "Approve this job (autopilot may fill & submit it)";
  approve.addEventListener("click", (ev) => { ev.stopPropagation(); toggleApprove(j, approved); });
  acts.appendChild(approve);
  const open = document.createElement("button");
  open.className = "mini";
  open.textContent = "Open";
  open.addEventListener("click", (ev) => { ev.stopPropagation(); chrome.tabs.create({ url: j.url, active: true }); });
  acts.appendChild(open);
  foot.appendChild(acts);
  card.appendChild(foot);
  return card;
}

function renderJobs() {
  jobsEl.innerHTML = "";
  if (offline) {
    const p = document.createElement("p");
    p.className = "empty";
    p.innerHTML = "The dashboard is where your jobs are fetched and stored. " +
      "Start it with <b>node server.js</b>, then reopen this popup.";
    jobsEl.appendChild(p);
    return;
  }
  const boards = (data && data.boards) || [];
  const jobs = ((data && data.jobs) || []).slice().sort((a, b) => (b.match || 0) - (a.match || 0));
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    const anyConnected = boards.some((b) => b.connected);
    p.innerHTML = anyConnected
      ? "Connected, but no listings yet. Open a board's job search (click its chip) and scroll once — its cards are read automatically."
      : "No board connected yet. Click a board above: it opens that board, checks whether you are <b>really</b> signed in, and fetches its jobs the moment the check passes.";
    jobsEl.appendChild(p);
    return;
  }
  for (const j of jobs.slice(0, 60)) jobsEl.appendChild(jobCard(j));
}

/* ---------- the agent actions ---------- */
function renderCta() {
  ctaEl.innerHTML = "";
  if (offline || !data) return;
  const connected = data.boards.filter((b) => b.connected);
  /* approve + apply: a finished run leaves halted jobs queued (action "apply"),
   * and the user must be able to send those again. Applied jobs never count. */
  const approved = Object.entries(data.decisions || {})
    .filter(([, d]) => d.action === "approve" || d.action === "apply").length;

  const fetchAll = document.createElement("button");
  fetchAll.textContent = connected.length ? "⇣ Fetch all jobs" : "⇣ Fetch all jobs (connect a board)";
  fetchAll.title = "Walk each connected board's result pages and collect every matching job";
  fetchAll.disabled = !connected.length;
  fetchAll.addEventListener("click", () => fetchAllJobs(connected));
  ctaEl.appendChild(fetchAll);

  const apply = document.createElement("button");
  apply.className = "go";
  apply.textContent = approved ? `▶ Apply to approved (${approved})` : "▶ Apply to approved";
  apply.title = approved
    ? "The agent opens each approved job in turn, fills it and submits"
    : "Approve a job card first — the agent only ever applies to jobs you approved";
  apply.disabled = !approved;
  apply.addEventListener("click", () => startApplyRun(approved));
  ctaEl.appendChild(apply);
}

function renderRun() {
  runEl.innerHTML = "";
  const run = data && data.run;
  if (!run || (!run.total && !run.done)) return;
  const line = document.createElement("span");
  if (run.done) {
    line.innerHTML = `Run finished — <b>${run.applied}</b> applied, <b>${run.halted}</b> halted of <b>${run.total}</b>.`;
  } else {
    line.innerHTML = `Applying <b>${run.attempted}/${run.total}</b> · <b>${run.applied}</b> applied` +
      `${run.halted ? ` · <b>${run.halted}</b> halted` : ""}`;
  }
  runEl.appendChild(line);
  if (!run.done) {
    const stop = document.createElement("button");
    stop.textContent = "stop";
    stop.title = "Stop the run after the current job";
    stop.addEventListener("click", async () => {
      await post("/api/apply/stop");
      await refresh();
    });
    runEl.appendChild(stop);
  }
}

async function fetchAllJobs(boards) {
  if (!boards.length) return;
  say(`<span class="k">Fetching all listings — up to 5 pages per board…</span>`);
  for (const b of boards) {
    await post(`/api/boards/${encodeURIComponent(b.id)}/sweep`, { pages: 5 });
    try { await chrome.tabs.create({ url: b.searchUrl || b.loginUrl, active: false }); } catch {}
  }
  await refresh();
}

async function startApplyRun(approvedCount) {
  if (!approvedCount) return;
  const r = await post("/api/apply/start", { cap: 25, minMatch: 0 });
  if (!r || r.error) {
    say(`<span class="stop">${esc((r && r.error) || "dashboard not reachable")}</span>`);
    return;
  }
  await refresh();
  if (r.first && r.first.url) {
    await chrome.tabs.create({ url: r.first.url, active: true });
    say(`<span class="k">Run started — the agent applies in this tab, then opens the next job itself. ` +
        `Leave the browser open; results land here as they come.</span>`);
  }
}

function render() {
  renderStatus();
  renderBoards();
  renderCta();
  renderRun();
  renderJobs();
}

/* ---------- actions ---------- */
async function chipClick(b) {
  if (b.connected) {
    /* Already connected — take me to the board's jobs so new listings get
     * harvested (the content script reads them on load). */
    await chrome.tabs.create({ url: b.searchUrl || b.loginUrl, active: true });
    return;
  }
  /* A tab we opened for this board is still around (verifying, or waiting for
   * a log in). Bring it forward instead of piling up duplicates, and reload it
   * so the login check re-runs against the current session. */
  const tabId = boardTabs.get(b.id);
  if (tabId != null) {
    const shown = await chrome.tabs.update(tabId, { active: true }).then(() => true).catch(() => false);
    if (shown) {
      await post(`/api/boards/${encodeURIComponent(b.id)}/connect`, { connected: true });
      await chrome.tabs.reload(tabId).catch(() => {});
      say(`<span class="k">${esc(b.name)} is open in that tab — log in there if you need to; ` +
          `the session check runs again now.</span>`);
      return;
    }
    boardTabs.delete(b.id);          // the user closed it
  }
  await startConnect(b);
}

async function startConnect(b) {
  const r = await post(`/api/boards/${encodeURIComponent(b.id)}/connect`, { connected: true });
  if (!r || r.error) {
    say(`<span class="stop">${esc((r && r.error) || "dashboard not reachable")}</span>`);
    return;
  }
  say(`<span class="k">Opening ${esc(b.name)} to verify your session…</span>`);
  await openBoard(b);
  await refresh();
}

async function openBoard(b) {
  try {
    const tab = await chrome.tabs.create({ url: b.searchUrl || b.loginUrl, active: false });
    if (tab && tab.id != null) boardTabs.set(b.id, tab.id);
  } catch (e) {
    say(`<span class="stop">Could not open ${esc(b.name)}: ${esc(String(e && e.message || e))}</span>`);
  }
}

async function disconnect(b) {
  const r = await post(`/api/boards/${encodeURIComponent(b.id)}/connect`, { connected: false });
  if (!r || r.error) {
    say(`<span class="stop">${esc((r && r.error) || "dashboard not reachable")}</span>`);
    return;
  }
  boardTabs.delete(b.id);
  await refresh();
}

async function forceConnect(b) {
  const r = await post(`/api/boards/${encodeURIComponent(b.id)}/connect`, { connected: true, force: true });
  if (!r || r.error) {
    say(`<span class="stop">${esc((r && r.error) || "dashboard not reachable")}</span>`);
    return;
  }
  await refresh();
}

async function toggleApprove(j, approved) {
  const r = await post(`/api/jobs/${j.id}/action`, { action: approved ? "deny" : "approve" });
  if (!r || r.error) {
    say(`<span class="stop">${esc((r && r.error) || "dashboard not reachable")}</span>`);
    return;
  }
  data.decisions = r.decisions;
  render();
}

/* ---------- refresh loop ---------- */
async function refresh() {
  const d = await api("/api/bootstrap");
  if (!d || !Array.isArray(d.boards)) {
    /* Only flip to offline if we had a working dashboard before, or never got
     * one — a single failed poll must not blank a populated list. */
    offline = true;
    render();
    return;
  }
  offline = false;
  data = d;
  render();
}

refresh();
/* Poll while the popup is open: a background board tab reports its verdict and
 * harvests listings asynchronously, and the chips and cards must follow. */
const poll = setInterval(refresh, 2500);
window.addEventListener("unload", () => clearInterval(poll));

/* ---------- autopilot preference ---------- */
chrome.storage.local.get("autopilot", (s) => {
  autoToggle.checked = s.autopilot !== false;
});
autoToggle.addEventListener("change", () => {
  chrome.storage.local.set({ autopilot: autoToggle.checked });
});

/* ---------- fill current page (unchanged engine contract) ---------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/* Pages Chrome will never let an extension inject into. Chrome withholds the
 * URL for these (activeTab doesn't apply), so the scheme check is a best-effort
 * early exit; the catch below is the reliable path. */
const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source|brave|opera|vivaldi):/i;

async function run(submit) {
  go.disabled = fillOnly.disabled = true;
  say(`<span class="k">${submit ? "Filling and submitting…" : "Filling…"}</span>`);
  try {
    const tab = await activeTab();
    if (!tab || tab.id == null || (tab.url && RESTRICTED.test(tab.url))) {
      say(`<span class="warn">This is a browser page, not a job application. ` +
          `Open the job's application form in a normal tab, then press the button again.</span>`);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["fillpack.js", "matcher.js", "content.js"],
    });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => (globalThis.__JOB_AGENT__ ? globalThis.__JOB_AGENT__.run({ submit: s }) : null),
      args: [submit],
    });
    const r = res && res[0] && res[0].result;
    if (!r) {
      say(`<span class="stop">Engine not available on this page (unsupported site or still loading).</span>`);
      return;
    }
    const lines = [];
    /* Which build answered — settles "I reloaded the extension but the tab
     * still runs old code" without guessing. */
    if (r.v) lines.push(`<span class="k">engine v${esc(r.v)}</span>`);
    if (!r.ok) {
      /* A halt message carries page-derived text — control labels and the
       * site's own validation copy — so it is escaped like any other content
       * from the page. A long diagnostic (an unrecognised layout lists every
       * control it saw) also reads better as a headline plus a detail line. */
      const m = String(r.message || "Stopped.");
      const at = ["Controls seen:", "No clickable controls"]
        .map((s) => m.indexOf(s))
        .filter((i) => i > 0)
        .sort((a, b) => a - b)[0] ?? -1;
      if (at > 0) {
        lines.push(`<span class="stop">${esc(m.slice(0, at).trim())}</span>`);
        lines.push(`<span class="k">${esc(m.slice(at).trim())}</span>`);
      } else {
        lines.push(`<span class="stop">${esc(m)}</span>`);
      }
    } else if (r.submitted) {
      lines.push(`<span class="ok">Submitted ✓</span> ${r.confirmation ? `Confirmation: ${esc(r.confirmation)}` : ""}`);
    } else {
      lines.push(`<span class="ok">Filled ${r.filled.length} fields.</span> Nothing submitted.`);
    }
    if (r.filled && r.filled.length) {
      const n = r.filled.length;
      lines.push(`<span class="k">Filled: ${n} field${n === 1 ? "" : "s"}.</span>`);
    }
    if (r.openQuestions && r.openQuestions.length) {
      lines.push(`<span class="warn">Left blank (need your answer): ${esc(r.openQuestions.join(", "))}</span>`);
    }
    if (r.failed && r.failed.length) {
      lines.push(`<span class="warn">Could not match: ${esc(r.failed.map((f) => f.key).join(", "))}</span>`);
    }
    say(lines.join("<br><br>"));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/cannot access a chrome:\/\//i.test(msg) || /^(chrome|edge|about|devtools):/i.test(msg)) {
      say(`<span class="warn">This is a browser settings page — the extension can only run ` +
          `on a job application. Open the job posting, then try again.</span>`);
    } else if (/cannot access contents of/i.test(msg) || /must request permission/i.test(msg)) {
      say(`<span class="warn">This site isn't one the extension covers (or the page is still ` +
          `loading). It runs on Workday, Greenhouse, Lever, Ashby, LinkedIn, Indeed, ` +
          `Glassdoor, Wellfound, Naukri, Foundit, Hirist, Instahyre, Internshala, Unstop, ` +
          `Cutshort, TopHire, LeetCode, GeeksforGeeks, AmbitionBox and HackerEarth.</span>`);
    } else {
      say(`<span class="stop">${esc(msg)}</span>`);
    }
  } finally {
    go.disabled = fillOnly.disabled = false;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

go.addEventListener("click", () => run(true));
fillOnly.addEventListener("click", () => run(false));
