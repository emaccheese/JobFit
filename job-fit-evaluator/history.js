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
      if (groupFilter && !FILTERS[groupFilter].match(r)) return false;
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

// Re-scores this one job with the current model and profile. Hard rejects are
// left alone: they come from the keyword scan, which the model never overrides.
// The result it replaces is kept on the record (see saveEvaluation).
function buildEvaluateActions(record) {
  const wrap = el("div", "brief-actions");
  const note = el("span", "brief-note", "");
  const label = record.score == null ? "Evaluate this job" : "Re-evaluate";

  if (!record.text) {
    note.textContent = "No stored posting text for this job, so it can't be re-scored from here.";
    wrap.appendChild(note);
    return wrap;
  }

  const button = el("button", null, label);
  button.addEventListener("click", async () => {
    const profile = store.profiles.find((p) => p.id === viewProfileId);
    if (!profile) {
      note.textContent = "This profile no longer exists.";
      return;
    }
    button.disabled = true;
    button.textContent = "Queueing…";
    const response = await queueMessage({
      type: "JOB_FIT_ENQUEUE",
      priority: true,
      item: evaluateItem(record, profile, JOB_FIT_PROFILES.fingerprint(profile)),
    });

    if (!response || !response.ok) {
      button.disabled = false;
      button.textContent = label;
      note.textContent = response && response.full
        ? `Queue is full (${response.max}) — let some finish first.`
        : "Couldn't queue it.";
      return;
    }

    button.textContent = response.duplicate ? "Already queued" : "Queued";
    note.textContent =
      (response.position > 1 ? "Running after the job in progress" : "Running now") +
      " — the new score appears here on its own; the current one is kept as a previous result.";
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
  return (live && live.name) || record.profileName || "unknown";
}

// One line, not two. Once you've applied, "applied 3d ago" is the fact that
// matters; the absolute date is reference and moves to the tooltip.
function buildWhen(record) {
  const when = el("div", "when");
  const activity = JOB_FIT_EVALSTORE.activityTs(record);
  if (record.appliedAt) {
    when.textContent = `applied ${daysSince(record.appliedAt)}d ago`;
    when.title = `Applied ${formatDate(record.appliedAt)} · evaluated ${formatDate(activity)}`;
  } else {
    const days = daysSince(activity);
    when.textContent = days === 0 ? "today" : `${days}d ago`;
    when.title = `Evaluated ${formatDate(activity)}`;
  }
  return when;
}

function statusGroupOf(record) {
  const entry = Object.entries(STATUS_GROUPS).find(([, group]) => group.match(record));
  return entry ? entry[0] : "none";
}

function renderJob(record) {
  const card = el("div", "job");
  // Closed rows fade rather than disappear: still findable, no longer competing
  // with the ones that need something from you.
  const statusClass = { none: "", waiting: "st-applied", active: "st-interviewing", closed: "st-closed" }[
    statusGroupOf(record)
  ];
  if (record.status === "offer") card.classList.add("st-offer");
  else if (record.status === "ghosted") card.classList.add("st-ghosted");
  else if (statusClass) card.classList.add(statusClass);

  const head = el("div", "job-head");
  head.appendChild(el("span", "chev", "▶"));

  const score = el("div", `score ${record.hardReject ? "red" : scoreClass(record.score)}`, String(record.score ?? "—"));
  head.appendChild(score);

  const titleWrap = el("div", "job-title");
  const strong = el("strong", null, record.title || "(untitled posting)");
  if (record.hardReject) strong.appendChild(el("span", "badge", "hard reject"));
  else if (record.score == null) strong.appendChild(el("span", "badge badge-muted", "summary only"));
  // Shown on every qualifying row, not only when the filter is on, so the
  // actionable jobs stand out while scanning the ordinary list.
  const reason = attentionReason(record);
  if (reason) strong.appendChild(el("span", "badge badge-attention", reason));
  titleWrap.appendChild(strong);
  titleWrap.appendChild(
    el("span", null, [record.company, record.location].filter(Boolean).join(" · ") || record.url)
  );
  head.appendChild(titleWrap);

  head.appendChild(buildWhen(record));

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
    if (record.durationMs) {
      body.appendChild(el("div", "meta-line", `Scored in ${Math.round(record.durationMs / 1000)}s${record.model ? ` by ${record.model}` : ""}`));
    }
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

  if (!record.hardReject) body.appendChild(buildEvaluateActions(record));

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
    label: () => "offer — decide",
  },
  {
    test: (r) => r.status === "interviewing",
    label: () => "interview scheduled",
  },
  {
    // Deliberately reuses the banner's green threshold: if the tool calls it a
    // strong match, and you haven't acted, that is the thing to act on.
    test: (r) => (!r.status || r.status === "not_applied") && r.score != null && r.score >= 75,
    label: (r) => `strong match (${r.score}) — not applied`,
  },
  {
    // Only "applied": ghosted means you have already decided it went quiet.
    test: (r) => r.status === "applied" && r.appliedAt && daysSince(r.appliedAt) >= SILENCE_DAYS,
    label: (r) => `no reply in ${daysSince(r.appliedAt)} days`,
  },
];

function attentionReason(record) {
  if (record.hardReject) return null;
  const rule = ATTENTION_RULES.find((r) => r.test(record));
  return rule ? rule.label(record) : null;
}

// The buckets a search actually moves through. Finer-grained filtering stays
// on the Status dropdown; these answer "what should I do next?".
const STATUS_GROUPS = {
  none: { label: "Not applied", match: (r) => !r.status || r.status === "not_applied" },
  waiting: { label: "Waiting", match: (r) => r.status === "applied" },
  active: { label: "In play", match: (r) => r.status === "interviewing" || r.status === "offer" },
  closed: {
    label: "Closed",
    match: (r) => r.status === "rejected" || r.status === "ghosted" || r.status === "withdrawn",
  },
};

const FILTERS = Object.assign({ attention: { label: "Needs attention", match: (r) => Boolean(attentionReason(r)) } }, STATUS_GROUPS);

// Chips and the Status dropdown are mutually exclusive — using one clears the
// other, so the list is never filtered by two controls at once.
let groupFilter = null;

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
  renderFunnel();
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

  const profileName = (store.profiles.find((p) => p.id === viewProfileId) || {}).name || "";
  els.subtitle.textContent =
    visible.length === records.length ? profileName : `${profileName} — showing ${visible.length} of ${records.length}`;
}

