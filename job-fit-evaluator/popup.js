const els = {
  profileSelect: document.getElementById("profileSelect"),
  profileNameRow: document.getElementById("profileNameRow"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileHint: document.getElementById("profileHint"),
  lmStudioUrl: document.getElementById("lmStudioUrl"),
  lmStudioModel: document.getElementById("lmStudioModel"),
  lmStudioTimeout: document.getElementById("lmStudioTimeout"),
  lmStudioReasoningEffort: document.getElementById("lmStudioReasoningEffort"),
  lmStudioEnableThinking: document.getElementById("lmStudioEnableThinking"),
  modelProvider: document.getElementById("modelProvider"),
  openAiKey: document.getElementById("openAiKey"),
  openAiModel: document.getElementById("openAiModel"),
  openAiTier: document.getElementById("openAiTier"),
  openAiFlex: document.getElementById("openAiFlex"),
  openAiReasoningEffort: document.getElementById("openAiReasoningEffort"),
  openAiMaxOutput: document.getElementById("openAiMaxOutput"),
  openAiBudget: document.getElementById("openAiBudget"),
  profile: document.getElementById("profile"),
  salaryUsdMin: document.getElementById("salaryUsdMin"),
  salaryUsdMax: document.getElementById("salaryUsdMax"),
  salaryCadMin: document.getElementById("salaryCadMin"),
  salaryCadMax: document.getElementById("salaryCadMax"),
  salaryMxnMin: document.getElementById("salaryMxnMin"),
  salaryMxnMax: document.getElementById("salaryMxnMax"),
  hardRejectsPresets: document.getElementById("hardRejectsPresets"),
  hardRejectsPhrases: document.getElementById("hardRejectsPhrases"),
  hardRejectsPatterns: document.getElementById("hardRejectsPatterns"),
  softWarningsPresets: document.getElementById("softWarningsPresets"),
  softWarningsPhrases: document.getElementById("softWarningsPhrases"),
  softWarningsPatterns: document.getElementById("softWarningsPatterns"),
  domainFlagsPhrases: document.getElementById("domainFlagsPhrases"),
  domainFlagsPatterns: document.getElementById("domainFlagsPatterns"),
  status: document.getElementById("status"),
};

const SALARY_CURRENCIES = ["USD", "CAD", "MXN"];

function salaryFieldsFor(currency) {
  const key = currency.charAt(0) + currency.slice(1).toLowerCase();
  return { min: els[`salary${key}Min`], max: els[`salary${key}Max`] };
}

function linesToArray(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function arrayToLines(arr) {
  return (arr || []).join("\n");
}

let statusTimer = null;

function setStatus(text, { persist = false } = {}) {
  els.status.textContent = text;
  clearTimeout(statusTimer);
  // Errors stay put: a message that clears itself after two seconds is no use
  // for explaining why a button did nothing.
  if (!persist) statusTimer = setTimeout(() => (els.status.textContent = ""), 2000);
}

// The whole profile store, held in memory while the popup is open so
// switching profiles doesn't need a storage round trip per keystroke.
let store = { profiles: [], activeProfileId: null };
// Which profile the form fields currently belong to. Needed because a switch
// has to write the form back to the OUTGOING profile, not the incoming one.
let formProfileId = null;
function activeProfile() {
  return store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
}

function renderProfileSelect() {
  els.profileSelect.innerHTML = "";
  store.profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    els.profileSelect.appendChild(opt);
  });
  // No guard needed around this: assigning .value never fires a change event,
  // so the switch handler can't see a programmatic repopulation.
  els.profileSelect.value = store.activeProfileId;
}

const KEYWORD_KINDS = ["hardRejects", "softWarnings", "domainFlags"];
const ADVANCED_SECTION_ID = {
  hardRejects: "adv-hardrejects",
  softWarnings: "adv-warnings",
  domainFlags: "adv-domainflags",
};

// Generated from the preset definitions rather than written into the HTML, so
// the two can't drift apart when a category is added.
function renderPresetCheckboxes() {
  KEYWORD_KINDS.forEach((kind) => {
    const host = els[`${kind}Presets`];
    if (!host) return;
    host.innerHTML = "";
    JOB_FIT_KEYWORDS.presetsFor(kind).forEach((preset) => {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = preset.id;
      row.appendChild(box);
      row.appendChild(document.createTextNode(preset.label));
      host.appendChild(row);
    });
  });
}

function keywordConfigFromForm(kind) {
  const host = els[`${kind}Presets`];
  const presets = host
    ? Array.from(host.querySelectorAll("input[type=checkbox]"))
        .filter((box) => box.checked)
        .map((box) => box.value)
    : [];
  return {
    presets,
    phrases: linesToArray(els[`${kind}Phrases`].value),
    patterns: linesToArray(els[`${kind}Patterns`].value),
  };
}

function fillKeywordConfig(kind, config) {
  const resolved = JOB_FIT_KEYWORDS.normalizeConfig(config, kind);
  const host = els[`${kind}Presets`];
  if (host) {
    host.querySelectorAll("input[type=checkbox]").forEach((box) => {
      box.checked = resolved.presets.includes(box.value);
    });
  }
  els[`${kind}Phrases`].value = arrayToLines(resolved.phrases);
  els[`${kind}Patterns`].value = arrayToLines(resolved.patterns);
  // Opened when it holds something, so a pattern carried over from the old
  // format isn't hidden where you can't see why a posting is being rejected.
  const advanced = document.getElementById(ADVANCED_SECTION_ID[kind]);
  if (advanced) advanced.open = resolved.patterns.length > 0;
}

