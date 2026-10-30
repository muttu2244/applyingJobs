# My Job Agent — Apply Agent (Chrome extension)

Fills your saved application data into Workday, Greenhouse, Lever, Ashby,
LinkedIn, Indeed, Glassdoor, Wellfound, Internshala, Unstop, Cutshort, TopHire,
LeetCode, GeeksforGeeks, AmbitionBox, HackerEarth and the Indian boards —
**in your own logged-in Chrome** — walks
multi-step forms, and **submits the application for you**.

## Install (once)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and pick *this* folder (`job-agent-ui/extension`).
4. Pin "My Job Agent — Apply Agent" to the toolbar (the card shows    **Version 2.12.4** — if it doesn't, click reload ⟳ on the card).
5. Reload any job tabs opened *before* the update — a tab keeps the engine it
   loaded with until the page is refreshed (the popup shows `engine vX.Y.Z`
   so you can see which build answered).
6. Start the dashboard (`node job-agent-ui/server.js`) so autopilot can talk to it.

## The popup is the board list *and* the job list

Click the toolbar icon and you get the boards and the jobs themselves — no
dashboard needed for the daily loop:

- **A chip per board.** Green = connected. Clicking a grey chip opens that
  board in a background tab, checks whether you are really signed in, and
  turns green only on evidence. A red **· log in** chip means the last check
  found a login form — click it to bring that tab forward; the check re-runs.
  When the page shows no clear signal the chip says **· unverified** and
  offers *skip check* (your explicit override). The **×** beside a connected
  chip disconnects that board and its jobs leave the list at once.
- **A card per job.** Each card names the **board** it came from, the
  **years of experience**, the **location**, the **pay** when the card shows
  it, how old the post is, and the match %. Click a card to open the
  posting; **Approve** makes it eligible for autopilot. Freshly fetched
  listings are marked ⚡.

The popup reads `/api/bootstrap` (the extension has host permission for
`127.0.0.1:8357`, so no page CSP can block it) and re-polls every 2.5s — the
moment a background board tab reports its verdict or harvests listings, the
chips and cards follow.

## The whole loop: connect → fetch all → apply

This is the myjobb-style flow, and every step is real here:

1. **Connect a board — with your approval, per board.** A chip in the popup
   (or a card in the dashboard) is the only way a board ever becomes a
   source. Clicking it opens that board in your browser and the extension
   reads the live page for evidence; nothing is read from, or applied to, a
   board you have not approved. The **×** / **Disconnect** revokes it and its
   jobs leave the list immediately.
2. **Fetch all — every result page, not just the first.** *Fetch all jobs* on
   a board starts a sweep: the extension harvests page 1, clicks **Next**,
   harvests page 2, and keeps going (default cap 5 pages, server-clamped to
   25). Progress is kept server-side, so if the click navigates, the next
   page's script resumes the sweep instead of starting over. The board card
   shows `Fetching… 3/5`, then `fetch-all finished: N new jobs across 5 pages`.
   If the board tab dies mid-sweep (extension reloaded, browser closed), the
   progress reports stop arriving and the server marks the sweep **stalled**
   after 2½ minutes of silence — logged once, with the Fetch button usable
   again — instead of claiming `Fetching…` forever. A throttled-but-alive tab
   proves itself with its next page report and is put straight back to
   running. The dashboard doesn't wait for a click either: its watchdog
   restarts a stalled fetch-all by itself (up to three times per session, so
   a board that can't be logged into can't spam tabs) and reopens the board
   so the extension picks the page-walk back up.
3. **Approve what you want.** Match %, experience, location, pay and
   freshness are on every card; *Approve* makes a job eligible. The agent
   never applies to anything you did not approve.
4. **Apply — one run, walked by the agent.** *Apply to approved (N)* starts a
   run on the dashboard: the queue is capped (25 by default), ordered by
   match %, and the first job opens in a tab. When that page finishes, the
   extension reports the outcome and asks for the next job, opening it in the
   background — the run advances by itself with nothing left open. A CAPTCHA
   or an unanswerable required question marks that job **halted** and the run
   moves on; the popup shows `Applying 3/10 · 2 applied · 1 halted` and the
   dashboard's apply step keeps the same count plus the log.Everything is server-driven and stateful: close the popup, close the
	dashboard — the queue, the sweep and the halts are all recorded, and the
next page load resumes where the run left off. If the run's own tab dies
before the queue is exhausted, nobody is left to ask for the next job — so
both sides pick it up on their own: the dashboard's watchdog (and the
worker, on browser start or any wake-up) notices that nothing has reported
for 2½ minutes and takes the next unattempted job itself (the server marks
it attempted first, so the dashboard and a live page can never both get the
same job), opens it in the background, and the chain continues by itself
from there. The manual **Resume — open queued job N of M** button stays on
the apply step for when you want to nudge it immediately. Dead-queue paths
are covered by `../e2e/apply-run.test.js` and `../e2e/queue-resume.js`.

