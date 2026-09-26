# JobFit — design notes

A Chrome/Edge extension that reads a job posting on the current tab, applies deterministic dealbreaker filters, and — when the posting survives the filters — sends it to a local LM Studio model for a structured fit score and keyword comparison against a stored candidate profile. No cloud API, no per-call cost.

**Scope: one weekend.** Anything beyond the MVP below is a separate decision, not a default.

---

## Why this design

- **Runs in the user's own browser session** — no scraping infrastructure, nothing to block. The user is already on the page; the extension just adds a verdict.
- **Two-layer evaluation** — cheap deterministic filters run first and stop early. The local model is only invoked for postings that pass, saving a round-trip (and your GPU/CPU) on obvious rejects.
- **Structured output** — the model returns JSON, not prose, so the UI can color a banner by score and every evaluation can be logged.
- **CV-vs-posting keyword comparison lives in the model call, not a hand-maintained list.** Layer 1's static "soft warning"/"positive match" regex lists were really just a manual copy of your own skills — redundant once the model already compares your profile against the posting text directly and returns `matches`/`gaps`. Layer 1 keeps only the dealbreaker regexes (citizenship, ITAR, sponsorship, etc.), since those check the *posting's* language, not your CV, and are worth catching instantly without waiting on a model call.
- **No API key, no cloud dependency — by default.** LM Studio's local server speaks the OpenAI-compatible chat completions format at `http://localhost:1234/v1/chat/completions` (port configurable). Since it's free and local, there's no cost pressure driving the two-layer split — Layer 1 survives purely for speed and determinism on dealbreakers.
- **OpenAI API as an opt-in provider** (added 2026-09-25). `modelProvider` chooses between LM Studio and OpenAI. `lmStudio` keeps its original shape, so no migration is needed, and it still owns the shared response timeout. `openai` holds `{ apiKey, model, reasoningEffort }`. `provider.js` resolves the active provider and model for every consumer (the request, the out-of-date check, popup readiness, queue auto-resume), so a switch can't leave one of them reading the old model.
  - **OpenAI requests are built separately** (`openAiRequestBody`), because OpenAI rejects parameters rather than ignoring them. There's no `/no_think` suffix and no penalties (those were local-model looping fixes), and `max_completion_tokens` replaces `max_tokens`. JSON mode (`response_format: json_object`) is on. Reasoning models (o-series, gpt-5) get `reasoning_effort` and no `temperature`; other models get `temperature: 0.2`.
  - **A missing key or model fails as `config`** before any request is sent, which pauses the queue with a message naming the fix. HTTP errors show OpenAI's own `error.message`.
  - **The model list comes from the key's own `/v1/models`**, filtered to chat models. The wizard defaults to a `-mini` model rather than whatever sorts first, since this provider bills per request.
  - **The key never leaves extension storage:** backups export only the OpenAI model choice, and a restore never touches the key or the provider switch.
  - **The privacy tradeoff is stated where you choose:** the wizard's provider cards and the popup's notice both say postings, the profile and salary expectations are sent to OpenAI and billed to your key.

---

## Tech stack

