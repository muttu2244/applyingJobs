/* Engine test — runs content.js against a minimal fake DOM.
 *
 * Proves the full agent contract:
 *   - fill-only mode types values, leaves open questions blank, and NEVER
 *     clicks submit/next/pay controls;
 *   - submit mode fills, advances a multi-step wizard, clicks the real submit
 *     control and reports the on-page confirmation;
 *   - pay/purchase controls are never clicked, in either mode;
 *   - CAPTCHA halts both modes before any click;
 *   - a required unanswered field blocks submit;
 *   - autopilot only fires for jobs approved in the dashboard.
 *
 * No jsdom available here, so the harness stubs only the DOM surface
 * content.js touches.
 *
 *   node test-engine.js
 */
"use strict";

require("./fillpack.js");
const M = require("./matcher.js");
globalThis.JobAgentMatcher = M;

/* ---------- minimal DOM ---------- */

class FakeEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } }
globalThis.Event = FakeEvent;

function makeInput(opts) {
  const el = {
    tagName: opts.tagName || (opts.type === "select" ? "SELECT" : "INPUT"),
    type: opts.type || "text",
    form: opts.form || null,
    name: opts.name || "",
    id: opts.id || "",
    placeholder: opts.placeholder || "",
    className: opts.className || "",
    textContent: opts.textContent || "",
    value: opts.value || "",
    disabled: !!opts.disabled,
    readOnly: false,
    required: !!opts.required,
    // Native validation: real controls answer validity/checkValidity(). The
    // engine reads them to name the field a wizard is silently refusing on.
    validity: opts.validity || { valid: true },
    willValidate: opts.willValidate !== false,
    checkValidity() { return el.validity.valid !== false; },
    // Layout neighbours, for question text that was never wired to the input.
    parentElement: opts.parent || null,
    previousElementSibling: opts.prev || null,
    childNodes: opts.childNodes || null,
    labels: opts.label ? [{ innerText: opts.label }] : [],
    options: opts.options || null,
    _listeners: [],
    _clicked: false,
    // Real elements answer for every attribute they carry; the engine reads
    // aria-label, placeholder, type and (on the dashboard's own pages) aria
    // descriptions, so the fake exposes them the way a DOM would.
    getAttribute(k) {
      if (opts.attrs && k in opts.attrs) return opts.attrs[k];
      if (k === "placeholder") return opts.placeholder || "";
      if (k === "aria-label") return opts.aria || "";
      return null;
    },
    closest(sel) {
      if (sel === "label" && opts.wrapsLabel) return opts.wrapsLabel;
      if (/fieldset/.test(sel) && opts.legend) return { legend: { innerText: opts.legend } };
      return (opts.form && sel === "form") ? opts.form : null;
    },
    focus() {},
    click() { el._clicked = true; if (opts.onClick) opts.onClick(el); },
    dispatchEvent(e) { el._listeners.push(e.type); return true; },
    getBoundingClientRect() { return { width: 120, height: 22 }; },
    set value(v) { el._value = v; },
    get value() { return el._value !== undefined ? el._value : (opts.value || ""); },
  };
  el._value = opts.value || "";
  return el;
}

/* A real <button> element. A button carries an explicit type attribute, so
 * content.js can tell a form's own submit button (type=submit, or no type
 * inside a <form>) from a plain click handler. Pass attrs: {} to model the
 * no-type-attribute case. */
function makeButton(label, onClick, extra) {
  return makeInput(Object.assign({
    tagName: "BUTTON", type: "button", textContent: label, className: "btn", onClick,
    attrs: { type: "button" },
  }, extra || {}));
}

let PAGE_FIELDS = [];
let PAGE_BUTTONS = [];
let PAGE_APPLY_ANCHORS = [];   // Workday-style bare <a href="…/apply"> openers
let PAGE_OT_REJECT = null;     // vendor consent buttons (#onetrust-…, etc.)
let PAGE_OT_ACCEPT = null;
let PAGE_OPTIONS = [];   // rows of an autocomplete picker, rendered after typing
let CAPTCHA = false;
/* When true alongside CAPTCHA, the captcha nodes exist but are not rendered —
 * Lever's invisible hCaptcha scoring iframe, which must NOT halt a run. */
let CAPTCHA_INVISIBLE = false;
/* reCAPTCHA's floating "protected by reCAPTCHA" badge — rendered, but it is
 * documentation, not a challenge. Greenhouse/foundit application pages carry
 * it at the viewport corner; treating it as a checkpoint blocked those fills. */
let CAPTCHA_BADGE = false;
let PAGE_URL = "https://jobs.example.com/apply/123";
let BODY_TEXT = "";
let PAGE_ERRORS = [];   // on-page validation nodes the engine may quote back

/* The engine types at human pace on purpose and bounds its waits with
 * Date.now(). The harness runs both on a virtual clock: every sleep() fires in
 * 1ms, and the clock jumps the amount that was requested. A 6-second look for
 * a submit control therefore costs milliseconds here, while the engine's
 * deadlines still mean what they say. The engine itself is untouched. */
const _realSetTimeout = globalThis.setTimeout;
const _realNow = Date.now;
let _skew = 0;
globalThis.setTimeout = (fn, ms) => {
  _skew += Math.max(ms || 0, 0);
  return _realSetTimeout(fn, 1);
};
globalThis.Date.now = () => _realNow() + _skew;

/* Default: dashboard unreachable. Tests 12-13 swap this for a fake one. */
globalThis.fetch = async () => ({ ok: false, json: async () => null });

