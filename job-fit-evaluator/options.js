// Settings: everything that used to be stacked in the popup, on a page of its
// own (options_ui, opened in a tab). The popup is destroyed the moment it
// loses focus, which made editing a CV there a race against a stray click;
// here the page stays put, so it can be laid out for reading.
//
// Per-profile sections (profile, salary, screening) edit the active profile —
// the one the popup evaluates as — and say so. Model, the on-page button,
// language and data are shared by every profile.
//
// Everything saves as you go. The page can be open for a long time next to a
// wizard tab or a popup that change the same storage, so a save writes only
// what this page owns — the current profile's fields, or the model settings —
// merged onto what's stored now, never a whole copy held since load.

const $ = (id) => document.getElementById(id);

const els = {
  profileSelect: $("profileSelect"),
  profileText: $("profileText"),
  profileNameRow: $("profileNameRow"),
  profileNameInput: $("profileNameInput"),
  profileHint: $("profileHint"),
  salaryRows: $("salaryRows"),
  salaryAdd: $("salaryAdd"),
  modelProvider: $("modelProvider"),
  lmStudioUrl: $("lmStudioUrl"),
  lmStudioModel: $("lmStudioModel"),
  lmStudioTimeout: $("lmStudioTimeout"),
  lmStudioReasoningEffort: $("lmStudioReasoningEffort"),
  lmStudioEnableThinking: $("lmStudioEnableThinking"),
  openAiKey: $("openAiKey"),
  openAiModel: $("openAiModel"),
  openAiTier: $("openAiTier"),
  openAiFlex: $("openAiFlex"),
  openAiReasoningEffort: $("openAiReasoningEffort"),
  openAiMaxOutput: $("openAiMaxOutput"),
  openAiBudget: $("openAiBudget"),
  hardRejectsPresets: $("hardRejectsPresets"),
  hardRejectsPhrases: $("hardRejectsPhrases"),
  hardRejectsPatterns: $("hardRejectsPatterns"),
  softWarningsPresets: $("softWarningsPresets"),
  softWarningsPhrases: $("softWarningsPhrases"),
  softWarningsPatterns: $("softWarningsPatterns"),
  domainFlagsPhrases: $("domainFlagsPhrases"),
  domainFlagsPatterns: $("domainFlagsPatterns"),
  uiLanguage: $("uiLanguage"),
  saveState: $("saveState"),
};

