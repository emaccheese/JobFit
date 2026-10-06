// The toolbar popup: what JobFit knows about the job in this tab, whether it's
// ready to score, and where to go next. Every setting lives in Settings
// (options.html) — the popup is destroyed the moment it loses focus, which
// made it the wrong place to edit a CV.

const $ = (id) => document.getElementById(id);

let store = { profiles: [], activeProfileId: null };
let tab = null; // the active tab
let pageProbe = null; // what probePage() saw
let tabJob = null; // { jobKey, title, company, location, text, meta } for the posting in this tab
let tabRecord = null; // its saved result for the active profile, if any
let shownRecord = null; // the result the This job block shows: tabRecord, or the same posting tracked from another site
let pageKnown = false; // a posting on a site JobFit has an extractor for

function activeProfile() {
  return store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
}

// Errors stay put: a message that clears itself is no use for explaining why
// a button did nothing.
function setStatus(text) {
  $("status").textContent = text;
}

// Settings opens in a tab; the popup has done its job once it has asked.
async function goToSettings(section) {
  await openSettings(section);
  window.close();
}

// --- profile ---------------------------------------------------------------

function renderProfileSelect() {
  const select = $("profileSelect");
  select.innerHTML = "";
  store.profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
  select.value = store.activeProfileId;
}

// The two things that make every score meaningless, said before you click:
// setup left unfinished, or a profile with no CV to score against.
function renderProfileNotices() {
  const profile = activeProfile();
  const unfinished = Boolean(profile && profile.setupIncomplete);
  $("setupBanner").hidden = !unfinished;
  if (unfinished) $("setupBannerText").textContent = t("popup.setupUnfinished", { name: profile.name });
  $("cvMissing").hidden = unfinished || Boolean(profile && profile.profile.trim());
  // One primary button per view: while setup is unfinished, that's the one.
  $("evaluate").classList.toggle("primary", !unfinished && !(tabRecord && isStale(tabRecord)));
}

async function switchProfile(id) {
  store.activeProfileId = id;
  await JOB_FIT_PROFILES.save(store);
  renderProfileNotices();
  await renderThisJob();
  JOB_FIT_UI.announce(t("popup.switched", { name: activeProfile().name }));
}

// --- this job ----------------------------------------------------------------

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
    // Signed in, or the signed-out page's description (see extractors/linkedin.js).
    linkedin:
      Boolean(document.querySelector('[data-testid="expandable-text-box"]')) ||
      (location.hostname.includes("linkedin.com") && Boolean(document.querySelector(".show-more-less-html__markup"))),
    greenhouse: Boolean(document.querySelector(".job__description, .application-description")),
    embedded: hasEmbeddedBoard,
    jibe: Boolean(document.querySelector("descriptions-app #description-body")),
    eightfold: Boolean(document.querySelector("#pcsx #job-description-container")),
    indeed: location.hostname.includes("indeed.") && Boolean(document.querySelector("#jobDescriptionText, .simple-job-description-html")),
    glassdoor: /(^|\.)glassdoor\.[a-z.]+$/i.test(location.hostname) && Boolean(document.querySelector('[class*="JobDetails_jobDescription"]')),
    workday: Boolean(document.querySelector('[data-automation-id="jobPostingDescription"]')),
  };
}

function setReady(dotId, textId, state, text, title) {
  $(dotId).className = `dot ${state}`;
  const label = $(textId);
  label.textContent = text;
  label.title = title || "";
}

async function checkPage() {
  if (!tab?.id) {
    setReady("pageDot", "pageState", "warn", t("popup.noTab"));
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage });
    pageProbe = results && results[0] && results[0].result;
  } catch (err) {
    setReady("pageDot", "pageState", "bad", t("popup.cantReadPage"));
    return;
  }
  if (!pageProbe) {
    setReady("pageDot", "pageState", "warn", t("popup.couldntReadTab"));
    return;
  }
  const p = pageProbe;
  // The first that matches, in the readers' own order.
  const site =
    [
      [p.linkedin, "LinkedIn"],
      [p.greenhouse, "Greenhouse"],
      [p.embedded, t("popup.siteEmbedded")],
      [p.indeed, "Indeed"],
      [p.glassdoor, "Glassdoor"],
      [p.workday, "Workday"],
      [p.jibe, t("popup.siteJibe")],
      [p.eightfold, t("popup.siteEightfold")],
    ].find(([found]) => found)?.[1] || null;
  pageKnown = Boolean(site);
  if (site) setReady("pageDot", "pageState", "ok", t("popup.postingDetected", { site }));
  else setReady("pageDot", "pageState", "warn", t("popup.noKnownPosting"), p.host);
}

