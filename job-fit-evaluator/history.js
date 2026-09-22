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

const els = {
  subtitle: document.getElementById("subtitle"),
  profileSelect: document.getElementById("profileSelect"),
  sortSelect: document.getElementById("sortSelect"),
  statusFilter: document.getElementById("statusFilter"),
  search: document.getElementById("search"),
  hideRejects: document.getElementById("hideRejects"),
  list: document.getElementById("list"),
};

function scoreClass(score) {
  // Null means summarized but never scored — that has to read as neutral, not
  // as a red 0, which is what a hard reject looks like.
  if (score == null) return "";
  if (score >= 75) return "green";
  if (score >= 55) return "amber";
  return "red";
}

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

function visibleRecords() {
  const query = els.search.value.trim().toLowerCase();
  const status = els.statusFilter.value;
  return sortRecords(
    records.filter((r) => {
      if (els.hideRejects.checked && r.hardReject) return false;
      if (status !== "all" && r.status !== status) return false;
      if (!query) return true;
      // Notes are searched too — a recruiter's name or "asked about OpenCL" is
      // exactly what you come back looking for weeks later.
      return `${r.title || ""} ${r.company || ""} ${r.location || ""} ${r.notes || ""} ${r.summary || ""} ${r.text || ""}`
        .toLowerCase()
        .includes(query);
    }),
    els.sortSelect.value
  );
}

function buildStatusSelect(record, onChange) {
  const select = document.createElement("select");
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
    note.textContent = "No stored posting text for this job, so a brief can't be generated.";
    wrap.appendChild(note);
    return wrap;
  }

  const summarize = el("button", null, record.summary ? "Re-summarize" : "Summarize this job");
  summarize.addEventListener("click", async () => {
    summarize.disabled = true;
    summarize.textContent = "Queueing…";
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
      summarize.textContent = record.summary ? "Re-summarize" : "Summarize this job";
      note.textContent = response && response.full
        ? `Queue is full (${response.max}) — let some finish first.`
        : "Couldn't queue it.";
      return;
    }

    summarize.textContent = response.duplicate ? "Already queued" : "Queued";
    note.textContent =
      response.position > 1
        ? `Running after the job in progress — the brief appears here on its own.`
        : "Running now — the brief appears here on its own.";
    refreshQueue();
  });
  wrap.appendChild(summarize);

  if (record.summary) {
    const copy = el("button", null, "Copy brief");
    copy.addEventListener("click", async () => {
      // Same text the popup copies: header line, brief, then this profile's
      // evaluation — built here so it stays in step with the popup's version.
      const header = [record.title, record.company, record.location].filter(Boolean).join(" — ");
      const text =
        (header ? `${header}\n\n` : "") +
        record.summary +
        JOB_FIT_EVALSTORE.formatEvaluation(record, profileDisplayName(record));
      try {
        await navigator.clipboard.writeText(text);
        note.textContent = "Copied — ready to paste into your other assistant.";
      } catch (err) {
        note.textContent = "Couldn't copy automatically.";
      }
      setTimeout(() => (note.textContent = ""), 3000);
    });
    wrap.appendChild(copy);
  }

  wrap.appendChild(note);
  return wrap;
}

// Resolved from the profile list rather than the record's stored copy, so a
// renamed profile is named correctly in a brief copied from an old job.
function profileDisplayName(record) {
  const live = store.profiles.find((p) => p.id === record.profileId);
  return (live && live.name) || record.profileName || "unknown";
}

