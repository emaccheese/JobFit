// Pulls in JOB_FIT_DEFAULTS so the fallbacks below are the same values the
// popup shows. They used to be hand-mirrored constants here, which drifted
// once already: reasoning_effort and enable_thinking were added to the popup
// but not to this file, so neither was ever sent for anyone who hadn't
// re-saved their settings.
importScripts("defaults.js", "evalstore.js", "queue.js");

const SYSTEM_PROMPT = `You evaluate job postings against a candidate profile.
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
    "posting_stated": "<salary/range exactly as stated in the posting, with currency and period, or 'not stated'>",
    "posting_stated_min": <integer, annual, or null if not stated>,
    "posting_stated_max": <integer, annual, or null if not stated>,
    "posting_stated_currency": "<ISO 4217 code, e.g. USD/CAD/MXN, or null if not stated>",
    "estimated_market_range": "<your estimate of a reasonable market range for this exact role, seniority, and location, in the posting's currency if it stated one, otherwise the candidate's expected currency>",
    "estimated_market_min": <integer, annual>,
    "estimated_market_max": <integer, annual>,
    "estimated_market_currency": "<ISO 4217 code>",
    "note": "<one sentence of context — do NOT state a comparison verdict here, that's computed separately>"
  },
  "one_line": "<one sentence a recruiter would say about fit>"
}

CRITICAL — matches and gaps must be derived from what THIS POSTING actually states, not copied from the candidate profile's own self-described strengths/weaknesses:
- For every skill, framework, methodology, or domain the posting requires or prefers, check whether the candidate profile substantively covers it.
- A requirement that offers alternatives is satisfied by ANY ONE of them, not all of them. "Experience in one or more object oriented languages like C++, Kotlin or Java" is a MATCH for a C++ engineer — it is NOT two gaps for Kotlin and Java. Treat "or", "one or more of", "such as", "e.g.", "or similar" and "or equivalent" all this way. Only when the profile covers NONE of the listed alternatives is it a gap, and then name the requirement as a whole rather than each alternative separately. A list joined by "and" is the opposite: it does require all of them.
- If the posting requires something the profile never mentions — even if the profile doesn't explicitly call it out as a gap — it belongs in "gaps" (and "required_gaps" if the posting marks it required). Silence in the profile on a stated requirement IS a gap.
- Do not restate the candidate profile's own "Gaps:" list unless those exact items also appear as requirements in this posting.
- Don't list something as a match if you've also listed a closely related required skill as a gap (e.g. don't claim "deep learning architecture experience" as a match while listing PyTorch/TensorFlow as gaps — those are the tools that experience would require).
- Never list the candidate's own stated specialization or strengths as a reason against fit (e.g. "specialized imaging focus" is not a weakness) unless the posting explicitly says that specialization is a mismatch. Only genuinely unmet posting requirements belong in gaps/one_line's reasoning.

CRITICAL — classify every gap before placing it: for each item in "gaps", explicitly check whether the posting lists it under a Required/Must-have section or a Preferred/Nice-to-have section (headings vary: "Requirements" vs "Nice to have", "must have" vs "bonus points", etc.). Only items the posting itself marks as required belong in "required_gaps". An item under Preferred/Nice-to-have must NEVER appear in required_gaps, even if it seems important to you.

CRITICAL — salary numbers only, no verdict: extract/estimate the numeric min/max/currency fields as accurately as you can. Do not compare them to the candidate's expectation yourself — that comparison is computed separately from your numbers, so just report what the posting states and your market estimate.

Scoring guidance:
- Score = the proportion of REQUIRED items the candidate satisfies, not a count of gaps. A candidate meeting most required items should score well even with 2-3 gaps — don't let a handful of gaps drag the score down disproportionately when the majority of required items are met.
- Preferred-only gaps (items under Preferred/Nice-to-have, not Required) adjust the score by no more than -5 total, combined.
- A required language the candidate lacks (e.g. C#) caps the score at 60.
- "distributed systems" as a requirement caps at 45.
- Domain match (image/video/color/GPU/embedded) adds up to +15.
- If any DETECTED DOMAIN-FLAG TERMS (listed below, if present) are stated as required and the candidate profile doesn't substantively cover them, cap the score at 50 and list them in required_gaps.
- Salary is informational only — do not let it influence the score or verdict either way.`;

