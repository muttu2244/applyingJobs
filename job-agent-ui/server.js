/* Job Agent dashboard server — zero deps, Node 18+.
 * Serves the static UI and a tiny JSON API backed by the real pipeline output:
 *   ../ranked_jobs.json  (210 scored LinkedIn jobs from match_jobs.py)
 *   ./state.json         (board connections, approvals, apply log — created on first run)
 *
 * GET  /api/bootstrap          profile + boards + jobs + queue + log
 * POST /api/boards/:id/connect {connected:bool}
 * POST /api/jobs/:id/action    {action:"approve"|"deny"|"apply"}
 * POST /api/harvest            {board, jobs:[{title,company,location,url,listed}]} —
 *                               fresh listings the extension scraped from the
 *                               user's own board tab; 403 unless that board is
 *                               connected (selected boards only, ever)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
// Some hosts export PORT=0 (random); only honor a real numeric port.
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : 8357;
const RANKED = path.join(ROOT, "..", "ranked_jobs.json");
const RESUME = path.join(ROOT, "..", "resume_extracted.txt");
const STATE = path.join(ROOT, "state.json");
const AUTOFILL = path.join(ROOT, "autofill.json");
/* Live listings fetched by the extension (see POST /api/harvest). Separate
 * file so ranked_jobs.json — the static index — is never rewritten. */
const HARVEST = path.join(ROOT, "harvest.json");

