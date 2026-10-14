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
  if (settings.provider === "tinocloud") return probeTinoCloud(settings);
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

// Tino Cloud's readiness: set up in this build, signed in, the server
// reachable, and the credit at the chosen level. Asks the server for the
// account, and keeps the balance it reports for the card and the popup.
async function probeTinoCloud(settings) {
  if (typeof JOB_FIT_CLOUD === "undefined" || !JOB_FIT_CLOUD.available()) return { ok: false, reason: "cloud-unavailable", models: [] };
  if (!settings.session && !(await JOB_FIT_CLOUD.isSignedIn())) return { ok: false, reason: "signed-out", models: [] };
  const account = await JOB_FIT_CLOUD.account();
  if (!account.ok) return { ok: false, reason: account.status === 401 ? "signed-out" : "unreachable", models: [] };
  const level = (account.levels || []).find((l) => l.id === settings.level) || null;
  await chrome.storage.local.set({
    tinoCloudBalance: { balanceMicros: account.balanceMicros, estLeft: level ? level.estLeft : 0, level: settings.level, at: Date.now() },
  });
  return { ok: true, models: [], account, level, outOfCredit: !level || level.estLeft < 1 };
}

// Credit, always in cents ("$0.84"): the three decimals formatDollars gives
// small amounts are for per-evaluation costs, not a balance.
function creditDollars(micros) {
  return `$${((Number(micros) || 0) / 1e6).toFixed(2)}`;
}

// An effort level's name, in the interface language.
function levelName(id) {
  return t(`level.${id}`);
}

// The effort-level picker, for Tino Cloud and your own OpenAI key, in
// Settings and the wizard: each level's name, what it's for, and what it
// costs. On Tino Cloud the cost is about how many evaluations are left at
// that level (from the account, when there is one); with your own key, about
// what 100 evaluations cost. Your own key also has "Custom": your own model
// and effort, set in the fields that follow.
function renderLevelPicker(host, { provider, selected, account = null, name = "modelLevel", onChange } = {}) {
  host.textContent = "";
  const group = document.createElement("div");
  group.className = "level-list";
  group.setAttribute("role", "radiogroup");
  const ids = JOB_FIT_PROVIDER.levels().map((l) => l.id).concat(provider === "openai" ? ["custom"] : []);
  const fromAccount = new Map(((account && account.levels) || []).map((l) => [l.id, l]));
  ids.forEach((id) => {
    const level = JOB_FIT_PROVIDER.levelById(id);
    const label = document.createElement("label");
    label.className = "level-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = id;
    input.checked = id === selected;
    input.addEventListener("change", () => input.checked && onChange && onChange(id));
    const text = document.createElement("span");
    text.className = "level-text";
    const title = document.createElement("strong");
    title.textContent = levelName(id);
    const blurb = document.createElement("span");
    blurb.className = "level-blurb";
    blurb.textContent = t(`level.${id}.blurb`);
    const cost = document.createElement("span");
    cost.className = "level-cost";
    if (!level) cost.textContent = "";
    else if (provider === "tinocloud") {
      const live = fromAccount.get(id);
      cost.textContent = live
        ? t("level.leftAt", { count: Math.max(0, Math.floor(live.estLeft)) })
        : t("level.perDollar", { count: Math.floor(1 / level.estCost) });
    } else {
      cost.textContent = t("level.per100", { cost: JOB_FIT_PROVIDER.formatDollars(level.estCost * 100) });
    }
    text.append(title, blurb, cost);
    label.append(input, text);
    group.appendChild(label);
  });
  host.appendChild(group);
}

// Signing in to Tino Cloud, for Settings and the wizard: "Continue with
// Google", or an email address, then the 6-digit code sent to it. Calls
// onSignedIn(email) once signed in (the session is in the vault by then).
const CLOUD_SIGN_IN_ERRORS = {
  email: "cloud.errEmail",
  rate: "cloud.errRate",
  code: "cloud.errCode",
  unreachable: "cloud.unreachable",
  cancelled: "cloud.errCancelled",
  failed: "cloud.errFailed",
};