function renderJob(record) {
  const card = el("div", "job");

  const head = el("div", "job-head");
  head.appendChild(el("span", "chev", "▶"));

  const score = el("div", `score ${record.hardReject ? "red" : scoreClass(record.score)}`, String(record.score ?? "—"));
  head.appendChild(score);

  const titleWrap = el("div", "job-title");
  const strong = el("strong", null, record.title || "(untitled posting)");
  if (record.hardReject) strong.appendChild(el("span", "badge", "hard reject"));
  else if (record.score == null) strong.appendChild(el("span", "badge badge-muted", "summary only"));
  titleWrap.appendChild(strong);
  titleWrap.appendChild(
    el("span", null, [record.company, record.location].filter(Boolean).join(" · ") || record.url)
  );
  head.appendChild(titleWrap);

  const when = el("div", "when");
  when.appendChild(el("div", null, formatDate(JOB_FIT_EVALSTORE.activityTs(record))));
  if (record.appliedAt) {
    when.appendChild(el("div", null, `applied ${daysSince(record.appliedAt)}d ago`));
  }
  head.appendChild(when);

  head.appendChild(
    buildStatusSelect(record, async (value) => {
      markSelfWrite(record.jobKey);
      const updated = await JOB_FIT_EVALSTORE.setStatus(viewProfileId, record.jobKey, value);
      if (updated) Object.assign(record, updated);
      // A full re-render is safe now that openKeys preserves expansion, and it
      // keeps the row in the right place under every sort and filter — the
      // old partial-update path only refreshed the date column.
      safeRender();
    })
  );

  if (openKeys.has(record.jobKey)) card.classList.add("open");
  head.addEventListener("click", () => {
    const nowOpen = card.classList.toggle("open");
    if (nowOpen) openKeys.add(record.jobKey);
    else openKeys.delete(record.jobKey);
  });
  card.appendChild(head);

  const body = el("div", "job-body");

  body.appendChild(el("h3", null, "Link"));
  const link = document.createElement("a");
  link.href = record.url;
  link.textContent = record.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  body.appendChild(link);

  if (record.hardReject) {
    tagList(body, "Reject reason", [`${record.hardReject.label}: "${record.hardReject.matchedText}"`], "tag-red");
  }

  const e = record.evaluation;
  if (e) {
    body.appendChild(el("h3", null, "Verdict"));
    const headline = el("div", "verdict-line");
    headline.appendChild(el("strong", null, `${record.score ?? "—"}/100`));
    if (e.verdict) headline.appendChild(el("span", "verdict-word", e.verdict));
    if (record.hardReject) headline.appendChild(el("span", "badge", "hard reject"));
    body.appendChild(headline);
    if (e.one_line) body.appendChild(el("div", null, e.one_line));
    tagList(body, "Matches", e.matches, "tag-green");
    tagList(body, "Gaps", e.gaps, "tag-amber");
    tagList(body, "Required gaps", e.required_gaps, "tag-red");
    tagList(body, "Seniority / comp check", e.seniority_flag ? [e.seniority_flag] : [], "tag-red");
    tagList(body, "Score cap applied", e.score_cap_reasons, "tag-amber");
    tagList(body, "Warnings", record.softWarnings, "tag-amber");
    tagList(body, "Domain flags", record.domainFlags, "tag-neutral");
    if (e.salary) {
      tagList(
        body,
        "Salary",
        [
          `Posting: ${e.salary.posting_stated}`,
          `Market estimate: ${e.salary.estimated_market_range}`,
          `vs. expectation: ${e.salary.vs_candidate_expectation}`,
          e.salary.note,
        ],
        "tag-neutral"
      );
    }
  }

  body.appendChild(el("h3", null, "Condensed brief"));
  if (record.summary) body.appendChild(el("div", "desc", record.summary));
  body.appendChild(buildBriefActions(record));

  body.appendChild(el("h3", null, "Full posting as extracted"));
  body.appendChild(el("div", "desc", record.text || "(not stored)"));

  body.appendChild(el("h3", null, "Notes"));
  const notes = document.createElement("textarea");
  notes.className = "notes";
  notes.value = record.notes || "";
  notes.placeholder = "Recruiter, comp discussed, follow-up dates…";
  body.appendChild(notes);

  const actions = el("div", "row-actions");
  const savedMsg = el("span", "saved", "");
  // Saved on blur rather than per keystroke: no debounce to get wrong, and a
  // storage write per character is pointless.
  notes.addEventListener("change", async () => {
    markSelfWrite(record.jobKey);
    await JOB_FIT_EVALSTORE.update(viewProfileId, record.jobKey, { notes: notes.value });
    record.notes = notes.value;
    savedMsg.textContent = "Notes saved";
    setTimeout(() => (savedMsg.textContent = ""), 1800);
  });
  actions.appendChild(savedMsg);

  const del = el("button", "danger", "Delete this entry");
  let armed = false;
  del.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      del.textContent = "Click again to delete";
      setTimeout(() => {
        armed = false;
        del.textContent = "Delete this entry";
      }, 4000);
      return;
    }
    markSelfWrite(record.jobKey);
    await JOB_FIT_EVALSTORE.remove(viewProfileId, record.jobKey);
    records = records.filter((r) => r.jobKey !== record.jobKey);
    openKeys.delete(record.jobKey);
    render();
  });
  actions.appendChild(del);
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

// ---------------------------------------------------------------------------
// Queue panel
// ---------------------------------------------------------------------------

const QUEUE_STATE_LABEL = {
  pending: "waiting",
  processing: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

async function queueMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return null;
  }
}