/* Board id -> display name, for job cards ("which board is this from"). */
const BOARD_NAMES = {
  linkedin: "LinkedIn", indeed: "Indeed", naukri: "Naukri", foundit: "Foundit",
  hirist: "Hirist", instahyre: "Instahyre", wellfound: "Wellfound",
  cutshort: "Cutshort", tophire: "TopHire", internshala: "Internshala",
  unstop: "Unstop", glassdoor: "Glassdoor", leetcode: "LeetCode",
  geeksforgeeks: "GeeksforGeeks", ambitionbox: "AmbitionBox", hackerearth: "HackerEarth",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/* ---------- scoring → human % ---------- */
// Raw keyword scores top out near 32. Map to 0-100 with a soft cap so the
// display matches the myjobb-style % without pretending to be calibrated ML.
function pct(raw) {
  if (raw <= 0) return 0;
  return Math.min(99, Math.round(raw * 3));
}

// Skills in the resume that this job never mentioned — the "missing" chips.
const RESUME_SKILLS = [
  "python", "fastapi", "kubernetes", "docker", "mlops", "mlflow", "dvc",
  "zenml", "terraform", "aws", "azure", "gcp", "cicd", "llm", "rag",
  "genai", "agentic", "pytorch", "tensorflow", "nlp", "sagemaker", "eks",
  "langchain", "tfs", "ci/cd",
];

function missingSkills(hits) {
  const have = new Set(hits.map((h) => h.toLowerCase()));
  const miss = [];
  for (const s of RESUME_SKILLS) {
    if (have.has(s)) continue;
    if (hits.some((h) => h.includes(s) || s.includes(h))) continue;
    miss.push(s);
    if (miss.length >= 5) break;
  }
  return miss;
}

function whyLine(job) {
  const bits = [];
  if (job.hits && job.hits.length) bits.push(`title matches ${job.hits.slice(0, 3).join(", ")}`);
  const loc = (job.company_location || "").toLowerCase();
  if (loc.includes("bengaluru") || loc.includes("bangalore")) bits.push("Bangalore location fit");
  else if (loc.includes("india")) bits.push("India location");
  if (/senior|staff|lead|architect/i.test(job.job_title || "")) bits.push("seniority aligns with 20+ yrs");
  return bits.join(" · ") || "keyword overlap on title";
}

/* ---------- profile (parsed from the real extracted resume) ---------- */
function loadProfile() {
  const fallback = {
    name: "Shivayogi Math",
    email: "muttu2244@gmail.com",
    phone: "+91-9900455663",
    location: "Bangalore",
    headline: "AI/ML | MLOps | FullStack",
    resumeFile: "Shivayogi_From_15082026.pdf",
    years: "20+",
    targetRoles: ["AI/ML Engineer", "MLOps Engineer", "AI Architect", "Staff/Lead AI Engineer"],
    notice: "Immediate – 30 days",
  };
  try {
    const txt = fs.readFileSync(RESUME, "utf-8");
    const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const p = { ...fallback };
    if (lines[0] && lines[0].length < 60) p.name = lines[0];
    const contact = lines.find((l) => l.includes("@")) || "";
    const em = contact.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    if (em) p.email = em[0];
    const ph = contact.match(/\+?\d[\d\s-]{8,}\d/);
    if (ph) p.phone = ph[0].trim();
    return p;
  } catch {
    return fallback;
  }
}

/* ---------- boards ---------- */
// Honesty rules baked into the labels: LinkedIn is session-gated (no apply API,
// we hit the sign-in wall live), the Naukri-family boards connect via the
// user's own browser session — credentials never pass through this server.
function defaultBoards() {
  return [
    {
      id: "linkedin", name: "LinkedIn", kind: "session-gated", connected: false,
      note: "Session-gated — no apply API. The extension applies through your logged-in browser session: approve a job here and its autopilot fills and submits the application for you.",
      jobs: 210, loginUrl: "https://www.linkedin.com/login",
    },
    {
      id: "indeed", name: "Indeed", kind: "session-gated", connected: false,
      note: "Session-gated — no apply API. The extension applies through your logged-in browser session: approve a job here and its autopilot fills and submits the application for you.",
      jobs: 0, loginUrl: "https://www.indeed.com/account/login",
    },
    {
      id: "naukri", name: "Naukri", kind: "cookie-session", connected: false,
      note: "Applies via your browser session (cookie import). Approved jobs are filled and submitted by the extension's autopilot.",
      jobs: 0, loginUrl: "https://www.naukri.com/mnjuser/login",
    },
    {
      id: "foundit", name: "Foundit", kind: "cookie-session", connected: false,
      note: "Applies via your browser session (cookie import). Approved jobs are filled and submitted by the extension's autopilot.",
      jobs: 0, loginUrl: "https://www.foundit.in/srp/login",
    },
    {
      id: "hirist", name: "Hirist", kind: "cookie-session", connected: false,
      note: "Applies via your browser session (cookie import). Approved jobs are filled and submitted by the extension's autopilot.",
      jobs: 0, loginUrl: "https://www.hirist.tech/login",
    },
    {
      id: "instahyre", name: "Instahyre", kind: "cookie-session", connected: false,
      note: "Applies via your browser session (cookie import). Approved jobs are filled and submitted by the extension's autopilot.",
      jobs: 0, loginUrl: "https://www.instahyre.com/login/",
    },
    {
      id: "wellfound", name: "Wellfound", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://wellfound.com/login",
    },
    {
      id: "cutshort", name: "Cutshort", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://cutshort.io/",
    },
    {
      id: "tophire", name: "TopHire", kind: "session-gated", connected: false,
      note: "Profile-based — TopHire has no per-job listings; companies review your profile and reach out. The extension still fills its sign-up and profile forms.",
      jobs: 0, loginUrl: "https://tophire.co/",
    },
    {
      id: "internshala", name: "Internshala", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://internshala.com/login",
    },
    {
      id: "unstop", name: "Unstop", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://unstop.com/login",
    },
    {
      id: "glassdoor", name: "Glassdoor", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://www.glassdoor.com/Jobs/",
    },
    {
      id: "leetcode", name: "LeetCode", kind: "session-gated", connected: false,
      note: "Session-gated — LeetCode's job board has no apply API. The extension applies through your logged-in browser session.",
      jobs: 0, loginUrl: "https://leetcode.com/accounts/login/",
    },
    {
      id: "geeksforgeeks", name: "GeeksforGeeks", kind: "session-gated", connected: false,
      note: "Session-gated — GfG Get Hired has no apply API. The extension applies through your logged-in browser session.",
      jobs: 0, loginUrl: "https://auth.geeksforgeeks.org/?to=https://www.geeksforgeeks.org/jobs/",
    },
    {
      id: "ambitionbox", name: "AmbitionBox", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://www.ambitionbox.com/",
    },
    {
      id: "hackerearth", name: "HackerEarth", kind: "session-gated", connected: false,
      note: SESSION_NOTE,
      jobs: 0, loginUrl: "https://www.hackerearth.com/login/",
    },
  ];
}

/* One sentence shared by every session-gated board card. */
const SESSION_NOTE = "Session-gated — no apply API. The extension applies through your logged-in browser session: approve a job here and its autopilot fills and submits the application for you.";

/* Where "Fetch fresh jobs" opens each board. List pages verified to render
 * in e2e/board-sweep.js; profile-only boards open home. */
const SEARCH_URLS = {
  linkedin: "https://www.linkedin.com/jobs/search/?keywords=AI%20ML%20Engineer&location=Bangalore",
  indeed: "https://www.indeed.com/jobs?q=AI+ML+Engineer&l=Bangalore",
  naukri: "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore",
  foundit: "https://www.foundit.in/srch/ai-ml-jobs",
  hirist: "https://www.hirist.tech/",
  instahyre: "https://www.instahyre.com/",
  wellfound: "https://wellfound.com/jobs",
  cutshort: "https://cutshort.io/jobs",
  tophire: "https://tophire.co/",
  internshala: "https://internshala.com/jobs",
  unstop: "https://unstop.com/jobs",
  glassdoor: "https://www.glassdoor.com/Jobs/",
  leetcode: "https://leetcode.com/jobs/",
  geeksforgeeks: "https://www.geeksforgeeks.org/jobs/",
  ambitionbox: "https://www.ambitionbox.com/jobs",
  hackerearth: "https://www.hackerearth.com/jobs/",
};

/* ---------- live-job scoring (port of match_jobs.py) ---------- */
const STRONG = {
  mlops: 10, "machine learning": 6, "ml engineer": 8, "ai engineer": 8,
  "ai/ml": 8, llm: 7, genai: 7, "gen ai": 7, "generative ai": 7,
  rag: 7, agentic: 7, "ai architect": 10, "ai platform": 8,
  kubernetes: 7, docker: 5, mlflow: 6, dvc: 5, zenml: 6,
  aws: 5, azure: 5, gcp: 4, terraform: 5, cicd: 6, "ci/cd": 6,
  python: 5, fastapi: 5, pytorch: 4, tensorflow: 4,
  sagemaker: 5, eks: 5, "data engineer": 3, devops: 4,
  cloud: 3, nlp: 4, "computer vision": 3, "azure ai": 7,
  "data scientist": 3, analytics: 2, automation: 3, microservices: 3,
};
const WEAK = {
  java: 2, sap: 1, salesforce: 1, marketing: 0, recruiter: 0,
  "customer support": 0, telesales: 0, accountant: 0, nurse: 0,
  teacher: 0, driver: 0, "hr ": 0, "business development": 0,
  "inside sales": 0, bpo: 0, pharma: 0, banking: 0,
  insurance: 0, "real estate": 0, workday: 0, maintenance: 0,
};
const SENIORITY = {
  senior: 3, staff: 4, principal: 4, lead: 3, architect: 5,
  manager: 3, director: 4, head: 4, jr: -3, junior: -3,
  trainee: -5, intern: -6, "entry level": -3, fresher: -5,
  associate: -1,
};
const REMOTE = { remote: 4, hybrid: 3, wfh: 3, "work from home": 4 };

function scoreLive(title, company, url, loc) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").toLowerCase();
  const text = norm(`${title} ${company} ${url}`);
  let s = 0;
  const hits = [];
  for (const [k, w] of Object.entries(STRONG)) {
    if (text.includes(k)) { s += w; hits.push(k); }
  }
  for (const [k, w] of Object.entries(WEAK)) if (text.includes(k)) s -= w;
  for (const [k, w] of Object.entries(SENIORITY)) if (text.includes(k)) s += w;
  for (const [k, w] of Object.entries(REMOTE)) if (text.includes(k)) s += w;
  const l = norm(loc);
  if (["bengaluru", "bangalore"].some((c) => l.includes(c))) s += 4;
  else if (["india", "hyderabad", "pune", "chennai", "mumbai", "delhi", "ncr", "gurgaon"].some((c) => l.includes(c))) s += 1;
  return { score: s, hits };
}

