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
  //
  // Labels are looked up when read, so they follow the interface language.
  function tr(key, vars, fallback) {
    if (typeof JOB_FIT_I18N !== "undefined" && JOB_FIT_I18N.has(key)) return JOB_FIT_I18N.t(key, vars);
    return fallback;
  }

  const STATUS_FALLBACK = {
    not_applied: "Not applied",
    applied: "Applied — pending response",
    interviewing: "Interview scheduled",
    offer: "Offer received",
    rejected: "Rejected",
    ghosted: "Ghosted / no response",
    withdrawn: "Withdrawn",
  };
  const STATUSES = Object.keys(STATUS_FALLBACK).map((value) => ({
    value,
    get label() {
      return tr(`status.${value}`, null, STATUS_FALLBACK[value]);
    },
  }));

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
      usage: record.usage || null,
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

  // Renders a record's evaluations as the block appended to a copied brief.
  // Lives here rather than in the popup because the service worker builds
  // that text too — the summary is assembled when the queued job finishes, so
  // it survives the popup being destroyed.
  //
  // One entry per model, newest first, with the current result leading: the
  // brief goes to another assistant, and the reason each model gave for its
  // score is more useful to it than the number alone. `previous` holds up to
  // MAX_PREVIOUS earlier runs; an older run from the same model is dropped,
  // since the newer one supersedes it.
  function evaluationsByModel(record) {
    const runs = [];
    if (record.lastEvaluatedAt) runs.push(evaluationSnapshot(record));
    (record.previous || []).forEach((run) => runs.push(run));
    const seen = new Set();
    return runs.filter((run) => {
      if (!run.hardReject && !run.evaluation) return false;
      const key = run.hardReject ? "\u0000keyword screen" : run.model || "\u0000unknown model";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function formatRun(run, { isCurrent, currentFingerprint }) {
    const date = run.evaluatedAt ? new Date(run.evaluatedAt).toISOString().slice(0, 10) : tr("brief.dateUnknown", null, "date unknown");
    const staleProfile =
      !isCurrent && run.profileFingerprint && currentFingerprint && run.profileFingerprint !== currentFingerprint
        ? ` ${tr("brief.earlierProfile", null, "[scored against an earlier version of this profile]")}`
        : "";
    const when = isCurrent ? tr("brief.current", null, "Current") : tr("brief.earlier", null, "Earlier");

    if (run.hardReject) {
      return [
        `${when} — ${tr("brief.keywordScreen", { date }, `keyword screen (${date}): hard reject`)}${staleProfile}`,
        `${tr("brief.reason", null, "Reason")}: ${tr(
          "brief.postingSays",
          { match: run.hardReject.matchedText, label: run.hardReject.label || "" },
          `the posting says "${run.hardReject.matchedText}" (${run.hardReject.label || ""})`
        )}`,
      ].join("\n");
    }

    const e = run.evaluation;
    const required = (e.required_gaps || []).map(String);
    const requiredLower = required.map((g) => g.toLowerCase());
    const otherGaps = (e.gaps || []).map(String).filter((g) => !requiredLower.includes(g.toLowerCase()));
    const verdict = tr(`verdict.${e.verdict}`, null, e.verdict);
    return [
      `${when} — ${run.model || tr("brief.unknownModel", null, "unknown model")} (${date}): ${e.score}/100, ${verdict}${staleProfile}`,
      e.one_line ? `${tr("brief.reason", null, "Reason")}: ${e.one_line}` : null,
      e.matches && e.matches.length ? `${tr("result.matches", null, "Matches")}: ${e.matches.join(", ")}` : null,
      required.length ? `${tr("result.requiredGaps", null, "Required gaps")}: ${required.join(", ")}` : null,
      otherGaps.length ? `${tr("brief.otherGaps", null, "Other gaps")}: ${otherGaps.join(", ")}` : null,
      e.score_cap_reasons && e.score_cap_reasons.length
        ? `${tr("result.scoreCap", null, "Score cap applied")}: ${e.score_cap_reasons.join(", ")}${
            e.raw_score != null ? ` ${tr("result.capDetail", { raw: e.raw_score, score: e.score }, `(model scored ${e.raw_score}, capped to ${e.score})`)}` : ""
          }`
        : null,
      e.seniority_flag ? `${tr("result.seniority", null, "Seniority/comp check")}: ${e.seniority_flag}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function formatEvaluation(record, profileName) {
    if (!record) return "";
    const who = profileName || record.profileName || "unknown";
    const runs = evaluationsByModel(record);
    if (!runs.length) return "";

    const heading =
      runs.length > 1
        ? tr("brief.evalHeadingMany", { profile: who, count: runs.length }, `MODEL EVALUATIONS (profile: ${who}; ${runs.length} results, newest first)`)
        : tr("brief.evalHeading", { profile: who }, `MODEL EVALUATION (profile: ${who})`);
    const entries = runs.map((run, i) =>
      formatRun(run, { isCurrent: i === 0 && Boolean(record.lastEvaluatedAt), currentFingerprint: record.profileFingerprint })
    );

    // Posting-level findings, the same whichever model scored it — stated once,
    // from the current result.
    const e = record.evaluation;
    const shared = [
      record.softWarnings && record.softWarnings.length
        ? `${tr("brief.warnings", null, "Warnings (worth asking about, not rejects)")}: ${record.softWarnings.join(", ")}`
        : null,
      record.domainFlags && record.domainFlags.length
        ? `${tr("brief.domainFlags", null, "Domain flags detected (keyword scan)")}: ${record.domainFlags.join(", ")}`
        : null,
      e && e.salary
        ? tr(
            "brief.salary",
            {
              posting: e.salary.posting_stated,
              market: e.salary.estimated_market_range,
              vs: salaryVerdictLabel(e.salary.vs_candidate_expectation),
            },
            `Salary — posting: ${e.salary.posting_stated}; market estimate: ${e.salary.estimated_market_range}; vs. expectation: ${e.salary.vs_candidate_expectation}`
          ) + (e.salary.note ? ` — ${e.salary.note}` : "")
        : null,
    ].filter(Boolean);

    return `\n\n${heading}\n\n${entries.join("\n\n")}${shared.length ? `\n\n${shared.join("\n")}` : ""}`;
  }

  // "within" / "below" / "above" / "unknown", as words in the UI language.
  function salaryVerdictLabel(value) {
    return tr(`salaryVs.${value}`, null, value);
  }

  // The whole text that gets copied: a header line, the condensed posting,
  // then the evaluations. One builder for the popup (via the service worker)
  // and the history page's Copy brief, so the two can't drift apart.
  function briefText(record, profileName) {
    const header = [record.title, record.company, record.location].filter(Boolean).join(" — ");
    return (header ? `${header}\n\n` : "") + (record.summary || "") + formatEvaluation(record, profileName);
  }

  // --- cross-site duplicates ---------------------------------------------
  //
  // The same posting reached through two sites gets two keys — LinkedIn's
  // job id and the company's Greenhouse id have nothing in common — so it is
  // filed twice. Keys can't fix that; only the content can. These are only
  // ever used to FLAG a possible duplicate, never to merge: two real openings
  // can share a title at one company, and a wrong merge would be invisible.

  function normalizeTitle(title) {
    // + # . survive so "C++" never collapses into "C", nor ".NET" into "NET".
    return String(title || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}+#.\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeCompany(company) {
    return normalizeTitle(company)
      .replace(/\.(?=\s|$)/g, "")
      .replace(/\s+(inc|llc|ltd|corp|corporation|co|gmbh|limited)$/, "")
      .trim();
  }

  function normalizeCity(location) {
    return normalizeTitle(String(location || "").split(",")[0]);
  }

  // How much of the shorter posting appears in the longer one, by runs of
  // three words. Containment rather than Jaccard: LinkedIn wraps the same
  // description in extra page text, which a symmetric measure would count
  // against it.
  function shingles(text) {
    const words = normalizeTitle(String(text || "").slice(0, 4000)).split(" ").filter(Boolean);
    const set = new Set();
    for (let i = 0; i + 2 < words.length; i++) set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    return set;
  }

  function containment(a, b) {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    small.forEach((s) => {
      if (large.has(s)) shared++;
    });
    return shared / small.size;
  }

  const DUPLICATE_TEXT_THRESHOLD = 0.6;

  function isDismissedPair(a, b) {
    return (a.notDuplicateOf || []).includes(b.jobKey) || (b.notDuplicateOf || []).includes(a.jobKey);
  }

  // Map<jobKey, [other records]> over one profile's records. Title+company is
  // the cheap bucket; the text check inside each bucket is what tells the
  // same posting from two openings that happen to share a title.
  function duplicateGroups(records) {
    const buckets = new Map();
    (records || []).forEach((r) => {
      const title = normalizeTitle(r.title);
      if (!title) return;
      const key = `${title}|${normalizeCompany(r.company)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    });

    const result = new Map();
    const shingleCache = new Map();
    const shinglesOf = (r) => {
      if (!shingleCache.has(r.jobKey)) shingleCache.set(r.jobKey, shingles(r.text));
      return shingleCache.get(r.jobKey);
    };
    const add = (a, b) => {
      if (!result.has(a.jobKey)) result.set(a.jobKey, []);
      result.get(a.jobKey).push(b);
    };

    buckets.forEach((group) => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (a.jobKey === b.jobKey || isDismissedPair(a, b)) continue;
          const same =
            a.text && b.text
              ? containment(shinglesOf(a), shinglesOf(b)) >= DUPLICATE_TEXT_THRESHOLD
              : normalizeCity(a.location) === normalizeCity(b.location);
          if (!same) continue;
          add(a, b);
          add(b, a);
        }
      }
    });
    return result;
  }

  function findDuplicatesOf(record, records) {
    const others = (records || []).filter((r) => r.jobKey !== record.jobKey);
    return duplicateGroups([record, ...others]).get(record.jobKey) || [];
  }

  // Which site a record came from, for "also tracked from LinkedIn".
  const SITE_LABELS = {
    linkedin: "LinkedIn",
    greenhouse: "Greenhouse",
    indeed: "Indeed",
    workday: "Workday",
    jibe: null,
    content: "Greenhouse portal",
  };

  function siteLabel(record) {
    const key = String(record.jobKey || "");
    const prefix = key.split(":")[0];
    if (SITE_LABELS[prefix]) return SITE_LABELS[prefix];
    if (prefix === "jibe") return tr("site.careerSite", null, "company career site");
    if (prefix === "url") return key.slice(4).split("/")[0] || tr("site.another", null, "another site");
    try {
      return new URL(record.url).hostname.replace(/^www\./, "");
    } catch (err) {
      return tr("site.another", null, "another site");
    }
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
    salaryVerdictLabel,
    formatEvaluation,
    briefText,
    duplicateGroups,
    findDuplicatesOf,
    siteLabel,
    normalizeTitle,
    normalizeCompany,
  };
})();