function renderQueue(queue) {
  const panel = document.getElementById("queuePanel");
  const itemsEl = document.getElementById("queueItems");
  const pauseEl = document.getElementById("queuePause");
  const resumeBtn = document.getElementById("queueResume");

  // Every profile's items live in one queue, but this page shows one profile,
  // so only that profile's work belongs here.
  const items = ((queue && queue.items) || []).filter((i) => i.profileId === viewProfileId);
  if (!items.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const waiting = items.filter((i) => i.state === "pending").length;
  const running = items.some((i) => i.state === "processing");
  document.getElementById("queueTitle").textContent = running
    ? `Queue — running, ${waiting} waiting`
    : `Queue — ${waiting} waiting`;

  const paused = queue.state === "paused";
  pauseEl.hidden = !paused;
  resumeBtn.hidden = !paused;
  if (paused) {
    pauseEl.textContent = `Paused: ${queue.pauseReason || "the local model was unreachable"} — fix it, then hit Resume. Nothing was lost.`;
  }

  itemsEl.innerHTML = "";
  items.forEach((item) => {
    const row = el("div", "qrow");
    row.appendChild(el("span", `qstate ${item.state}`, QUEUE_STATE_LABEL[item.state] || item.state));
    row.appendChild(
      el("span", "qtitle", `${item.title || item.url || item.jobKey}${item.kind === "summarize" ? "  (brief)" : ""}`)
    );

    if (item.state === "failed") {
      const retry = el("button", null, "Retry");
      retry.addEventListener("click", async () => {
        await queueMessage({ type: "JOB_FIT_QUEUE_RETRY", id: item.id });
        refreshQueue();
      });
      row.appendChild(retry);
    }
    if (item.state === "pending" || item.state === "processing") {
      const cancel = el("button", null, "Cancel");
      cancel.addEventListener("click", async () => {
        await queueMessage({ type: "JOB_FIT_QUEUE_CANCEL", id: item.id });
        refreshQueue();
      });
      row.appendChild(cancel);
    }

    itemsEl.appendChild(row);
    if (item.error && item.state === "failed") itemsEl.appendChild(el("div", "qerr", item.error));
  });
}

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

function render() {
  const visible = visibleRecords();
  els.list.innerHTML = "";

  if (!records.length) {
    els.list.appendChild(
      el(
        "div",
        "empty",
        "Nothing tracked under this profile yet. Open a job posting and hit “Evaluate this tab” or “Summarize this tab”."
      )
    );
  } else if (!visible.length) {
    els.list.appendChild(el("div", "empty", "No jobs match these filters."));
  } else {
    visible.forEach((record) => els.list.appendChild(renderJob(record)));
  }

  const applied = records.filter((r) => r.status && r.status !== "not_applied").length;
  const evaluated = records.filter((r) => r.score != null).length;
  const profileName = (store.profiles.find((p) => p.id === viewProfileId) || {}).name || "";
  els.subtitle.textContent =
    `${profileName} — ${records.length} tracked · ${evaluated} evaluated · ${applied} applied to` +
    (visible.length !== records.length ? ` · showing ${visible.length}` : "");
}

function csvCell(value) {
  const str = value == null ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const rows = [
    ["Title", "Company", "Location", "Score", "Verdict", "Hard reject", "Status", "Evaluated", "Applied", "URL", "Notes"],
    ...visibleRecords().map((r) => [
      r.title,
      r.company,
      r.location,
      r.score == null ? "" : r.score,
      r.verdict || (r.summary ? "summary only" : ""),
      r.hardReject ? r.hardReject.matchedText : "",
      JOB_FIT_EVALSTORE.statusLabel(r.status || "not_applied"),
      r.lastEvaluatedAt ? new Date(r.lastEvaluatedAt).toISOString().slice(0, 10) : "",
      r.appliedAt ? new Date(r.appliedAt).toISOString().slice(0, 10) : "",
      r.url,
      r.notes,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `job-fit-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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

async function loadProfile(profileId) {
  viewProfileId = profileId;
  openKeys.clear();
  records = await JOB_FIT_EVALSTORE.list(profileId);
  render();
  await refreshQueue();
}

async function init() {
  JOB_FIT_EVALSTORE.STATUSES.forEach(({ value, label }) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    els.statusFilter.appendChild(opt);
  });
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All statuses";
  els.statusFilter.insertBefore(all, els.statusFilter.firstChild);
  els.statusFilter.value = "all";

  store = await JOB_FIT_PROFILES.load();
  renderProfileOptions();

  els.profileSelect.addEventListener("change", () => loadProfile(els.profileSelect.value));
  [els.sortSelect, els.statusFilter, els.hideRejects].forEach((node) =>
    node.addEventListener("change", render)
  );
  els.search.addEventListener("input", render);
  document.getElementById("exportCsv").addEventListener("click", exportCsv);
  document.getElementById("queueResume").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_RESUME" });
    refreshQueue();
  });
  document.getElementById("queueClear").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_CLEAR_FINISHED" });
    refreshQueue();
  });

  watchForChanges();
  await loadProfile(els.profileSelect.value);
}

init();
