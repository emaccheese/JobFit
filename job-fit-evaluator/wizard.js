// The setup wizard: a guided pass over everything a profile needs, in the
// order the pieces depend on each other — language and location first (they
// pre-fill what follows), then who you are and where you can work, then the
// model (drafting the CV and every suggestion needs it), then the CV, then
// what's derived from the CV.
//
// A tab rather than the popup, for the same reason as history.html: the popup
// destroys itself whenever focus moves, and a step that asks you to paste a CV
// from another window would lose it every time.
//
// Every change is written to the real stores as you go. There is no draft copy
// to commit at the end, so closing the tab early loses nothing, and the popup's
// "Continue setup" banner picks up where you stopped.

const ALL_STEPS = ["welcome", "where", "about", "work", "model", "profile", "salary", "rejects", "warnings", "flags", "review"];

// Built to exercise every part of the result — a required section, a
// preferred section, a stated salary, a location, and a sponsorship line
// phrased so the default hard rejects don't fire on it.
const SAMPLE_POSTING = `Senior Software Engineer, Platform
Northwind Robotics
Location: Austin, TX (hybrid)

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

const AUTH_VALUES = ["citizen", "permit", "sponsor"];
const ARRANGEMENTS = ["remote", "hybrid", "onsite"];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// A new profile that has no name yet isn't in storage, so switching language
// (which reloads the page) keeps it here for the reload.
const DRAFT_KEY = "jobfitWizardDraft";

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
  detected: null,
  locationSkipped: false,
  salaryMarkets: null,
};

// --- small helpers ---------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className) {
  const b = el("button", className || null, label);
  b.type = "button";
  return b;
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
  return JOB_FIT_I18N.formatNumber(n);
}

function stepIndex(key) {
  return state.steps.findIndex((s) => s.key === key);
}

function currentKey() {
  return state.steps[state.index].key;
}

function stepTitle(key) {
  return t(`wiz.step.${key}`);
}

function callout(kind, children) {
  const box = el("div", `callout ${kind}`);
  (Array.isArray(children) ? children : [children]).forEach((c) =>
    box.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return box;
}

function jobSearch() {
  if (!state.profile.jobSearch) state.profile.jobSearch = JOB_FIT_PROFILES.blankJobSearch();
  return state.profile.jobSearch;
}

function answers() {
  if (!state.profile.setupAnswers) state.profile.setupAnswers = {};
  return state.profile.setupAnswers;
}

function countryName(code) {
  return JOB_FIT_I18N.countryName(code);
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
  const model = activeModelSettings().model || (state.provider === "openai" ? JOB_FIT_DEFAULTS.openai.model : "");
  return (model || "").trim();
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
    if (state.persisted) throw new Error(t("wiz.deletedElsewhere"));
    store.profiles.push(copy);
  } else {
    store.profiles[index] = copy;
  }
  if (activate) store.activeProfileId = state.profile.id;
  await JOB_FIT_PROFILES.save(store);
  state.persisted = true;
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch (err) {
    /* nothing kept */
  }
}

async function saveNow() {
  clearTimeout(saveTimer);
  collectCurrent();
  if (!state.persisted) {
    // Not saved until it has a name; kept for a language-switch reload.
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.profile));
    } catch (err) {
      /* private mode: a reload starts over */
    }
  }
  if (!state.modelDirty && !state.persisted) return;
  setSaveState(t("wiz.saving"));
  try {
    if (state.modelDirty) {
      await chrome.storage.local.set(modelSettingsToStore());
      state.modelDirty = false;
    }
    if (state.persisted) await saveProfile();
    setSaveState(t("wiz.allSaved"));
  } catch (err) {
    setSaveState(t("wiz.couldntSave", { error: err.message }), true);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState(t("wiz.saving"));
  saveTimer = setTimeout(saveNow, 400);
}

// Only while setup is unfinished: it's what lets the popup's "Continue setup"
// reopen at the right step. A finished profile re-run from settings has
// nothing to resume. Steps are saved by key, so adding a step to the wizard
// doesn't send a half-finished setup back to the wrong one.
async function saveProgress() {
  if (!state.persisted || !state.profile.setupIncomplete) return;
  const stored = await chrome.storage.local.get("wizardProgress");
  const all = stored.wizardProgress || {};
  all[state.profile.id] = {
    mode: state.mode,
    step: state.index,
    furthest: state.furthest,
    stepKey: currentKey(),
    furthestKey: state.steps[state.furthest].key,
  };
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
async function modelCall(message, statusHost, { button: trigger, busyText }) {
  const callId = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  statusHost.innerHTML = "";

  const busy = el("div", "busy");
  busy.appendChild(el("span", "spinner"));
  const label = el("span", null, busyText);
  busy.appendChild(label);
  const cancel = button(t("common.cancel"), "link");
  busy.appendChild(cancel);
  statusHost.appendChild(busy);

  const tick = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    label.textContent = `${busyText} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
  cancel.addEventListener("click", () => {
    label.textContent = t("wiz.cancelling");
    cancel.disabled = true;
    sendMessageWithRetry({ type: "JOB_FIT_CANCEL_CALL", callId }).catch(() => {});
  });

  if (trigger) trigger.disabled = true;
  let response;
  try {
    response = await sendMessageWithRetry({ ...message, callId });
  } catch (err) {
    response = { ok: false, error: err.message };
  } finally {
    clearInterval(tick);
    if (trigger) trigger.disabled = false;
    statusHost.innerHTML = "";
  }

  if (!response || !response.ok) {
    if (response && response.failure === "cancelled") return null;
    statusHost.appendChild(el("div", "error-text", (response && response.error) || t("wiz.noAnswer")));
    return null;
  }
  return response;
}

// --- language --------------------------------------------------------------

function fillLanguageSelect(select) {
  select.innerHTML = "";
  const detected = JOB_FIT_I18N.LANGUAGES.find((l) => l.code === JOB_FIT_I18N.detect());
  const auto = el("option", null, t("popup.languageAuto", { language: detected ? detected.name : "English" }));
  auto.value = "auto";
  select.appendChild(auto);
  JOB_FIT_I18N.LANGUAGES.forEach((l) => {
    const opt = el("option", null, l.name);
    opt.value = l.code;
    select.appendChild(opt);
  });
  select.value = JOB_FIT_I18N.setting;
}

// Every string on the page is drawn at load, so a new language means a
// reload — back to the same step, with everything already saved.
async function switchLanguage(value) {
  await saveNow();
  await JOB_FIT_I18N.setLanguage(value);
  const next = new URLSearchParams(location.search);
  next.set("mode", state.mode);
  if (state.persisted) next.set("profile", state.profile.id);
  next.set("step", currentKey());
  location.replace(`${location.pathname}?${next.toString()}`);
}

