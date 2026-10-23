/* Matcher tests — run with: node test-matcher.js
 *
 * Labels below are real strings seen on Workday, Greenhouse, Lever, Ashby,
 * LinkedIn and Indeed application forms. The suite is deliberately broad on purpose:
 * the first version tested one spelling per field and shipped a matcher that
 * failed on "Primary Email" and "State/Province". Testing the variants is
 * what catches that class of bug.
 *
 * matchLabelSafe() never throws — a miss reports "MISS" so the whole suite
 * runs to completion and shows every failure at once.
 */
"use strict";

const M = require("./matcher.js");
require("./fillpack.js");  // sets globalThis.FILLPACK
const PACK = globalThis.FILLPACK;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// A label that matches nothing is a MISS, not a crash.
const matchLabelSafe = (s) => {
  const m = M.matchLabel(s);
  return m ? m.key : "MISS";
};

// Same for matchField, which returns null when nothing matches.
const matchFieldSafe = (cand) => {
  const m = M.matchField(cand);
  return m ? m.key : "MISS";
};

/* --- Workday -------------------------------------------------------------- */
[
  ["First Name", "identity.firstName"],
  ["Last Name", "identity.lastName"],
  ["City", "identity.city"],
  ["State/Province", "identity.state"],
  ["Country/Region", "identity.country"],
  ["Mobile Phone", "identity.phoneLocal"],
  ["Primary Phone", "identity.phoneLocal"],
  ["Phone", "identity.phoneLocal"],
  ["Postal Code", "identity.postalCode"],
  ["Primary Email", "identity.email"],
  ["Email", "identity.email"],
  ["Email Address", "identity.email"],
  ["Address Line 1", "identity.address"],
  ["Street Address", "identity.address"],
].forEach(([l, k]) => check(`Workday "${l}"`, matchLabelSafe(l), k));

/* --- Greenhouse ------------------------------------------------------------ */
[
  ["How did you hear about this job?", "screening.howDidYouHear"],
  ["LinkedIn Profile", "identity.linkedinUrl"],
  ["LinkedIn", "identity.linkedinUrl"],
  ["GitHub Profile", "identity.githubUrl"],
  ["GitHub", "identity.githubUrl"],
  ["Website", "identity.portfolioUrl"],
  ["Portfolio", "identity.portfolioUrl"],
  ["Why do you want to work here?", "screening.whyThisRole"],
  ["Cover Letter", "screening.whyThisRole"],
].forEach(([l, k]) => check(`Greenhouse "${l}"`, matchLabelSafe(l), k));

/* --- Lever ---------------------------------------------------------------- */
[
  ["Phone", "identity.phoneLocal"],
  ["Current Employer", "identity.currentEmployer"],
  ["Current Title", "identity.currentTitle"],
  ["Full Name", "identity.fullName"],
].forEach(([l, k]) => check(`Lever "${l}"`, matchLabelSafe(l), k));

/* --- Indeed (contact-field labels from Indeed's own sample form; screener
 *        wording is employer-specific and deliberately not tested) --------- */
[
  ["First name", "identity.firstName"],
  ["Last name", "identity.lastName"],
  ["Street", "identity.address"],
  ["City", "identity.city"],
  ["Phone number", "identity.phoneLocal"],
  ["Email address", "identity.email"],
  ["zipcode", "identity.postalCode"],
  ["Postal code", "identity.postalCode"],
].forEach(([l, k]) => check(`Indeed "${l}"`, matchLabelSafe(l), k));

/* --- Regression: bare "name" must NOT land on firstName ------------------- */
// An earlier edit made the firstName rule match bare "name", which outranked
// the fullName rule and would have typed only "Shivayogi" into a full-name
// field. Locking the intended behaviour in.
check("bare 'name' -> fullName", matchLabelSafe("name"), "identity.fullName");
check("'Your Name' -> fullName", matchLabelSafe("Your Name"), "identity.fullName");

/* --- Ambiguity: the specific rule must beat the generic one ---------------- */
[
  ["Current Title", "identity.currentTitle"],
  ["Expected CTC", "work.expectedSalary"],
  ["Expected Salary", "work.expectedSalary"],
  ["Current CTC", "work.currentSalary"],
  ["Current Salary", "work.currentSalary"],
  ["Will you now or in the future require visa sponsorship?", "work.requiresSponsorship"],
  ["Visa Sponsorship", "work.requiresSponsorship"],
  ["Are you willing to relocate?", "work.willingToRelocate"],
  ["Notice Period", "work.noticePeriod"],
  ["Total Experience", "screening.totalExperience"],
  ["Work Authorization", "work.workAuthorizedIndia"],
].forEach(([l, k]) => check(`Ambiguity "${l}"`, matchLabelSafe(l), k));

/* --- Language: a question the pack cannot answer — asked, never guessed --- */
[
  "Select language",
  "Language",
  "Languages known",
  "Preferred language",
  "Language proficiency",
].forEach((l) => check(`Language "${l}"`, matchLabelSafe(l), "identity.languages"));
check("language answer is still open", M.valueFor(PACK, "identity.languages"), null);

/* --- Question text that isn't wired to the input -------------------------- */
check("nearby text used as a label", matchFieldSafe({ label: "", nearby: "Select language" }), "identity.languages");
check("a real label beats nearby text", matchFieldSafe({ label: "Expected CTC", nearby: "City" }), "work.expectedSalary");
check("nearby text alone still fills", matchFieldSafe({ label: "", name: "field_7", nearby: "City" }), "identity.city");

