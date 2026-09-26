// The setup wizard: a guided pass over everything a profile needs, in the
// order the pieces depend on each other — the model first (drafting the CV and
// every suggestion needs it), then who you are, then the CV, then what's
// derived from the CV.
//
// A tab rather than the popup, for the same reason as history.html: the popup
// destroys itself whenever focus moves, and a step that asks you to paste a CV
// from another window would lose it every time.
//
// Every change is written to the real stores as you go. There is no draft copy
// to commit at the end, so closing the tab early loses nothing, and the popup's
// "Continue setup" banner picks up where you stopped.

const ALL_STEPS = [
  { key: "welcome", title: "Welcome" },
  { key: "model", title: "Model" },
  { key: "about", title: "About you" },
  { key: "profile", title: "Candidate profile" },
  { key: "salary", title: "Expected salary" },
  { key: "rejects", title: "Hard rejects" },
  { key: "warnings", title: "Warnings" },
  { key: "flags", title: "Domain flags" },
  { key: "review", title: "Review" },
];

const SALARY_CURRENCIES = ["USD", "CAD", "MXN"];

// Each answer on the About step owns a set of hard-reject categories. Changing
// the answer re-ticks or unticks exactly those, and nothing else — so a
// category ticked by hand on the Hard rejects step survives later edits to
// unrelated answers.
const ANSWER_RULES = {
  citizen: {
    presets: ["citizenship", "clearance", "itar"],
    tickWhen: ["no"],
    reason: "you're not a US citizen or permanent resident",
  },
  sponsorship: {
    presets: ["sponsorship"],
    tickWhen: ["yes", "depends"],
    reason: "you'll need visa sponsorship",
  },
  relocate: {
    presets: ["relocation"],
    tickWhen: ["no"],
    reason: "you won't relocate at your own cost",
  },
};

// Built to exercise every part of the result — a required section, a
// preferred section, a stated salary, and a sponsorship line phrased so the
// default hard rejects don't fire on it.
const SAMPLE_POSTING = `Senior Software Engineer, Platform
Northwind Robotics · Austin, TX (hybrid)

About the role
You'll design and build the backend services that coordinate our fleet of warehouse robots: real-time job scheduling, telemetry ingestion, and the APIs our operations team uses every day.

What you'll do
- Design, build and operate high-throughput services in Go or Java
- Own features end to end, from design review to production monitoring
- Improve reliability and observability across the platform
- Mentor engineers and lead technical design discussions

Required qualifications
- 5+ years of professional software engineering experience
- Strong experience with Go, Java or C++
- Experience designing distributed systems and REST or gRPC APIs
- Experience with SQL databases and cloud infrastructure (AWS or GCP)

Preferred qualifications
- Kubernetes and infrastructure-as-code (Terraform)
- Experience with robotics, IoT or real-time systems
- Machine learning experience is a plus

Compensation: $150,000 – $185,000 per year, plus equity.
Visa sponsorship is available for this role.`;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  mode: "edit", // install | new | edit
  steps: [],
  index: 0,
  furthest: 0,
  returnToReview: false,
  profile: null, // the working profile; written through to storage
  persisted: false, // false only for a "new" profile before it has a name
  lm: null,
  modelDirty: false,
  modelOk: false,
  modelExpanded: false,
  flagSuggestions: [],
  draftUndo: null,
};

