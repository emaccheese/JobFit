// History page. Shows one profile at a time — scores produced under different
// profiles aren't comparable, so mixing them in one list would invite reading
// a friend's 82 as if it meant the same as yours. The profile selector here
// switches which set you're looking at without touching which profile the
// popup evaluates as.

let store = { profiles: [], activeProfileId: null };
let viewProfileId = null;
let records = [];
// Which cards are expanded, by jobKey. Held outside the DOM so a re-render —
// from a status change, a filter, or an evaluation landing in another tab —
// doesn't collapse whatever the user was reading.
const openKeys = new Set();
// Storage keys this page just wrote. chrome.storage.onChanged fires for our
// own writes too, and those are already reflected in memory, so echoing them
// back would re-render for nothing.
const selfWrites = new Set();
// Jobs ticked for re-evaluation, by jobKey. Outside the DOM for the same
// reason as openKeys: a re-render must not drop the selection.
const selectedKeys = new Set();
// The model and profile version new scores would be produced under. Read
// once per load (and on a model/profile change) so each row can say whether
// its score is out of date without an async lookup per render.
let current = { model: "", fingerprint: null };

const els = {
  profileSelect: document.getElementById("profileSelect"),
  sortSelect: document.getElementById("sortSelect"),
  statusFilter: document.getElementById("statusFilter"),
  search: document.getElementById("search"),
  hideRejects: document.getElementById("hideRejects"),
  list: document.getElementById("list"),
  toolbarLeft: document.getElementById("toolbarLeft"),
  pagerTop: document.getElementById("pagerTop"),
  pagerBottom: document.getElementById("pagerBottom"),
  staleChip: document.getElementById("staleChip"),
  detailPane: document.getElementById("detailPane"),
  pageStatus: document.getElementById("pageStatus"),
  moreFiltersLabel: document.getElementById("moreFiltersLabel"),
};

// Paging. The list had grown past what reads as a list; the page size is a
// per-viewer preference, remembered between visits.
const PAGE_SIZES = [5, 10, 20, 50, 100, 0]; // 0 = all
let page = 0;
// ui.staleDismissed holds the signature of the out-of-date set that was
// dismissed, so the chip returns when that set changes rather than staying
// hidden for good.
let ui = { pageSize: 20, staleDismissed: null };

async function loadUi() {
  const stored = await chrome.storage.local.get("historyUi");
  ui = { ...ui, ...(stored.historyUi || {}) };
  if (!PAGE_SIZES.includes(ui.pageSize)) ui.pageSize = 20;
}

function saveUi() {
  chrome.storage.local.set({ historyUi: ui });
}

// Any change to what's being listed starts again from the first page: page 4
// of a different filter is an arbitrary slice nobody asked for.
function resetPage() {
  page = 0;
}

// " · 2.3k tokens (800 reasoning)", or "" for scores from before usage was
// recorded.
function usageText(usage) {
  if (!usage) return "";
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const total = (usage.input || 0) + (usage.output || 0);
  return ` · ${t("history.tokens", { tokens: k(total) })}${usage.reasoning ? ` ${t("history.reasoningTokens", { tokens: k(usage.reasoning) })}` : ""}`;
}

// The bands are shared with the on-page card and the popup (ui-shared.js).
const scoreClass = JOB_FIT_UI.scoreClass;

function formatDate(ts) {
  return JOB_FIT_I18N.formatDate(ts);
}

function verdictLabel(verdict) {
  return verdict && JOB_FIT_I18N.has(`verdict.${verdict}`) ? t(`verdict.${verdict}`) : verdict || "";
}

function daysSince(ts) {
  return Math.floor((Date.now() - ts) / 86400000);
}

// Everything the posting supplies goes in as textContent, never innerHTML:
// the description is arbitrary markup scraped off a third-party page.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function tagList(parent, title, items, cls) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  parent.appendChild(el("h3", null, title));
  list.forEach((item) => parent.appendChild(el("span", `tag ${cls}`, item)));
}

function statusOrder(value) {
  const idx = JOB_FIT_EVALSTORE.STATUSES.findIndex((s) => s.value === value);
  return idx === -1 ? 99 : idx;
}

// Ranking tiers for the score sorts. `score ?? 0` used to tie an unscored job
// with a hard reject, leaving their relative order down to whatever came back
// from storage first. A job with no score yet is unknown and still worth a
// look, so it ranks above a hard reject, which is dead — while any real score,
// including a genuine 0, still ranks above both.
function scoreRank(record) {
  if (record.hardReject) return -1;
  if (record.score == null) return -0.5;
  return record.score;
}

function sortRecords(list, mode) {
  const by = {
    "score-desc": (a, b) => scoreRank(b) - scoreRank(a),
    "score-asc": (a, b) => scoreRank(a) - scoreRank(b),
    "viewed-desc": (a, b) => JOB_FIT_EVALSTORE.activityTs(b) - JOB_FIT_EVALSTORE.activityTs(a),
    "viewed-asc": (a, b) => JOB_FIT_EVALSTORE.activityTs(a) - JOB_FIT_EVALSTORE.activityTs(b),
    "applied-desc": (a, b) => (b.appliedAt || 0) - (a.appliedAt || 0),
    "company-asc": (a, b) => (a.company || "￿").localeCompare(b.company || "￿"),
    status: (a, b) => statusOrder(a.status) - statusOrder(b.status) || scoreRank(b) - scoreRank(a),
  };
  return [...list].sort(by[mode] || by["score-desc"]);
}

// Possible cross-site duplicates for the records on screen, by jobKey, and
// which connected set each belongs to — copies can carry different titles, so
// the set, not the title, is what groups them. Recomputed at the start of
// every render, so a delete, a "not a duplicate" or a newly tracked job is
// reflected straight away.
let dupGroups = new Map();
let dupSets = new Map();

function dupGroupKey(r) {
  return dupSets.get(r.jobKey) || r.jobKey;
}

function visibleRecords() {
  const list = filteredRecords();
  // Listing duplicates is for comparing them, so each set sits together,
  // in the chosen sort order within the set.
  if (groupFilter !== "duplicates") return list;
  const order = new Map();
  list.forEach((r, i) => {
    const key = dupGroupKey(r);
    if (!order.has(key)) order.set(key, i);
  });
  return [...list].sort((a, b) => order.get(dupGroupKey(a)) - order.get(dupGroupKey(b)));
}

function filteredRecords() {
  const query = els.search.value.trim().toLowerCase();
  const status = els.statusFilter.value;
  return sortRecords(
    records.filter((r) => {
      if (els.hideRejects.checked && r.hardReject) return false;
      if (groupFilter && !FILTERS[groupFilter].match(r)) return false;
      if (status !== "all" && r.status !== status) return false;
      if (!query) return true;
      // Notes are searched too — a recruiter's name or "asked about OpenCL" is
      // exactly what you come back looking for weeks later.
      return `${r.title || ""} ${r.company || ""} ${r.location || ""} ${(r.meta && r.meta.reqId) || ""} ${r.notes || ""} ${r.summary || ""} ${r.text || ""}`
        .toLowerCase()
        .includes(query);
    }),
    els.sortSelect.value
  );
}