// --- step: language and location -------------------------------------------

function fillCountrySelect(select, { emptyLabel }) {
  select.innerHTML = "";
  const none = el("option", null, emptyLabel);
  none.value = "";
  select.appendChild(none);
  JOB_FIT_GEO.countryOptions().forEach(({ code, name }) => {
    const opt = el("option", null, name);
    opt.value = code;
    select.appendChild(opt);
  });
}

function fillRegionSelect(country, selected) {
  const regions = JOB_FIT_GEO.regionsOf(country);
  $("homeRegionField").hidden = !regions.length;
  const select = $("homeRegion");
  select.innerHTML = "";
  const none = el("option", null, "—");
  none.value = "";
  select.appendChild(none);
  regions.forEach(({ code, name }) => {
    const opt = el("option", null, name);
    opt.value = code;
    select.appendChild(opt);
  });
  select.value = regions.some((r) => r.code === selected) ? selected : "";
}

function showLocationFields(home) {
  $("locationFields").hidden = false;
  $("homeCountry").value = home.country || "";
  fillRegionSelect(home.country, home.region);
  $("homeCity").value = home.city || "";
}

function placeOf(home) {
  return JOB_FIT_GEO.placeText({ city: home.city, region: home.region, country: home.country });
}

// Detected, never assumed: the guess is offered with Yes / Change / Skip, and
// nothing is saved until one is pressed.
function renderDetect() {
  const box = $("detectBox");
  box.innerHTML = "";
  const home = jobSearch().home;

  if (home.country) {
    showLocationFields(home);
    return;
  }
  if (state.locationSkipped) {
    $("locationFields").hidden = true;
    const row = el("div", "detect");
    row.appendChild(el("span", "grow hint", t("wiz.where.skipped")));
    const set = button(t("wiz.where.setIt"), "link");
    set.addEventListener("click", () => {
      state.locationSkipped = false;
      showLocationFields(state.detected && state.detected.country ? state.detected : { country: null });
      box.innerHTML = "";
      $("homeCountry").focus();
    });
    row.appendChild(set);
    box.appendChild(row);
    return;
  }

  const found = state.detected;
  if (!found || !found.country) {
    box.appendChild(callout("info", t("wiz.where.notDetected")));
    showLocationFields({ country: null });
    return;
  }

  $("locationFields").hidden = true;
  const row = el("div", "detect");
  row.appendChild(el("span", "grow", t("wiz.where.detected", { place: placeOf(found) })));
  const yes = button(t("wiz.where.yes"), "primary");
  yes.addEventListener("click", () => {
    Object.assign(jobSearch().home, { country: found.country, region: found.region, timeZone: found.timeZone });
    box.innerHTML = "";
    box.appendChild(callout("ok", t("wiz.where.confirmed")));
    showLocationFields(jobSearch().home);
    $("homeCity").focus();
    scheduleSave();
    updateNav();
  });
  const change = button(t("common.change"));
  change.addEventListener("click", () => {
    box.innerHTML = "";
    showLocationFields(found);
    collectWhere();
    scheduleSave();
    $("homeCountry").focus();
  });
  const skip = button(t("wiz.where.skip"), "link");
  skip.addEventListener("click", () => {
    state.locationSkipped = true;
    renderDetect();
  });
  row.appendChild(yes);
  row.appendChild(change);
  row.appendChild(skip);
  box.appendChild(callout("info", row));
}

function enterWhere() {
  fillLanguageSelect($("uiLanguage"));
  fillCountrySelect($("homeCountry"), { emptyLabel: t("wiz.where.noCountry") });
  if (!state.detected) state.detected = JOB_FIT_GEO.detectHome();
  renderDetect();
}

function collectWhere() {
  if ($("locationFields").hidden) return;
  const home = jobSearch().home;
  const country = $("homeCountry").value || null;
  if (country !== home.country) {
    home.region = null;
    fillRegionSelect(country, null);
  } else {
    home.region = $("homeRegion").value || null;
  }
  home.country = country;
  home.city = $("homeCity").value.trim();
  // The time zone is the computer's: it's where you are when you use this.
  home.timeZone = country ? home.timeZone || JOB_FIT_GEO.browserTimeZone() : null;
}

// --- step: about you (name, countries, work authorization) -----------------

// Older profiles answered three US-only questions; their answers seed the
// new per-country ones the first time, and so does where you live.
function seedTargets() {
  const js = jobSearch();
  const a = answers();
  if (a.targetsSeeded || js.targetCountries.length) return;
  a.targetsSeeded = true;
  if (a.citizen) {
    js.targetCountries = ["US"];
    js.workAuth.US = a.citizen === "yes" ? "citizen" : a.sponsorship === "no" ? "permit" : "sponsor";
  } else if (js.home.country) {
    js.targetCountries = [js.home.country];
    // "Allowed to work there" is the honest default for where you live; it's
    // shown selected, so it's a question you confirm rather than an assumption.
    js.workAuth[JOB_FIT_GEO.authCountry(js.home.country)] = "permit";
  }
  applyAuthRules();
}

function pillCountries() {
  const js = jobSearch();
  const pills = [...JOB_FIT_GEO.QUICK_PICKS];
  if (js.home.country && !pills.includes(js.home.country)) pills.push(js.home.country);
  return pills;
}

function renderTargets() {
  const js = jobSearch();
  const quick = $("targetQuick");
  quick.innerHTML = "";
  pillCountries().forEach((code) => {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.name = "target";
    box.value = code;
    box.checked = js.targetCountries.includes(code);
    label.appendChild(box);
    label.appendChild(el("span", null, countryName(code)));
    quick.appendChild(label);
  });

  const extra = $("targetExtra");
  extra.innerHTML = "";
  js.targetCountries
    .filter((c) => !pillCountries().includes(c))
    .forEach((code) => {
      const chip = el("span", "chip", countryName(code));
      const x = button("×");
      x.setAttribute("aria-label", t("wiz.remove", { name: countryName(code) }));
      x.addEventListener("click", () => setTarget(code, false));
      chip.appendChild(x);
      extra.appendChild(chip);
    });

  const add = $("addCountry");
  add.innerHTML = "";
  const first = el("option", null, t("wiz.about.addCountry"));
  first.value = "";
  add.appendChild(first);
  JOB_FIT_GEO.countryOptions()
    .filter(({ code }) => !pillCountries().includes(code) && !js.targetCountries.includes(code))
    .forEach(({ code, name }) => {
      const opt = el("option", null, name);
      opt.value = code;
      add.appendChild(opt);
    });

  renderAuthRows();
}