// Runs in the page (executeScript serializes it, so it can't call anything
// outside itself). The same readers as content.js's dispatchExtraction.
function extractOnPage() {
  const jf = window.__jobFit || {};
  const site = jf.readSite ? jf.readSite({ safe: true }) : null;
  const extracted = site ? site.result : jf.generic ? jf.generic() : null;
  if (!extracted) return null;
  // As content.js does, so the posting is looked up under the same company.
  if (!extracted.company && jf.jsonLdCompany) extracted.company = jf.jsonLdCompany();
  // Computed in the page, where location and the DOM are available, so the
  // popup can look this posting up in history — under its own key, or by its
  // requisition id and text as a copy of one tracked from another site.
  const meta = typeof JOB_FIT_META !== "undefined" ? JOB_FIT_META.fromPage(extracted) : null;
  return { ...extracted, jobKey: JOB_FIT_JOBKEY.keyFor(extracted), meta };
}

// Which job the tab shows, read with the extractors alone (no content.js, so
// nothing is evaluated). On a company site that embeds a Greenhouse board the
// posting is in the iframe, so that's asked too.
async function readTabJob() {
  if (!tab?.id || !pageProbe) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: JOB_FIT_LOOKUP_FILES });
    const top = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractOnPage });
    let found = top?.find((r) => r.result)?.result || null;
    if (pageProbe.embedded) {
      const frameIds = await injectJobFrames(tab.id, JOB_FIT_LOOKUP_FILES);
      if (frameIds.length) {
        const framed = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds }, func: extractOnPage });
        found = framed?.find((r) => r.result)?.result || found;
      }
    }
    return found
      ? { jobKey: found.jobKey, title: found.title, company: found.company, location: found.location, text: found.text, meta: found.meta }
      : null;
  } catch (err) {
    return null;
  }
}

let currentModel = "";

function staleReason(record) {
  if (record.score == null && !record.hardReject) return null;
  const reasons = [];
  if (!record.hardReject && (record.model || "") !== currentModel) {
    reasons.push(record.model ? t("history.scoredBy", { model: record.model }) : t("history.scoredByAnother"));
  }
  if (record.profileFingerprint !== JOB_FIT_PROFILES.fingerprint(activeProfile())) reasons.push(t("history.olderProfile"));
  return reasons.length ? JOB_FIT_I18N.list(reasons) : null;
}

function isStale(record) {
  return Boolean(staleReason(record));
}

function scoredWhen(record) {
  const ts = JOB_FIT_EVALSTORE.activityTs(record);
  const days = Math.floor((Date.now() - ts) / 86400000);
  return days <= 0 ? t("popup.scoredToday") : t("popup.scoredAgo", { count: days });
}

// This profile's tracked jobs, for what they say about the tab's job: a copy
// scored from another site, and your history at the company.
async function trackedRecords() {
  if (!tabJob) return [];
  try {
    return await JOB_FIT_EVALSTORE.list(activeProfile().id);
  } catch (err) {
    return [];
  }
}

// The saved result for this tab's job under the active profile: the number
// the on-page card shows, here too, with what to do about it. With none, the
// same posting scored from another site stands in, said to be that — the one
// Evaluate on the page would point to.
async function renderThisJob() {
  tabRecord = tabJob ? await JOB_FIT_EVALSTORE.get(activeProfile().id, tabJob.jobKey) : null;
  const hasScore = Boolean(tabRecord && (tabRecord.score != null || tabRecord.hardReject));
  const tracked = await trackedRecords();
  const candidate = tabJob ? { ...tabJob, profileId: activeProfile().id } : null;
  const duplicate = hasScore || !candidate ? null : JOB_FIT_EVALSTORE.scoredDuplicateOf(candidate, tracked);
  shownRecord = hasScore ? tabRecord : duplicate;
  $("record").hidden = !shownRecord;

  // Before you've scored it, too: how the other applications there went. The
  // saved record when there is one, whose copies elsewhere are already known.
  const subject = tabRecord || candidate;
  const companyNote = subject ? JOB_FIT_EVALSTORE.companyHistoryNote(tracked, subject) : null;
  $("companyNote").textContent = companyNote || "";
  $("companyNote").hidden = !companyNote;

  const evaluate = $("evaluate");
  if (!hasScore) {
    // "this job" only when a known board's posting was seen; anywhere else
    // Evaluate still tries, and says so.
    evaluate.textContent = tabJob && pageKnown ? t("popup.evaluateJob") : t("popup.evaluate");
    $("reevaluate").hidden = true;
    if (duplicate) renderRecord(duplicate, { duplicate: true });
    renderProfileNotices();
    return;
  }
  $("reevaluate").hidden = false;
  const stale = renderRecord(tabRecord);

  // Out of date: re-scoring is the thing to do. Otherwise showing the saved
  // result on the page is — it costs nothing.
  evaluate.textContent = t("popup.showOnPage");
  $("reevaluate").classList.toggle("primary", Boolean(stale) && !activeProfile().setupIncomplete);
  renderProfileNotices();
}