function buildStatusSelect(record, onChange) {
  const select = document.createElement("select");
  select.className = "status-select";
  // Without a label a screen reader announced a bare "Not applied" menu with
  // no hint of which job it belonged to.
  select.setAttribute("aria-label", t("history.statusFor", { title: record.title || t("history.untitled") }));
  JOB_FIT_EVALSTORE.STATUSES.forEach(({ value, label }) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = record.status || "not_applied";
  // The whole header row toggles the card, so the dropdown has to stop its
  // own clicks from reaching it — otherwise every status change collapses
  // the card you were working in.
  ["click", "pointerdown", "mousedown"].forEach((evt) =>
    select.addEventListener(evt, (e) => e.stopPropagation())
  );
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

// Queues a brief for a job already in history. Everything the worker needs is
// in the record — the full posting text is stored — so this reuses the same
// queue path as the popup rather than calling the model directly, which keeps
// the one-request-at-a-time invariant intact while evaluations are running.
function buildBriefActions(record) {
  const wrap = el("div", "brief-actions");
  const note = el("span", "brief-note", "");

  if (!record.text) {
    note.textContent = t("history.noTextBrief");
    wrap.appendChild(note);
    return wrap;
  }

  const summarizeLabel = record.summary ? t("history.resummarize") : t("history.summarizeJob");
  const summarize = el("button", null, summarizeLabel);
  summarize.className = "summarize-btn";
  summarize.dataset.label = summarizeLabel;
  // Status comes from the queue itself (see renderBriefStatus), refreshed on
  // every queue change — not from the enqueue reply, which only says the job
  // was accepted, not that anything is running.
  note.dataset.jobKey = record.jobKey;
  wrap.dataset.jobKey = record.jobKey;
  summarize.addEventListener("click", async () => {
    summarize.disabled = true;
    summarize.textContent = t("history.queueing");
    const response = await queueMessage({
      type: "JOB_FIT_ENQUEUE",
      priority: true,
      item: {
        kind: "summarize",
        jobKey: record.jobKey,
        profileId: record.profileId,
        profileName: record.profileName,
        postingText: record.text,
        title: record.title,
        company: record.company,
        location: record.location,
        url: record.url,
      },
    });

    if (!response || !response.ok) {
      summarize.disabled = false;
      summarize.textContent = summarizeLabel;
      note.textContent = response && response.full ? t("history.queueFull", { count: response.max }) : t("history.couldntQueue");
      return;
    }

    await refreshQueue();
  });
  wrap.appendChild(summarize);

  if (record.summary) {
    const copy = el("button", null, t("history.copyBrief"));
    copy.addEventListener("click", async () => {
      // Same builder the popup's text comes from: header line, brief, then
      // this profile's evaluations, one per model.
      const text = JOB_FIT_EVALSTORE.briefText(record, profileDisplayName(record));
      try {
        await navigator.clipboard.writeText(text);
        note.textContent = t("history.briefCopied");
      } catch (err) {
        note.textContent = t("history.couldntCopy");
      }
      setTimeout(() => (note.textContent = ""), 3000);
    });
    wrap.appendChild(copy);
  }

  wrap.appendChild(note);
  renderBriefStatus(wrap);
  return wrap;
}

// The latest summarize item for this job in the queue, if it's still live or
// failed — the thing whose state the brief area should describe.
function briefQueueItem(jobKey) {
  const items = ((latestQueue && latestQueue.items) || []).filter(
    (i) => i.kind === "summarize" && i.jobKey === jobKey && i.profileId === viewProfileId
  );
  const item = items[items.length - 1];
  return item && ["pending", "processing", "failed"].includes(item.state) ? item : null;
}

function renderBriefStatus(wrap) {
  const note = wrap.querySelector(".brief-note");
  const button = wrap.querySelector(".summarize-btn");
  if (!note || !button) return;
  const item = briefQueueItem(wrap.dataset.jobKey);
  const busy = item && item.state !== "failed";
  button.disabled = Boolean(busy);
  button.textContent = !item
    ? button.dataset.label
    : item.state === "processing"
      ? t("history.summarizingBtn")
      : item.state === "pending"
        ? t("history.queued")
        : button.dataset.label;
  if (!item) {
    // Leave a transient message (e.g. "Copied") alone; clear only our own.
    if (note.dataset.queueStatus) {
      note.textContent = "";
      delete note.dataset.queueStatus;
    }
    return;
  }

  note.dataset.queueStatus = "1";
  note.textContent = "";
  const items = latestQueue.items;
  if (item.state === "processing") {
    note.textContent = t("history.summarizingNow");
  } else if (item.state === "failed") {
    note.textContent = `${t("history.summarizeFailed", { error: item.error || t("common.unknownError") })} `;
    const retry = el("button", null, t("queue.retry"));
    retry.addEventListener("click", async () => {
      await queueMessage({ type: "JOB_FIT_QUEUE_RETRY", id: item.id });
      refreshQueue();
    });
    note.appendChild(retry);
  } else if (latestQueue.state === "paused") {
    // The case that used to say "Running now" while nothing ran.
    note.textContent = `${t("history.queuedPaused", { reason: latestQueue.pauseReason || t("queue.unreachable") })} `;
    const resume = el("button", null, t("queue.resumeQueue"));
    resume.addEventListener("click", async () => {
      await queueMessage({ type: "JOB_FIT_QUEUE_RESUME" });
      refreshQueue();
    });
    note.appendChild(resume);
  } else {
    const ahead = items.filter((i) => i.state === "processing").length +
      items.slice(0, items.indexOf(item)).filter((i) => i.state === "pending").length;
    note.textContent = ahead ? t("history.briefWaiting", { count: ahead }) : t("history.briefStarting");
  }
}

function refreshBriefStatuses() {
  document.querySelectorAll(".brief-actions[data-job-key]").forEach(renderBriefStatus);
}

// The queue lives at the top of the page, which is off-screen while you work
// further down the list. This pill in the sticky toolbar keeps its state in
// view — above all a pause, which otherwise nothing near the list would show.
function renderQueuePill() {
  const pill = document.getElementById("queuePill");
  const items = ((latestQueue && latestQueue.items) || []).filter((i) => i.profileId === viewProfileId);
  const waiting = items.filter((i) => i.state === "pending").length;
  const running = items.some((i) => i.state === "processing");
  const paused = latestQueue && latestQueue.state === "paused" && (waiting || running);
  pill.hidden = !(paused || running || waiting);
  if (pill.hidden) return;
  pill.className = `queue-pill${paused ? " paused" : ""}`;
  pill.textContent = paused
    ? `${t("queue.paused")} · ${t("queue.waitingCount", { count: waiting })}`
    : [running ? t("queue.running") : t("queue.title"), waiting ? t("queue.waitingCount", { count: waiting }) : null]
        .filter(Boolean)
        .join(" · ");
}

// The model's reasoning for one evaluation. Shared by the current result and
// the previous ones, so an old score reads exactly like a current one.
function evaluationTags(parent, e) {
  tagList(parent, t("result.matches"), e.matches, "tag-green");
  tagList(parent, t("result.gaps"), e.gaps, "tag-amber");
  tagList(parent, t("result.requiredGaps"), e.required_gaps, "tag-red");
  tagList(parent, t("result.seniority"), [e.seniority_flag, e.level_flag].filter(Boolean), "tag-amber");
  tagList(parent, t("result.unverifiedMatches"), e.unverified_matches, "tag-amber");
  tagList(parent, t("result.scoreCap"), e.score_cap_reasons, "tag-amber");
  if (e.salary) {
    tagList(
      parent,
      t("result.salary"),
      [
        `${t("result.salaryPosting")}: ${e.salary.posting_stated}`,
        `${t("result.salaryMarket")}: ${e.salary.estimated_market_range}`,
        `${t("result.salaryVs")}: ${JOB_FIT_EVALSTORE.salaryVerdictLabel(e.salary.vs_candidate_expectation)}`,
        e.salary.note,
      ],
      "tag-neutral"
    );
  }
}

// Earlier results for this job, newest first, kept by saveEvaluation when the
// job was re-scored. Each is collapsed to one line — score, verdict, model,
// date — and expands to that run's full reasoning, so two models can be
// compared on the same posting.
function appendPreviousResults(body, record) {
  const previous = record.previous || [];
  if (!previous.length) return;

  body.appendChild(el("h3", null, t("history.previousScores", { count: previous.length })));
  const list = el("div", "previous-list");
  previous.forEach((p) => {
    const item = document.createElement("details");
    item.className = "previous";
    const summary = document.createElement("summary");
    summary.appendChild(el("span", `qscore ${p.hardReject ? "red" : scoreClass(p.score)}`, String(p.score ?? "—")));
    const verdict = p.hardReject ? t("result.hardReject") : verdictLabel((p.evaluation && p.evaluation.verdict) || p.verdict);
    const parts = [
      verdict,
      p.model || t("brief.unknownModel"),
      p.evaluatedAt ? formatDate(p.evaluatedAt) : null,
      p.profileFingerprint && p.profileFingerprint !== record.profileFingerprint ? t("history.olderProfile") : null,
    ].filter(Boolean);
    summary.appendChild(el("span", "previous-meta", parts.join(" · ")));
    item.appendChild(summary);

    const detail = el("div", "previous-body");
    if (p.hardReject) {
      detail.appendChild(el("div", null, `${p.hardReject.label}: "${p.hardReject.matchedText}"`));
    } else if (p.evaluation) {
      if (p.evaluation.one_line) detail.appendChild(el("div", null, p.evaluation.one_line));
      if (p.durationMs) detail.appendChild(el("div", "meta-line", `${t("history.scoredIn", { seconds: Math.round(p.durationMs / 1000) })}${usageText(p.usage)}`));
      evaluationTags(detail, p.evaluation);
    } else {
      detail.appendChild(el("div", "meta-line", t("history.noReasoning")));
    }
    item.appendChild(detail);
    list.appendChild(item);
  });
  body.appendChild(list);
}

// Re-scores this one job with the current model and profile. Hard rejects are
// left alone: they come from the keyword scan, which the model never overrides.
// The result it replaces is kept on the record (see saveEvaluation).
function buildEvaluateActions(record) {
  const wrap = el("div", "brief-actions");
  const note = el("span", "brief-note", "");
  const label = record.score == null ? t("history.evaluateJob") : t("banner.reevaluate");

  if (!record.text) {
    note.textContent = t("history.noTextScore");
    wrap.appendChild(note);
    return wrap;
  }

  const button = el("button", null, label);
  button.addEventListener("click", async () => {
    const profile = store.profiles.find((p) => p.id === viewProfileId);
    if (!profile) {
      note.textContent = t("history.profileGone");
      return;
    }
    button.disabled = true;
    button.textContent = t("history.queueing");
    const response = await queueMessage({
      type: "JOB_FIT_ENQUEUE",
      priority: true,
      item: evaluateItem(record, profile, JOB_FIT_PROFILES.fingerprint(profile)),
    });

    if (!response || !response.ok) {
      button.disabled = false;
      button.textContent = label;
      note.textContent = response && response.full ? t("history.queueFull", { count: response.max }) : t("history.couldntQueue");
      return;
    }

    button.textContent = response.duplicate ? t("history.alreadyQueued") : t("history.queued");
    note.textContent = response.position > 1 ? t("history.reevalAfter") : t("history.reevalNow");
    refreshQueue();
  });
  wrap.appendChild(button);
  wrap.appendChild(note);
  return wrap;
}

// Resolved from the profile list rather than the record's stored copy, so a
// renamed profile is named correctly in a brief copied from an old job.
function profileDisplayName(record) {
  const live = store.profiles.find((p) => p.id === record.profileId);
  return (live && live.name) || record.profileName || t("common.unknown");
}

// One line, not two. Once you've applied, "applied 3d ago" is the fact that
// matters; the absolute date is reference and moves to the tooltip.
function buildWhen(record) {
  const when = el("span", "when");
  const activity = JOB_FIT_EVALSTORE.activityTs(record);
  if (record.appliedAt) {
    when.textContent = t("history.appliedAgo", { count: daysSince(record.appliedAt) });
    when.title = t("history.appliedTitle", { applied: formatDate(record.appliedAt), evaluated: formatDate(activity) });
  } else {
    const days = daysSince(activity);
    when.textContent = days === 0 ? t("history.today") : t("history.daysAgo", { count: days });
    when.title = t("history.evaluatedTitle", { date: formatDate(activity) });
  }
  return when;
}

function statusGroupOf(record) {
  const entry = Object.entries(STATUS_GROUPS).find(([, group]) => group.match(record));
  return entry ? entry[0] : "none";
}

// For pasting the job into a tracker, an email or a search box: position
// first, then company, in one click.
function buildCopyNameButton(record) {
  const btn = el("button", "copy-name", t("history.copyShort"));
  btn.type = "button";
  const text = [record.title, record.company].filter(Boolean).join(" — ");
  btn.title = text ? t("history.copyTitle", { text }) : t("history.nothingToCopy");
  btn.setAttribute("aria-label", btn.title);
  btn.disabled = !text;
  btn.addEventListener("click", async (event) => {
    // The row header toggles the card; copying shouldn't.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = t("history.copiedShort");
      JOB_FIT_UI.announce(t("history.copiedShort"));
    } catch (err) {
      btn.textContent = t("history.failedShort");
    }
    btn.classList.add("done");
    setTimeout(() => {
      btn.textContent = t("history.copyShort");
      btn.classList.remove("done");
    }, 1500);
  });
  return btn;
}

function duplicateSummary(d) {
  const score = d.hardReject ? t("result.hardReject") : d.score != null ? String(d.score) : t("result.noScore");
  const when = formatDate(JOB_FIT_EVALSTORE.activityTs(d));
  return `${JOB_FIT_EVALSTORE.siteLabel(d)} — ${score}, ${when}, ${JOB_FIT_EVALSTORE.statusLabel(d.status || "not_applied")}`;
}

// Flag, never merge: which copy to keep is the user's call, because only they
// know which one holds the status and notes that matter.
function buildDuplicateSection(record, dups) {
  const box = el("div", "dup-box");
  box.appendChild(el("h3", null, t("history.possibleDuplicate")));
  box.appendChild(el("div", "meta-line", t("history.duplicateExplain", { site: JOB_FIT_EVALSTORE.siteLabel(record) })));
  dups.forEach((d) => {
    const row = el("div", "dup-row");
    row.appendChild(el("span", "dup-what", duplicateSummary(d)));
    if (d.notes) row.appendChild(el("span", "dup-notes", `“${d.notes.slice(0, 60)}${d.notes.length > 60 ? "…" : ""}”`));
    const show = el("button", null, t("history.showIt"));
    show.type = "button";
    show.addEventListener("click", () => revealJob(d.jobKey));
    const notDup = el("button", null, t("history.notDuplicate"));
    notDup.type = "button";
    notDup.title = t("history.notDuplicateTitle");
    notDup.addEventListener("click", async () => {
      notDup.disabled = true;
      // Recorded on both sides, so deleting either one can't resurrect the flag
      // through the other.
      for (const [a, b] of [[record, d], [d, record]]) {
        const list = Array.from(new Set([...(a.notDuplicateOf || []), b.jobKey]));
        markSelfWrite(a.jobKey);
        const saved = await JOB_FIT_EVALSTORE.update(viewProfileId, a.jobKey, { notDuplicateOf: list });
        const index = records.findIndex((r) => r.jobKey === a.jobKey);
        if (saved && index !== -1) records[index] = saved;
      }
      render();
    });
    row.appendChild(show);
    row.appendChild(notDup);
    box.appendChild(row);
  });
  return box;
}

// How your other applications at this company went, and the way to see them
// all: a search for the company, which you can read and clear like any other.
function buildCompanyLine(record, note) {
  const line = el("div", "company-line");
  line.appendChild(el("span", null, note));
  const all = el("button", "link", t("company.showAll", { company: record.company }));
  all.type = "button";
  all.addEventListener("click", () => {
    groupFilter = null;
    els.statusFilter.value = "all";
    els.search.value = record.company;
    resetPage();
    render();
    JOB_FIT_UI.announce(t("company.showingAll", { company: record.company, count: visibleRecords().length }));
  });
  line.appendChild(all);
  return line;
}

function renderDupChip() {
  const host = document.getElementById("dupChip");
  host.innerHTML = "";
  // Counts extra copies, not flagged rows: one job tracked twice is "1
  // possible duplicate", not 2. Connected sets, so three copies of one job
  // count as 2 and two unrelated pairs as 2.
  const affected = dupSets.size - new Set(dupSets.values()).size;
  host.hidden = !affected;
  if (!affected) return;
  const chip = el("div", "stale-chip dup-chip");
  chip.setAttribute("aria-pressed", String(groupFilter === "duplicates"));
  const open = el("button", "stale-open");
  open.type = "button";
  open.title = t("history.dupChipTitle");
  open.appendChild(el("strong", null, String(affected)));
  open.appendChild(document.createTextNode(t("history.dupChip", { count: affected })));
  open.addEventListener("click", () => {
    groupFilter = groupFilter === "duplicates" ? null : "duplicates";
    els.statusFilter.value = "all";
    resetPage();
    render();
  });
  chip.appendChild(open);
  host.appendChild(chip);
}

// Side by side at this width: the list, and the selected job's details in a
// pane beside it. Narrower, a job's details open under its row instead.
const wideQuery = matchMedia("(min-width: 1100px)");

function isWide() {
  return wideQuery.matches;
}

// The job shown in the details pane (wide layout), by jobKey. Kept in the
// address (#job=…) so a reload, or the back button, lands on the same job.
let selectedKey = null;

const ICON_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

function setStatusFor(record) {
  return async (value) => {
    markSelfWrite(record.jobKey);
    const updated = await JOB_FIT_EVALSTORE.setStatus(viewProfileId, record.jobKey, value);
    if (updated) Object.assign(record, updated);
    JOB_FIT_UI.announce(t("history.statusSet", { status: JOB_FIT_EVALSTORE.statusLabel(value) }));
    // A full re-render keeps the row in the right place under every sort and
    // filter; focus is put back where it was (render()).
    safeRender();
  };
}

function openPostingLink(record, { withText = false } = {}) {
  const link = document.createElement("a");
  // Only ever a web address (a stored record is not trusted to be one).
  if (JOB_FIT_EVALSTORE.isWebUrl(record.url)) link.href = record.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  const title = record.title || t("history.untitled");
  if (withText) {
    link.innerHTML = ICON_OPEN;
    link.prepend(document.createTextNode(`${t("history.openPosting")} `));
  } else {
    link.className = "open-link";
    link.innerHTML = ICON_OPEN;
    link.title = t("history.openPosting");
    link.setAttribute("aria-label", t("history.openPostingFor", { title }));
  }
  link.addEventListener("click", (e) => e.stopPropagation());
  return link;
}

// Every badge a job has, most decisive first. The row shows only the first,
// so they don't crowd the title; the details show them all.
function badgesFor(record) {
  const list = [];
  if (record.hardReject) list.push(el("span", "badge", t("result.hardReject")));
  const reason = attentionReason(record);
  if (reason) list.push(el("span", "badge badge-attention", reason));
  const dups = dupGroups.get(record.jobKey);
  if (dups) {
    const badge = el("span", "badge badge-dup", t("history.possibleDuplicateBadge"));
    badge.title = dups.map((d) => t("history.alsoTracked", { what: duplicateSummary(d) })).join("\n");
    list.push(badge);
  }
  // Past its deadline and never applied to: still listed, no longer a to-do.
  if ((!record.status || record.status === "not_applied") && JOB_FIT_META.hasClosed(record.meta)) {
    list.push(el("span", "badge badge-muted", t("history.closedBadge")));
  }
  const outOfDate = staleReason(record);
  if (outOfDate) list.push(el("span", "badge badge-muted", outOfDate));
  if (!record.hardReject && record.score == null) list.push(el("span", "badge badge-muted", t("history.summaryOnly")));
  return list;
}

// What a screen reader hears before the title, since the coloured score box
// is decoration to it.
function scoreWords(record) {
  if (record.hardReject) return `${t("result.hardReject")}: `;
  if (record.score == null) return "";
  return `${t("history.scoreAria", { score: record.score })}: `;
}

function renderRow(record) {
  const card = el("div", "job");
  card.dataset.key = record.jobKey;
  // Closed rows fade rather than disappear: still findable, no longer
  // competing with the ones that need something from you.
  const statusClass = { none: "", waiting: "st-applied", active: "st-interviewing", closed: "st-closed" }[statusGroupOf(record)];
  if (record.status === "offer") card.classList.add("st-offer");
  else if (record.status === "ghosted") card.classList.add("st-ghosted");
  else if (statusClass) card.classList.add(statusClass);

  const wide = isWide();
  const selected = wide && selectedKey === record.jobKey;
  const open = !wide && openKeys.has(record.jobKey);
  card.classList.toggle("selected", selected);
  card.classList.toggle("open", open);
  const bodyId = `job-body-${CSS.escape(record.jobKey)}`;

  const head = el("div", "job-head");
  const chev = el("span", "chev", "▶");
  chev.setAttribute("aria-hidden", "true");
  head.appendChild(chev);
  head.appendChild(buildSelectBox(record));
  const score = el("div", `score ${record.hardReject ? "red" : scoreClass(record.score)}`, record.hardReject ? "✕" : String(record.score ?? "—"));
  score.setAttribute("aria-hidden", "true");
  head.appendChild(score);

  const titleWrap = el("div", "job-title");
  const line = el("div", "title-line");
  // The title is the row's real control: a button, so a job opens from the
  // keyboard. It used to be a click handler on a div, which Tab never reached.
  const titleBtn = el("button", "title-btn");
  titleBtn.type = "button";
  titleBtn.appendChild(el("span", "sr-only", scoreWords(record)));
  titleBtn.appendChild(document.createTextNode(record.title || t("history.untitled")));
  if (wide) {
    titleBtn.setAttribute("aria-controls", "detailPane");
    if (selected) titleBtn.setAttribute("aria-current", "true");
  } else {
    titleBtn.setAttribute("aria-expanded", String(open));
    titleBtn.setAttribute("aria-controls", bodyId);
  }
  titleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    activateRow(record.jobKey);
  });
  line.appendChild(titleBtn);
  line.appendChild(buildCopyNameButton(record));
  titleWrap.appendChild(line);
  // The one badge that matters most leads the second line, so the title keeps
  // the full width of the first.
  const sub = el("span", "job-sub");
  const [first] = badgesFor(record);
  if (first) {
    sub.appendChild(first);
    sub.appendChild(document.createTextNode(" "));
  }
  sub.appendChild(document.createTextNode([record.company, record.location].filter(Boolean).join(" · ") || record.url));
  sub.appendChild(document.createTextNode(" · "));
  sub.appendChild(buildWhen(record));
  titleWrap.appendChild(sub);
  head.appendChild(titleWrap);

  head.appendChild(buildStatusSelect(record, setStatusFor(record)));
  head.appendChild(openPostingLink(record));

  // The rest of the row still works as a big click target for the mouse.
  head.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select, label")) return;
    activateRow(record.jobKey);
  });
  card.appendChild(head);

  if (open) {
    const body = el("div", "job-body");
    body.id = bodyId;
    body.appendChild(renderJobDetails(record, { inline: true }));
    card.appendChild(body);
  }
  return card;
}

