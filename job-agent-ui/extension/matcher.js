/* Field matcher — pure logic, no DOM.
 *
 * An ATS form asks the same question fifty different ways: "First name",
 * "Given Name", "first_name", "FN". This module maps any of those back to a
 * fill-pack key. Kept free of DOM access so it can be unit-tested in Node
 * against real Workday / Greenhouse / Lever / LinkedIn label conventions.
 */
"use strict";

/* The whole module lives in one IIFE: the popup re-injects this file on
 * every run, and any top-level `const M` (or `var M` alongside an older
 * `const M` already in the tab's isolated world) throws "already been
 * declared" — the re-injection silently failed and the tab kept matching
 * with the rule table it loaded with. No top-level declarations = safe to
 * inject any number of times, across extension versions. */
(function () {

var M = {};

/* ---------- normalisation ---------- */

M.norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")     // curly apostrophes
    .replace(/[\u2013\u2014]/g, "-")     // en/em dash
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9'+ ]/g, " ")       // strip punctuation/underscores/slashes
    .replace(/\s+/g, " ")
    .trim();

/* ---------- rule table ----------
 * Each rule: [regex, fillpack key, priority].
 * Priority exists because labels overlap — "Current Title" must beat the
 * generic "Title", and "Expected CTC" must beat a bare "CTC". Higher wins.
 * `null` value keys are deliberately unresolvable; the engine reports them
 * as "ask the user" rather than guessing.
 */
M.RULES = [
  // --- identity -------------------------------------------------------------
  [/^(?:applicant |candidate |your )?(first name|given name|fname)$/, "identity.firstName", 90],
  [/^(?:applicant |candidate |your )?(last name|surname|family name|lname)$/, "identity.lastName", 90],
  [/^(full name|name|your name|applicant name|candidate name)$/, "identity.fullName", 70],
  [/^(?:primary |personal |home |best |enter |your |applicant |candidate |job application )?e ?mail( address| id)?$/, "identity.email", 90],
  [/^(?:primary |personal |home |best |enter |your )?.*(phone|mobile).*(country code|with code|international)$/, "identity.phone", 95],
  [/^(?:primary |personal |home |best |enter |your )?(phone|mobile|phone number|mobile number|contact number|contact phone|mobile phone|contact mobile)$/, "identity.phoneLocal", 90],
  [/^(phone|mobile).*(local|10 ?digit)/, "identity.phoneLocal", 95],
  [/^(city|town|location city|current city)$/, "identity.city", 80],
  [/^(state|state province|state or province|province|region|state province region)$/, "identity.state", 80],
  [/^(country|country or region|country region)$/, "identity.country", 85],
  [/^(address|street|street address|home address|postal address|address line 1)$/, "identity.address", 80],
  [/^(zip|zip code|zipcode|postal|postal code|zip postal code|pincode|pin code|postcode)$/, "identity.postalCode", 85],
  [/^linked ?in/, "identity.linkedinUrl", 95],
  [/^git ?hub/, "identity.githubUrl", 95],
  [/^(portfolio|portfolio url|website|personal website|website url)$/, "identity.portfolioUrl", 70],
  [/^(current employer|current company|employer name|present employer|most recent employer)$/, "identity.currentEmployer", 85],
  [/^(current title|current role|current position|present designation|most recent title|job title)$/, "identity.currentTitle", 85],
  [/^(headline|professional headline|title)$/, "identity.headline", 40],

  // --- work / screening -----------------------------------------------------
  [/^(total experience|total years of experience|years of experience|experience|yrs of experience|total work experience)$/, "screening.totalExperience", 85],
  [/^(ai ?\/ ?ml experience|ai ?ml years|ml experience|ai experience|genai experience)$/, "identity.aiMlExperienceYears", 85],
  [/^(notice period|notice|notice period in days|how soon can you join|availability|earliest start date|start date|available from|when can you join)$/, "work.noticePeriod", 80],
  [/^(work authorization|authorized to work|eligible to work|right to work|work permit|do you have work authorization)/, "work.workAuthorizedIndia", 85],
  [/^(sponsorship|visa sponsorship|will you now or in the future require visa sponsorship|require sponsorship|do you require sponsorship|visa)/, "work.requiresSponsorship", 95],
  [/^(relocation|willing to relocate|are you willing to relocate|relocate|open to relocation)$/, "work.willingToRelocate", 90],
  [/^(expected ctc|expected salary|salary expectation|salary expectations|ctc|desired ctc|compensation expectation|expected compensation|pay expectation)/, "work.expectedSalary", 95],
  [/^(current ctc|current salary|present salary|last drawn|current compensation)/, "work.currentSalary", 95],
  [/^(employment type|job type|type of employment|engagement type|position type)$/, "work.employmentType", 70],
  [/^(remote|work from home|hybrid|remote preference|work model)$/, "work.prefersRemote", 60],
  [/^(how did you hear|how did you find|source|how did you hear about us|where did you hear)/, "screening.howDidYouHear", 80],
  [/^(why (this|the) (role|position|company|us)|cover letter|motivation|why do you want to work|additional information|anything else)/, "screening.whyThisRole", 75],
  [/^(references|reference|may we contact|can we contact)/, "screening.references", 70],
  [/^(gender|race|ethnicity|veteran|disability|self.?identify|voluntary demographic|eeo)/, "screening.eeoDecline", 90],
  [/^(highest qualification|highest education|education level|degree|qualification)$/, "identity.highestEducation", 50],
  /* The pack has no answer for this yet — it is null, so the engine asks
   * instead of guessing English at a field that gates the next step. */
  [/^(?:select |choose |preferred |primary |application |known )?language(s)?( known| proficiency| skills| spoken| preference)?$/, "identity.languages", 75],
];

/* ---------- matching ---------- */

/* Score a single label against every rule. Returns {key, score} or null. */
M.matchLabel = (label) => {
  const t = M.norm(label);
  if (!t) return null;
  let best = null;
  for (const [re, key, pri] of M.RULES) {
    if (re.test(t)) {
      if (!best || pri > best.score) best = { key, score: pri, label: t };
    }
  }
  return best;
};

/* Build one haystack per candidate: the visible label, plus the attribute
 * hints (name/id/placeholder/aria) that ATS frameworks often leave as the
 * only signal. Attributes are penalised slightly — a real label is stronger
 * evidence than an input's `name="ctl00$foo"`. */
M.matchField = (cand) => {
  const attempts = [
    [cand.label, 0],
    [cand.ariaLabel, 8],
    /* Question text sitting next to the field instead of on it: stronger than
     * a placeholder, weaker than a real label. */
    [cand.nearby, 9],
    [cand.placeholder, 12],
    [cand.name, 18],
    [cand.id, 18],
  ];
  let best = null;
  for (const [text, penalty] of attempts) {
    const m = M.matchLabel(text);
    if (!m) continue;
    const score = m.score - penalty;
    if (!best || score > best.score) best = { key: m.key, score, via: text };
  }
  return best;
};

/* ---------- question bank ----------
 * ATS screening questions are free text — "Do you have form 16 and P/F A/c of
 * current & previous company" can't live in a fixed rule table. The pack
 * therefore carries its own bank:
 *
 *   "questions": [
 *     { "match": "form 16", "answer": true },
 *     { "match": "provident fund|uan|epf", "answer": null }
 *   ]
 *
 * `match` is a case-insensitive regex run against NORMALISED text (lowercase,
 * punctuation → spaces), so "P/F" is "p f", not "p/f". `answer` is the value
 * to answer with (true/false for a yes/no pair, or a string); null means the
 * user has not answered yet and the agent must ask — never guess.
 *
 * Specificity: the longest TEXT the pattern actually matches wins, so a narrow
 * "form 16" beats a generic "pf" on the same label. A tie goes to the earlier
 * bank entry — put the more specific question first.
 */
M.matchQuestion = (cand, bank) => {
  if (!Array.isArray(bank) || !bank.length) return null;
  /* groupQuestion is the wording printed ABOVE a yes/no pair (the options
   * themselves just say "yes"/"no"), so it is the strongest signal there. */
  const haystacks = [cand.groupQuestion, cand.label, cand.nearby, cand.ariaLabel, cand.placeholder];
  let best = null;
  for (let i = 0; i < bank.length; i++) {
    const q = bank[i];
    if (!q || typeof q.match !== "string" || !q.match) continue;
    let re;
    try { re = new RegExp(q.match, "i"); } catch { continue; }
    for (const text of haystacks) {
      const t = M.norm(text);
      if (!t) continue;
      const hit = t.match(re);
      if (!hit) continue;
      /* How much of the question the pattern actually explains — a long
       * alternation is not "more specific", only a longer match is. */
      const score = (hit[0] || "").length;
      if (!best || score > best.score) best = { index: i, entry: q, score, via: text };
    }
  }
  return best;
};

/* Map a fill-pack key to its value. Returns undefined for keys that don't
 * exist and null for keys that exist but are still open questions. */
M.valueFor = (pack, key) => {
  const parts = String(key).split(".");
  let cur = pack;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur === undefined ? undefined : cur;
};

if (typeof module !== "undefined" && module.exports) module.exports = M;
if (typeof globalThis !== "undefined") globalThis.JobAgentMatcher = M;

})();
