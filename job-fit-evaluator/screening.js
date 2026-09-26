// Layer 1 — the keyword screening that runs before any model call: hard
// rejects, domain flags and warnings. Shared by the page script (content.js,
// on "Evaluate this tab") and the service worker's queue (re-evaluations from
// Tracked jobs), so a posting is screened by exactly the same rules either
// way. Re-evaluations used to skip it entirely and go straight to the model —
// so a sponsorship reject added or fixed later never caught an already-saved
// job, and on a paid provider a dead posting was paid for again.
//
// Screening knows where the posting is (geo.js) and, from the profile's
// jobSearch answers, where the user can work. That's what makes the rules
// per country: "no sponsorship" rejects a San Diego job for someone who needs
// a US visa, and is ignored on a Tijuana job for a Mexican citizen. When the
// posting doesn't say which country it's in and the answer differs between
// the user's target countries, the reject becomes a warning instead — never
// silently dropped, never a wrong reject.
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

  function tr(key, vars, fallback) {
    if (typeof JOB_FIT_I18N !== "undefined" && JOB_FIT_I18N.has(key)) return JOB_FIT_I18N.t(key, vars);
    return fallback;
  }

  function countryName(code) {
    return typeof JOB_FIT_I18N !== "undefined" ? JOB_FIT_I18N.countryName(code) : code;
  }

  // --- country gates --------------------------------------------------------

  function hasAuthAnswers(jobSearch) {
    return Boolean(jobSearch && jobSearch.workAuth && Object.keys(jobSearch.workAuth).length);
  }

  // Would this rule apply to someone working in `country`? workAuth values:
  // "citizen" (citizen or permanent resident), "permit" (already allowed to
  // work, no sponsorship needed), "sponsor" (would need sponsorship). A
  // country with no answer counts as needing both — the cautious reading, and
  // the one JobFit always had.
  function applies(gate, country, jobSearch) {
    const auth = jobSearch.workAuth || {};
    const status = auth[JOB_FIT_GEO.authCountry(country)];
    if (gate === "sponsorship") return !status || status === "sponsor";
    if (gate === "citizenship") return status !== "citizen";
    if (gate === "usPerson") return auth.US !== "citizen";
    return true;
  }

  // "fire" | "warn" | "skip" for a gated category on this posting.
  function gateOutcome(gate, place, jobSearch) {
    if (!gate || !hasAuthAnswers(jobSearch)) return "fire";
    if (gate === "usPerson") return applies(gate, "US", jobSearch) ? "fire" : "skip";
    const candidates = place.country
      ? [place.country]
      : place.countries && place.countries.length
        ? place.countries
        : jobSearch.targetCountries || [];
    if (!candidates.length) return "fire";
    const hits = candidates.filter((c) => applies(gate, c, jobSearch)).length;
    if (hits === candidates.length) return "fire";
    return hits ? "warn" : "skip";
  }

  // The first hard reject that applies, as { label, matchedText }, or null.
  // label is the category name ("Citizenship or permanent residency") or the
  // user's own phrase — never the underlying pattern. Rules that only apply in
  // some of the possible countries come back in `downgraded`.
  function findHardRejectInPlace(text, hardRejects, place, jobSearch) {
    const downgraded = [];
    for (const item of hardRejects) {
      const m = text.match(item.re);
      if (!m) continue;
      const outcome = gateOutcome(item.gate, place, jobSearch);
      if (outcome === "fire") return { hardReject: { label: item.label, matchedText: m[0] }, downgraded: [] };
      if (outcome === "warn") {
        downgraded.push(
          tr(
            "screen.gatedUnknownCountry",
            { match: cleanMatch(m[0]), label: item.label },
            `"${cleanMatch(m[0])}" — ${item.label} (it isn't clear which country this job is in, and this only rules a job out in some of yours)`
          )
        );
      }
    }
    return { hardReject: null, downgraded };
  }

  // Kept for callers without a place: every rule applies.
  function findHardReject(text, hardRejects) {
    for (const item of hardRejects) {
      const m = text.match(item.re);
      if (m) return { label: item.label, matchedText: m[0] };
    }
    return null;
  }

  // --- computed warnings ----------------------------------------------------

  const LANGUAGE_NAMES = {
    en: "english|ingl[ée]s|anglais|ingl[êe]s",
    es: "spanish|espa[ñn]ol|espagnol|espanhol|castellano",
    fr: "french|franc[ée]s|fran[çc]ais|franc[êe]s",
    pt: "portuguese|portugu[ée]s|portugais|portugu[êe]s",
  };
  const LANGUAGE_BEFORE =
    "fluent|fluency in|fluently|bilingual|biling[üu]e|bilingue|native|nativo|nativa|proficien(?:t|cy) in|dominio (?:del?|de la)|dom[íi]nio (?:do|de)|ma[îi]trise (?:de l'|du|de la|de)|nivel avanzado de|advanced|avanzado|avanzada|avanc[ée]|avan[çc]ado|excellent|excelente|strong";
  const LANGUAGE_AFTER =
    "required|requerido|requerida|indispensable|obligatorio|obligatoria|imprescindible|requis|obligatoire|exig[ée]|obrigat[óo]rio|essencial|a must|is a must|fluency|fluent|avanzado|advanced|avanc[ée]|avan[çc]ado|fluido|fluida|nativo|native|b2|c1|c2";
  // A language the posting only prefers is not a requirement.
  const OPTIONAL_RE = /\b(plus|deseable|nice to have|atout|diferencial|preferred|preferid[oa]|preferible|bonus|valorad[oa]|souhait|desejável|desejavel|asset)\b/i;

  function requiredLanguages(text) {
    const found = [];
    Object.entries(LANGUAGE_NAMES).forEach(([code, names]) => {
      const res = [
        new RegExp(`\\b(?:${LANGUAGE_BEFORE})\\b[^.\\n;:]{0,30}?(?:${names})(?![a-z])`, "gi"),
        new RegExp(`(?:${names})(?![a-z])[^.\\n;]{0,25}?\\b(?:${LANGUAGE_AFTER})\\b`, "gi"),
        new RegExp(`(?:${names})(?![a-z]) ?\\((?:b2|c1|c2|fluent|advanced|avanzado)`, "gi"),
      ];
      const hit = res.some((re) => {
        let m;
        while ((m = re.exec(text))) {
          const start = Math.max(0, text.lastIndexOf("\n", m.index), text.lastIndexOf(".", m.index));
          const endDot = text.indexOf(".", m.index + m[0].length);
          const endLine = text.indexOf("\n", m.index + m[0].length);
          const ends = [endDot, endLine].filter((i) => i !== -1);
          const sentence = text.slice(start, ends.length ? Math.min(...ends) : text.length);
          if (!OPTIONAL_RE.test(sentence)) return true;
        }
        return false;
      });
      if (hit) found.push(code);
    });
    return found;
  }

  // Business-hours zones postings name. Bare "PT"/"ET" are left out: "PT
  // hours" is as often part-time as Pacific.
  const NAMED_ZONES = [
    { id: "ET", offset: -5, re: /\b(eastern (standard )?time|east coast hours|EST|EDT|hora(rio)? del este|heure de l'est|hor[áa]rio do leste)\b/ },
    { id: "CT", offset: -6, re: /\b(central (standard )?time|CST|CDT|hora(rio)? del centro|heure du centre|hor[áa]rio central)\b/ },
    { id: "MT", offset: -7, re: /\b(mountain (standard )?time|MST|MDT|hora(rio)? de la monta[ñn]a|heure des rocheuses)\b/ },
    { id: "PT", offset: -8, re: /\b(pacific (standard )?time|PST|PDT|hora(rio)? del pac[íi]fico|heure du pacifique|hor[áa]rio do pac[íi]fico)\b/ },
  ];
  const HOURS_CONTEXT_RE = /(hours|time ?zone|overlap|business day|working day|horario|horas|zona horaria|fuseau|heures|hor[áa]rio|fuso)/i;

  function timeZoneRequirement(text, homeTimeZone) {
    const own = JOB_FIT_GEO.standardOffset(homeTimeZone);
    if (own == null) return null;
    const sentences = String(text).split(/[.\n;]/);
    for (const sentence of sentences) {
      if (!HOURS_CONTEXT_RE.test(sentence)) continue;
      const zone = NAMED_ZONES.find((z) => z.re.test(sentence));
      if (!zone) continue;
      const hours = Math.round(Math.abs(own - zone.offset));
      return hours >= 3 ? { zone: zone.id, hours } : null;
    }
    return null;
  }

  // "Remote (US only)", "must reside in", "US-based": remote, but only for
  // people who already live there.
  const RESIDENCY_RE =
    /(must (reside|live|be (located|based)) in|(u\.?s\.?|us|canada|mexico)[- ]based (candidates|applicants)?|residents? only|only (open|available) to (candidates|applicants) (located|based|residing) in|deb(e|es|er[áa]) (residir|radicar|vivir) en|(doit|devez) (r[ée]sider|habiter) (au|en|aux)|(deve|precisa) (residir|morar) (no|na|em))/i;

  const ARRANGEMENTS = ["remote", "hybrid", "onsite"];

  function arrangementName(id) {
    return tr(`arrangement.${id}`, null, id);
  }

  function computedWarnings(ids, text, place, jobSearch) {
    const out = [];
    if (!jobSearch || !ids.length) return out;
    const targets = (jobSearch.targetCountries || []).map(JOB_FIT_GEO.authCountry);
    const home = jobSearch.home || {};
    const country = place.country ? JOB_FIT_GEO.authCountry(place.country) : null;
    const remote = place.arrangement === "remote";

    if (ids.includes("outsidetargets") && country && targets.length && !targets.includes(country) && !remote) {
      out.push(tr("screen.outsideTargets", { country: countryName(place.country) }, `In ${countryName(place.country)}, which isn't one of your target countries`));
    }

    if (ids.includes("relocationneeded") && home.country && country) {
      const homeCountry = JOB_FIT_GEO.authCountry(home.country);
      const elsewhere =
        country !== homeCountry || Boolean(home.region && place.region && place.region !== home.region);
      if (!remote && elsewhere && jobSearch.relocate === "no") {
        const where = JOB_FIT_GEO.placeText({ country: place.country, region: place.region });
        out.push(
          tr(
            "screen.relocationNeeded",
            { place: where, arrangement: arrangementName(place.arrangement || "onsite") },
            `${arrangementName(place.arrangement || "onsite")} in ${where} — outside your area, and you said you won't relocate`
          )
        );
      } else if (remote && country !== homeCountry && RESIDENCY_RE.test(text)) {
        out.push(
          tr("screen.remoteResidency", { country: countryName(place.country) }, `Remote, but only for people who live in ${countryName(place.country)}`)
        );
      }
    }

    const wanted = (jobSearch.arrangements || []).filter((a) => ARRANGEMENTS.includes(a));
    if (ids.includes("arrangement") && place.arrangement && wanted.length && wanted.length < 3 && !wanted.includes(place.arrangement)) {
      out.push(
        tr(
          "screen.arrangement",
          { arrangement: arrangementName(place.arrangement), wanted: JOB_FIT_I18N.list(wanted.map(arrangementName), "disjunction") },
          `${arrangementName(place.arrangement)}, and you asked for ${wanted.join(" or ")}`
        )
      );
    }

    if (ids.includes("timezone") && home.timeZone) {
      const tz = timeZoneRequirement(text, home.timeZone);
      if (tz) {
        const zone = tr(`tz.${tz.zone}`, null, tz.zone);
        out.push(tr("screen.timezone", { zone, count: tz.hours }, `Asks for ${zone} hours, ${tz.hours} hours from yours`));
      }
    }

    const spoken = jobSearch.languages || [];
    if (ids.includes("language") && spoken.length) {
      requiredLanguages(text)
        .filter((code) => !spoken.includes(code))
        .forEach((code) => {
          const name = typeof JOB_FIT_I18N !== "undefined" ? JOB_FIT_I18N.languageName(code) : code;
          out.push(tr("screen.language", { language: name }, `Asks for ${name}, which isn't one of your languages`));
        });
    }
    return out;
  }

  // --- the screen -----------------------------------------------------------

  // Everything Layer 1 decides about a posting, from a profile's keyword
  // settings and (optionally) its jobSearch answers and the posting's
  // location. A hard reject short-circuits: its flags and warnings are empty,
  // as the page has always stored them. `place` is where the posting was
  // read to be: { country, countries, region, arrangement }.
  function screen(text, keywords, context = {}) {
    const k = keywords || {};
    const body = String(text || "");
    const jobSearch = context.jobSearch || null;
    const place = JOB_FIT_GEO.postingPlace({ location: context.location, text: body });
    const where = { country: place.country, region: place.region, arrangement: place.arrangement };

    const { hardReject, downgraded } = findHardRejectInPlace(
      body,
      compileConfig(k.hardRejects, "hardRejects"),
      place,
      jobSearch || {}
    );
    if (hardReject) return { hardReject, domainFlags: [], softWarnings: [], place: where };

    const warningPatterns = compileConfig(k.softWarnings, "softWarnings").filter(
      (entry) => gateOutcome(entry.gate, place, jobSearch || {}) !== "skip"
    );
    const softWarnings = [
      ...downgraded,
      ...matchedLabels(warningPatterns, body),
      ...computedWarnings(JOB_FIT_KEYWORDS.computedIds(k.softWarnings, "softWarnings"), body, place, jobSearch),
    ];
    return {
      hardReject: null,
      domainFlags: matchedLabels(compileConfig(k.domainFlags, "domainFlags"), body),
      softWarnings,
      place: where,
    };
  }

  return { compileConfig, matchedLabels, cleanMatch, findHardReject, screen, requiredLanguages, timeZoneRequirement, gateOutcome };
})();
