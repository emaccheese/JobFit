// Which model scores postings: LM Studio on this machine, or the OpenAI API.
//
// The settings live in three storage keys:
//   modelProvider  "lmstudio" (default) | "openai"
//   lmStudio       { url, model, timeoutSeconds, reasoningEffort, enableThinking, seed }
//   openai         { model, reasoningEffort, keySavedAt, … }
// The OpenAI key itself is not in storage: it's in the vault (vault.js), where
// the scripts on job pages can't read it. load() adds it; resolve() alone,
// which those scripts use for the model name, never has it (except for an
// install not migrated yet, or the wizard's own in-memory state).
// `lmStudio` keeps its original shape so existing installs need no migration,
// and it still owns the response timeout, which applies to either provider.
//
// Everything that needs "the model in use" — the request itself, the
// out-of-date check on saved scores, the popup's readiness line — resolves it
// here, so switching provider can't leave one of them reading the old model.
//
// Loaded in the service worker, the popup, the history page, the wizard and
// injected pages; assigned with var so re-injection doesn't throw.
var JOB_FIT_PROVIDER = (function () {
  const KEYS = ["modelProvider", "lmStudio", "openai"];
  // The Responses API, OpenAI's current recommended API. LM Studio keeps its
  // chat-completions URL (see lmStudio.url).
  const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
  const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

  const LABELS = { lmstudio: "LM Studio", openai: "OpenAI" };

  function resolve(stored) {
    const s = stored || {};
    const provider = s.modelProvider === "openai" ? "openai" : "lmstudio";
    const lm = { ...JOB_FIT_DEFAULTS.lmStudio, ...(s.lmStudio || {}) };
    const oa = { ...JOB_FIT_DEFAULTS.openai, ...(s.openai || {}) };
    const timeoutSeconds = Number(lm.timeoutSeconds) || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;

    if (provider === "openai") {
      return {
        provider,
        label: LABELS.openai,
        url: OPENAI_RESPONSES_URL,
        // Empty means "not chosen yet", not "none": use the default tier.
        model: (oa.model || JOB_FIT_DEFAULTS.openai.model || "").trim(),
        apiKey: (oa.apiKey || "").trim(),
        reasoningEffort: oa.reasoningEffort || "",
        maxOutputTokens: clampOutputTokens(oa.maxOutputTokens),
        flex: ["bulk", "always", "never"].includes(oa.flex) ? oa.flex : "bulk",
        dailyTokenBudget: Math.max(0, Number(oa.dailyTokenBudget) || 0),
        timeoutSeconds,
      };
    }
    return {
      provider,
      label: LABELS.lmstudio,
      url: lm.url || JOB_FIT_DEFAULTS.lmStudio.url,
      model: (lm.model || "").trim(),
      apiKey: "",
      reasoningEffort: lm.reasoningEffort,
      enableThinking: lm.enableThinking,
      seed: lm.seed,
      timeoutSeconds,
    };
  }

  // For the service worker and the extension's pages: the settings with the
  // key from the vault. Never called from a page script.
  async function load() {
    const settings = resolve(await chrome.storage.local.get(KEYS));
    if (settings.provider === "openai" && typeof JOB_FIT_VAULT !== "undefined") {
      await JOB_FIT_VAULT.migrate();
      settings.apiKey = (await JOB_FIT_VAULT.openAiKey()) || settings.apiKey;
    }
    return settings;
  }

  function currentModel(stored) {
    return resolve(stored).model;
  }

  // Where an LM Studio-style endpoint may be. Every request to it carries the
  // CV, the salary expectations and the posting, so:
  //   this machine (localhost, 127.x, ::1)      always
  //   the local network (10.x, 172.16-31.x,
  //   192.168.x, *.local)                       once you allow it, http or https
  //   anywhere else                             https only, once you allow it
  // Anything that isn't an http(s) URL is refused. The allowed list is in the
  // vault, so a script on a job page can't add its own host to it.
  // { kind: "loopback" | "approval" | "insecure" | "invalid", origin }
  function endpointPolicy(url) {
    let u;
    try {
      u = new URL(String(url || ""));
    } catch (err) {
      return { kind: "invalid", origin: null };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "invalid", origin: null };
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const origin = u.origin;
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
      return { kind: "loopback", origin };
    }
    const lan =
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host.endsWith(".local");
    if (lan || u.protocol === "https:") return { kind: "approval", origin };
    return { kind: "insecure", origin };
  }

  // OpenAI's reasoning models (o-series, gpt-5 and later) reject temperature
  // and take reasoning effort; the others are the reverse. Decided by name
  // because the models list doesn't say — and it's only a first guess:
  // background.js retries without whatever a model rejects and remembers it.
  function isOpenAiReasoningModel(model) {
    return /^(o\d|gpt-([5-9]|\d{2,}))/i.test(model || "");
  }

  // Which reasoning.effort values a model takes. GPT-5 adds "minimal"; the
  // o-series starts at "low"; other models take none, and sending one is
  // rejected. Name-based, like isOpenAiReasoningModel.
  function reasoningEffortsFor(model) {
    const name = String(model || "").toLowerCase();
    if (/^gpt-5/.test(name)) return ["minimal", "low", "medium", "high"];
    // gpt-6 and later, and the o-series: the levels every reasoning model has
    // taken so far. Anything else a newer model adds isn't offered until known.
    if (/^(o\d|gpt-([6-9]|\d{2,}))/.test(name)) return ["low", "medium", "high"];
    return [];
  }

  const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh"];

  // The saved effort, adjusted to what this model accepts: "minimal" on an
  // o-series model becomes "low" rather than a rejected request, and a model
  // that takes no effort gets none.
  //
  // `rejected` are levels OpenAI has refused for this model before. The
  // nearest level at or above the wanted one is used — rounding up rather than
  // down, so a rejection never quietly lowers scoring quality.
  function effectiveReasoningEffort(model, wanted, rejected = []) {
    const allowed = reasoningEffortsFor(model).filter((e) => !rejected.includes(e));
    if (!allowed.length || !wanted) return "";
    if (allowed.includes(wanted)) return wanted;
    const rank = EFFORT_ORDER.indexOf(wanted);
    return allowed.find((e) => EFFORT_ORDER.indexOf(e) >= rank) || allowed[allowed.length - 1];
  }

  // A ceiling on what one request can cost. Reasoning tokens count toward it,
  // so too low a cap cuts the answer off — callLmStudio reports that plainly.
  const OUTPUT_TOKEN_RANGE = { min: 500, max: 64000 };
  function clampOutputTokens(value) {
    const n = Math.round(Number(value));
    if (!n) return JOB_FIT_DEFAULTS.openai.maxOutputTokens;
    return Math.min(OUTPUT_TOKEN_RANGE.max, Math.max(OUTPUT_TOKEN_RANGE.min, n));
  }

  // A rough cost per 100 evaluations for a tier, to make the choice concrete.
  // Assumes a typical evaluation (1,800 input + 700 output tokens) unless the
  // caller has the user's own average; prices are per 1M tokens.
  const TYPICAL_EVALUATION = { input: 1800, output: 700 };
  function costPer100(tier, mode = "standard", tokens = TYPICAL_EVALUATION) {
    const price = tier && tier.price && tier.price[mode];
    if (!price) return null;
    return (100 * (tokens.input * price[0] + tokens.output * price[1])) / 1e6;
  }

  function formatDollars(amount) {
    if (amount == null) return "";
    return amount < 0.1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`;
  }

  function tierForModel(model) {
    return (JOB_FIT_DEFAULTS.openaiTiers || []).find((t) => t.model === model) || null;
  }

  // Local calendar day, so "today" in the usage totals matches the user's day,
  // not UTC's.
  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Today's OpenAI tokens (input + output), as recorded in usageByDay.
  function openAiTokensOnDay(usageByDay, day = dayKey()) {
    const t = ((usageByDay || {})[day] || {}).openai;
    return t ? t.input + t.output : 0;
  }

  // What counts against the daily budget: today's tokens since the last
  // manual reset (stored as `openaiBudgetReset: { day, tokens }`), or all of
  // today's if there was none today. A reset records a starting point rather
  // than deleting usage, so the day's and month's totals stay true.
  function budgetTokensUsed(usageByDay, reset) {
    const today = dayKey();
    const used = openAiTokensOnDay(usageByDay, today);
    const baseline = reset && reset.day === today ? Number(reset.tokens) || 0 : 0;
    return Math.max(0, used - baseline);
  }

  // /v1/models lists every model on the account — embeddings, speech, image,
  // moderation — and only chat models can score a posting.
  function isOpenAiChatModel(id) {
    const name = String(id || "").toLowerCase();
    if (!/^(gpt-|o\d|chatgpt)/.test(name)) return false;
    return !/(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct)/.test(name);
  }

  return {
    KEYS,
    LABELS,
    OPENAI_RESPONSES_URL,
    OPENAI_MODELS_URL,
    OUTPUT_TOKEN_RANGE,
    resolve,
    load,
    currentModel,
    endpointPolicy,
    isOpenAiReasoningModel,
    isOpenAiChatModel,
    reasoningEffortsFor,
    effectiveReasoningEffort,
    clampOutputTokens,
    dayKey,
    openAiTokensOnDay,
    budgetTokensUsed,
    costPer100,
    formatDollars,
    tierForModel,
  };
})();