const KEYWORD_KINDS = ["hardRejects", "softWarnings", "domainFlags"];
const ADVANCED_SECTION_ID = { hardRejects: "adv-hardrejects", softWarnings: "adv-warnings", domainFlags: "adv-domainflags" };
const MODEL_KEYS = ["modelProvider", "lmStudio", "openai"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function linesToArray(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// --- save state -------------------------------------------------------------

function setSaveState(text, isError = false) {
  els.saveState.textContent = text;
  els.saveState.classList.toggle("error", isError);
}

// Runs a save and keeps the indicator honest: "Saving…" while it runs, the
// error if it fails (and it stays), "All changes saved" when it's done.
async function withSaveState(work) {
  setSaveState(t("wiz.saving"));
  try {
    await work();
    setSaveState(t("wiz.allSaved"));
  } catch (err) {
    setSaveState(t("wiz.couldntSave", { error: err.message }), true);
  }
}

// --- profile store ------------------------------------------------------------

let store = { profiles: [], activeProfileId: null };
// Which profile the form fields belong to.
let formProfileId = null;

function activeProfile() {
  return store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
}

// Every structural change (switch, rename, duplicate, delete, a field save)
// goes through here: read what's stored now, change it, write it back. The
// in-memory copy is then exactly what was written, which is also how a
// storage event can tell our own write from someone else's.
async function mutateStore(change) {
  const latest = await JOB_FIT_PROFILES.load();
  change(latest);
  await JOB_FIT_PROFILES.save(latest);
  store = latest;
}

function renderProfileSelect() {
  els.profileSelect.innerHTML = "";
  store.profiles.forEach((p) => {
    const opt = el("option", null, p.name);
    opt.value = p.id;
    els.profileSelect.appendChild(opt);
  });
  els.profileSelect.value = store.activeProfileId;
  document.querySelectorAll('[data-scope="profile"]').forEach((node) => {
    node.textContent = t("settings.forProfile", { name: activeProfile().name });
  });
}

// --- salary -----------------------------------------------------------------
//
// One row per currency: the currencies of the profile's target countries,
// any that already hold figures, and any added with "+ Add a currency". Each
// row has its own pay period, because a Mexican salary is usually quoted per
// month and a US one per year.
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
  const pick = (cls) => els.salaryRows.querySelector(`.${cls}[data-currency="${currency}"]`);
  const min = pick("sal-min");
  return min ? { min, max: pick("sal-max"), period: pick("sal-period") } : null;
}

function renderSalaryRows(profile) {
  const grid = els.salaryRows;
  grid.innerHTML = "";
  [["", "head"], [t("common.min"), "head"], [t("common.max"), "head"], [t("settings.period"), "head period"]].forEach(([text, cls]) => {
    const head = el("span", cls, text);
    head.setAttribute("aria-hidden", "true");
    grid.appendChild(head);
  });
  salaryCurrencies.forEach((cur) => {
    const range = (profile.expectedSalary || {})[cur] || {};
    grid.appendChild(el("span", "cur", cur));
    ["min", "max"].forEach((end) => {
      const input = el("input", `sal-${end}`);
      input.type = "number";
      input.min = "0";
      input.dataset.currency = cur;
      input.value = range[end] ?? "";
      input.setAttribute("aria-label", t(end === "min" ? "settings.salaryMinAria" : "settings.salaryMaxAria", { currency: cur }));
      grid.appendChild(input);
    });
    const period = el("select", "sal-period period");
    period.dataset.currency = cur;
    period.setAttribute("aria-label", t("settings.salaryPeriodAria", { currency: cur }));
    ["year", "month", "hour"].forEach((value) => {
      const opt = el("option", null, t(`period.${value}`));
      opt.value = value;
      period.appendChild(opt);
    });
    period.value = range.period && (range.min != null || range.max != null) ? range.period : defaultPeriod(cur, profile);
    grid.appendChild(period);
  });
  renderSalaryAdd();
}

function renderSalaryAdd() {
  const select = els.salaryAdd;
  select.innerHTML = "";
  const first = el("option", null, t("popup.addCurrency"));
  first.value = "";
  select.appendChild(first);
  Array.from(new Set(JOB_FIT_GEO.CODES.map(JOB_FIT_GEO.currencyOf)))
    .filter((c) => !salaryCurrencies.includes(c))
    .sort()
    .forEach((cur) => {
      const opt = el("option", null, cur);
      opt.value = cur;
      select.appendChild(opt);
    });
}

// A line under the heading: where this profile is looking, so it's clear
// which country rules apply. Edited in the setup wizard.
function renderSearchSummary(profile) {
  const js = profile.jobSearch || {};
  const targets = (js.targetCountries || []).map((c) => JOB_FIT_I18N.countryName(c));
  const home = js.home && js.home.country ? JOB_FIT_GEO.placeText(js.home) : "";
  const parts = [
    targets.length ? t("popup.searchTargets", { countries: JOB_FIT_I18N.list(targets) }) : null,
    home ? t("popup.searchHome", { place: home }) : null,
  ].filter(Boolean);
  $("searchSummary").textContent = parts.length ? `${parts.join(" · ")}.` : t("popup.searchNone");
}

// --- keyword lists ------------------------------------------------------------

// Generated from the preset definitions rather than written into the HTML, so
// the two can't drift apart when a category is added. Laid out like the
// wizard's, with the example of posting language each one catches.
function renderPresetCheckboxes() {
  ["hardRejects", "softWarnings"].forEach((kind) => {
    const host = els[`${kind}Presets`];
    host.innerHTML = "";
    JOB_FIT_KEYWORDS.presetsFor(kind).forEach((preset) => {
      const row = el("label", "preset");
      const box = el("input");
      box.type = "checkbox";
      box.value = preset.id;
      row.appendChild(box);
      const text = el("div");
      text.appendChild(el("div", "title", JOB_FIT_KEYWORDS.presetLabel(preset)));
      const example = JOB_FIT_KEYWORDS.presetExample(preset);
      if (example) text.appendChild(el("div", "example", t("wiz.example", { example })));
      row.appendChild(text);
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
  els[`${kind}Phrases`].value = resolved.phrases.join("\n");
  els[`${kind}Patterns`].value = resolved.patterns.join("\n");
  // Opened when it holds something, so a pattern carried over from the old
  // format isn't hidden where you can't see why a posting is being rejected.
  $(ADVANCED_SECTION_ID[kind]).open = resolved.patterns.length > 0;
}

// --- the profile form ----------------------------------------------------------

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
    profile: els.profileText.value,
    keywords: {
      hardRejects: keywordConfigFromForm("hardRejects"),
      softWarnings: keywordConfigFromForm("softWarnings"),
      domainFlags: keywordConfigFromForm("domainFlags"),
    },
    expectedSalary,
  };
}

function fillFormFromProfile(profile) {
  els.profileText.value = profile.profile;
  KEYWORD_KINDS.forEach((kind) => fillKeywordConfig(kind, profile.keywords[kind]));
  salaryCurrencies = salaryCurrenciesFor(profile);
  renderSalaryRows(profile);
  renderSearchSummary(profile);
  renderWordCount();
  renderSetupBanner();
  formProfileId = profile.id;
  $("salaryReasoning").textContent = "";
}

function renderWordCount() {
  const words = els.profileText.value.trim().split(/\s+/).filter(Boolean).length;
  const node = $("wordCount");
  node.textContent = t("settings.words", { count: words });
  node.classList.toggle("over", words > 400);
}

function renderSetupBanner() {
  const profile = activeProfile();
  const banner = $("setupBanner");
  banner.hidden = !(profile && profile.setupIncomplete);
  if (!banner.hidden) $("setupBannerText").textContent = t("popup.setupUnfinished", { name: profile.name });
}

// Writes the form's fields onto the profile they came from, in what's stored
// now. The keyword configs carry bookkeeping the form doesn't show (`seen`);
// keep it, or a category added later would be re-ticked on every save.
async function saveProfileFields() {
  const id = formProfileId;
  if (!id) return;
  const fields = collectProfileFields();
  await mutateStore((latest) => {
    const target = latest.profiles.find((p) => p.id === id);
    if (!target) return;
    KEYWORD_KINDS.forEach((kind) => {
      fields.keywords[kind].seen =
        (target.keywords[kind] && target.keywords[kind].seen) || JOB_FIT_KEYWORDS.presetsFor(kind).map((p) => p.id);
    });
    Object.assign(target, fields);
  });
}

// --- model settings --------------------------------------------------------------

// What this page last wrote to each model key, so a storage event can tell
// our own save from a change made in the wizard or another tab.
let lastModelWrite = {};

// The model settings as the form holds them, merged over what's stored so
// fields this page doesn't show (LM Studio's seed, say) survive a save.
async function saveModelSettings() {
  const stored = await chrome.storage.local.get(["lmStudio", "openai"]);
  const next = {
    modelProvider: els.modelProvider.value === "openai" ? "openai" : "lmstudio",
    lmStudio: {
      ...(stored.lmStudio || {}),
      url: els.lmStudioUrl.value.trim() || JOB_FIT_DEFAULTS.lmStudio.url,
      model: els.lmStudioModel.value.trim(),
      timeoutSeconds:
        els.lmStudioTimeout.value === "" ? JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds : Number(els.lmStudioTimeout.value),
      reasoningEffort: els.lmStudioReasoningEffort.value,
      enableThinking: els.lmStudioEnableThinking.checked,
    },
    openai: {
      ...(stored.openai || {}),
      apiKey: els.openAiKey.value.trim(),
      model: selectedOpenAiModel(),
      flex: els.openAiFlex.value,
      reasoningEffort: $("openAiReasoningSection").hidden
        ? els.openAiReasoningEffort.dataset.saved || ""
        : els.openAiReasoningEffort.value,
      maxOutputTokens: JOB_FIT_PROVIDER.clampOutputTokens(els.openAiMaxOutput.value),
      dailyTokenBudget: Math.max(0, Number(els.openAiBudget.value) || 0),
    },
  };
  lastModelWrite = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, JSON.stringify(v)]));
  await chrome.storage.local.set(next);
}

