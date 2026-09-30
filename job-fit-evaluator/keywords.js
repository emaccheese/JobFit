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
  // its patterns. `label` and `example` are the English fallbacks; the text
  // actually shown comes from the locale files (preset.<id>.label/.example).
  //
  // Curated categories. The wording postings use varies enormously; the
  // category does not. Ticking one pulls in every pattern for it, and a
  // profile that has it ticked inherits improvements to these patterns without
  // the user re-entering anything.
  //
  // Patterns cover English, Spanish, French and Portuguese, and all of them
  // run on every posting whatever the interface language: a Spanish posting
  // saying "no ofrecemos patrocinio de visa" has to be caught for someone
  // browsing in English, and a phrase in a language the posting isn't written
  // in simply never matches.
  //
  // `gate` makes a category depend on the posting's country and the profile's
  // work authorization there (see screening.js): "sponsorship" only rules a
  // job out where the user would need sponsorship; "citizenship" only where
  // they aren't a citizen or permanent resident; "usPerson" only when they
  // aren't a US citizen or permanent resident (ITAR, US export control). A
  // profile with no work-authorization answers gets the old behaviour: every
  // ticked category applies everywhere.
  //
  // `computed` categories have no patterns: screening.js decides them from
  // the profile and the posting's location (outside your target countries,
  // on-site somewhere you won't move to, a time zone you can't work, a
  // language you don't speak).
  const PRESETS = {
    hardRejects: [
      {
        id: "citizenship",
        label: "Citizenship or permanent residency",
        example: "Must be a U.S. citizen or permanent resident",
        gate: "citizenship",
        patterns: [
          "must be (a )?(u\\.?s\\.? citizen|us citizen)",
          "u\\.?s\\.? citizen(ship)? (is )?required",
          "must be (a )?(canadian|mexican|brazilian) citizen",
          "(canadian|mexican|brazilian) citizen(ship)? (is )?required",
          "permanent resident",
          "green card holder",
          // Spanish
          "(debe|deber[áa]s?|deber[áa] de|requiere|se requiere|indispensable|necesario) ser ciudadan[oa]",
          "ciudadan[íi]a (estadounidense|americana|mexicana|canadiense|brasile[ñn]a)( es)? (requerida|obligatoria|indispensable|necesaria)",
          "(ser de |tener )?nacionalidad mexicana( es)? (requerida|indispensable|obligatoria)",
          "residente permanente",
          // French
          "(doit|devez|devra|devrez) (être|etre) citoyen(ne)?",
          "citoyennet[ée] (canadienne|am[ée]ricaine)( est)? (requise|exig[ée]e|obligatoire)",
          "r[ée]sident(e)? permanent(e)?",
          // Portuguese
          "(deve|precisa|precisar[áa]) ser cidad[ãa]o",
          "cidadania (americana|brasileira|canadense)( [ée])? (obrigat[óo]ria|exigida|necess[áa]ria)",
        ],
      },
      {
        id: "sponsorship",
        label: "No visa sponsorship available",
        example: "We are not able to sponsor visas for this role",
        gate: "sponsorship",
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
          // "does not currently sponsor employment visas": an adverb between
          // "not" and "sponsor" slipped past the pattern above.
          "not (currently |presently |at this time |yet )?(be )?(able to )?sponsor(ing)?[^.\\n]{0,40}visas?",
          // "Candidates must not require sponsorship now or in the future" —
          // a statement, unlike the application question above, which has no
          // "not" in it.
          "(must|should|will|would|can|do|does|did) not (now or in the future |currently or in the future |now or at any time )?(require|need) (visa |employer |employment |immigration |work )?sponsorship",
          "(don't|doesn't|won't) (now or in the future )?(require|need) (visa |employer |employment |immigration |work )?sponsorship",
          // Spanish
          "no (ofrecemos|ofrece|brindamos|brinda|proporcionamos|otorgamos|contamos con|podemos ofrecer|es posible ofrecer)( el| ning[úu]n)? patrocinio",
          "no (patrocinamos|podemos patrocinar|se patrocinan?) (visas?|a candidatos)",
          "sin patrocinio( de visa| migratorio)?",
          "patrocinio (de visa |migratorio )?no (est[áa] |se encuentra )?disponible",
          // French
          "(pas de|aucun) parrainage",
          "(ne |n')(pouvons|pourrons|offrons|offre|offrira|fournissons) pas (de |d')?(parrainage|parrainer)",
          "pas (offrir|fournir|proposer) (de |d'|le |un )?parrainage",
          "sans parrainage",
          "ne (parrainons|parraine) pas",
          "parrainage (de visa |d'immigration )?(n'est pas|non) (offert|disponible|possible)",
          // Portuguese
          "n[ãa]o (oferecemos|oferece|patrocinamos|fornecemos|podemos oferecer)( o)? (patroc[íi]nio|visto)",
          "sem patroc[íi]nio( de visto)?",
          "patroc[íi]nio (de visto )?n[ãa]o (est[áa] )?(dispon[íi]vel|oferecido)",
        ],
      },
      {
        id: "clearance",
        label: "An active security clearance",
        example: "Active Secret security clearance required",
        gate: "citizenship",
        patterns: [
          "security clearance",
          "autorizaci[óo]n de seguridad",
          "(cote|habilitation) de s[ée]curit[ée]",
          "credenciamento de seguran[çc]a",
        ],
      },
      {
        id: "itar",
        label: "ITAR / export-controlled work",
        example: "Requires access to ITAR-controlled information",
        gate: "usPerson",
        patterns: ["\\bITAR\\b"],
      },
      {
        id: "locality",
        label: "Already living locally / within commuting distance",
        example: "Local candidates only",
        patterns: [
          "within (a )?(reasonable )?commut(ing|e) distance",
          "local candidates only",
          "(s[óo]lo|[úu]nicamente|solamente) candidatos locales",
          "candidats locaux (seulement|uniquement)",
          "(somente|apenas) candidatos locais",
        ],
      },
      {
        id: "relocation",
        label: "Relocating at your own cost",
        example: "No relocation assistance is provided",
        patterns: [
          "not able to (offer|provide) relocation",
          "no relocation (assistance|support)",
          "no (ofrecemos|se ofrece|incluye|contamos con) (apoyo|ayuda|paquete)( econ[óo]mico)? (de|para) (reubicaci[óo]n|mudanza)",
          "sin (apoyo|ayuda|paquete) de (reubicaci[óo]n|mudanza)",
          "(aucune |pas d')aide (à|a) la (relocalisation|r[ée]installation)",
          "(relocalisation|d[ée]m[ée]nagement) non (offert|pris en charge|rembours[ée])",
          "sem (aux[íi]lio|ajuda|apoio) (de|para) (realoca[çc][ãa]o|mudan[çc]a)",
          "n[ãa]o oferecemos (aux[íi]lio|ajuda|apoio) (de|para) (realoca[çc][ãa]o|mudan[çc]a)",
        ],
      },
      {
        id: "student",
        label: "Being a current student or a specific graduation year",
        example: "Graduating between 2026 and 2027",
        patterns: [
          "graduat(ing|ion) (date )?(between|in) (20\\d\\d)",
          "currently pursuing a (bachelor|master)",
          "fecha de (graduaci[óo]n|egreso|titulaci[óo]n) (entre|en) (20\\d\\d)",
          "(actualmente|estar) (cursando|estudiando) (una |la )?(licenciatura|maestr[íi]a|carrera|ingenier[íi]a)",
          "date de (diplomation|fin d'[ée]tudes) (entre|en) (20\\d\\d)",
          "actuellement (inscrit|[ée]tudiant)",
          "(previs[ãa]o de )?formatura (entre|em) (20\\d\\d)",
          "(atualmente|estar) (cursando|matriculado)",
        ],
      },
    ],
    softWarnings: [
      {
        id: "exportcontrol",
        label: "Export control mentioned (often satisfiable, unlike ITAR)",
        example: "Subject to U.S. export control regulations",
        gate: "usPerson",
        patterns: [
          "export control",
          "control(es)? de exportaci[óo]n",
          "contr[ôo]le (des |à l'|a l')exportations?",
          "controle de exporta[çc][ãa]o",
        ],
      },
      {
        // Not a hard reject: "only employ those who are legally authorized to
        // work" doesn't rule sponsorship out — many employers write it and
        // still transfer or sponsor existing visas — but it's worth a look
        // before applying if you'll need sponsorship.
        id: "workauth",
        label: "Must already be authorized to work (sponsorship unclear)",
        example: "Will only employ those who are legally authorized to work in the United States",
        gate: "sponsorship",
        patterns: [
          "only (employ|hire|consider|accept) (those|candidates|applicants|individuals|people) who are (legally )?authorized to work",
          "must (be|already be) (legally )?authorized to work in the (united states|u\\.?s\\.?|canada|mexico)",
          "must (have|hold) (a )?(valid )?work (permit|authorization)",
          // "…may not be able to employ candidates who have certain U.S. visa
          // categories": some visas excluded, which one isn't said.
          "may not be able to (employ|hire|consider|support)[^.\\n]{0,120}visa",
          "certain (u\\.?s\\.? )?(visa|immigration) (categories|types|statuses|classifications)",
          "deb(e|es|er[áa]s?) (contar con|tener) (un )?(permiso|autorizaci[óo]n) (legal )?(de trabajo|para trabajar)",
          "(legalmente )?autorizad[oa] para trabajar en",
          "(doit|devez) (être|etre) (l[ée]galement )?autoris[ée]e? (à|a) travailler",
          "permis de travail (valide )?(requis|obligatoire|exig[ée])",
          "(deve|precisa) (ter|possuir) autoriza[çc][ãa]o (legal )?para trabalhar",
        ],
      },
      {
        id: "masters",
        label: "A master's degree is required",
        example: "Master's degree required",
        patterns: [
          "master'?s degree (is )?required",
          "maestr[íi]a (es )?(requerida|indispensable|obligatoria)",
          "(se requiere|requisito:?) (una )?maestr[íi]a",
          "(ma[îi]trise|master) (est )?(requis|requise|exig[ée]e?|obligatoire)",
          "mestrado (é |e )?(obrigat[óo]rio|exigido|necess[áa]rio)",
        ],
      },
      {
        id: "outsidetargets",
        label: "In a country you're not targeting",
        example: "An on-site job in a country that isn't on your list",
        computed: true,
      },
      {
        id: "relocationneeded",
        label: "On-site or hybrid outside your area",
        example: "Hybrid in Austin, TX when you live in Monterrey and won't relocate",
        computed: true,
      },
      {
        id: "arrangement",
        label: "A work arrangement you didn't ask for",
        example: "On-site only, when you asked for remote",
        computed: true,
      },
      {
        id: "timezone",
        label: "Working hours in a time zone far from yours",
        example: "Must overlap with Pacific Time business hours",
        computed: true,
      },
      {
        id: "language",
        label: "A language you don't speak",
        example: "Fluent French required",
        computed: true,
      },
    ],
    // Deliberately none: domain flags are one person's skill gaps, so there is
    // no sensible shared list to offer.
    domainFlags: [],
    // Skills the person is picking up. Flagged for their information and
    // given to the model as learnable, never a reason to cap the score.
    learningFlags: [],
  };

  // The categories that existed before `seen` was recorded. A saved config
  // without `seen` has been shown exactly these, so anything newer that's on
  // by default is ticked for it once (see normalizeConfig).
  const LEGACY_IDS = {
    hardRejects: ["citizenship", "sponsorship", "clearance", "itar", "locality", "relocation", "student"],
    softWarnings: ["exportcontrol", "workauth", "masters"],
    domainFlags: [],
    learningFlags: [],
  };

  // Translated when the locale files are loaded; English otherwise.
  function presetLabel(preset) {
    const key = `preset.${preset.id}.label`;
    return typeof JOB_FIT_I18N !== "undefined" && JOB_FIT_I18N.has(key) ? JOB_FIT_I18N.t(key) : preset.label;
  }

  function presetExample(preset) {
    const key = `preset.${preset.id}.example`;
    return typeof JOB_FIT_I18N !== "undefined" && JOB_FIT_I18N.has(key) ? JOB_FIT_I18N.t(key) : preset.example;
  }

  // Two copies on purpose: a /g regex carries lastIndex between .test() calls,
  // so the global one is only ever used for .replace().
  const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
  const HAS_REGEX_METACHAR = /[.*+?^${}()|[\]\\]/;

  function presetsFor(kind) {
    return PRESETS[kind] || [];
  }

  // Words that are also part of common phrases meaning something else. A
  // phrase that is exactly one of these doesn't match inside them: "cloud"
  // (computing) isn't a point cloud, and "Go" (the language) isn't "go to
  // market" or "go live". Each one of these fired a false warning.
  const FALSE_FRIENDS = {
    cloud: { before: ["point", "word", "tag"], after: ["of points"] },
    clouds: { before: ["point", "word", "tag"], after: ["of points"] },
    go: { after: ["to", "live", "beyond", "ahead", "back", "further", "above", "through", "into", "over", "out", "for", "with"] },
  };

  // One or two letters with a capital, typed that way ("Go", "R", "C", "Qt"):
  // a language or library name that as a lower-case word means something
  // else, so it's matched exactly as typed.
  function isShortToken(phrase) {
    const trimmed = String(phrase).trim();
    return trimmed.length <= 2 && /^[A-Za-z]+$/.test(trimmed) && /[A-Z]/.test(trimmed);
  }

  // A phrase is literal text, matched as whole words (case-insensitive unless
  // it's a short token, above). Boundaries are added only where the phrase
  // actually begins or ends with a word character, so "C++" and ".NET" still
  // match — which matters, because those are exactly the terms people put in
  // domain flags. A hyphen counts as part of a word, so "go" doesn't match
  // "go-to-market"; a trailing + or # does too, so "C" isn't "C++" or "C#".
  function phraseToPattern(phrase) {
    const trimmed = String(phrase).trim();
    if (!trimmed) return null;

    const escaped = trimmed.replace(REGEX_METACHARS, "\\$&").replace(/\s+/g, "\\s+");
    const lead = /^\w/.test(trimmed) ? "(?<![\\w-])" : "";
    const trail = /\w$/.test(trimmed) ? "(?![\\w+#-])" : "";
    const friends = FALSE_FRIENDS[trimmed.toLowerCase()];
    const notBefore = friends && friends.before ? friends.before.map((w) => `(?<!\\b${w}\\s+)`).join("") : "";
    const notAfter = friends && friends.after ? `(?!\\s+(?:${friends.after.map((w) => w.replace(/\s+/g, "\\s+")).join("|")})\\b)` : "";
    return `${notBefore}${lead}${escaped}${trail}${notAfter}`;
  }

  // Returns [{ source, label }]. The label is what the UI shows when something
  // matches — a category name or the user's own phrase, never a regex.
  function compile(config, kind) {
    const entries = [];
    if (!config) return entries;

    const available = presetsFor(kind);
    (config.presets || []).forEach((id) => {
      const preset = available.find((p) => p.id === id);
      if (!preset || !preset.patterns) return;
      const label = presetLabel(preset);
      preset.patterns.forEach((source) => entries.push({ source, label, presetId: preset.id, gate: preset.gate || null }));
    });

    (config.phrases || []).forEach((phrase) => {
      const source = phraseToPattern(phrase);
      if (source) entries.push({ source, label: String(phrase).trim(), caseSensitive: isShortToken(phrase) });
    });

    (config.patterns || []).forEach((source) => {
      if (String(source).trim()) entries.push({ source, label: String(source).trim() });
    });

    return entries;
  }

  function emptyConfig(kind) {
    return { presets: [], phrases: [], patterns: [], seen: kind ? allIds(kind) : [] };
  }

  function allIds(kind) {
    return presetsFor(kind).map((p) => p.id);
  }

  function defaultConfig(kind) {
    return { presets: allIds(kind), phrases: [], patterns: [], seen: allIds(kind) };
  }

  // Computed categories that are ticked, for screening.js.
  function computedIds(config, kind) {
    const ticked = (config && config.presets) || [];
    return presetsFor(kind)
      .filter((p) => p.computed && ticked.includes(p.id))
      .map((p) => p.id);
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
    config.seen = LEGACY_IDS[kind] ? [...LEGACY_IDS[kind]] : [];
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

  // `seen` lists every category this config has been shown. A category added
  // to JobFit later is ticked once for configs that haven't seen it, so an
  // existing profile gets new checks without a "reset to defaults", while a
  // category someone deliberately unticked stays unticked.
  function normalizeConfig(value, kind) {
    const config = Array.isArray(value)
      ? fromLegacyList(value, kind)
      : value && typeof value === "object"
        ? {
            presets: Array.isArray(value.presets) ? [...value.presets] : [],
            phrases: Array.isArray(value.phrases) ? value.phrases : [],
            patterns: Array.isArray(value.patterns) ? value.patterns : [],
            seen: Array.isArray(value.seen) ? [...value.seen] : [...(LEGACY_IDS[kind] || [])],
          }
        : emptyConfig(kind);
    presetsFor(kind).forEach((preset) => {
      if (config.seen.includes(preset.id)) return;
      if (!config.presets.includes(preset.id)) config.presets.push(preset.id);
      config.seen.push(preset.id);
    });
    return config;
  }

  // --- terms from the candidate profile's own lines ----------------------------
  //
  // A profile can say what it's learning and what it isn't, in labelled lines:
  //   Learning: OpenCV, GoogleTest, ONNX Runtime
  //   NOT: Kubernetes, game engines, ML model training
  // (Gaps: works the same as NOT.) Those terms join the Learning list and the
  // domain flags, so the CV summary is the one place to keep them.
  const LEARNING_LINE = /^\s*(?:learning(?:\s*\/\s*in progress)?|in progress|currently learning|aprendiendo|en aprendizaje|en apprentissage|apprentissage|aprendendo|em aprendizado)\s*[:：]\s*(.+)$/i;
  const NOT_LINE = /^\s*(?:not|gaps?|carencias|brechas|lacunes|lacunas)\s*[:：]\s*(.+)$/i;
  const MAX_TERM_WORDS = 4;

  function splitTerms(list) {
    return String(list)
      .split(/[,;·•]|\s+\|\s+/)
      .map((term) =>
        term
          .replace(/\([^)]*\)/g, " ")
          .replace(/^\s*(?:and|or|no|not|never|without|y|o|sin|pas de|sans|sem|nem)\s+/i, "")
          .replace(/[.\s]+$/, "")
          .trim()
      )
      // A term is a skill name, not a sentence about one.
      .filter((term) => term && term.length <= 40 && term.split(/\s+/).length <= MAX_TERM_WORDS);
  }

  function termsFromProfile(profileText) {
    const out = { learning: [], not: [] };
    String(profileText || "")
      .split(/\n+/)
      .forEach((line) => {
        const learning = line.match(LEARNING_LINE);
        if (learning) {
          out.learning.push(...splitTerms(learning[1]));
          return;
        }
        const not = line.match(NOT_LINE);
        if (not) out.not.push(...splitTerms(not[1]));
      });
    const unique = (list) => Array.from(new Map(list.map((t) => [t.toLowerCase(), t])).values());
    return { learning: unique(out.learning), not: unique(out.not) };
  }

  function isEmpty(config) {
    if (!config) return true;
    return !(config.presets || []).length && !(config.phrases || []).length && !(config.patterns || []).length;
  }

  return {
    PRESETS,
    presetsFor,
    presetLabel,
    presetExample,
    computedIds,
    phraseToPattern,
    isShortToken,
    termsFromProfile,
    patternToPhrase,
    compile,
    emptyConfig,
    defaultConfig,
    fromLegacyList,
    normalizeConfig,
    isEmpty,
  };
})();