## Two ways it applies

**Autopilot (hands-free).** Approve jobs in the dashboard (step 4), hit
*Apply to approved jobs* (step 5), and with the popup's autopilot toggle on,
each opened job page is filled and submitted by itself. The extension checks
the dashboard before doing anything: it only ever auto-applies to jobs whose
URL matches one you approved. Results (applied ✓ with the on-page
confirmation, or halted with the reason) are reported back to the dashboard
log.

**Landing pages and redirects.** Job pages usually start with just an Apply /
Easy Apply button — no form. Submit mode clicks that opener, waits for the
form, then fills and finishes it. If Apply navigates to a company ATS on
another origin (Workday, Greenhouse, Lever…), an in-flight marker in
`chrome.storage.local` carries the run across: the next eligible page resumes
it within 5 minutes, re-checking the dashboard decision first. Any concluded
run — applied or halted — clears the marker, and an already-`applied` job is
never touched again.

**Reports survive a restart.** A submitted job's card leaves the dashboard
only when its report reaches the dashboard, and that POST can die with a
restarting server or a closing tab. The verdict is therefore written to
`chrome.storage.local` *before* the send and deleted only on a server
acknowledgement; the service worker re-sends whatever was never acknowledged,
at browser startup and on every wake. A job you have already applied to is
never listed again, however many times the dashboard or the browser restarts
in between.

**Per page.** Open any application, click the extension icon:

- **Fill & submit** — fills every field, clicks through Next/Continue steps,
  submits, and waits for the confirmation message.
- **Fill only** — fills and stops; you review and press Submit yourself.

## The location prompt never interrupts

Boards ask the browser for your location mid-form ("www.naukri.com wants to
know your location"). That prompt is browser UI, not page DOM — no content
script can click it, so it used to sit in the middle of a run waiting for a
human. `geo-shim.js` (generated by `node build-fillpack.js` from the
`geolocation` block of `../autofill.json`) runs in the **page world** at
`document_start`, before any site script can ask: it answers the page's own
`navigator.geolocation` calls with the coordinates on record and reports the
permission as `granted`, so the prompt never appears — and a site that checks
`permissions.query()` first doesn't render its own ask-location button
neither. The answer comes from your pack once, for every page: allow nothing,
click nothing, the run just proceeds. Delete the `geolocation` block to get
the normal browser prompt back. The shim never touches Chrome's geolocation
API, so it needs no manifest permission of its own; `node test-geo-shim.js`
(14 checks) proves the coordinates are served, the browser's own API is never
reached, other permissions pass through, and the no-coordinates variant stays
silent.

## Connect is verified, not assumed

"I'm signed in — connect" is a claim, not a fact — so the dashboard never
takes it at face value:

1. Clicking connect puts the board in **verifying session…** and opens it.
2. The extension reads the live page for evidence — a `Sign out` control or
   profile link means logged in; a password form or `Sign in` / `Register`
   control means not — and posts the verdict (`chrome.runtime` message relayed
   through the background worker, because a direct fetch from a board page to
   `127.0.0.1` can be blocked silently by the page's CSP).
3. **Verified** → the board connects and its jobs are fetched in the same
   breath. **Not signed in** → it stays out and says "log in in the opened
   tab, then connect again". **No signal yet** → it keeps waiting (headers
   render late on SPA boards — null verdicts re-check every 30s).
4. If the extension can't tell at all (or isn't loaded), the card offers
   **Connect without verifying** — your explicit choice, recorded as such in
   the log. Signing out later disconnects the board again.