/* Dedupe key for a listing URL: the same job re-fetched must collapse to one
 * entry even when the page appended tracking params. Most boards put identity
 * in the path (naukri slugs, linkedin /jobs/view/<id>); Indeed's jk= and
 * Glassdoor's jl= are the exceptions — those plus explicit id params survive,
 * everything else in the query string is dropped. An allowlist beats a deny
 * list here: unknown trackers are stripped forever, at worst two jobs sharing
 * a non-identity param collapse to one (the dedupe direction that never
 * duplicates what the user sees). */
const IDENTITY_PARAMS = new Set(["jk", "jl", "jobid", "reqid", "id"]);
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (!IDENTITY_PARAMS.has(k.toLowerCase())) x.searchParams.delete(k);
    }
    return x.href.replace(/\/$/, "");
  } catch { return String(u || ""); }
}

function cleanText(s, max) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/* A board's live-login state as the dashboard needs it. `pending` is set by
 * the connect click and cleared by the extension's verdict from the board tab. */
/* A "verifying…" that never got an answer is not still verifying. The board
 * tab was closed, or the extension was reloaded mid-check — after two minutes
 * the wait is over and the card goes back to "connect". (Seen live: a card
 * still saying "still waiting after 1939s" long after the tab was gone.) */
const PENDING_TTL_MS = 2 * 60 * 1000;

function sessionSummary(b) {
  const s = (b && b.session) || {};
  const pendingMs = s.pending && s.pendingAt ? Date.now() - s.pendingAt : 0;
  const stale = s.pending === true && pendingMs > PENDING_TTL_MS;
  return {
    /* ok = "verified signed in". `unknown` keeps the difference between "the
     * page showed a login form" and "the page showed nothing usable" — the UI
     * must not claim "not signed in" for a board it could not read. */
    ok: s.ok === true,
    unknown: s.ok === null || s.ok === undefined,
    pending: s.pending === true && !stale,
    expired: stale,
    pendingMs,
    at: s.at || null,
    detail: stale ? "verification timed out — connect again" : s.detail || "",
  };
}

/* ---------- harvest store ---------- */
function loadHarvest() {
  try {
    const h = JSON.parse(fs.readFileSync(HARVEST, "utf-8"));
    return {
      entries: Array.isArray(h.entries) ? h.entries : [],
      fetchedAt: h.fetchedAt && typeof h.fetchedAt === "object" ? h.fetchedAt : {},
    };
  } catch {
    return { entries: [], fetchedAt: {} };
  }
}
function saveHarvest(h) {
  fs.writeFileSync(HARVEST, JSON.stringify(h, null, 1), "utf-8");
}

/* ---------- state ---------- */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf-8"));
  } catch {
    return { boards: defaultBoards(), decisions: {}, log: [] };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), "utf-8");
}

/* ---------- jobs ---------- */
/* Which dashboard board a listing belongs to, from its URL alone. Hosts that
 * aren't a board here (employer ATS pages, mirrors, unknown harvests) map to
 * null — and a null board never satisfies any connection, so the default for
 * unknown sources is hidden, not shown. No board, no match. */
const JOB_HOSTS = [
  ["linkedin.com", "linkedin"], ["indeed.com", "indeed"], ["naukri.com", "naukri"],
  ["foundit.in", "foundit"], ["hirist.tech", "hirist"], ["instahyre.com", "instahyre"],
  ["wellfound.com", "wellfound"], ["cutshort.io", "cutshort"], ["tophire.co", "tophire"],
  ["internshala.com", "internshala"], ["unstop.com", "unstop"],
  ["glassdoor.com", "glassdoor"], ["glassdoor.co.in", "glassdoor"],
  ["leetcode.com", "leetcode"], ["geeksforgeeks.org", "geeksforgeeks"],
  ["ambitionbox.com", "ambitionbox"], ["hackerearth.com", "hackerearth"],
];
function boardOf(jobUrl) {
  let host = "";
  try { host = new URL(jobUrl).hostname.toLowerCase(); } catch { return null; }
  for (const [dom, id] of JOB_HOSTS) {
    if (host === dom || host.endsWith("." + dom)) return id;
  }
  return null;
}

function loadJobs() {
  const raw = JSON.parse(fs.readFileSync(RANKED, "utf-8"));
  /* Base index first, then live fetches in arrival order. Jobs are keyed by
   * array position, so appending (never reordering/deleting) keeps every
   * existing id — and its approval/apply decision — stable. */
  const live = loadHarvest().entries;
  /* A live entry with no company, no location, no experience and no posting
   * age is not a job — it is board navigation ("AI Bootcamps", "Job letter
   * samples") stored by an older build of the scraper. It stays in the file
   * because ids are array positions (dropping it would renumber decisions),
   * but it is flagged so nothing ever displays or applies to it. */
  const junkLive = (j, location, experience, listed) => j.source === "live" &&
    !location && !experience && !listed;
  /* An old harvest stored the card title itself as the "location" for board
   * category links ("Data Scientist Jobs In Delhi NCR"). Treat a title-shaped
   * location as no location at all. */
  const realLocation = (title, loc) => {
    const L = String(loc || "").trim();
    if (!L) return "";
    const T = String(title || "").trim().toLowerCase();
    if (L.toLowerCase() === T || L.toLowerCase().includes(T) || T.includes(L.toLowerCase())) return "";
    return L;
  };
  return raw.concat(live).map((j, i) => {
    const listed = String(j.job_listed || "").trim();
    const experience = String(j.experience || "").trim();
    const location = realLocation(j.job_title, j.company_location);
    const board = boardOf(j.job_detail_url);
    const why = whyLine(j);
    return {
      id: i,
      board,
      boardName: BOARD_NAMES[board] || "",
      title: j.job_title,
      company: j.company_name,
      location,
      listed,
      /* Board cards carry these as text; the static index has none, so they
       * stay empty strings and the card simply omits the chip. */
      experience,
      salary: j.salary || "",
      /* Short description for the job card: the scraper's captured blurb when
       * the board showed one, otherwise the match summary — real text, never
       * invented copy. */
      desc: cleanText(j.job_desc, 240) || `${why}${(j.hits || []).length ? ` — matched on ${j.hits.slice(0, 5).join(", ")}` : ""}`,
      url: j.job_detail_url,
      rawScore: j.score,
      match: pct(j.score),
      matched: j.hits || [],
      missing: missingSkills(j.hits || []),
      why,
      fresh: j.source === "live",
      fetchedAt: j.fetchedAt || null,
      usable: !junkLive(j, location, experience, listed),
    };
  });
}