function formatExpectedSalary(expectedSalary) {
  const currencies = ["USD", "CAD", "MXN"];
  const parts = currencies.map((cur) => {
    const r = expectedSalary && expectedSalary[cur];
    if (!r || (r.min == null && r.max == null)) return `${cur}: not specified`;
    if (r.min != null && r.max != null) return `${cur}: ${r.min}–${r.max}`;
    if (r.min != null) return `${cur}: ${r.min}+`;
    return `${cur}: up to ${r.max}`;
  });
  return parts.join(", ");
}

// Postings put company boilerplate first and the qualifications, comp and
// visa language LAST. A blind head-slice therefore threw away exactly the
// part being evaluated: a 6,583-char posting (an ordinary length on LinkedIn)
// lost its entire MINIMUM QUALIFICATIONS section and its salary line, and the
// model then scored it on boilerplate alone with nothing anywhere to show
// that had happened. Keep both ends and say plainly what was dropped.
const MAX_POSTING_CHARS = 12000;
const HEAD_SHARE = 0.55;

function trimPosting(postingText) {
  if (postingText.length <= MAX_POSTING_CHARS) return { text: postingText, truncated: false };

  const headChars = Math.floor(MAX_POSTING_CHARS * HEAD_SHARE);
  const tailChars = MAX_POSTING_CHARS - headChars;
  const omitted = postingText.length - MAX_POSTING_CHARS;
  const marker = `\n\n[... ${omitted} characters from the MIDDLE of this posting were omitted to fit. What follows is the END of the posting, which is where requirements, compensation and visa language usually appear. ...]\n\n`;

  return { text: postingText.slice(0, headChars) + marker + postingText.slice(-tailChars), truncated: true };
}

function buildUserPrompt(profile, postingText, expectedSalary, domainFlags) {
  const { text: trimmed, truncated } = trimPosting(postingText);
  const domainFlagsLine =
    domainFlags && domainFlags.length
      ? `\n\nDETECTED DOMAIN-FLAG TERMS IN POSTING (keyword scan, cross-check each against the profile per the scoring guidance): ${domainFlags.join(", ")}`
      : "";
  const prompt = `CANDIDATE PROFILE:\n${profile}\n\nCANDIDATE EXPECTED SALARY (per year): ${formatExpectedSalary(expectedSalary)}${domainFlagsLine}\n\nJOB POSTING:\n${trimmed}`;
  return { prompt, truncated };
}

// Scans text for balanced {...} spans (tracking brace depth, not just
// first-{-to-last-}) so we can pull a JSON object out of noisy surrounding
// prose rather than accidentally spanning from an early brace to an
// unrelated late one.
//
// Braces inside string values do not count. Without that, a perfectly good
// answer like {"summary":"Use } carefully"} closed depth early, produced the
// invalid fragment {"summary":"Use }, and the whole response was reported as
// unparseable — and this scanner only runs when the model wrapped its JSON in
// prose, which is exactly when it's needed. Quotes are only treated as string
// delimiters once inside an object (depth > 0); at depth 0 we're in the
// model's prose, where an odd number of quotation marks is normal and would
// otherwise swallow the rest of the text.
function findJsonObjects(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function extractJson(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // fall through to substring extraction below
  }

  // Reasoning models sometimes write the actual final answer as JSON
  // embedded partway through their own thinking trace, iterating on it
  // multiple times, rather than cleanly emitting it as the response. Try
  // each balanced {...} span found, last-to-first, since a later one is
  // more likely to be the final corrected answer than an earlier draft.
  const candidates = findJsonObjects(cleaned);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (err) {
      // try the next candidate
    }
  }

  throw new Error("No parseable JSON object found in response text");
}

// MV3 service workers get torn down after ~30s with no browser-API activity.
// A bare fetch() awaiting a slow local model doesn't count as activity, so a
// generation that takes a while can get the worker killed mid-request,
// closing the message channel back to content.js/popup.js before
// sendResponse ever fires. Ping a trivial extension API periodically while
// the fetch is in flight to keep resetting that idle timer.
function keepAlive(intervalMs = 20000) {
  const id = setInterval(() => {
    chrome.storage.local.get("lmStudio").catch(() => {});
  }, intervalMs);
  return () => clearInterval(id);
}