// A row's title button: in the wide layout it shows the job in the pane,
// narrower it opens the job under its row.
function activateRow(jobKey) {
  if (isWide()) {
    selectJob(jobKey);
    return;
  }
  if (openKeys.has(jobKey)) openKeys.delete(jobKey);
  else openKeys.add(jobKey);
  render({ focusKey: jobKey });
}

function selectJob(jobKey, { focusPane = false } = {}) {
  if (!records.some((r) => r.jobKey === jobKey)) return;
  selectedKey = jobKey;
  history.replaceState(null, "", `${location.pathname}${location.search}#job=${encodeURIComponent(jobKey)}`);
  document.querySelectorAll("#list .job").forEach((row) => {
    const on = row.dataset.key === jobKey;
    row.classList.toggle("selected", on);
    const btn = row.querySelector(".title-btn");
    if (on) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  });
  renderDetailPane();
  if (focusPane) {
    const heading = els.detailPane.querySelector("h2");
    if (heading) heading.focus();
  }
}

// The details, in the order you read a job: what it is and where, what was
// decided about it and why, what to do next, your notes, and the reference
// material (earlier scores, the brief, the posting itself) last.
function renderJobDetails(record, { inline = false } = {}) {
  const box = el("div", inline ? "details-inline" : "details");

  if (!inline) {
    const head = el("div", "d-head");
    const score = el("div", `score ${record.hardReject ? "red" : scoreClass(record.score)}`, record.hardReject ? "✕" : String(record.score ?? "—"));
    score.setAttribute("aria-hidden", "true");
    head.appendChild(score);
    const titles = el("div");
    const h2 = el("h2", null, record.title || t("history.untitled"));
    h2.id = "detailTitle";
    h2.tabIndex = -1;
    titles.appendChild(h2);
    titles.appendChild(el("div", "d-sub", [record.company, record.location].filter(Boolean).join(" · ")));
    head.appendChild(titles);
    box.appendChild(head);
  }

  const links = el("div", "d-links");
  links.appendChild(openPostingLink(record, { withText: true }));
  links.appendChild(el("span", "meta-line", JOB_FIT_EVALSTORE.siteLabel(record)));
  if (!inline) links.appendChild(buildStatusSelect(record, setStatusFor(record)));
  box.appendChild(links);

  // Requisition id, deadline, posting date — whatever the posting said.
  const posting = JOB_FIT_META.describe(record.meta, { applied: Boolean(record.status && record.status !== "not_applied") });
  if (posting.details.length) box.appendChild(el("div", "meta-line posting-line", posting.details.join(" · ")));

  const badges = badgesFor(record);
  if (badges.length) {
    const row = el("div", "d-badges");
    badges.forEach((b) => row.appendChild(b));
    box.appendChild(row);
  }

  const dups = dupGroups.get(record.jobKey);
  if (dups) box.appendChild(buildDuplicateSection(record, dups));

  const companyNote = JOB_FIT_EVALSTORE.companyHistoryNote(records, record);
  if (companyNote) box.appendChild(buildCompanyLine(record, companyNote));

  if (record.hardReject) {
    tagList(box, t("banner.rejectReason"), [`${record.hardReject.label}: "${record.hardReject.matchedText}"`], "tag-red");
  }

  const e = record.evaluation;
  if (e) {
    box.appendChild(el("h3", null, t("history.verdict")));
    const headline = el("div", "verdict-line");
    headline.appendChild(el("strong", null, `${record.score ?? "—"}/100`));
    if (e.verdict) headline.appendChild(el("span", "verdict-word", verdictLabel(e.verdict)));
    box.appendChild(headline);
    if (e.one_line) box.appendChild(el("div", null, e.one_line));
    if (record.durationMs) {
      const seconds = Math.round(record.durationMs / 1000);
      box.appendChild(
        el(
          "div",
          "meta-line",
          `${record.model ? t("history.scoredInBy", { seconds, model: record.model }) : t("history.scoredIn", { seconds })}${usageText(record.usage)}`
        )
      );
    }
    tagList(box, t("result.goodSigns"), record.positiveSignals, "tag-green");
    evaluationTags(box, e);
    const coreWork = record.coreWorkOnly || e.core_work_only || [];
    const disagreement = JOB_FIT_EVALSTORE.modelDisagreement(record);
    tagList(
      box,
      t("history.warnings"),
      [
        ...(posting.ageNote ? [posting.ageNote] : []),
        ...(record.softWarnings || []),
        ...(coreWork.length ? [t("result.coreWorkDiverges", { terms: coreWork.join(", ") })] : []),
        ...(disagreement
          ? [t("result.modelsDisagree", { spread: disagreement.spread, runs: disagreement.runs.map((r) => `${r.model} ${r.score}`).join(", ") })]
          : []),
      ],
      "tag-amber"
    );
    tagList(box, t("history.domainFlags"), record.domainFlags, "tag-neutral");
    tagList(box, t("result.learningFlags"), record.learningFlags, "tag-neutral");
  }

  // Actions: score it again, or delete it.
  const actions = el("div", "d-actions");
  if (!record.hardReject) actions.appendChild(buildEvaluateActions(record));
  actions.appendChild(el("span", "spacer"));
  const del = el("button", "danger", t("history.deleteEntry"));
  del.type = "button";
  JOB_FIT_UI.armConfirm(del, {
    confirmLabel: t("history.deleteAgain"),
    onConfirm: async () => {
      // The pane moves on to the next job rather than going blank.
      const order = lastShown.map((r) => r.jobKey);
      const next = order[order.indexOf(record.jobKey) + 1] || order[order.indexOf(record.jobKey) - 1] || null;
      markSelfWrite(record.jobKey);
      await JOB_FIT_EVALSTORE.remove(viewProfileId, record.jobKey);
      records = records.filter((r) => r.jobKey !== record.jobKey);
      openKeys.delete(record.jobKey);
      if (selectedKey === record.jobKey) selectedKey = next;
      JOB_FIT_UI.announce(t("history.deleted", { title: record.title || t("history.untitled") }));
      render({ focusKey: next });
    },
  });
  actions.appendChild(del);
  box.appendChild(actions);

  // Notes. Saved on change (blur) rather than per keystroke: no debounce to get
  // wrong, and a storage write per character is pointless.
  const notesId = `notes-${inline ? "inline-" : ""}${CSS.escape(record.jobKey)}`;
  const notesLabel = el("h3");
  const label = el("label", null, t("history.notes"));
  label.htmlFor = notesId;
  notesLabel.appendChild(label);
  box.appendChild(notesLabel);
  const notes = document.createElement("textarea");
  notes.className = "notes";
  notes.id = notesId;
  notes.value = record.notes || "";
  notes.placeholder = t("history.notesPlaceholder");
  box.appendChild(notes);
  const savedMsg = el("span", "saved", "");
  notes.addEventListener("change", async () => {
    markSelfWrite(record.jobKey);
    await JOB_FIT_EVALSTORE.update(viewProfileId, record.jobKey, { notes: notes.value });
    record.notes = notes.value;
    savedMsg.textContent = t("history.notesSaved");
    JOB_FIT_UI.announce(t("history.notesSaved"));
    setTimeout(() => (savedMsg.textContent = ""), 1800);
  });
  box.appendChild(savedMsg);

  appendPreviousResults(box, record);

  box.appendChild(el("h3", null, t("history.condensedBrief")));
  // Shown exactly as it's copied — the posting AND every model's score and
  // reasoning.
  if (record.summary) {
    box.appendChild(el("div", "desc", JOB_FIT_EVALSTORE.briefText(record, profileDisplayName(record))));
    if (!record.lastEvaluatedAt && !(record.previous || []).length) box.appendChild(el("div", "meta-line", t("history.noScoreYet")));
  }
  box.appendChild(buildBriefActions(record));

  box.appendChild(el("h3", null, t("history.fullPosting")));
  box.appendChild(el("div", "desc", record.text || t("history.notStored")));
  return box;
}