## Fresh jobs from the boards you selected

The dashboard's match list is not a static dump. Whenever a job-board page
is open — search results, a job page, even the "more jobs" rail — this
extension reads the listing cards in **your own logged-in tab** and POSTs
them to the dashboard (`/api/harvest`), where they are scored against the
resume, badged ⚡ fresh, and deduplicated (re-fetching never duplicates a
job). Each listing carries the text printed on its card — company, **years
of experience**, **location**, pay and how old the post is — so the cards in
the popup read like the board itself. Board navigation ("Data Science jobs",
"Jobs in Mumbai") is filtered out: a link that is not a job-detail URL is
only accepted when its own row already shows real job text. Connecting a board opens its list page so fetching starts at once;
**Fetch fresh jobs ↗** on a connected board re-opens it anytime. Everything
is enforced server-side:

- a board that is **not connected** gets a 403 — it can never put a job in
  front of you, no matter where the scrape came from;
- every listing's URL must map back to the **same board** that claimed it —
  a page tagged Naukri cannot smuggle linkedin.com links in;
- disconnecting hides that board's jobs again (approvals and apply history
  are kept).

So the rule the dashboard follows is exactly the one you asked for: *only
jobs from boards I selected, fetched fresh, and never LinkedIn jobs while
LinkedIn is off.**

## What it will never do