async function fillModelFields() {
  const stored = await chrome.storage.local.get(JOB_FIT_PROVIDER.KEYS);
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
  els.lmStudioUrl.value = lmStudio.url || JOB_FIT_DEFAULTS.lmStudio.url;
  els.lmStudioModel.value = lmStudio.model || "";
  els.lmStudioTimeout.value = lmStudio.timeoutSeconds || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
  els.lmStudioReasoningEffort.value = lmStudio.reasoningEffort ?? JOB_FIT_DEFAULTS.lmStudio.reasoningEffort;
  els.lmStudioEnableThinking.checked =
    typeof lmStudio.enableThinking === "boolean" ? lmStudio.enableThinking : JOB_FIT_DEFAULTS.lmStudio.enableThinking;
  renderUsage();
}

function showProviderFields() {
  const openai = els.modelProvider.value === "openai";
  $("lmStudioFields").hidden = openai;
  $("openAiFields").hidden = !openai;
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
    const cost = JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier));
    const missing = availableOpenAiModels && !availableOpenAiModels.includes(tier.model);
    const opt = el(
      "option",
      null,
      `${t(`tier.${tier.id}.label`)} — ${tier.model}${missing ? ` ${t("popup.notOnKey")}` : ` · ${t("popup.perHundred", { cost })}`}`
    );
    opt.value = tier.id;
    opt.disabled = Boolean(missing);
    select.appendChild(opt);
  });
  const custom = el("option", null, t("popup.customModel"));
  custom.value = "custom";
  select.appendChild(custom);
  const tier = JOB_FIT_PROVIDER.tierForModel(current);
  select.value = tier ? tier.id : "custom";
  syncTierHint();
}

function syncTierHint() {
  const tier = (JOB_FIT_DEFAULTS.openaiTiers || []).find((x) => x.id === els.openAiTier.value);
  $("openAiCustomRow").hidden = Boolean(tier);
  const hint = $("openAiTierHint");
  if (!tier) {
    hint.textContent = t("popup.customModelHint");
    return;
  }
  const flex = JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier, "flex"));
  hint.textContent = `${t(`tier.${tier.id}.blurb`)} ${t("popup.flexCost", { cost: flex })}`;
}