// Reads the per-profile fields out of the form. Deliberately does not touch
// the LM Studio fields — those are global and saved separately.
function collectProfileFields() {
  const expectedSalary = {};
  SALARY_CURRENCIES.forEach((cur) => {
    const { min, max } = salaryFieldsFor(cur);
    expectedSalary[cur] = {
      min: min.value === "" ? null : Number(min.value),
      max: max.value === "" ? null : Number(max.value),
    };
  });
  return {
    profile: els.profile.value,
    keywords: {
      hardRejects: keywordConfigFromForm("hardRejects"),
      softWarnings: keywordConfigFromForm("softWarnings"),
      domainFlags: keywordConfigFromForm("domainFlags"),
    },
    expectedSalary,
  };
}

function fillFormFromProfile(profile) {
  els.profile.value = profile.profile;
  KEYWORD_KINDS.forEach((kind) => fillKeywordConfig(kind, profile.keywords[kind]));
  SALARY_CURRENCIES.forEach((cur) => {
    const range = profile.expectedSalary[cur] || { min: null, max: null };
    const { min, max } = salaryFieldsFor(cur);
    min.value = range.min ?? "";
    max.value = range.max ?? "";
  });
  formProfileId = profile.id;
  document.getElementById("salaryReasoning").textContent = "";
  applyForcedSections();
}

// Folds whatever is in the form back into the in-memory profile it came from.
// Called before switching away and before saving.
function captureForm() {
  const target = store.profiles.find((p) => p.id === formProfileId);
  if (!target) return;
  Object.assign(target, collectProfileFields());
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([...JOB_FIT_PROVIDER.KEYS, "uiOpenSections"]);
  const lmStudio = stored.lmStudio || JOB_FIT_DEFAULTS.lmStudio;
  const openai = { ...JOB_FIT_DEFAULTS.openai, ...(stored.openai || {}) };
  els.modelProvider.value = stored.modelProvider === "openai" ? "openai" : "lmstudio";
  els.openAiKey.value = openai.apiKey || "";
  els.openAiModel.value = openai.model || JOB_FIT_DEFAULTS.openai.model;
  els.openAiFlex.value = ["bulk", "always", "never"].includes(openai.flex) ? openai.flex : "bulk";
  renderTierOptions();
  els.openAiMaxOutput.value = openai.maxOutputTokens;
  els.openAiBudget.value = Number(openai.dailyTokenBudget) || "";
  // The saved effort, kept even while a model that doesn't take one is
  // selected, so switching back restores it.
  els.openAiReasoningEffort.dataset.saved = openai.reasoningEffort || "";
  renderReasoningOptions();
  showProviderFields();
  renderUsage();
  els.lmStudioUrl.value = lmStudio.url || JOB_FIT_DEFAULTS.lmStudio.url;
  els.lmStudioModel.value = lmStudio.model || "";
  els.lmStudioTimeout.value = lmStudio.timeoutSeconds || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
  els.lmStudioReasoningEffort.value = lmStudio.reasoningEffort ?? JOB_FIT_DEFAULTS.lmStudio.reasoningEffort;
  els.lmStudioEnableThinking.checked =
    typeof lmStudio.enableThinking === "boolean" ? lmStudio.enableThinking : JOB_FIT_DEFAULTS.lmStudio.enableThinking;

  renderPresetCheckboxes();
  watchSettingsFields();
  store = await JOB_FIT_PROFILES.load();
  renderProfileSelect();
  restoreOpenSections(stored.uiOpenSections);
  fillFormFromProfile(activeProfile());
}

// Chrome destroys the popup document the moment it loses focus, and nothing
// here was written until you pressed Save — so editing your CV and then
// clicking anything outside the popup lost the edit silently.
//
// Debounced rather than written on every keystroke, and short enough that the
// most you can lose is the last fraction of a second of typing. A blur flush
// is not enough on its own: the teardown does not wait for an async storage
// write to finish.
let autoSaveTimer = null;

function scheduleAutoSave() {
  captureForm();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    persistSettings().then(() => setStatus("Saved automatically."));
  }, 400);
}

function flushAutoSave() {
  clearTimeout(autoSaveTimer);
  captureForm();
  return persistSettings();
}

// The model settings as the form holds them. One builder for autosave and the
// Save button, which used to each spell the object out and could drift.
function modelSettingsFromForm() {
  return {
    modelProvider: els.modelProvider.value === "openai" ? "openai" : "lmstudio",
    lmStudio: {
      url: els.lmStudioUrl.value.trim() || JOB_FIT_DEFAULTS.lmStudio.url,
      model: els.lmStudioModel.value.trim(),
      timeoutSeconds:
        els.lmStudioTimeout.value === "" ? JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds : Number(els.lmStudioTimeout.value),
      reasoningEffort: els.lmStudioReasoningEffort.value,
      enableThinking: els.lmStudioEnableThinking.checked,
    },
    openai: {
      apiKey: els.openAiKey.value.trim(),
      model: selectedOpenAiModel(),
      flex: els.openAiFlex.value,
      reasoningEffort: document.getElementById("openAiReasoningSection").hidden
        ? els.openAiReasoningEffort.dataset.saved || ""
        : els.openAiReasoningEffort.value,
      maxOutputTokens: JOB_FIT_PROVIDER.clampOutputTokens(els.openAiMaxOutput.value),
      dailyTokenBudget: Math.max(0, Number(els.openAiBudget.value) || 0),
    },
  };
}