- **Never drives a board's search page.** Keyword / location / experience
  boxes with no identity fields and no job-detail URL are refused as
  `not-an-application`: it clicks nothing — not the search button, not
  pagination, not a card's "Easy Apply" — and says *open a specific job*.
  (Before this, a results page produced "Stuck on step 3: clicking Next did
  not advance the form" and could page through results.)

- **Never submits anything you didn't approve.** Autopilot requires the job
  to be in your dashboard's approved/queued list; the popup buttons require
  your click. Browsing LinkedIn normally does nothing.
- **Never pays.** Pay/purchase/checkout controls are excluded from both
  filling and clicking, even in submit mode.
- **Never fights a CAPTCHA.** reCAPTCHA/hCaptcha halts the run — fill *and*
  submit — and reports it; you solve it and run again.
- **Never guesses.** A null value in the fill pack is left blank. If the
  field is marked `required`, submit is blocked and the field is reported —
  it will not send an application with a blank required answer.
- **Never double-applies.** Jobs already marked `applied` in the dashboard
  are skipped on later page loads.

## Data

The pack is generated from `../autofill.json` — the same file the dashboard
serves, so there's one source of truth. Edit that file, then regenerate:

    node build-fillpack.js

That prints the ready/open counts so you can see what the pack will fill.

## Checks

    node --check matcher.js content.js popup.js build-fillpack.js geo-shim.js test-engine.js
    node test-matcher.js
    node test-engine.js
    node test-geo-shim.js

Dashboard side (with `node ../server.js` running on 127.0.0.1:8357):

    node ../e2e/apply-run.test.js   #  36 checks — approved-only queue, cap, next, halt, summary, stalled sweeps
    node ../e2e/queue-resume.js     #  17 checks — a dead tab's run resumes from the dashboard, in Chromium
    node ../e2e/sweep.test.js       #  17 checks — fetch-all progress + connection gate
    node ../e2e/popup-jobs.js       #  26 checks — board chips, job cards, apply run, live in Chromium
    node ../e2e/harvest-details.js  #   8 checks — experience/location/pay scraped from a real board page
    node ../e2e/sweep-live.js       #   7 checks — the walker clicks Next on a real board
    node ../e2e/search-page-guard.js #   6 checks — a board's SEARCH page is refused, nothing clicked
    node ../e2e/yes-no-widget.js    #   9 checks — the real yes/no + option-list widgets, in Chromium
    node ../e2e/session.test.js     #  24 checks — connect requires login proof
    node ../e2e/gating.test.js     # 106 checks — connection gates every board
    node ../e2e/harvest.test.js    #  28 checks — fresh jobs, selected boards only

`test-matcher.js` (86 cases) runs the label matcher against real Workday /
Greenhouse / Lever / Ashby / Indeed label conventions. Worth re-running after any edit
to `matcher.js` — the first version shipped with rules that failed on
"Primary Email" and "State/Province", which only showed up once the suite
covered label *variants* rather than one spelling per field.

`test-engine.js` (216 cases) executes the engine against a minimal fake DOM:
it fills real fields, leaves null questions blank, ignores unknown fields,
picks select options, advances a multi-step wizard, clicks the real submit
control in submit mode and never in fill-only mode, refuses to click pay
controls, blocks submit on unanswered required fields, halts on a CAPTCHA in
both modes — but only when the challenge is actually *rendered* and is a real
checkpoint: Lever ships an invisible hCaptcha scoring iframe on every apply
page, ATSes keep a hidden response input in the DOM forever, and
greenhouse/foundit carry reCAPTCHA's floating corner badge (documentation, not
a challenge), and none of those halt a run — while a real challenge popup
still does — and — the autopilot contract — submits only for a job approved in
the dashboard and reports the outcome back. It also covers the landing-page
opener (Apply/Easy Apply opens the form, then it submits) and the cross-origin
resume marker: a fresh marker resumes and reports, a stale one is discarded,
and markers for applied or denied jobs are cleared without touching the page.
It also covers the ways a wizard can stall — a Next click that changes nothing
(`step-stuck`, clicked once, not twelve times), one refused by on-page
validation (`validation-blocked`, quoting the page's own error text), one
refused by the browser's own HTML validation, which prints nothing at all
(`validation-blocked`, naming the empty required field and why), and one
announced only to a screen reader (`validation-blocked`, quoting the live
region) — the four ways a finish control is recognised (below), including a
submit button that only enables itself after the page's own validation
settles, question text that was never wired to its input (a `<span>`/`<td>`
beside the field, a legend, or `aria-describedby`), and an autocomplete picker,
where typing the value is only half the job and the selection is the row you
click — only an exact match of the value we meant is ever clicked.

## How it reads a question

Not every ATS wires its question text to the input. Legacy layouts put it in
the next table cell and leave the input with a machine name like `_r_3_`, and
comboboxes carry no text at all — just a placeholder reading "Search". The
engine reads, in order:

1. a real `<label>`, a wrapping label, `aria-labelledby`, `aria-label`;
2. the text immediately next to the field — previous sibling, neighbouring
   table cell, whatever precedes it inside its own container;
3. `aria-describedby`, when the input describes itself;
4. the legend of the fieldset it sits in, then a section heading above it;
5. the placeholder;
6. the field's `name`/`id`.

A **yes/no pair** gets one extra reading, because its own labels say nothing:
when a radio or checkbox only says "yes"/"no", the engine reads the wording
printed above the pills — the paragraph or heading directly before the option
row, or the label-style prompt inside the same block ("Do you have…", "Are
you…", anything ending in "?"). That wording is what the question bank is
matched against, and it is what a halt report quotes. The pair is also treated
as one group by DOM container when the radios carry no `name` attribute at all
(custom React widgets), so the agent clicks exactly one option and never a
neighbouring question's radio.

An **option-list question** ("What is your notice period?" with seven pills and
nothing but a `Save` button) works the same way and needs one more rule:
`Save` advances the step — it is never the finish. A questionnaire modal whose
only control is a bare `type=submit` Save used to be clicked as Submit and
reported "application sent" after answering a single question; `Save` now wins
only as the advance control, a real `Submit` always outranks it, and a page
with nothing else is reported honestly instead of claimed as sent. The answer
itself is a **choice**, so the bank entry carries `choiceOnly` (an option label,
never free text — a "notice period in days" box still gets the pack's own text
answer) and `fallback` (the option to pick when the offered list contains no
matching answer, e.g. `Skip this question` — recorded as skipped, never as an
answer that isn't true).

A real label always outranks nearby text, which outranks a placeholder, which
outranks a `name` — and a halt report says **which** of those the text came
from, so a placeholder reading "Search" is never mistaken for the question.

When a matched text field is filled and a picker list appears (`role=option`,
a dropdown's `<li>`s, suggestions), the engine clicks the row whose text
matches the value it typed — exactly, after normalisation. A near-miss is left
alone; a wrong row would answer a question that was never asked.

A question the pack has no answer for is **asked, never guessed**: `languages`
joined the still-open list after a step refused to advance at "Select language"
— nothing on record said what to answer, so the run stopped and said so rather
than picking "English". Add your own answer to `../autofill.json` and that gate
stops blocking.

## Screening questions — the question bank

ATS screening questions are free text, so the pack carries its own bank in
`../autofill.json` (regenerate with `node build-fillpack.js`):

```json
"questions": [
  { "match": "form ?16", "answer": true,  "label": "Do you have Form 16 and P/F A/c of current & previous company" },
  { "match": "immediate joiner", "answer": false, "label": "Can you join immediately" },
  { "match": "\\bpan\\b", "answer": null,  "label": "PAN number" }
]
```

- `match` is a case-insensitive regex run against **normalised** text
  (lowercase, punctuation → spaces, so `P/F` is `p f`). The pattern that
  explains the most of the question wins; a tie goes to the earlier entry, so
  put the narrow question first.
- `answer` is what the agent answers — `true`/`false` for a yes/no pair, or a
  string. `null` means **ask me**: it is reported by its `label` and left
  blank, exactly like a null pack field.
- A yes/no answer is only used on a yes/no control (radio, checkbox, select).
  A free-text box that merely mentions the topic — "PF number" — is never
  filled with `true`.

The question is read from the wording above the pair, never from the option
text — the real Form 16 widget labels its radios only "yes" and "no", so the
option label alone is a guaranteed miss and the question above it is the only
signal. The wordings currently answered: Form 16 + P/F A/c (yes), PF account of
current & previous employer (yes), immediate joiner (no), valid passport (no),
and availability for a virtual interview on the dates the board names (yes).
PAN and Aadhaar are deliberately `null` — the agent asks rather than inventing
an ID number. Add a line to `questions` for any screening question a form
keeps asking you, and it is answered from then on.

`../e2e/yes-no-widget.js` runs this end to end in Chromium against
`../e2e/fixtures/yes-no-widget.html`, a copy of the reported widget: the Form 16
pair ("yes" from the pack) and a nameless passport pair ("no"), both answered
and the form submitted — 7 checks.

## How it finds the finish control

Submit buttons are not always labelled "Submit". The search runs in order of
confidence, and the weaker rungs only apply to a page *this run actually
filled something on*:

1. **An unambiguous label** — Submit / Finish / Send my details / Complete
   application. Trusted anywhere. Controls reading "finish later" or "save
   draft" are never taken for a submission.
2. **An apply-shaped label** (Apply / Easy Apply / Done) **when the step
offers no Next/Continue control** — on a one-page form the Apply button *is*
the submission. This rung is skipped when a Next exists, so a wizard's Apply
CTA can't be mistaken for the finish line.
3. **The form's own submit button.** `<input type=submit>`, or a `<button>`
with no type inside a `<form>` — by definition the control that sends the
form. This is what catches localized and icon-only footers ("Absenden").
4. **A second look over ~6 seconds.** Async-validation ATSes enable Submit only
after their own check settles, and some render their footer late; looking once
instantly declared such forms "unrecognised".

A div that merely *wraps* the form also contains the word "Submit", so only
short labels qualify as buttons, and pay controls are filtered out before any
hint sees them.

## When a run halts mid-form

The popup names the reason, and every halt is written back to the dashboard
log. The messages are meant to be pasted straight into a bug report:

| Message | What it means |
|---|---|
| `Stuck on step N: clicking "Next" did not advance the form — the page says "Please complete all required fields".` | The step refused to advance. The quoted text is the site's own message — that field is what needs an answer. |
| `Stuck on step N: clicking "Next" did not advance the form — 1 field is blocking it — "_r_3_" (text) — required, still empty.` | The browser's own HTML validation is refusing, which prints no error text: the named field is empty and marked required, and the engine cannot identify it from the page. This is the most common silent stall. |
| `Stuck on step N: … — the page announced "Select language is required"; 1 field is still empty — "Employment Type" [emp_type] (select: --Select--); controls here: "Next" (advances the form).` | A refusal with no error class: the wording appeared only in a live region (`role=alert` / `aria-live`), so it is quoted as it stands — live-region text is never filtered, because "Select language is required" matches no error wording the engine looks for. Then what is still empty (with a dropdown's options), what could not be placed, and which controls the step offers. |
| `Stuck on step N: … fields it couldn't place: "Some question" [field_7] (select: Yes, No), "_r_9_" (text).` | The step did not move and the page said nothing. Each field is named as tightly as the page allows — question text if it exists anywhere near the input, its machine name in square brackets, its type, where the text came from, and a dropdown's options. |
| `Cannot submit: required field(s) unanswered — identity.languages. Also blocking: "_r_3_" (text) — required, still empty. Answer them, then run again.` | Two kinds of blocker in one message: a question the pack holds no answer for (add it to `../autofill.json`), and a required field the page refuses on without ever labelling it. |
| `Gave up after 12 form steps on <host> without reaching a submit control` | The form kept advancing but Submit was never found on `host`. |
| `No submit control on <host>: N fields filled, but nothing on this page finishes the application. There is no reachable Apply/Easy Apply control here to open the form. Controls seen: "Next" (advances the form), "Back". Review and submit yourself.` | Nothing to open, nothing to advance to, nothing to submit. The second sentence says *which* case it is: either no opener is reachable, or `"Easy Apply" was clicked, but the form it should have opened never appeared.` The list names the controls that *are* there — screen-reader "Skip to …" aids and off-screen controls never take a slot, and the five slots go to what could finish, advance or open the form first (LinkedIn's skip links used to eat all five, hiding whether an Apply control existed). When it says *no clickable controls found in this frame*, the form itself is out of reach — most likely inside an iframe. |

## Scope

`manifest.json` is limited to ATS domains plus `http://127.0.0.1:8357/*`
(your local dashboard). No `<all_urls>`, and only `activeTab` / `scripting` /
`storage` permissions beyond that. The extension does nothing on any other
site.

## Known gaps

- Repeatable Workday sections (multi-employer Work History with "Add another")
  are **not** automated. The pack holds your 7-entry timeline; the extension
  fills single-instance fields. Adding repeatable-section support is the next
  real chunk of work.
- File uploads (resume/CV) depend on the board pre-attaching your stored
  resume; the extension never uploads a file itself.
- Workday's application chooser ("Autofill with Resume" / "Apply Manually" /
  "Use My Last Application") **is** handled — "Apply Manually" is preferred,
  because the resume route needs that upload. What is not handled is the
  account it asks for next: **Create Account** wants a password, which is a
  credential the agent never types. Create the Workday account (or sign in)
  once by hand on that tenant; the saved session covers every later job there,
  and the halt message (`needs-account`) names the wall instead of reporting a
  missing submit button.
- Form layouts vary. If a field is missed, the halt message names the question
  text, the machine name, the control type and (for a dropdown) the options it
  offered — that is enough to add the rule to `matcher.js` in one pass.
- The content script runs in the **top frame only**, so a form embedded in an
  `<iframe>` is invisible to it. The halt message says so explicitly rather
  than pretending the layout is unrecognised.
- Picker options are only clicked on an **exact** match after normalisation
  ("Bengaluru", not "Bengaluru Urban"), so a board whose option text differs
  from the pack value keeps the typed text instead of a guess. The typed text
  is usually enough; if it isn't, the halt report shows the options it offered.
