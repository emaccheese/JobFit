// History of evaluated postings.
//
// One storage key per record (`ev:<profileId>:<jobKey>`) rather than a single
// array: ticking a status dropdown shouldn't rewrite the whole history, and
// per-key writes can't lose data to a read-modify-write race between the
// history page and a tab that's mid-evaluation.
//
// Records are scoped per profile, so the same posting evaluated for two
// candidates is two records — the scores aren't comparable and mustn't
// overwrite each other.
var JOB_FIT_EVALSTORE = (function () {
  const PREFIX = "ev:";

  // A single lifecycle field rather than an "applied?" checkbox plus a status,
  // which could disagree with each other (unchecked + "interview scheduled").
  // Anything past NOT_APPLIED means the application went out.
  const STATUSES = [
    { value: "not_applied", label: "Not applied" },
    { value: "applied", label: "Applied — pending response" },
    { value: "interviewing", label: "Interview scheduled" },
    { value: "offer", label: "Offer received" },
    { value: "rejected", label: "Rejected" },
    { value: "ghosted", label: "Ghosted / no response" },
    { value: "withdrawn", label: "Withdrawn" },
  ];

  function recordKey(profileId, jobKey) {
    return `${PREFIX}${profileId}:${jobKey}`;
  }

  async function get(profileId, jobKey) {
    const key = recordKey(profileId, jobKey);
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  // How many earlier results a record keeps. Enough to compare a few models on
  // the same job without every re-evaluation growing the record without bound.
  const MAX_PREVIOUS = 5;

  // The part of a record that one evaluation produced — what re-evaluating
  // replaces, and so what has to be set aside to keep it.
  function evaluationSnapshot(record) {
    return {
      model: record.model || "",
      profileFingerprint: record.profileFingerprint || null,
      score: record.score,
      verdict: record.verdict,
      evaluation: record.evaluation || null,
      hardReject: record.hardReject || null,
      durationMs: record.durationMs || null,
      evaluatedAt: record.lastEvaluatedAt,
    };
  }

  // Writes an evaluation result, preserving the fields the user owns — status,
  // notes, when they applied, when the job was first seen. Re-evaluating a
  // posting must never reset the fact that you already applied to it.
  //
  // The result being replaced moves to `previous` (newest first) rather than
  // being lost, so scores from an earlier model or profile stay comparable.
  // A summarize-only record has no lastEvaluatedAt and nothing to keep.
  async function saveEvaluation(record) {
    const existing = await get(record.profileId, record.jobKey);
    const now = Date.now();
    const previous = (existing && existing.previous) || [];
    const kept =
      existing && existing.lastEvaluatedAt
        ? [evaluationSnapshot(existing), ...previous].slice(0, MAX_PREVIOUS)
        : previous;
    const merged = {
      status: "not_applied",
      statusChangedAt: null,
      appliedAt: null,
      notes: "",
      summary: null,
      firstSeenAt: now,
      ...(existing || {}),
      ...record,
      previous: kept,
      lastEvaluatedAt: now,
    };
    await chrome.storage.local.set({ [recordKey(record.profileId, record.jobKey)]: merged });
    return merged;
  }

  // Summarizing files the job too. It used to only attach the brief to a record
  // that already existed, so summarizing a posting you hadn't evaluated threw
  // the brief away — the one artifact you actually paste elsewhere.
  //
  // Stamps lastSummarizedAt rather than lastEvaluatedAt: the job has not been
  // scored, and claiming otherwise would put it in the history's date-evaluated
  // ordering under a time nothing was evaluated. score/verdict/evaluation stay
  // null, which is how the page tells "no score yet" apart from a hard reject
  // (score 0).
  async function saveSummary(record) {
    const existing = await get(record.profileId, record.jobKey);
    const now = Date.now();
    const merged = {
      status: "not_applied",
      statusChangedAt: null,
      appliedAt: null,
      notes: "",
      score: null,
      verdict: null,
      evaluation: null,
      hardReject: null,
      domainFlags: [],
      softWarnings: [],
      lastEvaluatedAt: null,
      firstSeenAt: now,
      ...(existing || {}),
      ...record,
      lastSummarizedAt: now,
    };
    await chrome.storage.local.set({ [recordKey(record.profileId, record.jobKey)]: merged });
    return merged;
  }

  // When this job last had anything happen to it. Records can be
  // evaluated-only, summarized-only, or both, so neither timestamp alone can
  // drive the history page's date column or its date ordering.
  function activityTs(record) {
    return record.lastEvaluatedAt || record.lastSummarizedAt || record.firstSeenAt || 0;
  }

  // Patches the user-owned fields without touching the evaluation.
  async function update(profileId, jobKey, patch) {
    const existing = await get(profileId, jobKey);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    await chrome.storage.local.set({ [recordKey(profileId, jobKey)]: merged });
    return merged;
  }

  async function setStatus(profileId, jobKey, status) {
    const existing = await get(profileId, jobKey);
    if (!existing) return null;
    const patch = { status, statusChangedAt: Date.now() };
    // Stamped once, on the first move off "not applied" — "applied 5 weeks ago,
    // still pending" is the view that tells you to follow up or let it go, and
    // a later move to Rejected shouldn't overwrite when you actually applied.
    if (status !== "not_applied" && !existing.appliedAt) patch.appliedAt = Date.now();
    if (status === "not_applied") patch.appliedAt = null;
    return update(profileId, jobKey, patch);
  }

  async function remove(profileId, jobKey) {
    await chrome.storage.local.remove(recordKey(profileId, jobKey));
  }

  // chrome.storage has no prefix query, so finding one profile's records means
  // enumerating keys. getKeys() (Chrome 130+) returns keys WITHOUT their
  // values, so we then deserialize only this profile's records instead of
  // every stored posting body — the difference between reading a few hundred
  // KB and reading the entire history. get(null) stays as the fallback.
  //
  // Deliberately not a maintained index: chrome.storage has no atomic update,
  // so an index would be written read-modify-write from both this page and a
  // content script, and a lost update there makes a record invisible. A slower
  // read beats a job that silently vanishes from the list.
  async function keysForProfile(profileId) {
    const wanted = `${PREFIX}${profileId}:`;
    if (typeof chrome.storage.local.getKeys === "function") {
      const keys = await chrome.storage.local.getKeys();
      return keys.filter((k) => k.startsWith(wanted));
    }
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith(wanted));
  }

  async function list(profileId) {
    const keys = await keysForProfile(profileId);
    if (keys.length === 0) return [];
    const stored = await chrome.storage.local.get(keys);
    return keys.map((k) => stored[k]).filter(Boolean);
  }

  // --- backup -------------------------------------------------------------

  async function allRecordKeys() {
    if (typeof chrome.storage.local.getKeys === "function") {
      return (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(PREFIX));
    }
    return Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(PREFIX));
  }

  // Every tracked job, across every profile.
  async function exportRecords() {
    const keys = await allRecordKeys();
    if (!keys.length) return [];
    const stored = await chrome.storage.local.get(keys);
    return keys.map((k) => stored[k]).filter(Boolean);
  }

  // Writes one record from a backup file. The storage key is rebuilt from the
  // record's own profileId and jobKey rather than taken from the file, so a
  // hand-edited or malformed backup can't write to arbitrary storage keys.
  // Existing records are never overwritten: a restore must not silently
  // discard an application status or notes added since the backup.
  async function importRecord(record) {
    if (!record || typeof record !== "object") return "invalid";
    const { profileId, jobKey } = record;
    if (!profileId || !jobKey || typeof profileId !== "string" || typeof jobKey !== "string") return "invalid";

    const existing = await get(profileId, jobKey);
    if (existing) return "skipped";

    await chrome.storage.local.set({ [recordKey(profileId, jobKey)]: { ...record, profileId, jobKey } });
    return "added";
  }

  async function countForProfile(profileId) {
    return (await keysForProfile(profileId)).length;
  }

  // Deleting a profile used to leave its records behind: unreachable from any
  // selector, still holding the full posting text of every job. They have to
  // go with it, and the popup warns how many first.
  async function removeAllForProfile(profileId) {
    const keys = await keysForProfile(profileId);
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  // Renders a record's evaluation as the block appended to a copied brief.
  // Lives here rather than in the popup because the service worker now builds
  // that text too — the summary is assembled when the queued job finishes, so
  // it survives the popup being destroyed.
  function formatEvaluation(record, profileName) {
    if (!record) return "";
    const who = profileName || record.profileName || "unknown";

    if (record.hardReject) {
      return `\n\nLOCAL MODEL EVALUATION (profile: ${who}): hard reject — the posting says "${record.hardReject.matchedText}"`;
    }

    const e = record.evaluation;
    if (!e) return "";

    return [
      `\n\nLOCAL MODEL EVALUATION (profile: ${who}, score: ${e.score}/100, verdict: ${e.verdict})`,
      e.one_line ? `Summary: ${e.one_line}` : null,
      e.matches && e.matches.length ? `Matches: ${e.matches.join(", ")}` : null,
      e.gaps && e.gaps.length ? `Gaps: ${e.gaps.join(", ")}` : null,
      e.required_gaps && e.required_gaps.length ? `Required gaps: ${e.required_gaps.join(", ")}` : null,
      e.seniority_flag ? `Seniority/comp check: ${e.seniority_flag}` : null,
      e.score_cap_reasons && e.score_cap_reasons.length
        ? `Score cap applied: ${e.score_cap_reasons.join(", ")}${
            e.raw_score != null ? ` (model scored ${e.raw_score}, capped to ${e.score})` : ""
          }`
        : null,
      record.softWarnings && record.softWarnings.length
        ? `Warnings (worth asking about, not rejects): ${record.softWarnings.join(", ")}`
        : null,
      record.domainFlags && record.domainFlags.length
        ? `Domain flags detected (keyword scan): ${record.domainFlags.join(", ")}`
        : null,
      e.salary
        ? `Salary — posting: ${e.salary.posting_stated}; market estimate: ${e.salary.estimated_market_range}; vs. expectation: ${e.salary.vs_candidate_expectation}${e.salary.note ? " — " + e.salary.note : ""}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function statusLabel(value) {
    const found = STATUSES.find((s) => s.value === value);
    return found ? found.label : value;
  }

  return {
    STATUSES,
    recordKey,
    get,
    saveEvaluation,
    saveSummary,
    activityTs,
    update,
    setStatus,
    remove,
    list,
    countForProfile,
    removeAllForProfile,
    exportRecords,
    importRecord,
    statusLabel,
    formatEvaluation,
  };
})();