// The timeout, not max_tokens, is what actually bounds how long the user
// waits — a bigger max_tokens costs nothing for a request that finishes
// normally (the model stops itself via its own stop token), it only matters
// as a worst-case ceiling. Throughput (tokens/sec) varies a lot by model and
// hardware — one model measured ~65 tok/s, another ~17 tok/s for the same
// schema — so a single hardcoded timeout doesn't generalize. This is a
// popup setting for that reason: tune it to your own observed speed rather
// than have it silently guessed.
async function callLmStudio(systemPrompt, userPrompt) {
  const stored = await chrome.storage.local.get("lmStudio");
  const defaults = JOB_FIT_DEFAULTS.lmStudio;
  const url = (stored.lmStudio && stored.lmStudio.url) || defaults.url;
  const model = (stored.lmStudio && stored.lmStudio.model) || undefined;
  const timeoutSeconds = (stored.lmStudio && stored.lmStudio.timeoutSeconds) || defaults.timeoutSeconds;
  const timeoutMs = timeoutSeconds * 1000;
  const reasoningEffort =
    stored.lmStudio && stored.lmStudio.reasoningEffort !== undefined
      ? stored.lmStudio.reasoningEffort
      : defaults.reasoningEffort;
  const enableThinking =
    stored.lmStudio && typeof stored.lmStudio.enableThinking === "boolean"
      ? stored.lmStudio.enableThinking
      : defaults.enableThinking;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const stopKeepAlive = keepAlive();
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          // "/no_think" is an older Qwen3 convention for skipping the
          // reasoning phase entirely; harmless no-op for models that don't
          // recognize it, kept as a fallback alongside reasoning_effort
          // below for models that use the graduated-effort API instead.
          { role: "user", content: `${userPrompt}\n\n/no_think` },
        ],
        temperature: 0.2,
        max_tokens: 16000,
        frequency_penalty: 0.3,
        presence_penalty: 0.3,
        // Newer reasoning models (e.g. this Qwen3 variant) expose graduated
        // reasoning_effort levels (low/medium/high/xhigh) instead of a
        // binary think/no-think toggle. Three different "thinking" models
        // have now shown extremely verbose reasoning before ever reaching
        // real output — on one model/hardware combo, ~10 tok/s, making a
        // 16000-token ceiling a 25-minute worst case — so defaulting to
        // "low" targets the actual cause instead of just raising timeout/
        // token budgets further. Omitted entirely if unset, since it's
        // meaningless (and possibly rejected) by non-reasoning models.
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        // The model's own LM Studio page confirmed the real root cause:
        // it defaults to reasoning_effort "xhigh" with thinking enabled.
        // This is a direct, stronger override of that default — disable
        // thinking outright rather than just requesting a lower effort
        // level, which may still produce a non-trivial reasoning pass.
        ...(typeof enableThinking === "boolean" ? { enable_thinking: enableThinking } : {}),
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        failure: "timeout",
        error: `Local model didn't respond within ${timeoutSeconds}s. If LM Studio's own console shows it was still making progress (not stuck repeating itself), raise the timeout in the popup settings — this model may just need longer. If it looked stuck looping, a longer timeout won't help.`,
      };
    }
    return {
      ok: false,
      failure: "unreachable",
      error: `Could not reach LM Studio at ${url} — is it running? (${err.message})`,
    };
  } finally {
    clearTimeout(timeoutId);
    stopKeepAlive();
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, failure: "http", error: `LM Studio returned HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }

  const data = await resp.json().catch(() => null);
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  const reasoningContent = message?.reasoning_content;

  // Some "thinking" models write the actual final answer inside their own
  // reasoning trace and never separately emit it as `content` before
  // stopping — observed on two different models. Fall back to scanning
  // reasoning_content when content comes back empty.
  const raw = typeof content === "string" && content.trim() !== "" ? content : reasoningContent;

  if (typeof raw !== "string") {
    return { ok: false, failure: "shape", error: "Unexpected response shape from LM Studio.", raw: JSON.stringify(data) };
  }

  if (raw.trim() === "") {
    const finishReason = data?.choices?.[0]?.finish_reason;
    return {
      ok: false,
      failure: finishReason === "length" ? "length" : "empty",
      error:
        finishReason === "length"
          ? "The model hit the max_tokens cap before producing any output — likely stuck in its own reasoning trace. Try a smaller/faster or non-reasoning model."
          : "The model returned an empty response.",
    };
  }

  try {
    return { ok: true, data: extractJson(raw) };
  } catch (err) {
    return { ok: false, failure: "parse", error: "Could not parse JSON from the model's response.", raw };
  }
}

// Local models are unreliable at comparing two numeric ranges correctly
// (observed: claiming "within" while also saying the posting's ceiling is
// below the candidate's floor). Range comparison is pure arithmetic, so do
// it ourselves instead of trusting the model's stated verdict.
function compareSalary(salary, expectedSalary) {
  if (!salary) return salary;

  let min = salary.posting_stated_min;
  let max = salary.posting_stated_max;
  let currency = salary.posting_stated_currency;
  let basisNote = "";

  if (min == null && max == null) {
    min = salary.estimated_market_min;
    max = salary.estimated_market_max;
    currency = salary.estimated_market_currency;
    basisNote = " (posting didn't state a range — compared against the market estimate instead)";
  }

  if (min == null && max == null) {
    return { ...salary, vs_candidate_expectation: "unknown" };
  }

  const expectedRange = expectedSalary && currency && expectedSalary[currency];
  if (!expectedRange || (expectedRange.min == null && expectedRange.max == null)) {
    return { ...salary, vs_candidate_expectation: "unknown" };
  }

  let verdict;
  if (max != null && expectedRange.min != null && max < expectedRange.min) {
    verdict = "below";
  } else if (min != null && expectedRange.max != null && min > expectedRange.max) {
    verdict = "above";
  } else {
    verdict = "within";
  }

  return { ...salary, vs_candidate_expectation: verdict, note: `${salary.note || ""}${basisNote}`.trim() };
}

const SENIORITY_REGEX = /\b(senior|sr\.?|staff|lead|principal|architect)\b/i;

// Computed in code for the same reason as compareSalary: this is a
// keyword-presence check plus arithmetic, not something to leave to the
// model's judgment. A posting with no seniority language and a salary
// ceiling well below the candidate's floor is a stronger "skip" signal
// than any individual skill gap, and testing showed the model didn't
// reliably surface it on its own.
function checkSeniorityMismatch(postingText, salary, expectedSalary) {
  if (SENIORITY_REGEX.test(postingText)) return null;
  if (!salary) return null;

  // Only ever off a salary the POSTING actually stated. This used to fall back
  // to the model's own estimated_market_max, which made the check circular: the
  // model's hunch about the role's seniority produced the estimate, the estimate
  // tripped the flag, and the flag capped the score at 40. A posting that states
  // no salary gives us nothing to check, so it gets no flag.
  const max = salary.posting_stated_max;
  const currency = salary.posting_stated_currency;
  if (max == null || !currency) return null;

  const expectedRange = expectedSalary && expectedSalary[currency];
  if (!expectedRange || expectedRange.min == null) return null;

  const threshold = expectedRange.min * 0.8;
  if (max < threshold) {
    return `Posting doesn't mention senior/staff/lead/principal, and its salary ceiling (${max} ${currency}) is below 80% of your expected floor (${expectedRange.min} ${currency}) — likely below your level.`;
  }
  return null;
}