function selectedOpenAiModel() {
  const tier = (JOB_FIT_DEFAULTS.openaiTiers || []).find((x) => x.id === els.openAiTier.value);
  return tier ? tier.model : els.openAiModel.value.trim();
}

function renderReasoningOptions() {
  const select = els.openAiReasoningEffort;
  const allowed = JOB_FIT_PROVIDER.reasoningEffortsFor(selectedOpenAiModel());
  const wanted = select.dataset.saved ?? select.value ?? "";
  $("openAiReasoningSection").hidden = !allowed.length;
  select.innerHTML = "";
  if (!allowed.length) return;
  ["", ...allowed].forEach((value) => {
    const opt = el("option", null, value || t("popup.modelDefault"));
    opt.value = value;
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
  const host = $("openAiUsage");
  const stored = await chrome.storage.local.get(["usageByDay", "openaiBudgetReset"]);
  const days = stored.usageByDay || {};
  const today = JOB_FIT_PROVIDER.dayKey();
  const counted = JOB_FIT_PROVIDER.budgetTokensUsed(days, stored.openaiBudgetReset);
  const wasReset = stored.openaiBudgetReset && stored.openaiBudgetReset.day === today;
  const month = today.slice(0, 7);
  const sum = (filter) =>
    Object.entries(days)
      .filter(([day]) => filter(day))
      .reduce(
        (acc, [, d]) => {
          if (d.openai) {
            acc.requests += d.openai.requests;
            acc.tokens += d.openai.input + d.openai.output;
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
  const left = budget ? Math.max(0, budget - counted) : 0;
  host.textContent =
    t("popup.usageLine", { count: day.requests, tokens: formatTokens(day.tokens), month: formatTokens(m.tokens), avg: formatTokens(avg) }) +
    " " +
    (budget
      ? t(wasReset ? "popup.usageBudgetSinceReset" : "popup.usageBudgetUsed", { used: formatTokens(counted), count: Math.floor(left / avg) })
      : t("popup.usageNoBudget"));
}

// Starts today's budget count from zero — handy after switching model or
// effort, when the day's earlier requests don't reflect what the rest will
// cost. Only the budget's starting point moves; usage history is untouched.
// A queue that paused because the budget ran out is resumed.
async function resetBudget() {
  const stored = await chrome.storage.local.get("usageByDay");
  const today = JOB_FIT_PROVIDER.dayKey();
  await chrome.storage.local.set({
    openaiBudgetReset: { day: today, tokens: JOB_FIT_PROVIDER.openAiTokensOnDay(stored.usageByDay, today), at: Date.now() },
  });
  let resumed = false;
  try {
    const snapshot = await sendMessageWithRetry({ type: "JOB_FIT_QUEUE_SNAPSHOT" });
    // pauseFailure, not the message: the message is in the user's language.
    if (snapshot && snapshot.state === "paused" && snapshot.pauseFailure === "budget") {
      await sendMessageWithRetry({ type: "JOB_FIT_QUEUE_RESUME" });
      resumed = true;
    }
  } catch (err) {
    /* worker asleep and no queue to resume */
  }
  await renderUsage();
  const message = resumed ? t("popup.budgetResetResumed") : t("popup.budgetResetDone");
  setSaveState(message);
  JOB_FIT_UI.announce(message);
}

// Fills the model suggestions from the account's own model list, so the name
// is picked rather than typed from memory.
async function loadOpenAiModels() {
  const key = els.openAiKey.value.trim();
  if (!key) return;
  const probe = await probeModels({ provider: "openai", apiKey: key });
  const list = $("openAiModelList");
  list.innerHTML = "";
  if (!probe.ok) return;
  availableOpenAiModels = probe.models;
  renderTierOptions();
  probe.models.forEach((id) => {
    const opt = el("option");
    opt.value = id;
    list.appendChild(opt);
  });
}

// The model check, shown at the top of the section: the same answer the
// popup gives, next to the fields that fix it. LM Studio's loaded models
// become suggestions for the model name.
let modelCheckSeq = 0;

async function checkModel() {
  const mine = ++modelCheckSeq;
  const box = $("modelState");
  box.className = "callout info";
  box.textContent = t("popup.checkingModel");
  const settings = await JOB_FIT_PROVIDER.load();
  const probe = await probeModels(settings);
  if (mine !== modelCheckSeq) return;
  const verdict = describeModelReadiness(settings, probe);
  box.className = `callout ${verdict.state === "ok" ? "ok" : verdict.state === "warn" ? "warn" : "bad"}`;
  box.textContent = verdict.text;
  box.title = verdict.title || "";
  if (settings.provider !== "openai" && probe.ok) {
    const list = $("lmModelList");
    list.innerHTML = "";
    probe.models.forEach((id) => {
      const opt = el("option");
      opt.value = id;
      list.appendChild(opt);
    });
  }
}

let modelCheckTimer = null;
function scheduleModelCheck() {
  clearTimeout(modelCheckTimer);
  modelCheckTimer = setTimeout(checkModel, 600);
}

function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

// Directly under the timeout field: the number you need to choose a timeout,
// next to the box you type it into.
async function renderTimingHint() {
  const hint = $("timingHint");
  const stored = await chrome.storage.local.get("evalStats");
  const durations = (stored.evalStats && stored.evalStats.durations) || [];
  if (!durations.length) {
    hint.textContent = t("popup.timingEmpty");
    return;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  hint.textContent = t("popup.timingLine", {
    count: durations.length,
    median: humanDuration(sorted[Math.floor(sorted.length / 2)]),
    slowest: humanDuration(sorted[sorted.length - 1]),
  });
}

// --- autosave wiring -------------------------------------------------------------

let profileSaveTimer = null;
let modelSaveTimer = null;

function scheduleProfileSave() {
  setSaveState(t("wiz.saving"));
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => {
    profileSaveTimer = null;
    withSaveState(saveProfileFields);
  }, 400);
}

function flushProfileSave() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = null;
  return withSaveState(saveProfileFields);
}

function scheduleModelSave() {
  setSaveState(t("wiz.saving"));
  clearTimeout(modelSaveTimer);
  modelSaveTimer = setTimeout(() => {
    modelSaveTimer = null;
    withSaveState(saveModelSettings).then(scheduleModelCheck);
  }, 400);
}

function flushModelSave() {
  clearTimeout(modelSaveTimer);
  modelSaveTimer = null;
  return withSaveState(saveModelSettings).then(scheduleModelCheck);
}

function watchFields() {
  const profileFields = [
    els.profileText,
    els.hardRejectsPhrases, els.hardRejectsPatterns,
    els.softWarningsPhrases, els.softWarningsPatterns,
    els.domainFlagsPhrases, els.domainFlagsPatterns,
  ];
  profileFields.forEach((field) => {
    field.addEventListener("input", scheduleProfileSave);
    field.addEventListener("change", flushProfileSave);
  });
  els.profileText.addEventListener("input", renderWordCount);
  // Rebuilt per profile, so delegated to their containers.
  els.salaryRows.addEventListener("input", scheduleProfileSave);
  els.salaryRows.addEventListener("change", flushProfileSave);
  ["hardRejects", "softWarnings"].forEach((kind) => els[`${kind}Presets`].addEventListener("change", flushProfileSave));

  const modelFields = [
    els.lmStudioUrl, els.lmStudioModel, els.lmStudioTimeout, els.lmStudioReasoningEffort, els.lmStudioEnableThinking,
    els.openAiKey, els.openAiModel, els.openAiReasoningEffort, els.openAiMaxOutput, els.openAiBudget, els.openAiFlex,
  ];
  modelFields.forEach((field) => {
    field.addEventListener("input", scheduleModelSave);
    field.addEventListener("change", flushModelSave);
  });

  els.modelProvider.addEventListener("change", () => {
    showProviderFields();
    flushModelSave();
    if (els.modelProvider.value === "openai") loadOpenAiModels();
  });
  els.openAiKey.addEventListener("change", loadOpenAiModels);
  els.openAiTier.addEventListener("change", () => {
    syncTierHint();
    if (els.openAiTier.value !== "custom") els.openAiModel.value = selectedOpenAiModel();
    else els.openAiModel.focus();
    renderReasoningOptions();
    flushModelSave();
  });
  els.openAiModel.addEventListener("input", renderReasoningOptions);
  els.openAiModel.addEventListener("change", renderReasoningOptions);
  els.openAiBudget.addEventListener("input", renderUsage);
  // The preference is only what the user picks here, never the adjusted value
  // a half-typed model name produced.
  els.openAiReasoningEffort.addEventListener("change", () => {
    els.openAiReasoningEffort.dataset.saved = els.openAiReasoningEffort.value;
  });
  $("resetBudget").addEventListener("click", resetBudget);

  els.salaryAdd.addEventListener("change", () => {
    const currency = els.salaryAdd.value;
    if (!currency) return;
    salaryCurrencies.push(currency);
    const profile = store.profiles.find((p) => p.id === formProfileId);
    renderSalaryRows({ ...profile, ...collectProfileFieldsSafe(profile) });
    flushProfileSave();
    const fields = salaryFieldsFor(currency);
    if (fields) fields.min.focus();
  });
  $("suggestSalary").addEventListener("click", suggestSalary);
}

// The salary rows as typed, for redrawing them with one more currency
// without losing what's in the others.
function collectProfileFieldsSafe(profile) {
  const salary = { ...(profile.expectedSalary || {}) };
  salaryCurrencies.forEach((cur) => {
    const fields = salaryFieldsFor(cur);
    if (!fields) return;
    salary[cur] = {
      min: fields.min.value === "" ? null : Number(fields.min.value),
      max: fields.max.value === "" ? null : Number(fields.max.value),
      period: fields.period.value,
    };
  });
  return { expectedSalary: salary };
}

// Flushed when the tab goes away; a debounced save still pending would
// otherwise be the last half-second of typing.
function flushAll() {
  if (profileSaveTimer) flushProfileSave();
  if (modelSaveTimer) flushModelSave();
}

// --- profiles: switch, create, rename, duplicate, delete --------------------------

async function switchProfile(id) {
  await flushProfileSave();
  await mutateStore((latest) => {
    if (latest.profiles.some((p) => p.id === id)) latest.activeProfileId = id;
  });
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  JOB_FIT_UI.announce(t("popup.switched", { name: activeProfile().name }));
}

// Name entry is inline: prompt() would do, but it can't be styled or
// translated, and it blocks the page.
let pendingNameAction = null;

function askForName(action, initialValue) {
  pendingNameAction = action;
  els.profileNameInput.value = initialValue || "";
  els.profileNameRow.hidden = false;
  els.profileNameInput.focus();
  els.profileNameInput.select();
}

function cancelNamePrompt() {
  const wasOpen = !els.profileNameRow.hidden;
  pendingNameAction = null;
  els.profileNameRow.hidden = true;
  els.profileNameInput.value = "";
  if (wasOpen) $(pendingFocusBack || "profileRename").focus();
}
let pendingFocusBack = null;

async function confirmNamePrompt() {
  const name = els.profileNameInput.value.trim();
  const action = pendingNameAction;
  if (!action) return;
  if (!name) {
    els.profileHint.textContent = t("popup.nameNeeded");
    return;
  }
  await flushProfileSave();
  let created = null;
  await mutateStore((latest) => {
    const current = latest.profiles.find((p) => p.id === latest.activeProfileId) || latest.profiles[0];
    if (action === "rename") {
      current.name = name;
    } else {
      created = Object.assign(JOB_FIT_PROFILES.clone(current), { id: JOB_FIT_PROFILES.newId(), name });
      latest.profiles.push(created);
      latest.activeProfileId = created.id;
    }
  });
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  pendingNameAction = null;
  els.profileNameRow.hidden = true;
  els.profileHint.textContent = "";
  const message = action === "rename" ? t("popup.renamed") : t("popup.created", { name });
  setSaveState(message);
  JOB_FIT_UI.announce(message);
}

function setupProfileDelete() {
  const btn = $("profileDelete");
  JOB_FIT_UI.armConfirm(btn, {
    confirmLabel: t("history.deleteAgain"),
    // The tracked-job count goes in the warning because those records are
    // deleted too, and that's the part you can't get back — the profile
    // itself is a minute of retyping.
    onArm: async () => {
      const profile = activeProfile();
      const tracked = await JOB_FIT_EVALSTORE.countForProfile(profile.id);
      els.profileHint.textContent = tracked
        ? t("popup.deleteConfirmJobs", { name: profile.name, count: tracked })
        : t("popup.deleteConfirm", { name: profile.name });
    },
    onDisarm: () => {
      els.profileHint.textContent = "";
    },
    onConfirm: deleteProfile,
  });
  btn.addEventListener(
    "click",
    (event) => {
      if (store.profiles.length < 2) {
        event.stopImmediatePropagation();
        els.profileHint.textContent = t("popup.cantDeleteOnly");
      }
    },
    { capture: true }
  );
}

async function deleteProfile() {
  const removed = activeProfile();
  // Records first: if this throws, the profile stays and the records are still
  // reachable. The other order would strand them permanently.
  let removedJobs = 0;
  try {
    removedJobs = await JOB_FIT_EVALSTORE.removeAllForProfile(removed.id);
  } catch (err) {
    els.profileHint.textContent = t("popup.deleteJobsFailed", { error: err.message });
    return;
  }
  clearTimeout(profileSaveTimer);
  await mutateStore((latest) => {
    latest.profiles = latest.profiles.filter((p) => p.id !== removed.id);
    latest.activeProfileId = latest.profiles[0].id;
  });
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  const message = removedJobs
    ? t("popup.deletedJobs", { name: removed.name, count: removedJobs })
    : t("popup.deleted", { name: removed.name });
  els.profileHint.textContent = message;
  JOB_FIT_UI.announce(message);
}

// Only the reject/warning lists. The candidate text can't be reset to a
// default that means anything once profiles exist, and domain flags are
// per-person by construction.
function setupResetKeywords() {
  JOB_FIT_UI.armConfirm($("resetKeywords"), {
    confirmLabel: t("settings.resetConfirm"),
    onConfirm: async () => {
      fillKeywordConfig("hardRejects", JOB_FIT_DEFAULTS.keywords.hardRejects);
      fillKeywordConfig("softWarnings", JOB_FIT_DEFAULTS.keywords.softWarnings);
      await flushProfileSave();
      JOB_FIT_UI.announce(t("settings.resetDone"));
      setSaveState(t("settings.resetDone"));
    },
  });
}

async function suggestSalary() {
  const btn = $("suggestSalary");
  const reasoningEl = $("salaryReasoning");
  // With no CV the model has nothing to reason from and returns a plausible
  // invented range, which is worse than no answer.
  if (!els.profileText.value.trim()) {
    reasoningEl.textContent = t("popup.salaryNeedsProfile");
    els.profileText.focus();
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
      profile: els.profileText.value,
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
    await flushProfileSave();
    reasoningEl.textContent = response.data.reasoning ? `${response.data.reasoning} ${t("popup.reviewIt")}` : t("popup.suggestedReview");
  } catch (err) {
    reasoningEl.textContent = t("common.errorDetail", { detail: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = t("popup.suggestAll");
  }
}

// --- on-page button and shortcut ------------------------------------------------

async function renderShortcut() {
  let shortcut = "";
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "evaluate-tab");
    shortcut = (cmd && cmd.shortcut) || "";
  } catch (err) {
    /* commands API unavailable */
  }
  $("shortcutKey").textContent = shortcut || t("popup.notSet");
}

function floatHost(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch (err) {
    return origin;
  }
}

async function renderFloatSites() {
  const { floatingButtonSites } = await chrome.storage.local.get("floatingButtonSites");
  const sites = Array.isArray(floatingButtonSites) ? floatingButtonSites : [];
  const list = $("floatSites");
  list.innerHTML = "";
  if (!sites.length) {
    list.appendChild(el("div", "hint", t("popup.floatNone")));
    return;
  }
  sites.forEach((site) => {
    const chip = el("span", "site-chip", floatHost(site));
    chip.setAttribute("role", "listitem");
    const x = el("button", null, "×");
    x.type = "button";
    x.title = t("popup.floatRemove", { site: floatHost(site) });
    x.setAttribute("aria-label", x.title);
    x.addEventListener("click", async () => {
      x.disabled = true;
      await sendMessageWithRetry({ type: "JOB_FIT_FLOAT_SITE", origin: site, enabled: false });
      JOB_FIT_UI.announce(t("settings.floatRemoved", { site: floatHost(site) }));
    });
    chip.appendChild(x);
    list.appendChild(chip);
  });
}

// --- language -------------------------------------------------------------------

function renderLanguagePicker() {
  const select = els.uiLanguage;
  select.innerHTML = "";
  const auto = el(
    "option",
    null,
    t("popup.languageAuto", { language: JOB_FIT_I18N.LANGUAGES.find((l) => l.code === JOB_FIT_I18N.detect()).name })
  );
  auto.value = "auto";
  select.appendChild(auto);
  JOB_FIT_I18N.LANGUAGES.forEach((l) => {
    const opt = el("option", null, l.name);
    opt.value = l.code;
    opt.lang = l.code;
    select.appendChild(opt);
  });
  select.value = JOB_FIT_I18N.setting;
  select.addEventListener("change", async () => {
    flushAll();
    await JOB_FIT_I18N.setLanguage(select.value);
    location.hash = "language";
    location.reload();
  });
}

// --- data -----------------------------------------------------------------------

function showDataStatus(text, kind = "ok") {
  const box = $("dataStatus");
  box.textContent = text;
  box.className = `status-box${kind === "ok" ? "" : ` ${kind}`}`;
  box.hidden = false;
}

function setupData() {
  $("exportData").addEventListener("click", async () => showDataStatus(await JOB_FIT_BACKUP.exportAll()));
  $("importData").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so picking the same file twice still fires
    if (!file) return;
    const result = await JOB_FIT_BACKUP.importFile(file);
    showDataStatus(result.text, result.ok ? "ok" : "error");
    if (result.ok) await reloadProfiles();
  });
  $("probeReport").addEventListener("click", async () => {
    const report = await JOB_FIT_BACKUP.probeReport();
    showDataStatus(report.text, "neutral");
  });
}

// --- navigation: the rail follows the page, and deep links land on a section --------

function setupRail() {
  const links = Array.from(document.querySelectorAll(".rail a[href^='#']"));
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id)));
      // The first section in page order that's in the band, so the highlight
      // moves as you scroll rather than jumping between two that share it.
      const first = links.map((a) => a.getAttribute("href").slice(1)).find((id) => visible.has(id));
      if (!first) return;
      links.forEach((a) => a.removeAttribute("aria-current"));
      byId.get(first).setAttribute("aria-current", "true");
    },
    { rootMargin: "-90px 0px -55% 0px" }
  );
  byId.forEach((_, id) => observer.observe($(id)));
  links.forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      jumpTo(a.getAttribute("href").slice(1));
    })
  );
}