function renderAuthRows() {
  const js = jobSearch();
  const host = $("authRows");
  host.innerHTML = "";
  // Puerto Rico is answered as the United States.
  const countries = Array.from(new Set(js.targetCountries.map(JOB_FIT_GEO.authCountry)));
  countries.forEach((code) => {
    const box = el("div", "auth-country");
    box.appendChild(el("span", "field-label", t("wiz.about.authIn", { country: countryName(code) })));
    const choices = el("div", "choices");
    AUTH_VALUES.forEach((value) => {
      const label = el("label");
      const radio = el("input");
      radio.type = "radio";
      radio.name = `auth-${code}`;
      radio.value = value;
      radio.checked = js.workAuth[code] === value;
      label.appendChild(radio);
      label.appendChild(el("span", null, t(`auth.${value}`)));
      choices.appendChild(label);
    });
    box.appendChild(choices);
    host.appendChild(box);
  });
  const missing = countries.filter((c) => !js.workAuth[c]);
  if (missing.length) host.appendChild(el("div", "hint", t("wiz.about.answerEach")));
  if (!countries.length) host.appendChild(el("div", "hint", t("wiz.about.noCountries")));
}

function setTarget(code, on) {
  const js = jobSearch();
  const has = js.targetCountries.includes(code);
  if (on && !has) js.targetCountries.push(code);
  if (!on && has) js.targetCountries = js.targetCountries.filter((c) => c !== code);
  // Answers for a country no longer targeted are dropped, so they can't keep
  // ticking a reject category nobody can see the reason for.
  const kept = new Set(js.targetCountries.map(JOB_FIT_GEO.authCountry));
  Object.keys(js.workAuth).forEach((c) => {
    if (!kept.has(c)) delete js.workAuth[c];
  });
  applyAuthRules();
  renderTargets();
  scheduleSave();
  updateNav();
}

function enterAbout() {
  $("profileName").value = state.profile.name || "";
  seedTargets();
  renderTargets();
}

function authAnswered() {
  const js = jobSearch();
  return js.targetCountries.map(JOB_FIT_GEO.authCountry).every((c) => js.workAuth[c]);
}

// --- automatic hard-reject categories ---------------------------------------

// Each rule owns some hard-reject categories and is recomputed from the
// answers whenever they change. Only the categories a changed answer owns are
// touched, so a category ticked by hand survives edits to unrelated answers.
// The categories are also gated by country at screening time (screening.js);
// ticking them here is what makes the Hard rejects step say why.
const AUTH_RULES = {
  sponsorship: {
    presets: ["sponsorship"],
    countries: (js) => js.targetCountries.map(JOB_FIT_GEO.authCountry).filter((c) => js.workAuth[c] === "sponsor"),
    reason: (countries) => t("wiz.why.sponsorship", { countries }),
  },
  citizenship: {
    presets: ["citizenship", "clearance"],
    countries: (js) =>
      js.targetCountries.map(JOB_FIT_GEO.authCountry).filter((c) => js.workAuth[c] && js.workAuth[c] !== "citizen"),
    reason: (countries) => t("wiz.why.citizenship", { countries }),
  },
  usPerson: {
    presets: ["itar"],
    countries: (js) => (js.targetCountries.map(JOB_FIT_GEO.authCountry).includes("US") && js.workAuth.US && js.workAuth.US !== "citizen" ? ["US"] : []),
    reason: () => t("wiz.why.usPerson"),
  },
  relocate: {
    presets: ["relocation"],
    countries: (js) => (js.relocate === "no" ? ["-"] : []),
    reason: () => t("wiz.why.relocate"),
    answered: (js) => Boolean(js.relocate),
  },
};

function ruleState(rule, js) {
  return rule.countries(js).filter((c, i, all) => all.indexOf(c) === i);
}

// Recomputes the rules whose outcome changed since the last time.
function applyAuthRules() {
  const js = jobSearch();
  const a = answers();
  const last = a.ruleState || {};
  const config = state.profile.keywords.hardRejects;
  const ticked = new Set(config.presets || []);
  Object.entries(AUTH_RULES).forEach(([name, rule]) => {
    if (rule.answered && !rule.answered(js)) return;
    const on = ruleState(rule, js).length > 0;
    if (last[name] === on) return;
    rule.presets.forEach((id) => (on ? ticked.add(id) : ticked.delete(id)));
    last[name] = on;
  });
  a.ruleState = last;
  // Kept in the order the categories are listed, so the review reads naturally.
  config.presets = JOB_FIT_KEYWORDS.presetsFor("hardRejects")
    .map((p) => p.id)
    .filter((id) => ticked.has(id));
}

// Which answer, if any, is the reason a hard-reject category is ticked.
function reasonFor(presetId) {
  const js = jobSearch();
  for (const rule of Object.values(AUTH_RULES)) {
    if (!rule.presets.includes(presetId)) continue;
    const countries = ruleState(rule, js);
    if (countries.length) return rule.reason(JOB_FIT_I18N.list(countries.filter((c) => c !== "-").map(countryName)));
  }
  return null;
}

// The work-authorization line for the CV template and the profile draft, in
// the user's language: "Mexico: citizen or permanent resident; United States:
// would need visa sponsorship. Won't relocate at own cost."
function authorisationSentence() {
  const js = jobSearch();
  const parts = Object.entries(js.workAuth)
    .filter(([c]) => js.targetCountries.map(JOB_FIT_GEO.authCountry).includes(c))
    .map(([c, v]) => `${countryName(c)}: ${t(`auth.${v}`).toLowerCase()}`);
  let text = parts.join("; ");
  if (js.relocate) text += `${text ? ". " : ""}${t(js.relocate === "yes" ? "wiz.sentence.relocateYes" : "wiz.sentence.relocateNo")}`;
  if (!text) return "";
  return text.endsWith(".") ? text : `${text}.`;
}

// --- step: work preferences --------------------------------------------------

function seedWork() {
  const js = jobSearch();
  const a = answers();
  if (a.workSeeded) return;
  a.workSeeded = true;
  if (!js.arrangements.length) js.arrangements = [...ARRANGEMENTS];
  if (!js.relocate && ["yes", "no"].includes(a.relocate)) js.relocate = a.relocate;
  if (!js.languages.length) {
    const home = js.home.country ? (JOB_FIT_GEO.info(js.home.country) || {}).languages || [] : [];
    js.languages = Array.from(new Set([...home, JOB_FIT_I18N.lang])).filter((l) => JOB_FIT_I18N.CODES.includes(l));
  }
  applyAuthRules();
}

function renderLanguageChoices() {
  const host = $("languageChoices");
  host.innerHTML = "";
  JOB_FIT_I18N.CODES.forEach((code) => {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.name = "workLanguage";
    box.value = code;
    box.checked = jobSearch().languages.includes(code);
    label.appendChild(box);
    label.appendChild(el("span", null, JOB_FIT_I18N.languageName(code)));
    host.appendChild(label);
  });
}