function renderFunnel() {
  const host = document.getElementById("funnel");
  host.innerHTML = "";

  const attention = records.filter(FILTERS.attention.match).length;
  const chips = [
    // First, and only when there is something in it: an empty "needs attention"
    // is the best possible state and should not occupy the eye.
    ...(attention ? [{ key: "attention", label: "Needs attention", count: attention, urgent: true }] : []),
    { key: null, label: "All", count: records.length },
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

// ---------------------------------------------------------------------------
// Backup / restore
//
// The CSV export covers tracked jobs only. Profiles, LM Studio settings and a
// job's status, notes and brief are not in it — and uninstalling the extension
// wipes chrome.storage.local with no warning, which is exactly how a search
// history gets lost. This is the full picture.
// ---------------------------------------------------------------------------

const BACKUP_FORMAT = "jobfit-backup";
const BACKUP_VERSION = 1;

function showBackupStatus(text, isError = false) {
  const box = document.getElementById("backupStatus");
  box.textContent = text;
  // Explicitly reset: the probe report leaves a monospace neutral style here.
  box.className = `backup-status${isError ? " error" : ""}`;
  box.hidden = false;
}

async function exportData() {
  const stored = await chrome.storage.local.get(["profiles", "activeProfileId", "lmStudio"]);
  // The queue and lastSummary are deliberately left out: both are transient
  // working state, and the queue holds tab ids that mean nothing on restore.
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: stored.profiles || [],
    activeProfileId: stored.activeProfileId || null,
    lmStudio: stored.lmStudio || null,
    records: await JOB_FIT_EVALSTORE.exportRecords(),
  };

  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `jobfit-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);

  showBackupStatus(
    `Backed up ${payload.profiles.length} profile(s) and ${payload.records.length} tracked job(s). ` +
      `Keep the file somewhere outside this folder — uninstalling the extension erases its storage.`
  );
}

// Everything here comes from a file on disk, so it is treated as untrusted:
// only known fields are read, profiles go through normalize() before being
// stored, and nothing existing is ever overwritten.
async function importData(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    showBackupStatus(`That file isn't valid JSON: ${err.message}`, true);
    return;
  }

  if (!payload || payload.format !== BACKUP_FORMAT) {
    showBackupStatus("That doesn't look like a JobFit backup file.", true);
    return;
  }
  if (payload.version > BACKUP_VERSION) {
    showBackupStatus(`That backup was written by a newer version (v${payload.version}).`, true);
    return;
  }

  // Assigns the module-level `store`, not a local one: a local would shadow it,
  // and the refresh at the end would then repopulate the selector from the
  // stale copy — an imported profile would be saved but never appear.
  store = await JOB_FIT_PROFILES.load();
  const existingIds = new Set(store.profiles.map((p) => p.id));
  let profilesAdded = 0;
  let profilesSkipped = 0;

  (Array.isArray(payload.profiles) ? payload.profiles : []).forEach((raw) => {
    if (!raw || typeof raw !== "object" || !raw.id) return;
    if (existingIds.has(raw.id)) {
      profilesSkipped++;
      return;
    }
    store.profiles.push(JOB_FIT_PROFILES.normalize(raw));
    existingIds.add(raw.id);
    profilesAdded++;
  });

  if (profilesAdded) await JOB_FIT_PROFILES.save(store);

  let added = 0;
  let skipped = 0;
  let invalid = 0;
  for (const record of Array.isArray(payload.records) ? payload.records : []) {
    // Only for profiles that exist here, so a job can't be orphaned into a
    // profile nothing references.
    if (!record || !existingIds.has(record.profileId)) {
      invalid++;
      continue;
    }
    const outcome = await JOB_FIT_EVALSTORE.importRecord(record);
    if (outcome === "added") added++;
    else if (outcome === "skipped") skipped++;
    else invalid++;
  }

  // Applied only when nothing is configured here, so restoring a friend's
  // backup can't silently repoint your endpoint at theirs.
  const current = await chrome.storage.local.get("lmStudio");
  let settingsNote = "";
  if (payload.lmStudio && !(current.lmStudio && current.lmStudio.model)) {
    await chrome.storage.local.set({ lmStudio: payload.lmStudio });
    settingsNote = "\nLM Studio settings restored.";
  } else if (payload.lmStudio) {
    settingsNote = "\nLM Studio settings left alone — you already have a model configured.";
  }

  const lines = [
    `Restored from ${payload.exportedAt ? payload.exportedAt.slice(0, 10) : "backup"}.`,
    `Profiles: ${profilesAdded} added${profilesSkipped ? `, ${profilesSkipped} already here` : ""}.`,
    `Jobs: ${added} added${skipped ? `, ${skipped} already here` : ""}${invalid ? `, ${invalid} unusable` : ""}.`,
    "Nothing existing was overwritten.",
  ];
  showBackupStatus(lines.join("\n") + settingsNote);

  renderProfileOptions();
  await loadProfile(els.profileSelect.value);
}

