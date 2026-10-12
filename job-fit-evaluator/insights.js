// Search insights: is the search working? Computed from one profile's tracked
// jobs, in the browser, from what Tino already keeps: the score, the status
// and when it changed, when you applied, and when a job first reached an
// interview or an offer (evalstore.js setStatus). Nothing new is stored.
//
// The page (insights-page.js) draws it; this file only counts, so the tests
// can check every number.
var JOB_FIT_INSIGHTS = (function () {
  const DAY = 86400000;
  // A rate from fewer applications than this says nothing yet: shown as
  // "too few to tell" rather than a confident 0% or 100%.
  const MIN_SAMPLE = 3;
  // The day Tino started remembering interviews past a later status (see
  // setStatus). A job rejected before it may have hidden an interview.
  const MILESTONES_SINCE = Date.UTC(2026, 9, 11);

  const isApplied = (r) => Boolean(r.status && r.status !== "not_applied");
  const reachedInterview = (r) => Boolean(r.interviewAt) || r.status === "interviewing" || r.status === "offer";
  const reachedOffer = (r) => Boolean(r.offerAt) || r.status === "offer";
  // A score, or a hard reject: a summary-only record wasn't evaluated.
  const isEvaluated = (r) => r.score != null || Boolean(r.hardReject);
  const silenceDays = () => (typeof JOB_FIT_ATTENTION !== "undefined" ? JOB_FIT_ATTENTION.SILENCE_DAYS : 14);

  const rate = (part, whole) => (whole >= MIN_SAMPLE ? part / whole : null);

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // The first answer to an application: an interview invitation, an offer,
  // or a rejection. Ghosted and withdrawn are no answer.
  function firstReplyAt(r) {
    if (r.interviewAt) return r.interviewAt;
    if (r.offerAt) return r.offerAt;
    if (["interviewing", "offer", "rejected"].includes(r.status)) return r.statusChangedAt || null;
    return null;
  }

  // The jobs a period covers: seen (evaluated) or applied to within it.
  function inPeriod(r, since) {
    if (since == null) return true;
    return (r.firstSeenAt || 0) >= since || (r.appliedAt || 0) >= since;
  }

  // Score bands, as the card colours them (ui-shared.js).
  function bandOf(r) {
    if (r.hardReject) return "rejected";
    if (r.score == null) return "none";
    if (r.score >= JOB_FIT_UI.GREEN_FROM) return "high";
    if (r.score >= JOB_FIT_UI.AMBER_FROM) return "mid";
    return "low";
  }

  // Applications and interviews per group, biggest first.
  function groupBy(records, keyOf, labelOf, limit) {
    const groups = new Map();
    records.forEach((r) => {
      const key = keyOf(r);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, { key, label: labelOf(r), applied: 0, interviews: 0, rejected: 0, noReply: 0 });
      const g = groups.get(key);
      g.applied++;
      if (reachedInterview(r)) g.interviews++;
      else if (r.status === "rejected") g.rejected++;
      else if (r.status === "ghosted") g.noReply++;
    });
    return [...groups.values()]
      .map((g) => ({ ...g, rate: rate(g.interviews, g.applied) }))
      .sort((a, b) => b.applied - a.applied || b.interviews - a.interviews || a.label.localeCompare(b.label))
      .slice(0, limit);
  }

  function compute(records, { now = Date.now(), sinceDays = null } = {}) {
    const since = sinceDays ? now - sinceDays * DAY : null;
    const pool = (records || []).filter((r) => inPeriod(r, since));
    const evaluated = pool.filter(isEvaluated);
    const applied = pool.filter(isApplied);
    const interviews = applied.filter(reachedInterview);
    const offers = applied.filter(reachedOffer);

    // What happened to each application.
    const silence = silenceDays() * DAY;
    const replied = applied.filter((r) => firstReplyAt(r) != null || reachedInterview(r) || r.status === "rejected");
    const noReply = applied.filter(
      (r) => r.status === "ghosted" || (r.status === "applied" && r.appliedAt && now - r.appliedAt >= silence)
    );
    const waiting = applied.filter((r) => r.status === "applied" && !(r.appliedAt && now - r.appliedAt >= silence));
    const replyDays = applied
      .map((r) => {
        const at = firstReplyAt(r);
        return at && r.appliedAt && at >= r.appliedAt ? (at - r.appliedAt) / DAY : null;
      })
      .filter((d) => d != null);

    const bands = ["high", "mid", "low"].map((band) => {
      const inBand = applied.filter((r) => bandOf(r) === band);
      const hits = inBand.filter(reachedInterview).length;
      return { band, applied: inBand.length, interviews: hits, rate: rate(hits, inBand.length) };
    });

    const company = (r) => (typeof JOB_FIT_EVALSTORE !== "undefined" ? JOB_FIT_EVALSTORE.normalizeCompany(r.company) : String(r.company || "").toLowerCase());
    const site = (r) => (typeof JOB_FIT_EVALSTORE !== "undefined" ? JOB_FIT_EVALSTORE.siteLabel(r) : "");

    // Rejected before Tino remembered interviews: one of these may have been
    // an interview that the page can't count.
    const unknownPast = applied.filter((r) => r.status === "rejected" && !r.interviewAt && (r.statusChangedAt || 0) < MILESTONES_SINCE).length;

    return {
      funnel: {
        evaluated: evaluated.length,
        applied: applied.length,
        interviews: interviews.length,
        offers: offers.length,
        applyRate: evaluated.length ? applied.length / evaluated.length : null,
        interviewRate: rate(interviews.length, applied.length),
        offerRate: rate(offers.length, interviews.length),
      },
      replies: {
        replied: replied.length,
        replyRate: rate(replied.length, applied.length),
        noReply: noReply.length,
        waiting: waiting.length,
        withdrawn: applied.filter((r) => r.status === "withdrawn").length,
        medianDays: replyDays.length ? Math.round(median(replyDays)) : null,
        measured: replyDays.length,
      },
      bands,
      bySite: groupBy(applied, site, site, 8),
      byCompany: groupBy(applied, company, (r) => r.company || "", 10),
      unknownPast,
    };
  }

  return { MIN_SAMPLE, MILESTONES_SINCE, compute, bandOf, reachedInterview, firstReplyAt };
})();