// Fills the record block; returns why the score is out of date, if it is.
function renderRecord(r, { duplicate = false } = {}) {
  const score = $("recScore");
  score.className = `score ${r.hardReject ? "red" : JOB_FIT_UI.scoreClass(r.score)}`;
  score.textContent = r.hardReject ? "✕" : String(r.score);
  const verdict = r.hardReject
    ? t("result.hardReject")
    : r.verdict && JOB_FIT_I18N.has(`verdict.${r.verdict}`)
      ? t(`verdict.${r.verdict}`)
      : r.verdict || "";
  // The badge carries the number visually and is hidden from screen readers,
  // so the number is spoken here instead.
  const recVerdict = $("recVerdict");
  recVerdict.textContent = "";
  if (!r.hardReject) {
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = `${r.score}/100 `;
    recVerdict.appendChild(spoken);
  }
  const word = document.createElement("span");
  word.className = "vword";
  word.textContent = verdict;
  recVerdict.appendChild(word);
  $("recName").textContent = [r.title, r.company].filter(Boolean).join(" — ");
  const meta = $("recMeta");
  if (duplicate) {
    meta.textContent = t("popup.dupFrom", { site: JOB_FIT_EVALSTORE.siteLabel(r), when: scoredWhen(r) });
    // Applied through that copy: the reason not to apply through this one.
    if (r.status && r.status !== "not_applied") appendMetaWarning(meta, JOB_FIT_EVALSTORE.statusLabel(r.status));
  } else {
    meta.textContent = r.hardReject ? `${r.hardReject.label} · ${scoredWhen(r)}` : scoredWhen(r);
  }
  const stale = duplicate ? null : staleReason(r);
  if (stale) appendMetaWarning(meta, t("popup.outOfDate", { reason: stale }));
  // Closing soon, or closed, and not applied to: the one date worth seeing
  // before you click anything.
  const applied = Boolean(r.status && r.status !== "not_applied");
  const { deadlineNote } = JOB_FIT_META.describe(r.meta || (tabJob && tabJob.meta), { applied });
  if (deadlineNote && !r.hardReject) appendMetaWarning(meta, deadlineNote);
  return stale;
}

function appendMetaWarning(meta, text) {
  meta.appendChild(document.createTextNode(" · "));
  const warn = document.createElement("span");
  warn.className = "stale";
  warn.textContent = text;
  meta.appendChild(warn);
}

async function evaluateCurrentTab({ ignoreCache = false } = {}) {
  // Guard against a double-click firing two concurrent evaluations before
  // the popup has a chance to close.
  const btn = ignoreCache ? $("reevaluate") : $("evaluate");
  if (btn.disabled || !tab?.id) return;
  btn.disabled = true;
  const started = await startEvaluation(tab.id, { ignoreCache });
  if (!started.ok) {
    setStatus(started.error);
    btn.disabled = false;
    return;
  }
  window.close();
}

// --- summarize -----------------------------------------------------------------