async function persistSettings() {
  await chrome.storage.local.set(modelSettingsFromForm());
  await JOB_FIT_PROFILES.save(store);
}

// Only the effort levels this model accepts, and the field only for models
// that take one at all: a value the model rejects fails the whole request.
// Tiers first, a custom model id only when asked for. `available` is the
// key's model list once known, so a tier the key can't use is greyed out.
let availableOpenAiModels = null;

function renderTierOptions() {
  const select = els.openAiTier;
  const current = els.openAiModel.value.trim();
  select.innerHTML = "";
  (JOB_FIT_DEFAULTS.openaiTiers || []).forEach((tier) => {
    const opt = document.createElement("option");
    opt.value = tier.id;
    const cost = JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier));
    const missing = availableOpenAiModels && !availableOpenAiModels.includes(tier.model);
    opt.textContent = `${tier.label} — ${tier.model}${missing ? " (not on this key)" : ` · ≈ ${cost} per 100 jobs`}`;
    opt.disabled = Boolean(missing);
    select.appendChild(opt);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom model…";
  select.appendChild(custom);
  const tier = JOB_FIT_PROVIDER.tierForModel(current);
  select.value = tier ? tier.id : "custom";
  syncTierHint();
}

function syncTierHint() {
  const tier = (JOB_FIT_DEFAULTS.openaiTiers || []).find((t) => t.id === els.openAiTier.value);
  document.getElementById("openAiCustomRow").hidden = Boolean(tier);
  const hint = document.getElementById("openAiTierHint");
  if (!tier) {
    hint.textContent = "Any chat model your key has. Its cost isn't estimated here.";
    return;
  }
  const flex = JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier, "flex"));
  hint.textContent = `${tier.blurb} About ${flex} per 100 with Flex.`;
}

function selectedOpenAiModel() {
  const tier = (JOB_FIT_DEFAULTS.openaiTiers || []).find((t) => t.id === els.openAiTier.value);
  return tier ? tier.model : els.openAiModel.value.trim();
}

function renderReasoningOptions() {
  const select = els.openAiReasoningEffort;
  const allowed = JOB_FIT_PROVIDER.reasoningEffortsFor(selectedOpenAiModel());
  const wanted = select.dataset.saved ?? select.value ?? "";
  document.getElementById("openAiReasoningSection").hidden = !allowed.length;
  select.innerHTML = "";
  if (!allowed.length) return;
  ["", ...allowed].forEach((value) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value || "(model default)";
    select.appendChild(opt);
  });
  select.value = JOB_FIT_PROVIDER.effectiveReasoningEffort(selectedOpenAiModel(), wanted);
}

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// Today's and this month's OpenAI tokens beside the budget field, plus what
// the budget comes to in requests at the current average — a token budget
// means nothing until it's translated into evaluations.
async function renderUsage() {
  const host = document.getElementById("openAiUsage");
  const days = (await chrome.storage.local.get("usageByDay")).usageByDay || {};
  const today = JOB_FIT_PROVIDER.dayKey();
  const month = today.slice(0, 7);
  const sum = (filter) =>
    Object.entries(days)
      .filter(([day]) => filter(day))
      .reduce(
        (acc, [, d]) => {
          const t = d.openai;
          if (t) {
            acc.requests += t.requests;
            acc.tokens += t.input + t.output;
          }
          return acc;
        },
        { requests: 0, tokens: 0 }
      );
  const t = sum((d) => d === today);
  const m = sum((d) => d.startsWith(month));
  if (!m.requests) {
    host.textContent = "Blank for no limit. Usage shows here once you've run some requests.";
    return;
  }
  const avg = Math.round(m.tokens / m.requests);
  const budget = Number(els.openAiBudget.value) || 0;
  host.textContent =
    `Today: ${t.requests} request${t.requests === 1 ? "" : "s"}, ${formatTokens(t.tokens)} tokens · ` +
    `this month: ${formatTokens(m.tokens)} · about ${formatTokens(avg)} per request` +
    (budget ? ` — this budget allows roughly ${Math.floor(budget / avg)} a day.` : ". Blank budget = no limit.");
}

function showProviderFields() {
  const openai = els.modelProvider.value === "openai";
  document.getElementById("lmStudioFields").hidden = openai;
  document.getElementById("openAiFields").hidden = !openai;
}

// Fills the model suggestions from the account's own model list, so the name
// is picked rather than typed from memory.
async function loadOpenAiModels() {
  const key = els.openAiKey.value.trim();
  if (!key) return;
  const probe = await probeModels({ provider: "openai", apiKey: key });
  const list = document.getElementById("openAiModelList");
  list.innerHTML = "";
  if (!probe.ok) return;
  availableOpenAiModels = probe.models;
  renderTierOptions();
  probe.models.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    list.appendChild(opt);
  });
}

