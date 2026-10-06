// Pulls in JOB_FIT_DEFAULTS so the fallbacks below are the same values the
// popup shows. They used to be hand-mirrored constants here, which drifted
// once already: reasoning_effort and enable_thinking were added to the popup
// but not to this file, so neither was ever sent for anyone who hadn't
// re-saved their settings.
importScripts(
  "locales/en.js",
  "locales/es.js",
  "locales/fr.js",
  "locales/pt.js",
  "i18n.js",
  "geo.js",
  "defaults.js",
  "prompts.js",
  "vault.js",
  "provider.js",
  "keywords.js",
  "screening.js",
  "profiles.js",
  "evalstore.js",
  "queue.js",
  "lmstudio-ui.js",
  "inject.js",
  "boards.js",
  "ui-shared.js"
);

// Messages this worker writes (errors, score-cap reasons, briefs) are in the
// user's language, which is a setting read from storage — so everything that
// produces text waits for it, and follows it when it changes.
const i18nReady = JOB_FIT_I18N.load();
JOB_FIT_I18N.watch(setUninstallPage);

// Where Chrome sends someone who uninstalls: one question on Tino's site
// (docs/goodbye.html), in their language. Only the language and the version
// go in the address — nothing about them, their profile or their jobs.
function setUninstallPage() {
  try {
    const url = new URL("goodbye.html", JOB_FIT_DEFAULTS.siteUrl);
    url.searchParams.set("lang", JOB_FIT_I18N.lang);
    url.searchParams.set("v", chrome.runtime.getManifest().version);
    Promise.resolve(chrome.runtime.setUninstallURL(url.toString())).catch(() => {});
  } catch (err) {
    /* not available here */
  }
}
i18nReady.then(setUninstallPage);

// The instructions are in prompts.js, shared with Tino Cloud's server.
function systemPrompt() {
  return JOB_FIT_PROMPTS.evaluate(JOB_FIT_I18N.lang);
}

// For the model's prompt, in English whatever the UI language.
function countryNameEn(code) {
  return JOB_FIT_I18N.countryName(code, "en");
}

const AUTH_TEXT = {
  citizen: "citizen or permanent resident",
  permit: "already authorized to work (work permit or visa, no sponsorship needed)",
  sponsor: "would need visa sponsorship",
};
const ARRANGEMENT_TEXT = { remote: "remote", hybrid: "hybrid", onsite: "on-site" };

function placeEn({ city, country, region } = {}) {
  return [city, country ? JOB_FIT_GEO.regionName(country, region) : region, country ? countryNameEn(country) : null]
    .filter(Boolean)
    .join(", ");
}

// The profile's jobSearch answers as plain lines for the model. The home
// city and region are only included when the user allowed it
// (shareLocation); the rest describes where they can work, not who they are.
function describeSituation(jobSearch) {
  if (!jobSearch) return "";
  const lines = [];
  const home = jobSearch.home || {};
  if (home.country) {
    lines.push(
      jobSearch.shareLocation
        ? `Lives in: ${placeEn(home)}${home.timeZone ? ` (time zone ${home.timeZone})` : ""}`
        : `Lives in: ${countryNameEn(home.country)}`
    );
  }
  const targets = jobSearch.targetCountries || [];
  if (targets.length) lines.push(`Applying in: ${targets.map(countryNameEn).join(", ")}`);
  const auth = Object.entries(jobSearch.workAuth || {}).filter(([, v]) => AUTH_TEXT[v]);
  if (auth.length) lines.push(`Work authorization: ${auth.map(([c, v]) => `${countryNameEn(c)} — ${AUTH_TEXT[v]}`).join("; ")}`);
  const arrangements = (jobSearch.arrangements || []).map((a) => ARRANGEMENT_TEXT[a]).filter(Boolean);
  if (arrangements.length && arrangements.length < 3) lines.push(`Accepts: ${arrangements.join(", ")} work`);
  if (jobSearch.relocate) lines.push(`Would relocate at own cost: ${jobSearch.relocate === "yes" ? "yes" : "no"}`);
  const languages = (jobSearch.languages || []).map((l) => JOB_FIT_I18N.languageName(l, "en"));
  if (languages.length) lines.push(`Works in: ${languages.join(", ")}`);
  return lines.join("\n");
}

function describePlace(place) {
  if (!place || (!place.country && !place.arrangement)) return "";
  const where = place.country ? placeEn(place) : "country unclear";
  return `${where}${place.arrangement ? ` (${ARRANGEMENT_TEXT[place.arrangement]})` : ""}`;
}

// Stated in the user's own terms ("MXN 45000–60000 per month") with the
// annual equivalent, since the schema asks the model for annual figures.
function formatExpectedSalary(expectedSalary) {
  const entries = Object.entries(expectedSalary || {}).filter(([, r]) => r && (r.min != null || r.max != null));
  if (!entries.length) return "not specified";
  return entries
    .map(([cur, r]) => {
      const period = r.period || "year";
      const range = r.min != null && r.max != null ? `${r.min}–${r.max}` : r.min != null ? `${r.min}+` : `up to ${r.max}`;
      if (period === "year") return `${cur} ${range} per year`;
      const lo = JOB_FIT_GEO.toAnnual(r.min, period);
      const hi = JOB_FIT_GEO.toAnnual(r.max, period);
      const annual = lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `${lo}+` : `up to ${hi}`;
      return `${cur} ${range} per ${period} (about ${annual} per year)`;
    })
    .join(", ");
}