function timeZoneText(tz) {
  if (!tz) return t("wiz.work.noTimeZone");
  const offset = JOB_FIT_GEO.standardOffset(tz);
  if (offset == null) return tz;
  const sign = offset < 0 ? "−" : "+";
  return `${tz.replace(/_/g, " ")} (UTC${sign}${Math.abs(offset)})`;
}

function enterWork() {
  seedWork();
  const js = jobSearch();
  document.querySelectorAll('input[name="arrangement"]').forEach((box) => (box.checked = js.arrangements.includes(box.value)));
  document.querySelectorAll('input[name="relocate"]').forEach((radio) => (radio.checked = radio.value === js.relocate));
  renderLanguageChoices();
  $("tzLine").textContent = timeZoneText(js.home.timeZone || JOB_FIT_GEO.browserTimeZone());
  $("shareLocation").checked = Boolean(js.shareLocation);
  $("shareLocation").disabled = !js.home.country;
}

function collectWork() {
  const js = jobSearch();
  js.arrangements = Array.from(document.querySelectorAll('input[name="arrangement"]:checked')).map((b) => b.value);
  const relocate = document.querySelector('input[name="relocate"]:checked');
  js.relocate = relocate ? relocate.value : js.relocate;
  js.languages = Array.from(document.querySelectorAll('input[name="workLanguage"]:checked')).map((b) => b.value);
  js.shareLocation = $("shareLocation").checked;
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
    host.appendChild(callout("info", t("wiz.model.pasteKey")));
    return;
  }
  if (probe.reason === "unauthorized") {
    host.appendChild(callout("bad", t("wiz.model.badKey")));
    return;
  }
  if (openai && !probe.ok) {
    host.appendChild(callout("bad", t("wiz.model.oaUnreachable")));
    return;
  }
  if (probe.reason === "invalid-url") {
    host.appendChild(callout("bad", t("wiz.model.badUrl")));
    return;
  }
  if (!probe.ok) {
    const steps = el("ol");
    ["wiz.model.lmStep1", "wiz.model.lmStep2", "wiz.model.lmStep3"].forEach((k) => steps.appendChild(el("li", null, t(k))));
    const retry = button(t("wiz.model.testAgain"));
    retry.style.marginTop = "8px";
    retry.addEventListener("click", testConnection);
    host.appendChild(callout("bad", [el("strong", null, t("wiz.model.lmUnreachable", { url: probe.url })), steps, retry]));
    return;
  }
  if (!probe.models.length) {
    host.appendChild(callout("warn", openai ? t("wiz.model.oaNoModels") : t("wiz.model.lmNoModels")));
    return;
  }

  host.appendChild(callout("ok", openai ? t("wiz.model.oaConnected") : t("wiz.model.lmConnected")));
  $("modelPickerHint").textContent = openai ? t("wiz.model.oaPickerHint") : t("wiz.model.lmPickerHint");
  const list = $("modelList");
  list.innerHTML = "";
  const wanted = activeModel();
  if (wanted && !probe.models.includes(wanted)) {
    host.appendChild(el("div", "hint", t("wiz.model.gone", { model: wanted })));
  }
  // Preselected, not saved: it's written when you leave this step, so merely
  // opening the wizard never changes the model other profiles are using.
  // For OpenAI: the default tier if the key has it, else the first tier it
  // has, else the first model — never whatever happens to sort first, which
  // is often an expensive one.
  const tiers = openai ? JOB_FIT_DEFAULTS.openaiTiers || [] : [];
  const tierModels = tiers.map((tier) => tier.model).filter((m) => probe.models.includes(m));
  const fallback = tierModels.includes(JOB_FIT_DEFAULTS.openai.model)
    ? JOB_FIT_DEFAULTS.openai.model
    : tierModels[0] || probe.models[0];
  const chosen = probe.models.includes(wanted) ? wanted : fallback;
  if (chosen !== wanted) {
    activeModelSettings().model = chosen;
    state.modelDirty = true;
  }

  const addRow = (parent, id, labelNode, disabled) => {
    const row = el("label");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "lmModel";
    radio.value = id;
    radio.checked = id === chosen;
    radio.disabled = Boolean(disabled);
    row.appendChild(radio);
    row.appendChild(labelNode);
    if (disabled) row.style.opacity = ".5";
    parent.appendChild(row);
  };

  if (openai) {
    // Three tiers, each with a rough cost, instead of a raw list of ids.
    tiers.forEach((tier) => {
      const onKey = probe.models.includes(tier.model);
      const text = el("span", "tier-text");
      const recommended = tier.model === JOB_FIT_DEFAULTS.openai.model ? ` ${t("wiz.model.recommended")}` : "";
      text.appendChild(el("strong", null, `${t(`tier.${tier.id}.label`)}${recommended}`));
      text.appendChild(el("span", "tier-model", tier.model));
      text.appendChild(
        el(
          "span",
          "tier-blurb",
          onKey
            ? `${t(`tier.${tier.id}.blurb`)} ${t("popup.perHundred", { cost: JOB_FIT_PROVIDER.formatDollars(JOB_FIT_PROVIDER.costPer100(tier)) })}`
            : t("wiz.model.notOnKey")
        )
      );
      addRow(list, tier.model, text, !onKey);
    });
    const others = probe.models.filter((m) => !tiers.some((tier) => tier.model === m));
    if (others.length) {
      const more = el("details", "other-models");
      more.open = !tiers.some((tier) => tier.model === chosen);
      more.appendChild(el("summary", null, t("wiz.model.otherModels", { count: others.length })));
      const inner = el("div", "model-list");
      others.forEach((id) => addRow(inner, id, document.createTextNode(id)));
      more.appendChild(inner);
      list.appendChild(more);
    }
  } else {
    probe.models.forEach((id) => addRow(list, id, document.createTextNode(id)));
  }
  $("modelPicker").hidden = false;
  state.modelOk = true;
  if (openai) renderOaReasoning();
}