// Every field that belongs to a profile or to the LM Studio settings. The
// profile selector, the rename box and the summary output are deliberately
// excluded — they are not settings.
function watchSettingsFields() {
  const fields = [
    els.profile, els.lmStudioUrl, els.lmStudioModel, els.lmStudioTimeout,
    els.lmStudioReasoningEffort, els.lmStudioEnableThinking,
    els.modelProvider, els.openAiKey, els.openAiModel, els.openAiReasoningEffort,
    els.openAiMaxOutput, els.openAiBudget, els.openAiFlex,
    els.hardRejectsPhrases, els.hardRejectsPatterns,
    els.softWarningsPhrases, els.softWarningsPatterns,
    els.domainFlagsPhrases, els.domainFlagsPatterns,
    ...SALARY_CURRENCIES.flatMap((cur) => {
      const { min, max } = salaryFieldsFor(cur);
      return [min, max];
    }),
  ].filter(Boolean);

  fields.forEach((field) => {
    field.addEventListener("input", scheduleAutoSave);
    field.addEventListener("change", flushAutoSave);
  });

  // Preset checkboxes are rebuilt on every render, so delegate to the container.
  KEYWORD_KINDS.forEach((kind) => {
    const host = els[`${kind}Presets`];
    if (host) host.addEventListener("change", flushAutoSave);
  });
}

async function saveSettings() {
  captureForm();
  await chrome.storage.local.set(modelSettingsFromForm());
  await JOB_FIT_PROFILES.save(store);
  setStatus(`Saved "${activeProfile().name}".`);
}

// Last line of defence. Not relied on — an async write started here may not
// finish before the document is torn down — but it costs nothing and catches
// an edit made inside the debounce window.
function flushOnHide() {
  if (document.visibilityState === "hidden") flushAutoSave();
}

// Switching auto-saves the outgoing profile rather than warning about unsaved
// edits — the popup is transient enough that a "discard changes?" prompt would
// fire constantly, and a half-typed regex persisted is harmless and editable.
async function switchProfile(id) {
  captureForm();
  await JOB_FIT_PROFILES.save(store);
  store.activeProfileId = id;
  await JOB_FIT_PROFILES.save(store);
  fillFormFromProfile(activeProfile());
  setStatus(`Switched to "${activeProfile().name}".`);
}

// Name entry is inline rather than window.prompt(): a modal dialog in an
// extension popup can dismiss the popup itself, losing the form with it.
let pendingNameAction = null;

function askForName(action, initialValue) {
  pendingNameAction = action;
  els.profileNameInput.value = initialValue || "";
  els.profileNameRow.hidden = false;
  els.profileNameInput.focus();
  els.profileNameInput.select();
}

function cancelNamePrompt() {
  pendingNameAction = null;
  els.profileNameRow.hidden = true;
  els.profileNameInput.value = "";
}

async function confirmNamePrompt() {
  const name = els.profileNameInput.value.trim();
  const action = pendingNameAction;
  if (!action) return;
  if (!name) {
    els.profileHint.textContent = "Give the profile a name.";
    return;
  }

  captureForm();

  if (action === "rename") {
    activeProfile().name = name;
  } else {
    const created = Object.assign(JOB_FIT_PROFILES.clone(activeProfile()), { id: JOB_FIT_PROFILES.newId(), name });
    store.profiles.push(created);
    store.activeProfileId = created.id;
  }

  await JOB_FIT_PROFILES.save(store);
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  cancelNamePrompt();
  els.profileHint.textContent = "";
  setStatus(action === "rename" ? "Renamed." : `Created "${name}".`);
}

// Two-step rather than confirm(), same popup-dismissal reason as above.
let deleteArmed = false;

async function deleteProfile() {
  const btn = document.getElementById("profileDelete");
  if (store.profiles.length < 2) {
    els.profileHint.textContent = "Can't delete the only profile.";
    return;
  }

  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = "Sure?";
    // The tracked-job count goes in the warning because those records are
    // deleted too, and that's the part you can't get back — the profile
    // itself is a minute of retyping.
    const tracked = await JOB_FIT_EVALSTORE.countForProfile(store.activeProfileId);
    const jobsNote = tracked
      ? ` and its ${tracked} tracked job${tracked === 1 ? "" : "s"} (evaluations, briefs, notes and application status)`
      : "";
    els.profileHint.textContent = `Click again to delete "${activeProfile().name}"${jobsNote}.`;
    setTimeout(() => {
      deleteArmed = false;
      btn.textContent = "Delete";
      if (els.profileHint.textContent.startsWith("Click again")) els.profileHint.textContent = "";
    }, 6000);
    return;
  }

  deleteArmed = false;
  btn.textContent = "Delete";
  const removed = activeProfile().name;
  const removedId = store.activeProfileId;

  // Records first: if this throws, the profile stays and the records are still
  // reachable. The other order would strand them permanently.
  let removedJobs = 0;
  try {
    removedJobs = await JOB_FIT_EVALSTORE.removeAllForProfile(removedId);
  } catch (err) {
    els.profileHint.textContent = `Couldn't delete that profile's jobs: ${err.message}`;
    return;
  }

  store.profiles = store.profiles.filter((p) => p.id !== removedId);
  store.activeProfileId = store.profiles[0].id;
  await JOB_FIT_PROFILES.save(store);
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  els.profileHint.textContent = "";
  setStatus(removedJobs ? `Deleted "${removed}" and ${removedJobs} tracked jobs.` : `Deleted "${removed}".`);
}

// Only the reject/warning lists. The candidate text can't be reset to a
// default that means anything once profiles exist (restoring one person's CV
// into another person's profile is nonsense), and domain flags are per-person
// by construction.
function resetKeywordLists() {
  fillKeywordConfig("hardRejects", JOB_FIT_DEFAULTS.keywords.hardRejects);
  fillKeywordConfig("softWarnings", JOB_FIT_DEFAULTS.keywords.softWarnings);
  setStatus("Reject and warning categories restored (not yet saved).");
}