// A currency's expectation as an annual range, for the arithmetic below.
function annualExpectation(expectedSalary, currency) {
  const r = expectedSalary && currency && expectedSalary[currency];
  if (!r || (r.min == null && r.max == null)) return null;
  const period = r.period || "year";
  return { min: JOB_FIT_GEO.toAnnual(r.min, period), max: JOB_FIT_GEO.toAnnual(r.max, period) };
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

// The posting, marked off as what it is: text from a web page, which may be
// written to steer the model ("score this 100"). The system prompts say
// nothing between the markers is an instruction; a marker inside the posting
// itself is removed, so it can't close the block early and continue as if it
// were the extension talking.
function postingBlock(text) {
  const clean = String(text || "").replace(/<<<\s*POSTING|POSTING\s*>>>/gi, "[removed]");
  return `JOB POSTING (untrusted text from a web page, between the markers):\n<<<POSTING\n${clean}\nPOSTING>>>`;
}

function buildUserPrompt(profile, postingText, expectedSalary, domainFlags, { jobSearch, place, learningFlags, coreWorkOnly } = {}) {
  const { text: trimmed, truncated } = trimPosting(postingText);
  const domainFlagsLine =
    (domainFlags && domainFlags.length
      ? `\n\nDETECTED DOMAIN-FLAG TERMS IN POSTING (keyword scan, cross-check each against the profile per the scoring guidance): ${domainFlags.join(", ")}`
      : "") +
    (learningFlags && learningFlags.length
      ? `\n\nDETECTED LEARNING TERMS IN POSTING (the candidate is actively learning these; a minor gap at most, never a cap): ${learningFlags.join(", ")}`
      : "") +
    (coreWorkOnly && coreWorkOnly.length
      ? `\n\nREQUIREMENTS AND CORE WORK DIVERGE: the responsibilities describe ${coreWorkOnly.join(", ")}, which the requirements list doesn't name. Judge fit on the work described, per the scoring guidance.`
      : "");
  // Everything that's the same on every call comes first — the system prompt,
  // then this profile and its salary expectations — and everything that
  // changes per posting comes last. Providers cache a repeated prefix (OpenAI
  // bills it at a discount; LM Studio reuses its KV cache), and the domain-flag
  // line used to sit between the profile and the posting, cutting that prefix
  // short on every posting that hit a different flag.
  // The situation is per profile, so it sits in the cached prefix; the
  // posting's parsed location changes per posting and goes at the end.
  const situation = describeSituation(jobSearch);
  const situationBlock = situation ? `\n\nCANDIDATE SITUATION:\n${situation}` : "";
  const where = describePlace(place);
  const placeLine = where ? `\n\nPOSTING LOCATION (as read by a keyword scan; the posting itself is authoritative): ${where}` : "";
  const prompt = `CANDIDATE PROFILE:\n${profile}\n\nCANDIDATE EXPECTED SALARY: ${formatExpectedSalary(expectedSalary)}${situationBlock}\n\n${postingBlock(trimmed)}${domainFlagsLine}${placeLine}`;
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
    return { ok: false, failure: "shape", error: t("bg.shapeOpenAi") };
  }
  const parts = data.output
    .filter((item) => item && item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  const refusal = parts.find((p) => p.type === "refusal");
  if (refusal) {
    return { ok: false, failure: "refusal", error: t("bg.refusal", { reason: refusal.refusal || t("bg.noReason") }) };
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
      error: t("bg.lengthOpenAi"),
    };
  }
  return {
    ok: false,
    failure: "empty",
    error: t("bg.emptyOpenAi", {
      status: data.status && data.status !== "completed" ? ` (${data.status}${reason ? `, ${reason}` : ""})` : "",
    }),
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

// Counted since the popup's "Reset" if one was pressed today (see
// JOB_FIT_PROVIDER.budgetTokensUsed).
async function openAiTokensToday() {
  const stored = await chrome.storage.local.get(["usageByDay", "openaiBudgetReset"]);
  return JOB_FIT_PROVIDER.budgetTokensUsed(stored.usageByDay, stored.openaiBudgetReset);
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
  await i18nReady;
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
      return { ok: false, failure: "config", error: t("bg.noApiKey") };
    }
    if (!model) {
      return { ok: false, failure: "config", error: t("bg.noModel") };
    }
    // Checked before sending, so the request that would cross the line is
    // never made. "budget" pauses the queue; raising the budget resumes it.
    if (settings.dailyTokenBudget) {
      const used = await openAiTokensToday();
      if (used >= settings.dailyTokenBudget) {
        return {
          ok: false,
          failure: "budget",
          error: t("bg.budgetUsed", {
            used: JOB_FIT_I18N.formatNumber(used),
            budget: JOB_FIT_I18N.formatNumber(settings.dailyTokenBudget),
          }),
        };
      }
    }
  }

  // The request carries the CV, the salary expectations and the posting: an
  // endpoint off this machine gets them only once it's been allowed, and
  // never over plain http to the internet (provider.js endpointPolicy).
  if (provider === "lmstudio") {
    const policy = JOB_FIT_PROVIDER.endpointPolicy(url);
    if (policy.kind === "invalid") return { ok: false, failure: "config", error: t("bg.endpointInvalid") };
    if (policy.kind === "insecure") return { ok: false, failure: "config", error: t("bg.endpointInsecure", { origin: policy.origin }) };
    if (policy.kind === "approval" && !(await JOB_FIT_VAULT.isApprovedOrigin(policy.origin))) {
      return { ok: false, failure: "config", error: t("bg.endpointNotApproved", { origin: policy.origin }) };
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
      if (sent.error === "cancelled") return { ok: false, failure: "cancelled", error: t("bg.cancelled") };
      if (sent.error === "timeout") {
        return {
          ok: false,
          failure: "timeout",
          error:
            provider === "openai"
              ? t(tier === "flex" ? "bg.openaiTimeoutFlex" : "bg.openaiTimeout", { seconds: attemptTimeoutSeconds })
              : t("bg.lmTimeout", { seconds: timeoutSeconds }),
        };
      }
      return {
        ok: false,
        failure: "unreachable",
        error:
          provider === "openai"
            ? t("bg.openaiUnreachable", { detail: sent.message })
            : t("bg.lmUnreachable", { url, detail: sent.message }),
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
    const which = model ? t("bg.forModel", { model }) : "";
    // OpenAI wraps its reason in {"error":{"message"}}; show just that.
    const detail = parseOpenAiError(body).message || body.slice(0, 300);
    return { ok: false, failure: "http", error: t("bg.http", { label, status: resp.status, which, detail }) };
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
      return { ok: false, failure: "parse", error: t("bg.parseOpenAi"), raw: read.text };
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
    return { ok: false, failure: "shape", error: t("bg.shapeLm"), raw: JSON.stringify(data) };
  }

  if (raw.trim() === "") {
    const finishReason = data?.choices?.[0]?.finish_reason;
    return {
      ok: false,
      failure: finishReason === "length" ? "length" : "empty",
      error: finishReason === "length" ? t("bg.lengthLm") : t("bg.emptyLm"),
    };
  }

  try {
    // The model is reported back so it can be stored on the record: scores from
    // different models are not comparable, and the history page sorts by score.
    return { ok: true, data: extractJson(raw), model: model || "", usage, durationMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, failure: "parse", error: t("bg.parseModel"), raw };
  }
}

// --- reading the model's salary numbers ---------------------------------------
//
// The schema asks for plain integers, but models return "140,000", "140k" or
// "$140K" often enough, and a string compared with a number is always false:
// a posting capped at $140K came out "within" a $160K floor that way.
function toAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = value.replace(/[\s,]/g, "").match(/(\d+(?:\.\d+)?)([kK])?/);
  return m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) : null;
}

// Words that say how often an amount is paid.
const MONTHLY_WORDS_RE =
  /\b(per|a|\/)\s*(month|mo)\b|\bmonthly\b|\bmensual(es)?\b|\bal mes\b|\bpor mes\b|\/\s*mes\b|\bmensuel(le)?s?\b|\bpar mois\b|\bmensa(l|is)\b|\bpor m[êe]s\b/i;
const YEARLY_WORDS_RE =
  /\b(per|a|\/)\s*(year|yr|annum)\b|\bannual(ly)?\b|\banual(es)?\b|\bal a[ñn]o\b|\bpor a[ñn]o\b|\/\s*a[ñn]o\b|\bpar an(n[ée]e)?\b|\bannuel(le)?s?\b|\bpor ano\b/i;

// The amounts in a stated range ("84,000 to 156,000", "$120K–$140K"),
// annualized when the text says per month or per hour. Used only when the
// model put the range in posting_stated but left the numeric fields empty.
function amountsIn(text) {
  const source = String(text || "");
  const amounts = [];
  for (const m of source.matchAll(/(\d{1,3}(?:[,.\s]\d{3})+|\d+(?:\.\d+)?)\s*([kK])?\b/g)) {
    const n = Number(m[1].replace(/[,.\s](?=\d{3}\b)/g, "")) * (m[2] ? 1000 : 1);
    if (n >= 10) amounts.push(n);
  }
  if (!amounts.length) return { amounts: [], annualized: false };
  const factor = MONTHLY_WORDS_RE.test(source)
    ? 12
    : /\b(per|an|\/)\s*(hour|hr)\b|\bhourly\b|por hora|de l'heure/i.test(source)
      ? 2080
      : 1;
  return { amounts: amounts.map((n) => Math.round(n * factor)), annualized: factor !== 1 };
}

// The posting's text around where it shows an amount, with thousands
// separators taken out so 45,000 is found as 45000. Null when the amount
// isn't in the posting as written — the model already converted it.
function textAround(postingText, amount) {
  if (amount == null) return null;
  const text = String(postingText || "").replace(/(\d)[,.\s](?=\d{3}\b)/g, "$1");
  const index = text.indexOf(String(amount));
  return index === -1 ? null : text.slice(Math.max(0, index - 120), index + 120);
}