function renderDetailPane() {
  const pane = els.detailPane;
  // Nothing tracked: the list's empty state gets the whole width rather than
  // sitting next to an empty box.
  pane.closest(".split").classList.toggle("no-jobs", !records.length);
  if (!isWide() || !records.length) {
    pane.innerHTML = "";
    return;
  }
  const record = records.find((r) => r.jobKey === selectedKey);
  // Same job as before: keep where the pane was scrolled to.
  const keepScroll = pane.dataset.key === selectedKey ? pane.scrollTop : 0;
  pane.innerHTML = "";
  pane.dataset.key = record ? record.jobKey : "";
  if (!record) {
    pane.appendChild(el("div", "pane-empty", records.length ? t("history.selectJob") : ""));
    return;
  }
  pane.appendChild(renderJobDetails(record));
  pane.scrollTop = keepScroll;
}

// Where keyboard focus was in the list before a re-render, so it can be put
// back: a status set with a number key rebuilds every row, and focus must not
// fall back to the top of the page.
function captureListFocus() {
  const active = document.activeElement;
  const row = active && active.closest && active.closest("#list .job");
  if (!row) return null;
  const kind = ["title-btn", "status-select", "select-box", "copy-name", "open-link"].find((c) => active.classList.contains(c)) || "title-btn";
  return { key: row.dataset.key, kind };
}

