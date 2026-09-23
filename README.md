# JobFit

**Screens job postings against your CV, entirely on your own machine.**

A Chrome extension that reads the job posting in your current tab, checks it against
your profile, and gives you a score, the concrete matches and gaps, and a salary
read — using a local model through [LM Studio](https://lmstudio.ai/). No API keys,
no per-call billing, and no posting or CV ever leaves your computer.

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

## How it works

Two layers, cheapest first.

**Layer 1 — deterministic, instant, free.** A keyword scan for things that end the
conversation regardless of fit. You configure it by ticking categories — *US
citizenship or permanent residency*, *no visa sponsorship*, *security clearance*,
*ITAR*, *already living locally* — and adding any plain phrases of your own. These
are yes/no facts, so no model is involved. A hard reject resolves immediately and
never reaches the queue.

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
  "within your range" while also stating a ceiling below the floor.
- **Seniority check.** Keyword presence plus a threshold, and only ever against a
  salary the posting actually stated — never against the model's own estimate,
  which made the check circular.
- **Score caps.** The prompt asks the model to cap its own score for uncovered
  required skills; the cap is then enforced in code regardless.

## Setup

1. Install and start [LM Studio](https://lmstudio.ai/), load a model, and start its
   local server (default `http://localhost:1234`).
2. Clone this repo.
3. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select the `job-fit-evaluator/` folder.
4. Open the extension popup and fill in:
   - **Local model** — endpoint and model name. Start with reasoning effort `low`
     and thinking off; see [Model notes](#model-notes).
   - **Candidate profile** — your CV summary, under ~400 words. The shipped text is
     a template showing the useful shape; replace it with yours.
   - **Expected salary** — optional, per currency. **Suggest all** will estimate
     from your profile if you'd rather start from something.

Then open a job posting and click **Evaluate this tab**.

## Using it

**Evaluate.** A banner appears in the page with the score, verdict and a one-line
read; **Details** expands to matches, gaps, required gaps, warnings and salary.

**Queue.** Clicking Evaluate on a second posting while the first is still running
queues it — up to 10. Click through a search page, queue everything that looks
plausible, and come back later; the toolbar badge counts down. The queue survives
browser restarts and pauses itself (rather than burning through every item) if
LM Studio goes away.

**Tracked jobs.** Everything evaluated is kept, sortable by score, with an
application status pipeline (not applied → applied → interviewing → offer /
rejected / ghosted), free-text notes, search across the posting body, and CSV
export.

**Backup.** *Back up all data* writes a JSON file containing your profiles,
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
- Host permissions are `localhost`, `127.0.0.1`, and `*://*.greenhouse.io/*`. The
  last one exists only so the extension can read a Greenhouse job board that a
  company career site embeds in a cross-origin iframe — without it Chrome won't
  let a script into that frame, and the posting is invisible. It is read access
  to job-board pages, nothing more; no data leaves your machine because of it.
- Everything is stored in `chrome.storage.local` on your machine.
- **Form subtrees are stripped before any text is sent to the model.** This is not
  incidental: job boards render the posting next to a part-filled application form,
  and an early version captured a name, email, phone number and résumé filename
  from one. The text extractor skips `<form>` and its controls outright.

## Supported sites

| Site | Notes |
|---|---|
| LinkedIn | Both `/jobs/view/…` and the search-results layout |
| Greenhouse | Classic job boards, the `my.greenhouse.io` candidate portal, and boards embedded in a company's own career site via iframe |
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
