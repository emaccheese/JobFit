// Turns what the user actually configures — ticked categories and plain
// phrases — into the regexes the scanner runs.
//
// The lists used to BE regexes, typed by hand. That put things like
// graduat(ing|ion) (date )?(between|in) (20\d\d) in front of someone whose job
// is not writing regexes, and it made correctness the user's problem: a bare
// `ITAR` silently matched "military" until someone thought to write \bITAR\b.
// Here, word boundaries are applied by the compiler, so that class of mistake
// can't be made.
var JOB_FIT_KEYWORDS = (function () {
  // `example` is display-only: a line of real posting language, shown by the
  // setup wizard so a category reads as something recognisable rather than as
  // its patterns.
  //
  // Curated categories. The wording postings use varies enormously; the
  // category does not. Ticking one pulls in every pattern for it, and a
  // profile that has it ticked inherits improvements to these patterns without
  // the user re-entering anything.
  const PRESETS = {
    hardRejects: [
      {
        id: "citizenship",
        label: "US citizenship or permanent residency",
        example: "Must be a U.S. citizen or permanent resident",
        patterns: [
          "must be (a )?(u\\.?s\\.? citizen|us citizen)",
          "u\\.?s\\.? citizen(ship)? (is )?required",
          "permanent resident",
          "green card holder",
        ],
      },
      {
        id: "sponsorship",
        label: "No visa sponsorship available",
        example: "We are not able to sponsor visas for this role",
        // Postings refuse sponsorship in many ways; "We will not sponsor
        // individuals for employment visas" matched none of the original three
        // and went straight to the model. Tested against refusals that must
        // match and against "sponsorship is available" and the application
        // question "Will you now or in the future require sponsorship?", which
        // must not — so "now or in the future" is deliberately not a pattern
        // on its own.
        patterns: [
          "without (the need for |requiring |needing |any )?(current or future |present or future |future )?(visa |employer |employment |immigration |company )?sponsorship",
          "not (able|available) to sponsor",
          "no (visa |immigration |employment |h-?1b )?sponsorship",
          "(will|do|does|can|are|is) not (be )?(able to )?(offer |provide )?sponsor",
          "(cannot|can't|won't|unable to|not able to) (offer |provide |support )?(visa |immigration |employment )?sponsor",
          "(not|unable to|cannot) (currently )?(offer|offering|provide|providing|support|supporting)( any)? (visa |immigration |employment |work authorization |h-?1b )?sponsorship",
          "sponsorship (is |will )?(not|n't) (be )?(available|offered|provided|supported|possible|an option)",
          "(ineligible|not eligible) for (visa |immigration |employment )?sponsorship",
        ],
      },
      {
        id: "clearance",
        label: "An active security clearance",
        example: "Active Secret security clearance required",
        patterns: ["security clearance"],
      },
      {
        id: "itar",
        label: "ITAR / export-controlled work",
        example: "Requires access to ITAR-controlled information",
        patterns: ["\\bITAR\\b"],
      },
      {
        id: "locality",
        label: "Already living locally / within commuting distance",
        example: "Local candidates only",
        patterns: ["within (a )?(reasonable )?commut(ing|e) distance", "local candidates only"],
      },
      {
        id: "relocation",
        label: "Relocating at your own cost",
        example: "No relocation assistance is provided",
        patterns: ["not able to (offer|provide) relocation", "no relocation (assistance|support)"],
      },
      {
        id: "student",
        label: "Being a current student or a specific graduation year",
        example: "Graduating between 2026 and 2027",
        patterns: ["graduat(ing|ion) (date )?(between|in) (20\\d\\d)", "currently pursuing a (bachelor|master)"],
      },
    ],
    softWarnings: [
      {
        id: "exportcontrol",
        label: "Export control mentioned (often satisfiable, unlike ITAR)",
        example: "Subject to U.S. export control regulations",
        patterns: ["export control"],
      },
      {
        // Not a hard reject: "only employ those who are legally authorized to
        // work" doesn't rule sponsorship out — many employers write it and
        // still transfer or sponsor existing visas — but it's worth a look
        // before applying if you'll need sponsorship.
        id: "workauth",
        label: "Must already be authorized to work in the US (sponsorship unclear)",
        example: "Will only employ those who are legally authorized to work in the United States",
        patterns: [
          "only (employ|hire|consider|accept) (those|candidates|applicants|individuals|people) who are (legally )?authorized to work",
          "must (be|already be) (legally )?authorized to work in the (united states|u\\.?s\\.?)",
        ],
      },
      {
        id: "masters",
        label: "A master's degree is required",
        example: "Master's degree required",
        patterns: ["master'?s degree (is )?required"],
      },
    ],
    // Deliberately none: domain flags are one person's skill gaps, so there is
    // no sensible shared list to offer.
    domainFlags: [],
  };

  // Two copies on purpose: a /g regex carries lastIndex between .test() calls,
  // so the global one is only ever used for .replace().
  const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
  const HAS_REGEX_METACHAR = /[.*+?^${}()|[\]\\]/;

  function presetsFor(kind) {
    return PRESETS[kind] || [];
  }

  // A phrase is literal text, matched case-insensitively as whole words.
  // Boundaries are added only where the phrase actually begins or ends with a
  // word character, so "C++" and ".NET" still match — which matters, because
  // those are exactly the terms people put in domain flags.
  function phraseToPattern(phrase) {
    const trimmed = String(phrase).trim();
    if (!trimmed) return null;

    const escaped = trimmed.replace(REGEX_METACHARS, "\\$&").replace(/\s+/g, "\\s+");
    const lead = /^\w/.test(trimmed) ? "\\b" : "";
    const trail = /\w$/.test(trimmed) ? "\\b" : "";
    return `${lead}${escaped}${trail}`;
  }

  // Returns [{ source, label }]. The label is what the UI shows when something
  // matches — a category name or the user's own phrase, never a regex.
  function compile(config, kind) {
    const entries = [];
    if (!config) return entries;

    const available = presetsFor(kind);
    (config.presets || []).forEach((id) => {
      const preset = available.find((p) => p.id === id);
      if (!preset) return;
      preset.patterns.forEach((source) => entries.push({ source, label: preset.label }));
    });

    (config.phrases || []).forEach((phrase) => {
      const source = phraseToPattern(phrase);
      if (source) entries.push({ source, label: String(phrase).trim() });
    });

    (config.patterns || []).forEach((source) => {
      if (String(source).trim()) entries.push({ source, label: String(source).trim() });
    });

    return entries;
  }

  function emptyConfig() {
    return { presets: [], phrases: [], patterns: [] };
  }

  function defaultConfig(kind) {
    return { presets: presetsFor(kind).map((p) => p.id), phrases: [], patterns: [] };
  }

  // --- migration from the old flat arrays of raw regex -------------------

  // `\bfoo bar\b` with nothing else regex-ish in it is just the phrase
  // "foo bar", so bring it back as one. Requires BOTH boundaries: `\bneural
  // network` (no trailing \b) also matches "networks", and re-compiling it as
  // a phrase would quietly stop it doing that.
  function patternToPhrase(pattern) {
    const source = String(pattern);
    if (!source.startsWith("\\b") || !source.endsWith("\\b")) return null;
    const inner = source.slice(2, -2);
    if (!inner || HAS_REGEX_METACHAR.test(inner)) return null;
    return inner;
  }

  // A preset is only ticked when every one of its patterns is present, so a
  // list someone had edited down is never silently re-expanded.
  function fromLegacyList(list, kind) {
    const config = emptyConfig();
    if (!Array.isArray(list)) return config;

    const claimed = new Set();
    presetsFor(kind).forEach((preset) => {
      if (preset.patterns.every((p) => list.includes(p))) {
        config.presets.push(preset.id);
        preset.patterns.forEach((p) => claimed.add(p));
      }
    });

    list.forEach((entry) => {
      if (claimed.has(entry)) return;
      const phrase = patternToPhrase(entry);
      if (phrase) config.phrases.push(phrase);
      else config.patterns.push(entry);
    });

    return config;
  }

  function normalizeConfig(value, kind) {
    if (Array.isArray(value)) return fromLegacyList(value, kind);
    if (!value || typeof value !== "object") return emptyConfig();
    return {
      presets: Array.isArray(value.presets) ? value.presets : [],
      phrases: Array.isArray(value.phrases) ? value.phrases : [],
      patterns: Array.isArray(value.patterns) ? value.patterns : [],
    };
  }

  function isEmpty(config) {
    if (!config) return true;
    return !(config.presets || []).length && !(config.phrases || []).length && !(config.patterns || []).length;
  }

  return {
    PRESETS,
    presetsFor,
    phraseToPattern,
    patternToPhrase,
    compile,
    emptyConfig,
    defaultConfig,
    fromLegacyList,
    normalizeConfig,
    isEmpty,
  };
})();
