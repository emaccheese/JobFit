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

// Returns { ok, models, url } or { ok: false, reason, url }. `reason` is
// "invalid-url" or "unreachable", so each caller can word the failure for
// where it's shown.
async function probeModels(chatUrl, timeoutMs = 2500) {
  const url = modelsUrlFrom(chatUrl);
  if (!url) return { ok: false, reason: "invalid-url", url: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = ((payload && payload.data) || []).map((m) => m.id).filter(Boolean);
    return { ok: true, models, url };
  } catch (err) {
    return { ok: false, reason: "unreachable", url };
  } finally {
    clearTimeout(timer);
  }
}

function openSetupWizard(params) {
  const query = new URLSearchParams(params).toString();
  chrome.tabs.create({ url: chrome.runtime.getURL(`wizard.html?${query}`) });
}
