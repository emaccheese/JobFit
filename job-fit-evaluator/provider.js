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
  const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
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
        url: OPENAI_CHAT_URL,
        model: (oa.model || "").trim(),
        apiKey: (oa.apiKey || "").trim(),
        reasoningEffort: oa.reasoningEffort || "",
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

  // /v1/models lists every model on the account — embeddings, speech, image,
  // moderation — and only chat models can score a posting.
  function isOpenAiChatModel(id) {
    const name = String(id || "").toLowerCase();
    if (!/^(gpt-|o\d|chatgpt)/.test(name)) return false;
    return !/(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct)/.test(name);
  }

  return { KEYS, LABELS, OPENAI_CHAT_URL, OPENAI_MODELS_URL, resolve, load, currentModel, isOpenAiReasoningModel, isOpenAiChatModel };
})();