// Monthly pay reported in the annual fields. Mexican postings quote pay per
// month ("$45,000 – $60,000 mensuales"), and a model that copies those
// numbers as they are makes every one look far below the floor. Two ways to
// tell: the posting says monthly next to numbers it shows exactly as the
// model reported them (so they weren't converted), or the country quotes pay
// per month, no period is given, and the figure is far too low to be a year's.
function looksMonthly({ min, max, currency, salary, place, postingText, expectedSalary }) {
  const top = max ?? min;
  if (top == null) return false;
  const stated = String(salary.posting_stated || "");
  const around = textAround(postingText, top) ?? textAround(postingText, min);
  if (YEARLY_WORDS_RE.test(stated) || (around && YEARLY_WORDS_RE.test(around))) return false;
  if (around && (MONTHLY_WORDS_RE.test(stated) || MONTHLY_WORDS_RE.test(around))) return true;
  const country = place && place.country;
  if (!country || JOB_FIT_GEO.periodOf(country) !== "month" || JOB_FIT_GEO.currencyOf(country) !== currency) return false;
  const expected = annualExpectation(expectedSalary, currency);
  return Boolean(expected && expected.min != null && top * 4 < expected.min);
}

// A currency the posting shows next to its numbers, or none.
const CURRENCY_SIGNS = [
  [/\bC(?:A)?\$|\bCAD\b/i, "CAD"],
  [/\bMX\$|\bMXN\b|\bpesos\b/i, "MXN"],
  [/\bUS\$|\bUSD\b/i, "USD"],
  [/R\$|\bBRL\b/i, "BRL"],
  [/€|\bEUR\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
];

function currencyShownIn(text) {
  const found = CURRENCY_SIGNS.find(([re]) => re.test(String(text || "")));
  return found ? found[1] : null;
}

// "Most offers fall between the minimum and the midpoint of the range": the
// realistic ceiling is the midpoint, not the top of the band.
const MIDPOINT_RE =
  /\b(most|majority|typically|usually|generally|expected to)\b[^.\n]{0,100}\b(between|from)\b[^.\n]{0,40}\b(minimum|min|low(er)? end|bottom|start(ing point)?)\b[^.\n]{0,40}\b(mid-?point|middle|mid)\b|\b(lower|bottom) half of (the|this) (range|band)\b/i;

// Local models are unreliable at comparing two numeric ranges correctly
// (observed: claiming "within" while also saying the posting's ceiling is
// below the candidate's floor). Range comparison is pure arithmetic, so do
// it ourselves instead of trusting the model's stated verdict. The numbers
// it uses are written back onto the result, so the seniority check below
// reads the same ones.
function compareSalary(salary, expectedSalary, { place = null, postingText = "" } = {}) {
  if (!salary) return salary;
  const out = { ...salary };
  const notes = [];

  let min = toAmount(salary.posting_stated_min);
  let max = toAmount(salary.posting_stated_max);
  let annualized = false;
  if (min == null && max == null && salary.posting_stated && !/not stated/i.test(salary.posting_stated)) {
    const found = amountsIn(salary.posting_stated);
    if (found.amounts.length) {
      min = Math.min(...found.amounts);
      max = Math.max(...found.amounts);
      annualized = found.annualized;
    }
  }

  let currency = null;
  if (min != null || max != null) {
    // The model's code first, then a sign in the stated text, then the job's
    // country: "84,000 to 156,000" in Ottawa is Canadian dollars.
    currency = salary.posting_stated_currency || currencyShownIn(salary.posting_stated);
    if (!currency && place && place.country && JOB_FIT_GEO.currencyOf(place.country)) {
      currency = JOB_FIT_GEO.currencyOf(place.country);
      out.currency_inferred = true;
      notes.push(t("bg.currencyInferred", { currency, country: JOB_FIT_I18N.countryName(place.country) }));
    }
    if (!annualized && looksMonthly({ min, max, currency, salary, place, postingText, expectedSalary })) {
      min = min != null ? min * 12 : null;
      max = max != null ? max * 12 : null;
      out.monthly_annualized = true;
      notes.push(t("bg.monthlyAnnualized"));
    }
    out.posting_stated_min = min;
    out.posting_stated_max = max;
    out.posting_stated_currency = currency;

    if (min != null && max != null && max > min && MIDPOINT_RE.test(postingText)) {
      max = Math.round((min + max) / 2);
      out.posting_realistic_max = max;
      notes.push(t("bg.midpointNote", { max: `${JOB_FIT_I18N.formatNumber(max)} ${currency || ""}`.trim() }));
    }
  } else {
    min = toAmount(salary.estimated_market_min);
    max = toAmount(salary.estimated_market_max);
    currency = salary.estimated_market_currency;
    if (min != null || max != null) notes.push(t("bg.salaryBasisNote"));
  }

  const note = [salary.note, ...notes].filter(Boolean).join(" ").trim();
  if (min == null && max == null) return { ...out, note, vs_candidate_expectation: "unknown" };

  // Annual on both sides: the schema asks the model for annual figures, and a
  // monthly expectation is converted here.
  const expectedRange = annualExpectation(expectedSalary, currency);
  if (!expectedRange || (expectedRange.min == null && expectedRange.max == null)) {
    return { ...out, note, vs_candidate_expectation: "unknown" };
  }

  let verdict;
  if (max != null && expectedRange.min != null && max < expectedRange.min) {
    verdict = "below";
  } else if (min != null && expectedRange.max != null && min > expectedRange.max) {
    verdict = "above";
  } else {
    verdict = "within";
  }
  return { ...out, note, vs_candidate_expectation: verdict };
}

// --- level: pay and experience ----------------------------------------------------
//
// Two signals that a role is below the candidate's level, each computed in
// code rather than left to the model: the posting's pay tops out below the
// candidate's floor, and it asks for far less experience. Either one alone is
// only a note — a well-paid role can ask for few years, and a modest band can
// sit on a senior title — and only both together take points off (below).

// The pay signal, only ever off a salary the POSTING stated (or its realistic
// top, when it says most offers sit between the minimum and the midpoint).
// This once fell back to the model's own market estimate, which made the check
// circular: its hunch about the role set the estimate that then flagged it.
function paySignal(salary, expectedSalary) {
  if (!salary) return null;
  const max = toAmount(salary.posting_realistic_max) ?? toAmount(salary.posting_stated_max);
  const currency = salary.posting_stated_currency;
  if (max == null || !currency) return null;
  const expectedRange = annualExpectation(expectedSalary, currency);
  if (!expectedRange || expectedRange.min == null || max >= expectedRange.min) return null;
  return t("bg.payBelowFloor", {
    max: `${JOB_FIT_I18N.formatNumber(max)} ${currency}`,
    floor: `${JOB_FIT_I18N.formatNumber(expectedRange.min)} ${currency}`,
  });
}

// --- experience level -----------------------------------------------------------
//
// A "2+ years, academic experience acceptable" role scored 100 for someone
// with eight: every skill matched, and nothing said the level was wrong.
// Years are arithmetic, so it's checked here. The largest number of years the
// posting asks for is used, so "5+ years of C++, 2+ of Python" reads as 5.

const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:(?:-|–|to|a|à)\s*\d{1,2}\s*)?(?:years?|yrs?|años|ans|anos)\b/gi;
const EXPERIENCE_RE = /experien|exp\.|trayectoria|exp[ée]rience|experi[êe]ncia/i;
const ENTRY_LEVEL_RE =
  /\b(entry[- ]level|new grad(uate)?s?|recent (college )?graduates?|academic experience (is |will be )?(acceptable|accepted|considered|counts)|reci[ée]n egresad[oa]s?|nivel de entrada|d[ée]butant|jeune dipl[ôo]m[ée])\b/i;