function mountCloudSignIn(host, { onSignedIn, idPrefix = "cloud" } = {}) {
  host.textContent = "";
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (text, className) => {
    const b = make("button", className || null, text);
    b.type = "button";
    return b;
  };

  const google = button(t("cloud.google"), "primary");
  const googleRow = make("div", "actions");
  googleRow.appendChild(google);

  const emailField = make("div", "field cloud-email");
  const emailLabel = make("label", "field-label", t("cloud.orEmail"));
  const email = make("input");
  email.type = "email";
  email.id = `${idPrefix}Email`;
  email.autocomplete = "email";
  email.spellcheck = false;
  email.placeholder = "you@example.com";
  emailLabel.htmlFor = email.id;
  const send = button(t("cloud.sendCode"));
  const emailRow = make("div", "row");
  emailRow.append(email, send);
  emailField.append(emailLabel, emailRow);

  const codeField = make("div", "field cloud-code");
  codeField.hidden = true;
  const codeLabel = make("label", "field-label", t("cloud.enterCode"));
  const code = make("input");
  code.type = "text";
  code.id = `${idPrefix}Code`;
  code.inputMode = "numeric";
  code.autocomplete = "one-time-code";
  code.maxLength = 7;
  code.spellcheck = false;
  code.placeholder = "123456";
  codeLabel.htmlFor = code.id;
  const verify = button(t("cloud.signIn"), "primary");
  const other = button(t("cloud.otherEmail"), "link");
  const codeRow = make("div", "row");
  codeRow.append(code, verify, other);
  codeField.append(codeLabel, codeRow);

  const status = make("div", "hint cloud-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const say = (key, vars, isError) => {
    status.textContent = key ? t(key, vars) : "";
    status.classList.toggle("error", Boolean(isError));
  };
  const fail = (error) => say(CLOUD_SIGN_IN_ERRORS[error] || "cloud.errFailed", null, error !== "cancelled");

  google.addEventListener("click", async () => {
    google.disabled = true;
    say("cloud.openingGoogle");
    const result = await JOB_FIT_CLOUD.signInWithGoogle();
    google.disabled = false;
    if (result.ok) {
      say("cloud.signedInAs", { email: result.email });
      onSignedIn && onSignedIn(result.email);
    } else fail(result.error);
  });

  const sendCode = async () => {
    send.disabled = true;
    const address = email.value.trim();
    const result = await JOB_FIT_CLOUD.requestCode(address);
    send.disabled = false;
    if (!result.ok) return fail(result.error);
    codeField.hidden = false;
    codeLabel.textContent = t("cloud.codeSentTo", { email: address });
    say("cloud.codeSent", { email: address });
    code.value = "";
    code.focus();
  };
  send.addEventListener("click", sendCode);
  email.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendCode();
    }
  });

  const check = async () => {
    verify.disabled = true;
    const result = await JOB_FIT_CLOUD.verifyCode(email.value.trim(), code.value);
    verify.disabled = false;
    if (result.ok) {
      codeField.hidden = true;
      say("cloud.signedInAs", { email: result.email });
      onSignedIn && onSignedIn(result.email);
    } else fail(result.error);
  };
  verify.addEventListener("click", check);
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      check();
    }
  });
  other.addEventListener("click", () => {
    codeField.hidden = true;
    say(null);
    email.focus();
  });

  host.append(googleRow, emailField, codeField, status);
}

// What a probe means for the person looking at it: { state: "ok" | "warn" |
// "bad", text, title }. Shared by the popup's readiness row and Settings ›
// Model, which used to word the same failures separately.
function describeModelReadiness(settings, probe) {
  const wanted = settings.model;
  if (settings.provider === "tinocloud") {
    if (probe.reason === "cloud-unavailable") return { state: "bad", text: t("cloud.unavailable") };
    if (probe.reason === "signed-out") return { state: "warn", text: t("cloud.signInFirst") };
    if (!probe.ok) return { state: "bad", text: t("cloud.unreachable") };
    if (probe.outOfCredit) return { state: "warn", text: t("cloud.outOfCredit", { level: levelName(settings.level) }) };
    return { state: "ok", text: t("cloud.ready", { level: levelName(settings.level), count: probe.level.estLeft }) };
  }
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