function restoreListFocus(focus) {
  if (!focus) return;
  const row = Array.from(document.querySelectorAll("#list .job")).find((r) => r.dataset.key === focus.key);
  const target = row && (row.querySelector(`.${focus.kind}`) || row.querySelector(".title-btn"));
  if (target) target.focus({ preventScroll: false });
}

function rowFor(jobKey) {
  return Array.from(document.querySelectorAll("#list .job")).find((r) => r.dataset.key === jobKey) || null;
}

function focusRow(jobKey) {
  const row = rowFor(jobKey);
  if (!row) return;
  row.querySelector(".title-btn").focus();
  row.scrollIntoView({ block: "nearest" });
}

// --- empty states -----------------------------------------------------------

async function renderEmpty() {
  const box = el("div", "empty");
  box.appendChild(el("h2", null, t("history.emptyTitle")));
  let shortcut = "";
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "evaluate-tab");
    shortcut = (cmd && cmd.shortcut) || "";
  } catch (err) {
    /* commands API unavailable */
  }
  box.appendChild(el("p", null, shortcut ? t("history.emptyBody", { shortcut }) : t("history.emptyBodyNoShortcut")));
  const actions = el("div", "actions");
  const onPage = el("button", null, t("history.emptyOnPage"));
  onPage.type = "button";
  onPage.addEventListener("click", () => openSettings("onpage"));
  actions.appendChild(onPage);
  box.appendChild(actions);
  return box;
}

function renderNoMatches() {
  const box = el("div", "empty");
  box.appendChild(el("p", null, t("history.noMatches")));
  const actions = el("div", "actions");
  const clear = el("button", null, t("history.clearFilters"));
  clear.type = "button";
  clear.addEventListener("click", () => {
    groupFilter = null;
    els.statusFilter.value = "all";
    els.search.value = "";
    els.hideRejects.checked = false;
    resetPage();
    render();
    els.search.focus();
  });
  actions.appendChild(clear);
  box.appendChild(actions);
  return box;
}

// "More filters" says how many of its filters are on, so a list narrowed from
// inside the closed menu doesn't look like a list with jobs missing.
function renderMoreFiltersLabel() {
  const count = (els.statusFilter.value !== "all" ? 1 : 0) + (els.hideRejects.checked ? 1 : 0);
  els.moreFiltersLabel.textContent = count ? t("history.moreFiltersCount", { count }) : t("history.moreFilters");
}

// --- keyboard ---------------------------------------------------------------
//
// One key per action, ignored while typing in a field, so they never get in
// the way of search or notes. The same list is in the "?" dialog.

const SHORTCUTS = [
  { keys: ["/"], label: () => t("history.kbSearch") },
  { keys: ["j", "k"], label: () => t("history.kbMove") },
  { keys: ["Enter", "o"], label: () => t("history.kbOpen") },
  { keys: ["x"], label: () => t("history.kbSelect") },
  { keys: ["1", "…", "7"], label: () => t("history.kbStatus", { list: JOB_FIT_EVALSTORE.STATUSES.map((s, i) => `${i + 1} ${s.label}`).join(", ") }) },
  { keys: ["Esc"], label: () => t("history.kbClose") },
  { keys: ["?"], label: () => t("history.kbHelp") },
];

function renderShortcutsList() {
  const list = document.getElementById("shortcutsList");
  list.innerHTML = "";
  SHORTCUTS.forEach(({ keys, label }) => {
    const dt = el("dt");
    keys.forEach((k, i) => {
      if (k === "…") {
        dt.appendChild(document.createTextNode(" – "));
        return;
      }
      if (i && keys[i - 1] !== "…") dt.appendChild(document.createTextNode(" "));
      dt.appendChild(el("kbd", null, k));
    });
    list.appendChild(dt);
    list.appendChild(el("dd", null, label()));
  });
}

function openShortcuts() {
  const dialog = document.getElementById("shortcutsDialog");
  renderShortcutsList();
  if (!dialog.open) dialog.showModal();
}

function currentKey() {
  const active = document.activeElement;
  const row = active && active.closest && active.closest("#list .job");
  if (row) return row.dataset.key;
  if (active && els.detailPane.contains(active)) return selectedKey;
  return isWide() ? selectedKey : null;
}

function moveBy(delta) {
  const order = lastShown.map((r) => r.jobKey);
  if (!order.length) return;
  // Nothing in the list has focus yet: the first press lands on the job the
  // pane is already showing rather than skipping past it.
  const active = document.activeElement;
  const inList = active && ((active.closest && active.closest("#list .job")) || els.detailPane.contains(active));
  if (!inList && isWide() && order.includes(selectedKey)) {
    focusRow(selectedKey);
    return;
  }
  const from = order.indexOf(currentKey());
  let index = from === -1 ? (delta > 0 ? 0 : order.length - 1) : from + delta;
  const pages = ui.pageSize ? Math.ceil(lastVisible.length / ui.pageSize) : 1;
  // Past the end of the page: carry on onto the next (or previous) one.
  if (index >= order.length && page < pages - 1) {
    goToPage(page + 1);
    index = 0;
  } else if (index < 0 && page > 0) {
    goToPage(page - 1);
    index = lastShown.length - 1;
  }
  const keys = lastShown.map((r) => r.jobKey);
  const key = keys[Math.max(0, Math.min(keys.length - 1, index))];
  if (isWide()) selectJob(key);
  focusRow(key);
}

function onKeydown(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.getElementById("shortcutsDialog").open) return; // the dialog handles its own keys
  const target = e.target;
  const typing = target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

  if (e.key === "Escape") {
    if (target === els.search && els.search.value) return; // native: clears the search
    if (typing) {
      target.blur();
      return;
    }
    const key = currentKey();
    if (els.detailPane.contains(document.activeElement) && key) {
      e.preventDefault();
      focusRow(key);
    } else if (!isWide() && key && openKeys.has(key)) {
      e.preventDefault();
      activateRow(key);
    }
    return;
  }
  if (typing) return;

  const key = currentKey();
  switch (e.key) {
    case "/":
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    case "j":
      e.preventDefault();
      moveBy(1);
      return;
    case "k":
      e.preventDefault();
      moveBy(-1);
      return;
    case "?":
      e.preventDefault();
      openShortcuts();
      return;
    case "o":
    case "Enter": {
      // Enter on a button or link already does what it says.
      if (e.key === "Enter" && target.closest("button, a, summary")) return;
      if (!key) return;
      e.preventDefault();
      if (isWide()) selectJob(key, { focusPane: true });
      else activateRow(key);
      return;
    }
    case "x": {
      const box = key && rowFor(key) && rowFor(key).querySelector(".select-box");
      if (box && !box.disabled) {
        e.preventDefault();
        box.click();
      }
      return;
    }
    default:
      if (/^[1-9]$/.test(e.key) && key) {
        const status = JOB_FIT_EVALSTORE.STATUSES[Number(e.key) - 1];
        const record = records.find((r) => r.jobKey === key);
        if (!status || !record) return;
        e.preventDefault();
        setStatusFor(record)(status.value);
      }
  }
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

// Days of silence after applying before a job is worth chasing. Two weeks is
// the point past which most processes have either moved or gone quiet for good;
// the row states the actual number so the rule is never magic.
const SILENCE_DAYS = 14;

// "Needs attention" is the page answering what to do next. Each rule carries
// its own wording, because a list of jobs with no stated reason is just another
// filter — the reason is the useful part.
//
// Ordered: the first match wins, most decisive first. Hard rejects are excluded
// throughout — they are disqualified, not pending.
const ATTENTION_RULES = [
  {
    test: (r) => r.status === "offer",
    label: () => t("attention.offer"),
  },
  {
    test: (r) => r.status === "interviewing",
    label: () => t("attention.interview"),
  },
  {
    // Ahead of the strong match: one that closes on Friday is the more urgent
    // fact about it. Not for a skip — a deadline doesn't make it worth it.
    test: (r) =>
      (!r.status || r.status === "not_applied") &&
      JOB_FIT_META.closingSoon(r.meta) != null &&
      !(r.score != null && r.score < JOB_FIT_UI.AMBER_FROM),
    label: (r) => {
      const days = JOB_FIT_META.closingSoon(r.meta);
      return days === 0 ? t("attention.closesToday") : t("attention.closesIn", { count: days });
    },
  },
  {
    // Deliberately reuses the card's green threshold: if the tool calls it a
    // strong match, and you haven't acted, that is the thing to act on —
    // unless applications have closed, and there's nothing left to act on.
    test: (r) =>
      (!r.status || r.status === "not_applied") &&
      r.score != null &&
      r.score >= JOB_FIT_UI.GREEN_FROM &&
      !JOB_FIT_META.hasClosed(r.meta),
    label: (r) => t("attention.strongMatch", { score: r.score }),
  },
  {
    // Only "applied": ghosted means you have already decided it went quiet.
    test: (r) => r.status === "applied" && r.appliedAt && daysSince(r.appliedAt) >= SILENCE_DAYS,
    label: (r) => t("attention.noReply", { count: daysSince(r.appliedAt) }),
  },
];

function attentionReason(record) {
  if (record.hardReject) return null;
  const rule = ATTENTION_RULES.find((r) => r.test(record));
  return rule ? rule.label(record) : null;
}