async function testConnection() {
  collectModel();
  const trigger = state.provider === "openai" ? $("testOpenAi") : $("testConnection");
  const label = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = t("wiz.model.testing");
  const probe = await probeModels(resolvedSettings(), 4000);
  trigger.disabled = false;
  trigger.textContent = label;
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
  const model = state.oa.model || JOB_FIT_DEFAULTS.openai.model || "";
  const allowed = JOB_FIT_PROVIDER.reasoningEffortsFor(model);
  $("oaReasoningField").hidden = !allowed.length;
  const select = $("oaReasoning");
  select.innerHTML = "";
  ["", ...allowed].forEach((value) => {
    const opt = el("option", null, value || t("popup.modelDefault"));
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
  $("oaFlex").value = ["bulk", "always", "never"].includes(state.oa.flex) ? state.oa.flex : "bulk";
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
  state.oa.flex = $("oaFlex").value;
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

// --- step: profile ---------------------------------------------------------

// Section labels in every language JobFit has, so a profile drafted in
// Spanish and one written in English are both recognised.
function labelPattern(id) {
  const labels = new Set([`profileLabel.${id}`].flatMap((key) => Object.values(JOB_FIT_MESSAGES).map((cat) => cat[key]).filter(Boolean)));
  if (id === "workAuth") labels.add("Work authorization");
  const alternatives = Array.from(labels)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^\\s*(?:${alternatives})\\s*:(.*)$`, "im");
}

const PROFILE_SECTIONS = ["core", "gaps", "workAuth", "target"];

function template() {
  return JOB_FIT_I18N.has("profile.template") ? t("profile.template") : JOB_FIT_DEFAULTS.profile;
}

function templateWithAnswers() {
  const sentence = authorisationSentence();
  const text = template();
  if (!sentence) return text;
  return text.replace(labelPattern("workAuth"), (line) => `${line.split(":")[0]}: ${sentence}`);
}

// The untouched template (in any language, with or without the answers
// filled in) isn't a profile — scoring against it would produce confident,
// meaningless numbers.
function isPlaceholderProfile(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  const templates = [JOB_FIT_DEFAULTS.profile, templateWithAnswers(), ...Object.values(JOB_FIT_MESSAGES).map((cat) => cat["profile.template"])];
  return templates.filter(Boolean).some((tpl) => tpl.trim() === value);
}

function renderProfileMeter() {
  const text = $("profileText").value;
  const meter = $("profileMeter");
  meter.innerHTML = "";
  const words = wordCount(text);
  const count = el("span", "count", t("wiz.profile.words", { count: words }));
  if (words > 600) count.classList.add("way-over");
  else if (words > 400) count.classList.add("over");
  meter.appendChild(count);
  PROFILE_SECTIONS.forEach((id) =>
    meter.appendChild(el("span", `sec${labelPattern(id).test(text) ? " has" : ""}`, t(`profileLabel.${id}`)))
  );

  const gapsLine = text.match(labelPattern("gaps"));
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
    status.appendChild(el("div", "error-text", t("wiz.profile.pasteFirst")));
    $("cvText").focus();
    return;
  }
  const response = await modelCall(
    { type: "JOB_FIT_DRAFT_PROFILE", cv, answersText: authorisationSentence() },
    status,
    { button: $("draftProfile"), busyText: t("wiz.profile.drafting") }
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
    const undo = button(t("wiz.profile.restorePrevious"), "link");
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

// The country a currency is being used for: a target country that pays in
// it, else the first country that does.
function countryForCurrency(currency) {
  return (
    jobSearch().targetCountries.find((c) => JOB_FIT_GEO.currencyOf(c) === currency) ||
    JOB_FIT_GEO.CODES.find((c) => JOB_FIT_GEO.currencyOf(c) === currency) ||
    null
  );
}

function defaultPeriod(currency) {
  const country = countryForCurrency(currency);
  return country ? JOB_FIT_GEO.periodOf(country) : "year";
}

function hasFigures(range) {
  return Boolean(range && (range.min != null || range.max != null));
}

// Offered: the currencies of your target countries, USD (remote roles for US
// companies are paid in it wherever you are), and any that already hold
// figures. With no countries chosen, the original three.
function salaryCurrencies() {
  const list = [];
  const add = (c) => c && !list.includes(c) && list.push(c);
  jobSearch().targetCountries.forEach((c) => add(JOB_FIT_GEO.currencyOf(c)));
  if (!list.length) ["USD", "CAD", "MXN"].forEach(add);
  add("USD");
  Object.entries(state.profile.expectedSalary || {}).forEach(([c, r]) => hasFigures(r) && add(c));
  return list;
}

function renderSalary() {
  const currencies = salaryCurrencies();
  const salary = state.profile.expectedSalary || {};
  const withValues = currencies.filter((c) => hasFigures(salary[c]));
  const targetCurrencies = jobSearch().targetCountries.map(JOB_FIT_GEO.currencyOf).filter(Boolean);
  const markets = state.salaryMarkets || (withValues.length ? withValues : targetCurrencies.length ? targetCurrencies : ["USD"]);

  const marketsHost = $("markets");
  marketsHost.innerHTML = "";
  const rows = $("salaryRows");
  rows.innerHTML = "";
  currencies.forEach((cur) => {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.value = cur;
    box.checked = markets.includes(cur);
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${cur}`));
    marketsHost.appendChild(label);

    const range = salary[cur] || {};
    const row = el("div", "salary-row");
    row.dataset.currency = cur;
    row.appendChild(el("span", "cur", cur));
    ["min", "max"].forEach((end) => {
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1000";
      input.placeholder = t(end === "min" ? "common.min" : "common.max");
      input.id = `salary${cur}${end}`;
      input.value = range[end] ?? "";
      row.appendChild(input);
    });
    const period = el("select");
    period.id = `salary${cur}period`;
    ["year", "month", "hour"].forEach((value) => {
      const opt = el("option", null, t(`period.${value}`));
      opt.value = value;
      period.appendChild(opt);
    });
    period.value = hasFigures(range) && range.period ? range.period : defaultPeriod(cur);
    row.appendChild(period);
    rows.appendChild(row);
  });
  syncSalaryRows();
}

function enterSalary() {
  state.salaryMarkets = null;
  renderSalary();
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
    const period = $(`salary${cur}period`).value;
    if (min !== "" && max !== "" && Number(min) > Number(max)) problems.push(t("wiz.salary.minOverMax", { currency: cur }));
    [min, max].forEach((v) => {
      if (period === "year" && v !== "" && Number(v) > 0 && Number(v) < 1000) suspicious = true;
    });
  });
  $("salaryError").hidden = !problems.length;
  $("salaryError").textContent = problems.join(" ");
  $("salaryWarn").hidden = !suspicious;
  $("salaryWarn").textContent = suspicious ? t("wiz.salary.suspicious") : "";
  return !problems.length;
}