// --- small helpers ---------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function linesToArray(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function wordCount(text) {
  const words = String(text || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

function formatMoney(n) {
  return Number(n).toLocaleString();
}

function stepIndex(key) {
  return state.steps.findIndex((s) => s.key === key);
}

function currentKey() {
  return state.steps[state.index].key;
}

function callout(kind, children) {
  const box = el("div", `callout ${kind}`);
  (Array.isArray(children) ? children : [children]).forEach((c) =>
    box.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return box;
}

// --- saving ----------------------------------------------------------------

let saveTimer = null;

function setSaveState(text, isError) {
  const node = $("saveState");
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
}

// The provider's own settings object: its .model is the one in use.
function activeModelSettings() {
  return state.provider === "openai" ? state.oa : state.lm;
}

function activeModel() {
  return (activeModelSettings().model || "").trim();
}

function resolvedSettings() {
  return JOB_FIT_PROVIDER.resolve({ modelProvider: state.provider, lmStudio: state.lm, openai: state.oa });
}

function modelSettingsToStore() {
  return {
    modelProvider: state.provider,
    lmStudio: {
      ...state.lm,
      url: (state.lm.url || "").trim() || JOB_FIT_DEFAULTS.lmStudio.url,
      model: (state.lm.model || "").trim(),
      timeoutSeconds: Number(state.lm.timeoutSeconds) || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds,
    },
    openai: {
      ...state.oa,
      apiKey: (state.oa.apiKey || "").trim(),
      model: (state.oa.model || "").trim(),
    },
  };
}

// Re-reads the store and replaces only this profile, so an edit made to a
// different profile in the popup or the history page while this tab was open
// isn't overwritten with a stale copy.
async function saveProfile({ activate = false } = {}) {
  const store = await JOB_FIT_PROFILES.load();
  const index = store.profiles.findIndex((p) => p.id === state.profile.id);
  const copy = JOB_FIT_PROFILES.clone(state.profile);
  if (index === -1) {
    // Saving a profile someone deleted elsewhere would quietly bring it back.
    if (state.persisted) throw new Error("this profile was deleted in another window");
    store.profiles.push(copy);
  } else {
    store.profiles[index] = copy;
  }
  if (activate) store.activeProfileId = state.profile.id;
  await JOB_FIT_PROFILES.save(store);
  state.persisted = true;
}

async function saveNow() {
  clearTimeout(saveTimer);
  collectCurrent();
  if (!state.modelDirty && !state.persisted) return;
  setSaveState("Saving…");
  try {
    if (state.modelDirty) {
      await chrome.storage.local.set(modelSettingsToStore());
      state.modelDirty = false;
    }
    if (state.persisted) await saveProfile();
    setSaveState("All changes saved");
  } catch (err) {
    setSaveState(`Couldn't save: ${err.message}`, true);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("Saving…");
  saveTimer = setTimeout(saveNow, 400);
}

// Only while setup is unfinished: it's what lets the popup's "Continue setup"
// reopen at the right step. A finished profile re-run from settings has
// nothing to resume.
async function saveProgress() {
  if (!state.persisted || !state.profile.setupIncomplete) return;
  const stored = await chrome.storage.local.get("wizardProgress");
  const all = stored.wizardProgress || {};
  all[state.profile.id] = { mode: state.mode, step: state.index, furthest: state.furthest };
  await chrome.storage.local.set({ wizardProgress: all });
}

async function clearProgress() {
  const stored = await chrome.storage.local.get("wizardProgress");
  const all = stored.wizardProgress || {};
  delete all[state.profile.id];
  await chrome.storage.local.set({ wizardProgress: all });
}

// --- model calls -----------------------------------------------------------

// Local models can take minutes. A bare spinner that long reads as broken, so
// every call shows how long it has been running and can be cancelled — and
// Cancel really stops the request in LM Studio, not just the spinner.
async function modelCall(message, statusHost, { button, busyText }) {
  const callId = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  statusHost.innerHTML = "";

  const busy = el("div", "busy");
  busy.appendChild(el("span", "spinner"));
  const label = el("span", null, busyText);
  busy.appendChild(label);
  const cancel = el("button", "link", "Cancel");
  cancel.type = "button";
  busy.appendChild(cancel);
  statusHost.appendChild(busy);

  const tick = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    label.textContent = `${busyText} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
  cancel.addEventListener("click", () => {
    label.textContent = "Cancelling…";
    cancel.disabled = true;
    sendMessageWithRetry({ type: "JOB_FIT_CANCEL_CALL", callId }).catch(() => {});
  });

  if (button) button.disabled = true;
  let response;
  try {
    response = await sendMessageWithRetry({ ...message, callId });
  } catch (err) {
    response = { ok: false, error: err.message };
  } finally {
    clearInterval(tick);
    if (button) button.disabled = false;
    statusHost.innerHTML = "";
  }

  if (!response || !response.ok) {
    if (response && response.failure === "cancelled") return null;
    statusHost.appendChild(el("div", "error-text", (response && response.error) || "The model didn't return an answer."));
    return null;
  }
  return response;
}

// --- step: model -----------------------------------------------------------

function renderModelStatus(probe) {
  const host = $("modelStatus");
  host.innerHTML = "";
  $("modelPicker").hidden = true;
  state.modelOk = false;

  if (!probe) return;
  const openai = state.provider === "openai";
  if (probe.reason === "no-key") {
    host.appendChild(callout("info", "Paste your OpenAI API key above and press Connect."));
    return;
  }
  if (probe.reason === "unauthorized") {
    host.appendChild(callout("bad", "OpenAI rejected that key. Check it was copied in full, and that the key is active on your OpenAI account."));
    return;
  }
  if (openai && !probe.ok) {
    host.appendChild(callout("bad", "Couldn't reach OpenAI. Check your internet connection and try again."));
    return;
  }
  if (probe.reason === "invalid-url") {
    host.appendChild(callout("bad", "That isn't a valid URL. The default is http://localhost:1234/v1/chat/completions."));
    return;
  }
  if (!probe.ok) {
    const steps = el("ol");
    [
      "Install LM Studio from lmstudio.ai and open it.",
      "Download a model and load it. An instruct model of 7–14B parameters works well.",
      "Open the Developer tab and start the local server, so its status reads Running.",
    ].forEach((t) => steps.appendChild(el("li", null, t)));
    const retry = el("button", null, "Test again");
    retry.type = "button";
    retry.style.marginTop = "8px";
    retry.addEventListener("click", testConnection);
    host.appendChild(callout("bad", [el("strong", null, `Couldn't reach LM Studio at ${probe.url}.`), steps, retry]));
    return;
  }
  if (!probe.models.length) {
    host.appendChild(
      callout(
        "warn",
        openai
          ? "That key works, but the account has no chat models available."
          : "LM Studio is running, but no model is loaded. Load one in LM Studio, then test again."
      )
    );
    return;
  }

  host.appendChild(callout("ok", openai ? "Connected to OpenAI." : "Connected to LM Studio."));
  $("modelPickerHint").textContent = openai
    ? "Chat models available on this API key. Smaller \"mini\" models are cheaper and usually score well."
    : "These are the models LM Studio has loaded right now.";
  const list = $("modelList");
  list.innerHTML = "";
  const wanted = activeModel();
  if (wanted && !probe.models.includes(wanted)) {
    host.appendChild(el("div", "hint", `The model you had selected, "${wanted}", isn't available any more. Pick one below.`));
  }
  // Preselected, not saved: it's written when you leave this step, so merely
  // opening the wizard never changes the model other profiles are using.
  // For OpenAI the first model alphabetically is often an expensive one;
  // a "mini" model is the cheaper default and scores postings well.
  const fallback = (openai && probe.models.find((m) => /-mini$/.test(m))) || probe.models[0];
  const chosen = probe.models.includes(wanted) ? wanted : fallback;
  if (chosen !== wanted) {
    activeModelSettings().model = chosen;
    state.modelDirty = true;
  }
  probe.models.forEach((id) => {
    const row = el("label");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "lmModel";
    radio.value = id;
    radio.checked = id === chosen;
    row.appendChild(radio);
    row.appendChild(document.createTextNode(id));
    list.appendChild(row);
  });
  $("modelPicker").hidden = false;
  state.modelOk = true;
  if (openai) renderOaReasoning();
}

async function testConnection() {
  collectModel();
  const button = state.provider === "openai" ? $("testOpenAi") : $("testConnection");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Testing…";
  const probe = await probeModels(resolvedSettings(), 4000);
  button.disabled = false;
  button.textContent = label;
  renderModelStatus(probe);
  updateNav();
  return probe;
}

// Shows the fields for the chosen provider only: an endpoint means nothing to
// OpenAI, and an API key means nothing to LM Studio.
function showProviderFields() {
  const openai = state.provider === "openai";
  $("openAiKeyField").hidden = !openai;
  $("lmUrlField").hidden = openai;
  $("oaCostFields").hidden = !openai;
  renderOaReasoning();
  $("lmOnlyAdvanced").hidden = openai;
  document.querySelectorAll('input[name="provider"]').forEach((r) => (r.checked = r.value === state.provider));
}

// Only the effort levels the selected model accepts; hidden for models that
// take none. The saved preference in state.oa is left alone, so picking a
// different model and back restores it.
function renderOaReasoning() {
  const model = state.oa.model || "";
  const allowed = JOB_FIT_PROVIDER.reasoningEffortsFor(model);
  $("oaReasoningField").hidden = !allowed.length;
  const select = $("oaReasoning");
  select.innerHTML = "";
  ["", ...allowed].forEach((value) => {
    const opt = el("option", null, value || "(model default)");
    opt.value = value;
    select.appendChild(opt);
  });
  select.value = JOB_FIT_PROVIDER.effectiveReasoningEffort(model, state.oa.reasoningEffort);
}

function fillModel() {
  showProviderFields();
  $("oaKey").value = state.oa.apiKey || "";
  $("oaMaxOutput").value = JOB_FIT_PROVIDER.clampOutputTokens(state.oa.maxOutputTokens);
  $("oaBudget").value = Number(state.oa.dailyTokenBudget) || "";
  $("lmUrl").value = state.lm.url || JOB_FIT_DEFAULTS.lmStudio.url;
  $("lmTimeout").value = state.lm.timeoutSeconds || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
  $("lmReasoning").value = state.lm.reasoningEffort ?? "";
  $("lmThinking").checked = Boolean(state.lm.enableThinking);
}

function collectModel() {
  const before = JSON.stringify(state.lm);
  state.lm.url = $("lmUrl").value.trim();
  state.lm.timeoutSeconds = $("lmTimeout").value === "" ? JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds : Number($("lmTimeout").value);
  state.lm.reasoningEffort = $("lmReasoning").value;
  state.lm.enableThinking = $("lmThinking").checked;
  const beforeOa = JSON.stringify(state.oa);
  state.oa.apiKey = $("oaKey").value.trim();
  if (!$("oaReasoningField").hidden) state.oa.reasoningEffort = $("oaReasoning").value;
  state.oa.maxOutputTokens = JOB_FIT_PROVIDER.clampOutputTokens($("oaMaxOutput").value);
  state.oa.dailyTokenBudget = Math.max(0, Number($("oaBudget").value) || 0);
  const picked = document.querySelector('input[name="lmModel"]:checked');
  if (picked) activeModelSettings().model = picked.value;
  if (JSON.stringify(state.lm) !== before || JSON.stringify(state.oa) !== beforeOa) state.modelDirty = true;
}

async function enterModel() {
  fillModel();
  // Setting up a second profile shouldn't mean re-doing the model: it's shared.
  // Collapsed to one line when it already works, expanded only if it doesn't.
  const compactable = state.mode === "new" && !state.modelExpanded;
  $("modelCompact").hidden = true;
  $("modelFull").hidden = compactable;
  const probe = await testConnection();
  if (compactable && state.modelOk) {
    $("compactModelName").textContent = `${activeModel()} (${resolvedSettings().label})`;
    $("modelCompact").hidden = false;
  } else {
    $("modelFull").hidden = false;
  }
  if (currentKey() === "model") updateNav();
  return probe;
}

// --- step: about -----------------------------------------------------------

function fillAbout() {
  $("profileName").value = state.profile.name || "";
  const answers = state.profile.setupAnswers || {};
  Object.keys(ANSWER_RULES).forEach((question) => {
    document.querySelectorAll(`input[name="${question}"]`).forEach((radio) => {
      radio.checked = radio.value === answers[question];
    });
  });
}

function applyAnswer(question, value) {
  state.profile.setupAnswers = { ...(state.profile.setupAnswers || {}), [question]: value };
  const rule = ANSWER_RULES[question];
  const config = state.profile.keywords.hardRejects;
  const ticked = new Set(config.presets || []);
  rule.presets.forEach((id) => (rule.tickWhen.includes(value) ? ticked.add(id) : ticked.delete(id)));
  // Kept in the order the categories are listed, so the review reads naturally.
  config.presets = JOB_FIT_KEYWORDS.presetsFor("hardRejects")
    .map((p) => p.id)
    .filter((id) => ticked.has(id));
}

// Which answer, if any, is the reason a hard-reject category is ticked.
function reasonFor(presetId) {
  const answers = state.profile.setupAnswers || {};
  for (const [question, rule] of Object.entries(ANSWER_RULES)) {
    if (rule.presets.includes(presetId) && rule.tickWhen.includes(answers[question])) return rule.reason;
  }
  return null;
}

function authorisationSentence() {
  const a = state.profile.setupAnswers || {};
  const parts = [];
  if (a.citizen === "yes") parts.push("US citizen or permanent resident");
  if (a.citizen === "no") parts.push("not a US citizen or permanent resident");
  if (a.sponsorship === "yes") parts.push("needs visa sponsorship");
  if (a.sponsorship === "depends") parts.push("needs visa sponsorship in some countries");
  if (a.sponsorship === "no") parts.push("doesn't need sponsorship");
  if (a.relocate === "yes") parts.push("willing to relocate at own cost");
  if (a.relocate === "no") parts.push("won't relocate at own cost");
  if (!parts.length) return "";
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

// --- step: profile ---------------------------------------------------------

function templateWithAnswers() {
  const sentence = authorisationSentence();
  const template = JOB_FIT_DEFAULTS.profile;
  return sentence ? template.replace(/^Work authorisation:.*$/m, `Work authorisation: ${sentence}`) : template;
}

// The untouched template (with or without the answers filled in) isn't a
// profile — scoring against it would produce confident, meaningless numbers.
function isPlaceholderProfile(text) {
  const t = String(text || "").trim();
  return !t || t === JOB_FIT_DEFAULTS.profile.trim() || t === templateWithAnswers().trim();
}

const PROFILE_SECTIONS = [
  ["Core", /^\s*core\s*:/im],
  ["Gaps", /^\s*gaps\s*:/im],
  ["Work authorisation", /^\s*work authori[sz]ation\s*:/im],
  ["Target", /^\s*target\s*:/im],
];

function renderProfileMeter() {
  const text = $("profileText").value;
  const meter = $("profileMeter");
  meter.innerHTML = "";
  const words = wordCount(text);
  const count = el("span", "count", `${words} / ~400 words`);
  if (words > 600) count.classList.add("way-over");
  else if (words > 400) count.classList.add("over");
  meter.appendChild(count);
  PROFILE_SECTIONS.forEach(([label, re]) => meter.appendChild(el("span", `sec${re.test(text) ? " has" : ""}`, label)));

  const gapsLine = text.match(/^\s*gaps\s*:(.*)$/im);
  $("gapsNudge").hidden = isPlaceholderProfile(text) || Boolean(gapsLine && gapsLine[1].trim());
}

function showProfileTab(which) {
  $("tabCv").setAttribute("aria-selected", String(which === "cv"));
  $("tabEdit").setAttribute("aria-selected", String(which === "edit"));
  $("paneCv").hidden = which !== "cv";
  $("paneEdit").hidden = which !== "edit";
  if (which === "edit") renderProfileMeter();
}

function enterProfile() {
  // An empty profile, or the template from before the answers were given,
  // gets the template with the authorisation line already written.
  if (isPlaceholderProfile(state.profile.profile)) {
    state.profile.profile = templateWithAnswers();
  }
  $("profileText").value = state.profile.profile;
  showProfileTab(isPlaceholderProfile(state.profile.profile) ? "cv" : "edit");
}

async function draftProfile() {
  const cv = $("cvText").value.trim();
  const status = $("draftStatus");
  if (!cv) {
    status.innerHTML = "";
    status.appendChild(el("div", "error-text", "Paste your CV first."));
    $("cvText").focus();
    return;
  }
  const response = await modelCall(
    { type: "JOB_FIT_DRAFT_PROFILE", cv, answersText: authorisationSentence() },
    status,
    { button: $("draftProfile"), busyText: "Drafting your profile…" }
  );
  if (!response) return;

  // Drafting over a profile you'd already written keeps the old one a click away.
  const previous = $("profileText").value;
  state.draftUndo = isPlaceholderProfile(previous) ? null : previous;
  $("profileText").value = response.profile;
  state.profile.profile = response.profile;
  const note = $("draftedNote");
  note.hidden = false;
  const existingUndo = note.querySelector("button");
  if (existingUndo) existingUndo.remove();
  if (state.draftUndo) {
    const undo = el("button", "link", "Restore my previous profile");
    undo.type = "button";
    undo.style.marginLeft = "6px";
    undo.addEventListener("click", () => {
      $("profileText").value = state.draftUndo;
      state.profile.profile = state.draftUndo;
      state.draftUndo = null;
      note.hidden = true;
      renderProfileMeter();
      scheduleSave();
      updateNav();
    });
    note.appendChild(undo);
  }
  showProfileTab("edit");
  scheduleSave();
  updateNav();
}

// --- step: salary ----------------------------------------------------------

function renderSalaryRows() {
  const host = $("salaryRows");
  if (host.childElementCount) return;
  SALARY_CURRENCIES.forEach((cur) => {
    const row = el("div", "salary-row");
    row.dataset.currency = cur;
    row.appendChild(el("span", "cur", cur));
    ["min", "max"].forEach((end) => {
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1000";
      input.placeholder = end === "min" ? "Minimum per year" : "Maximum per year";
      input.id = `salary${cur}${end}`;
      row.appendChild(input);
    });
    host.appendChild(row);
  });
}

function enterSalary() {
  renderSalaryRows();
  const salary = state.profile.expectedSalary || {};
  const withValues = SALARY_CURRENCIES.filter((c) => salary[c] && (salary[c].min != null || salary[c].max != null));
  const markets = withValues.length ? withValues : state.salaryMarkets || ["USD"];
  document.querySelectorAll("#markets input").forEach((box) => (box.checked = markets.includes(box.value)));
  SALARY_CURRENCIES.forEach((cur) => {
    const range = salary[cur] || {};
    $(`salary${cur}min`).value = range.min ?? "";
    $(`salary${cur}max`).value = range.max ?? "";
  });
  syncSalaryRows();
}

function checkedMarkets() {
  return Array.from(document.querySelectorAll("#markets input:checked")).map((b) => b.value);
}

function syncSalaryRows() {
  const markets = checkedMarkets();
  state.salaryMarkets = markets;
  document.querySelectorAll(".salary-row").forEach((row) => (row.hidden = !markets.includes(row.dataset.currency)));
  validateSalary();
}

function validateSalary() {
  const problems = [];
  let suspicious = false;
  checkedMarkets().forEach((cur) => {
    const min = $(`salary${cur}min`).value;
    const max = $(`salary${cur}max`).value;
    if (min !== "" && max !== "" && Number(min) > Number(max)) problems.push(`${cur}: the minimum is higher than the maximum.`);
    [min, max].forEach((v) => {
      if (v !== "" && Number(v) > 0 && Number(v) < 1000) suspicious = true;
    });
  });
  $("salaryError").hidden = !problems.length;
  $("salaryError").textContent = problems.join(" ");
  $("salaryWarn").hidden = !suspicious;
  $("salaryWarn").textContent = suspicious
    ? "Some figures look like monthly pay or thousands. Enter the full annual amount, e.g. 120000."
    : "";
  return !problems.length;
}

// Unticked markets are saved as empty, which already means "unknown" to the
// salary comparison. The inputs keep their values, so re-ticking a market you
// unticked by mistake brings the numbers back.
function collectSalary() {
  const markets = checkedMarkets();
  const out = {};
  SALARY_CURRENCIES.forEach((cur) => {
    const read = (end) => {
      const v = $(`salary${cur}${end}`).value;
      return !markets.includes(cur) || v === "" ? null : Number(v);
    };
    out[cur] = { min: read("min"), max: read("max") };
  });
  state.profile.expectedSalary = out;
}

async function suggestSalary() {
  const status = $("salaryStatus");
  status.innerHTML = "";
  $("salaryReasoning").textContent = "";
  // With no CV the model invents a plausible range, and that would then be
  // saved as your own expectation.
  if (isPlaceholderProfile(state.profile.profile)) {
    status.appendChild(el("div", "error-text", "Fill in your candidate profile first. Without it the model just invents a range."));
    return;
  }
  const markets = checkedMarkets();
  if (!markets.length) {
    status.appendChild(el("div", "error-text", "Tick at least one market first."));
    return;
  }
  const response = await modelCall({ type: "JOB_FIT_SUGGEST_SALARY", profile: state.profile.profile }, status, {
    button: $("suggestSalary"),
    busyText: "Estimating ranges…",
  });
  if (!response) return;
  markets.forEach((cur) => {
    const range = response.data && response.data[cur];
    if (!range) return;
    if (range.min != null) $(`salary${cur}min`).value = range.min;
    if (range.max != null) $(`salary${cur}max`).value = range.max;
  });
  $("salaryReasoning").textContent = response.data && response.data.reasoning
    ? `${response.data.reasoning} These are starting points, so adjust them to what you'd actually accept.`
    : "These are starting points, so adjust them to what you'd actually accept.";
  validateSalary();
  scheduleSave();
  updateNav();
}

// --- steps: hard rejects and warnings ---------------------------------------

function renderPresets(kind) {
  const host = $(`${kind}Presets`);
  host.innerHTML = "";
  const config = state.profile.keywords[kind];
  JOB_FIT_KEYWORDS.presetsFor(kind).forEach((preset) => {
    const row = el("label", "preset");
    const box = el("input");
    box.type = "checkbox";
    box.value = preset.id;
    box.checked = (config.presets || []).includes(preset.id);
    row.appendChild(box);
    const text = el("div");
    text.appendChild(el("div", "title", preset.label));
    if (preset.example) text.appendChild(el("div", "example", `e.g. "${preset.example}"`));
    // Hidden by CSS while unticked, so ticking doesn't need a re-render (which
    // would take keyboard focus off the checkbox).
    const why = kind === "hardRejects" ? reasonFor(preset.id) : null;
    if (why) text.appendChild(el("span", "why", `Because ${why}`));
    row.appendChild(text);
    host.appendChild(row);
  });
}

function enterKeywords(kind) {
  renderPresets(kind);
  const config = state.profile.keywords[kind];
  $(`${kind}Phrases`).value = (config.phrases || []).join("\n");
  $(`${kind}Patterns`).value = (config.patterns || []).join("\n");
  $(`${kind}Patterns`).closest("details").open = (config.patterns || []).length > 0;
}

function collectKeywords(kind) {
  state.profile.keywords[kind] = {
    presets: Array.from($(`${kind}Presets`).querySelectorAll("input:checked")).map((b) => b.value),
    phrases: linesToArray($(`${kind}Phrases`).value),
    patterns: linesToArray($(`${kind}Patterns`).value),
  };
}

// --- step: domain flags ----------------------------------------------------

function flagPhrases() {
  return state.profile.keywords.domainFlags.phrases || [];
}

function hasFlag(term) {
  return flagPhrases().some((p) => p.toLowerCase() === term.toLowerCase());
}

function addFlags(terms) {
  const config = state.profile.keywords.domainFlags;
  config.phrases = config.phrases || [];
  terms
    .map((t) => String(t).trim())
    .filter(Boolean)
    .forEach((t) => {
      if (!hasFlag(t)) config.phrases.push(t);
    });
  state.flagSuggestions = state.flagSuggestions.filter((s) => !hasFlag(s));
  renderFlags();
  scheduleSave();
}

function removeFlag(term) {
  const config = state.profile.keywords.domainFlags;
  config.phrases = flagPhrases().filter((p) => p !== term);
  renderFlags();
  scheduleSave();
}

function renderFlags() {
  const host = $("flagChips");
  const input = $("flagInput");
  host.querySelectorAll(".chip").forEach((c) => c.remove());
  flagPhrases().forEach((term) => {
    const chip = el("span", "chip", term);
    const x = el("button", null, "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${term}`);
    x.addEventListener("click", () => removeFlag(term));
    chip.appendChild(x);
    host.insertBefore(chip, input);
  });

  const suggestions = $("flagSuggestionChips");
  suggestions.innerHTML = "";
  state.flagSuggestions.forEach((term) => {
    const chip = el("button", "chip suggested", `+ ${term}`);
    chip.type = "button";
    chip.addEventListener("click", () => addFlags([term]));
    suggestions.appendChild(chip);
  });
  $("flagSuggestions").hidden = !state.flagSuggestions.length;
}

function enterFlags() {
  $("domainFlagsPatterns").value = (state.profile.keywords.domainFlags.patterns || []).join("\n");
  $("domainFlagsPatterns").closest("details").open = (state.profile.keywords.domainFlags.patterns || []).length > 0;
  renderFlags();
}

function collectFlags() {
  state.profile.keywords.domainFlags.patterns = linesToArray($("domainFlagsPatterns").value);
}

async function suggestFlags() {
  const status = $("flagsStatus");
  status.innerHTML = "";
  if (isPlaceholderProfile(state.profile.profile)) {
    status.appendChild(el("div", "error-text", "Fill in your candidate profile first. Suggestions come from its Gaps line."));
    return;
  }
  const response = await modelCall({ type: "JOB_FIT_SUGGEST_DOMAIN_FLAGS", profile: state.profile.profile }, status, {
    button: $("suggestFlags"),
    busyText: "Reading your profile…",
  });
  if (!response) return;
  state.flagSuggestions = response.terms.filter((t) => !hasFlag(t));
  if (!state.flagSuggestions.length) {
    status.appendChild(el("div", "hint", "Nothing new to suggest. Your list already covers what the profile's gaps point to."));
  }
  renderFlags();
}

// --- step: review ----------------------------------------------------------

function presetLabels(kind) {
  const config = state.profile.keywords[kind];
  const labels = JOB_FIT_KEYWORDS.presetsFor(kind)
    .filter((p) => (config.presets || []).includes(p.id))
    .map((p) => p.label);
  const extra = (config.phrases || []).length + (config.patterns || []).length;
  if (extra) labels.push(`${extra} custom phrase${extra === 1 ? "" : "s"}`);
  return labels;
}

function renderReview() {
  const host = $("reviewCards");
  host.innerHTML = "";
  const p = state.profile;

  const salaryLines = SALARY_CURRENCIES.filter((c) => p.expectedSalary[c] && (p.expectedSalary[c].min != null || p.expectedSalary[c].max != null)).map(
    (c) => {
      const r = p.expectedSalary[c];
      const lo = r.min != null ? formatMoney(r.min) : "…";
      const hi = r.max != null ? formatMoney(r.max) : "…";
      return `${c} ${lo} – ${hi}`;
    }
  );
  const rejects = presetLabels("hardRejects");
  const warnings = presetLabels("softWarnings");
  const flags = [...flagPhrases(), ...(p.keywords.domainFlags.patterns || [])];
  const firstLine = (p.profile || "").trim().split("\n")[0];

  const cards = [
    {
      step: "model",
      title: "Model",
      body: activeModel()
        ? `${activeModel()}\n${state.provider === "openai" ? "OpenAI API (postings and your profile are sent to OpenAI)" : state.lm.url}`
        : "Not connected. Evaluations won't run until it is.",
      missing: !activeModel(),
    },
    { step: "about", title: "About you", body: [p.name, authorisationSentence()].filter(Boolean).join("\n") },
    {
      step: "profile",
      title: "Candidate profile",
      body: isPlaceholderProfile(p.profile) ? "Not written yet." : `${wordCount(p.profile)} words: ${firstLine}`,
      missing: isPlaceholderProfile(p.profile),
    },
    {
      step: "salary",
      title: "Expected salary",
      body: salaryLines.length ? salaryLines.join("\n") : "Not set. Pay comparisons will show as unknown.",
    },
    { step: "rejects", title: "Hard rejects", body: rejects.length ? rejects.join("\n") : "None. No posting is rejected automatically." },
    { step: "warnings", title: "Warnings", body: warnings.length ? warnings.join("\n") : "None." },
    { step: "flags", title: "Domain flags", body: flags.length ? flags.join(", ") : "None. Gaps are left entirely to the model." },
  ];

  cards.forEach((card) => {
    const index = stepIndex(card.step);
    if (index === -1) return;
    const box = el("div", `review-card${card.missing ? " missing" : ""}`);
    const header = el("header");
    header.appendChild(el("h3", null, card.title));
    const edit = el("button", "link", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => goTo(index, { returnToReview: true }));
    header.appendChild(edit);
    box.appendChild(header);
    box.appendChild(el("div", "body", card.body));
    host.appendChild(box);
  });
}

async function enterReview() {
  renderReview();
  $("testBlocked").hidden = true;
  $("runTest").disabled = false;
  try {
    const snapshot = await sendMessageWithRetry({ type: "JOB_FIT_QUEUE_SNAPSHOT" });
    if (snapshot && snapshot.active > 0) {
      $("runTest").disabled = true;
      $("testBlocked").hidden = false;
      $("testBlocked").textContent = `Paused while ${snapshot.active} job${snapshot.active === 1 ? " is" : "s are"} being evaluated. LM Studio handles one request at a time.`;
    }
  } catch (err) {
    // No snapshot just means no pre-check; the worker refuses a busy run itself.
  }
}

function compileKind(kind) {
  return JOB_FIT_KEYWORDS.compile(state.profile.keywords[kind], kind)
    .map((entry) => {
      try {
        return { ...entry, re: new RegExp(entry.source, "i") };
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
}

function matchedLabels(kind, text) {
  const labels = [];
  compileKind(kind).forEach((entry) => {
    if (entry.re.test(text) && !labels.includes(entry.label)) labels.push(entry.label);
  });
  return labels;
}

function listSection(host, title, items) {
  if (!items || !items.length) return;
  host.appendChild(el("h4", null, title));
  const ul = el("ul");
  items.forEach((item) => ul.appendChild(el("li", null, item)));
  host.appendChild(ul);
}

async function runTest() {
  const status = $("testStatus");
  const out = $("testResult");
  status.innerHTML = "";
  out.innerHTML = "";
  await saveNow();

  if (isPlaceholderProfile(state.profile.profile)) {
    status.appendChild(el("div", "error-text", "Write your candidate profile first. There's nothing to score against yet."));
    return;
  }
  const own = $("ownPosting").open ? $("testPosting").value.trim() : "";
  const posting = own || SAMPLE_POSTING;

  // Layer 1 runs here exactly as it does on a real page: a hard reject stops
  // before the model is ever asked.
  const reject = compileKind("hardRejects").find((entry) => entry.re.test(posting));
  if (reject) {
    const box = el("div", "test-result");
    const line = el("div", "score-line");
    line.appendChild(el("span", "verdict reject", "Hard reject"));
    box.appendChild(line);
    const said = posting.match(reject.re);
    box.appendChild(
      el("p", null, `Rejected before the model ran: the posting says "${said ? said[0] : reject.label}" (${reject.label}). A real posting like this is filed as a reject straight away.`)
    );
    out.appendChild(box);
    return;
  }

  const domainFlags = matchedLabels("domainFlags", posting);
  const warnings = matchedLabels("softWarnings", posting);
  const response = await modelCall(
    {
      type: "JOB_FIT_TEST_EVALUATE",
      profile: state.profile.profile,
      postingText: posting,
      domainFlags,
      expectedSalary: state.profile.expectedSalary,
    },
    status,
    { button: $("runTest"), busyText: "Scoring the posting…" }
  );
  if (!response) return;

  const d = response.data || {};
  const box = el("div", "test-result");
  const line = el("div", "score-line");
  line.appendChild(el("span", "score", d.score != null ? String(d.score) : "?"));
  if (d.verdict) line.appendChild(el("span", `verdict ${d.verdict}`, d.verdict));
  box.appendChild(line);
  if (d.one_line) box.appendChild(el("p", null, d.one_line));
  if (d.score_cap_reasons) {
    box.appendChild(el("div", "hint", `Capped from ${d.raw_score}: ${d.score_cap_reasons.join(", ")}.`));
  }
  listSection(box, "Matches", d.matches);
  const required = (d.required_gaps || []).map((g) => String(g).toLowerCase());
  listSection(
    box,
    "Gaps",
    (d.gaps || []).map((g) => (required.includes(String(g).toLowerCase()) ? `${g} (required)` : g))
  );
  listSection(box, "Domain flags found", domainFlags);
  listSection(box, "Warnings found", warnings);
  if (d.salary && d.salary.posting_stated) {
    const vs = d.salary.vs_candidate_expectation;
    listSection(box, "Salary", [`${d.salary.posting_stated}${vs && vs !== "unknown" ? `: ${vs} your range` : ""}`]);
  }
  if (response.durationMs) {
    const seconds = Math.round(response.durationMs / 1000);
    const timeout = Number(state.lm.timeoutSeconds) || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
    const tight = seconds > timeout * 0.6;
    box.appendChild(
      el(
        "div",
        "hint",
        `Took ${seconds}s${response.usage ? `, ${(response.usage.input + response.usage.output).toLocaleString()} tokens${response.usage.reasoning ? ` (${response.usage.reasoning.toLocaleString()} reasoning)` : ""}` : ""}. Your timeout is ${timeout}s.${tight ? " That's close; consider raising it under Model → Advanced." : ""}`
      )
    );
  }
  out.appendChild(box);
}

// --- step controller -------------------------------------------------------

const STEP_HOOKS = {
  welcome: { valid: () => true },
  model: {
    enter: enterModel,
    collect: collectModel,
    valid: () => state.modelOk && Boolean(activeModel()),
  },
  about: {
    enter: fillAbout,
    collect: () => (state.profile.name = $("profileName").value.trim()),
    valid: () => Boolean($("profileName").value.trim()),
  },
  profile: {
    enter: enterProfile,
    collect: () => (state.profile.profile = $("profileText").value),
    valid: () => !isPlaceholderProfile($("profileText").value),
  },
  salary: { enter: enterSalary, collect: collectSalary, valid: validateSalary },
  rejects: { enter: () => enterKeywords("hardRejects"), collect: () => collectKeywords("hardRejects"), valid: () => true },
  warnings: { enter: () => enterKeywords("softWarnings"), collect: () => collectKeywords("softWarnings"), valid: () => true },
  flags: { enter: enterFlags, collect: collectFlags, valid: () => true },
  review: { enter: enterReview, valid: () => true },
};

function collectCurrent() {
  const hooks = STEP_HOOKS[currentKey()];
  if (hooks && hooks.collect) hooks.collect();
}

function canVisit(index) {
  // A new profile doesn't exist until it has a name, so nothing past About
  // can be opened before then.
  if (!state.persisted && index > stepIndex("about")) return false;
  return index <= state.furthest;
}

function renderRail() {
  const rail = $("rail");
  rail.innerHTML = "";
  state.steps.forEach((step, i) => {
    const li = el("li");
    // Once finished, the rail is a record of what was done, not navigation:
    // the steps are behind the done screen.
    if (state.finished) li.classList.add("done");
    else if (i === state.index) li.classList.add("current");
    else if (i < state.furthest || (i <= state.furthest && !state.profile.setupIncomplete)) li.classList.add("done");
    if (!canVisit(i)) li.classList.add("locked");
    const button = el("button");
    button.type = "button";
    button.disabled = state.finished || !canVisit(i) || i === state.index;
    const num = el("span", "num", li.classList.contains("done") ? "✓" : String(i + 1));
    button.appendChild(num);
    button.appendChild(document.createTextNode(step.title));
    button.addEventListener("click", () => goTo(i));
    li.appendChild(button);
    rail.appendChild(li);
  });
  $("mobileLabel").textContent = `Step ${state.index + 1} of ${state.steps.length} · ${state.steps[state.index].title}`;
  $("mobileBar").style.width = `${((state.index + 1) / state.steps.length) * 100}%`;
}

function updateNav() {
  const key = currentKey();
  const valid = STEP_HOOKS[key].valid();
  const next = $("next");
  next.disabled = !valid;
  if (key === "welcome") next.textContent = "Get started";
  else if (key === "review") next.textContent = state.profile.setupIncomplete ? "Finish setup" : "Done";
  else if (state.returnToReview) next.textContent = "Back to review";
  else next.textContent = "Next";
  $("back").hidden = state.index === 0;
  // Only the model can be skipped: everything after it that uses the model
  // explains itself when it isn't there, whereas a blank name or CV would
  // make the profile useless.
  $("skip").hidden = !(key === "model" && !valid);
}

function focusStep(section) {
  const target = Array.from(section.querySelectorAll('input[type="text"], textarea')).find(
    (node) => node.offsetParent !== null
  );
  (target || $("next")).focus({ preventScroll: true });
  // The seed name on a fresh install is a placeholder: typing replaces it.
  if (target && target.id === "profileName" && target.value === JOB_FIT_DEFAULTS.seedProfileName) target.select();
}

async function goTo(index, { returnToReview = false } = {}) {
  if (index < 0 || index >= state.steps.length) return;
  if (state.steps[state.index] && document.querySelector(`.step[data-step="${currentKey()}"]:not([hidden])`)) {
    await saveNow();
  }
  state.index = index;
  state.returnToReview = returnToReview;
  state.furthest = Math.max(state.furthest, index);

  const key = currentKey();
  document.querySelectorAll(".step").forEach((section) => (section.hidden = section.dataset.step !== key));
  const section = document.querySelector(`.step[data-step="${key}"]`);
  window.scrollTo({ top: 0 });

  // Enter before the nav is updated: each step's validity check reads fields
  // its enter hook fills in (the salary rows don't exist before the first visit).
  const hooks = STEP_HOOKS[key];
  const entering = hooks.enter ? hooks.enter() : null;
  renderRail();
  updateNav();
  focusStep(section);
  await entering;
  if (currentKey() === key) updateNav();
  saveProgress();
}

async function next() {
  const key = currentKey();
  if (!STEP_HOOKS[key].valid()) return;
  collectCurrent();

  // The moment a new profile gets its name, it becomes real: saved, active,
  // and resumable from the popup if this tab is closed.
  if (key === "about" && !state.persisted) {
    try {
      await saveProfile({ activate: true });
    } catch (err) {
      setSaveState(`Couldn't save: ${err.message}`, true);
      return;
    }
  }

  if (key === "review") {
    await finish();
    return;
  }
  const target = state.returnToReview ? stepIndex("review") : state.index + 1;
  await goTo(target);
}

async function finish() {
  state.profile.setupIncomplete = false;
  try {
    await saveNow();
    await saveProfile({ activate: state.mode !== "edit" });
    await clearProgress();
  } catch (err) {
    setSaveState(`Couldn't save: ${err.message}`, true);
    return;
  }
  $("card").hidden = true;
  $("nav").hidden = true;
  $("done").hidden = false;
  $("doneName").textContent = `"${state.profile.name}" is ready.`;
  $("doneModelWarn").hidden = Boolean(activeModel());
  state.furthest = state.steps.length - 1;
  state.finished = true;
  renderRail();
  $("doneClose").focus();
}

async function closeTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab && tab.id != null) chrome.tabs.remove(tab.id);
  else window.close();
}

// --- startup ---------------------------------------------------------------

function showFatal(message) {
  $("fatal").hidden = false;
  $("fatal").textContent = message;
  $("card").hidden = true;
  $("nav").hidden = true;
}

async function init() {
  const store = await JOB_FIT_PROFILES.load();
  const stored = await chrome.storage.local.get([...JOB_FIT_PROVIDER.KEYS, "wizardProgress"]);
  state.lm = { ...JOB_FIT_DEFAULTS.lmStudio, ...(stored.lmStudio || {}) };
  state.oa = { ...JOB_FIT_DEFAULTS.openai, ...(stored.openai || {}) };
  state.provider = stored.modelProvider === "openai" ? "openai" : "lmstudio";

  let mode = params.get("mode");
  const profileId = params.get("profile");

  if (mode === "new" && !profileId) {
    state.profile = JOB_FIT_PROFILES.blankProfile("");
    // blankProfile falls back to "New profile"; the name box should start
    // empty so the profile gets a real name, not a placeholder you forgot.
    state.profile.name = "";
    state.profile.setupIncomplete = true;
    state.persisted = false;
  } else {
    const wanted = profileId || store.activeProfileId;
    state.profile = store.profiles.find((p) => p.id === wanted);
    if (!state.profile) {
      showFatal("That profile doesn't exist any more. It may have been deleted. Close this tab and open the wizard again from the JobFit popup.");
      return;
    }
    state.persisted = true;
  }

  // An unfinished profile always resumes where it stopped, whichever button
  // opened the wizard, in the mode it was started in.
  const progress = (stored.wizardProgress || {})[state.profile.id];
  if (state.persisted && state.profile.setupIncomplete && progress) mode = progress.mode;
  if (!["install", "new", "edit"].includes(mode)) mode = state.profile.setupIncomplete ? "new" : "edit";
  state.mode = mode;

  state.steps = ALL_STEPS.filter((s) => s.key !== "welcome" || mode === "install");
  document.title = mode === "edit" ? `Setup: ${state.profile.name} — JobFit` : "Set up JobFit";
  $("railSub").textContent =
    mode === "install" ? "First-time setup" : mode === "new" ? "New profile" : `Editing "${state.profile.name}"`;

  let start = 0;
  if (state.persisted && state.profile.setupIncomplete && progress) {
    start = Math.min(progress.step || 0, state.steps.length - 1);
    state.furthest = Math.min(Math.max(progress.furthest || 0, start), state.steps.length - 1);
  } else if (!state.profile.setupIncomplete) {
    // A finished profile opened from settings: every step is open to jump to.
    state.furthest = state.steps.length - 1;
  }
  await goTo(start);
}

// --- wiring ----------------------------------------------------------------

const NOT_SETTINGS = new Set(["cvText", "testPosting", "flagInput"]);

$("card").addEventListener("input", (e) => {
  if (NOT_SETTINGS.has(e.target.id)) return;
  if (e.target.id === "profileText") renderProfileMeter();
  if (e.target.closest("#salaryRows")) validateSalary();
  collectCurrent();
  scheduleSave();
  updateNav();
});

$("card").addEventListener("change", (e) => {
  if (NOT_SETTINGS.has(e.target.id)) return;
  const group = e.target.closest(".choices");
  if (group && e.target.checked) applyAnswer(group.dataset.answer, e.target.value);
  if (e.target.closest("#markets")) syncSalaryRows();
  if (e.target.name === "lmModel") {
    state.modelDirty = true;
    if (state.provider === "openai") {
      state.oa.model = e.target.value;
      renderOaReasoning();
    }
  }
  if (e.target.id === "lmUrl" || e.target.id === "oaKey") testConnection();
  // Switching provider re-tests against the new one straight away; with no
  // key yet, that just asks for one.
  if (e.target.name === "provider") {
    collectModel();
    state.provider = e.target.value === "openai" ? "openai" : "lmstudio";
    state.modelDirty = true;
    // The list still shows the other provider's models; cleared before the
    // re-test reads the ticked one, or an LM Studio model name would be saved
    // as the OpenAI model.
    $("modelList").innerHTML = "";
    $("modelPicker").hidden = true;
    showProviderFields();
    testConnection();
    if (state.provider === "openai" && !state.oa.apiKey) $("oaKey").focus();
  }
  collectCurrent();
  scheduleSave();
  updateNav();
});

$("next").addEventListener("click", next);
$("back").addEventListener("click", () => goTo(state.returnToReview ? stepIndex("review") : state.index - 1));
$("skip").addEventListener("click", () => goTo(state.index + 1));
$("testConnection").addEventListener("click", testConnection);
$("testOpenAi").addEventListener("click", testConnection);
$("modelChange").addEventListener("click", () => {
  state.modelExpanded = true;
  $("modelCompact").hidden = true;
  $("modelFull").hidden = false;
  $("lmUrl").focus();
});
$("tabCv").addEventListener("click", () => showProfileTab("cv"));
$("tabEdit").addEventListener("click", () => showProfileTab("edit"));
$("skipToEdit").addEventListener("click", () => {
  showProfileTab("edit");
  $("profileText").focus();
});
$("draftProfile").addEventListener("click", draftProfile);
$("suggestSalary").addEventListener("click", suggestSalary);
$("suggestFlags").addEventListener("click", suggestFlags);
$("addAllFlags").addEventListener("click", () => addFlags(state.flagSuggestions));
$("runTest").addEventListener("click", runTest);
$("openRestore").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html") }));
$("doneClose").addEventListener("click", closeTab);
$("doneHistory").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html?profile=${encodeURIComponent(state.profile.id)}`) })
);
$("doneFixModel").addEventListener("click", () => {
  state.finished = false;
  $("done").hidden = true;
  $("card").hidden = false;
  $("nav").hidden = false;
  state.modelExpanded = true;
  goTo(stepIndex("model"), { returnToReview: true });
});

// Enter adds the typed term; a paste of a comma- or newline-separated list adds
// each one; Backspace in an empty box removes the last chip.
$("flagInput").addEventListener("keydown", (e) => {
  const input = e.target;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    e.stopPropagation();
    if (input.value.trim()) {
      addFlags([input.value]);
      input.value = "";
    }
  } else if (e.key === "Backspace" && !input.value && flagPhrases().length) {
    removeFlag(flagPhrases()[flagPhrases().length - 1]);
  }
});
$("flagInput").addEventListener("paste", (e) => {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!/[\n,]/.test(text)) return;
  e.preventDefault();
  addFlags(text.split(/[\n,]/));
});
$("flagChips").addEventListener("click", (e) => {
  if (e.target === $("flagChips")) $("flagInput").focus();
});

// Enter moves on from any single-line field; Esc folds away an open
// Advanced section.
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    const t = e.target;
    const singleLine = t.tagName === "INPUT" && ["text", "number", "radio", "checkbox"].includes(t.type);
    if (singleLine && t.id !== "flagInput" && !$("next").disabled && !$("nav").hidden) {
      e.preventDefault();
      next();
    }
  }
  if (e.key === "Escape") {
    document.querySelectorAll("details.advanced[open]").forEach((d) => (d.open = false));
  }
});

// The tab can be closed inside the debounce window.
window.addEventListener("pagehide", () => saveNow());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
});

init();