// The buckets a search actually moves through. Finer-grained filtering stays
// on the Status dropdown; these answer "what should I do next?".
// Labels are getters so they follow the interface language.
const STATUS_GROUPS = {
  none: { get label() { return t("group.none"); }, match: (r) => !r.status || r.status === "not_applied" },
  waiting: { get label() { return t("group.waiting"); }, match: (r) => r.status === "applied" },
  active: { get label() { return t("group.active"); }, match: (r) => r.status === "interviewing" || r.status === "offer" },
  closed: {
    get label() { return t("group.closed"); },
    match: (r) => r.status === "rejected" || r.status === "ghosted" || r.status === "withdrawn",
  },
};

const FILTERS = Object.assign(
  {
    attention: { get label() { return t("group.attention"); }, match: (r) => Boolean(attentionReason(r)) },
    stale: { get label() { return t("group.stale"); }, match: (r) => Boolean(staleReason(r)) },
    duplicates: { get label() { return t("group.duplicates"); }, match: (r) => dupGroups.has(r.jobKey) },
  },
  STATUS_GROUPS
);

// Chips and the Status dropdown are mutually exclusive — using one clears the
// other, so the list is never filtered by two controls at once.
let groupFilter = null;

function queueStateLabel(state) {
  return JOB_FIT_I18N.has(`qstate.${state}`) ? t(`qstate.${state}`) : state;
}

async function queueMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return null;
  }
}

// The last queue snapshot seen, for the brief status and the toolbar pill.
let latestQueue = null;

function renderQueue(queue) {
  latestQueue = queue || null;
  renderQueuePill();
  refreshBriefStatuses();
  const panel = document.getElementById("queuePanel");
  const itemsEl = document.getElementById("queueItems");
  const pauseEl = document.getElementById("queuePause");
  const resumeBtn = document.getElementById("queueResume");

  // Every profile's items live in one queue, but this page shows one profile,
  // so only that profile's work belongs here.
  const items = ((queue && queue.items) || []).filter((i) => i.profileId === viewProfileId);
  if (!items.length) {
    panel.hidden = true;
    lastQueueCount = -1;
    return;
  }
  panel.hidden = false;

  const waiting = items.filter((i) => i.state === "pending").length;
  const doneCount = items.filter((i) => i.state === "done").length;
  const failedCount = items.filter((i) => i.state === "failed").length;
  const running = items.find((i) => i.state === "processing");
  document.getElementById("queueTitle").textContent = [
    t("queue.title"),
    running ? t("qstate.processing") : null,
    t("queue.waitingCount", { count: waiting }),
    doneCount ? t("queue.doneCount", { count: doneCount }) : null,
    failedCount ? t("queue.failedCount", { count: failedCount }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const paused = queue.state === "paused";
  pauseEl.hidden = !paused;
  resumeBtn.hidden = !paused;
  if (paused) {
    pauseEl.textContent = t("queue.pausedExplain", { reason: queue.pauseReason || t("queue.unreachable") });
  }

  // The list runs oldest to newest, so new work lands at the bottom: follow it
  // there on load and whenever something is added — unless you've scrolled up
  // to read an item, which a routine refresh shouldn't yank you away from.
  const wasAtBottom = itemsEl.scrollTop + itemsEl.clientHeight >= itemsEl.scrollHeight - 4;
  const added = items.length > lastQueueCount;
  const firstRender = lastQueueCount === -1;
  lastQueueCount = items.length;

  const runningEl = document.getElementById("queueRunning");
  runningEl.innerHTML = "";
  itemsEl.innerHTML = "";
  items.forEach((item) => {
    const row = el("div", "qrow");
    row.appendChild(el("span", `qstate ${item.state}`, queueStateLabel(item.state)));
    row.appendChild(
      el("span", "qtitle", `${item.title || item.url || item.jobKey}${item.kind === "summarize" ? `  ${t("queue.briefTag")}` : ""}`)
    );

    // Read from the record rather than stored on the queue item: the score
    // belongs to the record, and the worker writes it before marking the item
    // done, so it is already in `records` by the time this runs.
    const finished = records.find((r) => r.jobKey === item.jobKey);
    // Evaluations only — a brief carries no score of its own, and showing the
    // job's score on a brief row implies it produced it.
    if (item.kind !== "summarize" && item.state === "done" && finished && finished.score != null) {
      row.appendChild(el("span", `qscore ${scoreClass(finished.score)}`, String(finished.score)));
    }

    if (item.state === "failed") {
      const retry = el("button", null, t("queue.retry"));
      retry.addEventListener("click", async () => {
        await queueMessage({ type: "JOB_FIT_QUEUE_RETRY", id: item.id });
        refreshQueue();
      });
      row.appendChild(retry);
    }
    if (item.state === "pending" || item.state === "processing") {
      const cancel = el("button", null, t("common.cancel"));
      cancel.addEventListener("click", async () => {
        await queueMessage({ type: "JOB_FIT_QUEUE_CANCEL", id: item.id });
        refreshQueue();
      });
      row.appendChild(cancel);
    }

    // Pinned above the scroll area, so following the newest item never hides
    // the one actually running.
    if (item === running) {
      runningEl.appendChild(row);
      return;
    }
    itemsEl.appendChild(row);
    if (item.error && item.state === "failed") itemsEl.appendChild(el("div", "qerr", item.error));
  });

  if (firstRender || added || wasAtBottom) itemsEl.scrollTop = itemsEl.scrollHeight;
}

// -1 until the first render, so opening the page starts at the bottom.
let lastQueueCount = -1;

async function refreshQueue() {
  const snapshot = await queueMessage({ type: "JOB_FIT_QUEUE_SNAPSHOT" });
  renderQueue(snapshot);
}

function markSelfWrite(jobKey) {
  selfWrites.add(JOB_FIT_EVALSTORE.recordKey(viewProfileId, jobKey));
}

// Re-rendering rebuilds every card, which would blow away a half-typed note.
// Defer until the field is no longer being typed in rather than dropping the
// update.
let renderQueued = false;
let flushTimer = null;

function notesHasFocus() {
  const active = document.activeElement;
  return Boolean(active && active.classList && active.classList.contains("notes"));
}

function flushPendingRender() {
  if (!renderQueued || notesHasFocus()) return;
  clearInterval(flushTimer);
  flushTimer = null;
  renderQueued = false;
  render();
}

function safeRender() {
  if (!notesHasFocus()) {
    render();
    return;
  }
  if (renderQueued) return;
  renderQueued = true;
  // Polled, not driven by a blur event alone. If the window loses focus while
  // a note is being edited, or the field goes away some other way, blur can
  // simply never fire — and a deferred render that never flushes leaves the
  // page silently stale with no way back. The blur listener below is only
  // there to make the common case feel instant.
  flushTimer = setInterval(flushPendingRender, 800);
  document.activeElement.addEventListener("blur", flushPendingRender, { once: true });
}

// Evaluations are written by a content script in whatever tab the posting is
// open in, so this page would otherwise sit there stale until reloaded — you'd
// evaluate a job, switch to this tab, and not see it.
function watchForChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    // The queue is written by the service worker, so this is how the panel
    // stays live while a batch runs.
    if (changes.queue) renderQueue(changes.queue.newValue);

    // A profile renamed or added in the popup should show up in the selector.
    if (changes.profiles) {
      store.profiles = changes.profiles.newValue || store.profiles;
      renderProfileOptions();
    }

    // Swapping the model or editing the CV changes which scores are out of date.
    if (changes.profiles || changes.lmStudio || changes.modelProvider || changes.openai) {
      loadCurrentScoring().then(safeRender);
    }

    const prefix = `ev:${viewProfileId}:`;
    let touched = false;

    Object.keys(changes).forEach((key) => {
      if (!key.startsWith(prefix)) return;
      if (selfWrites.delete(key)) return;

      const { newValue } = changes[key];
      const jobKey = key.slice(prefix.length);
      const index = records.findIndex((r) => r.jobKey === jobKey);

      if (!newValue) {
        if (index !== -1) records.splice(index, 1);
        openKeys.delete(jobKey);
      } else if (index === -1) {
        records.push(newValue);
      } else {
        records[index] = newValue;
      }
      touched = true;
    });

    if (touched) safeRender();
  });
}

// Every render rebuilds the rows. What the user was doing survives it: which
// jobs are open or ticked (held outside the DOM), the job in the details pane,
// and where keyboard focus was.
let renderToken = 0;

function render({ focusKey } = {}) {
  const token = ++renderToken;
  const focus = focusKey ? { key: focusKey, kind: "title-btn" } : captureListFocus();
  dupGroups = JOB_FIT_EVALSTORE.duplicateGroups(records);
  dupSets = JOB_FIT_EVALSTORE.duplicateSets(dupGroups);
  if (groupFilter === "duplicates" && !dupGroups.size) groupFilter = null;
  renderDupChip();
  renderFunnel();
  for (const key of selectedKeys) {
    if (!records.some((r) => r.jobKey === key && canReevaluate(r))) selectedKeys.delete(key);
  }
  renderStaleChip();
  renderMoreFiltersLabel();
  const visible = visibleRecords();

  // Clamped rather than reset: a job leaving the list (deleted, or no longer
  // matching after a status change) shouldn't bounce you back to page 1.
  const size = ui.pageSize || visible.length || 1;
  const pages = Math.max(1, Math.ceil(visible.length / size));
  page = Math.min(page, pages - 1);
  const shown = ui.pageSize ? visible.slice(page * size, page * size + size) : visible;

  // The pane always shows a job the list can reach: the one asked for, or
  // the first on screen when that one is filtered out.
  if (isWide()) {
    if (!visible.some((r) => r.jobKey === selectedKey)) selectedKey = shown.length ? shown[0].jobKey : null;
  }

  els.list.innerHTML = "";
  if (!records.length) {
    renderEmpty().then((box) => {
      if (token === renderToken) els.list.appendChild(box);
    });
  } else if (!visible.length) {
    els.list.appendChild(renderNoMatches());
  } else {
    shown.forEach((record) => els.list.appendChild(renderRow(record)));
  }

  renderToolbar(visible, shown);
  renderPager(els.pagerTop, visible.length, pages, { withSize: true });
  renderPager(els.pagerBottom, visible.length, pages, { withSize: false });
  renderDetailPane();
  restoreListFocus(focus);
}