function candidateYears(profileText) {
  const m = String(profileText || "").match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?|años|ans|anos)\b/i);
  return m ? Number(m[1]) : null;
}

function postingYears(postingText) {
  const text = String(postingText || "");
  const years = [];
  for (const m of text.matchAll(YEARS_RE)) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    if (EXPERIENCE_RE.test(around)) years.push(Number(m[1]));
  }
  return years.length ? Math.max(...years) : null;
}

function experienceSignal(postingText, profileText) {
  const yours = candidateYears(profileText);
  if (yours == null || yours < 4) return null;
  const asked = postingYears(postingText);
  if (asked != null && asked <= Math.floor(yours / 2)) return t("bg.belowLevel", { years: asked, yours });
  if (ENTRY_LEVEL_RE.test(postingText) && (asked == null || asked < yours - 2)) return t("bg.belowLevelEntry", { yours });
  return null;
}

// --- gaps that are really the job's location ----------------------------------
//
// Location is screened by the keyword rules (must be local, no relocation),
// and the candidate is relocating: "Tijuana-to-Mountain-View relocation" or
// "San Mateo, CA" as a required gap only dragged the score down twice.
const LOCATION_GAP_RE =
  /\b(relocat\w*|commut\w*|based in|located in|local to|live (in|near|within)|resid\w+ (in|near|within)|on-?site in|in[- ]office in)\b|^[A-Z][\w .'-]+,\s*[A-Z]{2}$/i;

function dropLocationGaps(data, location) {
  const city = String(location || "").split(/[,(|·•]/)[0].trim();
  const cityRe = city.length >= 3 ? new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  const isLocation = (gap) => LOCATION_GAP_RE.test(String(gap).trim()) || Boolean(cityRe && cityRe.test(String(gap)));
  const keep = (list) => (Array.isArray(list) ? list.filter((g) => !isLocation(g)) : list);
  return { ...data, gaps: keep(data.gaps), required_gaps: keep(data.required_gaps) };
}

// --- claimed matches the profile doesn't back up ----------------------------------
//
// A model once credited a C++/imaging engineer with "graphics expertise". A
// match is kept when at least one of its specific words (not "experience",
// "strong", "software"…) appears in the profile, by stem, so "image
// processing" is backed by "imaging". One that has none is moved aside and
// shown as unverified; the score is left alone, since this is a word check,
// not proof.

const GENERIC_MATCH_WORDS = new Set(
  (
    "a an and or the of in on for to with using via based including plus etc related relevant such as like " +
    "experience experienced expertise expert strong solid deep proven extensive hands-on hands on background " +
    "knowledge skills skill skilled ability abilities familiarity understanding proficiency proficient " +
    "software development developer developing develop engineering engineer engineers years year senior level " +
    "team teams design designing designed work working production professional modern complex large scale " +
    "high quality performance systems system tools technologies technology environment environments industry " +
    "building build built delivering deliver shipping ship code coding programming applications application " +
    "solutions solution projects project practices practice concepts principles"
  ).split(/\s+/)
);

function specificTerms(phrase) {
  return String(phrase || "")
    .split(/[\s,/()·:;]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}.+#]+|[^\p{L}\p{N}+#]+$/gu, ""))
    .filter((w) => w.length >= 2 && !GENERIC_MATCH_WORDS.has(w.toLowerCase()));
}

function stemRegex(term) {
  const escaped = (term.length > 4 ? term.replace(/(ing|ed|es|s)$/i, "") : term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, JOB_FIT_KEYWORDS.isShortToken(term) ? "u" : "iu");
}

function verifyMatches(matches, profileText) {
  const profile = String(profileText || "");
  const verified = [];
  const unverified = [];
  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const terms = specificTerms(match);
    // Nothing specific to check ("strong software engineering"): keep it.
    if (!terms.length || terms.some((term) => stemRegex(term).test(profile))) verified.push(match);
    else unverified.push(match);
  });
  return { verified, unverified };
}

// --- score caps -----------------------------------------------------------------
//
// Backstop for the caps the prompt describes: prompt-only guidance for this
// kind of conditional arithmetic has proven unreliable (see salary comparison
// above), so they're enforced here whether or not the model applied them.
//
// The domain-flag cap is for a flagged skill the job really requires. It used
// to fire on any required gap whose text merely contained the flag as a
// substring, which capped a 90 at 50 for "familiarity with … OpenCV, NumPy,
// SciPy, scikit-image, or PIL" (a low bar, and one of five alternatives), and
// matched "go" inside "Google Test". Now a flag counts only as a whole word,
// and a requirement that's worded as a low bar or offered as one of several
// alternatives costs 10 points instead of the cap.

const LOW_BAR_RE =
  /\b(familiar(ity)? with|exposure to|working knowledge|introductory|basic (knowledge|understanding|familiarity|experience)|some (experience|exposure|familiarity|knowledge)|awareness of|a plus|nice to have|bonus)\b/i;
const ALTERNATIVES_RE = /\bor\b|\band\/or\b|\bsuch as\b|\be\.g\.|\bfor example\b|\bone or more of\b|\bany of\b/i;
// How close an "or" must be to count as listing alternatives to the term,
// rather than being some other "or" in a long sentence.
const ALTERNATIVES_REACH = 60;
const SOFT_GAP_COST = 10;
// A skill the candidate is learning costs less than a real mismatch.
const LEARNING_GAP_COST = 5;
// Low-bar and learning costs together never exceed this.
const MAX_SOFT_COST = 15;
// Both level signals at once.
const BELOW_LEVEL_COST = 20;

function termRegex(term) {
  const source = JOB_FIT_KEYWORDS.phraseToPattern(term);
  return source ? new RegExp(source, JOB_FIT_KEYWORDS.isShortToken(term) ? "" : "i") : null;
}

// The sentences of the posting a term appears in.
function sentencesWith(text, re) {
  return String(text || "")
    .split(/(?<=[.;!?])\s+|\n+/)
    .filter((s) => re.test(s));
}

// A gap phrase the model wrote: short, so anywhere in it counts.
function isSoftGap(text) {
  return LOW_BAR_RE.test(text) || ALTERNATIVES_RE.test(text);
}

// A sentence of the posting: a low bar anywhere in it, or alternatives listed
// right around the term itself.
function isSoftMention(sentence, re) {
  if (LOW_BAR_RE.test(sentence)) return true;
  const m = sentence.match(re);
  if (!m) return false;
  const around = sentence.slice(Math.max(0, m.index - ALTERNATIVES_REACH), m.index + m[0].length + ALTERNATIVES_REACH);
  return ALTERNATIVES_RE.test(around);
}

// For each domain flag that shows up in a required gap: "hard" when the job
// really requires it, "soft" when every mention (the gap itself, or every
// sentence of the posting that names it) is a low bar or one of several
// alternatives.
function classifyFlagGaps(domainFlags, requiredGaps, postingText) {
  const hard = [];
  const soft = [];
  (domainFlags || []).forEach((flag) => {
    const re = termRegex(flag);
    if (!re) return;
    const gaps = (requiredGaps || []).map(String).filter((g) => {
      if (re.test(g)) return true;
      // "Kubernetes" as the gap for a "Kubernetes operators" flag.
      const gapRe = g.split(/\s+/).length <= 3 ? termRegex(g) : null;
      return Boolean(gapRe && gapRe.test(flag));
    });
    if (!gaps.length) return;
    const mentions = sentencesWith(postingText, re);
    const lowBar = gaps.every(isSoftGap) || (mentions.length > 0 && mentions.every((s) => isSoftMention(s, re)));
    (lowBar ? soft : hard).push(flag);
  });
  return { hard, soft };
}