async function summarizeCurrentTab() {
  const btn = $("summarizeTab");
  const statusEl = $("summarizeStatus");
  const resultEl = $("summarizeResult");
  const copyBtn = $("copySummary");

  btn.disabled = true;
  resultEl.hidden = true;
  copyBtn.hidden = true;
  statusEl.textContent = t("popup.extracting");

  if (!tab?.id) {
    statusEl.textContent = t("popup.noTab");
    btn.disabled = false;
    return;
  }
  const files = await jobFitContentFiles();

  let extracted;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    // Find cross-origin job board iframes (e.g. embedded Greenhouse on
    // custom-domain career sites). Targeted frameIds avoid the allFrames
    // rejection issue where one inaccessible ad iframe kills the whole call.
    const jobFrameIds = await injectJobFrames(tab.id, files);
    const topResults = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractOnPage });
    // .result unwraps the InjectionResult ({ frameId, result }) — find()
    // returns the wrapper, which is truthy even when result is null.
    extracted = topResults?.find((r) => r.result)?.result || null;
    // If a Greenhouse iframe exists, prefer its result: on a custom-domain
    // career site the top frame only has nav/footer/blog text.
    if (jobFrameIds.length > 0) {
      const frameResults = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: jobFrameIds }, func: extractOnPage });
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
  // than one request to the model. Priority, so it runs before queued
  // evaluations rather than behind them.
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
        meta: extracted.meta,
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
    const { lastSummary } = await chrome.storage.local.get("lastSummary");
    if (lastSummary && lastSummary.url === url && lastSummary.profileId === profileId && lastSummary.ts >= since) {
      return lastSummary;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

async function restoreLastSummary() {
  if (!tab?.url) return;
  const { lastSummary } = await chrome.storage.local.get("lastSummary");
  if (!lastSummary || lastSummary.url !== tab.url || !lastSummary.text) return;
  // A summary built for another profile carries that profile's evaluation
  // block, so don't resurrect it under the current one.
  if (lastSummary.profileId && lastSummary.profileId !== activeProfile().id) return;
  $("summarizeResult").value = lastSummary.text;
  $("summarizeResult").hidden = false;
  $("copySummary").hidden = false;
  $("summarizeStatus").textContent = t("popup.summaryEarlier");
}

async function copySummary() {
  const resultEl = $("summarizeResult");
  const statusEl = $("summarizeStatus");
  try {
    await navigator.clipboard.writeText(resultEl.value);
    statusEl.textContent = t("popup.copied");
  } catch (err) {
    resultEl.focus();
    resultEl.select();
    statusEl.textContent = t("popup.copyManually");
  }
}

// --- readiness -----------------------------------------------------------------

async function checkModel() {
  const settings = await JOB_FIT_PROVIDER.load();
  const verdict = describeModelReadiness(settings, await probeModels(settings));
  setReady("modelDot", "modelState", verdict.state, verdict.text, verdict.title);
  $("fixModel").hidden = verdict.state === "ok";
}

async function renderQueueStatus() {
  const row = $("queueRow");
  let snapshot;
  try {
    snapshot = await sendMessageWithRetry({ type: "JOB_FIT_QUEUE_SNAPSHOT" });
  } catch (err) {
    row.hidden = true;
    return;
  }
  const items = (snapshot && snapshot.items) || [];
  const processing = items.find((i) => i.state === "processing");
  const pending = items.filter((i) => i.state === "pending").length;
  const failed = items.filter((i) => i.state === "failed").length;
  if (!snapshot || (!snapshot.active && !failed)) {
    row.hidden = true;
    return;
  }
  const paused = snapshot.state === "paused";
  const parts = [];
  if (paused) parts.push(t("popup.qPaused"));
  if (processing) parts.push(t("popup.qProcessing", { title: processing.title || t("popup.posting") }));
  if (pending) parts.push(t("queue.waitingCount", { count: pending }));
  if (failed) parts.push(t("queue.failedCount", { count: failed }));
  $("queueStatus").textContent = `${parts.join(" · ")} — ${t("popup.qSeeTracked")}`;
  $("queueDot").className = `dot ${paused || failed ? "warn" : "ok"}`;
  row.hidden = false;
}

// Shows the shortcut Chrome actually assigned, which may differ from the
// suggested one. Formatted by Chrome for the platform, e.g. "⇧⌘E".
async function renderShortcutTip() {
  let shortcut = "";
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "evaluate-tab");
    shortcut = (cmd && cmd.shortcut) || "";
  } catch (err) {
    /* commands API unavailable */
  }
  $("evaluateTip").textContent = shortcut ? t("popup.tipShortcut", { shortcut }) : t("popup.tipNoShortcut");
}

// --- on-page button --------------------------------------------------------------
//
// Opt-in per site. Ticking the box asks Chrome for access to this one site;
// the worker then shows the button here straight away and on every later
// visit (background.js, setFloatSite). The permission prompt can close the
// popup before it hears the answer, so the site is also left in
// `floatPending` for the worker to finish on its own. The list of sites is in
// Settings › On-page button.
let floatTab = null;

function floatHost(origin) {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch (err) {
    return origin;
  }
}