// Backstop for the domain-flag score cap: the prompt asks the model to cap
// its own score, but prompt-only guidance for this kind of conditional
// arithmetic has already proven unreliable (see salary comparison above).
// Enforce it here regardless of whether the model applied it itself.
function applyScoreCaps(data, { domainFlags, seniorityFlag }) {
  let score = data.score;
  const capReasons = [];

  if (typeof score === "number" && domainFlags && domainFlags.length && Array.isArray(data.required_gaps)) {
    const requiredGapsLower = data.required_gaps.map((g) => String(g).toLowerCase());
    const uncoveredDomainFlag = domainFlags.some((flag) =>
      requiredGapsLower.some((g) => g.includes(flag.toLowerCase()) || flag.toLowerCase().includes(g))
    );
    if (uncoveredDomainFlag && score > 50) {
      score = 50;
      capReasons.push("required domain-flag gap not covered by profile");
    }
  }

  if (typeof score === "number" && seniorityFlag && score > 40) {
    score = 40;
    capReasons.push("seniority/comp mismatch");
  }

  return { ...data, score, score_cap_reasons: capReasons.length ? capReasons : undefined };
}

// expectedSalary arrives in the message rather than being read from storage
// here: the caller has already resolved the active profile, and a second
// independent read could land on a different profile if the user switched in
// between, scoring a posting against one profile's keywords and another's
// salary expectations.
async function evaluateWithLmStudio({ profile, postingText, domainFlags, expectedSalary }) {
  const { prompt, truncated } = buildUserPrompt(profile, postingText, expectedSalary, domainFlags);
  const result = await callLmStudio(SYSTEM_PROMPT, prompt);

  if (result.ok && result.data) {
    // Surfaced in the banner: a score produced from a partial posting is worth
    // knowing about, and silently dropping text is what made this a bug.
    result.data.input_truncated = truncated;
    if (result.data.salary) {
      result.data.salary = compareSalary(result.data.salary, expectedSalary);
    }
    const seniorityFlag = checkSeniorityMismatch(postingText, result.data.salary, expectedSalary);
    result.data.seniority_flag = seniorityFlag;
    result.data = applyScoreCaps(result.data, { domainFlags, seniorityFlag });
  }

  return result;
}

