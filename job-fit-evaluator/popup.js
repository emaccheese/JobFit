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
  salaryRows: document.getElementById("salaryRows"),
  salaryAdd: document.getElementById("salaryAdd"),
  uiLanguage: document.getElementById("uiLanguage"),
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

// --- salary ----------------------------------------------------------------
//
// One row per currency: the currencies of the profile's target countries,
// any that already hold figures, and any added with "+ Add a currency".
// Each row has its own pay period, because a Mexican salary is usually
// quoted per month and a US one per year.
let salaryCurrencies = [];

function salaryCurrenciesFor(profile) {
  const list = [];
  const add = (c) => c && !list.includes(c) && list.push(c);
  ((profile.jobSearch || {}).targetCountries || []).forEach((c) => add(JOB_FIT_GEO.currencyOf(c)));
  Object.entries(profile.expectedSalary || {}).forEach(([c, r]) => {
    if (r && (r.min != null || r.max != null)) add(c);
  });
  if (!list.length) ["USD", "CAD", "MXN"].forEach(add);
  return list;
}

// The country a currency is being used for: a target country that pays in
// it, else the first country that does.
function countryForCurrency(currency, profile) {
  const targets = ((profile && profile.jobSearch) || {}).targetCountries || [];
  return (
    targets.find((c) => JOB_FIT_GEO.currencyOf(c) === currency) ||
    JOB_FIT_GEO.CODES.find((c) => JOB_FIT_GEO.currencyOf(c) === currency) ||
    null
  );
}

function defaultPeriod(currency, profile) {
  const country = countryForCurrency(currency, profile);
  return country ? JOB_FIT_GEO.periodOf(country) : "year";
}

function salaryFieldsFor(currency) {
  const row = els.salaryRows.querySelector(`[data-currency="${currency}"]`);
  return row
    ? { min: row.querySelector(".sal-min"), max: row.querySelector(".sal-max"), period: row.querySelector(".sal-period") }
    : null;
}

function renderSalaryRows(profile) {
  els.salaryRows.innerHTML = "";
  salaryCurrencies.forEach((cur) => {
    const range = (profile.expectedSalary || {})[cur] || {};
    const row = document.createElement("div");
    row.className = "salary-row";
    row.dataset.currency = cur;
    const label = document.createElement("span");
    label.className = "currency-label";
    label.textContent = cur;
    row.appendChild(label);
    ["min", "max"].forEach((end) => {
      const input = document.createElement("input");
      input.type = "number";
      input.className = `sal-${end}`;
      input.placeholder = t(end === "min" ? "common.min" : "common.max");
      input.value = range[end] ?? "";
      row.appendChild(input);
    });
    const period = document.createElement("select");
    period.className = "sal-period";
    ["year", "month", "hour"].forEach((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = t(`period.${value}`);
      period.appendChild(opt);
    });
    period.value = range.period && (range.min != null || range.max != null) ? range.period : defaultPeriod(cur, profile);
    row.appendChild(period);
    els.salaryRows.appendChild(row);
  });
  renderSalaryAdd();
}

function renderSalaryAdd() {
  const select = els.salaryAdd;
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = t("popup.addCurrency");
  select.appendChild(first);
  const all = Array.from(new Set(JOB_FIT_GEO.CODES.map(JOB_FIT_GEO.currencyOf))).filter((c) => !salaryCurrencies.includes(c)).sort();
  all.forEach((cur) => {
    const opt = document.createElement("option");
    opt.value = cur;
    opt.textContent = cur;
    select.appendChild(opt);
  });
}

