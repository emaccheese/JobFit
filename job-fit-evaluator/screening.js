// Layer 1 — the keyword screening that runs before any model call: hard
// rejects, domain flags and warnings. Shared by the page script (content.js,
// on "Evaluate this tab") and the service worker's queue (re-evaluations from
// Tracked jobs), so a posting is screened by exactly the same rules either
// way. Re-evaluations used to skip it entirely and go straight to the model —
// so a sponsorship reject added or fixed later never caught an already-saved
// job, and on a paid provider a dead posting was paid for again.
//
// Loaded in the service worker via importScripts and injected into pages;
// assigned with var so re-injection doesn't throw.
var JOB_FIT_SCREEN = (function () {
  // Takes a keyword config (ticked categories + phrases + raw patterns),
  // compiles it, and carries each entry's human label alongside the regex so
  // the UI can name the rule that fired without ever showing a pattern.
  function compileConfig(config, kind) {
    return JOB_FIT_KEYWORDS.compile(config, kind)
      .map((entry) => {
        try {
          return { ...entry, re: new RegExp(entry.source, "i") };
        } catch (e) {
          console.warn(`[Job Fit Evaluator] invalid keyword pattern skipped: ${entry.source}`, e);
          return null;
        }
      })
      .filter(Boolean);
  }

  // Shows the words the POSTING actually used, not the pattern that matched
  // them. Trying to prettify a regex into prose never worked — stripping
  // backslashes left things like "master'?s degree (is )?required" and
  // "graduat(ing|ion) (date )?(between|in) (20\d\d)" on screen — and the
  // matched text is the more useful thing anyway: it says what tripped the
  // flag rather than what the rule looks like.
  const MAX_LABEL_CHARS = 80;

  // Matched text comes straight out of the posting, so it can carry newlines
  // from textFrom's block boundaries, and a loose pattern can match a long
  // span.
  function cleanMatch(raw) {
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…` : collapsed;
  }

  function matchedLabels(patterns, text) {
    const seen = new Set();
    const labels = [];

    patterns.forEach((item) => {
      const m = text.match(item.re);
      if (!m) return;
      const label = cleanMatch(m[0]);
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      labels.push(label);
    });

    return labels;
  }

  // The first hard reject that matches, as { label, matchedText }, or null.
  // label is the category name ("US citizenship or permanent residency") or
  // the user's own phrase — never the underlying pattern.
  function findHardReject(text, hardRejects) {
    for (const item of hardRejects) {
      const m = text.match(item.re);
      if (m) return { label: item.label, matchedText: m[0] };
    }
    return null;
  }

  // Everything Layer 1 decides about a posting, from a profile's keyword
  // settings. A hard reject short-circuits: its flags and warnings are empty,
  // as the page has always stored them.
  function screen(text, keywords) {
    const k = keywords || {};
    const hardReject = findHardReject(text, compileConfig(k.hardRejects, "hardRejects"));
    if (hardReject) return { hardReject, domainFlags: [], softWarnings: [] };
    return {
      hardReject: null,
      domainFlags: matchedLabels(compileConfig(k.domainFlags, "domainFlags"), text),
      softWarnings: matchedLabels(compileConfig(k.softWarnings, "softWarnings"), text),
    };
  }

  return { compileConfig, matchedLabels, cleanMatch, findHardReject, screen };
})();
