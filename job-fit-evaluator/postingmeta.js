// What a posting says about itself rather than about the job: its requisition
// id, when applications close, and when it was posted. The id is what tells
// the same opening apart from a namesake on another site; the dates are what
// the scores can't tell you — that the 84 you've been meaning to apply to
// closes on Friday, or has been up for six weeks.
//
// Read in the page (JSON-LD, the extractor's own fields, the posting text) and
// stored on the record as `meta`; the pages only ever read it back. Dates are
// kept as calendar days ("2026-10-15"), not timestamps: a deadline is a day,
// and a timestamp would move it across midnight for anyone east or west of
// where it was read.
//
// Assigned with var so re-injection doesn't throw.
var JOB_FIT_META = (function () {
  const DAY_MS = 86400000;

  // Closing within this many days puts a job you haven't applied to in Needs
  // attention.
  const CLOSING_SOON_DAYS = 7;
  // Posted longer ago than this: worth a note that many people may have
  // applied already. Three weeks is roughly when most postings have had the
  // bulk of their applicants.
  const OLD_POSTING_DAYS = 21;

  function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function stripAccents(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // --- calendar days ----------------------------------------------------------

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function isoDay(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // Local midnight of a "YYYY-MM-DD", or null.
  function dayStart(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function makeDay(year, monthIndex, day) {
    const date = new Date(year, monthIndex, day);
    if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) return null;
    return date;
  }

  function startOfToday(now) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Whole days from today to `iso`: 0 today, negative once it has passed.
  function daysUntil(iso, now = Date.now()) {
    const day = dayStart(iso);
    if (!day) return null;
    return Math.round((day - startOfToday(now)) / DAY_MS);
  }

  function daysSince(iso, now = Date.now()) {
    const until = daysUntil(iso, now);
    return until == null ? null : -until;
  }

  // For formatDate(), which takes a timestamp.
  function dayTs(iso) {
    const day = dayStart(iso);
    return day ? day.getTime() : null;
  }

  // --- reading a date ---------------------------------------------------------

  // Month names and the usual abbreviations, in the four interface languages,
  // without accents. A whole-word list rather than a prefix test, so
  // "marketing" is never March.
  const MONTH_WORDS = {
    0: "january jan janv janvier enero ene janeiro",
    1: "february feb febrero fevrier fevr fev fevereiro",
    2: "march mar marzo mars marco",
    3: "april apr abril abr avril avr",
    4: "may mayo mai maio",
    5: "june jun junio juin junho",
    6: "july jul julio juillet juil julho",
    7: "august aug agosto ago aout",
    8: "september sept sep septiembre setiembre setembro set",
    9: "october oct octubre octobre outubro out",
    10: "november nov noviembre novembre novembro",
    11: "december dec diciembre dic decembre dezembro dez",
  };
  const MONTHS = new Map();
  Object.entries(MONTH_WORDS).forEach(([index, words]) => words.split(" ").forEach((w) => MONTHS.set(w, Number(index))));

  function monthOf(word) {
    const key = stripAccents(word).toLowerCase().replace(/\.$/, "");
    return MONTHS.has(key) ? MONTHS.get(key) : null;
  }

  const WORD = "([A-Za-zÀ-ÿ]{3,10}\\.?)";
  // Global, so every candidate is tried: in "apply within 30 days, by October
  // 15" the first word-and-number pair is "within 30".
  const DATE_PATTERNS = [
    // 2026-10-15, also the date part of an ISO timestamp.
    { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, read: (m) => ({ y: +m[1], mo: +m[2] - 1, d: +m[3] }) },
    // October 15, 2026 · Oct. 15th · Oct 15 2026
    {
      re: new RegExp(`${WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"),
      read: (m) => ({ y: m[3] ? +m[3] : null, mo: monthOf(m[1]), d: +m[2] }),
    },
    // 15 October 2026 · 15 de octubre de 2026 · 1er octobre · 15 de outubro
    {
      re: new RegExp(`\\b(\\d{1,2})(?:er|º|°)?\\s+(?:de\\s+)?${WORD}(?:,?\\s+(?:de\\s+|del\\s+)?(\\d{4}))?`, "g"),
      read: (m) => ({ y: m[3] ? +m[3] : null, mo: monthOf(m[2]), d: +m[1] }),
    },
    // 10/15/2026 or 15/10/2026 — which one depends on the country.
    { re: /\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/g, read: null },
  ];

  // The day/month/year a match names, or null when it isn't a date.
  function partsOf(pattern, m, dayFirst) {
    if (pattern.read) {
      const parts = pattern.read(m);
      return parts.mo == null ? null : parts;
    }
    const a = +m[1];
    const b = +m[2];
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let first = dayFirst;
    if (a > 12 && b <= 12) first = true;
    else if (b > 12 && a <= 12) first = false;
    if (first == null) return null;
    return first ? { y: year, mo: b - 1, d: a } : { y: year, mo: a - 1, d: b };
  }

  function dateFrom(parts, now, future) {
    if (parts.y) return makeDay(parts.y, parts.mo, parts.d);
    const today = startOfToday(now);
    let date = makeDay(today.getFullYear(), parts.mo, parts.d);
    // Two months of slack: "closes Sept 30" read on Oct 2 is a deadline that
    // just passed, not one eleven months away.
    if (date && future && today - date > 60 * DAY_MS) date = makeDay(today.getFullYear() + 1, parts.mo, parts.d);
    if (date && !future && date - today > DAY_MS) date = makeDay(today.getFullYear() - 1, parts.mo, parts.d);
    return date;
  }

  // The first date in `text`, as a Date. `dayFirst` settles 05/10/2026 (null:
  // don't guess — a wrong deadline is worse than none). A date without a year
  // is the nearest one in the direction asked for: a deadline is upcoming, a
  // posting date is past.
  function parseDate(text, { now = Date.now(), dayFirst = null, future = true } = {}) {
    let best = null;
    DATE_PATTERNS.forEach((pattern) => {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(text))) {
        if (best && best.index <= m.index) break;
        const parts = partsOf(pattern, m, dayFirst);
        const date = parts && dateFrom(parts, now, future);
        if (date) {
          best = { index: m.index, date };
          break;
        }
      }
    });
    return best ? best.date : null;
  }

  // --- reading an age ("Reposted 1 week ago") ---------------------------------

  const UNIT_DAYS = [
    [/^(minute|minuto|hour|hora|heure)/, 0],
    [/^(day|dia|jour)/, 1],
    [/^(week|semana|semaine)/, 7],
    [/^(month|mes|mois)/, 30],
  ];
  const ONE = /^(a|an|one|un|una|une|um|uma)$/;

  // Each with the count in group 1 and the unit in group 3; group 2 is a "+"
  // ("30+ days ago"), which makes the age a lower bound.
  const AGE_PATTERNS = [
    /\b(\d+|an?|one)(\+?)\s*(minutes?|hours?|days?|weeks?|months?)\s+ago\b/i,
    /\bhace\s+(\d+|una?)(\+?)\s*(minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?)\b/i,
    /\bil y a\s+(\d+|une?)(\+?)\s*(minutes?|heures?|jours?|semaines?|mois)\b/i,
    /\bh[áa]\s+(\d+|uma?)(\+?)\s*(minutos?|horas?|dias?|semanas?|m[êe]s|meses)\b/i,
  ];
  const TODAY = /\b(just posted|posted today|today|hoy|aujourd'hui|hoje)\b/i;
  const YESTERDAY = /\b(yesterday|ayer|hier|ontem)\b/i;
  // In the posting's own text an age only counts next to a word that makes it
  // the posting's: "we shipped it two weeks ago" is not a posting date.
  const POSTED_WORD = /\b(?:re)?post(?:ed)?\b|\bpublica(?:do|da)\b|\bpubli[ée]e?\b|\banunciad[ao]\b/i;

  // { days, approx } or null. `strict` for free text (see POSTED_WORD); an
  // extractor's posted-date field is already known to be one.
  function parseAge(text, { strict = false } = {}) {
    const source = String(text || "");
    for (const re of AGE_PATTERNS) {
      const m = re.exec(source);
      if (!m) continue;
      if (strict && !POSTED_WORD.test(source.slice(Math.max(0, m.index - 30), m.index))) continue;
      const unit = stripAccents(m[3]).toLowerCase();
      const entry = UNIT_DAYS.find(([test]) => test.test(unit));
      if (!entry) continue;
      const count = ONE.test(stripAccents(m[1]).toLowerCase()) ? 1 : Number(m[1]);
      if (!Number.isFinite(count)) continue;
      return { days: count * entry[1], approx: m[2] === "+" };
    }
    if (strict) return null;
    if (TODAY.test(source)) return { days: 0, approx: false };
    if (YESTERDAY.test(source)) return { days: 1, approx: false };
    return null;
  }

  // --- labels in the posting text ---------------------------------------------

  // Whole words only: "deadlines" in "meets tight deadlines" is not a label.
  // Not \b, which treats the accented letters of "até" as a word break.
  function labelPattern(alternatives, { closed = true } = {}) {
    return new RegExp(`(?<![A-Za-zÀ-ÿ])(?:${alternatives.join("|")})${closed ? "(?![A-Za-zÀ-ÿ])" : ""}`, "gi");
  }

  // Followed by a date: when applications close. Not a bare "end date", which
  // is as often a contract's end as the posting's.
  const DEADLINE_LABEL = labelPattern(
    [
      "apply (?:by|before|no later than)",
      "application deadline",
      "deadline(?: to apply| for applications)?",
      "applications? (?:will )?(?:close|closes|closing)(?: on)?",
      "applications? (?:are )?accepted (?:until|through)",
      "accepting applications (?:until|through)",
      "(?:posting |application |job )?closing date",
      "(?:posting|application) (?:end|close) date",
      "open until",
      "(?:posting )?expires(?: on)?",
      "expiration date",
      "time left to apply",
      "fecha l[ií]mite(?: (?:de|para) (?:postulaci[oó]n|aplicaci[oó]n|postularse|aplicar))?",
      "fecha de cierre",
      "post[uú]late antes del?",
      "postulaciones? hasta(?: el)?",
      "vigente hasta(?: el)?",
      "date limite(?: de (?:candidature|d[ée]p[oô]t))?",
      "date de cl[oô]ture",
      "postuler avant le",
      "candidatures? (?:jusqu'au|avant le)",
      "ouvert jusqu'au",
      "prazo(?: (?:de|para) (?:inscri[cç][aã]o|candidatura))?",
      "data limite",
      "inscri[cç][oõ]es at[eé]",
      "candidaturas? at[eé]",
    ]
  );

  // Workday's details panel: "End Date: October 31, 2026 (25 days left to apply)".
  const DAYS_LEFT = /\b(\d{1,3})\s+days?\s+left\s+to\s+apply\b/i;

  // Followed by a date: when it was posted. "Posted" and "published" only
  // with "on" or a colon — "published research at CVPR, October 2024" is a
  // requirement, not a date.
  const POSTED_LABEL = labelPattern([
    "posted(?:\\s+on|\\s*:)",
    "posting date",
    "date posted",
    "published(?:\\s+on|\\s*:)",
    "fecha de publicaci[oó]n",
    "publicad[oa] el",
    "date de publication",
    "publi[ée]e? le",
    "data de publica[cç][aã]o",
    "publicad[oa] em",
  ]);

  // Followed by the id. Specific enough that a sentence can't trip it: "job"
  // alone or "reference" in English never counts.
  const REQ_LABEL = labelPattern(
    [
      "req(?:uisition)?\\.?\\s*(?:id|#|no\\.?|number|code)",
      "job\\s*requisition(?:\\s*id)?",
      "requisition",
      "job\\s*(?:identification|id|#|no\\.?|number|code|ref(?:erence)?(?:\\s*(?:#|no\\.?|number|code))?)",
      "(?:reference|ref\\.?)\\s*(?:id|#|no\\.?|number|code)",
      "(?:posting|position|vacancy|opening)\\s*(?:id|#|no\\.?|number)",
      "(?:id|c[oó]digo|n[uú]mero|referencia)\\s+de\\s+(?:la\\s+)?(?:vacante|requisici[oó]n|oferta|posici[oó]n)",
      "requisici[oó]n",
      // "Référence : 12345", and the English with a colon too — never the
      // word on its own ("reference designs").
      "r[ée]f[ée]rence(?:\\s+(?:du\\s+poste|de\\s+l'offre)|(?=\\s*:))",
      "(?:id|num[ée]ro)\\s+(?:du\\s+poste|de\\s+l'offre|de\\s+r[ée]quisition)",
      "(?:id|c[oó]digo|n[uú]mero|refer[êe]ncia)\\s+da\\s+vaga",
      "requisi[cç][aã]o",
    ],
    // "Req #" ends on a symbol, so no closing check; the value test that
    // follows needs a digit anyway.
    { closed: false }
  );
  const REQ_VALUE = /^[\s:#.\-–]{0,6}([A-Za-z0-9][A-Za-z0-9_\-/.]{1,30})/;

  function cleanReqId(value) {
    const id = String(value == null ? "" : value).trim().replace(/[.\-/_]+$/, "");
    if (id.length < 3 || id.length > 30 || !/\d/.test(id)) return null;
    // A year or a date is not an id.
    if (/^(19|20)\d\d$/.test(id) || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(id)) return null;
    return id;
  }

  function reqIdFromText(text) {
    REQ_LABEL.lastIndex = 0;
    let m;
    while ((m = REQ_LABEL.exec(text))) {
      const value = REQ_VALUE.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
      const id = value && cleanReqId(value[1]);
      if (id) return id;
    }
    return null;
  }

  // The first labelled date that reads as one. Only right next to the label,
  // so "Deadline: none — we review on a rolling basis since 2019" can't reach
  // across a sentence for a number.
  function labelledDate(text, label, options) {
    label.lastIndex = 0;
    let m;
    while ((m = label.exec(text))) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const date = parseDate(after.slice(0, 45), options);
      if (date) return date;
    }
    return null;
  }

  // --- plausibility -----------------------------------------------------------

  // A deadline that passed a while ago, or years out, is a placeholder.
  function plausibleDeadline(date, now) {
    if (!date) return null;
    const days = Math.round((date - startOfToday(now)) / DAY_MS);
    return days >= -60 && days <= 400 ? isoDay(date) : null;
  }

  function plausiblePosted(date, now) {
    if (!date) return null;
    const days = Math.round((startOfToday(now) - date) / DAY_MS);
    return days >= -1 && days <= 3 * 365 ? isoDay(date) : null;
  }

  function isoFromJsonLd(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    return m ? makeDay(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function jsonLdIdentifier(node) {
    for (const id of asArray(node && node.identifier)) {
      const value = id && typeof id === "object" ? id.value ?? id["@value"] : id;
      const clean = cleanReqId(value);
      if (clean) return clean;
    }
    return null;
  }

  // --- reading a posting ------------------------------------------------------

  // Every schema.org JobPosting on the page. A page may carry several blocks,
  // each of which may be a bare object, an array, or a @graph wrapper.
  function jsonLdNodes(doc = typeof document !== "undefined" ? document : null) {
    const nodes = [];
    if (!doc) return nodes;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch (err) {
        return;
      }
      asArray(parsed).forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        asArray(entry["@graph"]).concat([entry]).forEach((node) => {
          if (node && typeof node === "object" && asArray(node["@type"]).some((type) => String(type).includes("JobPosting"))) {
            nodes.push(node);
          }
        });
      });
    });
    return nodes;
  }

  // Which way round 05/10/2026 is: the US writes month first, nearly
  // everywhere else day first. Null when the country isn't known.
  function dayFirstFor(country) {
    if (!country) return null;
    return !["US", "PH"].includes(country);
  }

  // { reqId, deadline, postedOn, postedApprox } — each null when the posting
  // doesn't say. `fields` are an extractor's own: reqId and postedText (the
  // board's "Reposted 1 week ago"), and detailsText (a details panel outside
  // the description). The structured sources lead; the text is the fallback.
  function read(text, { jsonLd = null, fields = {}, country = null, now = Date.now() } = {}) {
    const body = String(text || "");
    const details = String(fields.detailsText || "");
    const options = { now, dayFirst: dayFirstFor(country) };

    const reqId = cleanReqId(fields.reqId) || jsonLdIdentifier(jsonLd) || reqIdFromText(details) || reqIdFromText(body);

    const daysLeft = DAYS_LEFT.exec(details) || DAYS_LEFT.exec(body);
    const deadline =
      plausibleDeadline(labelledDate(details, DEADLINE_LABEL, { ...options, future: true }), now) ||
      plausibleDeadline(labelledDate(body, DEADLINE_LABEL, { ...options, future: true }), now) ||
      (daysLeft ? plausibleDeadline(new Date(startOfToday(now).getTime() + Number(daysLeft[1]) * DAY_MS), now) : null) ||
      plausibleDeadline(isoFromJsonLd(jsonLd && jsonLd.validThrough), now);

    let postedOn = plausiblePosted(isoFromJsonLd(jsonLd && jsonLd.datePosted), now);
    let postedApprox = false;
    if (!postedOn) {
      const age = parseAge(fields.postedText) || parseAge(details, { strict: true }) || parseAge(body, { strict: true });
      if (age) {
        postedOn = isoDay(new Date(startOfToday(now).getTime() - age.days * DAY_MS));
        postedApprox = age.approx;
      } else {
        postedOn =
          plausiblePosted(labelledDate(details, POSTED_LABEL, { ...options, future: false }), now) ||
          plausiblePosted(labelledDate(body, POSTED_LABEL, { ...options, future: false }), now);
      }
    }

    return { reqId: reqId || null, deadline: deadline || null, postedOn: postedOn || null, postedApprox };
  }

  // Read in the page itself: the JSON-LD, the extractor's fields, the text.
  function fromPage(result, { country = null } = {}) {
    try {
      return read(result && result.text, {
        jsonLd: jsonLdNodes()[0] || null,
        fields: (result && result.postingFields) || {},
        country,
      });
    } catch (err) {
      return { reqId: null, deadline: null, postedOn: null, postedApprox: false };
    }
  }

  function isEmpty(meta) {
    return !meta || !(meta.reqId || meta.deadline || meta.postedOn);
  }

  // Days until it closes, when that's within the window and still ahead.
  function closingSoon(meta, now = Date.now()) {
    if (!meta || !meta.deadline) return null;
    const days = daysUntil(meta.deadline, now);
    return days != null && days >= 0 && days <= CLOSING_SOON_DAYS ? days : null;
  }

  function hasClosed(meta, now = Date.now()) {
    if (!meta || !meta.deadline) return false;
    const days = daysUntil(meta.deadline, now);
    return days != null && days < 0;
  }

  // Weeks since it was posted, when that's past the point worth a note.
  function oldPostingWeeks(meta, now = Date.now()) {
    if (!meta || !meta.postedOn) return null;
    const days = daysSince(meta.postedOn, now);
    return days != null && days > OLD_POSTING_DAYS ? Math.floor(days / 7) : null;
  }

  // --- wording ----------------------------------------------------------------

  function dateLabel(iso, now) {
    const ts = dayTs(iso);
    const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
    return JOB_FIT_I18N.formatDate(ts, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  }

  // "in 3 days", "tomorrow", "2 weeks ago", in the interface language.
  function relativeLabel(days) {
    const rtf = new Intl.RelativeTimeFormat(JOB_FIT_I18N.locale(), { numeric: "auto" });
    const size = Math.abs(days);
    if (size < 14) return rtf.format(days, "day");
    if (size < 60) return rtf.format(Math.trunc(days / 7), "week");
    return rtf.format(Math.trunc(days / 30), "month");
  }

  // What the card, Tracked jobs and the popup say about a posting's details:
  // `details` for reference, `notes` for the heads-up — closing soon, closed,
  // or up long enough that the pile of applicants is likely large. The notes
  // are about applying, so once you have, there are none.
  //
  // { details, deadlineNote, ageNote, notes } — notes being the two notes
  // that apply, for a caller that shows them together.
  function describe(meta, { applied = false, now = Date.now() } = {}) {
    const t = JOB_FIT_I18N.t;
    const details = [];
    let deadlineNote = null;
    let ageNote = null;
    if (meta && meta.reqId) details.push(t("posting.reqId", { id: meta.reqId }));
    if (meta && meta.deadline) {
      const days = daysUntil(meta.deadline, now);
      const date = dateLabel(meta.deadline, now);
      details.push(days < 0 ? t("posting.closed", { date }) : t("posting.closes", { date, when: relativeLabel(days) }));
      if (!applied && days < 0) deadlineNote = t("posting.closedNote", { date });
      else if (!applied && days === 0) deadlineNote = t("posting.closesTodayNote");
      else if (!applied && days <= CLOSING_SOON_DAYS) deadlineNote = t("posting.closingSoonNote", { count: days, date });
    }
    if (meta && meta.postedOn) {
      const date = dateLabel(meta.postedOn, now);
      details.push(
        meta.postedApprox ? t("posting.postedApprox", { date }) : t("posting.posted", { date, when: relativeLabel(-daysSince(meta.postedOn, now)) })
      );
      // Moot once applications have closed.
      const weeks = hasClosed(meta, now) ? null : oldPostingWeeks(meta, now);
      if (!applied && weeks) {
        ageNote = meta.postedApprox ? t("posting.oldNoteApprox", { count: weeks }) : t("posting.oldNote", { count: weeks });
      }
    }
    return { details, deadlineNote, ageNote, notes: [deadlineNote, ageNote].filter(Boolean) };
  }

  return {
    CLOSING_SOON_DAYS,
    OLD_POSTING_DAYS,
    read,
    fromPage,
    jsonLdNodes,
    isEmpty,
    parseDate,
    parseAge,
    daysUntil,
    daysSince,
    dayTs,
    closingSoon,
    hasClosed,
    oldPostingWeeks,
    describe,
    dateLabel,
  };
})();
