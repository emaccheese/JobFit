# JobFit

**Screens job postings against your CV — on your own machine, or through the OpenAI API if you'd rather not run a model.**

A Chrome extension that reads the job posting in your current tab, checks it against
your profile, and gives you a score, the concrete matches and gaps, and a salary
read. By default it uses a local model through [LM Studio](https://lmstudio.ai/): no
API keys, no per-call billing, and no posting or CV ever leaves your computer. You
can instead pick **OpenAI API** as the provider and score with ChatGPT models using
your own API key.

It also keeps what it finds: every evaluated job is tracked, with application
status, notes and CSV export, so a month of searching doesn't live in browser tabs.

---

## Why local

Evaluating a few hundred postings through a hosted API is a real bill and a real
privacy question — your CV and salary expectations in someone's request logs. A
27B model on a laptop is entirely good enough for "does this posting match this
CV", so the whole thing runs against `localhost`.

The extension talks to any OpenAI-compatible endpoint, so LM Studio is the default
but not a requirement.

**Or use the OpenAI API.** If you'd rather not run a model locally, set the provider
to **OpenAI API** (in the setup wizard, or **Settings → Model**), paste your API
key and pick a tier: **Economy** (gpt-6-luna, about $0.05 per 100 postings),
**Balanced** (gpt-6-sol, about $1 per 100, the default) or **Best** (gpt-6-astra,
about $5 per 100), or any other chat model your key has. Bulk re-evaluations from
Tracked jobs use OpenAI's Flex processing at about half price, and a daily token
budget (200k by default) pauses the queue before a runaway batch gets expensive. The tradeoff is explicit:
every evaluated posting, your candidate profile and your salary expectations are sent
to OpenAI, and each request is billed to your key. The key stays in this browser's
extension storage and is never written to a backup file. Switching back to LM Studio
keeps the key, so you can go back and forth. Scores from different models are marked
as out of date against each other in Tracked jobs, as before.

## How it works

Two layers, cheapest first.

**Layer 1 — deterministic, instant, free.** A keyword scan for things that end the
conversation regardless of fit. You configure it by ticking categories — *citizenship
or permanent residency*, *no visa sponsorship*, *security clearance*, *ITAR*,
*already living locally* — and adding any plain phrases of your own. These are
yes/no facts, so no model is involved. A hard reject resolves immediately and never
reaches the queue.

The rules are **per country**: you say which countries you apply in and whether you
are a citizen, already allowed to work, or would need sponsorship in each. "No visa
sponsorship" then rejects a San Diego posting for someone who needs a US visa, and
is ignored on a Tijuana posting for a Mexican citizen. The categories match posting
language in English, Spanish, French and Portuguese. Warnings also flag an on-site
job outside your area when you won't relocate, a work arrangement you didn't ask
for, working hours far from your time zone, and a language you don't speak.

Phrases are matched as whole words automatically, which is not cosmetic: a bare
`ITAR` typed into the old regex box silently matched "mil**itar**y". Making
boundaries the compiler's job rather than the user's removes that whole class of
mistake. Raw patterns are still available under *Advanced* for anything the
categories can't express.

**Layer 2 — the local model.** Only postings that survive Layer 1 get scored. The
model returns structured JSON: score, verdict, matches, gaps, required-vs-preferred
gaps, and salary figures.

**What the model is deliberately not trusted with.** Anything deterministic is
computed in code, because local models are unreliable at it and fail confidently:

- **Salary comparison.** The model extracts numbers; the comparison against your
  expected range is arithmetic done in JavaScript. It once reported a posting as
  "within your range" while also stating a ceiling below the floor. When the posting
  gives numbers without a currency, the currency comes from the job's country (and
  says so), and "most offers fall between the minimum and the midpoint" makes the
  midpoint the realistic top.
- **Seniority check.** Keyword presence plus a threshold, and only ever against a
  salary the posting actually stated — never against the model's own estimate,
  which made the check circular.