const SALARY_SUGGEST_PROMPT = `You estimate reasonable target salary ranges for a candidate based on their profile, for each of three currencies/markets.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "USD": { "min": <integer, annual>, "max": <integer, annual> },
  "CAD": { "min": <integer, annual>, "max": <integer, annual> },
  "MXN": { "min": <integer, annual>, "max": <integer, annual> },
  "reasoning": "<one or two sentences: role, seniority, and market basis for each estimate>"
}

Base each on the candidate's years of experience, skill level, domain, and any target location/role mentioned in the profile, adjusted for that market. These are starting points for the candidate to adjust, not precise figures.`;

async function suggestSalary({ profile }) {
  return callLmStudio(SALARY_SUGGEST_PROMPT, `CANDIDATE PROFILE:\n${profile}`);
}

const SUMMARIZE_SYSTEM_PROMPT = `You condense a job posting into a compact brief for another AI assistant to quickly assess candidate fit. That assistant already has the candidate's full profile/CV — it only needs the posting, stripped of bloat.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "summary": "<condensed posting, plain text, short lines separated by \\n, under 200 words>"
}

Include only what's relevant to assessing fit: role title, company, location, seniority, required qualifications (marked required), preferred qualifications (marked preferred), salary/compensation if stated, visa/sponsorship/citizenship language if stated, remote/hybrid/onsite status.
Keep alternatives as alternatives: a requirement worded "C++, Kotlin or Java" must stay "C++, Kotlin or Java" and never become "C++, Kotlin, Java". Flattening an "or" list into a plain list makes the role read as demanding all of them, which the assistant receiving this brief will score as gaps.
Omit: generic company boilerplate, benefits lists, EEO/diversity statements, application instructions, legal disclaimers, generic culture statements.`;

function buildSummarizePrompt(postingText) {
  return `JOB POSTING:\n${trimPosting(postingText).text}`;
}

// ---------------------------------------------------------------------------
// Queue wiring
// ---------------------------------------------------------------------------

const QUEUE_ALARM = "jobfit-queue-watchdog";

async function configuredTimeoutMs() {
  const stored = await chrome.storage.local.get("lmStudio");
  const seconds = (stored.lmStudio && stored.lmStudio.timeoutSeconds) || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
  return seconds * 1000;
}

async function setBadge(count, state) {
  try {
    await chrome.action.setBadgeText({ text: count ? String(count) : "" });
    if (count) {
      await chrome.action.setBadgeBackgroundColor({ color: state === "paused" ? "#b7791f" : "#3574d6" });
    }
  } catch (err) {
    // Badge is cosmetic; never let it break processing.
  }
}

// Best-effort. The tab may be closed, may have navigated, or may have lost the
// activeTab grant — the history page is the source of truth, so a failure here
// is not an error. The content script re-checks that the result still belongs
// to what it is showing before painting anything.
async function notifyTab(item, record) {
  if (!item.tabId) return;
  try {
    await chrome.tabs.sendMessage(item.tabId, {
      type: "JOB_FIT_RESULT",
      jobKey: item.jobKey,
      profileName: item.profileName,
      record,
    });
  } catch (err) {
    /* nothing to do */
  }
}