function verdictFor(score) {
  if (typeof score !== "number") return null;
  if (score >= JOB_FIT_UI.GREEN_FROM) return "apply";
  if (score >= JOB_FIT_UI.AMBER_FROM) return "borderline";
  return "skip";
}

// Learning terms that show up in a required gap, by whole word.
function learningGapHits(learningFlags, requiredGaps) {
  return (learningFlags || []).filter((term) => {
    const re = termRegex(term);
    return re && (requiredGaps || []).some((g) => re.test(String(g)));
  });
}

function applyScoreCaps(data, { domainFlags, learningFlags, experienceFlag, payFlag, postingText = "" }) {
  // Held to 0–100 before anything else: a reply of 140 (or -5) is a mistake,
  // or a posting that talked the model into it, and must not sort above
  // every real score.
  let score = typeof data.score === "number" && Number.isFinite(data.score) ? Math.min(100, Math.max(0, Math.round(data.score))) : data.score;
  const capReasons = [];
  const requiredGaps = Array.isArray(data.required_gaps) ? data.required_gaps.map(String) : [];

  if (typeof score === "number") {
    const { hard, soft } = classifyFlagGaps(domainFlags, requiredGaps, postingText);
    const learning = learningGapHits(learningFlags, requiredGaps);
    if (hard.length && score > 50) {
      score = 50;
      capReasons.push(t("bg.capDomain"));
    } else if (!hard.length && (soft.length || learning.length)) {
      let cost = 0;
      if (soft.length) {
        cost += SOFT_GAP_COST;
        capReasons.push(t("bg.capSoftDomain", { terms: soft.join(", "), points: SOFT_GAP_COST }));
      }
      if (learning.length) {
        cost += LEARNING_GAP_COST;
        capReasons.push(t("bg.capLearning", { terms: learning.join(", "), points: LEARNING_GAP_COST }));
      }
      cost = Math.min(cost, MAX_SOFT_COST);
      // Meeting everything except a "familiarity" item or a skill being
      // learned is still an apply: an 84 with one such gap used to drop to
      // 74, borderline. That holds only when every required gap is of that
      // soft kind; one real gap and the deduction stands.
      const learningRes = learning.map(termRegex);
      const softFlagRes = soft.map(termRegex);
      const allSoft = requiredGaps.every(
        (g) => isSoftGap(g) || learningRes.some((re) => re.test(g)) || softFlagRes.some((re) => re.test(g))
      );
      const floor = allSoft && score >= JOB_FIT_UI.GREEN_FROM ? JOB_FIT_UI.GREEN_FROM : 0;
      score = Math.max(floor, score - cost);
    }
  }

  // Below level only when both signals agree; either alone is just a note.
  if (typeof score === "number" && experienceFlag && payFlag) {
    score = Math.max(0, score - BELOW_LEVEL_COST);
    capReasons.push(t("bg.capBelowLevel", { points: BELOW_LEVEL_COST }));
  }

  // raw_score preserves what the model actually said. The caps are heuristics,
  // so seeing only the capped number leaves no way to judge whether the cap was
  // fair.
  //
  // The verdict follows the final score. The model's own verdict drifted from
  // it (a 90 came back "borderline" because sponsorship wasn't mentioned), and
  // the thresholds are the same ones the card and Tracked jobs colour by.
  const verdict = verdictFor(score) || data.verdict;
  return {
    ...data,
    score,
    verdict,
    model_verdict: data.verdict && data.verdict !== verdict ? data.verdict : undefined,
    raw_score: capReasons.length && score !== data.score ? data.score : undefined,
    score_cap_reasons: capReasons.length ? capReasons : undefined,
  };
}

// "Sponsorship not stated" is worth knowing before applying — when the
// candidate needs sponsorship in the posting's country — but it's a warning
// beside the score, not a reason to lower the verdict.
function sponsorshipWarning(data, jobSearch, place) {
  if (!data || data.sponsorship !== "unstated" || !place || !place.country) return null;
  const auth = (jobSearch && jobSearch.workAuth) || {};
  return auth[JOB_FIT_GEO.authCountry(place.country)] === "sponsor" ? t("bg.sponsorshipUnstated") : null;
}

// expectedSalary arrives in the message rather than being read from storage
// here: the caller has already resolved the active profile, and a second
// independent read could land on a different profile if the user switched in
// between, scoring a posting against one profile's keywords and another's
// salary expectations.
async function evaluateWithLmStudio(
  { profile, postingText, domainFlags, learningFlags, coreWorkOnly, expectedSalary, jobSearch, place, location },
  signal,
  { bulk = false } = {}
) {
  await i18nReady;
  const { prompt, truncated } = buildUserPrompt(profile, postingText, expectedSalary, domainFlags, {
    jobSearch,
    place,
    learningFlags,
    coreWorkOnly,
  });
  const result = await callLmStudio(systemPrompt(), prompt, { signal, bulk });

  if (result.ok && result.data) {
    // Surfaced in the result panel: a score produced from a partial posting is worth
    // knowing about, and silently dropping text is what made this a bug.
    result.data.input_truncated = truncated;
    if (result.data.salary) {
      result.data.salary = compareSalary(result.data.salary, expectedSalary, { place, postingText });
    }
    const payFlag = paySignal(result.data.salary, expectedSalary);
    const experienceFlag = experienceSignal(postingText, profile);
    result.data.seniority_flag = payFlag;
    result.data.level_flag = experienceFlag;
    result.data = dropLocationGaps(result.data, location);
    const { verified, unverified } = verifyMatches(result.data.matches, profile);
    result.data.matches = verified;
    result.data.unverified_matches = unverified.length ? unverified : undefined;
    result.data = applyScoreCaps(result.data, { domainFlags, learningFlags, experienceFlag, payFlag, postingText });
    result.data.sponsorship_warning = sponsorshipWarning(result.data, jobSearch, place);
    result.data.core_work_only = coreWorkOnly && coreWorkOnly.length ? coreWorkOnly : undefined;
  }

  return result;
}

function salarySuggestPrompt(markets) {
  return JOB_FIT_PROMPTS.suggestSalary(markets, JOB_FIT_I18N.lang);
}

async function suggestSalary({ profile, markets, jobSearch }, signal) {
  await i18nReady;
  const situation = describeSituation(jobSearch);
  return callLmStudio(
    salarySuggestPrompt(markets),
    `CANDIDATE PROFILE:\n${profile}${situation ? `\n\nCANDIDATE SITUATION:\n${situation}` : ""}`,
    { signal }
  );
}

function profileDraftPrompt() {
  return JOB_FIT_PROMPTS.draftProfile(JOB_FIT_I18N.lang);
}

function assembleDraftProfile(draft) {
  const clean = (value) => (typeof value === "string" ? value.trim() : "");
  const lines = [clean(draft.headline)];
  // Labels in the user's language; the wizard's section meter and the
  // evaluator recognise them in every language JobFit has.
  [
    ["core", draft.core],
    ["specialisms", draft.specialisms],
    ["tooling", draft.tooling],
    ["leadership", draft.leadership],
    ["gaps", draft.gaps],
    ["workAuth", draft.work_authorisation],
    ["target", draft.target],
  ].forEach(([id, value]) => {
    // Gaps is kept even when empty, so the gap in the profile is visible in
    // the editor rather than silently missing.
    if (clean(value) || id === "gaps") lines.push(`${t(`profileLabel.${id}`)}: ${clean(value)}`);
  });
  return lines.filter(Boolean).join("\n");
}