// The popup document is destroyed whenever it loses focus, so a <details> the
// user opened would collapse again on every reopen. Persist the state instead.
const SECTION_IDS = [
  "sec-profilemanage",
  "sec-shortcuts",
  "sec-profile",
  "sec-lmstudio",
  "sec-salary",
  "sec-hardrejects",
  "sec-warnings",
  "sec-domainflags",
];

function restoreOpenSections(saved) {
  const state = saved || {};
  SECTION_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.open = Boolean(state[id]);
  });
}

// Collapsed-by-default is right until a section holds the field you can't get
// anywhere without — an unconfigured model name, or a profile with no CV text
// yet (which is every profile the moment after you create it). Opening those
// beats making someone hunt for why nothing works.
function applyForcedSections() {
  renderSetupBanner();
  // An unfinished wizard profile gets the banner instead: the wizard is the
  // better place to finish, and opening sections underneath it would compete.
  if (activeProfile() && activeProfile().setupIncomplete) return;
  const modelMissing = els.modelProvider.value === "openai" ? !selectedOpenAiModel() : !els.lmStudioModel.value.trim();
  if (modelMissing) document.getElementById("sec-lmstudio").open = true;
  if (!els.profile.value.trim()) document.getElementById("sec-profile").open = true;
}

function renderSetupBanner() {
  const banner = document.getElementById("setupBanner");
  const profile = activeProfile();
  banner.hidden = !(profile && profile.setupIncomplete);
  if (!banner.hidden) document.getElementById("setupBannerName").textContent = profile.name;
}

function persistOpenSections() {
  const state = {};
  SECTION_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) state[id] = el.open;
  });
  chrome.storage.local.set({ uiOpenSections: state });
}

// --- shortcuts ---------------------------------------------------------------

// Shows the shortcut Chrome actually assigned, which may differ from the
// suggested one (another extension had it, or you changed it). Formatted by
// Chrome for the platform, e.g. "⇧⌘E" on a Mac and "Alt+Shift+E" elsewhere.
async function renderShortcuts() {
  let shortcut = "";
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "evaluate-tab");
    shortcut = (cmd && cmd.shortcut) || "";
  } catch (err) {
    /* commands API unavailable */
  }
  document.getElementById("shortcutKey").textContent = shortcut || "not set";
  document.getElementById("evaluateTip").textContent = shortcut
    ? `Tip: press ${shortcut} on any posting to evaluate it without opening this panel.`
    : "Tip: set a keyboard shortcut under Shortcuts to evaluate without opening this panel.";
}

// --- readiness -------------------------------------------------------------

function setReady(dotId, textId, state, text, title) {
  const dot = document.getElementById(dotId);
  dot.className = `dot ${state}`;
  const label = document.getElementById(textId);
  label.textContent = text;
  label.title = title || "";
}

async function checkModel() {
  const settings = await JOB_FIT_PROVIDER.load();
  const wanted = settings.model;
  const probe = await probeModels(settings);

  if (settings.provider === "openai") {
    if (probe.reason === "no-key") {
      setReady("modelDot", "modelState", "bad", "OpenAI is selected but no API key is set.");
    } else if (probe.reason === "unauthorized") {
      setReady("modelDot", "modelState", "bad", "OpenAI rejected the API key — check it under Model.");
    } else if (!probe.ok) {
      setReady("modelDot", "modelState", "bad", "Couldn't reach OpenAI — check the connection.");
    } else if (!wanted) {
      setReady("modelDot", "modelState", "warn", "OpenAI connected — pick a model under Model.");
    } else if (probe.models.length && !probe.models.includes(wanted)) {
      setReady("modelDot", "modelState", "warn", `"${wanted}" isn't available on this OpenAI account.`, probe.models.join("\n"));
    } else {
      setReady("modelDot", "modelState", "ok", `OpenAI — ${wanted}`);
    }
    return;
  }

  if (probe.reason === "invalid-url") {
    setReady("modelDot", "modelState", "bad", "The endpoint isn't a valid URL.");
    return;
  }
  if (!probe.ok) {
    setReady("modelDot", "modelState", "bad", "LM Studio isn't reachable — start it and reopen this popup.", probe.url);
    return;
  }

  const loaded = probe.models;

  if (!wanted) {
    setReady("modelDot", "modelState", "ok", `Connected — using ${loaded[0] || "whatever is loaded"}`, loaded.join("\n"));
    return;
  }
  // A model name that isn't loaded is the cause of the HTTP error that pauses
  // the whole queue — worth catching here rather than after you've queued ten.
  if (loaded.length && !loaded.includes(wanted)) {
    setReady("modelDot", "modelState", "warn", `"${wanted}" isn't loaded in LM Studio.`, `Loaded:\n${loaded.join("\n")}`);
    return;
  }
  setReady("modelDot", "modelState", "ok", `Connected — ${wanted}`);
}