function goToPage(n) {
  page = n;
  render();
  // Back to the top of the list, not the top of the page: the queue and the
  // filters above it haven't changed.
  const toolbar = document.getElementById("listToolbar");
  if (toolbar.getBoundingClientRect().top < 0) toolbar.scrollIntoView({ block: "start" });
}

function renderPager(host, total, pages, { withSize }) {
  host.innerHTML = "";
  // The bottom pager is only there to save scrolling back up; with one page
  // there's nothing to page to.
  if (!withSize && pages < 2) return;
  if (!total) return;
  const pager = el("div", "pager");

  if (withSize) {
    const label = el("label", "per-page");
    label.appendChild(document.createTextNode(`${t("history.perPage")} `));
    const select = document.createElement("select");
    PAGE_SIZES.forEach((n) => {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n ? String(n) : t("history.all");
      select.appendChild(opt);
    });
    select.value = String(ui.pageSize);
    select.addEventListener("change", () => {
      // Keep the first job you were looking at on screen after resizing.
      const firstShown = page * (ui.pageSize || 0);
      ui.pageSize = Number(select.value);
      saveUi();
      page = ui.pageSize ? Math.floor(firstShown / ui.pageSize) : 0;
      render();
    });
    label.appendChild(select);
    pager.appendChild(label);
  }

  if (pages > 1) {
    const prev = el("button", null, "‹");
    prev.type = "button";
    prev.title = t("history.prevPage");
    prev.disabled = page === 0;
    prev.addEventListener("click", () => goToPage(page - 1));
    const next = el("button", null, "›");
    next.type = "button";
    next.title = t("history.nextPage");
    next.disabled = page >= pages - 1;
    next.addEventListener("click", () => goToPage(page + 1));
    pager.appendChild(prev);
    pager.appendChild(el("span", "page-of", `${page + 1} / ${pages}`));
    pager.appendChild(next);
  }
  host.appendChild(pager);
}

function renderFunnel() {
  const host = document.getElementById("funnel");
  host.innerHTML = "";

  const attention = records.filter(FILTERS.attention.match).length;
  const chips = [
    // First, and only when there is something in it: an empty "needs attention"
    // is the best possible state and should not occupy the eye.
    ...(attention ? [{ key: "attention", label: t("group.attention"), count: attention, urgent: true }] : []),
    { key: null, label: t("history.all"), count: records.length },
    ...Object.entries(STATUS_GROUPS).map(([key, group]) => ({
      key,
      label: group.label,
      count: records.filter(group.match).length,
    })),
  ];

  chips.forEach((chip) => {
    const { key, label, count } = chip;
    // A bucket you have nothing in is noise, unless it's the one you're in.
    if (key && !count && groupFilter !== key) return;
    const btn = document.createElement("button");
    btn.type = "button";
    if (chip.urgent) btn.className = "urgent";
    btn.setAttribute("aria-pressed", String(groupFilter === key));
    const n = document.createElement("strong");
    n.textContent = String(count);
    btn.appendChild(n);
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", () => {
      groupFilter = groupFilter === key ? null : key;
      els.statusFilter.value = "all";
      resetPage();
      render();
    });
    host.appendChild(btn);
  });
}

function csvCell(value) {
  const str = value == null ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const rows = [
    [
      t("csv.title"),
      t("csv.company"),
      t("csv.location"),
      t("csv.score"),
      t("csv.verdict"),
      t("csv.hardReject"),
      t("csv.status"),
      t("csv.evaluated"),
      t("csv.applied"),
      t("csv.reqId"),
      t("csv.closes"),
      t("csv.posted"),
      "URL",
      t("csv.notes"),
    ],
    ...visibleRecords().map((r) => [
      r.title,
      r.company,
      r.location,
      r.score == null ? "" : r.score,
      r.verdict ? (r.hardReject ? t("result.hardReject") : verdictLabel(r.verdict)) : r.summary ? t("history.summaryOnly") : "",
      r.hardReject ? r.hardReject.matchedText : "",
      JOB_FIT_EVALSTORE.statusLabel(r.status || "not_applied"),
      r.lastEvaluatedAt ? new Date(r.lastEvaluatedAt).toISOString().slice(0, 10) : "",
      r.appliedAt ? new Date(r.appliedAt).toISOString().slice(0, 10) : "",
      (r.meta && r.meta.reqId) || "",
      (r.meta && r.meta.deadline) || "",
      (r.meta && r.meta.postedOn) || "",
      r.url,
      r.notes,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  JOB_FIT_BACKUP.download(csv, "text/csv;charset=utf-8", `job-fit-history-${new Date().toISOString().slice(0, 10)}.csv`);
}

function renderProfileOptions() {
  const previous = els.profileSelect.value;
  els.profileSelect.innerHTML = "";
  store.profiles.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    els.profileSelect.appendChild(opt);
  });
  // Opens on whichever profile the popup is set to, since that's the one you
  // were just evaluating with; a later rebuild keeps whatever is being viewed.
  const wanted = previous || store.activeProfileId;
  els.profileSelect.value = store.profiles.some((p) => p.id === wanted) ? wanted : store.profiles[0].id;
}

// Results of a bulk action (re-evaluating the ticked jobs), in a status box
// under the filters. Backup, restore and the extraction report are in
// Settings › Data.
function showPageStatus(text, isError = false) {
  els.pageStatus.textContent = text;
  els.pageStatus.className = `page-status${isError ? " error" : ""}`;
  els.pageStatus.hidden = false;
}

async function loadCurrentScoring() {
  const profile = store.profiles.find((p) => p.id === viewProfileId);
  current = {
    model: JOB_FIT_PROVIDER.currentModel(await chrome.storage.local.get(JOB_FIT_PROVIDER.KEYS)),
    fingerprint: profile ? JOB_FIT_PROFILES.fingerprint(profile) : null,
  };
}

// Only jobs that were scored and still have their posting text can be
// re-scored from here — without the text there is nothing to re-send. Hard
// rejects come from the keyword scan, which the model never overrides.
function canReevaluate(record) {
  return Boolean(record.text) && !record.hardReject;
}

// Why a score is out of date, or null. A score is stale when the profile it
// was scored under has changed, or when a different model produced it. Both
// matter because the page ranks by score: a list mixing scores from an old CV
// or a swapped-out model is a ranking that looks authoritative and isn't.
function staleReason(record) {
  if (record.score == null || !canReevaluate(record) || !current.fingerprint) return null;
  const byModel = (record.model || "") !== current.model;
  const byProfile = record.profileFingerprint !== current.fingerprint;
  if (byModel) return record.model ? t("history.scoredBy", { model: record.model }) : t("history.scoredByAnother");
  if (byProfile) return t("history.olderProfile");
  return null;
}

function staleSignature(stale) {
  return `${current.model}|${current.fingerprint}|${stale.length}`;
}

// A chip beside the filters instead of a full-width banner: the rows carry
// their own "scored by …" badge, so this only has to say how many and offer
// the filter. Dismissing hides it until the out-of-date set changes (another
// model, another profile edit, or more jobs), so it never hides news.
function renderStaleChip() {
  const host = els.staleChip;
  const stale = records.filter((r) => staleReason(r));
  const dismissed = ui.staleDismissed === staleSignature(stale);
  if (!stale.length && groupFilter === "stale") groupFilter = null;
  host.hidden = !stale.length || (dismissed && groupFilter !== "stale");
  host.innerHTML = "";
  if (host.hidden) return;

  const byModel = stale.some((r) => (r.model || "") !== current.model);
  const byProfile = stale.some((r) => r.profileFingerprint !== current.fingerprint);
  const why = JOB_FIT_I18N.list([byProfile && t("history.staleWhyProfile"), byModel && t("history.staleWhyModel")].filter(Boolean));

  const chip = el("div", "stale-chip");
  chip.setAttribute("aria-pressed", String(groupFilter === "stale"));
  const open = el("button", "stale-open");
  open.type = "button";
  open.title = t("history.staleTitle", { why });
  open.appendChild(el("strong", null, String(stale.length)));
  open.appendChild(document.createTextNode(t("history.outOfDate"))); 
  open.addEventListener("click", () => {
    groupFilter = groupFilter === "stale" ? null : "stale";
    els.statusFilter.value = "all";
    resetPage();
    render();
  });
  const dismiss = el("button", "stale-dismiss", "×");
  dismiss.type = "button";
  dismiss.title = t("history.staleDismissTitle");
  dismiss.setAttribute("aria-label", t("history.staleDismissAria"));
  dismiss.addEventListener("click", () => {
    ui.staleDismissed = staleSignature(stale);
    saveUi();
    if (groupFilter === "stale") groupFilter = null;
    render();
  });
  chip.appendChild(open);
  chip.appendChild(dismiss);
  host.appendChild(chip);
}

function buildSelectBox(record) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "select-box";
  box.title = t("history.selectTitle");
  if (!canReevaluate(record)) {
    // Kept in the row, disabled, so the columns still line up.
    box.disabled = true;
    box.title = record.hardReject ? t("history.selectRejected") : t("history.selectNoText");
    return box;
  }
  box.checked = selectedKeys.has(record.jobKey);
  // The row header toggles the card open; ticking a box shouldn't.
  box.addEventListener("click", (event) => event.stopPropagation());
  box.addEventListener("change", () => {
    if (box.checked) selectedKeys.add(record.jobKey);
    else selectedKeys.delete(record.jobKey);
    renderToolbar(lastVisible, lastShown);
  });
  return box;
}