// A record is stale when the profile it was scored under has changed, or when
// it was scored by a different model. Both matter because the page ranks by
// score: a list mixing scores from an old CV or a swapped-out model is a
// ranking that looks authoritative and isn't.
async function findStaleRecords() {
  const profile = store.profiles.find((p) => p.id === viewProfileId);
  if (!profile) return { stale: [], reason: null };

  const fingerprint = JOB_FIT_PROFILES.fingerprint(profile);
  const settings = await chrome.storage.local.get("lmStudio");
  const model = (settings.lmStudio && settings.lmStudio.model) || "";

  let profileChanged = 0;
  let modelChanged = 0;
  const stale = records.filter((r) => {
    // Only jobs that were actually scored and still have their posting text —
    // without the text there is nothing to re-send.
    if (r.score == null || !r.text || r.hardReject) return false;
    const byProfile = r.profileFingerprint !== fingerprint;
    const byModel = (r.model || "") !== model;
    if (byProfile) profileChanged++;
    if (byModel) modelChanged++;
    return byProfile || byModel;
  });

  const reasons = [];
  if (profileChanged) reasons.push("the profile has changed");
  if (modelChanged) reasons.push("a different model is configured");
  return { stale, reason: reasons.join(" and "), profile, fingerprint };
}

async function renderStaleNotice() {
  const box = document.getElementById("staleNotice");
  const { stale, reason } = await findStaleRecords();
  if (!stale.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = "";
  const count = stale.length;
  box.appendChild(
    el(
      "span",
      null,
      `${count} job${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} out of date — ${reason}. ` +
        `${count === 1 ? "Its score isn't" : "Their scores aren't"} comparable with the rest of this list.`
    )
  );
  const btn = el("button", null, `Re-queue ${stale.length}`);
  btn.addEventListener("click", () => requeueStale(btn));
  box.appendChild(btn);
}

// A queue item that re-scores a stored job under the given profile. The
// posting text is already on the record, so no tab or page visit is needed.
function evaluateItem(record, profile, fingerprint) {
  return {
    kind: "evaluate",
    jobKey: record.jobKey,
    profileId: profile.id,
    profileName: profile.name,
    profileSnapshot: { profile: profile.profile, expectedSalary: profile.expectedSalary, fingerprint },
    postingText: record.text,
    title: record.title,
    company: record.company,
    location: record.location,
    url: record.url,
    extractor: record.extractor,
    domainFlags: record.domainFlags || [],
    softWarnings: record.softWarnings || [],
  };
}

// Re-runs stale jobs through the normal queue. The posting text is already on
// the record, so this needs no tab and no page visit.
async function requeueStale(btn) {
  btn.disabled = true;
  btn.textContent = "Queueing…";

  const { stale, profile, fingerprint } = await findStaleRecords();
  let queued = 0;
  let rejected = 0;

  for (const record of stale) {
    const response = await queueMessage({
      type: "JOB_FIT_ENQUEUE",
      item: evaluateItem(record, profile, fingerprint),
    });
    if (response && response.ok && !response.duplicate) queued++;
    // The queue caps at 10; the rest stay stale and can be re-queued next time.
    else if (response && response.full) { rejected = stale.length - queued; break; }
  }

  btn.disabled = false;
  btn.textContent = `Re-queue ${stale.length}`;
  showBackupStatus(
    rejected
      ? `Queued ${queued}. The queue is full, so ${rejected} still need re-scoring — come back once these finish.`
      : `Queued ${queued} job${queued === 1 ? "" : "s"} for re-scoring.`
  );
  refreshQueue();
}

// Reports what the probe saw, so the decision to build JSON-LD extraction (or
// not) comes from real browsing rather than an assumption. The number that
// matters is the last column: not whether JSON-LD was present, but whether it
// held something the extractor had missed.
async function showProbeReport() {
  const stored = await chrome.storage.local.get("jsonLdProbe");
  const samples = (stored.jsonLdProbe && stored.jsonLdProbe.samples) || [];
  const box = document.getElementById("backupStatus");
  box.className = "backup-status neutral";
  box.hidden = false;

  if (!samples.length) {
    box.textContent = "No pages sampled yet. Evaluate a few postings and check back.";
    return;
  }

  const byHost = new Map();
  samples.forEach((s) => {
    const row = byHost.get(s.host) || { seen: 0, found: 0, adds: 0 };
    row.seen++;
    if (s.found) row.found++;
    if ((s.wouldAdd || []).length) row.adds++;
    byHost.set(s.host, row);
  });

  const found = samples.filter((s) => s.found).length;
  const helped = samples.filter((s) => (s.wouldAdd || []).length).length;
  const fieldCounts = {};
  samples.forEach((s) => (s.wouldAdd || []).forEach((f) => (fieldCounts[f] = (fieldCounts[f] || 0) + 1)));

  const pct = (n) => `${Math.round((n / samples.length) * 100)}%`;
  const lines = [
    `${samples.length} pages sampled`,
    `JSON-LD JobPosting found on ${found} (${pct(found)})`,
    `Would have added something on ${helped} (${pct(helped)})`,
    Object.keys(fieldCounts).length
      ? `  fields: ${Object.entries(fieldCounts).map(([f, n]) => `${f} ×${n}`).join(", ")}`
      : "  fields: none",
    "",
    "host                                  seen  found  adds",
  ];
  [...byHost.entries()]
    .sort((a, b) => b[1].seen - a[1].seen)
    .forEach(([host, row]) => {
      lines.push(`${host.slice(0, 36).padEnd(36)}  ${String(row.seen).padStart(4)}  ${String(row.found).padStart(5)}  ${String(row.adds).padStart(4)}`);
    });

  box.textContent = lines.join("\n");
}

async function loadProfile(profileId) {
  viewProfileId = profileId;
  openKeys.clear();
  groupFilter = null;
  records = await JOB_FIT_EVALSTORE.list(profileId);
  render();
  await refreshQueue();
  await renderStaleNotice();
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
  [els.sortSelect, els.hideRejects].forEach((node) => node.addEventListener("change", render));
  els.statusFilter.addEventListener("change", () => {
    groupFilter = null; // the dropdown and the chips never filter at once
    render();
  });
  els.search.addEventListener("input", render);
  const dataMenu = document.getElementById("dataMenu");
  const closeDataMenu = () => dataMenu.removeAttribute("open");
  document.addEventListener("click", (e) => {
    if (dataMenu.open && !dataMenu.contains(e.target)) closeDataMenu();
  });

  document.getElementById("exportCsv").addEventListener("click", () => {
    closeDataMenu();
    exportCsv();
  });
  document.getElementById("exportData").addEventListener("click", () => {
    closeDataMenu();
    exportData();
  });
  document.getElementById("probeReport").addEventListener("click", () => {
    closeDataMenu();
    showProbeReport();
  });
  document.getElementById("importData").addEventListener("click", () => {
    closeDataMenu();
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so picking the same file twice still fires
    if (file) await importData(file);
  });
  document.getElementById("queueResume").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_RESUME" });
    refreshQueue();
  });
  document.getElementById("queueClear").addEventListener("click", async () => {
    await queueMessage({ type: "JOB_FIT_QUEUE_CLEAR_FINISHED" });
    refreshQueue();
  });

  watchForChanges();

  // Opened from a banner's "Tracked jobs" button: land on the right profile and
  // on the right job, rather than at the top of a long list.
  const params = new URLSearchParams(location.search);
  const wantedProfile = params.get("profile");
  const wantedJob = params.get("job");
  if (wantedProfile && store.profiles.some((p) => p.id === wantedProfile)) {
    els.profileSelect.value = wantedProfile;
  }

  await loadProfile(els.profileSelect.value);
  if (wantedJob) revealJob(wantedJob);
}

function revealJob(jobKey) {
  if (!records.some((r) => r.jobKey === jobKey)) return;
  openKeys.add(jobKey);
  // Clear any filter that would hide the job we were asked to show.
  groupFilter = null;
  els.statusFilter.value = "all";
  els.search.value = "";
  els.hideRejects.checked = false;
  render();

  const cards = Array.from(document.querySelectorAll(".job"));
  const visible = visibleRecords();
  const index = visible.findIndex((r) => r.jobKey === jobKey);
  const card = index === -1 ? null : cards[index];
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
}

init();