/* ---------- API ---------- */
// The extension runs its content script on linkedin.com / indeed.com / workday
// origins, so every dashboard response carries permissive CORS. This server
// binds 127.0.0.1 only — it is never reachable from other machines.
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    /* Bootstrap carries the live board list — never let a browser or the
     * extension cache a snapshot from before an edit (that is exactly how
     * "I added Indeed but don't see it" happens). */
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function loadFillPack() {
  try {
    return JSON.parse(fs.readFileSync(AUTOFILL, "utf-8"));
  } catch {
    return null;
  }
}

/* The extension scrapes job cards from the user's own logged-in board tab and
 * POSTs them here — this is how "fresh jobs from the boards I selected" gets
 * filled without any server-side login. Two gates protect the user:
 *   1. the board must be CONNECTED (403 otherwise) — a board you didn't
 *      select can never put jobs in front of you, even if scraped;
 *   2. each listing's URL must map back to the SAME board via boardOf() —
 *      a page tagged "naukri" cannot smuggle linkedin.com links in.
 * Entries are append-only so job ids (approval keys) never shift. */
async function handleHarvest(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const boardId = typeof body.board === "string" ? body.board : "";
  const state = loadState();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return send(res, 404, { error: "unknown board" });
  if (!board.connected) {
    return send(res, 403, {
      error: `${board.name} is not signed in yet — open it once in your browser and its jobs flow in automatically`,
    });
  }
  const incoming = Array.isArray(body.jobs) ? body.jobs.slice(0, 80) : [];
  const h = loadHarvest();
  const seen = new Set(h.entries.map((e) => normUrl(e.job_detail_url)));
  const live = new Map(h.entries.map((e) => [normUrl(e.job_detail_url), e]));
  const base = JSON.parse(fs.readFileSync(RANKED, "utf-8"));
  for (const j of base) seen.add(normUrl(j.job_detail_url));
  const ts = Date.now();
  let added = 0, skipped = 0, enriched = 0;
  /* Detail lines only appear once the card's text renders, and the scraper
   * finds more of them as a page settles — so a known listing is not a dead
   * end: fill in experience/salary/posted when the entry is still missing
   * them, instead of leaving the first (bare) scrape as the final word. */
  const DETAIL_FIELDS = { experience: 60, salary: 60, job_listed: 60, job_desc: 240 };
  for (const j of incoming) {
    const u = j && typeof j.url === "string" ? j.url : "";
    if (!/^https?:\/\//i.test(u) || boardOf(u) !== boardId) { skipped++; continue; }
    const key = normUrl(u);
    const prev = live.get(key);
    if (seen.has(key)) {
      if (prev) {
        const gained = {
          experience: cleanText(j.experience, 60), salary: cleanText(j.salary, 60),
          job_listed: cleanText(j.listed, 60), job_desc: cleanText(j.desc, 240),
        };
        for (const f of Object.keys(DETAIL_FIELDS)) {
          if (gained[f] && !prev[f]) { prev[f] = gained[f]; enriched++; }
        }
      }
      skipped++; continue;
    }
    const title = cleanText(j.title, 200);
    if (!title) { skipped++; continue; }
    const company = cleanText(j.company, 120) || "—";
    const location = cleanText(j.location, 120);
    const experience = cleanText(j.experience, 60);
    const listed = cleanText(j.listed, 60);
    /* Never store navigation again: a listing with no company/location/
     * experience/posted-age is a menu link, not a job. */
    if (company === "—" && !location && !experience && !listed) { skipped++; continue; }
    const { score, hits } = scoreLive(title, company, u, location);
    seen.add(key);
    h.entries.push({
      job_title: title,
      company_name: company,
      company_location: location,
      job_listed: listed,
      experience,
      salary: cleanText(j.salary, 60),
      job_desc: cleanText(j.desc, 240),
      job_detail_url: u,
      score, hits,
      source: "live",
      fetchedAt: ts,
    });
    added++;
  }
  h.fetchedAt[boardId] = ts;
  saveHarvest(h);
  if (added || enriched) {
    state.log.unshift({
      ts, type: "fetch",
      text: `${board.name} — ${added} fresh job${added === 1 ? "" : "s"} fetched` +
        (enriched ? `, ${enriched} detail${enriched === 1 ? "" : "s"} filled in` : ""),
    });
    saveState(state);
  }
  /* Fetch-all progress: the content script walks the board's result pages and
   * reports each page it harvested, so the UI can show "page 3 of 5" and the
   * next page load knows the sweep is still running. Logged AFTER the page's
   * own fetch line, so a finished sweep is the newest thing in the timeline. */
  const sweepIn = body.sweep && typeof body.sweep === "object" ? body.sweep : null;
  if (sweepIn) {
    state.sweeps = state.sweeps || {};
    const cur = state.sweeps[boardId] || { startedAt: ts, page: 0, found: 0, maxPages: 1, status: "running" };
    cur.page = Math.max(Number(cur.page) || 0, Math.min(Number(sweepIn.page) || 0, 500));
    cur.found = (Number(cur.found) || 0) + added;
    cur.updatedAt = ts;
    if (sweepIn.last === true) { cur.status = "done"; cur.finishedAt = ts; }
    else if (cur.status !== "done") cur.status = "running";
    state.sweeps[boardId] = cur;
    if (cur.status === "done") {
      state.log.unshift({
        ts, type: "fetch",
        text: `${board.name} — fetch-all finished: ${cur.found} new job${cur.found === 1 ? "" : "s"} ` +
          `across ${cur.page || 1} page${(cur.page || 1) === 1 ? "" : "s"}`,
      });
    }
    saveState(state);
  }
  const liveTotal = h.entries.filter((e) => boardOf(e.job_detail_url) === boardId).length;
  return send(res, 200, { ok: true, added, enriched, skipped, board: boardId, fetchedAt: ts, liveTotal });
}

/* One job as the API hands it out (the apply runner and the UI both use it). */
function jobView(j) {
  if (!j) return null;
  return {
    id: j.id, board: j.board, boardName: j.boardName, title: j.title, company: j.company,
    location: j.location, experience: j.experience, salary: j.salary,
    listed: j.listed, desc: j.desc, url: j.url, match: j.match, fresh: j.fresh,
  };
}

/* Compact progress for an apply run — never the whole queue. */
function runSummary(run) {
  if (!run) return null;
  const queue = Array.isArray(run.queue) ? run.queue : [];
  const attempted = Array.isArray(run.attempted) ? run.attempted : [];
  const results = run.results || {};
  let applied = 0, halted = 0;
  for (const id of Object.keys(results)) {
    if (results[id].status === "applied") applied++;
    else if (results[id].status) halted++;
  }
  return {
    id: run.id, done: !!run.done, startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null, total: queue.length,
    attempted: attempted.length, applied, halted,
    current: attempted.length ? attempted[attempted.length - 1] : null,
  };
}

/* ---------- run liveness ----------
 * A queued job is opened in a tab by the extension; if that tab dies before
 * it reports (closed browser, discarded tab, a URL that never loaded), the
 * job sits attempted-with-no-result forever and the run can never finalize.
 * Silence is the evidence: nothing in the run (or any decision) moved for
 * RUN_STALL_MS means no page is working on it. The stall is recorded as a
 * halted result — honestly worded, and a late report from a slow-but-alive
 * page overwrites it with the real outcome. */
const RUN_STALL_MS = 150000;
function markStalledRuns(state) {
  const run = state.run;
  if (!run || run.done) return;
  const attempted = Array.isArray(run.attempted) ? run.attempted : [];
  run.results = run.results || {};
  const now = Date.now();
  let lastActivity = run.startedAt || 0;
  for (const d of Object.values(state.decisions || {})) {
    if (d && typeof d.ts === "number" && d.ts > lastActivity) lastActivity = d.ts;
  }
  if (now - lastActivity < RUN_STALL_MS) return;   // a page is (or was) alive
  let changed = false;
  for (const id of attempted) {
    if (run.results[id]) continue;
    const detail = "the job tab never reported (it was closed, or the page never loaded) — press Apply again to retry";
    run.results[id] = { status: "failed", at: now, detail };
    const d = state.decisions[id] || {};
    /* Keep action as-is so the card can offer a retry; ts must NOT move —
     * it is this function's own liveness clock. */
    if (d.action !== "applied" && d.status !== "failed") {
      state.decisions[id] = Object.assign({}, d, { status: "failed", detail });
    }
    changed = true;
  }
  if (changed) saveState(state);
}

/* ---------- queue liveness ----------
 * A sweep executes in a board tab. When that tab dies — extension disabled,
 * browser closed, tab discarded — no progress report ever arrives again, and
 * the record would claim "fetching…" forever: the dashboard's Fetch button
 * stays disabled for a run that can never finish. No page progress for
 * SWEEP_STALL_MS means the sweep is dead, and it is marked wherever it is
 * read. A healthy sweep reports at least every result page, which takes
 * seconds (the one loophole — a background-throttled live tab — reports
 * again and the progress handler below puts it straight back to running). */
const SWEEP_STALL_MS = 150000;
function markStalledSweeps(state) {
  let changed = false;
  for (const id of Object.keys(state.sweeps || {})) {
    const s = state.sweeps[id];
    if (!s || s.status !== "running") continue;
    const age = Date.now() - (s.updatedAt || s.startedAt || 0);
    if (age < SWEEP_STALL_MS) continue;
    s.status = "stalled";
    s.stalledAt = Date.now();
    const board = (state.boards || []).find((b) => b.id === id);
    state.log.unshift({
      ts: Date.now(), type: "halted",
      text: `${(board && board.name) || id} — fetch-all stalled after ${s.page || 0} page(s) with no progress`
        + " (the board tab was closed or the extension reloaded) — press Fetch all jobs to restart",
    });
    changed = true;
  }
  if (changed) saveState(state);
}

function bootstrap() {
  const state = loadState();
  state.run = state.run || null;
  state.sweeps = state.sweeps || {};
  markStalledSweeps(state);
  markStalledRuns(state);
  const all = loadJobs();
  const harvest = loadHarvest();
  /* Jobs are NOT gated on connection: the dashboard shows every matched job
   * from every board, and the connection is established behind the scenes
   * when the user presses Apply on a card (the extension verifies the
   * session from the job page itself). Two filters remain:
   *   - a listing whose URL maps to no known board can never be applied to
   *     (board === null) so it is never shown;
   *   - an APPLIED job leaves the list for good — the card must disappear
   *     the moment the submission is confirmed. */
  const jobs = all.filter((j) => j.board && j.usable !== false &&
    !(state.decisions[j.id] && state.decisions[j.id].action === "applied"));
  const totals = {};
  for (const j of all) totals[j.board] = (totals[j.board] || 0) + 1;
  /* Digest source: applied jobs are gone from `jobs`, so the apply log keeps
   * its own compact list of confirmed submissions. */
  const appliedJobs = all
    .filter((j) => state.decisions[j.id] && state.decisions[j.id].action === "applied")
    .slice(-20).reverse()
    .map((j) => ({
      id: j.id, title: j.title, company: j.company, match: j.match,
      confirmation: state.decisions[j.id].confirmation || null,
    }));
  /* Merge stored connections onto the canonical board list so cards always
   * carry searchUrl/fetchedAt even for state.json written before they existed. */
  const defs = defaultBoards();
  const stored = new Map(state.boards.map((b) => [b.id, b]));
  const boards = defs.map((d) => {
    const b = { ...d, ...(stored.get(d.id) || {}) };
    b.jobs = totals[b.id] || 0;
    b.fetchedAt = harvest.fetchedAt[b.id] || null;
    b.searchUrl = SEARCH_URLS[b.id] || b.loginUrl;
    b.session = sessionSummary(stored.get(d.id));
    b.sweep = state.sweeps[b.id] ? { ...state.sweeps[b.id] } : null;
    return b;
  });
  /* boards present in state but not in the defaults still round-trip */
  for (const b of state.boards) {
    if (defs.some((d) => d.id === b.id)) continue;
    boards.push({ ...b, fetchedAt: harvest.fetchedAt[b.id] || null, searchUrl: b.loginUrl, session: sessionSummary(b), sweep: state.sweeps[b.id] || null });
  }
  return {
    profile: loadProfile(), boards, jobs, appliedJobs, decisions: state.decisions, log: state.log,
    fill: loadFillPack(), run: runSummary(state.run),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  /* One line per request: which origin the extension's content script ran on
   * and whether its dashboard fetch landed — the empirical answer to "is
   * autopilot reaching the server from <board>?". */
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} origin=${req.headers.origin || "-"}`);

  if (req.method === "OPTIONS") return send(res, 204, {});

  if (url.pathname === "/api/bootstrap" && req.method === "GET") {
    return send(res, 200, bootstrap());
  }

  if (url.pathname === "/api/harvest" && req.method === "POST") {
    return handleHarvest(req, res);
  }

  /* ---------- fetch-all sweep ----------
   * "Get all the matching jobs", not just the first page: the dashboard asks
   * for a sweep, the content script walks the board's result pages (Next /
   * pagination), harvesting each page, and reports progress here. A sweep only
   * exists for a board the user actually connected. */
  const sweepMatch = url.pathname.match(/^\/api\/boards\/([\w-]+)\/sweep$/);
  if (sweepMatch) {
    const state = loadState();
    state.sweeps = state.sweeps || {};
    const board = state.boards.find((b) => b.id === sweepMatch[1]);
    if (!board) return send(res, 404, { error: "no such board" });
    if (req.method === "GET") {
      markStalledSweeps(state);
      return send(res, 200, { sweep: state.sweeps[board.id] || null });
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      const now = Date.now();

      /* progress report from the content script (the only writer of page/last) */
      if (parsed.progress != null) {
        const cur = state.sweeps[board.id];
        if (!cur) return send(res, 200, { ok: true, sweep: null });
        cur.page = Math.max(Number(cur.page) || 0, Math.min(Number(parsed.progress) || 0, 500));
        cur.updatedAt = now;
        /* A page arrived after a stall mark — the tab is alive after all
         * (background throttling, not death). Put it back on the rails. */
        if (cur.status === "stalled") cur.status = "running";
        if (parsed.last === true) { cur.status = "done"; cur.finishedAt = now; }
        saveState(state);
        return send(res, 200, { ok: true, sweep: cur });
      }

      if (parsed.stop === true) {
        const cur = state.sweeps[board.id];
        if (cur) { cur.status = "stopped"; cur.updatedAt = now; saveState(state); }
        return send(res, 200, { ok: true, sweep: cur || null });
      }

      if (!board.connected) {
        return send(res, 403, { error: `${board.name} is not connected — connect it before fetching its jobs` });
      }
      const pages = Math.max(1, Math.min(25, Number(parsed.pages) || 5));
      state.sweeps[board.id] = {
        status: "running", page: 0, found: 0, maxPages: pages,
        startedAt: now, updatedAt: now, finishedAt: null,
      };
      state.log.unshift({ ts: now, type: "fetch", text: `${board.name} — fetching all listings (up to ${pages} pages)` });
      saveState(state);
      return send(res, 200, { ok: true, sweep: state.sweeps[board.id] });
    });
    return;
  }

  /* ---------- apply run ----------
   * The queue, the cap and the "what next" decision live here, so a browser
   * tab finishing one job can hand off to the next without the dashboard
   * being open. A run only ever contains jobs the USER approved. */
  if (url.pathname === "/api/apply/start" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      const state = loadState();
      const jobs = loadJobs();
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const cap = Math.max(1, Math.min(100, Number(parsed.cap) || 25));
      const minMatch = Number.isFinite(Number(parsed.minMatch)) ? Math.max(0, Math.min(100, Number(parsed.minMatch))) : 0;

      /* Bulk runs (the popup's "Apply to approved") walk boards that already
       * have a verified session — a tab opened on a logged-out board can only
       * hit a login wall. The ONE-CLICK card flow never comes through here:
       * it queues via /api/jobs/:id/action and hands out via /api/apply/kick,
       * which establishes the session itself (and asks the user to log in
       * when it cannot). An applied job never re-enters a run. */
      const connectedBoards = new Set(state.boards.filter((b) => b.connected).map((b) => b.id));
      const usable = (id) => byId.has(id) && byId.get(id).usable !== false &&
        connectedBoards.has(byId.get(id).board);
      let ids = Array.isArray(parsed.ids) ? parsed.ids.map(Number).filter(usable) : null;
      if (!ids) {
        ids = Object.entries(state.decisions)
          .filter(([, d]) => d && (d.action === "approve" || d.action === "apply"))
          .map(([id]) => Number(id))
          .filter((id) => usable(id) && state.decisions[id].action !== "applied");
        ids.sort((a, b) => (byId.get(b).match || 0) - (byId.get(a).match || 0));
      }
      ids = ids.filter((id) => (byId.get(id).match || 0) >= minMatch).slice(0, cap);
      if (!ids.length) return send(res, 400, { error: "approve at least one job first" });

      const now = Date.now();
      for (const id of ids) {
        state.decisions[id] = Object.assign({}, state.decisions[id], { action: "apply", ts: now });
      }
      state.run = {
        id: `run-${now}`, startedAt: now, finishedAt: null, done: false,
        cap, minMatch, queue: ids, attempted: [], results: {},
      };
      state.log.unshift({
        ts: now, type: "apply",
        text: `apply run started — ${ids.length} approved job${ids.length === 1 ? "" : "s"} queued` +
          ` (cap ${cap}${minMatch ? `, ≥${minMatch}%` : ""})`,
      });
      saveState(state);
      return send(res, 200, { ok: true, run: runSummary(state.run), first: jobView(byId.get(ids[0])) });
    });
    return;
  }

  /* Hand out the next unattempted job — or say "waiting" while a handed-out
   * job is still unreported. NEVER finalize while any attempted job lacks a
   * result: a second kick (dashboard click, worker alarm) must not declare
   * the run finished under a page that is still filling the form. */
  const handOutNext = (state, res, opts) => {
    const run = state.run;
    if (!run || run.done) return send(res, 200, { done: true, run: runSummary(run) });
    const jobs = loadJobs();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    run.results = run.results || {};
    const attempted = Array.isArray(run.attempted) ? run.attempted : [];
    const nextId = (run.queue || []).find((id) => !attempted.includes(id) && byId.has(id));
    if (nextId == null) {
      const inFlight = attempted.filter((id) => !run.results[id]);
      if (inFlight.length) {
        return send(res, 200, { done: false, waiting: true, run: runSummary(run) });
      }
      run.done = true;
      run.finishedAt = Date.now();
      const summary = runSummary(run);
      state.log.unshift({
        ts: run.finishedAt, type: "apply",
        text: `apply run finished — ${summary.applied} applied, ${summary.halted} halted, ${summary.total} total`,
      });
      saveState(state);
      return send(res, 200, { done: true, run: summary });
    }
    /* The kick path checks the board session BEFORE handing the job out: a
     * job whose board has no verified sign-in waits in the queue while the
     * caller opens the board so the user can log in. /next (the chain's own
     * advance) hands out regardless — its caller is a page that already got
     * through. */
    if (opts && opts.checkSession) {
      const job = byId.get(nextId);
      const board = (state.boards || []).find((b) => b.id === job.board);
      if (!(board && board.session && board.session.ok === true)) {
        return send(res, 200, {
          ok: true, needLogin: job.board,
          boardName: BOARD_NAMES[job.board] || job.board,
          open: SEARCH_URLS[job.board] || job.url,
          run: runSummary(run),
        });
      }
    }
    run.attempted = attempted;
    run.attempted.push(nextId);
    saveState(state);
    return send(res, 200, {
      done: false, job: jobView(byId.get(nextId)), run: runSummary(run),
      progress: { i: run.attempted.length, n: (run.queue || []).length },
    });
  };

  if (url.pathname === "/api/apply/next" && req.method === "GET") {
    const state = loadState();
    markStalledRuns(state);
    return handOutNext(state, res);
  }

  /* One-click Apply's engine turn: the dashboard (or the worker on its
   * behalf) asks for the next job to open BEHIND THE SCENES. Same hand-out
   * as /next, plus the session gate — and it never finalizes a run. */
  if (url.pathname === "/api/apply/kick" && req.method === "POST") {
    const state = loadState();
    markStalledRuns(state);
    if (!state.run || state.run.done) {
      return send(res, 200, { ok: true, nothing: true, run: runSummary(state.run) });
    }
    const jobs = loadJobs();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const results = state.run.results || {};
    const attempted = Array.isArray(state.run.attempted) ? state.run.attempted : [];
    /* One job at a time: a handed-out but unreported job means a page is
     * still (or was) working on it — a second kick (dashboard relay + the
     * worker's alarm racing) must NOT open another tab on top of it. */
    const inFlight = attempted.filter((id) => !results[id]);
    if (inFlight.length) {
      return send(res, 200, { ok: true, waiting: true, run: runSummary(state.run) });
    }
    const nextId = (state.run.queue || []).find((id) => !attempted.includes(id) && byId.has(id));
    if (nextId == null) return send(res, 200, { ok: true, nothing: true, run: runSummary(state.run) });
    return handOutNext(state, res, { checkSession: true });
  }

  if (url.pathname === "/api/apply/stop" && req.method === "POST") {
    const state = loadState();
    if (state.run && !state.run.done) {
      state.run.done = true;
      state.run.finishedAt = Date.now();
      const summary = runSummary(state.run);
      state.log.unshift({
        ts: state.run.finishedAt, type: "apply",
        text: `apply run stopped by you — ${summary.applied} applied, ${summary.halted} halted, ${summary.attempted}/${summary.total} attempted`,
      });
      saveState(state);
      return send(res, 200, { ok: true, run: summary });
    }
    return send(res, 200, { ok: true, run: runSummary(state.run) });
  }

  /* The extension reports what actually happened on the page: applied (with
   * the on-page confirmation), or halted on captcha / a missing submit
   * control. This is the only path that ever marks a job "applied" — the
   * dashboard never claims a submission it did not witness. */
  const reportMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/report$/);
  if (reportMatch && req.method === "POST") {
    const id = Number(reportMatch[1]);
    const jobs = loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) return send(res, 404, { error: "no such job" });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const status = ["applied", "captcha", "failed"].includes(body.status) ? body.status : "failed";
    const state = loadState();
    const prev = state.decisions[id] || {};
    state.decisions[id] = Object.assign({}, prev, {
      action: status === "applied" ? "applied" : prev.action === "apply" ? "apply" : prev.action,
      status,
      ts: Date.now(),
      confirmation: body.confirmation || null,
      detail: body.message || "",
    });
    /* Feed the run: this is what proves the chain is advancing, and what the
     * final summary counts. A halted job is recorded too — the run continues
     * to the next one instead of dying on a CAPTCHA. */
    if (state.run && !state.run.done && (state.run.queue || []).includes(id)) {
      state.run.results = state.run.results || {};
      state.run.results[id] = {
        status, at: Date.now(), confirmation: body.confirmation || null,
        detail: String(body.message || "").slice(0, 200),
      };
    }
    const label = {
      applied: `applied ✓${body.confirmation ? ` — ${body.confirmation}` : ""}`,
      captcha: "halted — CAPTCHA needs you",
      failed: `halted — ${body.message || "agent could not submit"}`,
    }[status];
    state.log.unshift({ ts: Date.now(), type: status === "applied" ? "applied" : "halted", text: `${label}: ${job.title} @ ${job.company}` });
    saveState(state);
    return send(res, 200, { ok: true, decisions: state.decisions, log: state.log });
  }

  const boardMatch = url.pathname.match(/^\/api\/boards\/([\w-]+)\/connect$/);
  if (boardMatch && req.method === "POST") {
    /* connect is also where the UI opens the board's list page, so the
     * content script can verify the session and harvest immediately after */
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const state = loadState();
      const b = state.boards.find((x) => x.id === boardMatch[1]);
      if (!b) return send(res, 404, { error: "no such board" });
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      const want = parsed.connected !== false;
      if (!want) {
        /* disconnect is immediate — dropping access never waits on anything */
        b.connected = false;
        b.session = { ok: null, at: null, pending: false, pendingAt: null, detail: "" };
        state.log.unshift({ ts: Date.now(), type: "disconnect", text: `${b.name} disconnected` });
        saveState(state);
        return send(res, 200, { ok: true, board: b, log: state.log });
      }
      /* "I'm signed in" is a CLAIM, not a fact — the extension must confirm
       * it against the live page before this board flows any job. Until the
       * verdict arrives the board sits in `pending`, the dashboard says so,
       * and /api/harvest keeps refusing. `force:true` is the user's explicit
       * override after being shown the unverified state. */
      if (parsed.force === true) {
        b.connected = true;
        b.session = { ok: null, at: Date.now(), pending: false, pendingAt: null, detail: "connected without verification (your choice)" };
        state.log.unshift({ ts: Date.now(), type: "connect", text: `${b.name} connected — you chose to skip session verification` });
        saveState(state);
        return send(res, 200, { ok: true, board: b, log: state.log });
      }
      b.connected = false;
      b.session = { ok: null, at: b.session && b.session.at || null, pending: true, pendingAt: Date.now(), detail: "" };
      state.log.unshift({
        ts: Date.now(), type: "verify",
        text: `${b.name} — verifying your session (checking the board tab just opened)`,
      });
      saveState(state);
      send(res, 200, { ok: true, pending: true, board: b, log: state.log });
    });
    return;
  }

  /* The extension reads the board page in the user's own browser and reports
   * the verdict: a Sign out control / profile link means logged in, a login
   * form or Sign in control means not. Only evidence connects a board — a
   * click on "I'm signed in" never does by itself. */
  const sessMatch = url.pathname.match(/^\/api\/boards\/([\w-]+)\/session$/);
  if (sessMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const state = loadState();
      const b = state.boards.find((x) => x.id === sessMatch[1]);
      if (!b) return send(res, 404, { error: "no such board" });
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      const ok = parsed.ok === true ? true : parsed.ok === false ? false : null;
      const now = Date.now();
      const prev = b.session || {};
      const wasConnected = !!b.connected;
      b.session = {
        ok, at: now, pending: false, pendingAt: null,
        detail: parsed.detail ? String(parsed.detail).slice(0, 200) : "",
      };
      if (ok === true) {
        b.connected = true;
        if (!wasConnected) {
          state.log.unshift({ ts: now, type: "connect", text: `${b.name} connected — session verified in your browser` });
        }
      } else if (ok === false) {
        /* log only on transitions — the content script re-reports per page
         * load and the timeline must not drown in repeats */
        if (wasConnected) {
          b.connected = false;
          state.log.unshift({ ts: now, type: "disconnect", text: `${b.name} disconnected — you're signed out on the site` });
        } else if (prev.ok !== false) {
          state.log.unshift({ ts: now, type: "verify", text: `${b.name} — not signed in. Log in in the opened tab, then connect again` });
        }
      }
      /* ok === null: the check ran but the page showed no clear signal —
       * keep waiting (the dashboard offers "connect without verifying") */
      if (ok === null) {
        b.session = {
          ok: null, at: now,
          pending: prev.pending === true,
          pendingAt: prev.pendingAt || null,
          detail: "no clear login signal on the page",
        };
      }
      saveState(state);
      send(res, 200, { ok: true, connected: !!b.connected, board: b, log: state.log });
    });
    return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    const fresh = { boards: defaultBoards(), decisions: {}, log: [] };
    saveState(fresh);
    return send(res, 200, { ok: true });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/action$/);
  if (jobMatch && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = Number(jobMatch[1]);
      let action = "approve";
      try { action = JSON.parse(body || "{}").action || "approve"; } catch {}
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === id);
      if (!job) return send(res, 404, { error: "no such job" });
      const state = loadState();
      const now = Date.now();
      state.decisions[id] = { action, ts: now };
      // "apply" queues the job AND enqueues it in the active run — this is
      // the one-click Apply button on a job card. The background worker's
      // alarm hands it out via /api/apply/next (marking it attempted, so it
      // can never be handed out twice) and opens it in a background tab;
      // the extension connects the board on the page itself. "applied" is
      // set only by /report, never here.
      if (action === "apply") {
        if (!state.run || state.run.done) {
          state.run = {
            id: `run-${now}`, startedAt: now, finishedAt: null, done: false,
            cap: 25, minMatch: 0, queue: [], attempted: [], results: {},
          };
        }
        const run = state.run;
        run.done = false;
        run.finishedAt = null;
        if (!run.queue.includes(id)) run.queue.push(id);
        /* A retry of a halted job: clear its old verdict and un-attempt it so
         * /api/apply/next will hand it out again. */
        if (run.results) delete run.results[id];
        const ai = run.attempted.indexOf(id);
        if (ai >= 0) run.attempted.splice(ai, 1);
      }
      const label = { approve: "approved", deny: "denied", apply: "queued — the agent connects & applies" }[action] || action;
      state.log.unshift({ ts: now, type: action, text: `${label}: ${job.title} @ ${job.company}` });
      saveState(state);
      send(res, 200, { ok: true, job, run: runSummary(state.run), decisions: state.decisions, log: state.log });
    });
    return;
  }

  // static
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
      /* Same stance as the API above: the extension scripts must be fetchable
       * from the https job-board origins they run on (127.0.0.1 is loopback,
       * so browsers do not treat this as mixed content). */
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`job-agent-ui on http://127.0.0.1:${PORT}`);
});