- Manifest V3 extension. Plain JavaScript, no framework, no build step.
- `content.js` — runs on the page, extracts posting text, applies Layer 1, injects the result banner, messages `background.js` for Layer 2.
- `background.js` — service worker. Calls the local LM Studio endpoint via `fetch`, adapts its OpenAI-compatible request/response shape, returns the parsed result to `content.js`.
- `popup.html` / `popup.js` — settings: LM Studio URL + model name, profile text, expected salary, hard-reject keyword list; "Evaluate this tab" (full pipeline, on-page banner) and "Summarize this tab" (condensed posting brief, copied to clipboard for pasting into another LLM that already has your CV/profile loaded — a separate, lighter action that doesn't run Layer 1/Layer 2 scoring).
- `chrome.storage.local` for settings and the evaluation log.
- Backend: LM Studio's local server, OpenAI-compatible `POST http://localhost:1234/v1/chat/completions` (URL and model name are editable in the popup — whatever you have loaded).
- Runs on Chrome on macOS via `chrome://extensions` → Developer mode → "Load unpacked". No packaging, signing, or store listing needed — Manifest V3 unpacked extensions work identically on Mac Chrome.
- **Trigger mode: manual only.** No auto-run content scripts. The popup requests `activeTab`, and evaluation (Layer 1 + Layer 2) only runs when you click "Evaluate this tab". `host_permissions` cover only loopback addresses (`http://localhost/*`, `http://127.0.0.1/*`) — no external host permission needed since nothing leaves your machine.

---

## File layout

```
job-fit-evaluator/
├── manifest.json
├── background.js        # API call, storage access
├── content.js           # DOM extraction + banner injection
├── content.css          # banner styles
├── defaults.js          # JOB_FIT_DEFAULTS — shipped defaults
├── profiles.js          # multi-profile store + migration
├── keywords.js          # screening categories + phrase→regex compiler
├── queue.js             # serial work queue (service worker)
├── evalstore.js         # evaluated-job history records
├── jobkey.js            # canonical job identity per page
├── history.html         # evaluated-jobs page
├── history.js
├── wizard.html          # setup wizard (first install, new profile, re-run)
├── wizard.js
├── lmstudio-ui.js       # shared by popup + wizard: messaging, /v1/models probe
├── popup.html
├── popup.js
├── extractors/
│   ├── greenhouse.js    # site-specific selectors
│   ├── lever.js
│   ├── linkedin.js
│   └── generic.js       # fallback: largest text block
└── README.md
```

---

## Layer 1 — deterministic dealbreaker filters (local, instant, free)

> **Configured as categories and phrases, not regexes** (2026-09-22). The three
> lists were raw regex typed into textareas, which put
> `graduat(ing|ion) (date )?(between|in) (20\d\d)` in front of someone whose job
> is not writing regexes — and made correctness their problem: a bare `ITAR`
> matched "military" until somebody thought to write `\bITAR\b`.
>
> The three lists turned out to be different kinds of thing and now have
> different UIs. **Hard rejects and warnings** are universal *categories* worded
> differently by every posting, so they are ticked from a curated list
> (`keywords.js`) — the patterns are maintained in one place and a profile with
> a category ticked inherits improvements to it. **Domain flags** are one
> person's skill gaps, so no preset could exist; they are plain phrases.
> Everything keeps an *Advanced* escape hatch for raw patterns.
>
> `phraseToPattern()` escapes metacharacters, matches case-insensitively, turns
> spaces into `\s+` (so a line break in the posting doesn't break a match) and
> adds `\b` only where the phrase begins or ends with a word character — so
> `C++` and `.NET` still work, which matters because those are exactly the terms
> people put in domain flags.
>
> Each compiled entry carries a human `label` — the category name or the user's
> own phrase — so a hard reject now reads
> `"must be a US citizen" — US citizenship or permanent residency` rather than
> quoting the pattern at them.
>
> **Migration:** an old flat array is read back through `fromLegacyList()`. A
> category is ticked only when *every* one of its patterns is present, so a list
> someone had edited down is never silently re-expanded; leftovers go to
> Advanced; and a fully-bounded `\bfoo\b` comes back as the phrase `foo`. A
> half-bounded one like `\bneural network` stays raw, because it matches
> "networks" and re-compiling it as a phrase would quietly stop it doing that.

Run regex against the extracted text. On any **hard reject** hit, show a red banner with the matched phrase and **stop** — do not call the local model.

### Hard rejects
```
/without (current or future )?sponsorship/i
/not (able|available) to sponsor/i
/no sponsorship/i
/must be (a )?(u\.?s\.? citizen|us citizen)/i
/u\.?s\.? citizen(ship)? (is )?required/i
/permanent resident/i
/green card holder/i
/\bITAR\b/i                      # word-boundaried: bare /ITAR/i matched the
                                 # substring inside "military", a false
                                 # positive found in testing
/security clearance/i
/graduat(ing|ion) (date )?(between|in) (20\d\d)/i
/currently pursuing a (bachelor|master)/i
/not able to (offer|provide) relocation/i
/no relocation (assistance|support)/i
/within (a )?(reasonable )?commut(ing|e) distance/i
/local candidates only/i             # added after testing: a hybrid role
                                      # with no relocation help and a
                                      # commuting-distance requirement is
                                      # functionally the same dealbreaker as
                                      # "no sponsorship" for a candidate not
                                      # already local — the model let one
                                      # through uncaught before this existed.
```

This is editable from the popup — ship with these as defaults.

### Warnings (amber — flagged, never blocking)
```
/export control/i
/master'?s degree (is )?required/i
```
A third editable list, distinct from both the hard rejects above and the domain flags below: posting language that needs the candidate's own judgment rather than an automatic verdict. Matches are shown in the banner and Details, included in the copy-paste summary, and **never** stop the model call or move the score.

The distinction that earns `export control` a place here rather than in hard rejects: ITAR genuinely requires US-person status, so it's a real bar, but general "export control" language often refers to EAR, which covers plenty of ordinary technology and is frequently satisfiable. On an otherwise-strong posting it's a reasonable question to raise with a recruiter, not a reason to never see the posting. `master's degree required` sits here for the reason established earlier — too brittle to regex-check "or equivalent experience" context safely. (It had been demoted to a soft-warning tier once before, then silently promoted back into hard rejects when the tiers were collapsed during the LM Studio pivot — restoring it here is a correction, not a new decision.)

**This is not a revival of the old soft-warning/positive-match tier.** That one was a hand-copy of the candidate profile's own skills, redundant with what Layer 2 derives from the posting and returns as `matches`/`gaps`, and deleting it was correct. This list is about *the posting's language* and carries no skill inventory.

### Domain flags (reintroduced after testing — see below)
```
/\bmachine learning\b/i /\bdeep learning\b/i /\bneural network/i
/\bPyTorch\b/ /\bTensorFlow\b/ /\bmodel training\b/i /\bcomputer vision model/i
```
A second, separate editable list — **not** a return to the old soft-warning/positive-match design. This exists because real-world testing showed the local model's own posting comprehension is unreliable: given a posting whose core requirement was machine learning (absent from the candidate profile), it echoed the profile's own "Gaps:" line (C#, distributed systems, etc. — none of which the posting mentioned) instead of noticing the actual gap. Domain flags are a deterministic backstop: matched terms are (a) shown in the banner immediately, before the model call, (b) fed into the Layer 2 prompt as an explicit checklist so the model can't miss them, and (c) always shown in Details after scoring, regardless of what the model's JSON says — so a reasoning failure is still visible to you even if the model doesn't self-report it.

---

## Layer 2 — local model scoring (only if Layer 1 passes)

> **Alternatives in requirements** (found in testing, 2026-09-17): the model was
> reading "Experience in one or more object oriented languages like C++, Kotlin
> or Java" as three requirements and filing Kotlin and Java as gaps. This
> pattern is everywhere in real postings, so it was inflating gap counts and
> depressing scores across the board. Fixed in the prompt, not in code —
> deciding whether an alternatives list is covered is exactly the judgment the
> model is there for; a regex can't tell "C++, Kotlin or Java" (any one) from
> "C++, CUDA and OpenGL" (all three). The rule also covers "such as", "e.g.",
> "or similar", "or equivalent" and "one or more of", states that an "and" list
> genuinely does require all of them, and says a gap is only warranted when the
> profile covers *none* of the alternatives — without that last clause the
> correction over-fires and every "or" list reads as automatically satisfied.
> The summarize prompt got the matching rule: flattening "C++, Kotlin or Java"
> into "C++, Kotlin, Java" in the brief would hand the same bug to whatever
> assistant reads it.

> **Structured brief, and every model's score in it** (2026-09-25): the
> summarize prompt asked for one free-text `summary`, so each model picked its
> own layout, and some put a score into a brief the model is never asked to
> score. The score came from JobFit itself: the banner and Details panel are
> appended to `<body>`, and the generic extractor walks the whole body, so the
> previous score, verdict, matches and gaps were read as part of the posting.
> That also meant re-evaluating on a generic-extractor site showed the model
> its own earlier verdict. `textFrom()` now skips `#job-fit-*` elements. The
> prompt returns fixed fields (role, seniority, location, responsibilities,
> required, preferred, compensation, work authorization, other notes), says to
> describe only the posting and to ignore any evaluation text in the input,
> and `assembleSummary()` builds the text, printing "not stated" rather than
> dropping a field. The evaluation block is still appended by code, never
> written by the model: `JOB_FIT_EVALSTORE.briefText()` lists one entry per
> model, newest first, the current result leading, each with its score,
> verdict, reason (`one_line`), matches, required and other gaps, and any
> cap. An older run from the same model is dropped, and a run scored against
> an earlier version of the profile is labelled as such.

> **"and/or", phrase-level alternatives, and domain-flag leakage** (found in
> testing, 2026-09-24): one posting hit both gaps at once. "C++ and/or Rust"
> filed Rust as a required gap, because "and/or" wasn't in the list of
> alternative markers. "Low-latency, high-throughput backend services or
> multi-threaded/concurrent data engines" credited the concurrent-engines side
> as a match and *still* filed the other side as a required gap, because the
> only example the prompt gave was a list of single languages. Both "Rust"
> and "low-latency" were also domain flags, and the old wording ("list it in
> required_gaps" if uncovered) read as permission to promote a flag straight
> into required_gaps, which is what the earlier KLA run did with "machine
> learning" taken from the job title. The prompt now names "and/or", gives a
> phrase-level example, forbids gapping any alternative once another one from
> the same requirement is a match, and states that domain flags are
> informational: a flag only becomes a required gap when the posting's own
> wording makes it one, never because it appears in the title or on one side
> of an "or".

> **Posting truncation** (found in audit, 2026-09-19): the posting was cut to
> the first 6,000 characters before being sent. Postings put company
> boilerplate first and qualifications, compensation and visa language LAST, so
> a head-slice threw away precisely the part being evaluated — a 6,583-char
> posting (an ordinary LinkedIn length) lost its entire MINIMUM QUALIFICATIONS
> section and its salary line, and was then scored on boilerplate alone.
> Nothing surfaced it: Layer 1 scans the full text so hard rejects still fired,
> and history stores the full text, so the banner looked normal. Now 12,000
> characters, and over that it keeps the head and the tail with an explicit
> marker naming how much of the middle was dropped, so the model knows the
> section it is reading is the end. `input_truncated` rides back on the result
> and shows as a "Heads up" row in the banner's Details.

> **Seniority flag on an invented salary** (found in audit, 2026-09-19):
> `checkSeniorityMismatch` fell back to the model's own `estimated_market_max`
> when the posting stated no salary. That made the check circular — the model's
> hunch about the role's seniority produced the estimate, the estimate tripped
> the flag, and the flag capped the score at 40. Verified: a posting stating no
> salary, with the model guessing 70–90k USD against a 150k floor, took a score
> of 88 down to 40. It now reads `posting_stated_max` only; no stated salary
> means no flag. `compareSalary` still falls back to the market estimate, which
> is fine — it reports a comparison rather than capping anything.

### Request
- Extracted posting text (trim to ~6k chars if longer — keep the top, that's where requirements live)
- Candidate profile (stored string, see below)
- System prompt instructing JSON-only output

### Prompt shape
```
You evaluate job postings against a candidate profile.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "score": <integer 0-100>,
  "verdict": "apply" | "borderline" | "skip",
  "location": "<city, country or 'remote' or 'unknown'>",
  "sponsorship": "explicit_yes" | "explicit_no" | "unstated",
  "matches": ["<up to 6 short phrases FROM THE POSTING the candidate clearly satisfies>"],
  "gaps": ["<up to 6 short phrases FROM THE POSTING the candidate is missing>"],
  "required_gaps": ["<items from gaps that appear under REQUIRED, not preferred, in the posting>"],
  "salary": {
    "posting_stated": "<as stated in the posting, with currency/period, or 'not stated'>",
    "posting_stated_min": <integer or null>, "posting_stated_max": <integer or null>, "posting_stated_currency": "<ISO code or null>",
    "estimated_market_range": "<model's estimate for this role/seniority/location>",
    "estimated_market_min": <integer>, "estimated_market_max": <integer>, "estimated_market_currency": "<ISO code>",
    "note": "<one sentence of context — NOT a comparison verdict>"
  },
  "one_line": "<one sentence a recruiter would say about fit>"
}

CRITICAL — matches/gaps must come from what THIS POSTING states, never copied from the profile's own "Gaps:" list. If the posting requires something the profile is silent on (not just something it explicitly disclaims), that silence IS a gap. Also: don't list something as a match while listing a closely related required skill as a gap (e.g. claiming "deep learning architecture experience" as a match while listing PyTorch/TensorFlow as gaps is self-contradictory — those tools are what that experience would require).

**Required/preferred classification is explicit, not inferred.** Testing showed gaps under a posting's "Nice to have"/"Bonus points" section were still landing in `required_gaps`, dragging the score down for things the posting didn't actually require. The prompt now forces a classification step per gap — check which section (Required/Must-have vs Preferred/Nice-to-have, headings vary a lot across postings) it appears under before deciding where it goes — rather than leaving the required/preferred split to the model's unstated judgment.

**`vs_candidate_expectation` is computed in `background.js`, not requested from the model.** Testing showed the local model comparing two numeric ranges is unreliable — it once reported "within" while the posting's stated ceiling was below the candidate's floor, a contradiction plain arithmetic doesn't allow. Range comparison is mechanical, so `compareSalary()` does it directly from the model's extracted min/max/currency fields: below (posting max < candidate min), above (posting min > candidate max), within (otherwise), unknown (no candidate expectation stored, no salary data at all, or a currency mismatch it won't silently convert). Same principle as Layer 1 hard-rejects and domain flags — anything that's actually deterministic shouldn't be delegated to the model just because the rest of the evaluation is.

Scoring guidance:
- Score = the proportion of REQUIRED items satisfied, not a gap count — a few gaps shouldn't tank the score when most required items are met. This replaces an earlier "count only required items" phrasing that wasn't explicit enough about *proportion*: testing showed 2-3 gaps against a majority of matches was scoring much lower than the actual fit warranted.
- Preferred-only gaps adjust the score by no more than -5 total, combined (not per item).
- A required language the candidate lacks (e.g. C#) caps the score at 60.
- "distributed systems" as a requirement caps at 45.
- Domain match (image/video/color/GPU/embedded) adds up to +15.
- A required domain-flag term (see below) the profile doesn't cover caps the score at 50.
- Salary is informational only — never lets the score/verdict move.

CANDIDATE PROFILE:
{{profile}}

CANDIDATE EXPECTED SALARY (per year):
USD: {{min}}–{{max}}, CAD: {{min}}–{{max}}, MXN: {{min}}–{{max}} (each "not specified" if blank)

DETECTED DOMAIN-FLAG TERMS IN POSTING (if any matched):
{{domainFlags}}

JOB POSTING:
{{posting}}
```

Expected salary is **three** dedicated structured fields (min/max for USD, CAD, MXN — the markets the candidate actually applies across), not one currency picker. A candidate targeting both US and Canadian roles needs both figures stored at once, or every Canadian posting falls back to "unknown" for lack of a comparable number — which is exactly what happened in testing before this was split out. `compareSalary()` looks up `expectedSalary[postingCurrency]` directly; if that currency was never filled in (or the posting's currency isn't one of the three), the comparison is "unknown" — no silent guessing at conversion rates. The "Suggest all" button asks the model for all three ranges in one call.

**Seniority/comp-mismatch check — also computed in code, for the same reason as salary comparison.** Testing showed the model can derive posting-accurate gaps but still miss the bigger-picture signal: a posting with no "senior/staff/lead/principal" language and a salary ceiling far below the candidate's floor is a stronger reason to skip than any individual skill gap, and the model didn't reliably surface it unprompted. `checkSeniorityMismatch()` in `background.js` runs a keyword regex against the raw posting text plus an 80%-of-floor threshold check against the matching currency's expected range — both mechanical, so neither is left to the model's judgment. When it fires, the score is capped at 40 (lower than the domain-flag cap, since this is explicitly a stronger signal) and shown in Details as its own "Seniority/comp check" section.

**Domain-flag score cap is now enforced in code too, not just requested via prompt.** The prompt still asks the model to cap its own score, but after two observed failures of prompt-only conditional-arithmetic guidance (gap-echoing, salary comparison), `applyScoreCaps()` re-checks it deterministically: if any domain-flag term overlaps the model's own `required_gaps`, the score is force-capped at 50 regardless of what number the model returned. Shown in Details as "Score cap applied" when it fires — general principle now: anything that's actually deterministic (arithmetic, keyword presence, range comparison) gets computed in `background.js`, not delegated to the model just because the rest of the evaluation is model-driven.

### Response handling
- Strip any accidental ```json fences, then `JSON.parse`.
- On parse failure, show the raw text in the banner and log the error. Don't crash. **Expect this to happen more often than with Claude** — local open-weight models are generally less reliable at strict JSON-only output, especially smaller ones.
- On fetch failure (LM Studio not running, wrong port): show a distinct banner state pointing at the cause ("Could not reach local model — is LM Studio running?") rather than a generic error.
- Color the banner: green ≥ 75, amber 55–74, red < 55.
- No rate cap needed — it's local and free either way.
- **Explicit client-side timeout (`AbortController`) on every LM Studio call, plus a generous `max_tokens` (16000) and mild `frequency_penalty`/`presence_penalty`.** Testing surfaced a "thinking"-mode local model (Gemma variant) that got stuck looping inside its own reasoning trace — 20K+ reasoning tokens, 6 minutes, empty final output — which without a cap just runs forever and eventually surfaces as a cryptic "message channel closed" error when Chrome's service-worker lifecycle kills the request out from under us. We now decide how long to wait, not Chrome. **The timeout, not `max_tokens`, is the actual governor of wait time** — a bigger token cap costs nothing for a request that finishes normally (the model stops itself), it's only a worst-case ceiling; size `max_tokens` for "enough room to finish a legitimate verbose reasoning pass" and size the timeout to match the model's observed tokens/sec at that ceiling. A background-service-worker keep-alive ping (`chrome.storage.local.get` every 20s during the fetch) runs throughout, since a bare `fetch()` awaiting a slow-but-legitimate response doesn't reset Chrome's ~30s worker-idle timer on its own.
- **The timeout is a popup setting (`lmStudio.timeoutSeconds`, default 300), not a hardcoded constant.** Two different models measured wildly different throughput on the identical schema — ~65 tok/s vs. ~17 tok/s — so a fixed value tuned for one model cut off a second, slower model's legitimate (non-looping) completion right as it was about to finish. Tokens/sec depends on the specific model and hardware, not something this plan can predict in advance; better to expose it than keep guessing a new hardcoded number per model.
- **`/no_think` appended to every user prompt, plus optional `reasoning_effort` and `enable_thinking` request fields (both popup settings).** Three different "thinking"-mode ~27B models (a Gemma variant, two Qwen3 variants) all showed extremely verbose reasoning before ever reaching real output — on one model/hardware combo, throughput on a genuinely ambiguous posting dropped to ~10 tok/s, making 16000 tokens a 25-minute worst case. Confirmed root cause (checked the model's own LM Studio page): it defaults to `reasoning_effort: "xhigh"` with thinking enabled. `enable_thinking: false` (popup checkbox, off by default) is a direct, stronger override of that than just requesting a lower effort level; `reasoning_effort` (popup dropdown, default "low", empty = omitted from the request) is the fallback for models that expose graduated levels instead of a binary toggle; `/no_think` is an older Qwen3 convention kept as a third, harmless-if-unrecognized fallback. All three target the actual cause of the slowness rather than further raising timeout/token budgets around it — which levels/fields a given model supports isn't something this plan can predict, hence popup settings rather than hardcoded values.
- **The popup's "Evaluate this tab" button disables itself for the duration of the click handler**, guarding against a double-click firing two concurrent evaluations (and two concurrent LM Studio requests) before the popup closes — observed as two near-identical concurrent generations in LM Studio's own log.
- **`extractJson()` falls back to scanning `reasoning_content` for a balanced `{...}` JSON object when `content` comes back empty.** Two different "thinking" models (a Gemma variant and a Qwen variant) were both observed writing the complete, correct final JSON answer *inside* their own reasoning trace and never separately emitting it as `content` before stopping — `finish_reason` can even say `"stop"` (a clean finish) while `content` is still `""`. The fallback scans for balanced-brace `{...}` spans (not just first-`{`-to-last-`}`, which would span unrelated braces in surrounding prose) and tries each from last to first, since a later block is more likely to be the model's final corrected answer than an earlier draft it talked itself through on the way there.
- **Known limitation:** the local model extracts requirements much more reliably from bulleted postings than from narrative/prose ones — a prose-summarized posting scores noticeably worse than the full raw text. "Evaluate this tab" always uses the full extracted text for this reason. "Summarize this tab" (below) produces a condensed brief for pasting into a *different* LLM that already has your profile — don't feed that condensed output back into this tool's own evaluation, and expect any LLM (local or not) to do worse on a summarized posting than the original.

### Candidate profiles (multiple, stored, editable in popup)

The tool holds **a list of profiles**, one per person (or per job family for the
same person), selected from a dropdown at the top of the popup. Added so a
second candidate — a friend, also a Mexican national needing sponsorship — can
have postings evaluated against their own CV without overwriting the first.

**A profile owns:** the candidate text, `expectedSalary` per currency, and all
three keyword lists (hard rejects, warnings, domain flags).

**Popup layout.** Everything is collapsed by default — profile management,
the CV textarea, LM Studio, expected salary, and the three keyword lists — so
the popup opens
short and you expand only what you're editing. The profile **dropdown is the
exception and never collapses**: which profile is active is what you have to
see before hitting Evaluate. Open/closed state persists in `uiOpenSections`,
because the popup document is destroyed whenever it loses focus and would
otherwise re-collapse on every reopen. Two sections force themselves open when
they hold a field nothing works without: LM Studio when the model name is
blank, and the CV textarea when the profile has no text yet — which is every
profile the moment after you create one.

**A profile does not own the LM Studio settings.** Endpoint, model, timeout,
reasoning effort and thinking are global: there is one LM Studio on this
machine, and scoping them per profile would only mean fixing the endpoint
twice. They live in a collapsed `<details>` in the popup for that reason —
machine config you set once, not per-candidate tuning.

**What a new profile inherits, and what it deliberately doesn't.** *New* copies
the hard rejects and the warnings but leaves domain flags **empty**. The rejects
encode visa/legal facts about a person (both candidates here need sponsorship),
and an empty `hardRejects` list would silently stop filtering sponsorship-blocked
postings — the one check you never want to lose by accident. Domain flags are the
opposite: they encode one specific person's *skill gaps*, so inheriting them
would flag requirements that aren't gaps for whoever the profile is for.
*Duplicate* copies everything, for job-family variants of the same person.

**Storage shape:**

```js
{
  profiles: [ { id, name, profile, keywords:{hardRejects,softWarnings,domainFlags},
                expectedSalary:{USD,CAD,MXN} }, ... ],
  activeProfileId: "…",
  lmStudio: { … },              // global
  uiOpenSections: { … },        // which <details> are open
  lastEvaluation / lastSummary  // stamped with profileId + profileName
}
```

**Migration.** On the first read after this change, the pre-profiles top-level
`profile` / `keywords` / `expectedSalary` keys are wrapped into `profiles[0]`
with the fixed id `"seed"`. The id is fixed rather than generated so that if the
popup and an injected content script both hit an unmigrated store at the same
moment, the two writes are identical instead of producing two duplicate
profiles. The legacy keys are left on disk unread, so downgrading doesn't lose
them.

**`normalize()` backfills missing keys** (`Array.isArray`, not `||`, so a list
the user deliberately emptied stays empty while a key that never existed picks
up the current default). This is what makes a newly added keyword tier take
effect without a manual "Reset defaults → Save" round trip — the thing that was
needed when `softWarnings` was introduced.

**`lastEvaluation` is keyed by profile as well as URL.** Two candidates look at
the same postings, so matching on URL alone would splice one person's score into
the other person's summary brief with nothing on screen to show it had happened.
Same for `lastSummary`.

**The active profile is resolved once, in `content.js`, and passed through** in
the `JOB_FIT_EVALUATE` message (`profile` + `expectedSalary`). `background.js`
used to re-read `expectedSalary` from storage itself; switching profiles between
the two reads could score a posting against one profile's keywords and another's
salary expectations.

**Reset scope.** The popup's reset button is *Reset keyword lists* — rejects and
warnings only. It can't restore the candidate text once profiles exist (dropping
one person's CV into another person's profile is nonsense), and domain flags are
per-person by construction. It also no longer wipes the LM Studio endpoint,
which the old "Reset defaults" did.

### Setup wizard

`wizard.html` walks a profile through everything it needs. It opens on a fresh
install (`onInstalled`, `reason === "install"` only, never on update), from
**New** in the popup, and on demand from the popup or the history page.

- **A tab, not the popup.** Same reason as the history page: the popup destroys
  itself on blur, and the CV step asks you to paste from another window.
- **Model first.** Drafting the profile, suggesting salary and suggesting domain
  flags all need the model, so it's checked before anything that depends on it.
  The model list comes from `/v1/models`, which removes the "model name isn't
  loaded" failure by construction. For a second profile the step collapses to
  one line, because the model is global.
- **Hard rejects are derived from answers, not ticked cold.** Each
  work-authorization answer owns a fixed set of reject categories
  (`ANSWER_RULES` in `wizard.js`) and only re-ticks those, so a category you
  changed by hand survives edits to unrelated answers. Each tick shows the
  answer that caused it.
- **The profile draft is assembled in code.** The model returns one JSON field
  per template section and `assembleDraftProfile()` writes the text, so the
  labels the evaluator depends on (`Gaps:`, `Work authorisation:`, `Target:`)
  are always present and spelled the same way. Nothing the model produces is
  saved unseen: the draft, the salary and the flags are all review-first.
- **Writes go straight to the real stores.** There is no draft copy to commit, so
  closing the tab loses nothing. A `new` profile is created once it has a name.
  `setupIncomplete` on the profile drives the popup's **Continue setup** banner,
  and `wizardProgress[profileId]` records the step to resume at. Saves re-read
  the store and replace only this profile, so edits made elsewhere to other
  profiles aren't overwritten. `normalize()` carries `setupIncomplete` and
  `setupAnswers` through explicitly; neither is in `fingerprint()`, because
  neither changes a score.
- **The test run bypasses the queue on purpose.** `JOB_FIT_TEST_EVALUATE` calls
  `evaluateWithLmStudio()` directly, so a sample posting is never filed as a
  tracked job. It refuses to run while the queue is active, which keeps LM Studio
  at one request at a time. Layer 1 runs first in the page, exactly as on a
  real posting.
- **Every wizard model call is cancellable.** Calls carry a `callId`, and
  `JOB_FIT_CANCEL_CALL` aborts the fetch through the new `signal` option on
  `callLmStudio()`. Cancel stops LM Studio generating, not just the spinner.
- **Fresh installs start with no domain flags.** The shipped defaults are one
  specific person's gaps, and `startFirstRunSetup()` clears them for the seed
  profile.

The shipped default for the first profile, kept under ~400 words:

```
(See `defaults.js` for the shipped template. A real profile lives in
chrome.storage.local and is never committed.)
```

---

## JSON-LD probe

Most job boards are supposed to emit `schema.org/JobPosting` for Google Jobs
indexing, which would give title, company, location and **salary** as typed
fields — salary especially, since the model currently reads those numbers out
of prose and they feed `compareSalary`. Getting them structurally would take
the model out of one more job it is unreliable at.

The premise turned out not to hold where it matters most: Greenhouse emits
**none at all**, on either a board page or an embed. So rather than build on an
assumption, `probeJsonLd()` measures. It runs at extraction time, changes
nothing, and records per page: the host, the extractor used, whether a
`JobPosting` block was present, and — the number that actually decides this —
**which fields it would have added that the extractor missed**. Salary always
counts as an addition, because no extractor reads it.

Samples are capped at 200 and reported from the tracked-jobs Data menu, broken
down by host. If the long tail of career sites shows a high "adds" column it is
worth building; if it looks like Greenhouse, better generic extraction is the
cheaper path.

## Extraction

Each extractor exports `extract(document) → { title, company, location, text } | null`.

All three extractors go through `textFrom`. `greenhouse.js` was the holdout,
reading raw `innerText`, and its portal branch accepted any non-empty string
while the classic-board branch required 100 words — so a dialog caught
mid-render could be sent to the model as though it were the whole job. Both
branches now use `textFrom` with a shared 100-word floor, which also puts a
second line of defence under the PII case: `textFrom` strips form subtrees, so
even a form nested *inside* `.application-description` can't leak the
applicant's name, phone or resume filename. (Title, company and location still
read `innerText` — single-line values with no structure to preserve.)

- **text.js** — shared `textFrom(root)` used by the extractors below; see "Why not innerText" beneath this list.
- **greenhouse.js** — my.greenhouse.io dialog (`.application-description` inside a visible `[role="dialog"]`) or the classic static board (`.job__description`, title `.job__title h1`, location `.job__location`).
- **lever.js** — `.posting-page` / `.section-wrapper`; title in `.posting-headline h2`. *(Not built yet.)*
- **linkedin.js** — description `[data-testid="expandable-text-box"]`. Every class in this UI is hashed (`ed40912b _3122fa3c…`) **and changes between the collapsed and expanded states**, so classes are unusable — anchor on the testid. The full description is already in the DOM while collapsed; the "…more" button only toggles CSS clamping, so there's no need to expand it first (and `textFrom` skips the button element anyway).
  - **title** — the `a[href*="/jobs/view/<id>"]` matching the job id parsed from the page URL (`currentJobId=` query param in the search-results layout, else `/jobs/view/(\d+)` in the path). This correlation matters: the search-results layout renders a card per job in the left rail, each with its own `/jobs/view/` link, so a blind first-match would frequently name a *different* posting than the one on screen.
  - **company** — `a[href*="/company/"]`, scoped to the nearest ancestor shared with the title anchor (bounded upward walk, since hashed classes give `closest()` nothing to target).
  - **location** — first `·`-separated segment of that container's meta line (`Bellevue, WA · Reposted 1 week ago · 96 people clicked apply`).
  - Each field degrades to `null` independently — better to return nothing than to confidently label the posting with another job's title.
- **generic.js** — fallback: prefer the largest *visible* dialog, else `document.body`. Guard against garbage: under ~200 words, treat extraction as failed rather than sending a cookie banner or nav menu to the model.

### Why not innerText
`innerText` requires layout: on a **detached** node it silently degrades to `textContent`, flattening every `<br>` and `<li>` into one run-on blob. `generic.js` originally cloned its root in order to strip `<form>` subtrees (the my.greenhouse.io PII fix) and then read `innerText` from that clone — so every site falling through to the generic extractor was getting structure-flattened text, which is likely part of why prose-vs-bulleted postings scored so differently. `textFrom()` replaces it: a deliberate stand-in that walks the **live** DOM, skips the same elements (forms and their controls included, so the PII guarantee holds), and emits newlines at `<br>` and block boundaries. No cloning, no temporary page mutation. Greenhouse's extractor reads `innerText` from live, in-layout elements, so it was never affected and is left alone.

Dispatch by hostname, fall back to generic. Log which extractor fired.

**LinkedIn is a single-page app** — clicking between job listings changes the URL without a full page reload, so a content script that only extracts on initial load will show a stale result for the wrong posting. Since evaluation is manual (click "Evaluate" per the popup), this mostly resolves itself — just make sure extraction always reads the *current* DOM at click time rather than a cached value from page load.

---

## Queue

Clicking **Evaluate this tab** adds the posting to a serial queue instead of
running it there and then. Up to 10 jobs; click through a search page, queue
them all, come back later.

### Why the queue owns the work

The content script used to drive an evaluation end to end, which only works
while the page sits still. Queueing means clicking job after job — and on
LinkedIn's search layout the next click replaces the description DOM, while a
direct job page navigates outright. Either way the script waiting for a result
is gone.

So **extraction happens at enqueue time, not at processing time.** The click
does the cheap synchronous work — extract, Layer 1, keyword scan — and hands
the *text* to the service worker. Processing then needs no tab at all. A
hard-rejected posting is decided right there and never occupies a slot.

Each item also **snapshots the profile it was queued under** (CV text,
expectedSalary, fingerprint). Switch profiles mid-run and queued items still
score against what you queued them with — the same class of bug as the earlier
keywords/salary split, and much harder to notice here.

Concurrency is **1**: two concurrent LM Studio requests roughly halve each
other's throughput, so parallelism would make a batch slower. **Summarize goes
through the same lane** as a priority item for that reason, which also means
the brief is assembled and filed by the worker — so a summary finishing after
the popup closed is no longer lost, which it used to be.

### Ownership

The queue lives in `chrome.storage.local` with the **service worker as sole
writer**; the popup and history page mutate it only by message. One writer, no
read-modify-write race on the `queue` key.

```
item:  pending → processing → done | failed | cancelled
queue: idle | running | paused
```

### Surviving the worker dying

State is never only in memory. A `processing` item holds a **lease**
(`timeout + 30s`); on wake, expired leases are reclaimed to `pending`, failing
after 2 attempts — without that, one crash wedges the queue forever. A
`chrome.alarms` watchdog ticks every minute *while the queue is non-empty* (and
is cleared when it drains, so the worker isn't woken forever), and
`onStartup`/`onInstalled` resume automatically: a batch left running overnight
should still be running in the morning.

Anything thrown by a processor — a storage write failing, a malformed record —
is caught and converted into an item-level failure. Left to propagate it would
reject the pump loop and strand the item in `processing` until its lease
expired minutes later.

### Failure policy

Pause on problems that will repeat for every item; skip the ones specific to
one posting.

| Failure | Action | Why |
|---|---|---|
| `unreachable` — LM Studio not running | **Pause** | Identical for every remaining item |
| `http` — bad model name, server error | **Pause** | Configuration-level |
| `timeout` ×2 consecutive | **Pause** | The machine, not the posting |
| `timeout` ×1 | Skip | One long posting may just be slow |
| `empty` / `length` / `parse` / `storage` | Skip | Specific to that generation |

A pause keeps its item **pending**, not failed — nothing is wrong with it, so
Resume just runs it.

### What you see

Toolbar **badge** with the outstanding count (blue running, amber paused,
blank at zero). A **queue panel** on the tracked-jobs page — waiting/running/
failed with Cancel, Retry and Resume, filtered to the profile being viewed, and
live via the `storage.onChanged` listener. One status line in the popup.

The in-page banner is **best-effort**. When a result lands, the content script
re-derives the current `jobKey` from the live DOM before painting; on a
single-page app the tab id is unchanged and the script was never re-injected,
so a key remembered at enqueue time would still say "job A" while the page
shows job B — and A's score would be painted over B.

---

## Failure handling

**JSON extraction ignores braces inside strings** (fixed 2026-09-19). The
balanced-brace scanner counted every `{` and `}`, including ones inside string
values, so a valid answer like `{"summary":"Use } carefully"}` closed depth
early, yielded the invalid fragment `{"summary":"Use }`, and the whole response
came back as unparseable. It only runs when the model wrapped its JSON in prose
— exactly when it is needed. It now tracks string state and backslash escapes,
and treats `"` as a delimiter only at depth > 0, since at depth 0 we're in the
model's prose where an odd number of quotation marks is normal and would
otherwise swallow the rest of the text.



Two ways the UI could strand itself, both fixed in the 2026-09-19 audit:

- **Script injection is allowed to fail.** `chrome.scripting` refuses
  `chrome://` pages, the Web Store, PDF viewers and other extensions' pages.
  The rejection was unhandled, so Evaluate left its button permanently disabled
  and never closed the popup, and Summarize sat on "Extracting…" forever, in
  both cases with nothing on screen saying why. Both call sites now catch, name
  the reason in plain language, and re-enable the button.
- **Rendering no longer depends on the storage write.** The result used to be
  rendered only after `saveEvaluation` resolved, with no catch, so a failed
  write rejected `run()` and left the banner stuck on "scoring with local
  model…" — discarding a generation that had just taken minutes. `saveAndRender`
  now renders either way and reports the write failure in Details. `run()` also
  sits behind a `start()` wrapper that catches anything unexpected and renders
  an error banner rather than leaving a progress banner up forever.

---

## Popup readiness

Both "why isn't it working?" moments are answered before you click. On open the
popup GETs `/v1/models` — derived from the configured chat-completions URL,
since POSTing to that would run a generation — and reports reachable /
unreachable, plus **whether the configured model name is actually loaded**.
That last check catches the HTTP error that would otherwise pause the whole
queue, and catches it before ten jobs are sitting behind it.

It also probes the current tab with a cheap selector check (not the extractors,
which walk the DOM) and says whether a LinkedIn posting, a Greenhouse posting
or an embedded board was found. Evaluate is never disabled on a "no posting"
result — the generic extractor may still succeed — the popup just stops it
being a surprise.

---

## Banner UI (content.css)

Inject a fixed bar at the top of the page:
- Left: score (large) + verdict label.
- Middle: one_line summary.
- Right: "Details" toggle → expands matches / gaps / required_gaps / flagged phrases.
- Below (collapsible): keyword highlights, red / amber / green.
- Small "Re-evaluate" and "Log" buttons.

Keep it dismissable. Don't cover the page's own apply button.

**Radix UI dialogs (my.greenhouse.io's candidate portal) treat any click outside their own DOM subtree as a dismiss signal**, and our banner lives in `document.body` — so clicking Evaluate/Details/Dismiss on the banner would close the job dialog underneath it. Fix: stop `pointerdown`/`mousedown`/`click` from bubbling past the banner and details panel elements, so the event never reaches the document-level listener Radix uses to detect outside clicks.

---

The score is a coloured badge rather than text sharing weight with the verdict,
using the same green/amber/red thresholds as the tracked-jobs page — the same
number should look the same in both places. A hard reject shows no badge, since
its `0` is a marker rather than a score.

A **Tracked jobs** action opens the page deep-linked to that record
(`history.html?profile=…&job=…`). Content scripts cannot open tabs, so the
worker does it. On arrival the page clears any filter that would hide the job,
expands it, scrolls to it and flashes it — landing at the top of a long list
would defeat the point.

---

## Evaluation history

Every evaluation is filed as a record and surfaced on `history.html`, opened
from the popup's **View evaluated jobs**. An extension page rather than a popup
view: it needs the width, and it keeps full `chrome.storage` access without the
popup's habit of destroying itself the moment it loses focus.

**Picking the LinkedIn title anchor** (found in testing, 2026-09-22). Several
anchors on a job page point at the same job id — the title, but also pills like
"On-site", "Remote" and "Promoted". `querySelector` returned whichever came
first in the DOM, which is how postings arrived titled "On-site". Worse,
`findHeaderContainer` walks up *from that anchor*, so a wrong pick corrupted the
company and location too. The picker now rejects known pill labels, prefers an
anchor inside a heading (checked in both nesting directions, since the anchor
may wrap the heading or sit within it), and otherwise takes the longest label —
returning null rather than a confidently wrong title.

### Job identity — the part that's easy to get wrong

**A URL is not a job.** The same LinkedIn posting is reachable as
`/jobs/view/<id>/` and as `/jobs/search-results/?currentJobId=<id>&refId=…`,
with a fresh `refId` on every search. Keyed on `href`, the same job would be
filed three times and the "already evaluated this" check would essentially never
fire — the feature would look implemented and do nothing.

`jobkey.js` resolves, in order:

1. **LinkedIn** → `linkedin:<currentJobId>`, reusing the id `linkedin.js`
   already computes (now exported as `window.__jobFit.linkedinJobId`).
2. **Greenhouse** → `greenhouse:<company>:<id>` from `/<company>/jobs/<id>`; on
   the `my.greenhouse.io` portal, from the job link inside the dialog.
3. **No-id listing pages** → `content:<hash(title|company)>`. The portal's URL
   is `/jobs/search?query=…` for *every* posting opened in its dialog, so
   normalizing the URL there would file every job under one key and have each
   overwrite the last. Deliberately narrow — this is a fallback where no id
   exists, not cross-site content matching.
4. **Everything else** → `url:<normalized>`: host lowercased, `www.` and
   trailing slash and hash dropped, params sorted, and a conservative list of
   known tracking params stripped (`utm_*`, `refId`, `trackingId`, `gh_src`,
   `gclid`, …). Unrecognized params are *kept* — plenty of ATS put the job id in
   one.

### Cross-site duplicates — flagged, never merged

Keys are per site, so the same posting reached from two sites is two records.
The case that prompted this: Nuro's "Software Engineer, Onboard Platform" was
filed once as `linkedin:4426196077` and once as `greenhouse:nuro:7998328`,
with two scores, two statuses and two sets of notes. No shared ID exists, so
no key rule can catch it. Only the content can.

`JOB_FIT_EVALSTORE.duplicateGroups()` treats two records under one profile as
possible duplicates when:
- their title and company match after normalizing (lowercase, punctuation
  except `+ # .` dropped so C++ ≠ C, company legal suffixes like
  inc/llc/ltd stripped), **and**
- their posting text is near-identical: at least 0.6 containment of word
  3-shingles over the first 4,000 characters.

Containment is used rather than Jaccard because LinkedIn wraps the same
description in extra page text. Location is ignored ("Mountain View, CA" vs
"Mountain View, California (HQ)"). Only when a record has no text does the
city decide instead.

It **flags and never merges**. Two real openings can share a title at one
company, and a wrong merge would silently fuse their statuses and notes,
while a wrong flag costs one click. Tracked jobs shows:
- a "possible duplicate" badge on each copy
- a section in the card naming the other copy (site, score, status, notes),
  with **Show it** and **Not a duplicate**
- an "N possible duplicates" filter chip that lists each set side by side

**Not a duplicate** writes `notDuplicateOf` onto both records, so the pair
stays silenced even after re-scoring. The job-page banner also warns when a
posting matches one already tracked from another site.

### Records

A record can come from **Evaluate**, from **Summarize**, or from both, and the
three states have to stay distinguishable:

| | `score` | `evaluation` | `hardReject` |
|---|---|---|---|
| Evaluated | 0–100 | object | null |
| Hard reject | `0` | null | object |
| Summarized only | `null` | null | null |

Summarizing used to attach the brief only to a record that already existed, so
summarizing a posting you hadn't evaluated discarded it — the one artifact you
actually paste elsewhere. `saveSummary()` now creates the record, stamping
`lastSummarizedAt` rather than `lastEvaluatedAt` (nothing was scored, and
claiming otherwise would file it under a date-evaluated ordering for a time no
evaluation happened). `activityTs()` resolves
`lastEvaluatedAt || lastSummarizedAt || firstSeenAt` for the page's date column
and its date sorts. Either operation preserves the other's data, along with
status, notes and `appliedAt` — you can summarize a posting, apply to it off
the brief, and evaluate it a week later without losing any of that.

For the score sorts, `score ?? 0` used to tie an unscored job with a hard
reject and leave their order to whatever storage returned first. `scoreRank()`
makes it explicit: a real score (a genuine 0 included) outranks an unscored job,
which outranks a hard reject — unknown is still worth a look, dead is not.

Keyed `ev:<profileId>:<jobKey>`, one storage key per record. Not a single array:
ticking a status dropdown shouldn't rewrite the entire history, and per-key
writes can't lose data to a read-modify-write race between the history page and
a tab mid-evaluation. `unlimitedStorage` is declared so the 10 MB default cap
never becomes a thing to think about.

Records are **per profile** — the same posting evaluated for two candidates is
two records, because the scores aren't comparable and mustn't overwrite each
other.

`saveEvaluation()` merges, deliberately preserving the fields the *user* owns —
`status`, `notes`, `appliedAt`, `firstSeenAt`. Re-evaluating a posting must
never reset the fact that you already applied to it.

### Cache-on-evaluate

`Evaluate this tab` looks the posting up first and renders the stored result
instantly, labelled `[saved · evaluated 12 days ago]` with a **Re-evaluate**
button.

Each record stores a `profileFingerprint` — an FNV-1a hash of the CV text, all
three keyword lists and the salary expectations. If it no longer matches the
active profile, the cache is ignored and the posting is re-scored automatically.
Without this, editing a keyword and re-running a posting would return the old
score and look like the edit did nothing.

Hard rejects are stored like any other result, with `score: 0` so they sort last
and a `hard reject` badge. Storing them is the point: otherwise you re-screen the
same dead posting every time you come across it.

### Application tracking

One lifecycle field, not an "applied?" checkbox plus a status — those two can
disagree with each other (unchecked + "interview scheduled"):

`Not applied → Applied — pending response → Interview scheduled → Offer received
→ Rejected / Ghosted — no response / Withdrawn`

`appliedAt` is stamped once, on the first move off *Not applied*, and a later
move to *Rejected* doesn't overwrite it — "applied 5 weeks ago, still pending"
is the view that tells you to follow up or let it go.

### Page

The list is what the page is for, so the chrome above it is kept small. The
standing Backup panel became one **Data** control in the toolbar, and the
controls bar is sized to stay on a single row — it was wrapping and costing
60px directly above the first job.

**Funnel chips** (All / Not applied / Waiting / In play / Closed) replace the
grey count line and double as filters, because the question the page should
answer is "what do I do next?", not "what happened?". Chips and the Status
dropdown are mutually exclusive — using one clears the other — so the list is
never filtered by two controls at once. A bucket with nothing in it is hidden
unless it is the one selected.

**Order: status on top, then filters, then the list** (2026-09-25). The queue
moved to the top, away from the list, because it's status, not something you
use to work through the list. The filters sit directly above the list they
control. The queue shows at most four rows in a scroll area that follows the
newest item (on load, and whenever one is added, unless you've scrolled up to
read something). The running item is pinned above that scroll area, because
following the newest item would otherwise scroll the running one out of view.

**Out-of-date notice is a chip, not a banner.** It was a full-width row. It's
now an amber chip at the end of the funnel row, set apart from the status
buckets. Clicking it filters to those jobs, and × dismisses it. The dismissal
stores a signature (model, profile fingerprint and count), so the chip
returns when that set changes instead of hiding news. Every row keeps its own
"scored by …" badge, so dismissing loses nothing.

**The list toolbar is always rendered, at a fixed height.** The old
selection bar appeared only once something was ticked, so ticking the first
box inserted a bar and pushed every row down. One sticky row now holds a
tri-state checkbox that selects this page, the "1–20 of 143" count and the
pager. Selecting swaps its left side to "N selected · Re-evaluate · Clear"
and, once the page is fully ticked, "Select all N matching". The "select
all out of date" action moved here from the old banner, shown when the
out-of-date filter is on.

**Pages.** 5 / 10 / 20 / 50 / 100 / All per page, remembered in
`historyUi`. Filter, sort, search and profile changes go back to page 1, but
a job leaving the list (deleted, or no longer matching) only clamps the
page. Resizing keeps the first job you were looking at on screen. A deep
link from a banner opens the page the job is on. Selection spans pages, and
CSV export still covers everything matching the filters, not just the
current page. Rendering only the current page also keeps re-renders cheap
as the history grows.

**"Needs attention"** is the page answering what to do next rather than what
happened. Four rules, first match wins, most decisive first:

| Rule | Reason shown |
|---|---|
| `status = offer` | offer — decide |
| `status = interviewing` | interview scheduled |
| not applied and `score >= 75` | strong match (91) — not applied |
| `status = applied` and silent ≥ 14 days | no reply in 19 days |

The 75 threshold is deliberately the banner's green boundary: if the tool calls
something a strong match and you haven't acted, that is the thing to act on.
Ghosted, rejected and withdrawn never qualify — those are decisions already
made — and a hard reject is disqualified rather than pending.

Each flagged row **states its reason** inline, not only behind the filter: a
list of jobs with no stated reason is just another filter, and the reason is
the useful part. The chip is first, amber, and **hidden entirely when the count
is zero** — an empty "needs attention" is the best possible state and shouldn't
occupy the eye.

**Status reads from the row edge**, not from the controls: a coloured left
border, with closed rows faded to ~60% (they stay findable without competing
with rows that need something). Score badges keep the green/amber/red channel
to themselves so the two signals never collide, and status dropdowns are
borderless until hover or focus — eight bordered selects turned the list into
a form. Dates collapsed to one relative line, with the absolute date in the
tooltip.


Sort by score (default, high→low), score low→high, date evaluated, date applied,
company, or status. Filter by status, free-text search across title / company /
location / **notes** / posting body, and a hide-hard-rejects toggle. Each row
collapses to title, company, score, date and the status dropdown; expanded it
shows the link, the model's verdict and tags, the condensed brief, the full
extracted posting, a notes field and a two-click delete. CSV export covers
whatever the filters currently show.

**Identifying an embedded board by host, not by substring** (found in testing,
2026-09-22). The top-frame defer looked for `iframe[src*="greenhouse.io"]`. A
genuine Greenhouse board page loads a Google API proxy iframe whose hash is
`#parent=https%3A%2F%2Fjob-boards.greenhouse.io` — only `://` is encoded, so the
hostname sits in the URL as plain text and the substring matched. The board
concluded it was a wrapper page, deferred to what was actually a Google RPC
shim, and evaluated nothing.

Two independent conditions now, because neither alone was sufficient:

- The frame must be **hosted** on greenhouse.io and served from an `/embed/`
  path (`new URL(frame.src).hostname` rather than a substring of the whole src).
- The defer only happens when this document produced **no site-specific
  extraction** (`!result || extractorName === "generic"`). A real board is read
  by the greenhouse extractor in place, and deferring away from a page that can
  read itself is never right — so a future loose selector cannot break it again.

The same substring flaw was in `injectJobFrames`, which is why the content
script was then injected into the gapi frame; it filters on hostname too.

**A fixed `seed` makes scores reproducible.** Without one the same posting
scored differently on each run, so adjacent positions in a list sorted by score
were partly sampling noise — which undermines the page's default view. The seed
is sent with every request; `temperature` deliberately stays at 0.2, since a
seed makes sampling reproducible without forcing greedy decoding. One
consequence worth knowing: re-evaluating a posting whose profile, model and
text are all unchanged now returns exactly the same answer. That is the point,
but it does mean **Re-evaluate** is no longer a way to draw a second sample.

**Evaluation duration is recorded.** `callLmStudio` reports elapsed ms, which is
stored on the record and appended to a short rolling list under its own
`evalStats` key — separate so the popup can read it without pulling every
stored posting. The popup shows the median and slowest of the last 20 directly
beneath the timeout field, because that is the setting the number informs.
Median, not mean: one stuck generation should not skew the advice.

**A score is only valid for the profile AND the model that produced it.** The
staleness check originally covered the profile alone, so swapping models left
cached scores presented as current — and the page ranks by score, so a list
mixing two models' numbers looks authoritative and isn't. Records now store
`model`, the cache check compares it alongside the fingerprint, and the
tracked-jobs page counts out-of-date records and offers to **re-queue** them.
That re-queue needs no tab and no page visit: the posting text is on the record.

**`raw_score` survives a cap.** `applyScoreCaps` overwrote `score` in place, so
a capped result showed "40 — seniority/comp mismatch" with no sign the model had
said 78. The caps are heuristics; judging whether one was fair requires the
number it replaced. Both are shown wherever the cap is reported.

**Queue rows show the score by reading the record, not by storing it.** The
score belongs to the record, and the worker writes it before the pump marks the
item done — so it is already in `records` when the queue re-renders. Copying it
onto the queue item would have been a second source of truth that a
re-evaluation could leave stale. Brief items are excluded: they have no score,
and showing the job's score on a brief row implies it produced it.

**Settings save as you type.** Chrome destroys the popup document the moment it
loses focus, and nothing was written until Save was pressed — so editing the CV
and clicking anything outside the popup lost the edit silently. Writes are now
debounced 400ms after typing stops, flushed on blur, with `visibilitychange`
and `pagehide` as a last line of defence rather than the mechanism: an async
storage write started during teardown is not guaranteed to finish.

**Backup / restore.** `chrome.storage.local` is erased when the extension is
uninstalled — silently, with no undo — and the CSV export only ever covered
tracked jobs, not profiles, settings, status, notes or briefs. *Back up all
data* writes the lot as JSON; *Restore from backup* merges it.

The import treats the file as untrusted: only known fields are read, profiles
go through `normalize()` before being stored, records are only accepted for a
profile that exists here, and each record's storage key is **rebuilt from its
own profileId and jobKey** rather than taken from the file — so a hand-edited
backup cannot write outside the `ev:` namespace. Nothing existing is ever
overwritten, because a restore must not discard an application status or a note
added since the backup was taken. The queue and `lastSummary` are excluded:
both are transient, and the queue holds tab ids that mean nothing on restore.
LM Studio settings are applied only when no model is configured locally, so
restoring someone else's backup can't silently repoint your endpoint at theirs.

**The page refreshes itself.** Evaluations are written by a content script in
whatever tab the posting is open in, so without a `chrome.storage.onChanged`
listener this page sat stale until reloaded — you'd evaluate a job, switch to
this tab, and not see it. The listener merges only keys under
`ev:<viewProfileId>:`, skips the page's own writes (tracked in a `selfWrites`
set, since `onChanged` fires for those too and they're already in memory), and
picks up profile renames for the selector.

Two things make a live re-render safe. Expanded cards are tracked by `jobKey`
in `openKeys` rather than in the DOM, so a rebuild doesn't collapse whatever
you were reading — which also fixed the older annoyance of a status change
collapsing the card under an active filter. And a re-render while a note is
being typed would destroy the draft, so it defers; the flush is **polled**, not
driven by a `blur` event alone, because blur can simply never fire (a window
that loses focus, a field removed some other way) and a deferred render that
never flushes leaves the page silently stale with no way back. The blur
listener is kept only to make the common case feel instant.

**Profile deletion is a cascade.** A profile owns its tracked jobs, so deleting
one removes every `ev:<profileId>:*` record with it — see the audit follow-ups
above for why the confirmation names the count.

**Flag labels show the posting's words, not the pattern.** Labels used to be
made by stripping backslashes off the regex source, which left
`master'?s degree (is )?required` and
`graduat(ing|ion) (date )?(between|in) (20\d\d)` on screen. `matchedLabels()`
now returns `m[0]` — the text the posting actually used — collapsed to one
line, capped at 80 characters and de-duplicated case-insensitively. It reads as
prose ("Master's degree required", "must be a US citizen") and says what
tripped the flag rather than what the rule looks like. A hard reject still
shows its pattern, since that's the thing you'd go and edit, but as
`"<posting's words>" — matched rule: <pattern>` rather than passing a regex off
as prose.

**Profile names are resolved live.** Records carry a `profileName` copied at
write time, so renaming a profile left every earlier record — and the brief you
paste into another assistant — claiming the old name. `profileNameFor()` looks
the name up in the profile store by `profileId`, falling back to the stored
copy only for a record whose profile no longer exists.

Each expanded job leads with **score and verdict** (`82/100 · APPLY`) above the
one-line summary, and carries its own **Summarize / Re-summarize** button plus
**Copy brief**. Summarizing from here queues the brief through the service
worker exactly as the popup does — the record already stores the full posting
text — so it obeys the same one-request-at-a-time rule while evaluations are
running, and the finished brief arrives in the card by itself via the live
refresh. The copied text resolves the profile name from the profile list, so a
brief copied from an old job is not labelled with a name since renamed.

Search covers title, company, location, notes, the condensed brief and the full
posting body. Everything scraped from a posting is written with `textContent`, never
`innerHTML` — the description is arbitrary markup from a third-party page.

---

## Logging

Append every evaluation to `chrome.storage.local["evaluations"]`:
```json
{
  "ts": "2026-09-12T18:04:00Z",
  "url": "...",
  "title": "...",
  "company": "...",
  "location": "...",
  "layer1": "pass" | "hard_reject",
  "reject_reason": "...",
  "score": 72,
  "verdict": "borderline",
  "required_gaps": [...]
}
```
Popup has an "Export CSV" button. That CSV becomes the applications tracker.

---

## Build order (do these in sequence, ship after step 5)

1. `manifest.json` + `content.js` that logs page text to console. Load unpacked. Confirm it runs on one Greenhouse page. ✅
2. `extractors/greenhouse.js` + `generic.js`. Confirm clean `text` on real postings. ✅ (Also confirmed the my.greenhouse.io candidate-portal dialog case and the classic static board case.)
3. Layer 1 hard-reject regexes + banner injection. ✅
4. Popup: profile + hard-reject list editing, stored in `chrome.storage.local`. ✅ (Originally scoped as "API key + profile + keyword lists" before the LM Studio pivot — no API key field now.)
5. `background.js` calls the local LM Studio endpoint with the JSON prompt, content.js messages it via `chrome.runtime.sendMessage`. Wire banner colors to score. **This is the MVP.**
6. Logging + CSV export ✅ (CSV ships on the history page; see "Evaluation history").
7. `linkedin.js` extractor ✅ (plus `text.js`, shared). `lever.js` still outstanding.
8. Multiple candidate profiles + collapsible LM Studio settings ✅ (`profiles.js`;
   see "Candidate profiles" above). Verified with a Node harness against a
   `chrome.storage.local` shim: 23 checks covering migration, idempotence,
   concurrent migration, `normalize()` backfill vs. deliberate empties,
   inheritance rules for a new profile, delete/dangling-id recovery, and that a
   duplicated profile doesn't alias the original's nested objects.
9. Evaluation history + job tracking ✅ (`evalstore.js`, `jobkey.js`,
   `history.html`). Verified with two Node harnesses — 15 checks on job-key
   derivation (three LinkedIn URL forms collapsing to one key, two portal jobs
   on one search URL staying distinct, tracking-param stripping) and 22 on store
   semantics (re-evaluation preserving status/notes/appliedAt, `appliedAt`
   stamped once, per-profile isolation, fingerprint staleness) — plus the page
   itself rendered against a storage stub to check sorting, filtering, search,
   profile switching and the dropdown click guard.

---

## Audit follow-ups (all closed, 2026-09-19)

- **Deleting a profile orphaned its records.** The profile went, every
  `ev:<profileId>:*` key stayed — unreachable from any selector and still
  holding each job's full posting text. Delete now sweeps the prefix, and the
  two-step confirmation names the count first
  ("…and its 3 tracked jobs (evaluations, briefs, notes and application
  status)"), because those records are the part you can't retype. Records are
  removed *before* the profile: the other order strands them permanently if the
  write fails.
- **`list()` no longer reads the whole store.** `getKeys()` (Chrome 130+)
  returns keys without values, so only this profile's records get
  deserialized; `get(null)` remains as the fallback. Deliberately *not* a
  maintained index — chrome.storage has no atomic update, so an index written
  read-modify-write from both the history page and a content script would
  eventually drop a key and make a job silently vanish. A slower read is the
  better trade.
- **Dead `suppressSelectChange` guard removed.** Assigning `.value` never fires
  `change`, so it never suppressed anything.
- **Suggest all refuses without a CV.** It used to send an empty profile and
  get a confident invented range back — which you'd then save as your own
  expectation, so every later salary comparison would be built on it.
- **Re-evaluate is single-flight.** It sits in the banner for minutes while a
  model runs, so it's far easier to double-click than the popup's Evaluate, and
  LM Studio serving two requests at once roughly halves the throughput of both.
- **The details panel measures the banner.** `top: 48px` was a magic number
  that never matched the banner's real 50px, so the panel's first rows sat
  under it on *every* render — not, as first assumed, only when a long verdict
  wrapped it (the summary is `nowrap` + ellipsis and never wraps at all). The
  height comes from padding and button sizing, which a constant can't track.

---

## Not in scope (deliberately)

- Auto-applying to anything.
- Scraping search results / crawling job boards.
- Multi-user, publishing to the Chrome store, any auth beyond a local model endpoint.
- Tracking application status after evaluation (use the CSV).
- Any framework, bundler, or TypeScript.

---

## Notes for Claude Code

- Manifest V3 service workers are event-driven and can be killed between events. Don't hold state in `background.js` memory — use `chrome.storage`.
- Route the Layer 2 call through `background.js` via `chrome.runtime.sendMessage`, same as the original API-based design — keeps the fetch logic in one place and out of the page's own JS context, even though there's no key to protect anymore.
- `host_permissions` are just `["http://localhost/*", "http://127.0.0.1/*"]` — Chrome match patterns don't include a port component, so this covers LM Studio on any port without needing a specific one hardcoded.
- LM Studio's OpenAI-compatible endpoint takes `{ model, messages: [{role, content}], temperature }` and returns `choices[0].message.content` — a different shape from Anthropic's Messages API, so `background.js` builds this shape directly rather than adapting Anthropic's request format.
- Test the JSON prompt in the console (or LM Studio's own chat UI) first with 3 real postings (one apply, one borderline, one skip) before wiring the UI. Tune the scoring guidance until the verdicts match your own judgment — expect more prompt-tuning iteration than with Claude, since local model JSON compliance varies a lot by model choice and size.