// Scrolls to a section and moves focus to its heading, so keyboard and
// screen-reader users land where the link said.
function jumpTo(section) {
  const target = $(section);
  if (!target || !target.classList.contains("card")) return;
  history.replaceState(null, "", `#${section}`);
  target.scrollIntoView({ block: "start" });
  const heading = target.querySelector("h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

async function consumeJump() {
  const { settingsJump } = await chrome.storage.local.get("settingsJump");
  if (!settingsJump) return false;
  await chrome.storage.local.remove("settingsJump");
  if (Date.now() - settingsJump.ts > 15000) return false;
  jumpTo(settingsJump.section);
  return true;
}

// --- keeping up with other tabs ---------------------------------------------------

// A field someone is typing in is never refilled under them; the refresh
// waits until focus leaves it.
function editingInside(container) {
  const active = document.activeElement;
  return Boolean(active && container.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

let pendingProfileRefresh = false;
let pendingModelRefresh = false;

async function reloadProfiles() {
  store = await JOB_FIT_PROFILES.load();
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
}

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.profiles || changes.activeProfileId) {
      const profiles = changes.profiles ? changes.profiles.newValue : store.profiles;
      const activeId = changes.activeProfileId ? changes.activeProfileId.newValue : store.activeProfileId;
      const ours = JSON.stringify(profiles) === JSON.stringify(store.profiles) && activeId === store.activeProfileId;
      if (!ours) {
        const perProfile = ["profile", "salary", "screening"].map($);
        if (perProfile.some(editingInside)) pendingProfileRefresh = true;
        else reloadProfiles();
      }
    }
    const foreignModelChange = MODEL_KEYS.some(
      (k) => changes[k] && JSON.stringify(changes[k].newValue) !== lastModelWrite[k]
    );
    if (foreignModelChange && !modelSaveTimer) {
      if (editingInside($("model"))) pendingModelRefresh = true;
      else fillModelFields().then(scheduleModelCheck);
    }
    if (changes.floatingButtonSites) renderFloatSites();
    if (changes.usageByDay || changes.openaiBudgetReset) renderUsage();
    if (changes.evalStats) renderTimingHint();
    if (changes.settingsJump && changes.settingsJump.newValue) consumeJump();
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (pendingProfileRefresh && !["profile", "salary", "screening"].map($).some(editingInside)) {
        pendingProfileRefresh = false;
        reloadProfiles();
      }
      if (pendingModelRefresh && !editingInside($("model"))) {
        pendingModelRefresh = false;
        fillModelFields().then(scheduleModelCheck);
      }
    }, 0);
  });
  // Another page switched the language: follow it.
  JOB_FIT_I18N.watch(() => {
    flushAll();
    location.reload();
  });
}

