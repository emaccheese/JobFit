// What needs doing in a job search, and why: an offer to decide on, an
// interview, a posting that closes soon, a strong match not applied to, an
// application with no reply in two weeks. One set of rules for Tracked jobs'
// "Needs attention", the popup's "This week" and the toolbar icon's count,
// so they never disagree.
//
// Each rule carries its own wording: a list of jobs with no stated reason is
// just another filter, and the reason is the useful part.
var JOB_FIT_ATTENTION = (function () {
  // Days of silence after applying before a job is worth chasing. Two weeks is
  // the point past which most processes have either moved or gone quiet for
  // good; the wording states the actual number so the rule is never magic.
  const SILENCE_DAYS = 14;
  const DAY_MS = 86400000;

  const t = (key, vars) => JOB_FIT_I18N.t(key, vars);
  const notApplied = (r) => !r.status || r.status === "not_applied";
  const daysSince = (ts, now) => Math.floor((now - ts) / DAY_MS);

  // Ordered: the first match wins, most decisive first. `urgent` rules are the
  // week's to-do (the popup and the toolbar count); a strong match is worth
  // seeing in Tracked jobs but isn't a deadline, and a long search has many.
  const RULES = [
    {
      kind: "offer",
      urgent: true,
      test: (r) => r.status === "offer",
      label: () => t("attention.offer"),
    },
    {
      kind: "interview",
      urgent: true,
      test: (r) => r.status === "interviewing",
      label: () => t("attention.interview"),
    },
    {
      // Ahead of the strong match: one that closes on Friday is the more
      // urgent fact about it. Not for a skip: a deadline doesn't make it worth it.
      kind: "closing",
      urgent: true,
      test: (r, now) =>
        notApplied(r) &&
        JOB_FIT_META.closingSoon(r.meta, now) != null &&
        !(r.score != null && r.score < JOB_FIT_UI.AMBER_FROM),
      label: (r, now) => {
        const days = JOB_FIT_META.closingSoon(r.meta, now);
        return days === 0 ? t("attention.closesToday") : t("attention.closesIn", { count: days });
      },
    },
    {
      // The card's green threshold: if Tino calls it a strong match and you
      // haven't acted, that's the thing to act on, unless applications closed.
      kind: "strongMatch",
      urgent: false,
      test: (r, now) => notApplied(r) && r.score != null && r.score >= JOB_FIT_UI.GREEN_FROM && !JOB_FIT_META.hasClosed(r.meta, now),
      label: (r) => t("attention.strongMatch", { score: r.score }),
    },
    {
      // Only "applied": ghosted means you already decided it went quiet.
      kind: "noReply",
      urgent: true,
      test: (r, now) => r.status === "applied" && r.appliedAt && daysSince(r.appliedAt, now) >= SILENCE_DAYS,
      label: (r, now) => t("attention.noReply", { count: daysSince(r.appliedAt, now) }),
    },
  ];

  // Hard rejects are disqualified, not pending: never anything to do.
  function ruleFor(record, now = Date.now()) {
    if (!record || record.hardReject) return null;
    return RULES.find((rule) => rule.test(record, now)) || null;
  }

  // The reason as words, or null: Tracked jobs' badge.
  function reasonFor(record, now = Date.now()) {
    const rule = ruleFor(record, now);
    return rule ? rule.label(record, now) : null;
  }

  // Within the week's to-do: what's decided first, then the soonest deadline,
  // then the longest silence.
  const ORDER = { offer: 0, interview: 1, closing: 2, noReply: 3 };

  function sortKey(item, now) {
    if (item.kind === "closing") return JOB_FIT_META.closingSoon(item.record.meta, now) || 0;
    if (item.kind === "noReply") return -item.record.appliedAt;
    return -(item.record.statusChangedAt || 0);
  }

  // The urgent items, ordered, each { record, kind, label }; and how many
  // strong matches wait besides.
  function thisWeek(records, now = Date.now()) {
    const items = [];
    let strongMatches = 0;
    (records || []).forEach((record) => {
      const rule = ruleFor(record, now);
      if (!rule) return;
      if (rule.urgent) items.push({ record, kind: rule.kind, label: rule.label(record, now) });
      else if (rule.kind === "strongMatch") strongMatches++;
    });
    items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || sortKey(a, now) - sortKey(b, now));
    return { items, strongMatches };
  }

  return { SILENCE_DAYS, ruleFor, reasonFor, thisWeek };
})();