// Deliberately a cheap selector probe rather than running the extractors: it
// only has to say whether this page is worth clicking Evaluate on.
function probePage() {
  const hasEmbeddedBoard = Array.from(document.querySelectorAll("iframe[src]")).some((frame) => {
    try {
      const url = new URL(frame.src, location.href);
      return url.hostname.endsWith("greenhouse.io") && url.pathname.includes("/embed/");
    } catch (err) {
      return false;
    }
  });
  return {
    host: location.hostname,
    linkedin: Boolean(document.querySelector('[data-testid="expandable-text-box"]')),
    greenhouse: Boolean(document.querySelector(".job__description, .application-description")),
    embedded: hasEmbeddedBoard,
    jibe: Boolean(document.querySelector("descriptions-app #description-body")),
    eightfold: Boolean(document.querySelector("#pcsx #job-description-container")),
    indeed: location.hostname.includes("indeed.") && Boolean(document.querySelector("#jobDescriptionText, .simple-job-description-html")),
    workday: Boolean(document.querySelector('[data-automation-id="jobPostingDescription"]')),
  };
}

async function checkPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setReady("pageDot", "pageState", "warn", "No active tab.");
    return;
  }
  let probe;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
    probe = results && results[0] && results[0].result;
  } catch (err) {
    setReady("pageDot", "pageState", "bad", "Chrome won't let the extension read this page.");
    return;
  }
  if (!probe) {
    setReady("pageDot", "pageState", "warn", "Couldn't read this tab.");
    return;
  }

  if (probe.linkedin) setReady("pageDot", "pageState", "ok", "LinkedIn posting detected.");
  else if (probe.greenhouse) setReady("pageDot", "pageState", "ok", "Greenhouse posting detected.");
  else if (probe.embedded) setReady("pageDot", "pageState", "ok", "Embedded Greenhouse board detected.");
  else if (probe.indeed) setReady("pageDot", "pageState", "ok", "Indeed posting detected.");
  else if (probe.workday)setReady("pageDot", "pageState", "ok", "Workday posting detected.");
  else if (probe.jibe)setReady("pageDot", "pageState", "ok", "Jibe career-site posting detected.");
  else if (probe.eightfold) setReady("pageDot", "pageState", "ok", "Eightfold career-site posting detected.");
  else
    setReady(
      "pageDot",
      "pageState",
      "warn",
      "No known posting on this page — Evaluate will still try.",
      probe.host
    );
}

function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