// A line under the profile picker: where this profile is looking, so it's
// clear which country rules apply. Edited in the setup wizard.
function renderSearchSummary(profile) {
  const host = document.getElementById("searchSummary");
  const js = profile.jobSearch || {};
  const targets = (js.targetCountries || []).map((c) => JOB_FIT_I18N.countryName(c));
  const home = js.home && js.home.country ? JOB_FIT_GEO.placeText(js.home) : "";
  const parts = [
    targets.length ? t("popup.searchTargets", { countries: JOB_FIT_I18N.list(targets) }) : null,
    home ? t("popup.searchHome", { place: home }) : null,
  ].filter(Boolean);
  host.textContent = parts.length ? parts.join(" · ") : t("popup.searchNone");
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
      row.appendChild(document.createTextNode(JOB_FIT_KEYWORDS.presetLabel(preset)));
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
  salaryCurrencies.forEach((cur) => {
    const fields = salaryFieldsFor(cur);
    if (!fields) return;
    expectedSalary[cur] = {
      min: fields.min.value === "" ? null : Number(fields.min.value),
      max: fields.max.value === "" ? null : Number(fields.max.value),
      period: fields.period.value,
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
  salaryCurrencies = salaryCurrenciesFor(profile);
  renderSalaryRows(profile);
  renderSearchSummary(profile);
  formProfileId = profile.id;
  document.getElementById("salaryReasoning").textContent = "";
  applyForcedSections();
}

// Folds whatever is in the form back into the in-memory profile it came from.
// Called before switching away and before saving.
function captureForm() {
  const target = store.profiles.find((p) => p.id === formProfileId);
  if (!target) return;
  const fields = collectProfileFields();
  // The keyword configs carry bookkeeping the form doesn't show (`seen`);
  // keep it, or a category added later would be re-ticked on every save.
  KEYWORD_KINDS.forEach((kind) => {
    fields.keywords[kind].seen = (target.keywords[kind] && target.keywords[kind].seen) || JOB_FIT_KEYWORDS.presetsFor(kind).map((p) => p.id);
  });
  Object.assign(target, fields);
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
    persistSettings().then(() => setStatus(t("popup.savedAuto")));
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
    opt.textContent = `${t(`tier.${tier.id}.label`)} — ${tier.model}${missing ? ` ${t("popup.notOnKey")}` : ` · ${t("popup.perHundred", { cost })}`}`;
    opt.disabled = Boolean(missing);
    select.appendChild(opt);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = t("popup.customModel");
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
    hint.textContent = t("popup.customModelHint");
    return;
  }
  const flex = JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier, "flex"));
  hint.textContent = `${t(`tier.${tier.id}.blurb`)} ${t("popup.flexCost", { cost: flex })}`;
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
    opt.textContent = value || t("popup.modelDefault");
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
  const day = sum((d) => d === today);
  const m = sum((d) => d.startsWith(month));
  if (!m.requests) {
    host.textContent = t("popup.usageEmpty");
    return;
  }
  const avg = Math.round(m.tokens / m.requests);
  const budget = Number(els.openAiBudget.value) || 0;
  host.textContent =
    t("popup.usageLine", {
      count: day.requests,
      tokens: formatTokens(day.tokens),
      month: formatTokens(m.tokens),
      avg: formatTokens(avg),
    }) + " " + (budget ? t("popup.usageBudget", { count: Math.floor(budget / avg) }) : t("popup.usageNoBudget"));
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
  ].filter(Boolean);

  fields.forEach((field) => {
    field.addEventListener("input", scheduleAutoSave);
    field.addEventListener("change", flushAutoSave);
  });

  // Salary rows are rebuilt per profile, so delegate to their container.
  els.salaryRows.addEventListener("input", scheduleAutoSave);
  els.salaryRows.addEventListener("change", flushAutoSave);

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
  setStatus(t("popup.saved", { name: activeProfile().name }));
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
  setStatus(t("popup.switched", { name: activeProfile().name }));
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
    els.profileHint.textContent = t("popup.nameNeeded");
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
  setStatus(action === "rename" ? t("popup.renamed") : t("popup.created", { name }));
}

// Two-step rather than confirm(), same popup-dismissal reason as above.
let deleteArmed = false;

async function deleteProfile() {
  const btn = document.getElementById("profileDelete");
  if (store.profiles.length < 2) {
    els.profileHint.textContent = t("popup.cantDeleteOnly");
    return;
  }

  if (!deleteArmed) {
    deleteArmed = true;
    btn.textContent = t("popup.sure");
    // The tracked-job count goes in the warning because those records are
    // deleted too, and that's the part you can't get back — the profile
    // itself is a minute of retyping.
    const tracked = await JOB_FIT_EVALSTORE.countForProfile(store.activeProfileId);
    const armedText = tracked
      ? t("popup.deleteConfirmJobs", { name: activeProfile().name, count: tracked })
      : t("popup.deleteConfirm", { name: activeProfile().name });
    els.profileHint.textContent = armedText;
    setTimeout(() => {
      deleteArmed = false;
      btn.textContent = t("popup.delete");
      if (els.profileHint.textContent === armedText) els.profileHint.textContent = "";
    }, 6000);
    return;
  }

  deleteArmed = false;
  btn.textContent = t("popup.delete");
  const removed = activeProfile().name;
  const removedId = store.activeProfileId;

  // Records first: if this throws, the profile stays and the records are still
  // reachable. The other order would strand them permanently.
  let removedJobs = 0;
  try {
    removedJobs = await JOB_FIT_EVALSTORE.removeAllForProfile(removedId);
  } catch (err) {
    els.profileHint.textContent = t("popup.deleteJobsFailed", { error: err.message });
    return;
  }

  store.profiles = store.profiles.filter((p) => p.id !== removedId);
  store.activeProfileId = store.profiles[0].id;
  await JOB_FIT_PROFILES.save(store);
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  els.profileHint.textContent = "";
  setStatus(removedJobs ? t("popup.deletedJobs", { name: removed, count: removedJobs }) : t("popup.deleted", { name: removed }));
}