/* --- Attribute-only fallback (ATS with no visible label) ------------------ */
check("name=first_name via attr", matchFieldSafe({ label: "", name: "first_name" }), "identity.firstName");
check("name=last_name via attr", matchFieldSafe({ label: "", name: "last_name" }), "identity.lastName");
check("id=applicant_email via attr", matchFieldSafe({ label: "", id: "applicant_email" }), "identity.email");
check("name=applicant_email via attr", matchFieldSafe({ label: "", name: "applicant_email" }), "identity.email");
check("name=phone_number via attr", matchFieldSafe({ label: "", name: "phone_number" }), "identity.phoneLocal");
check("placeholder phone hint", matchFieldSafe({ label: "", placeholder: "Mobile number" }), "identity.phoneLocal");
// A bare phone field gets the local number (Workday has its own country-code
// dropdown); only an explicit ask for the international form gets +91.
check("explicit country-code ask -> full", matchFieldSafe({ label: "Phone (with country code)" }), "identity.phone");
check("unmatched returns null", M.matchField({ label: "", name: "" }), null);

/* --- Values resolve, and open questions stay null ------------------------- */
check("valueFor phone", M.valueFor(PACK, "identity.phone"), "+91-9900455663");
check("valueFor expectedSalary is null", M.valueFor(PACK, "work.expectedSalary"), null);
check("valueFor unknown key undefined", M.valueFor(PACK, "nope.nope"), undefined);

/* --- Normalisation --------------------------------------------------------- */
check("norm strips punctuation", M.norm("State/Province"), "state province");

/* --- Safety: nothing in the pack should be a submit-ish value ------------- */
const leaves = [];
(function walk(o) {
  if (o == null) return;
  if (Array.isArray(o)) return o.forEach(walk);
  if (typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("_") || k === "askUser") continue;
    if (v == null) continue;
    if (typeof v === "object") walk(v); else leaves.push(v);
  }
})(PACK);
check("pack has no executable-looking payload", leaves.every((v) => typeof v !== "string" || !/^\s*javascript:/i.test(v)), true);

/* --- question bank -------------------------------------------------------
 * Free-text screening questions are answered by the pack's own bank, matched
 * on normalised text (punctuation becomes spaces: "P/F" is "p f"). --- */
const BANK = [
  { match: "form ?16", answer: true },
  { match: "provident fund|p f a c|\\bpf\\b|\\buan\\b|\\bepf\\b", answer: true },
  { match: "valid passport", answer: false },
];
const qOf = (label, bank) => {
  const m = M.matchQuestion({ label }, bank || BANK);
  return m ? m.index : "MISS";
};
const REPORTED = "Do you have form 16 and P/F A/c of current & previous company";
check("bank: the exact Form 16 question", qOf(REPORTED), 0);
check("bank: PF / UAN question", qOf("Do you have a PF / UAN account?"), 1);
check("bank: passport question", qOf("Do you hold a valid passport"), 2);
check("bank: unrelated question is a miss", qOf("Why do you want to join us"), "MISS");
check("bank: answer values come through", M.matchQuestion({ label: REPORTED }, BANK).entry.answer, true);
/* specificity: the longer pattern wins on a label that matches both */
const mBoth = M.matchQuestion({ label: REPORTED }, [{ match: "p f", answer: false }, { match: "form ?16", answer: true }]);
check("bank: the more specific entry wins", mBoth ? mBoth.index : "MISS", 1);
/* the shipped pack recognises the reported question — and asks, since null */
const shipped = M.matchQuestion({ label: REPORTED }, PACK.questions);
check("pack: recognises the reported question", !!shipped && shipped.index === 0, true);
check("pack: carries the user's answer (yes)", !!shipped && shipped.entry.answer === true, true);
const immediate = M.matchQuestion({ label: "Are you an immediate joiner?" }, PACK.questions);
check("pack: immediate-joiner answer is the user's (no)", !!immediate && immediate.entry.answer === false, true);
const panQ = M.matchQuestion({ label: "Enter your PAN number" }, PACK.questions);
check("pack: unanswered ID questions are still asked, never guessed", !!panQ && panQ.entry.answer === null, true);
/* The real yes/no widget: the radio's own label is only "yes", so the bank has
 * to be read against the wording printed above the pair. */
check("bank: the option label alone is a miss", M.matchQuestion({ label: "yes" }, PACK.questions), null);
check("bank: the question above the pair answers its radio",
  (M.matchQuestion({ label: "yes", groupQuestion: REPORTED }, PACK.questions) || {}).index, 0);
check("bank: an unrelated pair stays unanswered",
  M.matchQuestion({ label: "no", groupQuestion: "Do you have a valid driving licence" }, PACK.questions), null);
/* A notice-period answer is one of the page's own options, never free text. */
const noticeQ = M.matchQuestion({ label: "What is your notice period?" }, PACK.questions);
check("pack: notice period answers with the recorded choice",
  noticeQ && noticeQ.entry.answer, "2 Months");
check("pack: that choice is option-only",
  noticeQ && noticeQ.entry.choiceOnly, true);
check("pack: and it falls back to 'Skip this question'",
  noticeQ && noticeQ.entry.fallback, "Skip this question");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