// Shown directly under the timeout field, because that is the setting it
// informs: the number you need to choose a timeout, next to the box you type it
// into.
async function renderTimingHint() {
  const hint = document.getElementById("timingHint");
  const stored = await chrome.storage.local.get("evalStats");
  const durations = (stored.evalStats && stored.evalStats.durations) || [];
  if (!durations.length) {
    hint.textContent = "Tune this to your model's speed — timings appear here once you've run a few evaluations.";
    return;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[sorted.length - 1];
  hint.textContent =
    `Last ${durations.length} evaluation${durations.length === 1 ? "" : "s"}: ` +
    `median ${humanDuration(median)}, slowest ${humanDuration(slowest)}.`;
}

async function renderQueueStatus() {
  const box = document.getElementById("queueStatus");
  let snapshot;
  try {
    snapshot = await sendMessageWithRetry({ type: "JOB_FIT_QUEUE_SNAPSHOT" });
  } catch (err) {
    box.style.display = "none";
    return;
  }
  if (!snapshot || !snapshot.items) {
    box.style.display = "none";
    return;
  }

  const processing = snapshot.items.find((i) => i.state === "processing");
  const pending = snapshot.items.filter((i) => i.state === "pending").length;
  const failed = snapshot.items.filter((i) => i.state === "failed").length;

  if (!snapshot.active && !failed) {
    box.style.display = "none";
    return;
  }

  const parts = [];
  if (processing) parts.push(`Processing “${processing.title || "posting"}”`);
  if (pending) parts.push(`${pending} waiting`);
  if (failed) parts.push(`${failed} failed`);
  if (snapshot.state === "paused") parts.unshift("⏸ Queue paused");

  box.textContent = `${parts.join(" · ")} — see tracked jobs`;
  box.style.display = "block";
}

async function suggestSalary() {
  const btn = document.getElementById("suggestSalary");
  const reasoningEl = document.getElementById("salaryReasoning");

  // With no CV the model has nothing to reason from and returns a plausible
  // invented range, which is worse than no answer — you'd save it as your own
  // expectation and every salary comparison after that would be built on it.
  if (!els.profile.value.trim()) {
    reasoningEl.textContent = "Fill in the candidate profile first — with no CV the model just invents a range.";
    document.getElementById("sec-profile").open = true;
    els.profile.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = "…";
  reasoningEl.textContent = "";

  try {
    const response = await sendMessageWithRetry({
      type: "JOB_FIT_SUGGEST_SALARY",
      profile: els.profile.value,
    });

    if (!response || !response.ok) {
      reasoningEl.textContent = response?.error || "Could not get a suggestion.";
      return;
    }

    SALARY_CURRENCIES.forEach((cur) => {
      const range = response.data[cur];
      if (!range) return;
      const { min, max } = salaryFieldsFor(cur);
      if (range.min != null) min.value = range.min;
      if (range.max != null) max.value = range.max;
    });

    reasoningEl.textContent = response.data.reasoning
      ? `${response.data.reasoning} (review before saving)`
      : "Suggested — review before saving.";
  } catch (err) {
    reasoningEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Suggest all";
  }
}

async function evaluateCurrentTab() {
  // Guard against a double-click firing two concurrent evaluations (and two
  // concurrent LM Studio requests) before the popup has a chance to close.
  const btn = document.getElementById("evaluate");
  if (btn.disabled) return;
  btn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    btn.disabled = false;
    return;
  }
  const started = await startEvaluation(tab.id);
  if (!started.ok) {
    setStatus(started.error, { persist: true });
    btn.disabled = false;
    return;
  }
  window.close();
}

// Runs in the page (executeScript serializes it, so it can't call anything
// outside itself). Same order as content.js's pickExtractor: this used to try
// only Greenhouse and LinkedIn before the whole-page fallback, so a brief on
// Indeed, Workday, Jibe or Eightfold summarized the page chrome as well.
function extractOnPage() {
  const host = location.hostname;
  const jf = window.__jobFit || {};
  const chain = [
    jf.greenhouse,
    host.includes("linkedin.com") && jf.linkedin,
    host.includes("indeed.") && jf.indeed,
    jf.workday,
    jf.jibe,
    jf.eightfold,
    jf.generic,
  ];
  let extracted = null;
  for (const extract of chain) {
    if (typeof extract !== "function") continue;
    extracted = extract();
    if (extracted) break;
  }
  if (!extracted) return null;
  // Computed in the page, where location and the DOM are available, so the
  // popup can look this posting up in history.
  return { ...extracted, jobKey: JOB_FIT_JOBKEY.keyFor(extracted) };
}

async function summarizeCurrentTab() {
  const btn = document.getElementById("summarizeTab");
  const statusEl = document.getElementById("summarizeStatus");
  const resultEl = document.getElementById("summarizeResult");
  const copyBtn = document.getElementById("copySummary");

  btn.disabled = true;
  resultEl.hidden = true;
  copyBtn.hidden = true;
  statusEl.textContent = "Extracting…";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusEl.textContent = "No active tab.";
    btn.disabled = false;
    return;
  }
  const files = JOB_FIT_CONTENT_FILES;

  let extracted;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files
    });


    // Find cross-origin job board iframes (e.g. embedded Greenhouse on
    // custom-domain career sites). Targeted frameIds avoid the allFrames
    // rejection issue where one inaccessible ad iframe kills the whole call.
    const jobFrameIds = await injectJobFrames(tab.id, files, { withCss: false });

    // Extract from top frame
    const topResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractOnPage,
    });
    // .result unwraps the InjectionResult ({ frameId, result }) — find() returns
    // the wrapper, and the wrapper is truthy, so without this the downstream
    // `if (!extracted)` guard passes and the brief is queued with an undefined
    // posting body.
    extracted = topResults?.find((r) => r.result)?.result || null;

    // If a Greenhouse iframe exists, prefer its result. On a custom-domain
    // career site (e.g. Nuro) the top frame only has nav/footer/blog text;
    // the actual job posting lives in the iframe.
    if (jobFrameIds.length > 0) {
      const frameResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: jobFrameIds },
        func: extractOnPage,
      });
      const frameExtracted = frameResults?.find((r) => r.result)?.result || null;
      if (frameExtracted) extracted = frameExtracted;
    }
  } catch (err) {
    statusEl.textContent = injectionErrorMessage(err);
    btn.disabled = false;
    return;
  }

  if (!extracted) {
    statusEl.textContent = "Couldn't extract job posting text on this tab.";
    btn.disabled = false;
    return;
  }

  // Through the same single-flight lane as evaluations, so there is never more
  // than one request to LM Studio: two at once roughly halves the throughput
  // of both. Priority, so it runs before queued evaluations rather than behind
  // ten of them.
  const active = activeProfile();
  const requestedAt = Date.now();

  let response;
  try {
    response = await sendMessageWithRetry({
      type: "JOB_FIT_ENQUEUE",
      priority: true,
      tabId: tab.id,
      item: {
        kind: "summarize",
        jobKey: extracted.jobKey,
        profileId: active.id,
        profileName: active.name,
        postingText: extracted.text,
        title: extracted.title,
        company: extracted.company,
        location: extracted.location,
        url: tab.url,
      },
    });
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    btn.disabled = false;
    return;
  }

  if (!response || !response.ok) {
    statusEl.textContent = response?.full
      ? `The queue already holds ${response.max} jobs — let some finish first.`
      : response?.error || "Could not queue the summary.";
    btn.disabled = false;
    return;
  }

  statusEl.textContent =
    response.position > 1
      ? `Queued behind ${response.position - 1} job(s) — the brief is filed automatically, reopen this popup to collect it.`
      : "Summarizing with the local model…";

  const combinedText = await waitForSummary(tab.url, active.id, requestedAt);
  if (!combinedText) {
    statusEl.textContent =
      "Still running — the brief is filed against this job automatically, so reopen this popup in a moment to collect it.";
    btn.disabled = false;
    renderQueueStatus();
    return;
  }

  // Assembled by the service worker (header line, brief, and this profile's
  // evaluation block) so that a brief finishing while the popup is closed is
  // still complete and still filed. The popup only displays it.
  resultEl.value = combinedText;
  resultEl.hidden = false;
  copyBtn.hidden = false;

  try {
    await navigator.clipboard.writeText(combinedText);
    statusEl.textContent = combinedText.includes("LOCAL MODEL EVALUATION")
      ? `Copied (includes the "${active.name}" evaluation of this posting).`
      : "Copied to clipboard.";
  } catch (err) {
    statusEl.textContent = "Couldn't auto-copy — select the text below or click Copy.";
  }

  btn.disabled = false;
  renderQueueStatus();
}