async function renderFloat() {
  const stored = await chrome.storage.local.get(["floatingButtonSites", "floatingButtonBoards"]);
  const sites = Array.isArray(stored.floatingButtonSites) ? stored.floatingButtonSites : [];
  const boards = Array.isArray(stored.floatingButtonBoards) ? stored.floatingButtonBoards : [];
  let origin = null;
  try {
    const url = new URL(tab && tab.url);
    if (/^https?:$/.test(url.protocol)) origin = url.origin;
  } catch (err) {
    origin = null;
  }
  // On a known job board the toggle covers all of it — every Indeed country,
  // every Workday employer — as one permission, rather than this one site.
  const board = origin ? JOB_FIT_BOARDS.boardForUrl(tab.url) : null;
  floatTab = origin ? { id: tab.id, origin, board } : null;
  $("floatRow").hidden = !origin;
  if (!origin) return;
  $("floatToggle").checked = sites.includes(origin) || Boolean(board && boards.includes(board.id));
  $("floatLabel").textContent = board
    ? t("popup.floatToggleBoard", { board: board.name })
    : t("popup.floatToggle", { site: floatHost(origin) });
}

// Not async before permissions.request: Chrome only shows the prompt from
// inside the click that asked for it.
function onFloatToggle(e) {
  const box = e.target;
  const hint = $("floatHint");
  hint.textContent = "";
  if (!floatTab) return;
  const { id: tabId, origin, board } = floatTab;
  if (!box.checked) {
    // Whichever put it here: the board, or this site on its own.
    Promise.all([
      board ? sendMessageWithRetry({ type: "JOB_FIT_FLOAT_BOARD", boards: [board.id], enabled: false }) : null,
      sendMessageWithRetry({ type: "JOB_FIT_FLOAT_SITE", origin, enabled: false }),
    ]).then(renderFloat);
    return;
  }
  const origins = board ? board.patterns : [`${origin}/*`];
  chrome.storage.local.set({ floatPending: board ? { boards: [board.id], tabId, ts: Date.now() } : { origin, tabId, ts: Date.now() } });
  chrome.permissions.request({ origins }).then(async (granted) => {
    if (!granted) {
      box.checked = false;
      hint.textContent = t("popup.floatDenied");
      return;
    }
    await sendMessageWithRetry(
      board ? { type: "JOB_FIT_FLOAT_BOARD", boards: [board.id], enabled: true, tabId } : { type: "JOB_FIT_FLOAT_SITE", origin, enabled: true, tabId }
    );
    hint.textContent = board ? t("popup.floatOnBoard", { board: board.name }) : t("popup.floatOn");
    renderFloat();
  });
}

// --- start -----------------------------------------------------------------------

function wire() {
  $("profileSelect").addEventListener("change", (e) => switchProfile(e.target.value));
  $("openSettings").addEventListener("click", () => goToSettings());
  $("fixModel").addEventListener("click", () => goToSettings("model"));
  $("addCv").addEventListener("click", () => goToSettings("profile"));
  $("setupContinue").addEventListener("click", () => {
    openSetupWizard({ profile: activeProfile().id, resume: "1" });
    window.close();
  });
  $("evaluate").addEventListener("click", () => evaluateCurrentTab());
  $("reevaluate").addEventListener("click", () => evaluateCurrentTab({ ignoreCache: true }));
  $("openRecord").addEventListener("click", () => {
    const params = new URLSearchParams({ profile: activeProfile().id, job: shownRecord ? shownRecord.jobKey : "" });
    chrome.tabs.create({ url: `${chrome.runtime.getURL("history.html")}?${params.toString()}` });
    window.close();
  });
  $("summarizeTab").addEventListener("click", summarizeCurrentTab);
  $("copySummary").addEventListener("click", copySummary);
  $("floatToggle").addEventListener("change", onFloatToggle);
  // An extension page rather than a popup view: it needs room, and it keeps
  // full chrome.storage access without the popup's habit of closing on blur.
  const openHistory = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
    window.close();
  };
  $("viewHistory").addEventListener("click", openHistory);
  $("queueStatus").addEventListener("click", openHistory);
}

async function init() {
  await JOB_FIT_I18N.load();
  JOB_FIT_I18N.translatePage();
  wire();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  store = await JOB_FIT_PROFILES.load();
  currentModel = JOB_FIT_PROVIDER.currentModel(await chrome.storage.local.get(JOB_FIT_PROVIDER.KEYS));
  renderProfileSelect();
  renderProfileNotices();
  renderShortcutTip();
  renderFloat();
  renderQueueStatus();
  checkModel();
  restoreLastSummary();
  await checkPage();
  tabJob = await readTabJob();
  await renderThisJob();
}

init();
