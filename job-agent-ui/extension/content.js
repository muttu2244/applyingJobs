/* Content script — fills AND submits application forms from the fill pack.
 *
 * Contract:
 *   - run({submit:false}) types values at human pace and never submits.
 *   - run({submit:true})  fills, walks Next/Continue steps, clicks the final
 *     submit control, then verifies a confirmation appeared.
 *   - Submission requires an explicit trigger: the popup's "Fill & submit"
 *     button, or autopilot (job was approved in the local dashboard AND the
 *     autopilot toggle is on). Browsing LinkedIn normally never submits.
 *   - CAPTCHA/security checkpoints halt everything, always.
 *   - A field whose pack value is null is never guessed. If such a field is
 *     marked required, submit halts and reports it.
 *   - Pay/purchase controls are never clicked, in any mode.
 */
"use strict";

(function () {
  const PACK = globalThis.FILLPACK;
  const M = globalThis.JobAgentMatcher;
  if (!PACK || !M) return;
  /* Load guard, stamped with the manifest version. A boolean guard made
   * re-injection a no-op even when the injected build was NEWER than the one
   * live in the tab: after an extension update the old content script is
   * orphaned but still owns __JOB_AGENT__, so the popup's fresh files
   * returned immediately and every run used the stale engine — the popup
   * showed old diagnostics while chrome://extensions showed the new version.
   * Comparing build versions swaps a stale engine out; the same build still
   * short-circuits. */
  const VERSION = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version : "test";
  if (globalThis.__JOB_AGENT_LOADED__ === VERSION) return;   // this build is already live
  /* An engine object that already exists bootstrapped itself for this page
   * load; replacing it must swap the API only, never boot a second autopilot
   * over the first. */
  const REPLACING = !!globalThis.__JOB_AGENT__;
  globalThis.__JOB_AGENT_LOADED__ = VERSION;

  const DASHBOARD = "http://127.0.0.1:8357";
  const MAX_STEPS = 12;          // backstop only — a stalled step is caught below
  const SUBMIT_WAIT_MS = 12000;  // how long to look for a confirmation after submit
  const SUBMIT_LOOKUP_MS = 6000; // re-look for a late/disabled finish control this long

  /* ---------- safety gates ---------- */

  const CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[title*='reCAPTCHA' i]",
    ".g-recaptcha",
    ".h-captcha",
    "[data-hcaptcha-widget-id]",
    "[id*='captcha' i]",
    "div[class*='captcha' i]",
  ];

  /* Controls that advance a form one step. */
  const NEXT_HINT = /^(next|continue|proceed|next step|continue to .+|save and continue)$/i;
  /* A questionnaire step often offers only "Save" — it closes THIS step and
   * nothing more. It is therefore an advance control, never a finish: mistaking
   * it for Submit reports "application sent" after answering one question. */
  const SAVE_HINT = /^(save|save and (?:next|continue)|save (?:my )?(?:answers|questions))$/i;
  const tidy = (t) => String(t || "").replace(/\s+/g, " ").trim();
  /* Controls that FINISH an application. Unambiguous labels, so they are
   * trusted anywhere on a page — "submit" alone covers Submit, Submit
   * application, Submit your application, … */
  const FINAL_HINT = /\b(submit|finish|send (my |your |the )?(application|details)|complete (my |the )?application|complete and submit|review my application)\b/i;
  /* Weak finish labels — the very words a landing page's Apply control uses,
   * so they are only trusted on a page this run actually filled something on,
   * and only when no Next/Continue control is offered (see findSubmitControl). */
  const APPLY_FINAL_HINT = /^(apply|apply now|apply for this job|easy apply|i'?m interested|done|send)$/i;
  /* Controls that LOOK like a finish but are not one: a saved draft is not a
   * submitted application. */
  const NOT_FINAL = /\b(later|draft|save (and|&) (exit|close)|remind me)\b/i;
  /* Controls that OPEN an application on job/ATS landing pages — the form
   * isn't rendered yet, so these are never "final" clicks. Indeed sends
   * external listings to the employer's own ATS with "Apply on company site",
   * and badges its hosted ones "Easily apply" — both openers. */
  const OPENER_HINT = /^(apply|apply now|easy apply|easily apply|apply on company site|apply with resume|apply with my resume|start( your)? application|apply for this job|begin( your)? application)$/i;
  const OPENER_LOOSE = /\b(apply now|easy apply|easily apply|apply with (my )?resume|apply on company site)\b/i;
  /* Anything submit- or apply-shaped is off-limits for FILLING. */
  function isSubmitLike(text, textContent) {
    return FINAL_HINT.test(text) || OPENER_LOOSE.test(text) || OPENER_HINT.test(String(textContent || "").trim());
  }
  /* Never clicked in any mode — paying is not applying. */
  const PAY_HINT = /\b(pay|payment|purchase|place order|buy now|checkout|proceed to payment|credit card|billing)\b/i;
  /* Confirmation language we accept as proof the application went out. */
  const CONFIRM_HINT = /application (was |has been |is )?(successfully )?(submitted|sent|received)|thank you for (your )?application|application (is )?complete|we('ve| have) received your application/i;
  /* Validation copy a step shows when it REFUSES to advance. When a wizard
   * stalls, this is the reason, and the most useful thing to report. */
  const ERROR_HINT = /(this field is required|field is required|required field|please (fix|correct|complete|fill|enter|select|choose)|must be (at least|a valid|filled)|invalid (email|phone|number|format)|errors? (found|below)|is not valid)/i;

  /* A captcha only stops the run when a human could actually see it.
   * Lever puts hCaptcha's invisible scoring iframe in a 0-height wrapper on
   * EVERY apply page, and ATSes leave the hidden response input in the DOM
   * forever — counting either halted every Lever application before a single
   * field was touched. Walk the ancestor chain: hidden or clipped means no
   * challenge is on screen. Anything unprovable still counts (stopping is
   * the safe answer). */
  function captchaRendered(el) {
    if (!el) return false;
    try {
      /* reCAPTCHA's floating "protected by reCAPTCHA" corner badge is
       * rendered on every Greenhouse/foundit application page — it is
       * documentation, not a checkpoint. The actual challenge popup (and a
       * v2 checkbox) renders OUTSIDE the badge container, so it still halts. */
      if (el.closest && el.closest(".grecaptcha-badge")) return false;
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && (r.width === 0 || r.height === 0)) return false;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === "none") return false;
        if (cs.visibility !== "visible") return false;
        if (parseFloat(cs.opacity) === 0) return false;
        /* a zero-size box only hides its children if it actually clips */
        if (n.clientWidth === 0 && cs.overflowX !== "visible") return false;
        if (n.clientHeight === 0 && cs.overflowY !== "visible") return false;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  function captchaPresent() {
    for (const s of CAPTCHA_SELECTORS) {
      let els;
      try { els = document.querySelectorAll(s); } catch (e) { continue; }
      for (const el of els) if (captchaRendered(el)) return true;
    }
    return false;
  }

  /* ---------- consent banners ---------- */
  /* Tenants gate their own application form behind a cookie dialog — Workday's
   * Motorola tenant renders ZERO inputs until it is dismissed, so autopilot
   * would stall on every such page. Dismissing it is neither applying nor
   * paying, and "Decline" is preferred over "Accept": the agent grants
   * nothing on the user's behalf. */
  const CONSENT_SELECTORS = [        /* vendor buttons, reject before accept */
    "#onetrust-reject-all-handler",
    "[data-testid='uc-deny-all-button']",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#truste-consent-button",
    "#onetrust-accept-btn-handler",
    "[data-testid='uc-accept-all-button']",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  ];
  const CONSENT_REJECT = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|use necessary cookies( only)?|only necessary cookies)$/i;
  const CONSENT_ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?)$/i;
  /* Consent-ish = the button names cookies itself, or sits in a small
   * cookie/privacy container. The size cap keeps a body-level word "cookie"
   * from turning every button on the page into a consent control. */
  function consentish(el) {
    if (/cookie|consent|tracking/i.test(el.textContent || "")) return true;
    for (let n = el.parentElement, d = 0; n && d < 4; n = n.parentElement, d++) {
      const idcls = `${n.id || ""} ${typeof n.className === "string" ? n.className : ""}`;
      if (/cookie|consent|privacy|tracking|onetrust|trustarc|usercentrics/i.test(idcls)) return true;
      const txt = n.textContent || "";
      if (txt.length <= 1500 && /cookie|tracking|privacy choices/i.test(txt)) return true;
    }
    return false;
  }
  function dismissConsent() {
    try {
      for (const sel of CONSENT_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && visible(el) && !el.disabled) { el.click(); return true; }
      }
      const cands = [];
      for (const el of document.querySelectorAll("button, [role=button]")) {
        if (!visible(el) || el.disabled) continue;
        const t = String(el.textContent || "").trim();
        if (CONSENT_REJECT.test(t) || CONSENT_ACCEPT.test(t)) cands.push(el);
      }
      const pick = cands.find((el) => CONSENT_REJECT.test(String(el.textContent || "").trim()) && consentish(el))
        || cands.find(consentish);
      if (pick) { pick.click(); return true; }
    } catch (e) { /* consent handling must never sink a run */ }
    return false;
  }

  const CLICKABLE = "button, [role=button], input[type=submit], input[type=button], a[class*='btn' i], a[class*='button' i], button[class*='btn' i]";
  /* The finish-control search looks one step wider — plenty of ATS footers are
   * divs and spans styled as buttons. Only the submit search uses this, so the
   * wizard's progress markers stay as quiet as before. */
  const CLICKABLE_WIDE = CLICKABLE + ", [class*='btn' i], [class*='button' i], [class*='submit' i]";

  function controlText(el) {
    /* textContent and innerText are the SAME string on every rendered element —
     * joining both silently turns "Apply" into "Apply Apply", which no anchored
     * hint (^apply$, ^next$) can ever match. That bug hid for as long as the
     * tests used fakes that set only one of the two; real pages set both. */
    return [...new Set([
      el.value, el.textContent, el.innerText,
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("name"),
    ].filter(Boolean))].join(" ").trim();
  }

  /* Anything that would send or open the application — off-limits for FILLING. */
  function wouldSubmit(el) {
    const t = [
      el.value, el.name, el.id, el.getAttribute("aria-label"),
      el.className, el.textContent,
    ].join(" ");
    return el.type === "submit" || isSubmitLike(t, el.textContent);
  }

  /* ---------- field discovery ---------- */

  const FILLABLE = "input, textarea, select";
  const SKIP_TYPES = new Set(["hidden", "file", "password", "submit", "button", "image", "reset"]);

  function labelFor(el) {
    if (el.labels && el.labels.length) {
      return [...el.labels].map((l) => l.innerText).join(" ").trim();
    }
    const wrapping = el.closest("label");
    if (wrapping) return wrapping.innerText.trim();
    const aria = el.getAttribute("aria-labelledby");
    if (aria) {
      const txt = aria.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (txt.trim()) return txt.trim();
    }
    return el.getAttribute("aria-label") || "";
  }

  const CONTROL_TAGS = /^(INPUT|SELECT|TEXTAREA|BUTTON)$/;

  /* Question text that was never wired to the input. Legacy ATS layouts put it
   * in the NEXT CELL of a table, or in the text just above the field, and give
   * the input nothing but a machine name ("_r_3_"). Without this, such a field
   * is unfillable AND unreportable — the report can only say "_r_3_". */
  function nearbyLabelFor(el) {
    const usable = (t) => t && t.length <= 80 && t !== clean(el.placeholder) && t !== clean(el.value);

    const sib = el.previousElementSibling;                 // <span>Select language</span><select>
    if (sib && !CONTROL_TAGS.test(sib.tagName || "")) {
      const t = clean(sib.innerText || sib.textContent);
      if (usable(t)) return t;
    }

    const parent = el.parentElement;
    const cell = parent && parent.previousElementSibling;  // <td>Select language</td><td><select></td>
    if (cell) {
      const t = clean(cell.innerText || cell.textContent);
      if (usable(t)) return t;
    }

    /* Whatever text precedes the control inside its own container. */
    if (parent && parent.childNodes) {
      let before = "";
      for (const node of parent.childNodes) {
        if (node === el || (node.contains && node.contains(el))) break;
        before += " " + (node.textContent || "");
      }
      const t = clean(before);
      if (usable(t)) return t;
    }

    /* The input describing itself: aria-describedby points straight at the
     * question on some frameworks. */
    const desc = (el.getAttribute && el.getAttribute("aria-describedby")) || "";
    if (desc) {
      const t = clean(desc.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
      if (usable(t)) return t;
    }

    /* Under a legend, or under a section heading: comboboxes (a field that
     * only says "Search") carry the question above rather than beside them. */
    const group = el.closest && el.closest("fieldset, [role=group]");
    const legend = group && group.legend && clean(group.legend.innerText);
    if (legend && usable(legend)) return legend;

    let up = el.parentElement;
    for (let i = 0; up && i < 4; i++, up = up.parentElement) {
      const head = up.firstElementChild;
      if (!head || head === el) continue;
      const tag = (head.tagName || "").toUpperCase();
      if (/^H[1-6]$/.test(tag) || tag === "LEGEND" ||
          (head.getAttribute && head.getAttribute("role") === "heading")) {
        const t = clean(head.innerText || head.textContent);
        if (usable(t)) return t;
      }
    }
    return "";
  }

  /* How a passed-over field is named in a halt report: the question text if we
   * can find any, WHERE that text came from when it is not a real label (so a
   * placeholder reading "Search" is not mistaken for the question), the machine
   * name so it can be located in the page source, the control type, and — for a
   * select — the options it offered. */
  function describeField(cand, el) {
    const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
    /* For a yes/no pair the option's own text is just "yes": quote the
     * question instead, so a screening question the pack has no answer for
     * is reported as the question, not as an unplaceable "yes" radio. */
    const label = cand.groupQuestion || cand.label || cand.nearby || cand.placeholder || cand.name || cand.id || "unnamed field";
    const name = cand.name && cand.name !== label ? ` [${cand.name}]` : "";
    const tag = (el && el.tagName) || "";
    const type = tag === "SELECT" ? "select" : ((el && el.type) || "text");
    const role = el && el.getAttribute ? clean(el.getAttribute("role")) : "";
    const from = cand.groupQuestion ? ", question above the options"
      : cand.label ? "" : cand.nearby ? ", nearby text" : cand.placeholder ? ", placeholder" : "";
    const hint = (role && role !== "presentation") ? `, ${role}` : "";
    const blank = el && el.required && !clean(el.value) ? ", required" : "";
    const opts = tag === "SELECT" && el.options
      ? [...el.options].map((o) => clean(o.text)).filter(Boolean).slice(0, 6).join(", ")
      : (el.type === "radio" || el.type === "checkbox")
        /* A yes/no or option-list question: the choices are the most useful
         * thing a report can carry — they say what the page accepts. */
        ? optionGroup(el).map((o) => clean(labelFor(o))).filter(Boolean).slice(0, 8).join(", ")
        : "";
    return `"${clip(label, 40)}"${name} (${type}${from}${hint}${blank}${opts ? `: ${clip(opts, 60)}` : ""})`;
  }
  function clean(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

  /* Native HTML validation refuses to advance a wizard WITHOUT printing an
   * error node — the browser shows a tooltip and the step simply sits there.
   * That silently-blocked case is the most common reason a Next click "does
   * nothing", so name the exact controls the page is rejecting. */
  function invalidFields(skip) {
    const out = [];
    for (const el of document.querySelectorAll(FILLABLE)) {
      if (skip && skip.has(el)) continue;      // already reported by key
      if (el.willValidate === false) continue;
      if (!visible(el)) continue;
      const bad = el.checkValidity ? !el.checkValidity() : !!(el.validity && el.validity.valid === false);
      if (!bad) continue;
      const v = el.validity || {};
      const why = v.valueMissing ? "required, still empty"
        : v.typeMismatch ? "not a valid value"
          : v.patternMismatch ? "does not match the format the page expects"
            : v.tooShort ? "too short"
              : v.badInput ? "not a number"
                : "rejected by the page's own validation";
      out.push(`${describeField({ label: labelFor(el), nearby: nearbyLabelFor(el), placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "", name: el.name, id: el.id }, el)} — ${why}`);
      if (out.length >= 4) break;
    }
    return out;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
  }

  function candidates() {
    return [...document.querySelectorAll(FILLABLE)].filter((el) => {
      if (SKIP_TYPES.has(el.type)) return false;
      if (!visible(el)) return false;
      if (wouldSubmit(el)) return false;
      return true;
    });
  }

  /* A control we may CLICK. A text input whose value reads "Apply Now" is
   * styled to look like a button but is not one, and clicking it can re-trigger
   * the whole apply flow — only real controls qualify. */
  function clickTarget(el) {
    if ((el.tagName || "").toUpperCase() !== "INPUT") return true;   // button / a / [role=button] / div
    return el.type === "submit" || el.type === "button" || el.type === "image";
  }

  /* Every visible, enabled candidate control, minus pay controls. Paying is
   * never applying, in any mode, so those are dropped before any hint sees
   * them. */
  function visibleControls(selector) {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (el.disabled) continue;
      if (!visible(el)) continue;
      if (!clickTarget(el)) continue;
      const t = controlText(el);
      if (!t) continue;
      if (PAY_HINT.test(t)) continue;
      out.push(el);
    }
    return out;
  }

  function matchControls(hints, selector) {
    return visibleControls(selector).filter((el) => hints.some((h) => h.test(controlText(el))));
  }

  /* Find the visible, enabled control whose text matches any of `hints`. */
  function findControl(...hints) {
    return matchControls(hints, CLICKABLE)[0] || null;
  }

  /* A board's pagination "Next" is not a form Next. On a job-search page the
   * wizard used to click it, land on the next PAGE of results, and then report
   * "clicking Next did not advance the form" for a form that never existed
   * (seen live on Naukri: "Search jobs here", keyword/experience/location
   * boxes, and pagination as the only Next). */
  function isPagerControl(el) {
    if (!el) return false;
    try {
      if (String((el.getAttribute && el.getAttribute("rel")) || "").toLowerCase() === "next") return true;
      if (el.closest && el.closest("[class*='pagination' i], [class*='pager' i], nav[aria-label*='agination' i]")) return true;
    } catch { /* fake nodes in tests */ }
    return false;
  }

  /* The form's Next: same hints, pagination excluded. */
  function findFormNext() {
    const explicit = matchControls([NEXT_HINT], CLICKABLE).find((el) => !isPagerControl(el));
    if (explicit) return explicit;
    /* No Next, but the step offers a Save: click Save — UNLESS the page also
     * carries a real finish control, in which case that Submit is the one that
     * ends the application and Save must not compete with it. */
    if (matchControls([FINAL_HINT], CLICKABLE_WIDE).length) return null;
    return matchControls([SAVE_HINT], CLICKABLE).find((el) => !isPagerControl(el)) || null;
  }

  /* Openers get their own, wider selector: on Workday (and Greenhouse/Lever
   * job pages) the only Apply control is a bare <a href="…/apply"> with no
   * button class — invisible to CLICKABLE, which made autopilot report "no
   * opener" on a page whose whole purpose is Apply. An href that IS the
   * application route is as strong as a button class; the hint text still has
   * to match, so random anchors never qualify. */
  const OPENER_SELECTABLE = CLICKABLE + ", a[href*='/apply' i], a[href*='/application' i]";
  function findOpener() {
    return matchControls([OPENER_HINT, OPENER_LOOSE], OPENER_SELECTABLE)[0] || null;
  }

  /* Is this control the FORM's own submit button? HTML semantics, not text:
   * an <input type=submit> always is; a <button> with no explicit type that
   * lives in a <form> submits that form by definition. This is what catches
   * localized and icon-only footers ("Absenden", "Envoyer"), where no English
   * label exists to match. */
  function isFormSubmit(el) {
    if ((el.tagName || "").toUpperCase() === "INPUT") return el.type === "submit" || el.type === "image";
    if ((el.tagName || "").toUpperCase() !== "BUTTON") return false;
    const explicit = ((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    if (explicit) return explicit === "submit";
    return !!(el.form || (el.closest && el.closest("form")));
  }

  /* The control that FINISHES the application, in order of confidence:
   *   1. an unambiguous finish LABEL (Submit / Finish / Send my details …);
   *   2. on a page this run filled something on, with no Next control offered,
   *      an apply-shaped label — on a one-page form Apply IS the submission;
   *   3. on that same kind of page, the form's own submit button.
   * A label longer than a button's is a wrapper div that merely CONTAINS the
   * word Submit; clicking it sends nothing, so only short labels qualify. */
  function findSubmitControl(opts) {
    const filled = !!(opts && opts.filled);
    const hasNext = !!(opts && opts.hasNext);
    const pick = (els) => {
      const fit = els.filter((el) => !NOT_FINAL.test(controlText(el)));
      const short = fit.filter((el) => controlText(el).length <= 48);
      return short.sort((a, b) => controlText(a).length - controlText(b).length)[0] || null;
    };

    const strong = pick(matchControls([FINAL_HINT], CLICKABLE_WIDE));
    if (strong) return strong;
    if (!filled || hasNext) return null;

    const loose = pick(matchControls([APPLY_FINAL_HINT], CLICKABLE_WIDE));
    if (loose) return loose;

    const formSubs = visibleControls(CLICKABLE_WIDE)
      .filter(isFormSubmit)
      .filter((el) => !NOT_FINAL.test(controlText(el)))
      /* A bare "Save" that happens to be a <button type=submit> submits the
       * QUESTIONNAIRE modal, not the application — it never counts as finish. */
      .filter((el) => !SAVE_HINT.test(tidy(controlText(el))));
    if (formSubs.length === 1) return formSubs[0];
    /* Several submit buttons on one page — only take one that names itself. */
    const named = formSubs.filter((el) => /submit|send|finish|apply|complete/i.test(controlText(el)));
    if (named.length === 1) return named[0];
    return null;
  }

  /* Async-validation ATSes enable Submit only after their own check settles,
   * and some render the footer late. Looking exactly once, instantly, is what
   * produced "the layout isn't recognized" on forms that submit fine. */
  async function waitForSubmit(opts) {
    const t0 = Date.now();
    for (;;) {
      const el = findSubmitControl(opts);
      if (el) return el;
      if (Date.now() - t0 >= SUBMIT_LOOKUP_MS) return null;
      await sleep(400);
    }
  }

  /* Plain-language inventory of what IS on the page. "Layout isn't
   * recognized" is only actionable if the report says what it actually saw.
   * Screen-reader skip links are not controls anyone can finish an
   * application with, and they sit at the TOP of the DOM — on LinkedIn the
   * five "Skip to …" aids consumed every slot before the first real button,
   * so the report listed nothing useful. Off-screen controls (zero-size box)
   * are equally unactionable. The five slots go to what could finish,
   * advance or open the form, then everything else in DOM order. */
  function describeControls() {
    const rows = [];
    for (const el of document.querySelectorAll(CLICKABLE_WIDE)) {
      const box = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      if (!(box.width > 0 && box.height > 0)) continue;    // nothing a user could click
      const t = controlText(el).replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (/^skip to\b/i.test(t)) continue;                 // accessibility aid, not an application control
      const label = t.length > 34 ? t.slice(0, 34) + "…" : t;
      const why = el.disabled
        ? "disabled"
        : PAY_HINT.test(t)
          ? "pay control, never clicked"
          : NEXT_HINT.test(t)
            ? "advances the form"
            : (OPENER_HINT.test(t) || OPENER_LOOSE.test(t))
              ? "opens the application form"
              : SAVE_HINT.test(t) ? "advances this step"
                : NOT_FINAL.test(t) ? "saves a draft" : "";
      const s = why ? `"${label}" (${why})` : `"${label}"`;
      if (!rows.some((r) => r.s === s)) rows.push({ s, rank: inventoryRank(t) });
    }
    return rows.sort((a, b) => a.rank - b.rank).slice(0, 5).map((r) => r.s);
  }
  /* What earns one of the five slots: the control that finishes the form
   * first, then the one that advances it, then the one that opens it. */
  function inventoryRank(t) {
    return FINAL_HINT.test(t) ? 0 : (NEXT_HINT.test(t) || SAVE_HINT.test(t)) ? 1 :
      (OPENER_HINT.test(t) || OPENER_LOOSE.test(t)) ? 2 : 3;
  }

  /* ---------- value application ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => base + Math.random() * base * 0.6;

  /* React and several ATS frameworks ignore a plain .value assignment — they
   * track the value through their own setter. Going through the prototype
   * descriptor and re-dispatching input/change is what makes the value stick
   * and reach framework state. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* Type character by character — a value that appears instantly is the
   * clearest automation tell there is. */
  async function typeInto(el, value) {
    el.focus();
    await sleep(jitter(120));
    setNativeValue(el, "");
    let acc = "";
    for (const ch of String(value)) {
      acc += ch;
      setNativeValue(el, acc);
      await sleep(jitter(38));
    }
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(jitter(90));
  }

  function chooseSelect(el, value) {
    const want = M.norm(value);
    const opts = [...el.options];
    let opt = opts.find((o) => M.norm(o.text) === want);
    if (!opt) opt = opts.find((o) => o.text && want && M.norm(o.text).includes(want));
    if (!opt) opt = opts.find((o) => o.text && want && want.includes(M.norm(o.text)));
    if (!opt) return false;
    setNativeValue(el, opt.value);
    return true;
  }

  /* Which radios/checkboxes answer the SAME question. Named groups are easy;
   * custom React widgets often ship nameless radios, so fall back to the
   * closest container that holds more than one of them — never to "every radio
   * on the page", which would answer a neighbouring question too. */
  function optionGroup(el) {
    if (el.type !== "radio" && el.type !== "checkbox") return [el];
    const all = [...document.querySelectorAll("input[type=radio], input[type=checkbox]")]
      .filter((r) => r.type === el.type && !r.disabled);
    if (!all.length) return [el];
    if (el.name) {
      const named = all.filter((r) => r.name === el.name);
      if (named.length) return named;
    }
    const parent = el.parentElement;
    const same = all.filter((r) => r.parentElement && r.parentElement === parent);
    if (same.length > 1) return same;
    const grand = parent && parent.parentElement;
    const near = all.filter((r) => r.parentElement && grand &&
      (r.parentElement.parentElement === grand));
    if (near.length > 1) return near;
    return [el];
  }

  /* The QUESTION a yes/no pair answers. Custom blocks print the wording in a
   * plain <p>/<div> above the pills, wired to nothing: the option labels
   * ("yes", "no") say nothing about WHICH question is being asked, so without
   * this the pack's question bank can never recognise it. */
  function groupQuestionFor(el) {
    if (el.type !== "radio" && el.type !== "checkbox") return "";
    const opts = new Set(optionGroup(el).map((o) => M.norm(labelFor(o))).filter(Boolean));
    const looksLikeQuestion = (t) => {
      if (!t || t.length < 12 || t.length > 220) return false;
      if (/\?/.test(t)) return true;
      /* No question mark: accept a question opener, or a label-style prompt.
       * Anything else is page copy, not the question. */
      return /^(do|does|are|is|have|has|had|did|will|would|can|could|may|should|shall|what|how|when|where|why|which|since|mention|please|total|current|expected|enter|select|your|years?|notice)\b/i.test(t.trim());
    };
    let up = el.parentElement;
    for (let i = 0; up && i < 6; i++, up = up.parentElement) {
      /* Wording in the block immediately above the options. */
      let sib = up.previousElementSibling;
      for (let k = 0; sib && k < 2; k++, sib = sib.previousElementSibling) {
        const t = clean(sib.innerText ?? sib.textContent);
        if (looksLikeQuestion(t) && !opts.has(M.norm(t))) return t;
      }
      /* Wording inside this container, above the options themselves. */
      for (const kid of (up.childNodes || up.children || [])) {
        if (kid === el || (kid.contains && kid.contains(el))) break;
        const t = clean(kid.innerText ?? kid.textContent);
        if (looksLikeQuestion(t) && !opts.has(M.norm(t))) return t;
      }
    }
    return "";
  }

  /* The choices a control offers, in plain text — what a failed match reports. */
  function optionLabels(el) {
    if (!el) return "";
    if (el.tagName === "SELECT" && el.options) {
      return [...el.options].map((o) => clean(o.text)).filter(Boolean).slice(0, 8).join(", ");
    }
    return optionGroup(el).map((o) => clean(labelFor(o))).filter(Boolean).slice(0, 8).join(", ") || "(none readable)";
  }

  /* Radio/checkbox groups: match the option's own label text to the answer. */
  function chooseOption(group, want) {
    const wantN = M.norm(want);
    const isBool = /^(yes|no|true|false)$/i.test(String(want));
    const yesNo = /^(yes|y|true)$/i.test(String(want)) ? "yes" : /^(no|n|false)$/i.test(String(want)) ? "no" : null;
    const radios = optionGroup(group);
    const scored = radios.map((r) => {
      const lab = M.norm(labelFor(r));
      const val = M.norm(r.value);
      let s = 0;
      if (isBool && yesNo) {
        if (lab === yesNo || val === yesNo) s = 100;
        else if (lab.startsWith(yesNo) || val.startsWith(yesNo)) s = 80;
      } else {
        if (lab === wantN || val === wantN) s = 100;
        else if (lab && wantN && (lab.includes(wantN) || wantN.includes(lab))) s = 70;
      }
      return { r, s };
    }).sort((a, b) => b.s - a.s);
    if (!scored.length || scored[0].s < 70) return false;
    scored[0].r.click();
    return true;
  }

  /* ---------- the plan ---------- */

  function buildPlan() {
    const seen = new Set();
    const plan = { fields: [], open: [], unmatched: [], skipped: [] };

    for (const el of candidates()) {
      const cand = {
        label: labelFor(el),
        ariaLabel: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        nearby: nearbyLabelFor(el),          // question text not wired to the input
        groupQuestion: groupQuestionFor(el), // wording above a yes/no pair
        name: el.name || "",
        id: el.id || "",
      };
      /* The pack's own question bank wins: it exists for the free-text
       * screening questions no rule table can enumerate ("Do you have form 16
       * and P/F A/c of current & previous company"). A null answer is an
       * open question — reported by its readable label, never guessed. */
      const q = M.matchQuestion ? M.matchQuestion(cand, PACK.questions) : null;
      if (q && q.score >= 3) {
        const label = q.entry.label || q.entry.match;
        if (q.entry.answer === null || q.entry.answer === undefined) {
          plan.open.push({ el, cand, key: label });
          continue;
        }
        /* A yes/no answer only fits a yes/no control. Typing "true" into a
         * "PF number" box would be worse than leaving it — so a boolean
         * answer on a free-text field is not used at all. */
        const choice = el.type === "radio" || el.type === "checkbox" ||
          String(el.tagName || "").toUpperCase() === "SELECT";
        if (typeof q.entry.answer === "boolean" && !choice) {
          plan.unmatched.push({ el, cand });
          continue;
        }
        /* An answer that is a CHOICE ("2 Months", "Skip this question") only
         * fits a choice control. A free-text field about the same topic is
         * answered from the pack field instead — the bank entry governs the
         * option list, not the text box. */
        if (q.entry.choiceOnly && !choice) {
          const tm = M.matchField(cand);
          const tv = tm && M.valueFor(PACK, tm.key);
          if (tv === null) { plan.open.push({ el, cand, key: tm.key }); continue; }
          if (tv !== undefined && !seen.has(tm.key)) {
            seen.add(tm.key);
            plan.fields.push({ el, cand, key: tm.key, value: tv, score: tm.score });
          }
          continue;
        }
        const qKey = `questions[${q.index}]`;
        if (seen.has(qKey)) continue;
        seen.add(qKey);
        plan.fields.push({ el, cand, key: label, value: q.entry.answer, score: 100, fallback: q.entry.fallback || null });
        continue;
      }

      const m = M.matchField(cand);
      if (!m) { plan.unmatched.push({ el, cand }); continue; }

      const value = M.valueFor(PACK, m.key);
      if (value === undefined) continue;          // key not in pack — leave alone
      if (value === null) { plan.open.push({ el, cand, key: m.key }); continue; }
      if (seen.has(m.key)) continue;              // don't fill the same key twice
      seen.add(m.key);
      plan.fields.push({ el, cand, key: m.key, value, score: m.score });
    }
    return plan;
  }

  /* Fill every field of the CURRENT step. Shared by both modes. */
  async function fillStep(acc) {
    const plan = buildPlan();
    for (const f of plan.fields) {
      try {
        const el = f.el;
        if (el instanceof HTMLSelectElement) {
          if (chooseSelect(el, f.value)) acc.done.push({ key: f.key, via: "select" });
          else if (f.fallback && chooseSelect(el, f.fallback)) {
            acc.done.push({ key: f.key, via: "select: skipped, answer not offered" });
          } else acc.failed.push({ key: f.key, reason: `no matching option — offered: ${optionLabels(el)}` });
        } else if (el.type === "radio" || el.type === "checkbox") {
          if (chooseOption(el, f.value)) acc.done.push({ key: f.key, via: "option" });
          else if (f.fallback && chooseOption(el, f.fallback)) {
            /* The employer offers no option that is true for you: skipping the
             * question beats inventing an answer. Recorded, not silent. */
            acc.done.push({ key: f.key, via: "option: skipped, answer not offered" });
          } else acc.failed.push({ key: f.key, reason: `no matching option — offered: ${optionLabels(el)}` });
        } else {
          await typeInto(el, f.value);
          const picked = await pickFromList(f.value);
          acc.done.push({ key: f.key, via: picked ? "typed+picked" : "typed" });
        }
        await sleep(jitter(160));
      } catch (e) {
        acc.failed.push({ key: f.key, reason: String(e && e.message || e) });
      }
    }
    for (const o of plan.open) if (!acc.open.includes(o.key)) acc.open.push(o.key);
    return plan;
  }

  /* Wait for the wizard to advance: the DOM must change after Next/Submit. */
  async function waitForChange(marker) {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const now = document.querySelectorAll(FILLABLE).length + "|" +
        [...document.querySelectorAll(CLICKABLE)].map(controlText).join(",");
      if (now !== marker) return true;
      await sleep(150);
    }
    return false;
  }

  /* Everything that says "this step moved on": which fields are visible and
   * what they hold, plus which controls are offered. Field IDENTITY, not just
   * the count — many wizards swap one input for another on the next step, and
   * a count-only marker would read that as no change. */
  function pageMarker() {
    return fieldSignature() + "||" +
      [...document.querySelectorAll(CLICKABLE)].map(controlText).join(",");
  }

  /* Signature of the visible fillable fields AND their current values.
   * Compared across a Next click: two identical signatures mean the form did
   * NOT move forward, so clicking Next again would just repeat itself. */
  function fieldSignature() {
    return [...document.querySelectorAll(FILLABLE)]
      .filter(visible)
      .map((el) => [labelFor(el), el.name, el.id, el.type, el.value].join("~").replace(/\s+/g, " "))
      .join("|");
  }

  /* On-page validation messages, up to three, deduped and clipped. */
  function pageErrors() {
    const out = [];
    const nodes = document.querySelectorAll(
      "[role=alert], [class*='error' i], [class*='invalid' i], [id*='error' i], [data-error]"
    );
    for (const el of nodes) {
      const t = ((el.innerText || el.textContent || "") + "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 140 || !ERROR_HINT.test(t)) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= 3) break;
    }
    return out;
  }

  function detectConfirmation() {
    const body = (document.body && (document.body.innerText || "")) || "";
    const m = body.match(CONFIRM_HINT);
    return m ? m[0].slice(0, 160) : null;
  }

  /* Live regions: some frameworks announce a refusal ONLY to a screen reader
   * (role=alert / aria-live), with no error class and wording that never
   * matches ERROR_HINT — "Select language is required", for instance. A live
   * region is an error channel by definition, so this one takes the text as it
   * stands. Used when pageErrors() found nothing. */
  function pageAlerts() {
    const out = [];
    for (const el of document.querySelectorAll("[role=alert], [aria-live]")) {
      if (el.getAttribute && (el.getAttribute("aria-live") === "off" || el.getAttribute("aria-hidden") === "true")) continue;
      const t = clean(el.innerText || el.textContent || "");
      if (!t || t.length > 160) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= 3) break;
    }
    return out;
  }

  /* An autocomplete picker: we type the value, the site renders a list, and
   * the selection lives in the row we click rather than in the input. ONLY an
   * exact normalised match of the value we meant is clicked — a near-miss
   * would answer a question we did not ask — and if no list appears the cost
   * is one query, not a wait. */
  const LISTBOX = "[role=option], [role=listbox] li, [class*='dropdown' i] li, [class*='suggestion' i] li, [class*='autocomplete' i] li";

  async function pickFromList(value) {
    const want = M.norm(value);
    if (!want) return false;
    const rowsNow = () => [...document.querySelectorAll(LISTBOX)].filter(visible);
    if (!rowsNow().length) {
      /* The list renders off the input event — give it one beat, then stop. */
      await sleep(150);
      if (!rowsNow().length) return false;
    }
    const t0 = Date.now();
    for (;;) {
      for (const row of rowsNow()) {
        if (M.norm(clean(row.innerText || row.textContent)) === want) {
          row.click();
          return true;
        }
      }
      if (Date.now() - t0 >= 1200) return false;
      await sleep(200);
    }
  }

  /* ---------- execution ---------- */

  /* Is this a board's search/results page rather than an application? A page
   * with keyword/location/experience boxes, no identity fields and no Apply
   * control is a listing page: the wizard must refuse instead of typing into
   * the search box and pressing pagination. */
  const SEARCH_FIELD_HINT = /keyword|designation|compan(y|ies)|search jobs|enter location|select experience|^skills?$/i;
  const IDENTITY_FIELD_HINT = /first ?name|last ?name|full ?name|e-?mail|phone|mobile|resume|cv|cover ?letter|address|linkedin/i;

  function looksLikeJobSearch() {
    let fields = [];
    try { fields = [...document.querySelectorAll(FILLABLE)].filter((el) => visible(el)); } catch { return false; }
    if (!fields.length) return false;
    const textOf = (el) => [labelFor(el), nearbyLabelFor(el),
      (el.getAttribute && el.getAttribute("placeholder")) || "",
      el.name || "", el.id || "", String(el.type || "")].join(" ");
    if (fields.some((el) => IDENTITY_FIELD_HINT.test(textOf(el)))) return false;
    if (!fields.some((el) => String(el.type || "").toLowerCase() === "search" || SEARCH_FIELD_HINT.test(textOf(el)))) return false;
    const route = (location.pathname || "") + (location.search || "");
    /* A job DETAIL page is where applying happens — even if it carries a
     * search bar or an "Easy Apply" control in a card beside it. */
    if (/job-listings|\/jobs\/view\/|\/viewjob|jk=|\/job\/|-jd-|\/jobs\/\d/i.test(route)) return false;
    let jobLinks = 0;
    try {
      jobLinks = [...document.querySelectorAll("a[href]")]
        .filter((a) => /job-listings|\/jobs\/view\/|\/viewjob|jk=|\/job\//i.test(a.getAttribute("href") || "")).length;
    } catch { /* fake nodes */ }
    /* Result lists: whatever buttons sit on the cards (LinkedIn's "Easy
     * Apply" included), the page itself is not an application. */
    return jobLinks >= 3 || /-jobs(\/|$|\?)|jobs-in-|\/search\b|\/jobsearch\b|\/jobs(\/|$|\?)/i.test(route);
  }

  async function run(opts) {
    const wantSubmit = !!(opts && opts.submit);

    if (dismissConsent()) await sleep(jitter(700));   // cookie wall: no form until it unmounts

    if (captchaPresent()) {
      return { ok: false, reason: "captcha", message: "CAPTCHA/security checkpoint detected — stopping. Solve it yourself, then run again." };
    }

    if (looksLikeJobSearch()) {
      return {
        ok: false, reason: "not-an-application",
        filled: [], failed: [], openQuestions: [],
        message: "This is a job search/results page, not an application form — nothing was clicked. " +
          "Open a specific job first (the job cards in the dashboard and the popup link to it), " +
          "or use Fetch all jobs to collect the listings.",
      };
    }

    const acc = { done: [], failed: [], open: [] };
    let lastPlan = null;
    let openedForm = false;
    let openedHref = "";   // where the last opener click happened — a CHANGED
                           // href means we're on a new page (Workday's chooser:
                           // Apply -> "Start Your Application") that may offer
                           // the next opener; the same page is never clicked twice
    let openerClicks = 0;  // hard cap: three hops is a chain, more is a loop
    let openerLabel = "";   // what we clicked to open the form — quoted if it opened nothing

    for (let step = 0; step < MAX_STEPS; step++) {
      /* A consent wall can mount AFTER the run started — most CMPs load
       * late — and a form rendered behind it shows zero inputs, which reads
       * as "nothing to fill". Cheap no-op when the banner is already gone. */
      dismissConsent();
      lastPlan = await fillStep(acc);

      if (!wantSubmit) {
        return {
          ok: true,
          filled: acc.done,
          failed: acc.failed,
          openQuestions: acc.open,
          submitted: false,
          note: "Filled only — nothing was submitted.",
        };
      }

      /* Landing pages (LinkedIn job view, ATS overview) have no form yet —
       * just an Apply / Easy Apply control. Open it once so the wizard below
       * can fill the real form. If that click navigates to another origin
       * (external ATS), this script dies with the page; maybeResume() picks
       * the run up on the far side. */
      const nothingToFill = lastPlan.fields.length === 0 && lastPlan.open.length === 0;
      if (nothingToFill && openerClicks < 3 && (!openedForm || location.href !== openedHref)) {
        const opener = findOpener();
        if (opener) {
          openedForm = true;
          openerClicks++;
          openerLabel = clean(controlText(opener)).slice(0, 34);
          const marker = pageMarker();
          openedHref = location.href;
          opener.click();
          await sleep(jitter(900));
          await waitForChange(marker);
          await sleep(jitter(600));
          dismissConsent();         // the form side may sit behind its own banner
          continue;                                 // form (or modal) should now be open
        }
      }

      /* Submit path. A required field we can't answer blocks submission —
       * clicking through it would send a broken application. */
      const blocking = lastPlan.open.filter((o) => o.el && o.el.required);
      if (blocking.length) {
        /* A wizard can refuse on a field the pack can answer AND on one it
         * cannot even name. Report both in one message so a single edit to the
         * pack moves the application forward. */
        const also = invalidFields(new Set(blocking.map((b) => b.el)));
        return {
          ok: false,
          reason: "required-missing",
          filled: acc.done,
          failed: acc.failed,
          openQuestions: acc.open,
          message: `Cannot submit: required field(s) unanswered — ${blocking.map((b) => b.key).join(", ")}.` +
            (also.length ? ` Also blocking: ${also.join(", ")}.` : "") +
            ` Answer them, then run again.`,
        };
      }

      if (captchaPresent()) {
        return { ok: false, reason: "captcha", filled: acc.done, failed: acc.failed, openQuestions: acc.open,
          message: "A CAPTCHA appeared mid-form — stopping. Solve it yourself, then run again." };
      }

      const nextBtn = findFormNext();
      const submitLookup = { filled: acc.done.length > 0, hasNext: !!nextBtn };
      let submitBtn = findSubmitControl(submitLookup);

      /* A review step shows no fields but often keeps a Next/Continue control
       * beside Submit. Having already filled something, prefer Submit —
       * clicking Next there walks past the finish line. */
      const preferSubmit = !!submitBtn && !!nextBtn && nothingToFill && acc.done.length > 0;

      if (nextBtn && !preferSubmit) {
        const before = pageMarker();
        const ctrl = controlText(nextBtn).replace(/\s+/g, " ").trim();
        nextBtn.click();
        await sleep(jitter(700));
        await waitForChange(before);
        await sleep(jitter(400));

        /* The click changed nothing — the step is refusing to advance, almost
         * always over an unanswered or invalid field. Report WHY instead of
         * clicking the same control until the step budget runs out. */
        if (pageMarker() === before) {
          const errs = pageErrors();
          const alerts = errs.length ? [] : pageAlerts();
          const invalid = invalidFields();
          const quoted = (xs) => xs.map((e) => `"${e}"`).join(" / ");
          const cand = (el) => ({
            label: labelFor(el), nearby: nearbyLabelFor(el),
            /* A yes/no pair must be reported as the QUESTION above it — "yes"
             * tells the user nothing about what is being asked. */
            groupQuestion: groupQuestionFor(el),
            placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",
            name: el.name, id: el.id,
          });
          const unmatchedEls = new Set(lastPlan.unmatched.map((u) => u.el));
          const stillEmpty = [...new Set([...document.querySelectorAll(FILLABLE)]
            .filter((el) => {
              if (!visible(el) || clean(el.value)) return false;
              if (unmatchedEls.has(el)) return false;          // reported below instead
              const bad = el.checkValidity ? !el.checkValidity() : !!(el.validity && el.validity.valid === false);
              return !bad;                                     // already reported above
            })
            .map((el) => {
              const d = describeField(cand(el), el);
              return lastPlan.open.some((o) => o.el === el) ? `${d} — no pack answer` : d;
            }))].slice(0, 5);
          const cantPlace = [...new Set(lastPlan.unmatched.map((u) => describeField(u.cand, u.el)))].slice(0, 5);
          const controls = describeControls().slice(0, 4);

          const clauses = [];
          if (errs.length) clauses.push(`the page says ${quoted(errs)}`);
          else if (alerts.length) clauses.push(`the page announced ${quoted(alerts)}`);
          if (invalid.length) {
            clauses.push(`${invalid.length === 1 ? "1 field is" : `${invalid.length} fields are`} blocking it — ${invalid.join(", ")}`);
          }
          if (stillEmpty.length) {
            clauses.push(`${stillEmpty.length === 1 ? "1 field is" : `${stillEmpty.length} fields are`} still empty — ${stillEmpty.join(", ")}`);
          }
          if (cantPlace.length) clauses.push(`fields it couldn't place: ${cantPlace.join(", ")}`);
          clauses.push(`controls here: ${controls.join(", ") || "none visible"}`);

          const detail = clauses.join("; ");
          return {
            ok: false,
            reason: (errs.length || alerts.length || invalid.length) ? "validation-blocked" : "step-stuck",
            filled: acc.done,
            failed: acc.failed,
            openQuestions: acc.open,
            message: `Stuck on step ${step + 1}: clicking "${ctrl}" did not advance the form — ${detail}.`,
          };
        }
        continue;                                 // fill the next step
      }

      if (!submitBtn) {
        /* Nothing left to fill and no finish control — maybe the opener
         * opened a modal we can still reach. Try the opener once more. */
        if (!openedForm || location.href !== openedHref) {
          if (openerClicks < 3) {
            const opener = findOpener();
            if (opener) {
              openedForm = true;
              openerClicks++;
              openerLabel = clean(controlText(opener)).slice(0, 34);
              const marker = pageMarker();
              openedHref = location.href;
              opener.click();
              await sleep(jitter(900));
              await waitForChange(marker);
              await sleep(jitter(600));
              dismissConsent();
              continue;
            }
          }
        }
        /* Give a slow form its chance before declaring the layout unknown. */
        submitBtn = await waitForSubmit(submitLookup);
        if (!submitBtn) {
          const seen = describeControls();
          const errs = pageErrors();
          return {
            ok: false,
            reason: "no-submit-control",
            filled: acc.done,
            failed: acc.failed,
            openQuestions: acc.open,
            message: `No submit control on ${location.host}: ` +
              `${acc.done.length} field${acc.done.length === 1 ? "" : "s"} filled, ` +
              `but nothing on this page finishes the application. ` +
              (openedForm
                ? `"${openerLabel}" was clicked, but the form it should have opened never appeared. `
                : `There is no reachable Apply/Easy Apply control here to open the form. `) +
              (seen.length
                ? `Controls seen: ${seen.join(", ")}.`
                : "No clickable controls found in this frame — the form may be inside an iframe or shadow DOM.") +
              (errs.length ? ` The page says ${errs.map((e) => `"${e}"`).join(" / ")}.` : "") +
              " Review and submit yourself.",
          };
        }
      }

      if (captchaPresent()) {
        return { ok: false, reason: "captcha", filled: acc.done, failed: acc.failed, openQuestions: acc.open,
          message: "A CAPTCHA appeared before submit — stopping." };
      }

      const beforeUrl = location.href;
      submitBtn.click();

      /* Verify: confirmation text, or the page navigated away. */
      const t0 = Date.now();
      let confirmation = detectConfirmation();
      while (!confirmation && Date.now() - t0 < SUBMIT_WAIT_MS) {
        await sleep(400);
        confirmation = detectConfirmation();
        if (!confirmation && location.href !== beforeUrl) break;   // navigated = submitted (or closed)
      }

      return {
        ok: true,
        filled: acc.done,
        failed: acc.failed,
        openQuestions: acc.open,
        submitted: true,
        confirmation: confirmation || (location.href !== beforeUrl ? "page navigated after submit" : null),
        note: confirmation
          ? `Submitted — confirmation on page: "${confirmation}"`
          : "Clicked submit and the page changed, but no confirmation text was found. Check the tab.",
      };
    }

    const errs = pageErrors();
    return {
      ok: false,
      reason: "too-many-steps",
      filled: acc.done,
      failed: acc.failed,
      openQuestions: acc.open,
      message: `Gave up after ${MAX_STEPS} form steps on ${location.host} without reaching a submit control` +
        (errs.length ? ` — the page says ${errs.map((e) => `"${e}"`).join(" / ")}.` : "."),
    };
  }

  /* ---------- dashboard integration ---------- */

  /* Match a live tab URL against the dashboard's stored job URL. LinkedIn
   * redirects country subdomains (in.linkedin.com -> www.linkedin.com),
   * appends tracking params, and rewrites the slug — so for LinkedIn job
   * views, normalise to the numeric job id, which is stable across all of
   * that. Other URLs normalise to path-minus-query. */
  function normalizeUrl(u) {
    const clean = String(u || "").split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase();
    const li = clean.match(/^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/jobs\/view\/(?:.*-)?(\d{6,})$/);
    if (li) return `linkedin:${li[1]}`;
    return clean;
  }

  async function dashboardFetch(path, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      /* Preferred: the MV3 service worker fetches on the extension's own
       * origin. A direct content-script fetch to 127.0.0.1 from an https
       * board page can be refused silently by the page's CSP or Chrome's
       * private-network-access preflight — empirically, no board-origin
       * request ever reached the dashboard log that way. */
      const relay = typeof chrome !== "undefined" && chrome.runtime &&
        typeof chrome.runtime.sendMessage === "function";
      if (relay) {
        const r = await new Promise((resolve) => {
          const method = (opts && opts.method) || "GET";
          let body;
          try { body = typeof opts.body === "string" ? JSON.parse(opts.body) : (opts && opts.body) || {}; }
          catch { body = {}; }
          chrome.runtime.sendMessage({ type: "dashboard", path, method, body }, (resp) => {
            if (chrome.runtime.lastError) resolve(null); else resolve(resp);
          });
        });
        /* a real relay answer (even "dashboard down") is final; only a
         * broken channel falls through to the direct fetch below */
        if (r) return r.ok && r.json ? r.json : null;
      }
      const r = await fetch(DASHBOARD + path, Object.assign({ signal: ctl.signal }, opts || {}));
      return r && r.ok ? await r.json() : null;
    } catch {
      return null;                                 // dashboard not running — fine
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- live job harvesting ----------
   * The dashboard can only show fresh jobs from a board if something reads
   * them. Server-side fetches are bot-walled on every major board, so the
   * scrape runs here — in the user's own logged-in tab — and POSTs to
   * /api/harvest. Two server-side gates back it up: an unconnected board
   * gets 403 (selected boards only, ever), and each listing's URL must map
   * back to the same board. This host table mirrors server.js JOB_HOSTS. */
  const HARVEST_HOSTS = [
    ["linkedin.com", "linkedin"], ["indeed.com", "indeed"], ["naukri.com", "naukri"],
    ["foundit.in", "foundit"], ["hirist.tech", "hirist"], ["instahyre.com", "instahyre"],
    ["wellfound.com", "wellfound"], ["cutshort.io", "cutshort"], ["tophire.co", "tophire"],
    ["internshala.com", "internshala"], ["unstop.com", "unstop"],
    ["glassdoor.com", "glassdoor"], ["glassdoor.co.in", "glassdoor"],
    ["leetcode.com", "leetcode"], ["geeksforgeeks.org", "geeksforgeeks"],
    ["ambitionbox.com", "ambitionbox"], ["hackerearth.com", "hackerearth"],
  ];
  function boardIdOfHost(host) {
    for (const [dom, id] of HARVEST_HOSTS) {
      if (host === dom || host.endsWith("." + dom)) return id;
    }
    return null;
  }

  /* Card links are found by shape, not by per-board class names (those churn
   * constantly): an anchor on this board's own host whose href says /job/ and
   * whose first text line reads like a title. Nav/filter/login links are
   * noise-filtered; the server re-checks every URL anyway. */
  const LINK_NOISE = /(alert|search|filter|keyword|login|signin|signup|register|subscribe|policy|terms|privacy|help|collections|directory|walkin-jobs|\/category)/i;
  /* A link is a LISTING only if it looks like a detail URL or its card carries
   * real job text. Without this, board navigation — "Data Science jobs",
   * "Fresher jobs", "Jobs in Mumbai" — was harvested as if it were a job
   * (seen live on Naukri: 11 category links shipped as zero-detail listings). */
  const DETAIL_HREF = /(job-listings|\/jobs\/view\/|\/viewjob\b|viewjob\?|[?&]jk=|[?&]jobId=|\/job\/|-jd-|\/jobs\/\d|\/o\/[\w-]+)/i;
  /* Cities and countries only. "hybrid" is a work mode, not a location — with
   * it in here, a skills line ("… Hybrid ML Optimisation, Gurobi, CPLEX") was
   * stored as the job's location. */
  const LOC_RE = /\b(bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|kochi|jaipur|indore|coimbatore|chandigarh|india|remote|work from home|wfh|anywhere)\b/i;
  /* The detail facts a card needs — experience, pay, age of the post — are
   * plain text lines on every board's listing card ("2-5 Yrs", "₹6-12 LPA",
   * "3 days ago"). Patterns instead of per-board selectors, same as titles. */
  const EXP_RE = /\d{1,2}\s*[-–—]\s*\d{1,2}\s*(?:yrs?|years?)|\d{1,2}\s*\+\s*(?:yrs?|years?)|(?:exp(?:erience)?\s*:?\s*)?\d{1,2}\s*(?:yrs?|years?)(?:\s*of\s*exp(?:erience)?)?|fresher/i;
  const SALARY_RE = /(₹|rs\.?\s?\d|inr\s?\d|\$\s?\d)|\d+(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?)|per annum|per month|\/\s*(?:mo|month)\b/i;
  const LISTED_RE = /\d+\s*(?:minute|hour|day|week|month)s?\s*ago|few\s+(?:minutes?|hours?|days?)\s+ago|just\s+(?:posted|now)|posted\s+(?:today|yesterday)|today|yesterday|reposted/i;

  function cleanLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  /* The nearest container is sometimes only the title's own row (Naukri wraps
   * it in `div.row1`) while company / experience / location live two levels up
   * inside the card. Climb until the container carries detail lines, stopping
   * before the whole result list — that would mix one job's text into another. */
  const CARD_SEL = "li, article, [class*='card'], [class*='result'], [class*='job'], tr, dd, div";
  function cardLines(a, title) {
    let el = a.closest(CARD_SEL);
    let best = [];
    for (let up = 0; el && up < 4; up++) {
      const raw = el.innerText || "";
      const lines = raw.split("\n")
        .map(cleanLine)
        .filter((l) => l.length >= 2 && l.length <= 90)
        .slice(0, 16);
      if (lines.length > best.length) best = lines;
      if (lines.filter((l) => l !== title).length >= 2 && raw.length < 1500) return lines;
      el = el.parentElement && el.parentElement.closest(CARD_SEL);
    }
    return best;
  }

  function scrapeListings() {
    const boardId = boardIdOfHost(location.hostname);
    if (!boardId) return [];
    const out = [];
    const seen = new Set();
    /* The page we are standing on is not one of its own listings, and a board's
     * category/search route ("…-jobs", "jobs-in-…", "/search") is an index no
     * matter how much card text sits next to it. (Seen live: the search page
     * itself was harvested as a job because its heading link had details.) */
    const hereKey = (() => {
      try { const u = new URL(location.href); return u.origin + u.pathname; } catch { return ""; }
    })();
    const urlKey = (href) => { try { const u = new URL(href); return u.origin + u.pathname; } catch { return ""; } };
    const isIndexUrl = (href) => {
      const path = urlKey(href).replace(/^https?:\/\/[^/]+/i, "");
      return /(-jobs|-vacancies|jobs-in-|\/search\b|\/jobsearch\b|\/jobs\/?$)/i.test(path) &&
        !DETAIL_HREF.test(href);
    };
    for (const a of document.querySelectorAll("a[href]")) {
      if (out.length >= 60) break;
      const href = a.href || "";
      if (!/^https?:/i.test(href) || !/job/i.test(href) || LINK_NOISE.test(href)) continue;
      if (hereKey && urlKey(href) === hereKey) continue;   // the page itself
      if (isIndexUrl(href)) continue;                      // a category/search index
      let ah = "";
      try { ah = new URL(href).hostname.toLowerCase(); } catch { continue; }
      if (boardIdOfHost(ah) !== boardId) continue;   // same board only
      const title = cleanLine((a.innerText || a.getAttribute("aria-label") || "").split("\n")[0]);
      if (title.length < 8 || title.length > 160 || seen.has(href)) continue;
      seen.add(href);
      const lines = cardLines(a, title);
      const company = lines.find((l) => l !== title && l.length <= 60 && !/^\d/.test(l) && !LOC_RE.test(l)) || "";
      /* A location line is short and never the title itself (board category
       * links used to store their own title as the location). */
      const location = (lines.find((l) => l !== title && l.length <= 40 &&
        !l.toLowerCase().includes(title.toLowerCase()) && LOC_RE.test(l)) || "").slice(0, 80);
      const experience = (lines.find((l) => EXP_RE.test(l)) || "").slice(0, 40);
      const salary = (lines.find((l) => SALARY_RE.test(l)) || "").slice(0, 40);
      const listed = (lines.find((l) => LISTED_RE.test(l)) || "").slice(0, 40);
      /* Accept only a detail-page URL, or a link whose OWN row already holds
       * more than the title. Board navigation ("Data Science jobs", "Jobs in
       * Mumbai") is a single-line link: climbing its ancestors reaches the
       * page header, which is exactly how nav text was mistaken for a
       * company/location and shipped as a job. */
      const near = a.closest(CARD_SEL);
      const nearLines = ((near && near.innerText) || "").split("\n")
        .map(cleanLine).filter((l) => l.length >= 2);
      const hasDetail = !!(company || location || experience || listed);
      if (!DETAIL_HREF.test(href) && !(hasDetail && nearLines.length >= 3)) continue;
      out.push({ title, company, location, experience, salary, listed, url: href });
    }
    return out;
  }

  /* ---------- session verification ----------
   * "I'm signed in — connect" is a claim, not a fact. The dashboard asks
   * this page for EVIDENCE before a board ever flows jobs: an explicit
   * Sign out control or a profile/account link means logged in; a password
   * form or a Sign in control means not. Ambiguous answers null — the server
   * treats unknown as "not verified" and tells you to log in rather than
   * trusting the click. */
  const SESSION_IN = /^(sign ?out|log ?out|logout)\b/i;
  const SESSION_OUT = /^(sign ?in|log ?in|login|register|sign ?up|create (an )?account)\b/i;
  const PROFILE_HREF = /\/(profile|account|me|my[-_])|\/user\//i;

  function sessionVerdict() {
    const boardId = boardIdOfHost(location.hostname);
    if (!boardId) return { board: null, ok: null };
    let hasIn = false, hasOut = false, hasForm = false;
    for (const el of document.querySelectorAll("button, a, [role=button], input[type=password], img")) {
      if ((el.type || "").toLowerCase() === "password") { hasForm = true; continue; }
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "IMG") {
        if (/profile|avatar/i.test(el.alt || el.title || "")) hasIn = true;
        continue;
      }
      /* each source is matched SEPARATELY — a real element carries innerText
       * AND textContent (same string), a fake carries one; joining them makes
       * exact patterns miss, and aria-label noise must not drown the label. */
      const texts = [el.innerText, el.textContent, el.value]
        .filter(Boolean)
        .map((t) => cleanLine(t).slice(0, 24));
      if (texts.some((t) => SESSION_IN.test(t))) hasIn = true;
      else if (texts.some((t) => SESSION_OUT.test(t))) hasOut = true;
      if (!hasIn && el.href && PROFILE_HREF.test(el.href)) hasIn = true;
    }
    let ok = null;
    if (hasIn && !hasForm) ok = true;
    else if ((hasOut || hasForm) && !hasIn) ok = false;
    return { board: boardId, ok, signals: { in: hasIn, out: hasOut, form: hasForm } };
  }

  let lastSessionSig = "";
  let lastNullAt = 0;
  async function reportSession() {
    const v = sessionVerdict();
    if (!v.board) return v;
    const sig = `${v.board}:${v.ok}`;
    if (sig === lastSessionSig) {
      /* A decisive verdict stands for the page-load. Null does NOT — it may
       * just mean the header hadn't rendered yet (seen live: Naukri's
       * "Register for free" lands at ~6s, the first check runs at 2.5s),
       * so null is retried, throttled to every 30s. */
      if (v.ok !== null || Date.now() - lastNullAt < 30000) return v;
    }
    const res = await dashboardFetch(`/api/boards/${v.board}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: v.ok, detail: JSON.stringify(v.signals) }),
    });
    if (res && res.ok) {
      lastSessionSig = sig;
      lastNullAt = Date.now();
      /* A verified login is the moment the board becomes eligible — fetch
       * its jobs right away instead of waiting for the next DOM change. */
      if (v.ok === true) await harvestOnce().catch(() => {});
    }
    return v;
  }

  let harvestTimer = null;
  function scheduleHarvest(quietMs) {
    if (harvestTimer) return;                    // one pending burst at a time
    harvestTimer = setTimeout(async () => {
      harvestTimer = null;
      await reportSession().catch(() => {});     // connect waits on this verdict
      await harvestOnce().catch(() => {});       // never break the page we're on
    }, quietMs);
  }

  let lastHarvestSig = "";
  async function harvestOnce(opts) {
    const boardId = boardIdOfHost(location.hostname);
    if (!boardId || captchaPresent()) return null;
    const jobs = scrapeListings();
    if (!jobs.length) return null;
    const sweep = opts && opts.sweep ? opts.sweep : null;
    /* A sweep page is reported even when its URL set repeats — the server's
     * progress counter needs every page it walked, not only new jobs. */
    const sig = jobs.map((j) => j.url).join("|") + (sweep ? `#p${sweep.page}` : "");
    if (sig === lastHarvestSig) return null;      // nothing new since last POST
    const body = { board: boardId, page: location.href, jobs };
    if (sweep) body.sweep = sweep;
    const res = await dashboardFetch("/api/harvest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res && res.ok) lastHarvestSig = sig;
    return res;
  }

  /* ---------- fetch-all: walk the board's result pages ----------
   * "Get all the matching jobs", not just the first page: the dashboard asks
   * for a sweep, this page harvests itself, clicks Next and continues. If the
   * click navigates, this script dies with the page and the NEXT page's script
   * picks the sweep up from the server — progress survives navigation. Stops
   * at the page cap, at a dead end, or when the user stops it. */
  const NEXT_LABEL = /^(next(\s+page)?|›|»|→)\b/i;

  function nextPageControl() {
    for (const el of document.querySelectorAll("a[rel='next'], a, button, [role=button]")) {
      const label = cleanLine(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0, 30);
      if (!label || !NEXT_LABEL.test(label)) continue;
      if (el.disabled) continue;
      if (/disabled|is-disabled/i.test(String(el.className || ""))) continue;
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      const href = el.getAttribute("href") || "";
      const inPager = !!el.closest("[class*='pagination' i], [class*='pager' i], nav[aria-label*='agination' i]");
      if (rel === "next" || inPager || /[?&](page|start|p|offset)=\d+/i.test(href)) return el;
    }
    return null;
  }

  let sweeping = false;
  async function reportSweep(boardId, page, last) {
    return dashboardFetch(`/api/boards/${boardId}/sweep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: page, last }),
    });
  }

  async function maybeSweep() {
    if (sweeping) return null;
    const boardId = boardIdOfHost(location.hostname);
    if (!boardId || captchaPresent()) return null;
    const st = await dashboardFetch(`/api/boards/${boardId}/sweep`);
    const sweep = st && st.sweep ? st.sweep : null;
    if (!sweep || sweep.status !== "running") return null;
    if (!scrapeListings().length) return null;    // not a listing page yet
    sweeping = true;
    let page = Number(sweep.page) || 0;
    const max = Math.max(1, Number(sweep.maxPages) || 1);
    try {
      while (page < max) {
        const ctl = nextPageControl();
        if (!ctl) {
          await reportSweep(boardId, page, true);
          return { page, done: true, why: "no next-page control" };
        }
        page += 1;
        ctl.click();
        await sleep(4000);                        // new page render (SPA or navigation)
        /* A navigating click destroys this context; the next page's script
         * resumes the sweep from the server. */
        await reportSession().catch(() => {});
        await harvestOnce({ sweep: { page, last: page >= max } }).catch(() => {});
      }
      await reportSweep(boardId, page, true);
      return { page, done: true };
    } finally {
      sweeping = false;
    }
  }

  function startHarvester() {
    if (boardIdOfHost(location.hostname) === null) return;   // not a board page
    scheduleHarvest(2500);                                  // first render (session first)
    /* A fetch-all may be waiting on this page (or have just navigated here). */
    setTimeout(() => { maybeSweep().catch(() => {}); }, 4500);
    /* Infinite-scroll and SPA lists keep swapping cards in — re-scrape after
     * bursts of DOM change (throttled: one pending timer, POST only when the
     * URL set actually grew, so busy pages don't chatter the dashboard). */
    try {
      new MutationObserver(() => scheduleHarvest(6000))
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  }

  /* ---------- in-flight marker (cross-page runs) ----------
   * Clicking Apply on LinkedIn can navigate to a company ATS on another
   * origin — this content script dies with the page, and the fresh script on
   * the far side has no URL match against the dashboard. An in-flight marker
   * in chrome.storage.local bridges that: autopilot writes it before a run,
   * any later page load within the TTL may resume it, and "applied" clears
   * it. The decision is re-checked against the dashboard on every resume, so
   * a marker can never apply to an unapproved or already-applied job. */
  const INFLIGHT_KEY = "inflight";
  /* A redirect completes in seconds; a short TTL keeps the marker from ever
   * outliving the hop it was written for. */
  const INFLIGHT_TTL_MS = 5 * 60 * 1000;

  function storageArea() {
    return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) || null;
  }

  async function setInflight(jobId) {
    const s = storageArea();
    if (!s) return;
    try { await s.set({ [INFLIGHT_KEY]: { jobId, ts: Date.now() } }); } catch {}
  }

  async function clearInflight() {
    const s = storageArea();
    if (!s) return;
    try { await s.remove(INFLIGHT_KEY); } catch {}
  }

  async function getInflight() {
    const s = storageArea();
    if (!s) return null;
    try {
      const r = await s.get(INFLIGHT_KEY);
      const f = r && r[INFLIGHT_KEY];
      if (!f || typeof f.jobId !== "number") return null;
      if (Date.now() - f.ts > INFLIGHT_TTL_MS) { await clearInflight(); return null; }
      return f;
    } catch { return null; }
  }

  /* Decide whether THIS page may run, based on the dashboard + marker. */
  async function resolveTarget() {
    const boot = await dashboardFetch("/api/bootstrap");
    if (!boot || !boot.jobs) return null;
    const decisions = boot.decisions || {};
    const allowed = (id) => {
      const d = decisions[id];
      if (!d) return false;
      if (d.action === "applied") return false;    // already done — never double-apply
      return d.action === "approve" || d.action === "apply";  // only user-approved jobs
    };

    const here = normalizeUrl(location.href);
    const job = boot.jobs.find((j) => normalizeUrl(j.url) === here);
    if (job && allowed(job.id)) return { job, boot };

    /* No direct match: is this the far side of an approved job's redirect? */
    const inflight = await getInflight();
    if (inflight && allowed(inflight.jobId)) {
      const j = boot.jobs.find((x) => x.id === inflight.jobId);
      if (j) return { job: j, boot, resumed: true };
    }
    return null;
  }

  async function reportRun(job, res) {
    await dashboardFetch(`/api/jobs/${job.id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: res.ok && res.submitted ? "applied" : res.reason === "captcha" ? "captcha" : "failed",
        confirmation: res.confirmation || null,
        message: res.message || res.note || "",
        filled: (res.filled || []).length,
        openQuestions: res.openQuestions || [],
      }),
    });
    /* Any concluded run ends the in-flight hop — even a halted one. The
     * marker exists only to carry a run across a redirect; a run that
     * reported back concluded here, so a later page must earn a fresh
     * trigger (URL match or a new approve) rather than inherit this one. */
    await clearInflight();
    /* …and then hand off: the server's run decides what comes next. */
    await advanceRun();
  }

  /* The apply queue lives on the dashboard. When this page concludes its job,
   * ask for the next one and let the background worker open it — so the run
   * advances on its own, with no tab or dashboard needed to stay open. */
  async function advanceRun() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const next = await dashboardFetch("/api/apply/next");
    if (!next || next.done || !next.job || !next.job.url) return;
    try {
      chrome.runtime.sendMessage({ type: "apply:open", url: next.job.url });
    } catch { /* worker asleep — the user can resume from the popup */ }
  }

  /* Autopilot: run only when THIS page is a job the user approved in the
   * dashboard (or the continuation of one), and the toggle is on. */
  async function maybeAutopilot() {
    try {
      const s = storageArea();
      if (s) {
        const stored = await s.get("autopilot");
        if (stored && stored.autopilot === false) return;
      }
      const target = await resolveTarget();
      if (!target) return;

      await setInflight(target.job.id);            // survives a cross-origin hop
      await sleep(jitter(1500));                    // let the page settle
      const res = await run({ submit: true });
      /* A page that is not an application (an expired job that redirected to
       * search, a listing tab) never gets reported as a failed application —
       * nothing happened. The run moves on instead of stalling on it. */
      if (res.reason === "not-an-application") {
        await clearInflight();
        await advanceRun();
        return;
      }
      await reportRun(target.job, res);
    } catch {
      /* never break the page we're on */
    }
  }

  /* Resume: after a redirect, the landing page may itself need an Apply click
   * before the form exists. Called shortly after load; maybeAutopilot already
   * covers pages that match directly, so this only acts when a marker exists
   * and the direct match didn't fire. */
  async function maybeResume() {
    try {
      const s = storageArea();
      if (s) {
        const stored = await s.get("autopilot");
        if (stored && stored.autopilot === false) return;
      }
      const inflight = await getInflight();
      if (!inflight) return;                        // nothing in flight — browsing is untouched
      const boot = await dashboardFetch("/api/bootstrap");
      if (!boot || !boot.jobs) return;
      const job = boot.jobs.find((x) => x.id === inflight.jobId);
      if (!job) { await clearInflight(); return; }
      const d = (boot.decisions || {})[job.id];
      if (!d || d.action === "applied") { await clearInflight(); return; }
      if (d.action !== "approve" && d.action !== "apply") { await clearInflight(); return; }

      /* Only pages that look like an application get touched: either fields
       * to fill, or an Apply-shaped control to open the form. */
      const p = buildPlan();
      const opener = findOpener();
      if (!p.fields.length && !p.open.length && !opener) return;

      await sleep(jitter(2000));                    // let the far-side page settle
      const res = await run({ submit: true });
      await reportRun(job, res);
    } catch {
      /* never break the page we're on */
    }
  }

  globalThis.__JOB_AGENT__ = {
    /* login evidence on this page — the dashboard's connect gate reads it */
    session: () => sessionVerdict(),
    /* The build stamp rides on every result so the popup can show WHICH
     * engine answered — the exact doubt a chrome://extensions version alone
     * cannot settle for a tab opened before the update. */
    run: async (opts) => Object.assign({ v: VERSION }, await run(opts)),
    fill: () => run({ submit: false }),
    /* What the harvester reads off this page right now — the diagnostics
     * answer to "why are no jobs arriving from this board?". */
    listings: () => scrapeListings(),
    /* Walk this board's result pages for a pending fetch-all. */
    sweep: () => maybeSweep(),
    autopilot: maybeAutopilot,
    resume: maybeResume,
    preview: () => {
      const p = buildPlan();
      return {
        wouldFill: p.fields.map((f) => ({ key: f.key, value: f.value, label: f.cand.label })),
        needsYou: p.open.map((o) => o.key),
        captcha: captchaPresent(),
        submitControl: !!findSubmitControl({ filled: true }),
        openerControl: !!findOpener(),
        nextControl: !!findControl(NEXT_HINT),
      };
    },
  };

  async function boot() {
    startHarvester();     // fresh jobs flow to the dashboard while you browse
    await maybeAutopilot();
    await maybeResume();   // no-op unless a marker survived a redirect
  }

  if (!REPLACING) {
    if (typeof document !== "undefined" && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { boot(); });
    } else {
      boot();
    }
  }
})();