// The brief is written to storage by the service worker when the queued item
// finishes. Poll for it while the popup happens to still be open; if the popup
// is gone by then nothing is lost, because restoreLastSummary() picks it up on
// the next open.
async function waitForSummary(url, profileId, since, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const stored = await chrome.storage.local.get("lastSummary");
    const summary = stored.lastSummary;
    if (summary && summary.url === url && summary.profileId === profileId && summary.ts >= since) {
      return summary.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

async function restoreLastSummary() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  const stored = await chrome.storage.local.get("lastSummary");
  const lastSummary = stored.lastSummary;
  if (!lastSummary || lastSummary.url !== tab.url || !lastSummary.text) return;
  // A summary built for another profile carries that profile's evaluation
  // block, so don't resurrect it under the current one.
  if (lastSummary.profileId && lastSummary.profileId !== activeProfile().id) return;

  document.getElementById("summarizeResult").value = lastSummary.text;
  document.getElementById("summarizeResult").hidden = false;
  document.getElementById("copySummary").hidden = false;
  document.getElementById("summarizeStatus").textContent = "Summary from earlier — click Copy to copy it again.";
}

async function copySummary() {
  const resultEl = document.getElementById("summarizeResult");
  const statusEl = document.getElementById("summarizeStatus");
  try {
    await navigator.clipboard.writeText(resultEl.value);
    statusEl.textContent = "Copied to clipboard.";
  } catch (err) {
    resultEl.focus();
    resultEl.select();
    statusEl.textContent = "Select-all done — copy manually (Cmd+C).";
  }
}

document.getElementById("save").addEventListener("click", saveSettings);
// chrome:// pages can't be linked to, but an extension can open one in a tab.
document.getElementById("changeShortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});
els.modelProvider.addEventListener("change", () => {
  showProviderFields();
  flushAutoSave().then(checkModel);
  if (els.modelProvider.value === "openai") loadOpenAiModels();
});
els.openAiKey.addEventListener("change", () => {
  loadOpenAiModels();
  flushAutoSave().then(checkModel);
});
els.openAiTier.addEventListener("change", () => {
  syncTierHint();
  if (els.openAiTier.value !== "custom") els.openAiModel.value = selectedOpenAiModel();
  else els.openAiModel.focus();
  renderReasoningOptions();
  flushAutoSave().then(checkModel);
});
els.openAiModel.addEventListener("change", () => {
  renderReasoningOptions();
  flushAutoSave().then(checkModel);
});
els.openAiModel.addEventListener("input", renderReasoningOptions);
els.openAiBudget.addEventListener("input", renderUsage);
// The preference is only what the user picks here, never the adjusted value a
// half-typed model name produced.
els.openAiReasoningEffort.addEventListener("change", () => {
  els.openAiReasoningEffort.dataset.saved = els.openAiReasoningEffort.value;
});
document.getElementById("reset").addEventListener("click", resetKeywordLists);
els.profileSelect.addEventListener("change", (e) => switchProfile(e.target.value));
// New profiles go through the setup wizard: a blank profile has no CV, no
// salary and no domain flags, and the wizard is what walks through filling them.
// Opened as a tab because the popup destroys itself the moment focus moves.
document.getElementById("profileNew").addEventListener("click", async () => {
  await flushAutoSave();
  openSetupWizard({ mode: "new" });
  window.close();
});
document.getElementById("profileWizard").addEventListener("click", async () => {
  await flushAutoSave();
  openSetupWizard({ mode: "edit", profile: activeProfile().id });
  window.close();
});
// Resumes where the wizard was left; the wizard reads its own saved progress.
document.getElementById("setupContinue").addEventListener("click", async () => {
  await flushAutoSave();
  openSetupWizard({ profile: activeProfile().id, resume: "1" });
  window.close();
});
document.getElementById("profileDuplicate").addEventListener("click", () =>
  askForName("duplicate", `${activeProfile().name} copy`)
);
document.getElementById("profileRename").addEventListener("click", () => askForName("rename", activeProfile().name));
document.getElementById("profileDelete").addEventListener("click", deleteProfile);
document.getElementById("profileNameOk").addEventListener("click", confirmNamePrompt);
document.getElementById("profileNameCancel").addEventListener("click", cancelNamePrompt);
els.profileNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmNamePrompt();
  if (e.key === "Escape") cancelNamePrompt();
});
SECTION_IDS.forEach((id) => document.getElementById(id)?.addEventListener("toggle", persistOpenSections));
document.getElementById("evaluate").addEventListener("click", evaluateCurrentTab);
document.getElementById("suggestSalary").addEventListener("click", suggestSalary);
document.getElementById("summarizeTab").addEventListener("click", summarizeCurrentTab);
document.getElementById("copySummary").addEventListener("click", copySummary);
// An extension page rather than a popup view: it needs room, and it keeps full
// chrome.storage access without the popup's habit of destroying itself on blur.
document.getElementById("viewHistory").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
});

// restoreLastSummary() reads the active profile, so it has to wait for the
// store to be in memory.
document.addEventListener("visibilitychange", flushOnHide);
window.addEventListener("pagehide", flushAutoSave);

renderShortcuts();
loadSettings().then(() => {
  restoreLastSummary();
  if (els.modelProvider.value === "openai") loadOpenAiModels();
});
renderQueueStatus();
checkModel();
checkPage();
renderTimingHint();