async function draftProfile({ cv, answersText }, signal) {
  await i18nReady;
  const answers = answersText ? `\n\nCANDIDATE ANSWERS:\n${answersText}` : "";
  const result = await callLmStudio(profileDraftPrompt(), `CV:\n${String(cv).slice(0, 20000)}${answers}`, { signal });
  if (!result.ok) return result;
  return { ok: true, profile: assembleDraftProfile(result.data || {}) };
}

async function suggestDomainFlags({ profile, languages }, signal) {
  await i18nReady;
  const result = await callLmStudio(JOB_FIT_PROMPTS.suggestFlags(languages), `CANDIDATE PROFILE:\n${profile}`, { signal });
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
    await i18nReady;
    return { ok: false, failure: "busy", error: t("bg.queueBusy", { count: snapshot.active }) };
  }
  return evaluateWithLmStudio(
    {
      profile: message.profile,
      postingText: message.postingText,
      domainFlags: message.domainFlags,
      learningFlags: message.learningFlags,
      coreWorkOnly: message.coreWorkOnly,
      expectedSalary: message.expectedSalary,
      jobSearch: message.jobSearch,
      place: message.place,
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

function summarizePrompt() {
  return JOB_FIT_PROMPTS.summarize(JOB_FIT_I18N.lang);
}

function assembleSummary(data) {
  if (!data || typeof data !== "object") return "";
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const list = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
  const notStated = t("brief.notStated");
  const stated = (value) => {
    const v = text(value);
    return !v || v.toLowerCase() === "not stated" ? notStated : v;
  };

  // A model that ignored the schema and answered in the old single-field
  // shape still produces a usable brief.
  const hasFields = ["role", "required", "preferred", "responsibilities"].some((k) => data[k] != null);
  if (!hasFields && text(data.summary)) return text(data.summary);

  const bullets = (title, items) => (items.length ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  const lines = [
    t("brief.heading"),
    `${t("brief.role")}: ${stated(data.role)}`,
    `${t("brief.seniority")}: ${stated(data.seniority)}`,
    `${t("brief.location")}: ${stated(data.location)}`,
    `${t("brief.compensation")}: ${stated(data.compensation)}`,
    `${t("brief.workAuth")}: ${stated(data.work_authorization)}`,
  ].join("\n");
  const notes = text(data.other_notes);
  return (
    lines +
    bullets(t("brief.responsibilities"), list(data.responsibilities)) +
    bullets(t("brief.required"), list(data.required)) +
    bullets(t("brief.preferred"), list(data.preferred)) +
    (notes ? `\n\n${t("brief.otherNotes")}: ${notes}` : "")
  );
}

function buildSummarizePrompt(postingText) {
  return postingBlock(trimPosting(postingText).text);
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
      await chrome.action.setBadgeBackgroundColor({ color: state === "paused" ? "#9a6300" : "#2350c4" });
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
  await i18nReady;
  const { profiles } = await JOB_FIT_PROFILES.load();
  const profile = profiles.find((p) => p.id === item.profileId);
  if (!profile) {
    const place = JOB_FIT_GEO.postingPlace({ location: item.location, text: item.postingText || "" });
    return {
      hardReject: null,
      domainFlags: item.domainFlags || [],
      learningFlags: item.learningFlags || [],
      coreWorkOnly: [],
      positiveSignals: [],
      softWarnings: item.softWarnings || [],
      place: { country: place.country, region: place.region, arrangement: place.arrangement },
    };
  }
  return JOB_FIT_SCREEN.screen(item.postingText || "", profile.keywords, {
    profileText: profile.profile,
    location: item.location,
    jobSearch: profile.jobSearch,
  });
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
    place: screened.place || null,
    // Requisition id and dates, read on the page when it was queued; a
    // re-evaluation from Tracked jobs has none and keeps what's saved.
    meta: item.meta || null,
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
        learningFlags: [],
        coreWorkOnly: [],
        positiveSignals: [],
        softWarnings: [],
      });
    } catch (err) {
      return { ok: false, failure: "storage", error: t("bg.rejectNotSaved", { error: err.message }) };
    }
    await notifyTab(item, record);
    return { ok: true };
  }

  const result = await evaluateWithLmStudio(
    {
      profile: snapshot.profile,
      postingText: item.postingText,
      domainFlags: screened.domainFlags,
      learningFlags: screened.learningFlags,
      coreWorkOnly: screened.coreWorkOnly,
      expectedSalary: snapshot.expectedSalary,
      jobSearch: snapshot.jobSearch,
      place: screened.place,
      location: item.location,
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
      learningFlags: screened.learningFlags || [],
      coreWorkOnly: screened.coreWorkOnly || [],
      positiveSignals: screened.positiveSignals || [],
      // "Sponsorship not stated" sits with the other amber warnings, where
      // it's something to ask about, not a lower verdict.
      softWarnings: [...(screened.softWarnings || []), ...(result.data.sponsorship_warning ? [result.data.sponsorship_warning] : [])],
    });
  } catch (err) {
    return { ok: false, failure: "storage", error: t("bg.scoredNotSaved", { error: err.message }) };
  }

  await recordDuration(result.durationMs);
  await notifyTab(item, record);
  return { ok: true };
}