globalThis.location = {
  get href() { return PAGE_URL; },
  // Real browsers always expose these; content.js quotes location.host to say
  // WHICH site a run stalled on, so the harness must model them.
  get host() { return PAGE_URL.replace(/^https?:\/\//, "").split("/")[0]; },
  get hostname() { return PAGE_URL.replace(/^https?:\/\//, "").split("/")[0].split(":")[0]; },
  get pathname() { try { return new URL(PAGE_URL).pathname; } catch { return ""; } },
  get search() { try { return new URL(PAGE_URL).search; } catch { return ""; } },
};
globalThis.document = {
  body: { get innerText() { return BODY_TEXT; } },
  readyState: "complete",
  querySelectorAll(sel) {
    if (sel.includes("input, textarea, select")) return PAGE_FIELDS;
    /* The opener selector (CLICKABLE + apply-href anchors) — both kinds of
     * opener qualify; plain-anchor openers live only in PAGE_APPLY_ANCHORS. */
    if (sel.includes("a[href*='/apply'")) return PAGE_APPLY_ANCHORS.concat(PAGE_BUTTONS);
    if (sel.includes("[role=option]")) return PAGE_OPTIONS;  // autocomplete picker
    /* optionGroup() asks for radios/checkboxes by type, never by name: custom
     * yes/no widgets ship nameless radios. */
    if (sel.includes("input[type=radio]")) {
      return PAGE_FIELDS.filter((f) => f.type === "radio" || f.type === "checkbox");
    }
    if (sel.includes("[role=button]")) return PAGE_BUTTONS;   // CLICKABLE selector
    if (sel.includes("[class*='error'") || sel.includes("[role=alert]")) return PAGE_ERRORS;
    const m = /input\[name="(.+?)"\]/.exec(sel);
    if (m) return PAGE_FIELDS.filter((f) => f.name === m[1]);
    if (CAPTCHA && /captcha/i.test(sel)) {
      return CAPTCHA_INVISIBLE ? [invisibleCaptcha()]
        : CAPTCHA_BADGE ? [badgeCaptcha()]
        : [visibleCaptcha()];
    }
    return [];
  },
  querySelector(sel) {
    if (CAPTCHA && /captcha/i.test(sel)) return { stub: true };
    if (sel === "#onetrust-reject-all-handler") return PAGE_OT_REJECT;
    if (sel === "#onetrust-accept-btn-handler") return PAGE_OT_ACCEPT;
    return null;
  },
  getElementById() { return null; },
  addEventListener() {},
};

/* Computed-style lookups for the captcha visibility walk. Nodes carry a
 * `_cs` snapshot; anything else reads as a plain rendered box. */
const VISIBLE_CS = { display: "block", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "visible" };
globalThis.getComputedStyle = (n) => n && n._cs ? n._cs : VISIBLE_CS;

function visibleCaptcha() {
  return { nodeType: 1, tagName: "DIV", className: "g-recaptcha",
    getBoundingClientRect: () => ({ width: 300, height: 80 }),
    clientWidth: 300, clientHeight: 80, _cs: Object.assign({}, VISIBLE_CS),
    parentElement: null };
}
/* reCAPTCHA's floating corner badge: a rendered 256x60 iframe — but it lives
 * inside .grecaptcha-badge, so it is the notice, not a checkpoint. */
function badgeCaptcha() {
  return { nodeType: 1, tagName: "IFRAME", title: "reCAPTCHA",
    getBoundingClientRect: () => ({ width: 256, height: 60 }),
    clientWidth: 256, clientHeight: 60, _cs: Object.assign({}, VISIBLE_CS),
    closest: (sel) => (sel === ".grecaptcha-badge" ? { nodeType: 1 } : null),
    parentElement: null };
}
/* hCaptcha's scoring frame: a full-size iframe inside a 0-height wrapper
 * that clips (overflow-y hidden) — present in the DOM, invisible to a human. */
function invisibleCaptcha() {
  const wrap = { nodeType: 1, tagName: "DIV", className: "h-captcha",
    clientWidth: 1205, clientHeight: 0,
    _cs: { display: "block", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "hidden" },
    parentElement: null };
  return { nodeType: 1, tagName: "IFRAME",
    getBoundingClientRect: () => ({ width: 1265, height: 720 }),
    clientWidth: 1265, clientHeight: 720, _cs: Object.assign({}, VISIBLE_CS),
    parentElement: wrap };
}

globalThis.HTMLInputElement = function () {};
globalThis.HTMLTextAreaElement = function () {};
globalThis.HTMLSelectElement = function () {};
globalThis.CSS = { escape: (s) => s.replace(/"/g, '\\"') };

// content.js guards on these being real constructors for instanceof checks.
Object.defineProperty(globalThis, "__isFake", { value: true });

const engineSrc = require("fs").readFileSync(require("path").join(__dirname, "content.js"), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
};

/* ---------- a realistic Workday-ish single-page form ---------- */

function loadEngine(opts) {
  /* keepGuard: re-eval WITHOUT clearing the load guard — models the popup
   * re-injecting files into a tab that already has an engine (the real-world
   * path where a stale engine used to win forever). */
  if (!(opts && opts.keepGuard)) {
    delete globalThis.__JOB_AGENT_LOADED__;
    delete globalThis.__JOB_AGENT__;
  }
  PAGE_OPTIONS = [];   // no autocomplete picker unless a test installs one
  // instanceof must recognise our fakes.
  const wrapped = engineSrc
    .replace(/el instanceof HTMLTextAreaElement/g, 'el.tagName === "TEXTAREA"')
    .replace(/el instanceof HTMLSelectElement/g, 'el.tagName === "SELECT"');
  eval(wrapped);
  return globalThis.__JOB_AGENT__;
}

function buildForm() {
  const text = (label, name, extra) => makeInput(Object.assign({ type: "text", label, name }, extra || {}));
  return [
    text("First Name", "first_name"),
    text("Last Name", "last_name"),
    text("Primary Email", "applicant_email"),
    text("Mobile Phone", "phone_number"),
    text("City", "city"),
    text("State/Province", "state"),
    text("Country/Region", "country"),
    text("Current Title", "current_title"),
    text("Notice Period", "notice_period"),
    text("LinkedIn Profile", "linkedin"),
    // Open question (null in the pack) — must be left blank.
    text("Expected CTC", "expected_ctc"),
    // Not in the pack at all — must be ignored, not guessed.
    text("Favourite Colour", "fave_colour"),
    // Submit-looking input: must be excluded from FILLING (wouldSubmit).
    makeInput({ type: "text", name: "apply_now_btn", className: "btn apply-now", textContent: "Apply Now" }),
  ];
}

/* Decoy controls that must never be clicked in fill-only mode:
 * the real submit and a pay button. */
function buildDangerButtons(submitExtra) {
  return [
    makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; }, submitExtra),
    makeButton("Pay application fee", null, { className: "btn pay" }),
  ];
}

(async () => {
  /* --- 1. fill-only: fills real fields, leaves open questions blank --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = buildDangerButtons();
  CAPTCHA = false;
  BODY_TEXT = "";
  let api = loadEngine();
  let res = await api.run({ submit: false });

  const byName = (n) => PAGE_FIELDS.find((f) => f.name === n);
  const submitEl = PAGE_BUTTONS[0];
  const payEl = PAGE_BUTTONS[1];
  const applyInput = PAGE_FIELDS.find((f) => f.name === "apply_now_btn");

  check("fill-only reports ok", res.ok === true, res);
  check("fill-only does not submit", res.submitted === false, res.submitted);
  check("First Name filled", byName("first_name").value === "Shivayogi", byName("first_name").value);
  check("Last Name filled", byName("last_name").value === "Math", byName("last_name").value);
  check("Primary Email filled", byName("applicant_email").value === globalThis.FILLPACK.identity.email, { got: byName("applicant_email").value });
  check("Mobile Phone filled", byName("phone_number").value === "9900455663", byName("phone_number").value);
  check("City filled", byName("city").value === "Bengaluru", byName("city").value);
  check("State filled", byName("state").value === "Karnataka", byName("state").value);
  check("Country filled", byName("country").value === "India", byName("country").value);
  check("Current Title filled", byName("current_title").value === "AI Architect", byName("current_title").value);
  check("Notice Period filled", byName("notice_period").value.length > 0, byName("notice_period").value);

  check("open question left blank", byName("expected_ctc").value === "", byName("expected_ctc").value);
  check("open question reported", res.openQuestions.includes("work.expectedSalary"), res.openQuestions);
  check("unknown field untouched", byName("fave_colour").value === "", byName("fave_colour").value);

  check("fill-only: submit never clicked", submitEl._clicked === false);
  check("fill-only: pay never clicked", payEl._clicked === false);
  check("fill-only: Apply-Now-styled input untouched", applyInput.value === "" && applyInput._clicked === false, applyInput.value);
  check("fill-only note says nothing submitted", /nothing was submitted/i.test(res.note), res.note);

  /* --- 2. human pace: value arrives char by char, not in one shot --- */
  const city = byName("city");
  check("typing dispatches input events", (city._listeners || []).includes("input"), city._listeners);
  check("typing dispatches change events", (city._listeners || []).includes("change"), city._listeners);
  check("typing ends with blur", city._listeners[city._listeners.length - 1] === "blur", city._listeners);

  /* --- 3. select elements --- */
  PAGE_FIELDS = [makeInput({
    type: "select", label: "Employment Type", name: "emp_type",
    options: [{ text: "--Select--", value: "" }, { text: "Full-time", value: "FT" }, { text: "Contract", value: "C" }],
  })];
  PAGE_BUTTONS = [makeButton("Submit Application")];
  api = loadEngine();
  res = await api.run({ submit: false });
  check("select option chosen", PAGE_FIELDS[0].value === "FT", PAGE_FIELDS[0].value);

  /* --- 4. CAPTCHA gate: stops fill, touches nothing --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = buildDangerButtons();
  CAPTCHA = true;
  api = loadEngine();
  res = await api.run({ submit: false });
  check("captcha halts fill", res.ok === false && res.reason === "captcha", res);
  check("captcha: nothing filled", byName("first_name").value === "", byName("first_name").value);

  /* --- 5. CAPTCHA gate also halts SUBMIT before any click --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = buildDangerButtons();
  CAPTCHA = true;
  api = loadEngine();
  res = await api.run({ submit: true });
  check("captcha halts submit", res.ok === false && res.reason === "captcha", res);
  check("captcha+submit: nothing clicked", submitEl._clicked === false && payEl._clicked === false,
    { submit: submitEl._clicked, pay: payEl._clicked });

  /* --- 5b. INVISIBLE captcha must NOT halt. Lever's apply pages carry an
   * hCaptcha scoring iframe in a 0-height clipping wrapper on every load;
   * treating it as a challenge blocked every real Lever fill. --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = [makeButton("Submit Application")];
  CAPTCHA = true;
  CAPTCHA_INVISIBLE = true;
  api = loadEngine();
  res = await api.run({ submit: false });
  check("invisible captcha does not halt fill", res.ok === true, res);
  check("invisible captcha: field filled", byName("first_name").value === "Shivayogi",
    byName("first_name").value);
  CAPTCHA = false;
  CAPTCHA_INVISIBLE = false;

  /* --- 5c. The reCAPTCHA corner BADGE must NOT halt: it is rendered on
   * every Greenhouse/foundit application page and is not a challenge. --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = [makeButton("Submit Application")];
  CAPTCHA = true;
  CAPTCHA_BADGE = true;
  api = loadEngine();
  res = await api.run({ submit: false });
  check("captcha badge does not halt fill", res.ok === true, res);
  check("captcha badge: field filled", byName("first_name").value === "Shivayogi",
    byName("first_name").value);
  CAPTCHA = false;
  CAPTCHA_BADGE = false;

  /* --- 6. submit mode, single page: fills then clicks the real submit --- */
  PAGE_FIELDS = buildForm();
  const submitSingle = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; });
  PAGE_BUTTONS = [submitSingle, makeButton("Pay application fee")];
  CAPTCHA = false;
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("submit mode returns ok", res.ok === true, res);
  check("submit mode clicked submit", submitSingle._clicked === true);
  check("submit mode did not click pay", PAGE_BUTTONS[1]._clicked === false);
  check("confirmation captured", /submitted/i.test(res.confirmation || ""), res.confirmation);
  check("result says submitted", res.submitted === true, res.submitted);
  check("fields were filled before submit", byName("first_name").value === "Shivayogi", byName("first_name").value);

  /* --- 7. multi-step wizard: Next advances, then Submit finishes --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const nextBtn = makeButton("Next", () => {
    // step 2 appears: a new field + the submit control
    PAGE_FIELDS = [makeInput({ type: "text", label: "City", name: "city" })];
    PAGE_BUTTONS = [makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Application sent — thank you!"; })];
  });
  PAGE_BUTTONS = [nextBtn];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("wizard: next was clicked", nextBtn._clicked === true);
  check("wizard: step-1 field filled", PAGE_FIELDS.length === 1 && res.filled.some((f) => f.key === "identity.firstName"), res.filled);
  check("wizard: step-2 field filled", res.filled.some((f) => f.key === "identity.city"), res.filled);
  check("wizard: submitted at the end", res.ok === true && res.submitted === true, res);
  check("wizard: confirmation captured", /application sent/i.test(res.confirmation || ""), res.confirmation);

  /* --- 8. no submit control: filled but honest about it --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = [];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("no submit control reported", res.ok === false && res.reason === "no-submit-control", res);
  check("no submit control: fields still filled", byName("first_name").value === "Shivayogi", byName("first_name").value);
  check("no submit control: report names the host", /jobs\.example\.com/.test(res.message || ""), res.message);
  check("no submit control: report hints at an iframe", /iframe/i.test(res.message || ""), res.message);

  /* --- 9. required unanswered field blocks submit --- */
  PAGE_FIELDS = buildForm().map((el) => {
    if (el.name === "expected_ctc") el.required = true;
    return el;
  });
  const submitReq = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitReq];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("required missing blocks submit", res.ok === false && res.reason === "required-missing", res);
  check("required missing: submit not clicked", submitReq._clicked === false);
  check("required missing: message names the field", /work\.expectedSalary/.test(res.message || ""), res.message);

  /* --- 10. pay controls are never clicked even if nothing else exists --- */
  PAGE_FIELDS = buildForm();
  const payOnly = makeButton("Pay and submit application", null, { className: "btn pay" });
  PAGE_BUTTONS = [payOnly];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("pay-only page: nothing clicked", payOnly._clicked === false, res);
  check("pay-only page: reports no submit control", res.ok === false && res.reason === "no-submit-control", res);

  /* --- 11. preview is safe (never clicks anything) --- */
  PAGE_FIELDS = buildForm();
  PAGE_BUTTONS = buildDangerButtons();
  api = loadEngine();
  const pv = api.preview();
  check("preview lists fillable keys", pv.wouldFill.some((f) => f.key === "identity.firstName"), pv);
  check("preview flags open questions", pv.needsYou.includes("work.expectedSalary"), pv.needsYou);
  check("preview never clicks", PAGE_BUTTONS.every((b) => b._clicked === false));

  /* --- 12. autopilot fires ONLY for a job approved in the dashboard --- */
  const mkAutoFixture = () => {
    const submitA = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; });
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [submitA];
    BODY_TEXT = "";
    return submitA;
  };

  // positive: current page is an approved job -> fills, submits, reports
  let submitA = mkAutoFixture();
  const reported = [];
  api = loadEngine();   // load while the default no-op stub is active — no eval-time race
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 7, url: PAGE_URL, title: "Test Job", company: "Acme" }],
        decisions: { 7: { action: "approve", ts: 1 } },
      }) };
    }
    if (String(url).includes("/report")) {
      reported.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: false, json: async () => null };
  };
  await api.autopilot();
  check("autopilot: approved job submitted", submitA._clicked === true);
  check("autopilot: field filled", PAGE_FIELDS[0].value === "Shivayogi", PAGE_FIELDS[0].value);
  check("autopilot: reported to dashboard", reported.length === 1 && reported[0].status === "applied", reported);

  /* --- 12b. apply-run chain: after reporting, the page asks the dashboard
   *        for the NEXT queued job and has the worker open it. That handoff is
   *        the "then apply" loop — no tab or dashboard has to stay open. --- */
  delete globalThis.chrome;
  const opened = [];
  globalThis.chrome = makeWorkerChrome(opened);
  let nextResponse = { done: false, job: { id: 32, url: "https://www.naukri.com/job-listings-next-queued-job" } };
  const quietFetch = async () => ({ ok: false, json: async () => null });
  globalThis.fetch = quietFetch;
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 10));   // drain eval-time boot
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 31, url: PAGE_URL, title: "Chain Job", company: "Acme" }],
        decisions: { 31: { action: "apply", ts: 1 } },
      }) };
    }
    if (String(url).includes("/api/apply/next")) return { ok: true, json: async () => nextResponse };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitChain = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; });
  PAGE_BUTTONS = [submitChain];
  BODY_TEXT = "";
  await api.autopilot();
  check("chain: finished job submitted", submitChain._clicked === true);
  check("chain: asked for the next queued job", opened.length === 1 && opened[0].type === "apply:open", opened);
  check("chain: opened the next job by URL",
    opened[0] && opened[0].url === "https://www.naukri.com/job-listings-next-queued-job", opened[0]);

  /* An exhausted (or absent) run must not open anything. */
  opened.length = 0;
  nextResponse = { done: true, run: { total: 1, applied: 1, halted: 0 } };
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitEnd = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitEnd];
  await api.autopilot();
  check("chain: finished run opens nothing more", opened.length === 0, opened);
  delete globalThis.chrome;
  globalThis.fetch = quietFetch;

  /* --- 12c. a board's SEARCH page is never an application.
   *        The exact report this fixes: "Stuck on step 3: clicking Next did
   *        not advance the form — fields it couldn't place: \"Enter keyword,
   *        designation, or companies\" … controls here: Next, Search jobs
   *        here". The wizard had driven a search box and clicked pagination. --- */
  PAGE_URL = "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore";
  const searchFixture = () => {
    PAGE_FIELDS = [
      makeInput({ type: "text", placeholder: "Enter keyword, designation, or companies", name: "k" }),
      makeInput({ type: "text", label: "Select experience", name: "experienceDD" }),
      makeInput({ type: "text", placeholder: "Enter location", name: "l" }),
    ];
  };
  let pagerClicks = 0;
  searchFixture();
  PAGE_BUTTONS = [
    makeButton("Search jobs here", () => {}),
    makeButton("Search", () => {}),
    makeButton("Next", () => { pagerClicks++; }),
    makeButton("Notifications", () => {}),
  ];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("search page: refuses as not-an-application", res.ok === false && res.reason === "not-an-application", res);
  check("search page: pagination Next never clicked", pagerClicks === 0, pagerClicks);
  check("search page: typed nothing into the search boxes", PAGE_FIELDS.every((f) => !f.value),
    PAGE_FIELDS.map((f) => f.value));
  check("search page: message points at a job", /open a specific job/i.test(res.message || ""), res.message);

  /* A results list whose cards carry "Easy Apply" is STILL not an application
   * (LinkedIn). The card's opener must never be clicked from a list page. */
  PAGE_URL = "https://www.linkedin.com/jobs/search/?keywords=AI%20ML%20Engineer";
  searchFixture();
  pagerClicks = 0;
  let easyClicks = 0;
  PAGE_BUTTONS = [
    makeButton("Easy Apply", () => { easyClicks++; }),
    makeButton("Next", () => { pagerClicks++; }),
  ];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("linkedin search list: refuses even with Easy Apply cards", res.reason === "not-an-application", res);
  check("linkedin search list: card opener never clicked", easyClicks === 0, easyClicks);
  check("linkedin search list: pagination untouched", pagerClicks === 0, pagerClicks);

  /* …but an application that merely has a search box still runs. */
  PAGE_URL = "https://jobs.example.com/apply/123";
  PAGE_FIELDS = [
    makeInput({ type: "text", label: "First Name", name: "first_name" }),
    makeInput({ type: "text", placeholder: "Search", name: "keyword" }),
  ];
  const submitWithSearch = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; });
  PAGE_BUTTONS = [submitWithSearch];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("application with a search box still submits", res.ok === true && res.submitted === true, res);

  /* autopilot on that search page: no failed report, and the run moves on. */
  PAGE_URL = "https://www.naukri.com/ai-ml-engineer-jobs-in-bangalore";
  searchFixture();
  pagerClicks = 0;
  PAGE_BUTTONS = [makeButton("Search jobs here", () => {}), makeButton("Next", () => { pagerClicks++; })];
  const openedOnSearch = [];
  let reports = 0;
  globalThis.chrome = makeWorkerChrome(openedOnSearch);
  globalThis.fetch = quietFetch;
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 10));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 41, url: PAGE_URL, title: "Expired job", company: "Acme" }],
        decisions: { 41: { action: "apply", ts: 1 } },
      }) };
    }
    if (String(url).includes("/report")) { reports++; return { ok: true, json: async () => ({ ok: true }) }; }
    if (String(url).includes("/api/apply/next")) {
      return { ok: true, json: async () => ({ done: false, job: { id: 42, url: "https://www.naukri.com/job-listings-next" } }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await api.autopilot();
  check("search page autopilot: nothing reported as failed", reports === 0, reports);
  check("search page autopilot: pagination untouched", pagerClicks === 0, pagerClicks);
  check("search page autopilot: queue advanced instead",
    openedOnSearch.length === 1 && /job-listings-next/.test(openedOnSearch[0].url || ""), openedOnSearch);
  delete globalThis.chrome;
  globalThis.fetch = quietFetch;
  PAGE_URL = "https://jobs.example.com/apply/123";

  // negative: same page, but the job is NOT approved -> touches nothing
  submitA = mkAutoFixture();
  reported.length = 0;
  api = loadEngine();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 8, url: PAGE_URL, title: "Test Job", company: "Acme" }],
        decisions: { 8: { action: "deny", ts: 1 } },
      }) };
    }
    return { ok: false, json: async () => null };
  };
  await api.autopilot();
  check("autopilot: unapproved job untouched", submitA._clicked === false && PAGE_FIELDS[0].value === "");
  check("autopilot: nothing reported for unapproved", reported.length === 0, reported);

  /* --- 13. LinkedIn country-subdomain redirect still matches --- */
  const redirectFixture = () => {
    const submitA2 = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; });
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [submitA2];
    BODY_TEXT = "";
    return submitA2;
  };
  const submitR = redirectFixture();
  api = loadEngine();
  PAGE_URL = "https://www.linkedin.com/jobs/view/4472392193/?refId=abc&trackingId=xyz";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 9, url: "https://in.linkedin.com/jobs/view/ai-ml-engineer-4472392193?position=7", title: "Redirected Job", company: "Infosys" }],
        decisions: { 9: { action: "apply", ts: 1 } },
      }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await api.autopilot();
  check("redirect: in.linkedin.com job matches www tab", submitR._clicked === true);
  PAGE_URL = "https://jobs.example.com/apply/123";   // restore for readability

  /* --- 14. fake chrome.storage.local for in-flight marker tests --- */
  /* A service-worker chrome: "dashboard" messages are relayed through the
   * fetch stub (like background.js), "apply:open" is recorded. */
  function makeWorkerChrome(opened) {
    return {
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
      runtime: {
        sendMessage: (m, cb) => {
          if (!m || m.type !== "dashboard") {
            if (m && m.type === "apply:open") opened.push(m);
            if (cb) cb({ ok: true });
            return;
          }
          const opts = m.method === "POST" ? { method: "POST", body: JSON.stringify(m.body || {}) } : {};
          globalThis.fetch("http://127.0.0.1:8357" + m.path, opts)
            .then(async (r) => { let json = null; try { json = await r.json(); } catch {} if (cb) cb({ ok: r.ok, json }); })
            .catch(() => { if (cb) cb({ ok: false, json: null }); });
        },
      },
    };
  }

  function makeChrome() {
    const data = {};
    return {
      storage: { local: {
        async get(k) { return { [k]: data[k] }; },
        async set(o) { Object.assign(data, o); },
        async remove(k) { delete data[k]; },
      } },
      _data: data,
    };
  }
  const NOOP_FETCH = async () => ({ ok: false, json: async () => null });

  /* --- 15. landing page: opener click opens the form, then it submits --- */
  PAGE_FIELDS = [];                                // no form yet — just a landing page
  const applyBtn = makeButton("Easy Apply", () => {
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; })];
  });
  PAGE_BUTTONS = [applyBtn];
  CAPTCHA = false;
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("landing: opener was clicked", applyBtn._clicked === true);
  check("landing: form filled after opener", res.filled.some((f) => f.key === "identity.firstName"), res.filled);
  check("landing: submitted at the end", res.ok === true && res.submitted === true, res);

  /* --- 16. landing page with nothing to click: honest halt, no guessing --- */
  PAGE_FIELDS = [];
  PAGE_BUTTONS = [];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("empty landing: halts with no-submit-control", res.ok === false && res.reason === "no-submit-control", res);
  check("empty landing: says no opener exists", /no reachable Apply\/Easy Apply control/.test(res.message || ""), res.message);

  /* --- 15b. Workday-style opener: the ONLY Apply control is a bare
   * <a href="…/apply"> — no button class. Autopilot must find it in preview,
   * click it, fill the form that appears, and submit. This is the "once it's
   * connected, apply even if it routes to Workday" contract. --- */
  PAGE_FIELDS = [];                                 // job detail page, no form yet
  PAGE_BUTTONS = [];
  let anchorClicks = 0;
  const applyAnchor = makeInput({
    tagName: "A", textContent: "Apply", className: "",
    href: "https://acme.wd1.myworkdayjobs.com/External/job/X/apply",
    attrs: {},
    onClick: () => {
      anchorClicks++;
      PAGE_APPLY_ANCHORS = [];
      PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
      PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; })];
    },
  });
  /* Real DOM exposes BOTH textContent and innerText for the same node — the
   * duplicate that used to make controlText read "Apply Apply", which no
   * anchored hint could match. Set it the way a real <a> answers. */
  applyAnchor.innerText = "Apply";
  PAGE_APPLY_ANCHORS = [applyAnchor];
  BODY_TEXT = "";
  api = loadEngine();
  const wpv = api.preview();
  check("workday opener: preview reports an opener", wpv.openerControl === true, wpv);
  res = await api.run({ submit: true });
  check("workday opener: the anchor was clicked once", anchorClicks === 1, anchorClicks);
  check("workday opener: form filled after the opener", res.filled.some((f) => f.key === "identity.firstName"), res.filled);
  check("workday opener: submitted at the end", res.ok === true && res.submitted === true, res);
  PAGE_APPLY_ANCHORS = [];

  /* --- 5d. consent banner (vendor-id shape): dismissed at run entry, with
   * DECLINE preferred over ACCEPT — the agent grants nothing on the user's
   * behalf — and the run proceeds to a real submit afterwards. --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; })];
  let rejectClicked = false, acceptClicked = false;
  PAGE_OT_REJECT = makeButton("Decline", () => { rejectClicked = true; });
  PAGE_OT_ACCEPT = makeButton("Accept Cookies", () => { acceptClicked = true; });
  CAPTCHA = false;
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("consent: vendor DECLINE clicked", rejectClicked === true, rejectClicked);
  check("consent: vendor ACCEPT left alone", acceptClicked === false, acceptClicked);
  check("consent: run continued and submitted", res.ok === true && res.submitted === true, res);
  PAGE_OT_REJECT = PAGE_OT_ACCEPT = null;

  /* --- 5e. consent banner (plain-text shape, no vendor id): Motorola's
   * "Decline" button in a privacy-notice wrapper — found by text + context. --- */
  let plainDeclined = false, plainAccepted = false;
  const bannerParent = { id: "", className: "privacy-notice", textContent:
    "Cookie Policy Read Full Privacy Message Decline Accept Cookies", parentElement: null };
  PAGE_BUTTONS = [
    makeButton("Decline", () => { plainDeclined = true; }, { parent: bannerParent }),
    makeButton("Accept Cookies", () => { plainAccepted = true; }, { parent: bannerParent }),
    makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; }),
  ];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("consent: plain DECLINE clicked", plainDeclined === true, plainDeclined);
  check("consent: plain ACCEPT left alone", plainAccepted === false, plainAccepted);
  check("consent: run continued and submitted (plain shape)", res.ok === true && res.submitted === true, res);
  PAGE_BUTTONS = [makeButton("Submit Application")];

  /* --- 17. resume after redirect: marker + approved decision -> applies --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitResume = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; });
  PAGE_BUTTONS = [submitResume];
  BODY_TEXT = "";
  const chromeA = makeChrome();
  globalThis.chrome = chromeA;
  globalThis.fetch = NOOP_FETCH;
  api = loadEngine();
  /* Let eval-time boot() finish under the no-op fetch BEFORE installing the
   * marker + stub — otherwise boot's deferred awaits would race the explicit
   * resume() below and double-submit. */
  await new Promise((r) => _realSetTimeout(r, 0));
  chromeA._data.inflight = { jobId: 21, ts: Date.now() };
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 21, url: "https://boards.greenhouse.io/acme/jobs/999", title: "ATS Page", company: "Acme" }],
        decisions: { 21: { action: "apply", ts: 1 } },
      }) };
    }
    if (String(url).includes("/report")) { reported.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: false, json: async () => null };
  };
  reported.length = 0;
  await api.resume();                              // PAGE_URL deliberately does NOT match
  check("resume: redirected page submitted", submitResume._clicked === true);
  check("resume: reported under the in-flight job", reported.length === 1 && reported[0].status === "applied", reported);
  check("resume: marker cleared after applied", chromeA._data.inflight === undefined, chromeA._data);

  /* --- 18. stale marker (past TTL) is ignored and cleaned up --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitStale = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitStale];
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 0));   // drain eval-time boot
  chromeA._data.inflight = { jobId: 21, ts: Date.now() - 6 * 60 * 1000 };  // older than 5-min TTL
  await api.resume();
  check("resume: stale marker ignored", submitStale._clicked === false && PAGE_FIELDS[0].value === "");
  check("resume: stale marker cleaned up", chromeA._data.inflight === undefined, chromeA._data);

  /* --- 19. marker for an already-applied job never re-applies --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitDone = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitDone];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 21, url: "https://boards.greenhouse.io/acme/jobs/999", title: "ATS Page", company: "Acme" }],
        decisions: { 21: { action: "applied", ts: 1 } },
      }) };
    }
    return { ok: false, json: async () => null };
  };
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 0));   // drain eval-time boot
  chromeA._data.inflight = { jobId: 21, ts: Date.now() };
  await api.resume();
  check("resume: applied job never re-applied", submitDone._clicked === false && PAGE_FIELDS[0].value === "");
  check("resume: marker cleared for applied job", chromeA._data.inflight === undefined, chromeA._data);

  /* --- 20. marker for a denied job never applies --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitDenied = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitDenied];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) {
      return { ok: true, json: async () => ({
        jobs: [{ id: 22, url: "https://boards.greenhouse.io/acme/jobs/1000", title: "Denied Job", company: "Acme" }],
        decisions: { 22: { action: "deny", ts: 1 } },
      }) };
    }
    return { ok: false, json: async () => null };
  };
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 0));   // drain eval-time boot
  chromeA._data.inflight = { jobId: 22, ts: Date.now() };
  await api.resume();
  check("resume: denied job untouched", submitDenied._clicked === false && PAGE_FIELDS[0].value === "");
  check("resume: marker cleared for denied job", chromeA._data.inflight === undefined, chromeA._data);

  /* --- 21. no marker at all: browsing is never touched --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const submitBrowse = makeButton("Submit Application", (el) => { el._clicked = true; });
  PAGE_BUTTONS = [submitBrowse];
  delete chromeA._data.inflight;
  api = loadEngine();
  await new Promise((r) => _realSetTimeout(r, 0));   // drain eval-time boot
  await api.resume();
  check("resume: no marker = no action", submitBrowse._clicked === false && PAGE_FIELDS[0].value === "");

  /* --- 22. a Next click that changes nothing: report why, once --- */
  PAGE_ERRORS = [];
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  let stuckClicks = 0;
  PAGE_BUTTONS = [makeButton("Next", () => { stuckClicks++; })];   // never advances
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("stuck: reports step-stuck", res.ok === false && res.reason === "step-stuck", res);
  check("stuck: clicked Next exactly once", stuckClicks === 1, stuckClicks);
  check("stuck: message says it did not advance", /did not advance the form/.test(res.message || ""), res.message);
  check("stuck: field was still filled", byName("first_name").value === "Shivayogi", byName("first_name").value);

  /* --- 23. the page's own validation copy is quoted back --- */
  PAGE_ERRORS = [{ innerText: "This field is required.", textContent: "" }];
  PAGE_FIELDS = [makeInput({ type: "text", label: "Expected CTC", name: "expected_ctc" })];
  let vClicks = 0;
  PAGE_BUTTONS = [makeButton("Continue", () => { vClicks++; })];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("validation: reports validation-blocked", res.ok === false && res.reason === "validation-blocked", res);
  check("validation: quotes the page error", /This field is required/.test(res.message || ""), res.message);
  check("validation: clicked Continue once", vClicks === 1, vClicks);
  PAGE_ERRORS = [];

  /* --- 24. review step: no fields, Next + Submit -> Submit wins --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  let nextAfterFill = 0, submittedReview = false;
  PAGE_BUTTONS = [makeButton("Next", () => {
    nextAfterFill++;
    PAGE_FIELDS = [];                                  // review step: nothing to fill
    PAGE_BUTTONS = [
      makeButton("Next", () => { nextAfterFill++; }),
      makeButton("Submit Application", (el) => {
        el._clicked = true; submittedReview = true;
        BODY_TEXT = "Thank you for your application";
      }),
    ];
  })];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("review: Next used once to reach review", nextAfterFill === 1, nextAfterFill);
  check("review: Submit preferred over Next", submittedReview === true, submittedReview);
  check("review: submitted ok", res.ok === true && res.submitted === true, res);

  /* --- 25. budget exhausted: the give-up message carries diagnostics --- */
  PAGE_ERRORS = [{ innerText: "Please complete all required fields", textContent: "" }];
  let steps = 0;
  PAGE_FIELDS = [makeInput({ type: "text", label: "City", name: "city" })];
  PAGE_BUTTONS = [makeButton("Next", () => {
    steps++;
    // Advances every time, so progress is real — but Submit never appears.
    PAGE_FIELDS = [makeInput({ type: "text", label: "City", name: "city", id: "c" + steps })];
  })];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("budget: reason is too-many-steps", res.ok === false && res.reason === "too-many-steps", res);
  check("budget: message names the host", /jobs\.example\.com/.test(res.message || ""), res.message);
  check("budget: message quotes the page error", /Please complete all required fields/.test(res.message || ""), res.message);
  check("budget: exhausted the step budget", steps === 12, steps);
  PAGE_ERRORS = [];

  /* --- 30. the form's own submit control: no English label needed --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const localized = makeButton("Absenden", (el) => { el._clicked = true; }, { form: {}, attrs: {} });
  PAGE_BUTTONS = [localized];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("localized submit: form's own button clicked", localized._clicked === true, res);
  check("localized submit: reported submitted", res.ok === true && res.submitted === true, res);

  /* an explicit type=submit needs no <form> and no label either */
  const typedSubmit = makeButton("Senden", (el) => { el._clicked = true; }, { attrs: { type: "submit" } });
  PAGE_BUTTONS = [typedSubmit];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("type=submit control clicked", typedSubmit._clicked === true, res);

  /* --- 31. a one-page form whose finish control is just "Apply" --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const applyFinish = makeButton("Apply", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; });
  PAGE_BUTTONS = [applyFinish];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("apply-shaped finish clicked on a filled form", applyFinish._clicked === true, res);
  check("apply-shaped finish: reported submitted", res.ok === true && res.submitted === true, res);
  check("apply-shaped finish: confirmation captured", /thank you for your application/i.test(res.confirmation || ""), res.confirmation);

  /* ...but on a landing page that same word OPENS the form, and must not be
   * mistaken for a submission (or clicked twice). */
  PAGE_FIELDS = [];
  let landingClicks = 0;
  const landingApply = makeButton("Apply", () => { landingClicks++; });
  PAGE_BUTTONS = [landingApply];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("landing page: Apply opens the form once", landingClicks === 1, landingClicks);
  check("landing page: Apply is not a submission", !(res.ok && res.submitted), res);

  /* --- 32. a submit control that only becomes usable after the page's own
   *        validation settles --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const lateSubmit = makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; });
  lateSubmit.disabled = true;
  PAGE_BUTTONS = [lateSubmit];
  BODY_TEXT = "";
  let looks = 0;
  const realQueryAll = document.querySelectorAll;
  document.querySelectorAll = (sel) => {
    if (String(sel).includes("[role=button]")) {
      looks++;
      if (looks > 3) lateSubmit.disabled = false;   // enables itself mid-lookup
    }
    return realQueryAll(sel);
  };
  api = loadEngine();
  res = await api.run({ submit: true });
  document.querySelectorAll = realQueryAll;
  check("late submit: engine looked again", looks > 3, looks);
  check("late submit: clicked once it enabled", lateSubmit._clicked === true, res);
  check("late submit: reported submitted", res.ok === true && res.submitted === true, res);

  /* --- 33. an unrecognised layout reports what it actually saw --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  PAGE_BUTTONS = [
    makeButton("Back", null),
    makeButton("Pay application fee", null),
    makeButton("Save for later", null),
  ];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("unrecognised layout: still no-submit-control", res.reason === "no-submit-control", res);
  check("unrecognised layout: counts the filled fields", /1 field filled/.test(res.message || ""), res.message);
  check("unrecognised layout: lists the controls it saw", /"Back"/.test(res.message || ""), res.message);
  check("unrecognised layout: flags the pay control", /pay control, never clicked/.test(res.message || ""), res.message);
  check("unrecognised layout: flags the draft control", /saves a draft/.test(res.message || ""), res.message);

  /* --- 34. a text input styled as a button is never clicked --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  const decoy = makeInput({ type: "text", value: "Apply Now", className: "btn apply-now", name: "apply_now_btn" });
  PAGE_BUTTONS = [decoy];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("button-styled text input never clicked", decoy._clicked === false, decoy._clicked);
  check("button-styled text input is not a submit control", res.reason === "no-submit-control", res);

  /* --- 35. the step's own HTML validation blocks Next without saying so.
   *        (The real report that prompted this: a field named "_r_3_".) --- */
  PAGE_FIELDS = [
    makeInput({ type: "text", label: "First Name", name: "first_name" }),
    makeInput({ type: "text", name: "_r_3_", required: true, validity: { valid: false, valueMissing: true } }),
  ];
  let stallClicks = 0;
  const stallNext = makeButton("Next", () => { stallClicks++; });
  PAGE_BUTTONS = [stallNext];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("silent validation: reported validation-blocked", res.ok === false && res.reason === "validation-blocked", res);
  check("silent validation: names the blocking field", /_r_3_/.test(res.message || ""), res.message);
  check("silent validation: says why it is blocked", /required, still empty/.test(res.message || ""), res.message);
  check("silent validation: Next tried once, not twelve times", stallClicks === 1, stallClicks);
  check("silent validation: the field it could place was still filled", PAGE_FIELDS[0].value === "Shivayogi", PAGE_FIELDS[0].value);

  /* --- 36. question text that isn't wired to the input --- */
  const cityNoLabel = makeInput({ type: "text", name: "field_7" });
  cityNoLabel.previousElementSibling = { tagName: "SPAN", innerText: "City", textContent: "City" };
  const langSelect = makeInput({
    type: "select", name: "_r_3_", required: true,
    options: [{ text: "--Select--", value: "" }, { text: "English", value: "en" }, { text: "Hindi", value: "hi" }],
  });
  langSelect.previousElementSibling = { tagName: "SPAN", innerText: "Select language", textContent: "Select language" };
  const unnameable = makeInput({ type: "text", name: "_r_3_", required: true, validity: { valid: false, valueMissing: true } });
  PAGE_FIELDS = [cityNoLabel, langSelect, unnameable];
  PAGE_BUTTONS = [makeButton("Submit Application", (el) => { el._clicked = true; })];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("nearby text: sibling question text fills the field", cityNoLabel.value === "Bengaluru", cityNoLabel.value);
  check("nearby text: language asked for, not guessed", res.ok === false && /languages/.test(res.message || ""), res);
  check("nearby text: the unnameable blocker is reported too", /_r_3_/.test(res.message || ""), res.message);
  check("nearby text: no option was picked", langSelect.value === "", langSelect.value);

  /* --- 37. an unrecognised select reports the options it offered --- */
  PAGE_FIELDS = [makeInput({
    type: "select", name: "_r_9_", required: true, validity: { valid: false, valueMissing: true },
    options: [{ text: "--Select--", value: "" }, { text: "Yes", value: "y" }, { text: "No", value: "n" }],
  })];
  PAGE_BUTTONS = [makeButton("Next", () => {})];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("unrecognised select: left untouched", PAGE_FIELDS[0].value === "", PAGE_FIELDS[0].value);
  check("unrecognised select: report lists its options", /Yes, No/.test(res.message || ""), res.message);
  check("unrecognised select: report gives the machine name", /_r_9_/.test(res.message || ""), res.message);

  /* --- 37b. free-text screening questions from the pack's question bank.
   *        The real report: "Do you have form 16 and P/F A/c of current &
   *        previous company" with yes/no radios — previously "a field it
   *        couldn't place", so the application stalled on it. --- */
  const FORM16 = "Do you have form 16 and P/F A/c of current & previous company";
  const form16Yes = makeInput({ type: "radio", name: "form16", value: "yes", aria: "yes", legend: FORM16 });
  const form16No = makeInput({ type: "radio", name: "form16", value: "no", aria: "no", legend: FORM16 });
  const savedQuestions = globalThis.FILLPACK.questions;
  globalThis.FILLPACK.questions = [{ match: "form ?16", answer: true, label: FORM16 }];
  PAGE_FIELDS = [form16Yes, form16No];
  PAGE_BUTTONS = [makeButton("Submit Application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; })];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("question bank: the yes radio was clicked", form16Yes._clicked === true, form16Yes._clicked);
  check("question bank: the no radio was left alone", form16No._clicked === false, form16No._clicked);
  check("question bank: form completed", res.ok === true && res.submitted === true, res);

  /* A boolean answer must never be typed into a free-text box: "PF number"
   * matches the PF entry, but the answer belongs on a yes/no control. */
  const pfNumber = makeInput({ type: "text", label: "PF number", name: "pf_number" });
  globalThis.FILLPACK.questions = [{ match: "provident fund|p f a c|pf account", answer: true, label: "PF account" }];
  PAGE_FIELDS = [pfNumber];
  PAGE_BUTTONS = [];
  api = loadEngine();
  res = await api.run({ submit: false });
  check("question bank: yes/no answer is never typed into a text box",
    String(pfNumber.value) === "", pfNumber.value);

  /* A bank entry with no answer is an open question — asked, not guessed. */
  form16Yes._clicked = false;
  form16No._clicked = false;
  PAGE_FIELDS = [form16Yes, form16No];
  PAGE_BUTTONS = [makeButton("Submit Application", (el) => { el._clicked = true; })];
  globalThis.FILLPACK.questions = [{ match: "form ?16", answer: null, label: FORM16 }];
  api = loadEngine();
  res = await api.run({ submit: false });
  check("question bank: unanswered question is reported by its label",
    (res.openQuestions || []).includes(FORM16), res.openQuestions);
  check("question bank: unanswered question was not guessed",
    form16Yes._clicked === false && form16No._clicked === false,
    [form16Yes._clicked, form16No._clicked]);
  globalThis.FILLPACK.questions = savedQuestions;

  /* --- 37c. the widget from the real screenshot: the wording sits in a plain
   *        <p> above the pills and the radios have no name attribute at all —
   *        their own labels say only "yes" and "no". Neither the label nor
   *        the name says which question is being answered, so the question
   *        bank sees nothing unless the engine reads the wording above. --- */
  {
    const qText = "Do you have form 16 and P/F A/c of current & previous company";
    const questionP = { tagName: "P", innerText: qText, textContent: qText };
    const options = { tagName: "DIV", previousElementSibling: questionP, childNodes: [] };
    const yesLabel = { tagName: "LABEL", parentElement: options, previousElementSibling: null };
    const noLabel = { tagName: "LABEL", parentElement: options, previousElementSibling: yesLabel };
    const yes = makeInput({ type: "radio", value: "yes", label: "yes", parent: yesLabel });
    const no = makeInput({ type: "radio", value: "no", label: "no", parent: noLabel });
    yesLabel.childNodes = [yes];
    noLabel.childNodes = [no];
    options.childNodes = [yesLabel, noLabel];
    globalThis.FILLPACK.questions = [{ match: "form ?16", answer: true, label: qText }];
    PAGE_FIELDS = [yes, no];
    PAGE_BUTTONS = [makeButton("Submit Application", (el) => {
      el._clicked = true; BODY_TEXT = "Thank you for your application";
    })];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("screenshot widget: nameless yes radio clicked", yes._clicked === true, yes._clicked);
    check("screenshot widget: no radio left alone", no._clicked === false, no._clicked);
    check("screenshot widget: answered against the question, not the option label",
      (res.filled || []).some((f) => f.key === qText), res.filled);
    check("screenshot widget: application submitted", res.ok === true && res.submitted === true, res);
    globalThis.FILLPACK.questions = savedQuestions;
  }

  /* An unknown yes/no question must be REPORTED as the question, so the same
   * widget with no bank answer produces something actionable to answer —
   * "a field it couldn't place: 'yes' (radio)" is not. */
  {
    const qText = "Do you have a valid driving licence";
    const questionP = { tagName: "P", innerText: qText, textContent: qText };
    const options = { tagName: "DIV", previousElementSibling: questionP, childNodes: [] };
    const yesLabel = { tagName: "LABEL", parentElement: options, previousElementSibling: null };
    const noLabel = { tagName: "LABEL", parentElement: options, previousElementSibling: yesLabel };
    const yes = makeInput({ type: "radio", value: "yes", label: "yes", parent: yesLabel });
    const no = makeInput({ type: "radio", value: "no", label: "no", parent: noLabel });
    yesLabel.childNodes = [yes];
    noLabel.childNodes = [no];
    options.childNodes = [yesLabel, noLabel];
    PAGE_FIELDS = [yes, no];
    PAGE_BUTTONS = [makeButton("Next", () => {})];   // never advances
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("unknown yes/no: the question is quoted, not the option label",
      (res.message || "").includes(qText), res.message);
    check("unknown yes/no: nothing was guessed", yes._clicked === false && no._clicked === false,
      [yes._clicked, no._clicked]);
  }

  /* --- 37d. the questionnaire widget from the second screenshot: an option
   *        list under the question and only a "Save" button. Save advances
   *        THIS step — it must never be read as the application's finish, or
   *        the run reports "application sent" after answering one question. --- */
  const NOTICE_Q = "What is your notice period?";
  const NOTICE_OPTS = ["15 Days or less", "1 Month", "2 Months", "3 Months",
    "More than 3 Months", "Serving Notice Period", "Skip this question"];
  function noticeWidget() {
    const questionP = { tagName: "P", innerText: NOTICE_Q, textContent: NOTICE_Q };
    const options = { tagName: "DIV", previousElementSibling: questionP, childNodes: [] };
    let prev = null;
    const rows = [];
    const radios = NOTICE_OPTS.map((lab) => {
      const row = { tagName: "LABEL", parentElement: options, previousElementSibling: prev, childNodes: [] };
      const r = makeInput({ type: "radio", name: "notice", value: lab, label: lab, parent: row });
      row.childNodes.push(r);
      prev = row;
      rows.push(row);
      return r;
    });
    options.childNodes = rows;
    return { radios };
  }

  {
    const saved = globalThis.FILLPACK.questions;
    globalThis.FILLPACK.questions = [
      { match: "notice period", answer: "2 Months", label: NOTICE_Q },
    ];
    /* The step offers Save only, then a second step with a real Submit. */
    const w = noticeWidget();
    let advanced = false;
    const saveBtn = makeButton("Save", () => {
      advanced = true;
      PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
      PAGE_BUTTONS = [makeButton("Submit Application", (el) => {
        el._clicked = true; BODY_TEXT = "Thank you for your application";
      })];
    });
    PAGE_FIELDS = w.radios;
    PAGE_BUTTONS = [saveBtn];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("Save step: the listed option that is on record was picked",
      w.radios[2]._clicked === true && w.radios.filter((r) => r._clicked).length === 1,
      w.radios.map((r) => [r.value, r._clicked]));
    check("Save step: Save advanced the step", advanced === true, advanced);
    check("Save step: answered against the question, not an option label",
      (res.filled || []).some((f) => f.key === NOTICE_Q && f.via === "option"), res.filled);
    check("Save step: finished at the real Submit", res.ok === true && res.submitted === true, res);

    /* A Save that IS a form's type=submit must not be read as the finish:
     * the old path clicked it and reported "submitted" with no confirmation. */
    const w2 = noticeWidget();
    const loneSave = makeButton("Save", () => {}, { attrs: { type: "submit" }, form: {} });
    PAGE_FIELDS = w2.radios;
    PAGE_BUTTONS = [loneSave];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("lone Save: never reported as a submitted application",
      res.submitted !== true, res);
    check("lone Save: the step did not advance, so it is reported honestly",
      res.ok === false && res.reason === "step-stuck", res);

    /* A real Submit control wins over Save when both are offered. */
    const w3 = noticeWidget();
    const save3 = makeButton("Save", () => {});
    const submit3 = makeButton("Submit Application", (el) => {
      el._clicked = true; BODY_TEXT = "Thank you for your application";
    });
    PAGE_FIELDS = w3.radios;
    PAGE_BUTTONS = [save3, submit3];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("Submit wins over Save", submit3._clicked === true && save3._clicked === false,
      [save3._clicked, submit3._clicked]);
    check("Save step: run still completes", res.ok === true && res.submitted === true, res);
    globalThis.FILLPACK.questions = saved;
  }

  /* --- 37e. the notice-period answer is a CHOICE, not free text: it is never
   *        typed into a "notice period in days" box, and when the employer
   *        offers no option that is true, "Skip this question" is clicked
   *        instead of inventing one. --- */
  {
    const saved = globalThis.FILLPACK.questions;
    const ENTRY = {
      match: "notice period", answer: "4 Weeks", choiceOnly: true,
      fallback: "Skip this question", label: NOTICE_Q,
    };

    /* The bank's answer is the CHOICE "4 Weeks"; a free-text field on the same
     * topic must get the pack field's own text instead, never the option. */
    const daysField = makeInput({ type: "text", label: "Notice period in days", name: "notice_days" });
    globalThis.FILLPACK.questions = [ENTRY];
    PAGE_FIELDS = [daysField];
    PAGE_BUTTONS = [];
    api = loadEngine();
    res = await api.run({ submit: false });
    check("choice-only: the option is never typed into a free-text field",
      String(daysField.value) !== "4 Weeks", daysField.value);
    check("choice-only: the text field got the pack's own answer",
      String(daysField.value) === globalThis.FILLPACK.work.noticePeriod, daysField.value);

    const w = noticeWidget();
    PAGE_FIELDS = w.radios;
    PAGE_BUTTONS = [makeButton("Submit Application", (el) => {
      el._clicked = true; BODY_TEXT = "Thank you for your application";
    })];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: true });
    check("fallback: answer not offered, so 'Skip this question' is chosen",
      w.radios[6]._clicked === true && w.radios.filter((r) => r._clicked).length === 1,
      w.radios.map((r) => [r.value, r._clicked]));
    check("fallback: recorded as skipped, never as an answer",
      (res.filled || []).some((f) => /skipped/.test(f.via || "")), res.filled);
    check("fallback: run still completes", res.ok === true && res.submitted === true, res);

    const w2 = noticeWidget();
    globalThis.FILLPACK.questions = [Object.assign({}, ENTRY, { fallback: null })];
    PAGE_FIELDS = w2.radios;
    PAGE_BUTTONS = [makeButton("Submit Application", (el) => { el._clicked = true; })];
    BODY_TEXT = "";
    api = loadEngine();
    res = await api.run({ submit: false });
    check("no fallback: the report lists what the page offered",
      /15 Days or less, 1 Month, 2 Months/.test(JSON.stringify(res.failed || [])), res.failed);
    check("no fallback: nothing was guessed",
      w2.radios.every((r) => r._clicked === false), w2.radios.map((r) => r._clicked));
    globalThis.FILLPACK.questions = saved;
  }

  /* --- 38. autocomplete picker: type the value, then click the exact row --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "Country/Region", name: "country_search" })];
  PAGE_BUTTONS = [];
  const rows = [makeInput({ type: "text", textContent: "India" }), makeInput({ type: "text", textContent: "Indonesia" })];
  BODY_TEXT = "";
  api = loadEngine();
  PAGE_OPTIONS = rows;
  res = await api.run({ submit: true });
  check("picker: the exact row was clicked", rows[0]._clicked === true && rows[1]._clicked === false, rows.map((r) => r._clicked));
  check("picker: value recorded as picked", res.filled.some((f) => f.key === "identity.country" && f.via === "typed+picked"), res.filled);

  /* --- 39. a near-miss row is not a match --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "Country/Region", name: "country_search" })];
  const nearMiss = makeInput({ type: "text", textContent: "India Limited" });
  PAGE_BUTTONS = [];
  api = loadEngine();
  PAGE_OPTIONS = [nearMiss];
  res = await api.run({ submit: true });
  check("near-miss: the row was never clicked", nearMiss._clicked === false, nearMiss._clicked);
  check("near-miss: still recorded as typed", res.filled.some((f) => f.key === "identity.country" && f.via === "typed"), res.filled);

  /* --- 40. a field that only says "Search": read the legend above it --- */
  const searchBox = makeInput({ type: "text", placeholder: "Search", legend: "Country/Region" });
  PAGE_FIELDS = [searchBox];
  PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; })];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("legend: the search box was identified", res.filled.some((f) => f.key === "identity.country"), res.filled);
  check("legend: filled from the pack", searchBox.value === "India", searchBox.value);
  check("legend: the run still completed", res.ok === true && res.submitted === true, res);

  /* --- 41. a refused step says what it heard, what is empty, what exists --- */
  PAGE_FIELDS = [
    makeInput({ type: "select", label: "Employment Type", name: "emp_type", options: [{ text: "--Select--", value: "" }] }),
    makeInput({ type: "text", name: "", placeholder: "Search" }),
  ];
  let dClicks = 0;
  PAGE_BUTTONS = [makeButton("Next", () => { dClicks++; })];
  BODY_TEXT = "";
  api = loadEngine();
  PAGE_ERRORS = [{ innerText: "Select language is required", textContent: "" }];   // wording ERROR_HINT misses
  res = await api.run({ submit: true });
  PAGE_ERRORS = [];
  check("diagnostic: the live region made it validation-blocked", res.reason === "validation-blocked", res);
  check("diagnostic: announced wording quoted", /the page announced "Select language is required"/.test(res.message || ""), res.message);
  check("diagnostic: still-empty field named with its options", /"Employment Type" \[emp_type\] \(select: --Select--\)/.test(res.message || ""), res.message);
  check("diagnostic: label source shown for a placeholder-only field", /"Search" \(text, placeholder\)/.test(res.message || ""), res.message);
  check("diagnostic: the controls that exist are listed", /controls here: "Next"/.test(res.message || ""), res.message);
  check("diagnostic: Next tried once", dClicks === 1, dClicks);

  /* --- 42. an unanswered pack question shows up in the stall report --- */
  PAGE_FIELDS = [makeInput({
    type: "select", label: "Select language", name: "_r_3_",
    options: [{ text: "--Select--", value: "" }, { text: "English", value: "en" }],
  })];
  PAGE_BUTTONS = [makeButton("Next", () => {})];
  api = loadEngine();
  res = await api.run({ submit: true });
  check("open question: the stall report names it", /"Select language" \[_r_3_\].*no pack answer/s.test(res.message || ""), res.message);
  check("open question: still a plain step-stuck", res.reason === "step-stuck", res);

  /* --- 43. the report must not be hijacked by screen-reader skip links.
   *        (LinkedIn's five "Skip to …" aids sit at the top of the DOM and
   *        ate every slot of the controls inventory: the halt listed nothing
   *        but skip links, hiding whether an Apply control even existed.) --- */
  PAGE_FIELDS = [];
  let openerClicks = 0;
  PAGE_BUTTONS = [
    makeButton("Skip to search"),
    makeButton("Skip to main content"),
    makeButton("Skip to primary content"),
    makeButton("Skip to aside"),
    makeButton("Skip to footer"),
    makeButton("Apply", () => { openerClicks++; }),   // clicked, but no form ever appears
  ];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("inventory: still the honest halt", res.ok === false && res.reason === "no-submit-control", res);
  check("inventory: skip links never listed", !/Skip to/.test(res.message || ""), res.message);
  check("inventory: the opener was clicked exactly once", openerClicks === 1, openerClicks);
  check("inventory: says the opener opened nothing",
    (res.message || "").includes('"Apply" was clicked, but the form it should have opened never appeared'), res.message);
  check("inventory: the real control is what the list shows",
    (res.message || "").includes('Controls seen: "Apply" (opens the application form)'), res.message);

  /* --- 44. the five slots go to the controls that matter, and an
   *        off-screen control is never "seen" --- */
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  let rankClicks = 0;
  const hiddenSubmit = makeButton("Submit application", (el) => { el._clicked = true; });
  hiddenSubmit.getBoundingClientRect = () => ({ width: 0, height: 0 });
  PAGE_BUTTONS = [
    makeButton("Skip to search"),
    makeButton("Skip to main content"),
    makeButton("Back"),
    hiddenSubmit,
    makeButton("Next", () => { rankClicks++; }),   // refuses to advance -> the stall lists controls
  ];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("rank: the refused step is what gets reported", res.reason === "step-stuck", res);
  check("rank: Next is listed first, then Back",
    (res.message || "").includes('controls here: "Next" (advances the form), "Back"'), res.message);
  check("rank: skip links stay out", !/Skip to/.test(res.message || ""), res.message);
  check("rank: an off-screen control is never listed", !/Submit application/.test(res.message || ""), res.message);
  check("rank: Next clicked once", rankClicks === 1, rankClicks);

  /* --- 45. Indeed-style landing pages: the openers it actually uses.
   *        "Easily apply" badges the hosted flow (it never matched the old
   *        opener hints — "easy apply" is not "easily apply"). --- */
  PAGE_FIELDS = [];
  let easilyClicks = 0;
  const easilyApply = makeButton("Easily apply", () => {
    easilyClicks++;
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; })];
  });
  PAGE_BUTTONS = [easilyApply];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("indeed: 'Easily apply' opened the form", easilyClicks === 1, easilyClicks);
  check("indeed: run completed after the opener", res.ok === true && res.submitted === true, res);

  /* --- 46. "Apply on company site": Indeed's path to the employer's own
   *        ATS — an opener here, just like Apply Now. --- */
  PAGE_FIELDS = [];
  let extClicks = 0;
  const extApply = makeButton("Apply on company site", () => {
    extClicks++;
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you for your application"; })];
  });
  PAGE_BUTTONS = [extApply];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("indeed: 'Apply on company site' opened the form", extClicks === 1, extClicks);
  check("indeed: run completed after the offsite opener", res.ok === true && res.submitted === true, res);

  /* --- 47. the two-hop Workday chain: Apply lands on the tenant's chooser
   *        page ("Start Your Application" / "Apply Manually"), whose OWN
   *        opener opens the real form. The opener retry is page-change-aware:
   *        the same page is never clicked twice, but a new page (href
   *        changed by the click) gets its opener too — up to three hops.
   *        (Motorola's tenant stalled here: Apply -> chooser -> dead end.) --- */
  PAGE_URL = "https://acme.wd1.myworkdayjobs.com/External/job/X";
  PAGE_FIELDS = [];
  let hop1 = 0, hop2 = 0;
  const startYourApplication = makeButton("Start Your Application", () => {
    hop2++;
    PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
    PAGE_BUTTONS = [makeButton("Submit application", (el) => { el._clicked = true; BODY_TEXT = "Thank you! Your application was submitted."; })];
  });
  const applyHop1 = makeButton("Apply", () => {
    hop1++;
    PAGE_URL = "https://acme.wd1.myworkdayjobs.com/External/job/X/apply";   // SPA route change
    PAGE_BUTTONS = [startYourApplication];
  });
  PAGE_BUTTONS = [applyHop1];
  BODY_TEXT = "";
  api = loadEngine();
  res = await api.run({ submit: true });
  check("two-hop: 'Apply' opened the chooser page", hop1 === 1, hop1);
  check("two-hop: the chooser's own opener was clicked once", hop2 === 1, hop2);
  check("two-hop: the form behind it was filled", res.filled.some((f) => f.key === "identity.firstName"), res.filled);
  check("two-hop: run completed", res.ok === true && res.submitted === true, res);
  PAGE_URL = "https://jobs.example.com/apply/123";   // restore for readability

  /* --- 48. session verification: connect trusts EVIDENCE on the board
   *        page, never the click. The verdict feeds /api/boards/:id/session,
   *        which is the only thing that connects a board. --- */
  PAGE_URL = "https://www.naukri.com/python-jobs";
  PAGE_BUTTONS = [makeButton("Sign in")];
  api = loadEngine();
  let sv = api.session();
  check("session: a Sign-in control means logged out", sv.ok === false, sv);
  check("session: verdict names the board", sv.board === "naukri", sv);
  PAGE_BUTTONS = [makeButton("Sign out")];
  sv = api.session();
  check("session: a Sign-out control means logged in", sv.ok === true, sv);
  PAGE_BUTTONS = [makeButton("Sign out"), makeInput({ type: "password" })];
  sv = api.session();
  check("session: sign-out beside a password form is ambiguous, not a guess", sv.ok === null, sv);
  PAGE_BUTTONS = [];
  sv = api.session();
  check("session: no evidence is unknown, never a claim", sv.ok === null, sv);
  PAGE_URL = "https://jobs.example.com/apply/123";   // restore for later tests

  /* --- 49. the load guard is stamped with the build, so an extension
   *        update replaces a stale engine instead of being blocked by it.
   *        (The old boolean guard meant: update the extension, click the
   *        popup, and the tab kept running the pre-update engine forever —
   *        chrome://extensions said 2.7.x while the diagnostics were older.) --- */
  delete globalThis.chrome;          // guard falls back to the "test" stamp
  let bootFetches = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/bootstrap")) bootFetches++;
    return { ok: false, json: async () => null };
  };
  PAGE_FIELDS = [makeInput({ type: "text", label: "First Name", name: "first_name" })];
  PAGE_BUTTONS = [];
  api = loadEngine();                      // fresh page: guard + agent both clear
  const engineFresh = globalThis.__JOB_AGENT__;
  check("guard: build stamp recorded", globalThis.__JOB_AGENT_LOADED__ === "test", globalThis.__JOB_AGENT_LOADED__);
  check("guard: fresh load bootstrapped", bootFetches > 0, bootFetches);

  bootFetches = 0;
  api = loadEngine({ keepGuard: true });   // same build re-injected (popup click on an up-to-date tab)
  check("guard: same-build re-injection is a no-op", globalThis.__JOB_AGENT__ === engineFresh);
  check("guard: same-build re-injection does not re-boot", bootFetches === 0, bootFetches);

  /* A pre-stamp orphan set the flag to `true` and owns the old API. */
  globalThis.__JOB_AGENT_LOADED__ = true;
  const staleRun = () => ({ stale: true });
  globalThis.__JOB_AGENT__ = { run: staleRun };
  bootFetches = 0;
  api = loadEngine({ keepGuard: true });   // popup injects the NEW files into that tab
  check("guard: stale engine object replaced", globalThis.__JOB_AGENT__ && globalThis.__JOB_AGENT__.run !== staleRun,
    globalThis.__JOB_AGENT__);
  check("guard: replacement stamped with the new build", globalThis.__JOB_AGENT_LOADED__ === "test", globalThis.__JOB_AGENT_LOADED__);
  check("guard: replacing never double-boots the autopilot", bootFetches === 0, bootFetches);
  res = await api.run({ submit: false });
  check("guard: the replacement engine answers runs", res.ok === true && res.v === "test", res);

  delete globalThis.chrome;
  globalThis.fetch = NOOP_FETCH;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