// Only the reject/warning lists. The candidate text can't be reset to a
// default that means anything once profiles exist (restoring one person's CV
// into another person's profile is nonsense), and domain flags are per-person
// by construction.
function resetKeywordLists() {
  fillKeywordConfig("hardRejects", JOB_FIT_DEFAULTS.keywords.hardRejects);
  fillKeywordConfig("softWarnings", JOB_FIT_DEFAULTS.keywords.softWarnings);
  setStatus(t("popup.resetDone"));
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
  if (!banner.hidden) document.getElementById("setupBannerText").textContent = t("popup.setupUnfinished", { name: profile.name });
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
  document.getElementById("shortcutKey").textContent = shortcut || t("popup.notSet");
  document.getElementById("evaluateTip").textContent = shortcut
    ? t("popup.tipShortcut", { shortcut })
    : t("popup.tipNoShortcut");
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
      setReady("modelDot", "modelState", "bad", t("popup.oaNoKey"));
    } else if (probe.reason === "unauthorized") {
      setReady("modelDot", "modelState", "bad", t("popup.oaBadKey"));
    } else if (!probe.ok) {
      setReady("modelDot", "modelState", "bad", t("popup.oaUnreachable"));
    } else if (!wanted) {
      setReady("modelDot", "modelState", "warn", t("popup.oaPickModel"));
    } else if (probe.models.length && !probe.models.includes(wanted)) {
      setReady("modelDot", "modelState", "warn", t("popup.oaModelMissing", { model: wanted }), probe.models.join("\n"));
    } else {
      setReady("modelDot", "modelState", "ok", `OpenAI — ${wanted}`);
    }
    return;
  }

  if (probe.reason === "invalid-url") {
    setReady("modelDot", "modelState", "bad", t("popup.lmBadUrl"));
    return;
  }
  if (!probe.ok) {
    setReady("modelDot", "modelState", "bad", t("popup.lmUnreachable"), probe.url);
    return;
  }

  const loaded = probe.models;

  if (!wanted) {
    setReady("modelDot", "modelState", "ok", t("popup.lmConnectedUsing", { model: loaded[0] || t("popup.whateverLoaded") }), loaded.join("\n"));
    return;
  }
  // A model name that isn't loaded is the cause of the HTTP error that pauses
  // the whole queue — worth catching here rather than after you've queued ten.
  if (loaded.length && !loaded.includes(wanted)) {
    setReady("modelDot", "modelState", "warn", t("popup.lmNotLoaded", { model: wanted }), `${t("popup.loaded")}:\n${loaded.join("\n")}`);
    return;
  }
  setReady("modelDot", "modelState", "ok", t("popup.lmConnected", { model: wanted }));
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
    setReady("pageDot", "pageState", "warn", t("popup.noTab"));
    return;
  }
  let probe;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
    probe = results && results[0] && results[0].result;
  } catch (err) {
    setReady("pageDot", "pageState", "bad", t("popup.cantReadPage"));
    return;
  }
  if (!probe) {
    setReady("pageDot", "pageState", "warn", t("popup.couldntReadTab"));
    return;
  }

  const site = probe.linkedin
    ? "LinkedIn"
    : probe.greenhouse
      ? "Greenhouse"
      : probe.embedded
        ? t("popup.siteEmbedded")
        : probe.indeed
          ? "Indeed"
          : probe.workday
            ? "Workday"
            : probe.jibe
              ? t("popup.siteJibe")
              : probe.eightfold
                ? t("popup.siteEightfold")
                : null;
  if (site) setReady("pageDot", "pageState", "ok", t("popup.postingDetected", { site }));
  else setReady("pageDot", "pageState", "warn", t("popup.noKnownPosting"), probe.host);
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
    hint.textContent = t("popup.timingEmpty");
    return;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[sorted.length - 1];
  hint.textContent = t("popup.timingLine", {
    count: durations.length,
    median: humanDuration(median),
    slowest: humanDuration(slowest),
  });
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
  if (processing) parts.push(t("popup.qProcessing", { title: processing.title || t("popup.posting") }));
  if (pending) parts.push(t("queue.waitingCount", { count: pending }));
  if (failed) parts.push(t("queue.failedCount", { count: failed }));
  if (snapshot.state === "paused") parts.unshift(`⏸ ${t("popup.qPaused")}`);

  box.textContent = `${parts.join(" · ")} — ${t("popup.qSeeTracked")}`;
  box.style.display = "block";
}

