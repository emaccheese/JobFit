// Pulls in JOB_FIT_DEFAULTS so the fallbacks below are the same values the
// popup shows. They used to be hand-mirrored constants here, which drifted
// once already: reasoning_effort and enable_thinking were added to the popup
// but not to this file, so neither was ever sent for anyone who hadn't
// re-saved their settings.
importScripts("defaults.js", "provider.js", "keywords.js", "screening.js", "profiles.js", "evalstore.js", "queue.js", "lmstudio-ui.js", "inject.js");

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
- A requirement that offers alternatives is satisfied by ANY ONE of them, not all of them. "Experience in one or more object oriented languages like C++, Kotlin or Java" is a MATCH for a C++ engineer — it is NOT two gaps for Kotlin and Java. Treat "or", "and/or", "one or more of", "such as", "e.g.", "or similar" and "or equivalent" all this way: when a requirement lists alternatives joined by "or" or "and/or", satisfying any one alternative is a full match. "C++ and/or Rust" is fully met by C++ — Rust is NOT a gap. The alternatives can be whole phrases, not just single languages: "low-latency, high-throughput backend services or multi-threaded/concurrent data engines" is fully met by concurrent data engine experience, so low-latency backend services is NOT a gap. Once you list one alternative as a match, no other alternative from that same requirement may appear in gaps or required_gaps. Only when the profile covers NONE of the listed alternatives is it a gap, and then name the requirement as a whole rather than each alternative separately. A list joined by plain "and" is the opposite: it does require all of them.
- If the posting requires something the profile never mentions — even if the profile doesn't explicitly call it out as a gap — it belongs in "gaps" (and "required_gaps" if the posting marks it required). Silence in the profile on a stated requirement IS a gap.
- Do not restate the candidate profile's own "Gaps:" list unless those exact items also appear as requirements in this posting.
- Don't list something as a match if you've also listed a closely related required skill as a gap (e.g. don't claim "deep learning architecture experience" as a match while listing PyTorch/TensorFlow as gaps — those are the tools that experience would require).
- Never list the candidate's own stated specialization or strengths as a reason against fit (e.g. "specialized imaging focus" is not a weakness) unless the posting explicitly says that specialization is a mismatch. Only genuinely unmet posting requirements belong in gaps/one_line's reasoning.

CRITICAL — classify every gap before placing it: for each item in "gaps", explicitly check whether the posting lists it under a Required/Must-have section or a Preferred/Nice-to-have section (headings vary: "Requirements" vs "Nice to have", "must have" vs "bonus points", etc.). Only items the posting itself marks as required belong in "required_gaps". An item under Preferred/Nice-to-have must NEVER appear in required_gaps, even if it seems important to you. The one exception is a DETECTED DOMAIN-FLAG TERM whose work the responsibilities require — see scoring guidance.

CRITICAL — domain flags are informational and must never be listed as required gaps on their own. A DETECTED DOMAIN-FLAG TERM only means a keyword scan saw that word somewhere in the posting (possibly the job title, the company blurb, or one side of an "or"). It is a prompt to check the posting, not evidence of a gap. Judge it exactly like any other requirement from how the posting actually phrases it: if it appears only in the title or company description, it is not a requirement; if it is one alternative of an "or"/"and/or" requirement the profile already satisfies another way, it is a match, not a gap.

CRITICAL — salary numbers only, no verdict: extract/estimate the numeric min/max/currency fields as accurately as you can. Do not compare them to the candidate's expectation yourself — that comparison is computed separately from your numbers, so just report what the posting states and your market estimate.

Scoring guidance:
- Score = the proportion of REQUIRED items the candidate satisfies, not a count of gaps. A candidate meeting most required items should score well even with 2-3 gaps — don't let a handful of gaps drag the score down disproportionately when the majority of required items are met.
- Preferred-only gaps (items under Preferred/Nice-to-have, not Required) adjust the score by no more than -5 total, combined.
- A required language the candidate lacks (e.g. C#) caps the score at 60.
- "distributed systems" as a requirement caps at 45.
- Domain match (image/video/color/GPU/embedded) adds up to +15.
- A DETECTED DOMAIN-FLAG TERM (listed below, if present) is effectively required when the posting marks it required OR when the responsibilities describe the hire doing that work themselves — regardless of where, or whether, it appears in the qualifications. Listing it only as preferred doesn't make it optional if the day-to-day job is that work. Working alongside a team that does it, or using its output, is not doing it. Appearing in the job title or company description alone does not make it required, and neither does being one alternative of an "or"/"and/or" requirement the profile satisfies another way. If any effectively required term isn't substantively covered by the candidate profile, cap the score at 50 and list it in required_gaps.
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
  // Everything that's the same on every call comes first — the system prompt,
  // then this profile and its salary expectations — and everything that
  // changes per posting comes last. Providers cache a repeated prefix (OpenAI
  // bills it at a discount; LM Studio reuses its KV cache), and the domain-flag
  // line used to sit between the profile and the posting, cutting that prefix
  // short on every posting that hit a different flag.
  const prompt = `CANDIDATE PROFILE:\n${profile}\n\nCANDIDATE EXPECTED SALARY (per year): ${formatExpectedSalary(expectedSalary)}\n\nJOB POSTING:\n${trimmed}${domainFlagsLine}`;
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

function lmStudioRequestBody(systemPrompt, userPrompt, settings) {
  const { reasoningEffort, enableThinking, seed } = settings;
  return {
    model: settings.model || undefined,
    messages: [
      { role: "system", content: systemPrompt },
      // "/no_think" is an older Qwen3 convention for skipping the
      // reasoning phase entirely; harmless no-op for models that don't
      // recognize it, kept as a fallback alongside reasoning_effort
      // below for models that use the graduated-effort API instead.
      { role: "user", content: `${userPrompt}\n\n/no_think` },
    ],
    temperature: 0.2,
    // Reproducibility, not determinism-at-any-cost: the same posting and
    // profile give the same score twice, while temperature stays where it
    // produces better output than greedy decoding.
    ...(typeof seed === "number" ? { seed } : {}),
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
  };
}

// OpenAI goes through the Responses API (POST /v1/responses), its current
// recommended API; LM Studio stays on chat completions, which is what its
// server implements. OpenAI rejects parameters it doesn't support rather than
// ignoring them, so this sends only what the chosen model takes:
// - no "/no_think" (a local-model convention) and no penalties (they were
//   there to stop local models looping); no seed, which Responses doesn't take
// - JSON mode via text.format. It requires the word "JSON" in the input
//   messages, so the instructions go in as a developer message rather than
//   the separate `instructions` field.
// - store: false. Responses keeps each response on OpenAI's side by default
//   for later retrieval; nothing here ever retrieves one, and the input is
//   a CV and salary expectations.
// - Reasoning models (o-series, gpt-5) take reasoning.effort and only the
//   default temperature; the others take temperature.
function openAiRequestBody(systemPrompt, userPrompt, settings, { caps = {}, tier = null } = {}) {
  const reasoning = JOB_FIT_PROVIDER.isOpenAiReasoningModel(settings.model);
  const effort = caps.noReasoning
    ? ""
    : JOB_FIT_PROVIDER.effectiveReasoningEffort(settings.model, settings.reasoningEffort, caps.rejectedEfforts);
  const sendTemperature = !reasoning && !caps.noTemperature;
  return {
    model: settings.model,
    input: [
      { role: "developer", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: { format: { type: "json_object" } },
    max_output_tokens: settings.maxOutputTokens,
    store: false,
    ...(sendTemperature ? { temperature: 0.2 } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(tier ? { service_tier: tier } : {}),
  };
}

// A Responses API reply is a list of output items — reasoning items, then the
// assistant message whose content parts hold the text. Returns the text, or a
// failure in the same shape callLmStudio uses everywhere else.
function readOpenAiResponse(data) {
  if (!data || !Array.isArray(data.output)) {
    return { ok: false, failure: "shape", error: "Unexpected response shape from OpenAI." };
  }
  const parts = data.output
    .filter((item) => item && item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  const refusal = parts.find((p) => p.type === "refusal");
  if (refusal) {
    return { ok: false, failure: "refusal", error: `OpenAI declined to answer: ${refusal.refusal || "no reason given"}` };
  }
  const text = parts
    .filter((p) => p.type === "output_text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (text.trim()) return { ok: true, text };

  // Nothing usable: say why, when OpenAI says why.
  const reason = data.incomplete_details && data.incomplete_details.reason;
  if (data.status === "incomplete" && reason === "max_output_tokens") {
    return {
      ok: false,
      failure: "length",
      error: "The model used its whole output budget (much of it on reasoning) before answering. Lower the reasoning effort or pick a non-reasoning model.",
    };
  }
  return {
    ok: false,
    failure: "empty",
    error: `OpenAI returned no text${data.status && data.status !== "completed" ? ` (status: ${data.status}${reason ? `, ${reason}` : ""})` : ""}.`,
  };
}

// --- token usage ----------------------------------------------------------
//
// Both APIs report what a request used, in different field names. Kept per
// local day and provider in `usageByDay`, which drives the popup's totals and
// the OpenAI daily budget. Tokens, not dollars: prices differ per model and
// change, and a stale price table would be worse than none.

const USAGE_KEEP_DAYS = 62;

function usageFrom(provider, data) {
  const u = data && data.usage;
  if (!u) return null;
  if (provider === "openai") {
    return {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      reasoning: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0,
      cached: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
      // Billed above the normal input rate on models that list a cache-write price.
      cacheWrite: (u.input_tokens_details && u.input_tokens_details.cache_write_tokens) || 0,
    };
  }
  return {
    input: u.prompt_tokens || 0,
    output: u.completion_tokens || 0,
    reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
    cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    cacheWrite: (u.prompt_tokens_details && u.prompt_tokens_details.cache_write_tokens) || 0,
  };
}

// Serialized: wizard calls can finish while a queued evaluation does, and
// two read-modify-writes of the same key would drop one of them.
let usageWrite = Promise.resolve();

function recordUsage(provider, usage) {
  if (!usage) return Promise.resolve();
  usageWrite = usageWrite.then(async () => {
    const stored = await chrome.storage.local.get("usageByDay");
    const days = stored.usageByDay || {};
    const key = JOB_FIT_PROVIDER.dayKey();
    const day = (days[key] = days[key] || {});
    const t = (day[provider] = day[provider] || { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0 });
    t.requests += 1;
    if (usage.tier === "flex") t.flexRequests = (t.flexRequests || 0) + 1;
    t.cacheWrite = (t.cacheWrite || 0) + (usage.cacheWrite || 0);
    t.input += usage.input;
    t.output += usage.output;
    t.reasoning += usage.reasoning;
    t.cached += usage.cached;
    Object.keys(days)
      .sort()
      .slice(0, -USAGE_KEEP_DAYS)
      .forEach((old) => delete days[old]);
    await chrome.storage.local.set({ usageByDay: days });
  }).catch(() => {});
  return usageWrite;
}

async function openAiTokensToday() {
  const stored = await chrome.storage.local.get("usageByDay");
  const day = (stored.usageByDay || {})[JOB_FIT_PROVIDER.dayKey()] || {};
  const t = day.openai;
  return t ? t.input + t.output : 0;
}

// One POST with a timeout, a caller's cancel signal and the service-worker
// keep-alive. Returns { resp } or { error: "cancelled" | "timeout" |
// "unreachable", message }.
async function postJson(url, body, { apiKey, timeoutMs, signal }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const stopKeepAlive = keepAlive();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    return { resp };
  } catch (err) {
    if (err.name === "AbortError") return { error: signal && signal.aborted ? "cancelled" : "timeout" };
    return { error: "unreachable", message: err.message };
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    stopKeepAlive();
  }
}

function parseOpenAiError(text) {
  try {
    const e = (JSON.parse(text) || {}).error || {};
    return { message: e.message || "", param: e.param || "", code: e.code || "", type: e.type || "" };
  } catch (err) {
    return { message: "", param: "", code: "", type: "" };
  }
}

// --- self-correcting OpenAI parameters -------------------------------------
//
// Which models take temperature, which reasoning levels, and which support
// Flex is guessed from the model name (provider.js) — and names change with
// every release. So when OpenAI rejects a setting as unsupported, the request
// is retried without it and the model's quirk is remembered in
// `openaiModelCaps`, so the next request gets it right first time.

const FLEX_MIN_TIMEOUT_SECONDS = 900;

async function loadModelCaps(model) {
  const stored = await chrome.storage.local.get("openaiModelCaps");
  const caps = (stored.openaiModelCaps || {})[model] || {};
  return { noTemperature: false, noReasoning: false, noFlex: false, rejectedEfforts: [], ...caps };
}

async function saveModelCaps(model, caps) {
  const stored = await chrome.storage.local.get("openaiModelCaps");
  const all = stored.openaiModelCaps || {};
  all[model] = caps;
  await chrome.storage.local.set({ openaiModelCaps: all });
}

// Returns which setting was adjusted ("temperature", "reasoning",
// "service_tier"), or null when the rejection isn't one a retry can fix.
function learnFromRejection(status, err, body, caps) {
  if (status !== 400) return null;
  const text = `${err.param} ${err.message}`.toLowerCase();
  if (!/unsupported|not supported|does not support|invalid value|not allowed/.test(text)) return null;

  if (/temperature/.test(text) && "temperature" in body && !caps.noTemperature) {
    caps.noTemperature = true;
    return "temperature";
  }
  if (/reasoning/.test(text) && body.reasoning && !caps.noReasoning) {
    // A level the model doesn't take: try without that level first (the next
    // one down, if any), and only then without reasoning at all.
    const effort = body.reasoning.effort;
    if (effort && !caps.rejectedEfforts.includes(effort)) caps.rejectedEfforts.push(effort);
    else caps.noReasoning = true;
    return "reasoning";
  }
  if (/service_tier|flex/.test(text) && body.service_tier && !caps.noFlex) {
    caps.noFlex = true;
    return "service_tier";
  }
  return null;
}

// Flex is half price and slower. "bulk" (the default) uses it only for work
// nobody is watching — re-evaluations queued from Tracked jobs.
function wantsFlex(settings, bulk, caps) {
  if (caps && caps.noFlex) return false;
  if (settings.flex === "always") return true;
  if (settings.flex === "never") return false;
  return Boolean(bulk);
}

// The timeout, not max_tokens, is what actually bounds how long the user
// waits — a bigger max_tokens costs nothing for a request that finishes
// normally (the model stops itself via its own stop token), it only matters
// as a worst-case ceiling. Throughput (tokens/sec) varies a lot by model and
// hardware — one model measured ~65 tok/s, another ~17 tok/s for the same
// schema — so a single hardcoded timeout doesn't generalize. This is a
// popup setting for that reason: tune it to your own observed speed rather
// than have it silently guessed.
// `signal` lets a caller cancel: the setup wizard's model calls can take
// minutes, and a Cancel button that only hid the spinner would leave LM
// Studio busy generating an answer nobody is waiting for.
async function callLmStudio(systemPrompt, userPrompt, { signal, bulk = false } = {}) {
  // Named for where it started; it now calls whichever provider is selected
  // (see provider.js): LM Studio's chat-completions endpoint, or OpenAI's
  // Responses API. The request and reply shapes differ per provider; the
  // result handed back is the same either way.
  const settings = await JOB_FIT_PROVIDER.load();
  const { url, provider, label, timeoutSeconds } = settings;
  const model = settings.model || undefined;

  if (provider === "openai") {
    // Caught here rather than sent: OpenAI would answer 401/400, and "config"
    // pauses the queue with a message that says what to fix.
    if (!settings.apiKey) {
      return { ok: false, failure: "config", error: "No OpenAI API key is set. Add it in the popup under Model, or switch the provider back to LM Studio." };
    }
    if (!model) {
      return { ok: false, failure: "config", error: "No OpenAI model is selected. Pick one in the popup under Model." };
    }
    // Checked before sending, so the request that would cross the line is
    // never made. "budget" pauses the queue; raising the budget resumes it.
    if (settings.dailyTokenBudget) {
      const used = await openAiTokensToday();
      if (used >= settings.dailyTokenBudget) {
        return {
          ok: false,
          failure: "budget",
          error: `Today's OpenAI budget is used up (${used.toLocaleString()} of ${settings.dailyTokenBudget.toLocaleString()} tokens). Raise it in the popup under Model to continue now, or press Resume tomorrow.`,
        };
      }
    }
  }

  const startedAt = Date.now();
  // What this model is known to reject (learned from earlier replies), and
  // whether to ask for Flex. Both can change between attempts below.
  const caps = provider === "openai" ? await loadModelCaps(model) : null;
  let tier = provider === "openai" && wantsFlex(settings, bulk, caps) ? "flex" : null;
  let fellBackFromFlex = false;
  let resp;
  let failureBody = "";

  // At most one retry per adjustable setting, so a model that keeps rejecting
  // things can't loop: temperature, reasoning effort (twice: a lower level,
  // then none) and Flex.
  for (let attempt = 0; attempt < 5; attempt++) {
    const body =
      provider === "openai"
        ? openAiRequestBody(systemPrompt, userPrompt, settings, { caps, tier })
        : lmStudioRequestBody(systemPrompt, userPrompt, settings);
    // Flex responses are slower by design; OpenAI's own SDKs allow 10 minutes.
    const attemptTimeoutSeconds = tier === "flex" ? Math.max(timeoutSeconds, FLEX_MIN_TIMEOUT_SECONDS) : timeoutSeconds;
    const sent = await postJson(url, body, {
      apiKey: provider === "openai" ? settings.apiKey : null,
      timeoutMs: attemptTimeoutSeconds * 1000,
      signal,
    });

    if (sent.error) {
      if (sent.error === "cancelled") return { ok: false, failure: "cancelled", error: "Cancelled." };
      if (sent.error === "timeout") {
        return {
          ok: false,
          failure: "timeout",
          error:
            provider === "openai"
              ? `OpenAI didn't respond within ${attemptTimeoutSeconds}s${tier === "flex" ? " (Flex processing is slower by design)" : ""}. Try again, or raise the timeout in the popup settings.`
              : `Local model didn't respond within ${timeoutSeconds}s. If LM Studio's own console shows it was still making progress (not stuck repeating itself), raise the timeout in the popup settings — this model may just need longer. If it looked stuck looping, a longer timeout won't help.`,
        };
      }
      return {
        ok: false,
        failure: "unreachable",
        error:
          provider === "openai"
            ? `Could not reach OpenAI — check the internet connection. (${sent.message})`
            : `Could not reach LM Studio at ${url} — is it running? (${sent.message})`,
      };
    }

    resp = sent.resp;
    if (resp.ok || provider !== "openai") break;

    failureBody = await resp.text().catch(() => "");
    const err = parseOpenAiError(failureBody);

    // No Flex capacity right now. Not billed; retried on Standard, which is
    // OpenAI's own recommended fallback, so the queue never stalls on it.
    if (tier === "flex" && resp.status === 429 && /resource.?unavailable|capacity/i.test(`${err.code} ${err.type} ${err.message}`)) {
      tier = null;
      fellBackFromFlex = true;
      continue;
    }

    // A setting this model doesn't take: remember that, and retry without it.
    const adjusted = learnFromRejection(resp.status, err, body, caps);
    if (adjusted) {
      if (adjusted === "service_tier") tier = null;
      await saveModelCaps(model, caps);
      continue;
    }
    break;
  }

  if (!resp.ok) {
    const body = provider === "openai" ? failureBody : await resp.text().catch(() => "");
    // Names the model: a paused queue shows this message until it resumes, and
    // without the name there's no way to tell whether it's about the model
    // configured now or one you've since switched away from.
    const which = model ? ` for model "${model}"` : "";
    // OpenAI wraps its reason in {"error":{"message"}}; show just that.
    const detail = parseOpenAiError(body).message || body.slice(0, 300);
    return { ok: false, failure: "http", error: `${label} returned HTTP ${resp.status}${which}: ${detail}` };
  }

  const data = await resp.json().catch(() => null);
  // Recorded whatever happens next: a reply that fails to parse was still billed.
  const usage = usageFrom(provider, data);
  if (usage && provider === "openai") {
    // What actually served it, which OpenAI says can differ from what was asked.
    usage.tier = (data && data.service_tier) || tier || "default";
    if (fellBackFromFlex) usage.flexFallback = true;
  }
  await recordUsage(provider, usage);

  if (provider === "openai") {
    const read = readOpenAiResponse(data);
    if (!read.ok) return { ...read, raw: JSON.stringify(data) };
    try {
      return { ok: true, data: extractJson(read.text), model: model || "", usage, durationMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, failure: "parse", error: "Could not parse JSON from OpenAI's response.", raw: read.text };
    }
  }

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
    // The model is reported back so it can be stored on the record: scores from
    // different models are not comparable, and the history page sorts by score.
    return { ok: true, data: extractJson(raw), model: model || "", usage, durationMs: Date.now() - startedAt };
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

  // raw_score preserves what the model actually said. The caps are heuristics,
  // so seeing only the capped number leaves no way to judge whether the cap was
  // fair — "40, seniority/comp mismatch" reads very differently once you know
  // the model scored it 78.
  return {
    ...data,
    score,
    raw_score: capReasons.length ? data.score : undefined,
    score_cap_reasons: capReasons.length ? capReasons : undefined,
  };
}

// expectedSalary arrives in the message rather than being read from storage
// here: the caller has already resolved the active profile, and a second
// independent read could land on a different profile if the user switched in
// between, scoring a posting against one profile's keywords and another's
// salary expectations.
async function evaluateWithLmStudio({ profile, postingText, domainFlags, expectedSalary }, signal, { bulk = false } = {}) {
  const { prompt, truncated } = buildUserPrompt(profile, postingText, expectedSalary, domainFlags);
  const result = await callLmStudio(SYSTEM_PROMPT, prompt, { signal, bulk });

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

async function suggestSalary({ profile }, signal) {
  return callLmStudio(SALARY_SUGGEST_PROMPT, `CANDIDATE PROFILE:\n${profile}`, { signal });
}

// Asks for one field per template section rather than the finished text, and
// the text is assembled here. A local model asked for a multi-line string
// inside JSON gets the escaping wrong often enough to matter, and assembling
// it in code guarantees the section labels the evaluator relies on (Gaps:,
// Work authorisation:, Target:) are always spelled the same way.
const PROFILE_DRAFT_PROMPT = `You condense a candidate's CV into a short profile that a job-fit evaluator reads on every evaluation.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "headline": "<one line: seniority, main language/discipline, years of experience, industry>",
  "core": "<the systems they actually built: domain, scale, the part they owned>",
  "specialisms": "<the two or three things they are genuinely strong at, with concrete techniques or standards>",
  "tooling": "<languages, frameworks, OS, hardware>",
  "leadership": "<team size, scope, a result — or empty string if the CV shows none>",
  "gaps": "<technologies and domains common in their target roles that the CV shows NO experience with, stated plainly>",
  "work_authorisation": "<citizenship/visa status and whether sponsorship is needed>",
  "target": "<roles, seniority and locations they want>"
}

Rules:
- Use only facts in the CV. Never invent employers, numbers, or skills.
- Keep the whole profile under 400 words. Prefer specifics over adjectives.
- "gaps" matters most: an evaluator uses it to tell a real gap from a silence. Name concrete things (e.g. "Kubernetes, distributed systems, mobile"), never soft skills. If the CV is too thin to judge, name the most common requirements of the target roles it doesn't mention.
- For "work_authorisation", use the CANDIDATE ANSWERS when given; they override anything the CV implies.`;

function assembleDraftProfile(draft) {
  const clean = (value) => (typeof value === "string" ? value.trim() : "");
  const lines = [clean(draft.headline)];
  [
    ["Core", draft.core],
    ["Specialisms", draft.specialisms],
    ["Tooling/platform", draft.tooling],
    ["Leadership", draft.leadership],
    ["Gaps", draft.gaps],
    ["Work authorisation", draft.work_authorisation],
    ["Target", draft.target],
  ].forEach(([label, value]) => {
    // Gaps is kept even when empty, so the gap in the profile is visible in
    // the editor rather than silently missing.
    if (clean(value) || label === "Gaps") lines.push(`${label}: ${clean(value)}`);
  });
  return lines.filter(Boolean).join("\n");
}

async function draftProfile({ cv, answersText }, signal) {
  const answers = answersText ? `\n\nCANDIDATE ANSWERS:\n${answersText}` : "";
  const result = await callLmStudio(PROFILE_DRAFT_PROMPT, `CV:\n${String(cv).slice(0, 20000)}${answers}`, { signal });
  if (!result.ok) return result;
  return { ok: true, profile: assembleDraftProfile(result.data || {}) };
}

const DOMAIN_FLAG_SUGGEST_PROMPT = `You propose "domain flags" for a job-fit evaluator: short terms that, when they appear in a job posting, point at a skill or domain this candidate does NOT have.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "terms": ["<5 to 12 short terms, 1-3 words each>"]
}

Rules:
- Start from the profile's "Gaps:" line, then add closely related terms that postings for the candidate's target roles commonly require.
- Write each term the way postings phrase it ("machine learning", "Kubernetes", "React Native"), so it can be matched as literal text.
- Never include anything the profile says the candidate has, and nothing generic ("communication", "teamwork", "software").`;

async function suggestDomainFlags({ profile }, signal) {
  const result = await callLmStudio(DOMAIN_FLAG_SUGGEST_PROMPT, `CANDIDATE PROFILE:\n${profile}`, { signal });
  if (!result.ok) return result;
  const terms = Array.isArray(result.data?.terms) ? result.data.terms : [];
  const seen = new Set();
  const cleaned = terms
    .map((t) => String(t).trim())
    .filter((t) => t && t.length <= 40 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  return { ok: true, terms: cleaned };
}

// The wizard's try-it run. Calls the evaluator directly instead of going
// through the queue, so a test against a sample posting is never filed as a
// tracked job. It still respects the one-request-at-a-time rule by refusing
// to run while the queue is working.
async function testEvaluate(message, signal) {
  const snapshot = await JOB_FIT_QUEUE.snapshot();
  if (snapshot.active > 0) {
    return { ok: false, failure: "busy", error: `The queue is evaluating ${snapshot.active} job(s) — try again when it's done.` };
  }
  return evaluateWithLmStudio(
    {
      profile: message.profile,
      postingText: message.postingText,
      domainFlags: message.domainFlags,
      expectedSalary: message.expectedSalary,
    },
    signal
  );
}

// Wizard calls carry a callId so the page can cancel them. Kept in memory
// only: if the worker restarts, the fetch it owned is gone with it anyway.
const cancellableCalls = new Map();

function runCancellable(callId, run) {
  const controller = new AbortController();
  if (callId) cancellableCalls.set(callId, controller);
  return run(controller.signal).finally(() => {
    if (callId) cancellableCalls.delete(callId);
  });
}

// Fixed fields rather than one free-text summary, assembled into text in
// code. With a single "summary" string every model chose its own layout and
// its own idea of what mattered — and some reported a score, which the model
// is never given and was copying from JobFit's own banner text on the page.
// Fields make the brief look the same whichever model wrote it, and an
// explicit "not stated" is kept visible rather than silently missing.
const SUMMARIZE_SYSTEM_PROMPT = `You condense a job posting into a structured brief for another AI assistant that will assess candidate fit. That assistant already has the candidate's full profile/CV — it only needs the posting, stripped of bloat.
Return ONLY a JSON object, no prose, no markdown fences.

Schema:
{
  "role": "<job title as stated>",
  "seniority": "<level as stated (e.g. Senior, Staff, II), or 'not stated'>",
  "location": "<city/country plus remote, hybrid or onsite, as stated, or 'not stated'>",
  "responsibilities": ["<3 to 5 short lines: what the hire will actually do day to day>"],
  "required": ["<each required qualification, one per item>"],
  "preferred": ["<each preferred / nice-to-have qualification, one per item>"],
  "compensation": "<pay exactly as stated, with currency and period, or 'not stated'>",
  "work_authorization": "<visa, sponsorship, citizenship or clearance language exactly as stated, or 'not stated'>",
  "other_notes": "<anything else that affects fit, such as travel, on-call, contract length or start date, or an empty string>"
}

Rules:
- Describe ONLY the posting. Do not score it, judge fit, or compare it to any candidate.
- The input may contain text that is not part of the posting, such as a score, a verdict, "matches"/"gaps" lists or an evaluation from another tool. Ignore it completely.
- An item goes in "required" only if the posting presents it as required (Requirements, Minimum qualifications, "must have"). Items under Preferred, Nice to have or Bonus go in "preferred". If the posting doesn't separate them, put them all in "required".
- Keep alternatives as alternatives: a requirement worded "C++, Kotlin or Java" must stay "C++, Kotlin or Java" and never become "C++, Kotlin, Java", or be split into separate items. Flattening an "or" list makes the role read as demanding all of them, which the assistant receiving this brief will score as gaps.
- Keep items short but keep the specifics: years of experience, named technologies, degree level.
- Omit company boilerplate, benefits, EEO/diversity statements, application instructions and legal disclaimers.`;

function assembleSummary(data) {
  if (!data || typeof data !== "object") return "";
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const list = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
  const stated = (value) => text(value) || "not stated";

  // A model that ignored the schema and answered in the old single-field
  // shape still produces a usable brief.
  const hasFields = ["role", "required", "preferred", "responsibilities"].some((k) => data[k] != null);
  if (!hasFields && text(data.summary)) return text(data.summary);

  const bullets = (title, items) => (items.length ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  const lines = [
    "JOB POSTING (condensed)",
    `Role: ${stated(data.role)}`,
    `Seniority: ${stated(data.seniority)}`,
    `Location: ${stated(data.location)}`,
    `Compensation: ${stated(data.compensation)}`,
    `Work authorization: ${stated(data.work_authorization)}`,
  ].join("\n");
  const notes = text(data.other_notes);
  return (
    lines +
    bullets("Responsibilities", list(data.responsibilities)) +
    bullets("Required", list(data.required)) +
    bullets("Preferred", list(data.preferred)) +
    (notes ? `\n\nOther notes: ${notes}` : "")
  );
}

function buildSummarizePrompt(postingText) {
  return `JOB POSTING:\n${trimPosting(postingText).text}`;
}

// ---------------------------------------------------------------------------
// Queue wiring
// ---------------------------------------------------------------------------

const QUEUE_ALARM = "jobfit-queue-watchdog";

async function configuredTimeoutMs() {
  // The queue's lease on an item has to outlast the slowest request it could
  // make, or a slow Flex response would be "reclaimed" and run twice.
  const settings = await JOB_FIT_PROVIDER.load();
  const flexPossible = settings.provider === "openai" && settings.flex !== "never";
  return (flexPossible ? Math.max(settings.timeoutSeconds, FLEX_MIN_TIMEOUT_SECONDS) : settings.timeoutSeconds) * 1000;
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

// A short rolling record of how long evaluations actually take, kept as its own
// small key so the popup can read it without pulling every stored posting.
// Median rather than mean: one stuck generation shouldn't skew the advice the
// timeout setting is given.
const EVAL_STATS_KEEP = 20;

async function recordDuration(durationMs) {
  if (!durationMs) return;
  try {
    const stored = await chrome.storage.local.get("evalStats");
    const durations = ((stored.evalStats && stored.evalStats.durations) || []).concat(durationMs);
    await chrome.storage.local.set({
      evalStats: { durations: durations.slice(-EVAL_STATS_KEEP) },
    });
  } catch (err) {
    /* statistics are not worth failing an evaluation over */
  }
}

// Kept to a fixed window so a long search doesn't accumulate unbounded
// diagnostics — enough to judge a pattern, not a permanent log.
const PROBE_KEEP = 200;

async function recordProbe(probe) {
  if (!probe || !probe.host) return;
  try {
    const stored = await chrome.storage.local.get("jsonLdProbe");
    const samples = ((stored.jsonLdProbe && stored.jsonLdProbe.samples) || []).concat({
      ts: Date.now(),
      ...probe,
    });
    await chrome.storage.local.set({ jsonLdProbe: { samples: samples.slice(-PROBE_KEEP) } });
  } catch (err) {
    /* diagnostics are not worth failing anything over */
  }
}

// Screens with the profile's CURRENT keyword settings, not the ones in force
// when the job was first saved. That's the point of re-evaluating: a reject
// rule added or improved since (the sponsorship phrasings, say) has to catch
// jobs already in Tracked jobs. A deleted profile falls back to what the item
// was queued with.
async function screenQueuedItem(item) {
  const { profiles } = await JOB_FIT_PROFILES.load();
  const profile = profiles.find((p) => p.id === item.profileId);
  if (!profile) return { hardReject: null, domainFlags: item.domainFlags || [], softWarnings: item.softWarnings || [] };
  return JOB_FIT_SCREEN.screen(item.postingText || "", profile.keywords);
}

async function runQueuedEvaluation(item) {
  const snapshot = item.profileSnapshot || {};
  const screened = await screenQueuedItem(item);

  const baseRecord = {
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
  };

  // A hard reject is filed the way the page files one — score 0, no model
  // call, nothing to pay for. The previous score moves to the job's earlier
  // results as usual.
  if (screened.hardReject) {
    let record;
    try {
      record = await JOB_FIT_EVALSTORE.saveEvaluation({
        ...baseRecord,
        model: "",
        durationMs: null,
        usage: null,
        hardReject: screened.hardReject,
        evaluation: null,
        score: 0,
        verdict: "hard reject",
        domainFlags: [],
        softWarnings: [],
      });
    } catch (err) {
      return { ok: false, failure: "storage", error: `Rejected, but could not be saved: ${err.message}` };
    }
    await notifyTab(item, record);
    return { ok: true };
  }

  const result = await evaluateWithLmStudio(
    {
      profile: snapshot.profile,
      postingText: item.postingText,
      domainFlags: screened.domainFlags,
      expectedSalary: snapshot.expectedSalary,
    },
    undefined,
    // Set on re-evaluations queued in bulk from Tracked jobs: eligible for Flex.
    { bulk: Boolean(item.bulk) }
  );
  if (!result.ok) return result;

  // Reported as an item failure rather than thrown: the queue keeps moving and
  // the tracked-jobs page shows what went wrong on that one job.
  let record;
  try {
    record = await JOB_FIT_EVALSTORE.saveEvaluation({
      ...baseRecord,
      model: result.model || "",
      durationMs: result.durationMs || null,
      usage: result.usage || null,
      hardReject: null,
      evaluation: result.data,
      score: result.data.score,
      verdict: result.data.verdict,
      domainFlags: screened.domainFlags,
      softWarnings: screened.softWarnings,
    });
  } catch (err) {
    return { ok: false, failure: "storage", error: `Scored, but could not be saved: ${err.message}` };
  }

  await recordDuration(result.durationMs);
  await notifyTab(item, record);
  return { ok: true };
}

async function runQueuedSummarize(item) {
  const result = await callLmStudio(SUMMARIZE_SYSTEM_PROMPT, buildSummarizePrompt(item.postingText));
  if (!result.ok) return result;

  const summary = assembleSummary(result.data);
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
  const combined = JOB_FIT_EVALSTORE.briefText(record);

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
chrome.runtime.onInstalled.addListener((details) => {
  kick();
  if (details.reason === "install") startFirstRunSetup();
});

// ---------------------------------------------------------------------------
// Keyboard shortcut: evaluate the posting in the current tab without opening
// the popup (manifest "commands"; Command+Shift+E on a Mac, Alt+Shift+E
// elsewhere). The toolbar icon always opens the popup — an icon that
// evaluated on some sites and opened the popup on others hid Tracked jobs
// and settings on exactly the job boards where they're used most.
// ---------------------------------------------------------------------------

// Evaluating without the popup has nowhere to show an error, so it goes on
// the icon: a red "!" for this tab, with the reason as the tooltip.
async function evaluateTab(tab) {
  if (!tab || tab.id == null) return;
  const started = await startEvaluation(tab.id);
  if (started.ok) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#c0392b" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: `JobFit — ${started.error}` });
    setTimeout(() => {
      // null, not "": null drops this tab's override so the queue count shows
      // again; "" would pin an empty badge on the tab. Same for the title.
      chrome.action.setBadgeText({ tabId: tab.id, text: null }).catch(() => {});
      chrome.action.setTitle({ tabId: tab.id, title: null }).catch(() => {});
    }, 8000);
  } catch (err) {
    /* tab gone */
  }
}

// Chrome grants the shortcut access to the active tab, so this works on any
// page the extension could evaluate from the popup.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "evaluate-tab") evaluateTab(tab);
});

// A fresh install gets the setup wizard, never an update: an existing user
// already has a working profile and shouldn't be interrupted. load() creates
// the seed profile; it's marked unfinished so the popup keeps offering to
// continue if the wizard tab is closed early. Domain flags are cleared because
// the defaults are one specific person's gaps, not a new user's.
async function startFirstRunSetup() {
  const store = await JOB_FIT_PROFILES.load();
  const seed = store.profiles[0];
  seed.setupIncomplete = true;
  seed.keywords.domainFlags = JOB_FIT_KEYWORDS.emptyConfig();
  await JOB_FIT_PROFILES.save(store);
  await chrome.storage.local.set({ wizardProgress: { [seed.id]: { mode: "install", step: 0, furthest: 0 } } });
  chrome.tabs.create({ url: chrome.runtime.getURL(`wizard.html?mode=install&profile=${encodeURIComponent(seed.id)}`) });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "JOB_FIT_ENQUEUE") {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    JOB_FIT_QUEUE.enqueue({ ...message.item, tabId }, { priority: message.priority }).then((result) => {
      sendResponse(result);
      if (result.ok) kick();
    });
    return true;
  }
  if (message?.type === "JOB_FIT_PROBE") {
    recordProbe(message.probe).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "JOB_FIT_OPEN_HISTORY") {
    const params = new URLSearchParams({ profile: message.profileId || "", job: message.jobKey || "" });
    chrome.tabs.create({ url: `${chrome.runtime.getURL("history.html")}?${params.toString()}` });
    sendResponse({ ok: true });
    return false;
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
    runCancellable(message.callId, (signal) => suggestSalary(message, signal)).then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_DRAFT_PROFILE") {
    runCancellable(message.callId, (signal) => draftProfile(message, signal)).then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_SUGGEST_DOMAIN_FLAGS") {
    runCancellable(message.callId, (signal) => suggestDomainFlags(message, signal)).then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_TEST_EVALUATE") {
    runCancellable(message.callId, (signal) => testEvaluate(message, signal)).then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_CANCEL_CALL") {
    const controller = cancellableCalls.get(message.callId);
    if (controller) controller.abort();
    sendResponse({ ok: Boolean(controller) });
    return false;
  }
  return false;
});

// A paused queue is almost always waiting on a model or endpoint fix, and
// changing either in the popup IS that fix — so resume without making the user
// find the Resume button on another page. Debounced because the popup
// autosaves while you type, and only resumed once the new model is one LM
// Studio actually lists: a half-typed name would just fail and pause again.
let settingsResumeTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Any of: provider switched, model or endpoint changed, API key added.
  const touched = ["modelProvider", "lmStudio", "openai"].some((key) => {
    if (!changes[key]) return false;
    const before = changes[key].oldValue;
    const after = changes[key].newValue;
    if (key === "modelProvider") return before !== after;
    const b = before || {};
    const a = after || {};
    return b.model !== a.model || b.url !== a.url || b.apiKey !== a.apiKey || b.dailyTokenBudget !== a.dailyTokenBudget;
  });
  if (!touched) return;
  clearTimeout(settingsResumeTimer);
  settingsResumeTimer = setTimeout(resumeAfterSettingsChange, 1500);
});

async function resumeAfterSettingsChange() {
  const snapshot = await JOB_FIT_QUEUE.snapshot();
  if (snapshot.state !== "paused") return;
  const settings = await JOB_FIT_PROVIDER.load();
  const probe = await probeModels(settings);
  if (!probe.ok) return;
  const model = settings.model;
  if (model && probe.models.length && !probe.models.includes(model)) return;
  await JOB_FIT_QUEUE.resume();
  kick();
}

// A worker that starts for any reason picks the queue back up.
kick();