// Unticked markets are saved as empty, which already means "unknown" to the
// salary comparison. The inputs keep their values, so re-ticking a market you
// unticked by mistake brings the numbers back.
function collectSalary() {
  if (!$("markets").childElementCount) return;
  const markets = checkedMarkets();
  const out = {};
  document.querySelectorAll(".salary-row").forEach((row) => {
    const cur = row.dataset.currency;
    const read = (end) => {
      const v = $(`salary${cur}${end}`).value;
      return !markets.includes(cur) || v === "" ? null : Number(v);
    };
    out[cur] = { min: read("min"), max: read("max"), period: $(`salary${cur}period`).value };
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
    status.appendChild(el("div", "error-text", t("wiz.salary.needsProfile")));
    return;
  }
  const markets = checkedMarkets();
  if (!markets.length) {
    status.appendChild(el("div", "error-text", t("wiz.salary.tickOne")));
    return;
  }
  const response = await modelCall(
    {
      type: "JOB_FIT_SUGGEST_SALARY",
      profile: state.profile.profile,
      markets: markets.map((currency) => ({
        currency,
        period: $(`salary${currency}period`).value,
        country: countryForCurrency(currency),
      })),
      jobSearch: jobSearch(),
    },
    status,
    { button: $("suggestSalary"), busyText: t("wiz.salary.estimating") }
  );
  if (!response) return;
  markets.forEach((cur) => {
    const range = response.data && response.data[cur];
    if (!range) return;
    if (range.min != null) $(`salary${cur}min`).value = range.min;
    if (range.max != null) $(`salary${cur}max`).value = range.max;
  });
  const tail = t("wiz.salary.startingPoints");
  $("salaryReasoning").textContent = response.data && response.data.reasoning ? `${response.data.reasoning} ${tail}` : tail;
  validateSalary();
  collectSalary();
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
    text.appendChild(el("div", "title", JOB_FIT_KEYWORDS.presetLabel(preset)));
    const example = JOB_FIT_KEYWORDS.presetExample(preset);
    if (example) text.appendChild(el("div", "example", t("wiz.example", { example })));
    if (preset.computed) text.appendChild(el("div", "computed-note", t("wiz.warnings.computedNote")));
    // Hidden by CSS while unticked, so ticking doesn't need a re-render (which
    // would take keyboard focus off the checkbox).
    const why = kind === "hardRejects" ? reasonFor(preset.id) : null;
    if (why) text.appendChild(el("span", "why", why));
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
  if (kind === "hardRejects") $("gateNote").hidden = !Object.keys(jobSearch().workAuth).length;
}

function collectKeywords(kind) {
  const previous = state.profile.keywords[kind] || {};
  state.profile.keywords[kind] = {
    presets: Array.from($(`${kind}Presets`).querySelectorAll("input:checked")).map((b) => b.value),
    phrases: linesToArray($(`${kind}Phrases`).value),
    patterns: linesToArray($(`${kind}Patterns`).value),
    // Which categories this profile has been shown; see keywords.js.
    seen: previous.seen || JOB_FIT_KEYWORDS.presetsFor(kind).map((p) => p.id),
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
    .map((term) => String(term).trim())
    .filter(Boolean)
    .forEach((term) => {
      if (!hasFlag(term)) config.phrases.push(term);
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
    const x = button("×");
    x.setAttribute("aria-label", t("wiz.remove", { name: term }));
    x.addEventListener("click", () => removeFlag(term));
    chip.appendChild(x);
    host.insertBefore(chip, input);
  });

  const suggestions = $("flagSuggestionChips");
  suggestions.innerHTML = "";
  state.flagSuggestions.forEach((term) => {
    const chip = button(`+ ${term}`, "chip suggested");
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
    status.appendChild(el("div", "error-text", t("wiz.flags.needsProfile")));
    return;
  }
  const response = await modelCall(
    { type: "JOB_FIT_SUGGEST_DOMAIN_FLAGS", profile: state.profile.profile, languages: jobSearch().languages },
    status,
    { button: $("suggestFlags"), busyText: t("wiz.flags.reading") }
  );
  if (!response) return;
  state.flagSuggestions = response.terms.filter((term) => !hasFlag(term));
  if (!state.flagSuggestions.length) {
    status.appendChild(el("div", "hint", t("wiz.flags.nothingNew")));
  }
  renderFlags();
}

// --- step: review ----------------------------------------------------------

function presetLabels(kind) {
  const config = state.profile.keywords[kind];
  const labels = JOB_FIT_KEYWORDS.presetsFor(kind)
    .filter((p) => (config.presets || []).includes(p.id))
    .map((p) => JOB_FIT_KEYWORDS.presetLabel(p));
  const extra = (config.phrases || []).length + (config.patterns || []).length;
  if (extra) labels.push(t("wiz.review.customPhrases", { count: extra }));
  return labels;
}

function renderReview() {
  const host = $("reviewCards");
  host.innerHTML = "";
  const p = state.profile;
  const js = jobSearch();

  const salaryLines = Object.entries(p.expectedSalary || {})
    .filter(([, r]) => hasFigures(r))
    .map(([c, r]) => {
      const lo = r.min != null ? formatMoney(r.min) : "…";
      const hi = r.max != null ? formatMoney(r.max) : "…";
      return `${c} ${lo} – ${hi} ${t(`period.per.${r.period || "year"}`)}`;
    });
  const rejects = presetLabels("hardRejects");
  const warnings = presetLabels("softWarnings");
  const flags = [...flagPhrases(), ...(p.keywords.domainFlags.patterns || [])];
  const firstLine = (p.profile || "").trim().split("\n")[0];
  const language = JOB_FIT_I18N.LANGUAGES.find((l) => l.code === JOB_FIT_I18N.lang);
  const authLines = js.targetCountries
    .map(JOB_FIT_GEO.authCountry)
    .filter((c, i, all) => all.indexOf(c) === i)
    .map((c) => `${countryName(c)}: ${js.workAuth[c] ? t(`auth.${js.workAuth[c]}`) : t("wiz.review.notAnswered")}`);

  const cards = [
    {
      step: "where",
      title: stepTitle("where"),
      body: [
        `${t("wiz.where.language")}: ${language ? language.name : ""}`,
        js.home.country ? placeOf(js.home) : t("wiz.review.noLocation"),
      ].join("\n"),
    },
    {
      step: "about",
      title: stepTitle("about"),
      body: [p.name, js.targetCountries.length ? authLines.join("\n") : t("wiz.about.noCountries")].filter(Boolean).join("\n"),
      missing: !js.targetCountries.length,
    },
    {
      step: "work",
      title: stepTitle("work"),
      body: [
        js.arrangements.length ? JOB_FIT_I18N.list(js.arrangements.map((a) => t(`arrangement.${a}`))) : t("wiz.review.anyArrangement"),
        js.relocate ? t(js.relocate === "yes" ? "wiz.sentence.relocateYes" : "wiz.sentence.relocateNo") : null,
        js.languages.length ? JOB_FIT_I18N.list(js.languages.map((l) => JOB_FIT_I18N.languageName(l))) : null,
        js.shareLocation ? t("wiz.review.sharesLocation") : t("wiz.review.keepsLocation"),
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      step: "model",
      title: stepTitle("model"),
      body: activeModel()
        ? `${activeModel()}\n${state.provider === "openai" ? t("wiz.review.openaiNote") : state.lm.url}`
        : t("wiz.review.noModel"),
      missing: !activeModel(),
    },
    {
      step: "profile",
      title: stepTitle("profile"),
      body: isPlaceholderProfile(p.profile) ? t("wiz.review.noProfile") : t("wiz.review.profileWords", { count: wordCount(p.profile), line: firstLine }),
      missing: isPlaceholderProfile(p.profile),
    },
    {
      step: "salary",
      title: stepTitle("salary"),
      body: salaryLines.length ? salaryLines.join("\n") : t("wiz.review.noSalary"),
    },
    { step: "rejects", title: stepTitle("rejects"), body: rejects.length ? rejects.join("\n") : t("wiz.review.noRejects") },
    { step: "warnings", title: stepTitle("warnings"), body: warnings.length ? warnings.join("\n") : t("wiz.review.none") },
    { step: "flags", title: stepTitle("flags"), body: flags.length ? flags.join(", ") : t("wiz.review.noFlags") },
  ];

  cards.forEach((card) => {
    const index = stepIndex(card.step);
    if (index === -1) return;
    const box = el("div", `review-card${card.missing ? " missing" : ""}`);
    const header = el("header");
    header.appendChild(el("h3", null, card.title));
    const edit = button(t("wiz.review.edit"), "link");
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
      $("testBlocked").textContent = t("wiz.review.blocked", { count: snapshot.active });
    }
  } catch (err) {
    // No snapshot just means no pre-check; the worker refuses a busy run itself.
  }
}

function listSection(host, title, items) {
  if (!items || !items.length) return;
  host.appendChild(el("h4", null, title));
  const ul = el("ul");
  items.forEach((item) => ul.appendChild(el("li", null, item)));
  host.appendChild(ul);
}

function verdictLabel(verdict) {
  return verdict && JOB_FIT_I18N.has(`verdict.${verdict}`) ? t(`verdict.${verdict}`) : verdict || "";
}

async function runTest() {
  const status = $("testStatus");
  const out = $("testResult");
  status.innerHTML = "";
  out.innerHTML = "";
  await saveNow();

  if (isPlaceholderProfile(state.profile.profile)) {
    status.appendChild(el("div", "error-text", t("wiz.review.writeProfileFirst")));
    return;
  }
  const own = $("ownPosting").open ? $("testPosting").value.trim() : "";
  const posting = own || SAMPLE_POSTING;

  // Layer 1 runs here exactly as it does on a real page — the same rules, per
  // country — and a hard reject stops before the model is ever asked.
  const screened = JOB_FIT_SCREEN.screen(posting, state.profile.keywords, { jobSearch: jobSearch(), profileText: state.profile.profile });
  if (screened.hardReject) {
    const box = el("div", "test-result");
    const line = el("div", "score-line");
    line.appendChild(el("span", "verdict reject", t("result.hardReject")));
    box.appendChild(line);
    box.appendChild(
      el("p", null, t("wiz.review.rejected", { match: JOB_FIT_SCREEN.cleanMatch(screened.hardReject.matchedText), label: screened.hardReject.label }))
    );
    out.appendChild(box);
    return;
  }

  const response = await modelCall(
    {
      type: "JOB_FIT_TEST_EVALUATE",
      profile: state.profile.profile,
      postingText: posting,
      domainFlags: screened.domainFlags,
      learningFlags: screened.learningFlags,
      coreWorkOnly: screened.coreWorkOnly,
      expectedSalary: state.profile.expectedSalary,
      jobSearch: jobSearch(),
      place: screened.place,
    },
    status,
    { button: $("runTest"), busyText: t("wiz.review.scoring") }
  );
  if (!response) return;

  const d = response.data || {};
  const box = el("div", "test-result");
  const line = el("div", "score-line");
  line.appendChild(el("span", "score", d.score != null ? String(d.score) : "?"));
  if (d.verdict) line.appendChild(el("span", `verdict ${d.verdict}`, verdictLabel(d.verdict)));
  box.appendChild(line);
  if (d.one_line) box.appendChild(el("p", null, d.one_line));
  if (d.score_cap_reasons) {
    box.appendChild(el("div", "hint", t("wiz.review.capped", { raw: d.raw_score, reasons: d.score_cap_reasons.join(", ") })));
  }
  listSection(box, t("result.matches"), d.matches);
  const required = (d.required_gaps || []).map((g) => String(g).toLowerCase());
  listSection(
    box,
    t("result.gaps"),
    (d.gaps || []).map((g) => (required.includes(String(g).toLowerCase()) ? `${g} ${t("wiz.review.requiredTag")}` : g))
  );
  listSection(box, t("wiz.review.flagsFound"), screened.domainFlags);
  listSection(box, t("wiz.review.warningsFound"), screened.softWarnings);
  if (d.salary && d.salary.posting_stated) {
    const vs = d.salary.vs_candidate_expectation;
    listSection(box, t("result.salary"), [
      vs && vs !== "unknown" ? t("wiz.review.salaryVs", { stated: d.salary.posting_stated, vs: salaryVsLabel(vs) }) : d.salary.posting_stated,
    ]);
  }
  if (response.durationMs) {
    const seconds = Math.round(response.durationMs / 1000);
    const timeout = Number(state.lm.timeoutSeconds) || JOB_FIT_DEFAULTS.lmStudio.timeoutSeconds;
    const tight = seconds > timeout * 0.6;
    const usage = response.usage
      ? t("wiz.review.tokens", {
          tokens: JOB_FIT_I18N.formatNumber(response.usage.input + response.usage.output),
          reasoning: response.usage.reasoning ? JOB_FIT_I18N.formatNumber(response.usage.reasoning) : "0",
        })
      : "";
    box.appendChild(
      el(
        "div",
        "hint",
        `${t("wiz.review.took", { seconds })}${usage} ${t("wiz.review.timeout", { timeout })}${tight ? ` ${t("wiz.review.tight")}` : ""}`
      )
    );
  }
  out.appendChild(box);
}

// "within" / "below" / "above", as words (evalstore.js isn't loaded here).
function salaryVsLabel(value) {
  return JOB_FIT_I18N.has(`salaryVs.${value}`) ? t(`salaryVs.${value}`) : value;
}

// --- step controller -------------------------------------------------------

const STEP_HOOKS = {
  welcome: { valid: () => true },
  where: { enter: enterWhere, collect: collectWhere, valid: () => true },
  about: {
    enter: enterAbout,
    collect: () => (state.profile.name = $("profileName").value.trim()),
    valid: () => Boolean($("profileName").value.trim()) && authAnswered(),
  },
  work: { enter: enterWork, collect: collectWork, valid: () => true },
  model: {
    enter: enterModel,
    collect: collectModel,
    valid: () => state.modelOk && Boolean(activeModel()),
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
  if (!state.steps.length) return;
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
    const b = button(null);
    b.disabled = state.finished || !canVisit(i) || i === state.index;
    b.appendChild(el("span", "num", li.classList.contains("done") ? "✓" : String(i + 1)));
    b.appendChild(document.createTextNode(step.title));
    b.addEventListener("click", () => goTo(i));
    li.appendChild(b);
    rail.appendChild(li);
  });
  $("mobileLabel").textContent = t("wiz.stepOf", {
    n: state.index + 1,
    total: state.steps.length,
    title: state.steps[state.index].title,
  });
  $("mobileBar").style.width = `${((state.index + 1) / state.steps.length) * 100}%`;
}

function updateNav() {
  const key = currentKey();
  const valid = STEP_HOOKS[key].valid();
  const next = $("next");
  next.disabled = !valid;
  if (key === "welcome") next.textContent = t("wiz.getStarted");
  else if (key === "review") next.textContent = state.profile.setupIncomplete ? t("wiz.finish") : t("wiz.doneBtn");
  else if (state.returnToReview) next.textContent = t("wiz.backToReview");
  else next.textContent = t("common.next");
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
      setSaveState(t("wiz.couldntSave", { error: err.message }), true);
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
    setSaveState(t("wiz.couldntSave", { error: err.message }), true);
    return;
  }
  $("card").hidden = true;
  $("nav").hidden = true;
  $("done").hidden = false;
  $("doneName").textContent = t("wiz.done.ready", { name: state.profile.name });
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

function restoreDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? JOB_FIT_PROFILES.normalize(JSON.parse(raw)) : null;
  } catch (err) {
    return null;
  }
}

async function init() {
  await JOB_FIT_I18N.load();
  JOB_FIT_I18N.translatePage();
  fillLanguageSelect($("railLanguage"));

  const store = await JOB_FIT_PROFILES.load();
  const stored = await chrome.storage.local.get([...JOB_FIT_PROVIDER.KEYS, "wizardProgress"]);
  state.lm = { ...JOB_FIT_DEFAULTS.lmStudio, ...(stored.lmStudio || {}) };
  state.oa = { ...JOB_FIT_DEFAULTS.openai, ...(stored.openai || {}) };
  state.provider = stored.modelProvider === "openai" ? "openai" : "lmstudio";

  let mode = params.get("mode");
  const profileId = params.get("profile");

  if (mode === "new" && !profileId) {
    const draft = params.get("step") ? restoreDraft() : null;
    if (draft) {
      state.profile = draft;
    } else {
      state.profile = JOB_FIT_PROFILES.blankProfile("");
      // blankProfile falls back to "New profile"; the name box should start
      // empty so the profile gets a real name, not a placeholder you forgot.
      state.profile.name = "";
      state.profile.setupIncomplete = true;
    }
    state.persisted = false;
  } else {
    const wanted = profileId || store.activeProfileId;
    state.profile = store.profiles.find((p) => p.id === wanted);
    if (!state.profile) {
      showFatal(t("wiz.profileGone"));
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

  state.steps = ALL_STEPS.filter((key) => key !== "welcome" || mode === "install").map((key) => ({ key, title: stepTitle(key) }));
  document.title = mode === "edit" ? t("wiz.titleEdit", { name: state.profile.name }) : t("wiz.titleSetup");
  $("railSub").textContent =
    mode === "install" ? t("wiz.firstTime") : mode === "new" ? t("wiz.newProfile") : t("wiz.editing", { name: state.profile.name });

  const byKey = (key, fallback) => {
    const i = key ? stepIndex(key) : -1;
    return i === -1 ? fallback : i;
  };
  let start = 0;
  if (state.persisted && state.profile.setupIncomplete && progress) {
    start = Math.min(byKey(progress.stepKey, progress.step || 0), state.steps.length - 1);
    state.furthest = Math.min(Math.max(byKey(progress.furthestKey, progress.furthest || 0), start), state.steps.length - 1);
  } else if (!state.profile.setupIncomplete) {
    // A finished profile opened from settings: every step is open to jump to.
    state.furthest = state.steps.length - 1;
  }
  // Back from a language switch: the same step, as far as it's reachable.
  const wantedStep = byKey(params.get("step"), -1);
  if (wantedStep !== -1) {
    state.furthest = Math.max(state.furthest, wantedStep);
    start = canVisit(wantedStep) ? wantedStep : start;
  }
  // The step is only for landing back after a language switch; a later
  // reload of this tab should resume normally, not jump back to it.
  if (params.has("step")) {
    const clean = new URLSearchParams(location.search);
    clean.delete("step");
    history.replaceState(null, "", `${location.pathname}?${clean.toString()}`);
  }
  await goTo(start);
}

// --- wiring ----------------------------------------------------------------

const NOT_SETTINGS = new Set(["cvText", "testPosting", "flagInput", "uiLanguage", "railLanguage", "addCountry"]);

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
  const target = e.target;
  if (target.id === "homeCountry") {
    collectWhere();
    fillRegionSelect(target.value || null, null);
  }
  if (target.name === "target") setTarget(target.value, target.checked);
  if (target.name && target.name.startsWith("auth-")) {
    jobSearch().workAuth[target.name.slice(5)] = target.value;
    applyAuthRules();
    renderAuthRows();
  }
  if (target.name === "relocate") {
    collectWork();
    applyAuthRules();
  }
  if (target.id === "shareLocation" || target.name === "arrangement" || target.name === "workLanguage") collectWork();
  if (target.closest("#markets")) syncSalaryRows();
  if (target.name === "lmModel") {
    state.modelDirty = true;
    if (state.provider === "openai") {
      state.oa.model = target.value;
      renderOaReasoning();
    }
  }
  if (target.id === "lmUrl" || target.id === "oaKey") testConnection();
  // Switching provider re-tests against the new one straight away; with no
  // key yet, that just asks for one.
  if (target.name === "provider") {
    collectModel();
    state.provider = target.value === "openai" ? "openai" : "lmstudio";
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

$("uiLanguage").addEventListener("change", (e) => switchLanguage(e.target.value));
$("railLanguage").addEventListener("change", (e) => switchLanguage(e.target.value));
$("addCountry").addEventListener("change", (e) => {
  if (e.target.value) setTarget(e.target.value, true);
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
$("openRestore").addEventListener("click", () => openSettings("data"));
$("doneSettings").addEventListener("click", () => openSettings());
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
    const target = e.target;
    const singleLine = target.tagName === "INPUT" && ["text", "number", "radio", "checkbox"].includes(target.type);
    if (singleLine && target.id !== "flagInput" && !$("next").disabled && !$("nav").hidden) {
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