async function runQueuedEvaluation(item) {
  const snapshot = item.profileSnapshot || {};
  const result = await evaluateWithLmStudio({
    profile: snapshot.profile,
    postingText: item.postingText,
    domainFlags: item.domainFlags,
    expectedSalary: snapshot.expectedSalary,
  });
  if (!result.ok) return result;

  // Reported as an item failure rather than thrown: the queue keeps moving and
  // the tracked-jobs page shows what went wrong on that one job.
  let record;
  try {
    record = await JOB_FIT_EVALSTORE.saveEvaluation({
      jobKey: item.jobKey,
      profileId: item.profileId,
      profileName: item.profileName,
      url: item.url,
      title: item.title,
      company: item.company,
      location: item.location,
      text: item.postingText,
      extractor: item.extractor,
      profileFingerprint: snapshot.fingerprint,
      hardReject: null,
      evaluation: result.data,
      score: result.data.score,
      verdict: result.data.verdict,
      domainFlags: item.domainFlags,
      softWarnings: item.softWarnings,
    });
  } catch (err) {
    return { ok: false, failure: "storage", error: `Scored, but could not be saved: ${err.message}` };
  }

  await notifyTab(item, record);
  return { ok: true };
}

async function runQueuedSummarize(item) {
  const result = await callLmStudio(SUMMARIZE_SYSTEM_PROMPT, buildSummarizePrompt(item.postingText));
  if (!result.ok) return result;

  const summary = (result.data && result.data.summary) || "";
  const record = await JOB_FIT_EVALSTORE.saveSummary({
    jobKey: item.jobKey,
    profileId: item.profileId,
    profileName: item.profileName,
    url: item.url,
    title: item.title,
    company: item.company,
    location: item.location,
    text: item.postingText,
    summary,
  });

  // Assembled here rather than in the popup so the brief survives the popup
  // being destroyed — which, before the queue, is exactly how a finished
  // summary got lost.
  const header = [item.title, item.company, item.location].filter(Boolean).join(" — ");
  const combined =
    (header ? `${header}\n\n` : "") + summary + JOB_FIT_EVALSTORE.formatEvaluation(record);

  await chrome.storage.local.set({
    lastSummary: { url: item.url, ts: Date.now(), profileId: item.profileId, jobKey: item.jobKey, text: combined },
  });
  return { ok: true };
}

JOB_FIT_QUEUE.configure({
  evaluate: runQueuedEvaluation,
  summarize: runQueuedSummarize,
  timeoutMs: configuredTimeoutMs,
  setBadge,
});

// Kept only while there is something to watch, so the worker isn't woken
// every minute forever.
async function syncWatchdog() {
  const snapshot = await JOB_FIT_QUEUE.snapshot();
  if (snapshot.active > 0) {
    await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(QUEUE_ALARM);
  }
}

async function kick() {
  await syncWatchdog();
  JOB_FIT_QUEUE.pump().then(syncWatchdog);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) kick();
});

// Resume automatically after a browser restart or an extension reload: a batch
// left running overnight should still be running in the morning.
chrome.runtime.onStartup.addListener(kick);
chrome.runtime.onInstalled.addListener(kick);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "JOB_FIT_ENQUEUE") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    JOB_FIT_QUEUE.enqueue({ ...message.item, tabId }, { priority: message.priority }).then((result) => {
      sendResponse(result);
      if (result.ok) kick();
    });
    return true;
  }
  if (message?.type === "JOB_FIT_QUEUE_SNAPSHOT") {
    JOB_FIT_QUEUE.snapshot().then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_QUEUE_CANCEL") {
    JOB_FIT_QUEUE.cancel(message.id).then((r) => {
      sendResponse(r);
      kick();
    });
    return true;
  }
  if (message?.type === "JOB_FIT_QUEUE_RETRY") {
    JOB_FIT_QUEUE.retry(message.id).then((r) => {
      sendResponse(r);
      kick();
    });
    return true;
  }
  if (message?.type === "JOB_FIT_QUEUE_RESUME") {
    JOB_FIT_QUEUE.resume().then((r) => {
      sendResponse(r);
      kick();
    });
    return true;
  }
  if (message?.type === "JOB_FIT_QUEUE_CLEAR_FINISHED") {
    JOB_FIT_QUEUE.clearFinished().then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_SUGGEST_SALARY") {
    suggestSalary(message).then(sendResponse);
    return true;
  }
  return false;
});

// A worker that starts for any reason picks the queue back up.
kick();
