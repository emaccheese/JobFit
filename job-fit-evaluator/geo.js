// Places: the countries JobFit knows about (the Americas), where the user
// probably is, and which country a posting is in.
//
// Two jobs:
//  - detectHome() guesses the user's own location from the browser's time
//    zone and language, with no permission prompt and nothing sent anywhere,
//    so the setup wizard can say "Looks like you're in Baja California,
//    Mexico" instead of asking from scratch.
//  - parseLocation() reads a posting's location text ("Mountain View, CA",
//    "Tijuana, B.C., Mexico", "Remote - Brazil") into a country, a region and
//    whether it's remote, so screening can apply the rules for THAT country:
//    "no sponsorship" rules out a San Diego job for someone who needs a US
//    visa, and means nothing on a Tijuana job for a Mexican citizen.
//
// Country names in every language come from the browser (Intl.DisplayNames);
// only what Intl can't give — states and provinces, big cities, the
// abbreviations postings use — is written out here.
//
// Loaded everywhere; assigned with var so re-injection doesn't throw.
var JOB_FIT_GEO = (function () {
  // currency: what salaries are quoted in. period: how pay is usually quoted
  // there — yearly in the US and Canada, monthly across most of Latin America.
  // languages: the main working language(s), a default for "languages you
  // work in", never a rule.
  const COUNTRIES = {
    US: { currency: "USD", period: "year", languages: ["en"] },
    CA: { currency: "CAD", period: "year", languages: ["en", "fr"] },
    MX: { currency: "MXN", period: "month", languages: ["es"] },
    AR: { currency: "ARS", period: "month", languages: ["es"] },
    BS: { currency: "BSD", period: "year", languages: ["en"] },
    BB: { currency: "BBD", period: "year", languages: ["en"] },
    BZ: { currency: "BZD", period: "month", languages: ["en", "es"] },
    BO: { currency: "BOB", period: "month", languages: ["es"] },
    BR: { currency: "BRL", period: "month", languages: ["pt"] },
    CL: { currency: "CLP", period: "month", languages: ["es"] },
    CO: { currency: "COP", period: "month", languages: ["es"] },
    CR: { currency: "CRC", period: "month", languages: ["es"] },
    CU: { currency: "CUP", period: "month", languages: ["es"] },
    DO: { currency: "DOP", period: "month", languages: ["es"] },
    EC: { currency: "USD", period: "month", languages: ["es"] },
    SV: { currency: "USD", period: "month", languages: ["es"] },
    GT: { currency: "GTQ", period: "month", languages: ["es"] },
    GY: { currency: "GYD", period: "month", languages: ["en"] },
    HT: { currency: "HTG", period: "month", languages: ["fr"] },
    HN: { currency: "HNL", period: "month", languages: ["es"] },
    JM: { currency: "JMD", period: "year", languages: ["en"] },
    NI: { currency: "NIO", period: "month", languages: ["es"] },
    PA: { currency: "USD", period: "month", languages: ["es"] },
    PY: { currency: "PYG", period: "month", languages: ["es"] },
    PE: { currency: "PEN", period: "month", languages: ["es"] },
    PR: { currency: "USD", period: "year", languages: ["es", "en"] },
    SR: { currency: "SRD", period: "month", languages: ["en"] },
    TT: { currency: "TTD", period: "month", languages: ["en"] },
    UY: { currency: "UYU", period: "month", languages: ["es"] },
    VE: { currency: "VES", period: "month", languages: ["es"] },
  };
  const CODES = Object.keys(COUNTRIES);
  // Offered first in the wizard; the rest of the Americas are one click away.
  const QUICK_PICKS = ["US", "CA", "MX"];

  const PERIOD_FACTOR = { year: 1, month: 12, hour: 2080 };

  // What people and job boards call a country beyond its proper name. Short
  // all-caps codes are only trusted in capitals ("US", not the word "us").
  const COUNTRY_ALIASES = {
    US: ["usa", "u.s.a.", "u.s.", "united states of america", "ee. uu.", "ee.uu.", "eeuu", "eua", "e.u.a.", "etats-unis", "estados unidos de america"],
    CA: ["canada"],
    MX: ["mexico", "mejico", "mexique"],
    BR: ["brasil", "bresil"],
    PR: ["puerto rico", "porto rico"],
  };
  const COUNTRY_CODES_UPPER = { US: "US", USA: "US", MX: "MX", MEX: "MX", BR: "BR", CAN: "CA", BRA: "BR", ARG: "AR", COL: "CO", CHL: "CL", PER: "PE" };

  // [code, display name, ...aliases]. ISO 3166-2 codes without the country
  // prefix. Two-letter US and Canadian codes are matched only after a comma
  // ("Austin, TX"), where they can't be an ordinary word.
  const REGIONS = {
    US: [
      ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
      ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia", "washington d.c.", "washington dc"],
      ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
      ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
      ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
      ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
      ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
      ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
      ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
      ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
    ],
    CA: [
      ["AB", "Alberta"], ["BC", "British Columbia", "colombie-britannique", "colombie britannique"], ["MB", "Manitoba"],
      ["NB", "New Brunswick", "nouveau-brunswick"], ["NL", "Newfoundland and Labrador", "terre-neuve-et-labrador", "newfoundland"],
      ["NS", "Nova Scotia", "nouvelle-ecosse"], ["NT", "Northwest Territories", "territoires du nord-ouest"],
      ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island", "ile-du-prince-edouard"],
      ["QC", "Quebec", "province de quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
    ],
    MX: [
      ["AGU", "Aguascalientes", "ags."], ["BCN", "Baja California", "b.c."], ["BCS", "Baja California Sur", "b.c.s.", "bcs"],
      ["CAM", "Campeche", "camp."], ["CHP", "Chiapas", "chis."], ["CHH", "Chihuahua", "chih."],
      ["CMX", "Ciudad de México", "cdmx", "mexico city", "ciudad de mexico", "distrito federal", "d.f."],
      ["COA", "Coahuila", "coah.", "coahuila de zaragoza"], ["COL", "Colima", "col."], ["DUR", "Durango", "dgo."],
      ["MEX", "Estado de México", "edo. mex.", "edomex", "estado de mexico", "state of mexico"],
      ["GUA", "Guanajuato", "gto."], ["GRO", "Guerrero", "gro."], ["HID", "Hidalgo", "hgo."], ["JAL", "Jalisco", "jal."],
      ["MIC", "Michoacán", "mich.", "michoacan"], ["MOR", "Morelos", "mor."], ["NAY", "Nayarit", "nay."],
      ["NLE", "Nuevo León", "n.l.", "nuevo leon"], ["OAX", "Oaxaca", "oax."], ["PUE", "Puebla", "pue."],
      ["QUE", "Querétaro", "qro.", "queretaro"], ["ROO", "Quintana Roo", "q. roo", "q.roo"],
      ["SLP", "San Luis Potosí", "s.l.p.", "slp", "san luis potosi"], ["SIN", "Sinaloa", "sin."], ["SON", "Sonora", "son."],
      ["TAB", "Tabasco", "tab."], ["TAM", "Tamaulipas", "tamps."], ["TLA", "Tlaxcala", "tlax."],
      ["VER", "Veracruz", "ver."], ["YUC", "Yucatán", "yuc.", "yucatan"], ["ZAC", "Zacatecas", "zac."],
    ],
    BR: [
      ["AC", "Acre"], ["AL", "Alagoas"], ["AP", "Amapá", "amapa"], ["AM", "Amazonas"], ["BA", "Bahia"], ["CE", "Ceará", "ceara"],
      ["DF", "Distrito Federal"], ["ES", "Espírito Santo", "espirito santo"], ["GO", "Goiás", "goias"],
      ["MA", "Maranhão", "maranhao"], ["MT", "Mato Grosso"], ["MS", "Mato Grosso do Sul"], ["MG", "Minas Gerais"],
      ["PA", "Pará"], ["PB", "Paraíba", "paraiba"], ["PR", "Paraná", "parana"], ["PE", "Pernambuco"],
      ["PI", "Piauí", "piaui"], ["RJ", "Rio de Janeiro", "estado do rio de janeiro"], ["RN", "Rio Grande do Norte"],
      ["RS", "Rio Grande do Sul"], ["RO", "Rondônia", "rondonia"], ["RR", "Roraima"], ["SC", "Santa Catarina"],
      ["SP", "São Paulo", "sao paulo"], ["SE", "Sergipe"], ["TO", "Tocantins"],
    ],
  };
  // Brazilian state codes collide with US ones (PA, MA, SC, MS, MT…), so
  // they're only read when the text also says Brazil — or in Brazil's own
  // "São Paulo - SP" style.
  const COMMA_CODE_COUNTRIES = ["US", "CA"];

  // Cities often given without their state or country. [name, country,
  // region]. Deliberately small: the big hubs job postings actually name.
  const CITIES = [
    ["new york city", "US", "NY"], ["nyc", "US", "NY"], ["san francisco", "US", "CA"], ["los angeles", "US", "CA"],
    ["seattle", "US", "WA"], ["austin", "US", "TX"], ["boston", "US", "MA"], ["chicago", "US", "IL"],
    ["san diego", "US", "CA"], ["san jose", "US", "CA"], ["mountain view", "US", "CA"], ["palo alto", "US", "CA"],
    ["sunnyvale", "US", "CA"], ["santa clara", "US", "CA"], ["cupertino", "US", "CA"], ["menlo park", "US", "CA"],
    ["irvine", "US", "CA"], ["bay area", "US", "CA"], ["silicon valley", "US", "CA"], ["denver", "US", "CO"],
    ["atlanta", "US", "GA"], ["dallas", "US", "TX"], ["houston", "US", "TX"], ["san antonio", "US", "TX"],
    ["miami", "US", "FL"], ["phoenix", "US", "AZ"], ["pittsburgh", "US", "PA"], ["philadelphia", "US", "PA"],
    ["raleigh", "US", "NC"], ["salt lake city", "US", "UT"], ["minneapolis", "US", "MN"], ["detroit", "US", "MI"],
    ["redmond", "US", "WA"], ["bellevue", "US", "WA"],
    ["toronto", "CA", "ON"], ["ottawa", "CA", "ON"], ["waterloo", "CA", "ON"], ["kitchener", "CA", "ON"],
    ["mississauga", "CA", "ON"], ["markham", "CA", "ON"], ["montreal", "CA", "QC"], ["quebec city", "CA", "QC"],
    ["vancouver", "CA", "BC"], ["victoria", "CA", "BC"], ["calgary", "CA", "AB"], ["edmonton", "CA", "AB"],
    ["winnipeg", "CA", "MB"], ["halifax", "CA", "NS"],
    ["guadalajara", "MX", "JAL"], ["zapopan", "MX", "JAL"], ["monterrey", "MX", "NLE"], ["tijuana", "MX", "BCN"],
    ["mexicali", "MX", "BCN"], ["ensenada", "MX", "BCN"], ["merida", "MX", "YUC"], ["cancun", "MX", "ROO"],
    ["ciudad juarez", "MX", "CHH"], ["hermosillo", "MX", "SON"], ["saltillo", "MX", "COA"],
    ["leon", "MX", "GUA"], ["santiago de queretaro", "MX", "QUE"],
    ["rio de janeiro", "BR", "RJ"], ["belo horizonte", "BR", "MG"], ["curitiba", "BR", "PR"],
    ["porto alegre", "BR", "RS"], ["florianopolis", "BR", "SC"], ["recife", "BR", "PE"], ["brasilia", "BR", "DF"],
    ["campinas", "BR", "SP"], ["fortaleza", "BR", "CE"],
    ["bogota", "CO", null], ["medellin", "CO", null], ["buenos aires", "AR", null], ["santiago de chile", "CL", null],
    ["lima", "PE", null], ["quito", "EC", null], ["guayaquil", "EC", null], ["montevideo", "UY", null],
    ["caracas", "VE", null], ["santo domingo", "DO", null], ["ciudad de panama", "PA", null], ["panama city", "PA", null],
    ["ciudad de guatemala", "GT", null], ["guatemala city", "GT", null], ["asuncion", "PY", null], ["la paz", "BO", null],
    ["san salvador", "SV", null], ["tegucigalpa", "HN", null], ["managua", "NI", null],
  ];

  // Region names that are also everyday words ("para" in Spanish and
  // Portuguese, "acre" in English). Shown as names, never matched as text;
  // those states are still found by their codes.
  const NOT_MATCHED = new Set(["para", "acre"]);

  // Time zone → country (and region when the zone pins one down). Only the
  // Americas; anywhere else is left for the user to pick.
  const TIME_ZONES = {
    "America/New_York": "US", "America/Detroit": "US-MI", "America/Chicago": "US", "America/Denver": "US",
    "America/Phoenix": "US-AZ", "America/Los_Angeles": "US", "America/Anchorage": "US-AK", "America/Juneau": "US-AK",
    "America/Boise": "US-ID", "Pacific/Honolulu": "US-HI", "America/Indiana/Indianapolis": "US-IN",
    "America/Kentucky/Louisville": "US-KY", "America/Puerto_Rico": "PR",
    "America/Toronto": "CA-ON", "America/Montreal": "CA-QC", "America/Vancouver": "CA-BC", "America/Edmonton": "CA-AB",
    "America/Winnipeg": "CA-MB", "America/Regina": "CA-SK", "America/Halifax": "CA-NS", "America/Glace_Bay": "CA-NS",
    "America/Moncton": "CA-NB", "America/St_Johns": "CA-NL", "America/Whitehorse": "CA-YT",
    "America/Yellowknife": "CA-NT", "America/Iqaluit": "CA-NU",
    "America/Tijuana": "MX-BCN", "America/Mexico_City": "MX", "America/Monterrey": "MX-NLE", "America/Cancun": "MX-ROO",
    "America/Merida": "MX-YUC", "America/Chihuahua": "MX-CHH", "America/Ciudad_Juarez": "MX-CHH",
    "America/Hermosillo": "MX-SON", "America/Mazatlan": "MX-SIN", "America/Matamoros": "MX-TAM",
    "America/Bahia_Banderas": "MX-NAY", "America/Ojinaga": "MX-CHH",
    "America/Guatemala": "GT", "America/Belize": "BZ", "America/El_Salvador": "SV", "America/Tegucigalpa": "HN",
    "America/Managua": "NI", "America/Costa_Rica": "CR", "America/Panama": "PA", "America/Havana": "CU",
    "America/Santo_Domingo": "DO", "America/Port-au-Prince": "HT", "America/Jamaica": "JM",
    "America/Port_of_Spain": "TT", "America/Nassau": "BS", "America/Barbados": "BB",
    "America/Bogota": "CO", "America/Caracas": "VE", "America/Guayaquil": "EC", "America/Lima": "PE",
    "America/La_Paz": "BO", "America/Asuncion": "PY", "America/Montevideo": "UY", "America/Santiago": "CL",
    "America/Guyana": "GY", "America/Paramaribo": "SR",
    "America/Buenos_Aires": "AR", "America/Sao_Paulo": "BR", "America/Bahia": "BR-BA", "America/Fortaleza": "BR",
    "America/Recife": "BR-PE", "America/Manaus": "BR-AM", "America/Belem": "BR-PA", "America/Cuiaba": "BR-MT",
    "America/Campo_Grande": "BR-MS", "America/Porto_Velho": "BR-RO", "America/Rio_Branco": "BR-AC",
    "America/Boa_Vista": "BR-RR", "America/Maceio": "BR-AL", "America/Araguaina": "BR-TO", "America/Santarem": "BR-PA",
    "America/Noronha": "BR-PE",
  };

  // --- text helpers ---------------------------------------------------------

  function stripAccents(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Lower case, no accents, punctuation other than dots and hyphens turned
  // into spaces — dots matter ("B.C.", "U.S."), and so do hyphens
  // ("Colombie-Britannique").
  function normalize(text) {
    return stripAccents(text)
      .toLowerCase()
      .replace(/[^a-z0-9.\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- the name index -------------------------------------------------------

  let index = null;

  function countryNamesIn(code, langs) {
    const names = new Set();
    langs.forEach((l) => {
      try {
        const name = new Intl.DisplayNames([l], { type: "region" }).of(code);
        if (name && name !== code) names.add(normalize(name));
      } catch (err) {
        /* Intl without DisplayNames: the aliases below still apply */
      }
    });
    return names;
  }

  function buildIndex() {
    const entries = [];
    CODES.forEach((code) => {
      const names = countryNamesIn(code, ["en", "es", "fr", "pt"]);
      (COUNTRY_ALIASES[code] || []).forEach((a) => names.add(normalize(a)));
      names.forEach((name) => entries.push({ name, kind: "country", country: code }));
    });
    Object.entries(REGIONS).forEach(([country, list]) => {
      list.forEach(([code, ...names]) => {
        names
          .map(normalize)
          .filter((name) => !NOT_MATCHED.has(name))
          .forEach((name) => entries.push({ name, kind: "region", country, region: code }));
      });
    });
    CITIES.forEach(([name, country, region]) => entries.push({ name: normalize(name), kind: "city", country, region }));
    // Longest first, so "new mexico" is found before "mexico" and "baja
    // california sur" before "baja california".
    entries.sort((a, b) => b.name.length - a.name.length);
    return entries.map((entry) => ({
      ...entry,
      re: new RegExp(`(^|[\\s,(/])${escapeRe(entry.name)}(?=$|[\\s,)/.-])`, "g"),
    }));
  }

  function findMatches(text) {
    if (!index) index = buildIndex();
    const norm = normalize(text);
    const found = [];
    index.forEach((entry) => {
      entry.re.lastIndex = 0;
      let m;
      while ((m = entry.re.exec(norm))) {
        const start = m.index + m[1].length;
        found.push({ ...entry, start, end: start + entry.name.length });
      }
    });
    // A name inside a longer one isn't a separate place: the "mexico" in "new
    // mexico", the "leon" in "nuevo leon".
    return found.filter((a) => !found.some((b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start));
  }

  // "Austin, TX", "Toronto, ON" — two capitals right after a comma.
  function commaCodes(raw) {
    const out = [];
    const re = /,\s*([A-Z]{2})(?=$|[\s,)\-–·|])/g;
    let m;
    while ((m = re.exec(String(raw || "")))) out.push(m[1]);
    return out;
  }

  // "São Paulo - SP", "Curitiba/PR": Brazil's own style.
  function brazilCodes(raw) {
    const out = [];
    const re = /[-/–]\s*([A-Z]{2})(?=$|[\s,)])/g;
    let m;
    while ((m = re.exec(String(raw || "")))) out.push(m[1]);
    return out;
  }

  function upperCountryCodes(raw) {
    const out = [];
    const re = /(^|[\s,(\-–|/])([A-Z]{2,3})(?=$|[\s,)\-–|/])/g;
    let m;
    while ((m = re.exec(String(raw || "")))) {
      if (COUNTRY_CODES_UPPER[m[2]]) out.push(COUNTRY_CODES_UPPER[m[2]]);
    }
    return out;
  }

  const REMOTE_RE = /\b(remote|remoto|remota|remotely|home office|work from home|wfh|teletrabajo|t[ée]l[ée]travail|[àa] distance|trabalho remoto|100% remoto)\b/i;
  const HYBRID_RE = /\b(hybrid|h[íi]brido|h[íi]brida|hybride)\b/i;
  const ONSITE_RE = /\b(on-?site|in-?office|in office|presencial|en sitio|sur place|en personne|in person)\b/i;

  function arrangementOf(text) {
    const s = String(text || "");
    if (HYBRID_RE.test(s)) return "hybrid";
    const remote = REMOTE_RE.test(s);
    const onsite = ONSITE_RE.test(s);
    if (remote && !onsite) return "remote";
    if (onsite && !remote) return "onsite";
    return null;
  }

  // { country, countries, region, arrangement } from a location string.
  // country is set only when the text points at exactly one; `countries`
  // lists every one it names ("USA or Canada").
  function parseLocation(raw) {
    const text = String(raw || "");
    const result = { country: null, countries: [], region: null, arrangement: arrangementOf(text) };
    if (!text.trim()) return result;

    const matches = findMatches(text);
    const named = new Set(matches.filter((m) => m.kind === "country").map((m) => m.country));
    upperCountryCodes(text).forEach((c) => named.add(c));

    const regions = matches.filter((m) => m.kind !== "country");
    commaCodes(text).forEach((code) => {
      COMMA_CODE_COUNTRIES.forEach((country) => {
        const hit = REGIONS[country].find(([c]) => c === code);
        if (hit) regions.push({ kind: "region", country, region: code, fromCode: true });
      });
    });
    if (named.has("BR")) {
      brazilCodes(text).concat(commaCodes(text)).forEach((code) => {
        if (REGIONS.BR.some(([c]) => c === code)) regions.push({ kind: "region", country: "BR", region: code, fromCode: true });
      });
    }

    // Puerto Rico is its own entry for currency and names, but for work
    // authorization it's the United States.
    const countries = new Set(named);
    let fitting = regions.filter((r) => !countries.size || countries.has(r.country));
    if (!countries.size) fitting.forEach((r) => countries.add(r.country));
    // "Vancouver, BC" is Canada; a "B.C." next to "Mexico" is Baja California.
    // With no country named and a region claimed by two, the full name wins
    // over a two-letter code.
    if (!named.size && countries.size > 1) {
      const byName = new Set(fitting.filter((r) => !r.fromCode).map((r) => r.country));
      if (byName.size === 1) {
        countries.clear();
        byName.forEach((c) => countries.add(c));
        fitting = fitting.filter((r) => countries.has(r.country));
      }
    }

    result.countries = Array.from(countries);
    if (result.countries.length === 1) {
      result.country = result.countries[0];
      const region = fitting.find((r) => r.country === result.country && r.region);
      result.region = region ? region.region : null;
    }
    return result;
  }

  // When the extractor found no location: a labelled line near the top of
  // the posting ("Location: Austin, TX", "Ubicación: Guadalajara").
  const LOCATION_LABEL_RE = /^\s*(?:job\s+)?(?:location|locations|ubicaci[óo]n|localizaci[óo]n|lugar de trabajo|localisation|lieu|lieu de travail|localiza[çc][ãa]o|local de trabalho|office)\s*[:\-–]\s*(.{2,120})$/im;

  function locationFromText(text) {
    const head = String(text || "").slice(0, 3000);
    const m = head.match(LOCATION_LABEL_RE);
    return m ? m[1].trim() : null;
  }

  // Everything screening needs to know about where a posting is.
  function postingPlace({ location, text }) {
    const fromField = parseLocation(location);
    if (fromField.countries.length) {
      if (!fromField.arrangement) fromField.arrangement = arrangementOf(String(text || "").slice(0, 1500));
      return { ...fromField, source: "location" };
    }
    const line = locationFromText(text);
    const fromLine = parseLocation(line);
    const arrangement = fromField.arrangement || fromLine.arrangement || arrangementOf(String(text || "").slice(0, 1500));
    return { ...fromLine, arrangement, source: line && fromLine.countries.length ? "text" : null };
  }

  // --- the user's own location ---------------------------------------------

  function browserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (err) {
      return null;
    }
  }

  function splitPlace(value) {
    if (!value) return { country: null, region: null };
    const [country, region] = value.split("-");
    return { country, region: region || null };
  }

  // A best guess, never a fact: the time zone first (it's where the computer
  // is), then a region in the browser's language ("es-MX"). Returns
  // { country, region, timeZone, source } with source "timezone",
  // "language" or null when nothing points anywhere in the Americas.
  function detectHome() {
    const timeZone = browserTimeZone();
    const fromZone = splitPlace(TIME_ZONES[timeZone]);
    if (fromZone.country) return { ...fromZone, timeZone, source: "timezone" };
    const tags = typeof navigator !== "undefined" ? [...(navigator.languages || []), navigator.language] : [];
    for (const tag of tags) {
      const region = String(tag || "").split(/[-_]/)[1];
      if (region && COUNTRIES[region.toUpperCase()] && region.toUpperCase() !== "US") {
        return { country: region.toUpperCase(), region: null, timeZone, source: "language" };
      }
    }
    return { country: null, region: null, timeZone, source: null };
  }

  // Hours from UTC outside daylight saving (the lower of January and July),
  // so "Pacific time" and Tijuana compare as the same zone all year.
  function standardOffset(timeZone) {
    if (!timeZone) return null;
    const offsetAt = (month) => {
      try {
        const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
          .formatToParts(new Date(Date.UTC(2026, month, 15, 12)))
          .find((p) => p.type === "timeZoneName");
        const m = part && part.value.match(/GMT([+-]\d+)(?::(\d+))?/);
        if (!part) return null;
        if (!m) return 0;
        const hours = Number(m[1]);
        return hours + Math.sign(hours || 1) * (Number(m[2] || 0) / 60);
      } catch (err) {
        return null;
      }
    };
    const jan = offsetAt(0);
    const jul = offsetAt(6);
    if (jan == null || jul == null) return null;
    return Math.min(jan, jul);
  }

  // --- names for display ----------------------------------------------------

  function regionsOf(country) {
    return (REGIONS[country] || []).map(([code, name]) => ({ code, name }));
  }

  function regionName(country, region) {
    const hit = (REGIONS[country] || []).find(([code]) => code === region);
    return hit ? hit[1] : region || "";
  }

  function countryName(code) {
    return typeof JOB_FIT_I18N !== "undefined" ? JOB_FIT_I18N.countryName(code) : code;
  }

  // "Tijuana, Baja California, Mexico".
  function placeText({ city, region, country } = {}) {
    return [city, country ? regionName(country, region) : region, country ? countryName(country) : null]
      .filter(Boolean)
      .join(", ");
  }

  // Quick picks first, then everything else by name in the current language.
  function countryOptions() {
    const rest = CODES.filter((c) => !QUICK_PICKS.includes(c)).sort((a, b) =>
      countryName(a).localeCompare(countryName(b))
    );
    return [...QUICK_PICKS, ...rest].map((code) => ({ code, name: countryName(code) }));
  }

  function info(code) {
    return COUNTRIES[code] || null;
  }

  function currencyOf(code) {
    return (COUNTRIES[code] && COUNTRIES[code].currency) || null;
  }

  function periodOf(code) {
    return (COUNTRIES[code] && COUNTRIES[code].period) || "year";
  }

  // For work authorization, Puerto Rico is the United States.
  function authCountry(code) {
    return code === "PR" ? "US" : code;
  }

  function toAnnual(amount, period) {
    if (amount == null) return null;
    return Math.round(Number(amount) * (PERIOD_FACTOR[period] || 1));
  }

  return {
    COUNTRIES,
    CODES,
    QUICK_PICKS,
    PERIOD_FACTOR,
    normalize,
    parseLocation,
    locationFromText,
    postingPlace,
    arrangementOf,
    detectHome,
    browserTimeZone,
    standardOffset,
    regionsOf,
    regionName,
    placeText,
    countryOptions,
    info,
    currencyOf,
    periodOf,
    authCountry,
    toAnnual,
  };
})();