// --- start ----------------------------------------------------------------------

function wireProfileButtons() {
  els.profileSelect.addEventListener("change", (e) => switchProfile(e.target.value));
  // New profiles go through the setup wizard: a blank profile has no CV, no
  // salary and no domain flags, and the wizard is what walks through them.
  $("profileNew").addEventListener("click", async () => {
    await flushProfileSave();
    openSetupWizard({ mode: "new" });
  });
  $("profileWizard").addEventListener("click", async () => {
    await flushProfileSave();
    openSetupWizard({ mode: "edit", profile: activeProfile().id });
  });
  $("setupContinue").addEventListener("click", async () => {
    await flushProfileSave();
    openSetupWizard({ profile: activeProfile().id, resume: "1" });
  });
  $("profileDuplicate").addEventListener("click", () => {
    pendingFocusBack = "profileDuplicate";
    askForName("duplicate", t("popup.copyName", { name: activeProfile().name }));
  });
  $("profileRename").addEventListener("click", () => {
    pendingFocusBack = "profileRename";
    askForName("rename", activeProfile().name);
  });
  $("profileNameOk").addEventListener("click", confirmNamePrompt);
  $("profileNameCancel").addEventListener("click", cancelNamePrompt);
  els.profileNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmNamePrompt();
    if (e.key === "Escape") cancelNamePrompt();
  });
  setupProfileDelete();
}

async function init() {
  await JOB_FIT_I18N.load();
  JOB_FIT_I18N.translatePage();
  document.title = `${t("settings.title")} — JobFit`;

  renderPresetCheckboxes();
  store = await JOB_FIT_PROFILES.load();
  renderProfileSelect();
  fillFormFromProfile(activeProfile());
  await fillModelFields();
  if (els.modelProvider.value === "openai") loadOpenAiModels();

  watchFields();
  wireProfileButtons();
  setupResetKeywords();
  setupData();
  renderLanguagePicker();
  renderShortcut();
  renderFloatSites();
  renderTimingHint();
  checkModel();
  $("changeShortcut").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  setupRail();
  watchStorage();
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });

  // After load: focus moved before the document finishes loading is reset,
  // and the jump's whole point is where focus lands.
  if (document.readyState !== "complete") await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
  const jumped = await consumeJump();
  if (!jumped && location.hash) jumpTo(location.hash.slice(1));
  setSaveState(t("wiz.allSaved"));
}

init();
