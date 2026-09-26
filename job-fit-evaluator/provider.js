// Which model scores postings: LM Studio on this machine, or the OpenAI API.
//
// The settings live in three storage keys:
//   modelProvider  "lmstudio" (default) | "openai"
//   lmStudio       { url, model, timeoutSeconds, reasoningEffort, enableThinking, seed }
//   openai         { apiKey, model, reasoningEffort }
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
        model: (oa.model || "").trim(),
        apiKey: (oa.apiKey || "").trim(),
        reasoningEffort: oa.reasoningEffort || "",
        maxOutputTokens: clampOutputTokens(oa.maxOutputTokens),
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

  async function load() {
    return resolve(await chrome.storage.local.get(KEYS));
  }

  function currentModel(stored) {
    return resolve(stored).model;
  }

  // OpenAI's reasoning models (o-series, gpt-5 family) reject temperature and
  // the penalty parameters, and take reasoning_effort; the others are the
  // reverse. Decided by name because the models list doesn't say.
  function isOpenAiReasoningModel(model) {
    return /^(o\d|gpt-5)/i.test(model || "");
  }

  // Which reasoning.effort values a model takes. GPT-5 adds "minimal"; the
  // o-series starts at "low"; other models take none, and sending one is
  // rejected. Name-based, like isOpenAiReasoningModel.
  function reasoningEffortsFor(model) {
    const name = String(model || "").toLowerCase();
    if (/^gpt-5/.test(name)) return ["minimal", "low", "medium", "high"];
    if (/^o\d/.test(name)) return ["low", "medium", "high"];
    return [];
  }

  // The saved effort, adjusted to what this model accepts: "minimal" on an
  // o-series model becomes "low" rather than a rejected request, and a model
  // that takes no effort gets none.
  function effectiveReasoningEffort(model, wanted) {
    const allowed = reasoningEffortsFor(model);
    if (!allowed.length || !wanted) return "";
    if (allowed.includes(wanted)) return wanted;
    return wanted === "minimal" ? allowed[0] : "";
  }

  // A ceiling on what one request can cost. Reasoning tokens count toward it,
  // so too low a cap cuts the answer off — callLmStudio reports that plainly.
  const OUTPUT_TOKEN_RANGE = { min: 500, max: 64000 };
  function clampOutputTokens(value) {
    const n = Math.round(Number(value));
    if (!n) return JOB_FIT_DEFAULTS.openai.maxOutputTokens;
    return Math.min(OUTPUT_TOKEN_RANGE.max, Math.max(OUTPUT_TOKEN_RANGE.min, n));
  }

  // Local calendar day, so "today" in the usage totals matches the user's day,
  // not UTC's.
  function dayKey(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    isOpenAiReasoningModel,
    isOpenAiChatModel,
    reasoningEffortsFor,
    effectiveReasoningEffort,
    clampOutputTokens,
    dayKey,
  };
})();