async function runQueuedSummarize(item) {
  await i18nReady;
  const result = await callLmStudio(summarizePrompt(), buildSummarizePrompt(item.postingText));
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
    meta: item.meta || null,
    summary,
  });

  // Assembled here rather than in the popup so the brief survives the popup
  // being destroyed — which, before the queue, is exactly how a finished
  // summary got lost.
  const combined = JOB_FIT_EVALSTORE.briefText(record);

  await chrome.storage.local.set({
    lastSummary: {
      url: item.url,
      ts: Date.now(),
      profileId: item.profileId,
      jobKey: item.jobKey,
      text: combined,
      // Whether the brief carries this profile's evaluation, for the popup's
      // "Copied (includes …)" line — the text itself is in the user's language.
      hasEvaluation: Boolean(JOB_FIT_EVALSTORE.formatEvaluation(record)),
    },
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
chrome.runtime.onStartup.addListener(() => {
  kick();
  syncFloatScripts();
});
chrome.runtime.onInstalled.addListener((details) => {
  kick();
  // An update ships new files; re-register so the button runs the new ones.
  syncFloatScripts();
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
async function evaluateTab(tab, { ignoreCache = false, skipDuplicateCheck = false, anyPage = false } = {}) {
  if (!tab || tab.id == null) return;
  await i18nReady;
  const started = await startEvaluation(tab.id, { ignoreCache, skipDuplicateCheck, anyPage });
  if (started.ok) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b3261e" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: `Tino — ${started.error}` });
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

// ---------------------------------------------------------------------------
// On-page button (float.js), opt-in per site or per job board.
//
// JobFit reads nothing on a page until asked, and installs with no access to
// job boards. The button needs to run on a site before anyone clicks, so it's
// switched on in the popup or Settings, which ask Chrome for exactly that
// (optional_host_permissions): one site (`floatingButtonSites`, origins), or
// a whole job board (`floatingButtonBoards`, ids from boards.js) — every
// Indeed country, every Workday employer — as one permission. One dynamically
// registered content script covers exactly what's still granted, so revoking
// access in Chrome's own settings takes the button away too.
// ---------------------------------------------------------------------------

const FLOAT_SCRIPT_ID = "jobfit-float";
const FLOAT_FRAME_SCRIPT_ID = "jobfit-float-frame";

// The extractors and job identity (to know which job is on screen), the
// stores (to show its saved score), the card and the messages. content.js is
// left out: it starts an evaluation the moment it loads, and the button only
// does that on a click.
function floatFiles() {
  const pageFiles = JOB_FIT_CONTENT_FILES.filter((f) => f !== "content.js" && f !== "screening.js" && f !== "geo.js");
  return ["locales/en.js", "locales/es.js", "locales/fr.js", "locales/pt.js", ...pageFiles, "boards.js", "float.js"];
}

// A Greenhouse board embedded in a company's career site: just enough to say
// which job the embed shows (float-frame.js).
function floatFrameFiles() {
  return ["extractors/text.js", "extractors/greenhouse.js", "jobkey.js", "float-frame.js"];
}

function sitePattern(origin) {
  return `${origin}/*`;
}

async function floatState() {
  const { floatingButtonSites, floatingButtonBoards } = await chrome.storage.local.get(["floatingButtonSites", "floatingButtonBoards"]);
  return {
    sites: Array.isArray(floatingButtonSites) ? floatingButtonSites : [],
    boards: Array.isArray(floatingButtonBoards) ? floatingButtonBoards.filter((id) => JOB_FIT_BOARDS.byId(id)) : [],
  };
}

async function floatEnabledFor(url) {
  return JOB_FIT_BOARDS.enabledFor(url, await floatState());
}

// Serialized: registering while an earlier call is still unregistering would
// fail on the duplicate id.
let floatSync = Promise.resolve();

function syncFloatScripts() {
  floatSync = floatSync
    .then(async () => {
      const { sites, boards } = await floatState();
      const grantedSites = [];
      for (const origin of sites) {
        if (await chrome.permissions.contains({ origins: [sitePattern(origin)] })) grantedSites.push(origin);
      }
      const grantedBoards = [];
      for (const id of boards) {
        if (await chrome.permissions.contains({ origins: JOB_FIT_BOARDS.byId(id).patterns })) grantedBoards.push(id);
      }
      if (grantedSites.length !== sites.length || grantedBoards.length !== boards.length) {
        await chrome.storage.local.set({ floatingButtonSites: grantedSites, floatingButtonBoards: grantedBoards });
      }
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [FLOAT_SCRIPT_ID, FLOAT_FRAME_SCRIPT_ID] });
      } catch (err) {
        // Not both registered; take away whichever was.
        await chrome.scripting.unregisterContentScripts({ ids: [FLOAT_SCRIPT_ID] }).catch(() => {});
        await chrome.scripting.unregisterContentScripts({ ids: [FLOAT_FRAME_SCRIPT_ID] }).catch(() => {});
      }
      const matches = Array.from(
        new Set([...grantedSites.map(sitePattern), ...grantedBoards.flatMap((id) => JOB_FIT_BOARDS.byId(id).patterns)])
      );
      if (!matches.length) return;
      await chrome.scripting.registerContentScripts([
        {
          id: FLOAT_SCRIPT_ID,
          matches,
          js: floatFiles(),
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        },
        // Embedded boards: runs in any greenhouse.io embed frame, asks whether
        // the page around it is switched on, and reads nothing if not.
        {
          id: FLOAT_FRAME_SCRIPT_ID,
          matches: ["https://*.greenhouse.io/embed/*"],
          js: floatFrameFiles(),
          runAt: "document_idle",
          allFrames: true,
          persistAcrossSessions: true,
        },
      ]);
    })
    .catch((err) => console.warn("[Job Fit Evaluator] on-page button registration failed", err));
  return floatSync;
}

// Shown straight away, without reloading the tab.
function showFloatNow(tabId) {
  if (tabId != null) chrome.scripting.executeScript({ target: { tabId }, files: floatFiles() }).catch(() => {});
}

async function setFloatSite(origin, enabled, tabId) {
  if (!/^https?:\/\/[^/]+$/.test(String(origin || ""))) return { ok: false };
  const { sites } = await floatState();
  const next = enabled ? Array.from(new Set([...sites, origin])) : sites.filter((s) => s !== origin);
  await chrome.storage.local.set({ floatingButtonSites: next, floatPending: null });
  await syncFloatScripts();
  if (enabled) showFloatNow(tabId);
  if (!enabled) {
    // Give the access back. Fails harmlessly for a site the manifest itself
    // needs (greenhouse.io).
    chrome.permissions.remove({ origins: [sitePattern(origin)] }).catch(() => {});
  }
  return { ok: true, sites: next };
}

// Switches whole boards on or off. A site the board now covers loses its own
// entry and permission: the board's is the one that counts, and a leftover
// grant would be access nothing uses.
async function setFloatBoards(ids, enabled, tabId) {
  const valid = (ids || []).filter((id) => JOB_FIT_BOARDS.byId(id));
  if (!valid.length) return { ok: false };
  const state = await floatState();
  const boards = enabled ? Array.from(new Set([...state.boards, ...valid])) : state.boards.filter((id) => !valid.includes(id));
  let sites = state.sites;
  if (enabled) {
    const covered = sites.filter((origin) => {
      const board = JOB_FIT_BOARDS.boardForUrl(origin);
      return board && valid.includes(board.id);
    });
    sites = sites.filter((origin) => !covered.includes(origin));
    covered.forEach((origin) => chrome.permissions.remove({ origins: [sitePattern(origin)] }).catch(() => {}));
  }
  await chrome.storage.local.set({ floatingButtonBoards: boards, floatingButtonSites: sites, floatPending: null });
  await syncFloatScripts();
  if (enabled) showFloatNow(tabId);
  if (!enabled) {
    valid
      .map(JOB_FIT_BOARDS.byId)
      .filter((board) => !board.alwaysGranted)
      .forEach((board) => chrome.permissions.remove({ origins: board.patterns }).catch(() => {}));
  }
  return { ok: true, sites, boards };
}

// The popup asks for the permission; if Chrome's prompt closes the popup
// before it hears the answer, this finishes the job.
chrome.permissions.onAdded.addListener(async (added) => {
  const { floatPending } = await chrome.storage.local.get("floatPending");
  if (!floatPending || Date.now() - floatPending.ts > 5 * 60 * 1000) return;
  const origins = added.origins || [];
  if (floatPending.origin && origins.includes(sitePattern(floatPending.origin))) {
    setFloatSite(floatPending.origin, true, floatPending.tabId);
  } else if (Array.isArray(floatPending.boards)) {
    const boards = floatPending.boards.map(JOB_FIT_BOARDS.byId).filter(Boolean);
    const allGranted = boards.every((board) => board.alwaysGranted || board.patterns.every((p) => origins.includes(p)));
    if (boards.length && allGranted) setFloatBoards(floatPending.boards, true, floatPending.tabId);
  }
});

chrome.permissions.onRemoved.addListener(() => syncFloatScripts());

// A fresh install gets the setup wizard, never an update: an existing user
// already has a working profile and shouldn't be interrupted. load() creates
// the seed profile; it's marked unfinished so the popup keeps offering to
// continue if the wizard tab is closed early. Domain flags are cleared because
// the defaults are one specific person's gaps, not a new user's.
async function startFirstRunSetup() {
  const store = await JOB_FIT_PROFILES.load();
  const seed = store.profiles[0];
  seed.setupIncomplete = true;
  seed.keywords.domainFlags = JOB_FIT_KEYWORDS.emptyConfig("domainFlags");
  await JOB_FIT_PROFILES.save(store);
  await chrome.storage.local.set({ wizardProgress: { [seed.id]: { mode: "install", step: 0, furthest: 0 } } });
  chrome.tabs.create({ url: chrome.runtime.getURL(`wizard.html?mode=install&profile=${encodeURIComponent(seed.id)}`) });
}

// Who's asking. The extension's own pages — the popup, Settings, Tracked jobs,
// the wizard — can ask for anything. The scripts JobFit runs on job sites are
// only as trustworthy as that site's renderer, so they get what the card and
// an evaluation need and nothing more: never a model call with text of their
// choosing (it would spend the user's API key), never the queue's controls,
// and never switching the on-page button on.
function fromExtensionPage(sender) {
  return Boolean(
    sender &&
      sender.id === chrome.runtime.id &&
      typeof sender.url === "string" &&
      sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

const PAGE_SCRIPT_MESSAGES = new Set([
  "JOB_FIT_ENQUEUE",
  "JOB_FIT_EVALUATE_TAB",
  "JOB_FIT_CARD_RELAY",
  "JOB_FIT_FLOAT_SITE",
  "JOB_FIT_FLOAT_BOARD",
  "JOB_FIT_FRAME_ENABLED",
  "JOB_FIT_FRAME_JOB",
  "JOB_FIT_PROBE",
  "JOB_FIT_OPEN_HISTORY",
]);

// A posting longer than this is page furniture, not a job; the prompt trims
// far below it anyway (MAX_POSTING_CHARS), so this only bounds what's stored.
const MAX_STORED_POSTING_CHARS = 200000;

// The profile an evaluation is scored against, read here rather than taken
// from the message: a page script's copy could carry any CV.
async function profileSnapshotFor(profileId) {
  const { profiles } = await JOB_FIT_PROFILES.load();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) return null;
  return {
    name: profile.name,
    snapshot: {
      profile: profile.profile,
      expectedSalary: profile.expectedSalary,
      jobSearch: profile.jobSearch,
      fingerprint: JOB_FIT_PROFILES.fingerprint(profile),
    },
  };
}

// What a page script may queue: an evaluation of the page it's on, against a
// profile that exists, scored with that profile as stored.
async function enqueueFromPage(item, sender) {
  if (!item || item.kind !== "evaluate" || typeof item.jobKey !== "string" || !sender.tab) return { ok: false };
  const owner = await profileSnapshotFor(item.profileId);
  if (!owner) return { ok: false };
  return JOB_FIT_QUEUE.enqueue({
    ...item,
    kind: "evaluate",
    profileName: owner.name,
    profileSnapshot: owner.snapshot,
    postingText: String(item.postingText || "").slice(0, MAX_STORED_POSTING_CHARS),
    url: sender.url || item.url,
    tabId: sender.tab.id,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const trusted = fromExtensionPage(sender);
  if (!trusted && !PAGE_SCRIPT_MESSAGES.has(message?.type)) {
    if (typeof message?.type === "string" && message.type.startsWith("JOB_FIT_")) sendResponse({ ok: false, error: "not allowed" });
    return false;
  }

  if (message?.type === "JOB_FIT_ENQUEUE") {
    const queued = trusted
      ? JOB_FIT_QUEUE.enqueue({ ...message.item, tabId: sender.tab ? sender.tab.id : message.tabId }, { priority: message.priority })
      : enqueueFromPage(message.item, sender);
    queued.then((result) => {
      sendResponse(result);
      if (result.ok) kick();
    });
    return true;
  }
  // The on-page card's click: exactly what the keyboard shortcut does. Its
  // Re-evaluate asks for the saved result to be skipped, and its Evaluate
  // anyway for the same posting scored elsewhere to be, or for a page that
  // doesn't look like a posting to be read as one.
  if (message?.type === "JOB_FIT_EVALUATE_TAB") {
    if (sender.tab) {
      evaluateTab(sender.tab, {
        ignoreCache: Boolean(message.ignoreCache),
        skipDuplicateCheck: Boolean(message.skipDuplicateCheck),
        anyPage: Boolean(message.anyPage),
      });
    }
    sendResponse({ ok: Boolean(sender.tab) });
    return false;
  }
  // card.js in a frame (an embedded Greenhouse board) draws nothing itself:
  // its calls go to the card in the page's top frame. Through here rather
  // than postMessage, which the embedding site could read — the result says
  // how well its own posting fits your CV.
  if (message?.type === "JOB_FIT_CARD_RELAY") {
    if (sender.tab && sender.frameId !== 0 && typeof message.method === "string") {
      chrome.tabs
        .sendMessage(sender.tab.id, { type: "JOB_FIT_CARD_CALL", method: message.method, args: message.args || [] }, { frameId: 0 })
        .catch(() => {});
    }
    return false;
  }
  // From a page script, only the card's ×: off, and only for the site or
  // board the card is on. Switching on is the popup's and Settings' to do.
  if (message?.type === "JOB_FIT_FLOAT_SITE") {
    if (!trusted) {
      if (message.enabled || !sender.tab || !sender.tab.url) {
        sendResponse({ ok: false });
        return false;
      }
      setFloatSite(new URL(sender.tab.url).origin, false, sender.tab.id).then(sendResponse);
      return true;
    }
    const origin = message.origin || (sender.tab && sender.tab.url ? new URL(sender.tab.url).origin : null);
    setFloatSite(origin, Boolean(message.enabled), message.tabId ?? (sender.tab && sender.tab.id)).then(sendResponse);
    return true;
  }
  if (message?.type === "JOB_FIT_FLOAT_BOARD") {
    if (!trusted) {
      const board = sender.tab && sender.tab.url ? JOB_FIT_BOARDS.boardForUrl(sender.tab.url) : null;
      if (message.enabled || !board) {
        sendResponse({ ok: false });
        return false;
      }
      setFloatBoards([board.id], false, sender.tab.id).then(sendResponse);
      return true;
    }
    setFloatBoards(message.boards, Boolean(message.enabled), message.tabId ?? (sender.tab && sender.tab.id)).then(sendResponse);
    return true;
  }
  // float-frame.js, in a Greenhouse board embedded in a company's site: is
  // the page around it switched on? Asked before it reads anything.
  if (message?.type === "JOB_FIT_FRAME_ENABLED") {
    if (!sender.tab || sender.frameId === 0) {
      sendResponse(false);
      return false;
    }
    floatEnabledFor(sender.tab.url).then(sendResponse);
    return true;
  }
  // …and which job it shows, for the card in the page's top frame.
  if (message?.type === "JOB_FIT_FRAME_JOB") {
    if (sender.tab && sender.frameId !== 0 && message.job && typeof message.job.jobKey === "string") {
      floatEnabledFor(sender.tab.url).then((on) => {
        if (!on) return;
        chrome.tabs
          .sendMessage(sender.tab.id, { type: "JOB_FIT_FRAME_JOB", job: message.job }, { frameId: 0 })
          .catch(() => {});
      });
    }
    return false;
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
  // Any of: provider switched, model or endpoint changed, API key added, an
  // endpoint allowed.
  const touched = Boolean(changes.endpointApprovalStamp) || ["modelProvider", "lmStudio", "openai"].some((key) => {
    if (!changes[key]) return false;
    const before = changes[key].oldValue;
    const after = changes[key].newValue;
    if (key === "modelProvider") return before !== after;
    const b = before || {};
    const a = after || {};
    // The key is in the vault; its keySavedAt stamp is what changes here.
    return b.model !== a.model || b.url !== a.url || b.keySavedAt !== a.keySavedAt || b.dailyTokenBudget !== a.dailyTokenBudget;
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

// A key saved before the vault existed moves there on the first start after
// the update, rather than waiting for the first OpenAI request.
JOB_FIT_VAULT.migrate().catch((err) => console.warn("[Job Fit Evaluator] key migration failed", err));

// A worker that starts for any reason picks the queue back up.
kick();