// What the toolbar was last rendered with, so ticking one box can refresh it
// without re-rendering the whole list.
let lastVisible = [];
let lastShown = [];

function renderToolbar(visible, shown) {
  lastVisible = visible;
  lastShown = shown;
  const host = els.toolbarLeft;
  host.innerHTML = "";
  if (!visible.length) return;

  const pageSelectable = shown.filter(canReevaluate);
  const allSelectable = visible.filter(canReevaluate);
  const pageSelected = pageSelectable.filter((r) => selectedKeys.has(r.jobKey)).length;

  // Tri-state, like a mail client: ticks this page's rows, not the whole list.
  const all = document.createElement("input");
  all.type = "checkbox";
  all.className = "select-all";
  all.title = t("history.selectPage");
  all.disabled = !pageSelectable.length;
  all.checked = pageSelectable.length > 0 && pageSelected === pageSelectable.length;
  all.indeterminate = pageSelected > 0 && pageSelected < pageSelectable.length;
  all.addEventListener("change", () => {
    pageSelectable.forEach((r) => (all.checked ? selectedKeys.add(r.jobKey) : selectedKeys.delete(r.jobKey)));
    render();
  });
  host.appendChild(all);

  const count = selectedKeys.size;
  if (!count) {
    const from = ui.pageSize ? page * ui.pageSize + 1 : 1;
    const to = from + shown.length - 1;
    const noun = groupFilter === "stale" ? "countStale" : groupFilter === "duplicates" ? "countDup" : "countJobs";
    const what = t(`history.${noun}`, { count: visible.length });
    host.appendChild(
      el(
        "span",
        "count",
        shown.length === visible.length
          ? `${visible.length} ${what}`
          : t("history.rangeOf", { from, to, total: visible.length, what })
      )
    );
    // The action the old full-width notice carried, now where the list is.
    if (groupFilter === "stale" && allSelectable.length) {
      const pick = el("button", null, t("history.selectAllN", { count: allSelectable.length }));
      pick.type = "button";
      pick.addEventListener("click", () => {
        allSelectable.forEach((r) => selectedKeys.add(r.jobKey));
        render();
      });
      host.appendChild(pick);
    }
    return;
  }

  host.appendChild(el("span", "count selected", t("history.selectedCount", { count })));
  const run = el("button", "primary", t("history.reevaluateN", { count }));
  run.type = "button";
  run.addEventListener("click", () => requeueSelected(run));
  host.appendChild(run);
  const clear = el("button", null, t("history.clear"));
  clear.type = "button";
  clear.addEventListener("click", () => {
    selectedKeys.clear();
    render();
  });
  host.appendChild(clear);

  // Offered once this page is fully ticked and there's more beyond it.
  const unselectedElsewhere = allSelectable.filter((r) => !selectedKeys.has(r.jobKey)).length;
  if (pageSelected === pageSelectable.length && unselectedElsewhere) {
    const more = el("button", "link", t("history.selectAllMatching", { count: allSelectable.length }));
    more.type = "button";
    more.addEventListener("click", () => {
      allSelectable.forEach((r) => selectedKeys.add(r.jobKey));
      render();
    });
    host.appendChild(more);
  }
}

// A queue item that re-scores a stored job under the given profile. The
// posting text is already on the record, so no tab or page visit is needed.
function evaluateItem(record, profile, fingerprint) {
  return {
    kind: "evaluate",
    jobKey: record.jobKey,
    profileId: profile.id,
    profileName: profile.name,
    profileSnapshot: { profile: profile.profile, expectedSalary: profile.expectedSalary, jobSearch: profile.jobSearch, fingerprint },
    postingText: record.text,
    title: record.title,
    company: record.company,
    location: record.location,
    url: record.url,
    extractor: record.extractor,
    domainFlags: record.domainFlags || [],
    learningFlags: record.learningFlags || [],
    softWarnings: record.softWarnings || [],
  };
}

// Queues the ticked jobs with the current model and profile. Each one that
// gets in is unticked; any the queue had no room for stay ticked, so running
// it again once some finish picks up exactly where it stopped.
async function requeueSelected(btn) {
  const profile = store.profiles.find((p) => p.id === viewProfileId);
  if (!profile) return;
  btn.disabled = true;
  btn.textContent = t("history.queueing");

  const fingerprint = JOB_FIT_PROFILES.fingerprint(profile);
  const chosen = records.filter((r) => selectedKeys.has(r.jobKey) && canReevaluate(r));
  let queued = 0;
  let full = false;

  for (const record of chosen) {
    const response = await queueMessage({
      type: "JOB_FIT_ENQUEUE",
      // Bulk: nobody is waiting on these, so they may use OpenAI's Flex
      // processing (half price, slower) — see the popup's Flex setting.
      item: { ...evaluateItem(record, profile, fingerprint), bulk: true },
    });
    if (response && response.full) { full = true; break; }
    if (response && response.ok) {
      if (!response.duplicate) queued++;
      selectedKeys.delete(record.jobKey);
    }
  }

  const left = selectedKeys.size;
  showPageStatus(full ? t("history.bulkQueuedFull", { queued, count: left }) : t("history.bulkQueued", { count: queued }));
  render();
  refreshQueue();
}

let viewProfileIdLoaded = null;

async function loadProfile(profileId) {
  viewProfileId = profileId;
  openKeys.clear();
  selectedKeys.clear();
  if (profileId !== viewProfileIdLoaded) selectedKey = null;
  viewProfileIdLoaded = profileId;
  await loadCurrentScoring();
  groupFilter = null;
  resetPage();
  records = await JOB_FIT_EVALSTORE.list(profileId);
  render();
  await refreshQueue();
}

async function init() {
  await JOB_FIT_I18N.load();
  JOB_FIT_I18N.translatePage();
  document.title = `${t("history.title")} — JobFit`;
  // Another page switched the language: this one follows on its next load
  // rather than half-translating itself now.
  JOB_FIT_I18N.watch(() => location.reload());
  JOB_FIT_EVALSTORE.STATUSES.forEach(({ value, label }) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    els.statusFilter.appendChild(opt);
  });
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = t("history.allStatuses");
  els.statusFilter.insertBefore(all, els.statusFilter.firstChild);
  els.statusFilter.value = "all";

  store = await JOB_FIT_PROFILES.load();
  await loadUi();
  renderProfileOptions();

  els.profileSelect.addEventListener("change", () => loadProfile(els.profileSelect.value));
  const relist = () => {
    resetPage();
    render();
  };
  [els.sortSelect, els.hideRejects].forEach((node) => node.addEventListener("change", relist));
  els.statusFilter.addEventListener("change", () => {
    groupFilter = null; // the dropdown and the chips never filter at once
    relist();
  });
  els.search.addEventListener("input", relist);
  // The filter menu closes when you click elsewhere, like any menu.
  const moreFilters = document.getElementById("moreFilters");
  document.addEventListener("click", (e) => {
    if (moreFilters.open && !moreFilters.contains(e.target)) moreFilters.removeAttribute("open");
  });
  moreFilters.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && moreFilters.open) {
      e.stopPropagation();
      moreFilters.removeAttribute("open");
      moreFilters.querySelector("summary").focus();
    }
  });

  document.getElementById("exportCsv").addEventListener("click", exportCsv);
  document.getElementById("openSettings").addEventListener("click", () => openSettings());

  // Keyboard shortcuts, and the list of them.
  document.addEventListener("keydown", onKeydown);
  const shortcuts = document.getElementById("shortcutsDialog");
  document.getElementById("showShortcuts").addEventListener("click", openShortcuts);
  document.getElementById("closeShortcuts").addEventListener("click", () => shortcuts.close());
  shortcuts.addEventListener("click", (e) => {
    if (e.target === shortcuts) shortcuts.close(); // a click on the backdrop
  });

  // Crossing the width where the list and the details sit side by side.
  wideQuery.addEventListener("change", () => render());
  // A #job= typed or pasted into the address, or reached with Back.
  window.addEventListener("hashchange", () => {
    const wanted = new URLSearchParams(location.hash.slice(1)).get("job");
    if (wanted && wanted !== selectedKey) revealJob(wanted);
  });

  document.getElementById("queuePill").addEventListener("click", () =>
    document.getElementById("queuePanel").scrollIntoView({ behavior: "smooth", block: "start" })
  );
  document.getElementById("queueResume").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_RESUME" });
    refreshQueue();
  });
  document.getElementById("queueClear").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_CLEAR_FINISHED" });
    refreshQueue();
  });

  watchForChanges();

  // Opened from the result panel's "Tracked jobs" button: land on the right profile and
  // on the right job, rather than at the top of a long list.
  const params = new URLSearchParams(location.search);
  const wantedProfile = params.get("profile");
  // ?job= from the card; #job= is this page's own, kept as you select jobs.
  const hashJob = new URLSearchParams(location.hash.slice(1)).get("job");
  const wantedJob = params.get("job") || hashJob;
  if (wantedProfile && store.profiles.some((p) => p.id === wantedProfile)) {
    els.profileSelect.value = wantedProfile;
  }

  await loadProfile(els.profileSelect.value);
  if (wantedJob) revealJob(wantedJob);
}

// Brings one job into view, clearing any filter that would hide it: selected in
// the details pane (wide) or opened under its row (narrow), then flashed so it
// stands out among identical-looking rows.
function revealJob(jobKey) {
  if (!records.some((r) => r.jobKey === jobKey)) return;
  groupFilter = null;
  els.statusFilter.value = "all";
  els.search.value = "";
  els.hideRejects.checked = false;
  const visible = visibleRecords();
  const index = visible.findIndex((r) => r.jobKey === jobKey);
  page = ui.pageSize && index > 0 ? Math.floor(index / ui.pageSize) : 0;
  if (isWide()) selectedKey = jobKey;
  else openKeys.add(jobKey);
  render({ focusKey: jobKey });
  const row = rowFor(jobKey);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1600);
}

init();
