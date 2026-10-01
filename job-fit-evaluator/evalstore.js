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

  // A posting's requisition id and dates (postingmeta.js). Reading the page
  // again replaces what it found; what it couldn't see this time — a board
  // that dropped its "posted" line, a re-evaluation queued from Tracked jobs
  // with no page at all — keeps what was read before.
  function mergeMeta(older, newer) {
    if (!newer) return older || null;
    if (!older) return newer;
    const merged = { ...older };
    ["reqId", "deadline", "postedOn"].forEach((key) => {
      if (newer[key]) merged[key] = newer[key];
    });
    if (newer.postedOn) merged.postedApprox = Boolean(newer.postedApprox);
    return merged;
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
      meta: mergeMeta(existing && existing.meta, record.meta),
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
      meta: mergeMeta(existing && existing.meta, record.meta),
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
  //
  // Each run is kept as a 32-bit hash, sorted, rather than as a string in a
  // Set: about 3.5 KB a posting instead of tens, which is what makes keeping
  // them between calls affordable (below). Two different runs sharing a hash
  // is a one-in-millions overcount, well inside the thresholds' slack.
  function hashRun(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function shingles(text) {
    const words = normalizeTitle(String(text || "").slice(0, 4000)).split(" ").filter(Boolean);
    const runs = new Uint32Array(Math.max(0, words.length - 2));
    for (let i = 0; i < runs.length; i++) runs[i] = hashRun(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    runs.sort();
    let unique = 0;
    for (let i = 0; i < runs.length; i++) if (i === 0 || runs[i] !== runs[i - 1]) runs[unique++] = runs[i];
    return runs.subarray(0, unique);
  }

  // Both sorted: one walk through each.
  function containment(a, b) {
    if (!a.length || !b.length) return 0;
    const [small, large] = a.length <= b.length ? [a, b] : [b, a];
    let shared = 0;
    for (let i = 0, j = 0; i < small.length && j < large.length; ) {
      if (small[i] === large[j]) {
        shared++;
        i++;
        j++;
      } else if (small[i] < large[j]) i++;
      else j++;
    }
    return shared / small.length;
  }

  // Kept per record object between calls. Building them is nearly all the
  // cost, and Tracked jobs looks for duplicates on every render — each
  // keystroke in its search box — over records that haven't changed. A record
  // that's replaced (re-evaluated, re-read) is a new object; the text check
  // covers one updated in place.
  const shingleMemo = new WeakMap();

  function shinglesOf(record) {
    const kept = shingleMemo.get(record);
    if (kept && kept.text === record.text) return kept.runs;
    const runs = shingles(record.text);
    shingleMemo.set(record, { text: record.text, runs });
    return runs;
  }

  // Same title: most of the text in common is enough. Different titles need
  // nearly all of it — two roles at one company share the About-us and the
  // benefits, and a short description can be outweighed by them.
  const DUPLICATE_TEXT_THRESHOLD = 0.6;
  const RETITLED_TEXT_THRESHOLD = 0.9;

  // Words a title writes two ways, and qualifiers boards add ("- Remote",
  // "(Hybrid)") that don't make it another job.
  const TITLE_WORDS = { sr: "senior", snr: "senior", jr: "junior", mgr: "manager", engr: "engineer", eng: "engineer", dev: "developer" };
  const ARRANGEMENT_WORD = /^(remote|hybrid|onsite|on-site|in-office|remoto|presencial|h[ií]brido|t[ée]l[ée]travail)$/;

  function titleWords(title) {
    return normalizeTitle(String(title || "").replace(/&/g, " and "))
      .split(" ")
      .map((w) => w.replace(/\.$/, ""))
      .map((w) => TITLE_WORDS[w] || w)
      .filter((w) => w && !ARRANGEMENT_WORD.test(w));
  }

  // "Sr. Software Engineer - Remote" and "Senior Software Engineer (Hybrid)"
  // are one title; so are "Engineering Manager" and "Manager, Engineering".
  // What follows " - " or " | " is usually a location or a team, and goes.
  function titleKey(title) {
    const raw = String(title || "").replace(/\([^)]*\)/g, " ");
    const head = raw.split(/\s[-–—|]\s/)[0];
    const words = titleWords(head).length ? titleWords(head) : titleWords(raw);
    return words.sort().join(" ");
  }

  // The requisition id, read from the posting (postingmeta.js) or, for a
  // Workday job saved before that, from its key — which is built on it.
  function reqIdOf(record) {
    const id = (record.meta && record.meta.reqId) || (/^workday:[^:]+:(.+)$/.exec(record.jobKey || "") || [])[1];
    return id ? String(id).toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
  }

  function isDismissedPair(a, b) {
    return (a.notDuplicateOf || []).includes(b.jobKey) || (b.notDuplicateOf || []).includes(a.jobKey);
  }

  // Two records at one company: the same opening? Requisition ids decide when
  // both have one — the same role posted for three cities is three ids and
  // three jobs, however alike the text. Otherwise the text does, with the
  // bar depending on whether the titles agree; with no text, the title and
  // the city.
  function samePosting(a, b) {
    const idA = reqIdOf(a);
    const idB = reqIdOf(b);
    if (idA && idB) return idA === idB;
    const keyA = titleKey(a.title);
    const sameTitle = Boolean(keyA) && keyA === titleKey(b.title);
    if (a.text && b.text) {
      return containment(shinglesOf(a), shinglesOf(b)) >= (sameTitle ? DUPLICATE_TEXT_THRESHOLD : RETITLED_TEXT_THRESHOLD);
    }
    return sameTitle && normalizeCity(a.location) === normalizeCity(b.location);
  }

  // Map<jobKey, [other records]> over one profile's records. Bucketed by
  // company, the one thing every copy of a posting shares; within a company
  // every pair is compared, since a retitled copy wouldn't share a title
  // bucket.
  function duplicateGroups(records) {
    const buckets = new Map();
    (records || []).forEach((r) => {
      if (!r || !r.jobKey || !(r.title || r.text)) return;
      const key = normalizeCompany(r.company);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    });

    const result = new Map();
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
          if (!samePosting(a, b)) continue;
          add(a, b);
          add(b, a);
        }
      }
    });
    return result;
  }

  // The connected sets in duplicateGroups(), as Map<jobKey, set id>: three
  // copies of one job are one set even when only two pairs were matched.
  function duplicateSets(groups) {
    const setOf = new Map();
    groups.forEach((_, key) => {
      if (setOf.has(key)) return;
      const stack = [key];
      while (stack.length) {
        const k = stack.pop();
        if (setOf.has(k)) continue;
        setOf.set(k, key);
        (groups.get(k) || []).forEach((d) => stack.push(d.jobKey));
      }
    });
    return setOf;
  }

  // Copies are only ever matched within a company, so only its jobs are
  // compared: the rest of the history can't change the answer, and with a
  // thousand jobs tracked it took the popup and the card ~400 ms to find that
  // out.
  function findDuplicatesOf(record, records) {
    const company = normalizeCompany(record.company);
    const others = (records || []).filter((r) => r && r.jobKey !== record.jobKey && normalizeCompany(r.company) === company);
    return duplicateGroups([record, ...others]).get(record.jobKey) || [];
  }

  // The scored copy of `record` among `records` worth pointing to, or null:
  // the model run a new evaluation would repeat. One you've applied to comes
  // first — "you already applied there" is the thing not to miss — then the
  // newest. A keyword reject doesn't count; re-checking one costs nothing.
  function scoredDuplicateOf(record, records) {
    const applied = (r) => (r.status && r.status !== "not_applied" ? 1 : 0);
    const scored = findDuplicatesOf(record, records).filter((d) => d.evaluation && d.score != null && !d.hardReject);
    return scored.sort((a, b) => applied(b) - applied(a) || (b.lastEvaluatedAt || 0) - (a.lastEvaluatedAt || 0))[0] || null;
  }

  // --- company history -----------------------------------------------------
  //
  // What happened the other times you went for a job at this company: two
  // rejections and one still pending is worth knowing before applying a
  // fourth time. Statuses only — a score says nothing about how they replied.

  // Most decisive first, which is the order they're listed in.
  const HISTORY_STATUSES = ["offer", "interviewing", "applied", "rejected", "ghosted", "withdrawn"];

  // { tracked, applied, counts } over one profile's records at `company`.
  // `exclude` drops jobKeys (the job being looked at). Copies of one posting
  // count once: an application tracked from LinkedIn and from Workday is one
  // application, with the status that changed last.
  function companyHistory(records, company, { exclude = [] } = {}) {
    const key = normalizeCompany(company);
    if (!key) return null;
    const skip = new Set(exclude);
    const atCompany = (records || []).filter((r) => r && r.jobKey && !skip.has(r.jobKey) && normalizeCompany(r.company) === key);
    const sets = duplicateSets(duplicateGroups(atCompany));
    const movedAt = (r) => (r.status && r.status !== "not_applied" ? r.statusChangedAt || r.appliedAt || 1 : 0);
    const jobs = new Map();
    atCompany.forEach((r) => {
      const set = sets.get(r.jobKey) || r.jobKey;
      const kept = jobs.get(set);
      if (!kept || movedAt(r) > movedAt(kept)) jobs.set(set, r);
    });
    const counts = {};
    jobs.forEach((r) => {
      if (HISTORY_STATUSES.includes(r.status)) counts[r.status] = (counts[r.status] || 0) + 1;
    });
    const applied = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { tracked: jobs.size, applied, counts };
  }

  // "At Garmin: 2 rejections · 1 applied — 5 other jobs tracked there.", or
  // null when nothing there has gone past Not applied. The record's own copies
  // on other sites are left out — the duplicate note already covers them.
  function companyHistoryNote(records, record) {
    if (!record || !record.company) return null;
    const exclude = [record.jobKey, ...findDuplicatesOf(record, records).map((d) => d.jobKey)];
    const history = companyHistory(records, record.company, { exclude });
    if (!history || !history.applied) return null;
    const parts = HISTORY_STATUSES.filter((s) => history.counts[s]).map((s) =>
      tr(`company.${s}`, { count: history.counts[s] }, `${history.counts[s]} ${s}`)
    );
    return tr(
      "company.note",
      { company: record.company, counts: parts.join(" · "), count: history.tracked },
      `At ${record.company}: ${parts.join(" · ")} — ${history.tracked} other jobs tracked there.`
    );
  }

  // When different models scored the same job 30 or more points apart, the
  // posting is usually saying two things — short generic requirements over
  // specialist work — and the gap is worth reading about rather than just two
  // numbers side by side. The newest score per model counts. Null otherwise.
  const DISAGREEMENT_POINTS = 30;

  function modelDisagreement(record) {
    if (!record) return null;
    const byModel = new Map();
    [{ model: record.model, score: record.score, hardReject: record.hardReject }, ...(record.previous || [])].forEach((run) => {
      if (!run || run.hardReject || typeof run.score !== "number" || !run.model) return;
      if (!byModel.has(run.model)) byModel.set(run.model, run.score);
    });
    if (byModel.size < 2) return null;
    const runs = Array.from(byModel, ([model, score]) => ({ model, score }));
    const scores = runs.map((r) => r.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    return spread >= DISAGREEMENT_POINTS ? { spread, runs } : null;
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
    modelDisagreement,
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
    duplicateSets,
    findDuplicatesOf,
    scoredDuplicateOf,
    companyHistory,
    companyHistoryNote,
    mergeMeta,
    titleKey,
    siteLabel,
    normalizeTitle,
    normalizeCompany,
  };
})();
