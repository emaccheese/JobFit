// Shared by the popup and the setup wizard: talking to the service worker, and
// asking LM Studio which models it has loaded. Both pages need the same answer
// to "is the model reachable", so there is one implementation of it.

// MV3 service workers go idle after ~30s. Waking one via sendMessage can
// lose a race the first time (message dispatched before its listener is
// registered), throwing "Receiving end does not exist" even though a
// manual retry would succeed immediately after. Retry transparently
// instead of surfacing that as a real error.
async function sendMessageWithRetry(message, retries = 2, delayMs = 250) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// The configured endpoint is the chat-completions URL; POSTing to it would run
// a generation. /v1/models is the cheap GET that answers "is it up", and its
// response also says which models are actually loaded.
function modelsUrlFrom(chatUrl) {
  try {
    const url = new URL(chatUrl);
    url.search = "";
    url.hash = "";
    url.pathname = /\/chat\/completions\/?$/.test(url.pathname)
      ? url.pathname.replace(/\/chat\/completions\/?$/, "/models")
      : "/v1/models";
    return url.toString();
  } catch (err) {
    return null;
  }
}

// Whether an endpoint off this machine has been allowed. Only the worker and
// the extension's pages can read the vault; anywhere else, no.
async function endpointApproved(origin) {
  return typeof JOB_FIT_VAULT !== "undefined" && (await JOB_FIT_VAULT.isApprovedOrigin(origin));
}

// Allowing (or no longer allowing) an endpoint. The stamp in storage is what
// the worker watches, to resume a queue that paused waiting for this.
async function setEndpointApproved(origin, allowed) {
  if (allowed) await JOB_FIT_VAULT.approveOrigin(origin);
  else await JOB_FIT_VAULT.revokeOrigin(origin);
  await chrome.storage.local.set({ endpointApprovalStamp: Date.now() });
}

// Returns { ok, models, url } or { ok: false, reason, url }. `reason` is
// "invalid-url", "insecure", "not-approved" (with `origin`), "unreachable",
// "no-key" or "unauthorized", so each caller can word the failure for where
// it's shown.
//
// Takes either a chat URL (LM Studio, the original signature) or a settings
// object from JOB_FIT_PROVIDER.resolve(), which may point at OpenAI.
async function probeModels(target, timeoutMs = 2500) {
  const settings = typeof target === "string" ? { provider: "lmstudio", url: target } : target || {};
  const isOpenAi = settings.provider === "openai";
  if (isOpenAi && !settings.apiKey) return { ok: false, reason: "no-key", url: JOB_FIT_PROVIDER.OPENAI_MODELS_URL };

  // An endpoint off this machine has to be allowed first (provider.js
  // endpointPolicy): the probe itself sends nothing private, but scoring
  // would, and "connected" would be the wrong answer.
  if (!isOpenAi) {
    const policy = JOB_FIT_PROVIDER.endpointPolicy(settings.url);
    if (policy.kind === "invalid") return { ok: false, reason: "invalid-url", url: null };
    if (policy.kind === "insecure") return { ok: false, reason: "insecure", url: settings.url, origin: policy.origin };
    if (policy.kind === "approval" && !(await endpointApproved(policy.origin))) {
      return { ok: false, reason: "not-approved", url: settings.url, origin: policy.origin };
    }
  }

  const url = isOpenAi ? JOB_FIT_PROVIDER.OPENAI_MODELS_URL : modelsUrlFrom(settings.url);
  if (!url) return { ok: false, reason: "invalid-url", url: null };

  const controller = new AbortController();
  // OpenAI is a round trip over the internet, not to localhost.
  const timer = setTimeout(() => controller.abort(), isOpenAi ? Math.max(timeoutMs, 8000) : timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: isOpenAi ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    });
    if (isOpenAi && (response.status === 401 || response.status === 403)) {
      return { ok: false, reason: "unauthorized", url };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    let models = ((payload && payload.data) || []).map((m) => m.id).filter(Boolean);
    if (isOpenAi) models = models.filter(JOB_FIT_PROVIDER.isOpenAiChatModel).sort();
    return { ok: true, models, url };
  } catch (err) {
    return { ok: false, reason: "unreachable", url };
  } finally {
    clearTimeout(timer);
  }
}

// What a probe means for the person looking at it: { state: "ok" | "warn" |
// "bad", text, title }. Shared by the popup's readiness row and Settings ›
// Model, which used to word the same failures separately.
function describeModelReadiness(settings, probe) {
  const wanted = settings.model;
  if (settings.provider === "openai") {
    if (probe.reason === "no-key") return { state: "bad", text: t("popup.oaNoKey") };
    if (probe.reason === "unauthorized") return { state: "bad", text: t("popup.oaBadKey") };
    if (!probe.ok) return { state: "bad", text: t("popup.oaUnreachable") };
    if (!wanted) return { state: "warn", text: t("popup.oaPickModel") };
    if (probe.models.length && !probe.models.includes(wanted)) {
      return { state: "warn", text: t("popup.oaModelMissing", { model: wanted }), title: probe.models.join("\n") };
    }
    return { state: "ok", text: `OpenAI — ${wanted}` };
  }
  if (probe.reason === "invalid-url") return { state: "bad", text: t("popup.lmBadUrl") };
  if (probe.reason === "insecure") return { state: "bad", text: t("popup.lmInsecure", { origin: probe.origin }) };
  if (probe.reason === "not-approved") return { state: "warn", text: t("popup.lmNotApproved", { origin: probe.origin }) };
  if (!probe.ok) return { state: "bad", text: t("popup.lmUnreachable"), title: probe.url };
  const loaded = probe.models;
  if (!wanted) {
    return { state: "ok", text: t("popup.lmConnectedUsing", { model: loaded[0] || t("popup.whateverLoaded") }), title: loaded.join("\n") };
  }
  // A model name that isn't loaded is the cause of the HTTP error that pauses
  // the whole queue — worth catching before you've queued ten.
  if (loaded.length && !loaded.includes(wanted)) {
    return { state: "warn", text: t("popup.lmNotLoaded", { model: wanted }), title: `${t("popup.loaded")}:\n${loaded.join("\n")}` };
  }
  return { state: "ok", text: t("popup.lmConnected", { model: wanted }) };
}

// Settings opens in a tab (options_ui), and Chrome focuses the one already
// open. A section to land on is left in storage for it to pick up, because
// openOptionsPage() can't carry a #hash to a tab that's already open.
async function openSettings(section) {
  if (section) await chrome.storage.local.set({ settingsJump: { section, ts: Date.now() } });
  await chrome.runtime.openOptionsPage();
}

function openSetupWizard(params) {
  const query = new URLSearchParams(params).toString();
  chrome.tabs.create({ url: chrome.runtime.getURL(`wizard.html?${query}`) });
}