async function suggestSalary() {
  const btn = document.getElementById("suggestSalary");
  const reasoningEl = document.getElementById("salaryReasoning");

  // With no CV the model has nothing to reason from and returns a plausible
  // invented range, which is worse than no answer — you'd save it as your own
  // expectation and every salary comparison after that would be built on it.
  if (!els.profile.value.trim()) {
    reasoningEl.textContent = t("popup.salaryNeedsProfile");
    document.getElementById("sec-profile").open = true;
    els.profile.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = "…";
  reasoningEl.textContent = "";

  try {
    const profile = activeProfile();
    const markets = salaryCurrencies.map((currency) => ({
      currency,
      period: salaryFieldsFor(currency).period.value,
      country: countryForCurrency(currency, profile),
    }));
    const response = await sendMessageWithRetry({
      type: "JOB_FIT_SUGGEST_SALARY",
      profile: els.profile.value,
      markets,
      jobSearch: profile.jobSearch,
    });

    if (!response || !response.ok) {
      reasoningEl.textContent = response?.error || t("popup.noSuggestion");
      return;
    }

    salaryCurrencies.forEach((cur) => {
      const range = response.data[cur];
      if (!range) return;
      const { min, max } = salaryFieldsFor(cur);
      if (range.min != null) min.value = range.min;
      if (range.max != null) max.value = range.max;
    });
    await flushAutoSave();

    reasoningEl.textContent = response.data.reasoning
      ? `${response.data.reasoning} ${t("popup.reviewIt")}`
      : t("popup.suggestedReview");
  } catch (err) {
    reasoningEl.textContent = t("common.errorDetail", { detail: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = t("popup.suggestAll");
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
  statusEl.textContent = t("popup.extracting");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusEl.textContent = t("popup.noTab");
    btn.disabled = false;
    return;
  }
  const files = await jobFitContentFiles();

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
    statusEl.textContent = t("banner.noTextSummary");
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
    statusEl.textContent = t("common.errorDetail", { detail: err.message });
    btn.disabled = false;
    return;
  }

  if (!response || !response.ok) {
    statusEl.textContent = response?.full
      ? t("popup.queueFull", { count: response.max })
      : response?.error || t("popup.couldNotQueueSummary");
    btn.disabled = false;
    return;
  }

  statusEl.textContent =
    response.position > 1 ? t("popup.summaryQueued", { count: response.position - 1 }) : t("popup.summarizing");

  const summary = await waitForSummary(tab.url, active.id, requestedAt);
  const combinedText = summary && summary.text;
  if (!combinedText) {
    statusEl.textContent = t("popup.summaryStillRunning");
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
    statusEl.textContent = summary.hasEvaluation ? t("popup.copiedWithEval", { name: active.name }) : t("popup.copied");
  } catch (err) {
    statusEl.textContent = t("popup.couldntAutoCopy");
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
      return summary;
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
  document.getElementById("summarizeStatus").textContent = t("popup.summaryEarlier");
}

async function copySummary() {
  const resultEl = document.getElementById("summarizeResult");
  const statusEl = document.getElementById("summarizeStatus");
  try {
    await navigator.clipboard.writeText(resultEl.value);
    statusEl.textContent = t("popup.copied");
  } catch (err) {
    resultEl.focus();
    resultEl.select();
    statusEl.textContent = t("popup.copyManually");
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
  askForName("duplicate", t("popup.copyName", { name: activeProfile().name }))
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

els.salaryAdd.addEventListener("change", () => {
  const currency = els.salaryAdd.value;
  if (!currency) return;
  captureForm();
  salaryCurrencies.push(currency);
  renderSalaryRows(activeProfile());
  flushAutoSave();
  const fields = salaryFieldsFor(currency);
  if (fields) fields.min.focus();
});

// The language picker: "Automatic" follows the browser. Changing it reloads
// the popup in the new language — every string on it is drawn at load.
function renderLanguagePicker() {
  const select = els.uiLanguage;
  select.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = t("popup.languageAuto", { language: JOB_FIT_I18N.LANGUAGES.find((l) => l.code === JOB_FIT_I18N.detect()).name });
  select.appendChild(auto);
  JOB_FIT_I18N.LANGUAGES.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    select.appendChild(opt);
  });
  select.value = JOB_FIT_I18N.setting;
  select.addEventListener("change", async () => {
    await flushAutoSave();
    await JOB_FIT_I18N.setLanguage(select.value);
    location.reload();
  });
}

JOB_FIT_I18N.load().then(() => {
  JOB_FIT_I18N.translatePage();
  renderLanguagePicker();
  renderShortcuts();
  loadSettings().then(() => {
    restoreLastSummary();
    if (els.modelProvider.value === "openai") loadOpenAiModels();
  });
  renderQueueStatus();
  checkModel();
  checkPage();
  renderTimingHint();
});