- **Experience level.** A posting asking for far fewer years than you have ("2+
  years, academic experience acceptable" against your 8) is flagged *likely below
  your level* and capped at 70.
- **Score caps.** The prompt asks the model to cap its own score for uncovered
  required skills; the cap is then enforced in code regardless — but only for a
  skill the job really requires. A requirement worded as a low bar ("familiarity
  with", "exposure to") or offered as one of several options ("OpenCV, NumPy, … or
  PIL") costs 10 points instead.
- **The verdict.** Apply at 75 and up, borderline 55–74, skip below 55, from the
  final score. A posting that doesn't mention sponsorship gets an amber warning (when
  you'd need it there), not a lower verdict.

**Learning.** Skills you're picking up (OpenCV, GoogleTest, ONNX Runtime…) go in
**Settings → Screening rules → Learning**. They're flagged for your information and
never cap the score, unlike domain flags, which mark real mismatches.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/), load a model, and start its
   local server (default `http://localhost:1234`).
2. Clone this repo.
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select the `job-fit-evaluator/` folder.
4. The **setup wizard** opens in a new tab on first install. It walks through, in order:
   - **Language and location**: the language is detected from your browser
     (English, Spanish, French or Portuguese) and can be changed any time. Your
     location is guessed from the browser's time zone — offered, never assumed,
     and never sent anywhere.
   - **About you**: a profile name, the countries you apply in, and your right to
     work in each. Your answers tick the matching hard rejects.
   - **Work preferences**: remote/hybrid/on-site, relocation, the languages you
     work in, and whether the model may be told your city.
   - **Model**: tests the connection and lists the models LM Studio has
     loaded, so you pick one instead of typing its name.
   - **Candidate profile**: paste your CV and the local model drafts the ~400-word
     summary, or write it yourself from the template.
   - **Expected salary**: per currency of the countries you apply in, each with its
     own pay period (monthly pesos, yearly dollars), with a suggestion from your profile.
   - **Hard rejects**, **Warnings** and **Domain flags**: the flags can be
     suggested from your profile's Gaps line.
   - **Review**: every setting on one page, plus a test evaluation of a sample
     posting (or one you paste) that isn't saved to your tracked jobs.

   Everything saves as you go. Close the tab early and the popup offers
   **Continue setup**. To run it again later, use **Run setup wizard for this
   profile** in **Settings → Profile**; **New profile…** there opens it too.
   Every setting stays editable in **Settings** (the ⚙ in the popup, or
   right-click the JobFit icon → **Options**).

Then open a job posting and click **Evaluate this job**.

## Using it

**Evaluate.** Open the posting and press **⌘⇧E** on a Mac, or **Alt+Shift+E** on
Windows and Linux. It works on any site, with no clicks. You can also click the
JobFit icon, then **Evaluate this job**. You can change the shortcut at
`chrome://extensions/shortcuts`, or from **Settings → On-page button and shortcut**.

**The popup** is for the job in front of you. If you've scored it before, it shows
the saved score and verdict, when it was scored and whether it's out of date (another
model, or a profile you've edited since), with **Show on page**, **Re-evaluate** and
**Open in Tracked jobs**. Below that it says whether the model is reachable, with a
**Fix in Settings** link when it isn't, and how the queue is doing. Everything you set
once lives in **Settings**, a full page with a section for each: profile and CV,
salary, screening rules, model, the on-page button, language, and backups.

**On-page button (optional).** A card in the corner of job postings that evaluates the
posting with one click, and already shows the score when you open a job you've scored
before. It never evaluates on its own, and it's off everywhere until you turn it on:

- **For a whole job board** (LinkedIn, Indeed, Greenhouse, Workday): in
  **Settings → On-page button and shortcut**, tick the board or press **Turn on for all
  job boards**. Or open a posting on that board and tick **Show the JobFit button on all
  {board} job pages** in the popup. A board is one Chrome permission covering all of it:
  every Indeed country, LinkedIn's country sites, every employer's Workday site.
  Greenhouse needs no prompt, because JobFit already has access there.
- **For a company's own career site** (Jibe, Eightfold, a Greenhouse board embedded on
  the company's domain): open it and tick **Show the JobFit button on {site}** in the
  popup. On a site with an embedded Greenhouse board, the card shows the job in the
  embed.

Hover the card for **–** to shrink it to just the score, or **×** (twice) to turn it off
for that board or site and give the access back. You can also do that in Settings.

The result opens in a panel from a card in the corner of the page, whichever way
you started it: the score, the verdict and a one-line read, then sections for
required gaps, matches, gaps, warnings and salary, with **Re-evaluate** and
**Tracked jobs**. The card doesn't cover the site's navigation. Drag it up either
edge, or use **⇄** to move it to the other side; the spot is remembered per site.
Press Esc to close the panel.

**Queue.** Clicking Evaluate on a second posting while the first is still running
queues it — up to 50. Click through a search page, queue everything that looks
plausible, and come back later; the toolbar badge counts down. The queue survives
browser restarts and pauses itself (rather than burning through every item) if
LM Studio goes away.

**Tracked jobs.** Everything evaluated is kept, sortable by score, with an
application status pipeline (not applied → applied → interviewing → offer /
rejected / ghosted), free-text notes, search across the posting body, and CSV
export. On a wide window the list and the selected job's details sit side by side;
narrower, a job opens under its row. The status chips (Needs attention, Not applied,
Waiting, In play, Closed) are the filter; the exact status and *Hide hard rejects* are
under **More filters**. It works from the keyboard: `/` search, `j` / `k` next and
previous job, `Enter` or `o` details, `1`–`7` set the status, `x` tick for
re-evaluation, `Esc` back, and `?` lists them all.

**Backup** (in **Settings → Data**). *Back up all data* writes a JSON file containing your profiles,
LM Studio settings and every tracked job — status, notes and briefs included,
all of which the CSV leaves out. *Restore from backup* merges a file back in
and **never overwrites anything already present**, so restoring an old backup
can't discard a status you've updated since. Worth doing before you touch
`chrome://extensions`: uninstalling an extension erases its storage with no
warning and no undo.

**Briefs.** *Summarize* condenses a posting into a compact brief — role, stack,
required vs preferred, comp, visa language — with the local evaluation appended,
for pasting into another assistant that already knows your CV.

**Multiple profiles.** More than one candidate can be tracked separately, each with
its own CV, salary expectations and screening rules. Scores never mix: the same
posting evaluated for two people is two records.

## Privacy

- **No posting or CV is sent anywhere except your own `localhost`.** There is no
  cloud mode and no telemetry.
- The on-page button is off everywhere by default. Each job board or site you switch it
  on for is a separate Chrome permission you grant (and can revoke) for that board or
  site alone.
- Host permissions are `localhost`, `127.0.0.1`, and `*://*.greenhouse.io/*`. The
  last one exists only so the extension can read a Greenhouse job board that a
  company career site embeds in a cross-origin iframe — without it Chrome won't
  let a script into that frame, and the posting is invisible. It is read access
  to job-board pages, nothing more; no data leaves your machine because of it.
- Everything is stored in `chrome.storage.local` on your machine.
- **Your location** is detected from the browser's time zone, never from GPS or an
  IP lookup, and is stored locally. The model is told your city and region only if
  you turn that on in the wizard; the countries you apply in and your work
  authorization are always included, since they don't identify you.
- **Form subtrees are stripped before any text is sent to the model.** This is not
  incidental: job boards render the posting next to a part-filled application form,
  and an early version captured a name, email, phone number and résumé filename
  from one. The text extractor skips `<form>` and its controls outright.

## Supported sites

| Site | Notes |
|---|---|
| LinkedIn | Both `/jobs/view/…` and the search-results layout |
| Greenhouse | Classic job boards, the `my.greenhouse.io` candidate portal, and boards embedded in a company's own career site via iframe |
| Indeed | Job pages and the search-results side panel |
| Workday | `*.myworkdayjobs.com` postings, including the search panel |
| Jibe (iCIMS) | Company career sites built on Jibe, e.g. careers.keysight.com |
| Eightfold | Company career sites built on Eightfold, e.g. careers.qualcomm.com, including the search page where the selected job opens beside the results list |
| Anything else | Generic extractor — finds the largest visible content block |

Site-specific extractors give better titles, companies and locations. The generic
fallback usually gets the posting body right on its own.

Postings are identified by a canonical job key, not a URL: the same LinkedIn job is
reachable under several URLs with tracking parameters that change per search, so
keying on the URL would file the same job repeatedly and defeat the
already-evaluated check.

## Model notes

Throughput varies enormously between local models — one measured ~65 tok/s and
another ~17 tok/s on the same schema — so the response timeout is a setting rather
than a constant.

Watch out for reasoning models: several default to maximum reasoning effort and
will produce thousands of tokens of internal monologue before answering, or write
the answer *inside* the reasoning trace and never emit it as content. The extension
handles the second case by scanning the reasoning output for the JSON, but the
practical fix is setting reasoning effort to `low` and disabling thinking.

## What it deliberately doesn't do

- **Rewrite your CV or generate cover letters.** It tells you whether to apply.
- **Auto-apply.** No form filling, no submissions.
- **Send anything to a hosted API.** There is no cloud mode.

## Design notes

[`DESIGN.md`](DESIGN.md) is the working document: the architecture, and — more
usefully — a log of what broke in testing and why. The PII leak, the extraction bug
that flattened every bulleted requirement into prose, the silent truncation that
was scoring postings on their company boilerplate, and the reasons several things
are computed in code rather than asked of the model.

## License

MIT
