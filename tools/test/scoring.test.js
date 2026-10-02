// Reproduces the reported scoring problems against the real background.js and
// screening.js, with the model's answer stubbed to what was observed.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");

const ev = () => ({ addListener() {} });
const store = {};
const chrome = {
  storage: { local: { async get() { return {}; }, async set(o) { Object.assign(store, o); }, async remove() {}, async getKeys() { return []; } }, session: { async get() { return {}; }, async set() {} }, onChanged: ev() },
  runtime: { onMessage: ev(), onStartup: ev(), onInstalled: ev(), getURL: (p) => p, id: "x" },
  permissions: { async contains() { return false; }, async remove() {}, onAdded: ev(), onRemoved: ev() },
  scripting: { async registerContentScripts() {}, async unregisterContentScripts() {}, async executeScript() { return []; } },
  tabs: { async sendMessage() {}, onRemoved: ev(), onUpdated: ev(), async query() { return []; }, create() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  alarms: { onAlarm: ev(), async get() { return null; }, async create() {}, async clear() {} },
  commands: { onCommand: ev() },
  webNavigation: { async getAllFrames() { return []; } },
  i18n: { getUILanguage: () => "en" },
};
const ctx = { chrome, console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, fetch: async () => ({ ok: false }), navigator: { languages: ["en"] }, Intl, AbortController };
ctx.self = ctx;
ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f }));
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });

let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) { fails++; console.log("FAIL", name, JSON.stringify(detail ?? "")); } else console.log("ok  ", name);
};

const PROFILE = "Senior C++ engineer, 8 years. Imaging and video processing, Windows-primary. Gaps: Kubernetes, game engines, ML model training.";
const EXPECTED = {
  USD: { min: 160000, max: 200000, period: "year" },
  CAD: { min: 120000, max: 150000, period: "year" },
  MXN: { min: 80000, max: 110000, period: "month" },
};

async function run(modelData, { postingText, domainFlags = [], learningFlags = [], coreWorkOnly = [], place = null, location = "", jobSearch = null, profile = PROFILE }) {
  ctx.callLmStudio = async () => ({ ok: true, data: JSON.parse(JSON.stringify(modelData)), model: "m" });
  const r = await ctx.evaluateWithLmStudio({ profile, postingText, domainFlags, learningFlags, coreWorkOnly, expectedSalary: EXPECTED, jobSearch, place, location });
  return r.data;
}

(async () => {
  await ctx.i18nReady;

  // 1. VIAVI: 91, "familiarity with … such as OpenCV, NumPy, SciPy, scikit-image, or PIL",
  //    salary "84,000 to 156,000" with no currency, Ottawa.
  const viavi = "Software Development Engineer (Image Processing)\nOttawa, ON\nRequirements\n- 5+ years of C++ development\n- Familiarity with common image processing and numerical libraries such as OpenCV, NumPy, SciPy, scikit-image, or PIL.\nSalary range: 84,000 to 156,000";
  let d = await run(
    {
      score: 91, verdict: "apply",
      required_gaps: ["Familiarity with common image processing and numerical libraries such as OpenCV, NumPy, SciPy, scikit-image, or PIL"],
      gaps: [], matches: ["C++"],
      salary: { posting_stated: "84,000 to 156,000", posting_stated_min: null, posting_stated_max: null, posting_stated_currency: null, estimated_market_min: 110000, estimated_market_max: 150000, estimated_market_currency: "CAD" },
    },
    { postingText: viavi, domainFlags: ["OpenCV"], place: { country: "CA" }, location: "Ottawa, ON" }
  );
  check("VIAVI: no 50 cap, 10 points off", d.score === 81 && d.raw_score === 91, { score: d.score, raw: d.raw_score, reasons: d.score_cap_reasons });
  check("VIAVI: verdict apply", d.verdict === "apply", d.verdict);
  check("VIAVI: CAD inferred from Ottawa", d.salary.posting_stated_currency === "CAD" && d.salary.currency_inferred === true, d.salary);
  check("VIAVI: compared against the CAD expectation (within)", d.salary.vs_candidate_expectation === "within", d.salary.vs_candidate_expectation);
  check("VIAVI: says the currency was inferred", /inferred/i.test(d.salary.note), d.salary.note);

  // 1b. Same, but the model shortened the gap to just "OpenCV": the posting's
  //     own sentence still makes it a low bar.
  d = await run({ score: 91, verdict: "apply", required_gaps: ["OpenCV"], gaps: [] }, { postingText: viavi, domainFlags: ["OpenCV"], place: { country: "CA" } });
  check("VIAVI short gap: still soft (81)", d.score === 81, { score: d.score, reasons: d.score_cap_reasons });

  // 2. A flagged skill the job really requires still caps at 50.
  d = await run(
    { score: 88, verdict: "apply", required_gaps: ["Kubernetes"], gaps: [] },
    { postingText: "Responsibilities\nYou will operate and extend our Kubernetes clusters every day.\nRequirements\n- 3+ years running Kubernetes in production", domainFlags: ["Kubernetes"] }
  );
  check("hard domain flag: capped at 50, skip", d.score === 50 && d.verdict === "skip", { score: d.score, verdict: d.verdict });

  // 3. "Go" never matches inside "GoogleTest".
  d = await run({ score: 85, verdict: "apply", required_gaps: ["GoogleTest unit testing"], gaps: [] }, { postingText: "Requirements\n- Unit tests with GoogleTest", domainFlags: ["Go"] });
  check("'Go' flag doesn't match GoogleTest", d.score === 85 && !d.score_cap_reasons, { score: d.score, reasons: d.score_cap_reasons });

  // 4. Verdict follows the score, not the model's word.
  d = await run({ score: 90, verdict: "borderline", sponsorship: "unstated", required_gaps: [], gaps: [] }, { postingText: "Requirements\n- C++" });
  check("90 is 'apply' even if the model said borderline", d.verdict === "apply" && d.model_verdict === "borderline", { verdict: d.verdict, model: d.model_verdict });

  // 5. A stated max of "140,000" (a string) against a 160K USD floor is below.
  d = await run(
    { score: 80, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$120,000 - $140,000", posting_stated_min: "120,000", posting_stated_max: "140,000", posting_stated_currency: "USD" } },
    { postingText: "Senior Engineer\nBase pay: $120,000 - $140,000" }
  );
  check("max 140K vs 160K floor is 'below'", d.salary.vs_candidate_expectation === "below", d.salary);

  // 6. "Most offers between the minimum and midpoint": realistic top is the midpoint.
  d = await run(
    { score: 80, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$150,000 – $210,000", posting_stated_min: 150000, posting_stated_max: 210000, posting_stated_currency: "USD" } },
    { postingText: "Senior Engineer\nThe base range is $150,000 – $210,000. Most offers will fall between the minimum and midpoint of the range." }
  );
  // Midpoint 180K is above the 160K floor, so still within — but it's the number used.
  check("midpoint used as realistic top", d.salary.posting_realistic_max === 180000 && /midpoint/i.test(d.salary.note), d.salary);

  // 7. Item 1: below level needs BOTH signals. Years alone: a note, no deduction.
  const junior = "Software Engineer\nRequirements\n- 2+ years of experience in C++ (academic experience acceptable)";
  d = await run({ score: 100, verdict: "apply", required_gaps: [], gaps: [] }, { postingText: junior });
  check("item 1: low years alone -> flag only, 100 stays", d.score === 100 && Boolean(d.level_flag) && !d.score_cap_reasons, { score: d.score, flag: d.level_flag });
  // Pay alone: a note, no deduction.
  d = await run(
    { score: 88, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$90,000 - $110,000", posting_stated_min: 90000, posting_stated_max: 110000, posting_stated_currency: "USD" } },
    { postingText: "Senior Engineer\nRequirements\n- 7+ years of C++ experience\nPay: $90,000 - $110,000" }
  );
  check("item 1: pay below floor alone -> flag only", d.score === 88 && Boolean(d.seniority_flag) && !d.level_flag, { score: d.score, pay: d.seniority_flag });
  // Both: 20 points off.
  d = await run(
    { score: 100, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$90,000 - $110,000", posting_stated_min: 90000, posting_stated_max: 110000, posting_stated_currency: "USD" } },
    { postingText: junior + "\nPay: $90,000 - $110,000" }
  );
  check("item 1: both signals -> 100 - 20 = 80", d.score === 80 && d.raw_score === 100, { score: d.score, reasons: d.score_cap_reasons });
  d = await run({ score: 90, verdict: "apply", required_gaps: [], gaps: [] }, { postingText: "Senior Engineer\nRequirements\n- 7+ years of professional C++ experience" });
  check("7+ years for someone with 8: no level flag", d.score === 90 && !d.level_flag, { score: d.score, flag: d.level_flag });

  // 8. The job's location is never a gap.
  d = await run(
    { score: 78, verdict: "apply", required_gaps: ["San Mateo, CA", "Tijuana-to-Mountain-View relocation", "C++17"], gaps: ["Must be based in San Mateo", "CUDA"] },
    { postingText: "Requirements\n- C++17", location: "San Mateo, CA" }
  );
  check("location gaps dropped", JSON.stringify(d.required_gaps) === '["C++17"]' && JSON.stringify(d.gaps) === '["CUDA"]', { required: d.required_gaps, gaps: d.gaps });

  // 9. Sponsorship unstated: a warning only where sponsorship is needed.
  const js = { workAuth: { US: "sponsor", MX: "citizen" } };
  d = await run({ score: 90, verdict: "apply", sponsorship: "unstated", required_gaps: [], gaps: [] }, { postingText: "Requirements\n- C++", place: { country: "US" }, jobSearch: js });
  check("unstated sponsorship in the US: warning, verdict still apply", Boolean(d.sponsorship_warning) && d.verdict === "apply", { warn: d.sponsorship_warning, verdict: d.verdict });
  d = await run({ score: 90, verdict: "apply", sponsorship: "unstated", required_gaps: [], gaps: [] }, { postingText: "Requirements\n- C++", place: { country: "MX" }, jobSearch: js });
  check("unstated sponsorship in Mexico (citizen): no warning", !d.sponsorship_warning, d.sponsorship_warning);

  // 10. Learning terms are never capped even if the model lists them as required.
  d = await run({ score: 86, verdict: "apply", required_gaps: ["ONNX Runtime"], gaps: [] }, { postingText: "Requirements\n- Deploy models with ONNX Runtime", learningFlags: ["ONNX Runtime"] });
  check("learning term in required gaps: never the 50 cap (5 off -> 81)", d.score === 81, { score: d.score, reasons: d.score_cap_reasons });

  // --- Phase 1 (second round) --------------------------------------------------

  // Item 2: a learning term in a required gap costs 5.
  d = await run({ score: 86, verdict: "apply", required_gaps: ["GoogleTest"], gaps: [] }, { postingText: "Requirements\n- Unit tests with GoogleTest", learningFlags: ["GoogleTest"] });
  check("item 2: learning gap -> 5 points off (86 -> 81)", d.score === 81, { score: d.score, reasons: d.score_cap_reasons });

  // Item 5: meets everything except one familiarity item -> stays apply.
  const fam = "Requirements\n- 6+ years of C++\n- Familiarity with OpenCV";
  d = await run({ score: 84, verdict: "apply", required_gaps: ["Familiarity with OpenCV"], gaps: [] }, { postingText: fam, domainFlags: ["OpenCV"] });
  check("item 5: 84 with one familiarity gap -> 75, apply", d.score === 75 && d.verdict === "apply", { score: d.score, verdict: d.verdict });
  d = await run({ score: 84, verdict: "apply", required_gaps: ["Familiarity with OpenCV", "5+ years of Rust"], gaps: [] }, { postingText: fam + "\n- 5+ years of Rust", domainFlags: ["OpenCV"] });
  check("item 5: plus a real gap -> no floor (74, borderline)", d.score === 74 && d.verdict === "borderline", { score: d.score, verdict: d.verdict });
  d = await run(
    { score: 91, verdict: "apply", required_gaps: ["Familiarity with common image processing and numerical libraries such as OpenCV, NumPy, SciPy, scikit-image, or PIL"], gaps: [] },
    { postingText: viavi, domainFlags: ["OpenCV"], place: { country: "CA" } }
  );
  check("item 5: VIAVI still 81", d.score === 81, d.score);

  // Item 3: a claimed match the profile doesn't back up is moved aside, score untouched.
  d = await run({ score: 80, verdict: "apply", required_gaps: [], gaps: [], matches: ["Graphics expertise", "C++ in production", "Image processing pipelines", "Strong software engineering"] }, { postingText: "Requirements\n- C++" });
  check(
    "item 3: 'graphics expertise' unverified, real matches kept, score 80",
    JSON.stringify(d.unverified_matches) === '["Graphics expertise"]' && d.matches.length === 3 && d.score === 80,
    { matches: d.matches, unverified: d.unverified_matches }
  );

  // Item 10: MXN monthly.
  const mx = { country: "MX" };
  d = await run(
    { score: 80, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$45,000 – $60,000 MXN mensuales", posting_stated_min: 45000, posting_stated_max: 60000, posting_stated_currency: "MXN" } },
    { postingText: "Ingeniero de software\nSueldo: $45,000 - $60,000 mensuales", place: mx }
  );
  check("item 10: monthly wording -> x12, compared as 540k-720k (below 960k floor)", d.salary.posting_stated_max === 720000 && d.salary.monthly_annualized && d.salary.vs_candidate_expectation === "below", d.salary);
  d = await run(
    { score: 80, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$45,000 – $60,000 MXN mensuales", posting_stated_min: 540000, posting_stated_max: 720000, posting_stated_currency: "MXN" } },
    { postingText: "Ingeniero de software\nSueldo: $45,000 - $60,000 mensuales", place: mx }
  );
  check("item 10: already annualized by the model -> untouched", d.salary.posting_stated_max === 720000 && !d.salary.monthly_annualized, d.salary);
  d = await run(
    { score: 80, verdict: "apply", required_gaps: [], gaps: [], salary: { posting_stated: "$70,000 - $90,000", posting_stated_min: 70000, posting_stated_max: 90000, posting_stated_currency: "MXN" } },
    { postingText: "Ingeniero de software\nSueldo: $70,000 - $90,000", place: mx }
  );
  check("item 10: no period stated, too low for a year in MX -> monthly, within", d.salary.posting_stated_max === 1080000 && d.salary.vs_candidate_expectation === "within", d.salary);

  // Item 4: models 33 points apart.
  const dis = ctx.JOB_FIT_EVALSTORE.modelDisagreement({ model: "qwen3", score: 85, previous: [{ model: "gpt-6-sol", score: 52 }, { model: "qwen3", score: 70 }] });
  check("item 4: disagreement 33 points, newest per model", dis && dis.spread === 33 && dis.runs.length === 2, dis);
  check("item 4: 20 points apart -> nothing", ctx.JOB_FIT_EVALSTORE.modelDisagreement({ model: "a", score: 80, previous: [{ model: "b", score: 60 }] }) === null);

  // Item 2: the profile's Learning / NOT lines.
  const lines = ctx.JOB_FIT_KEYWORDS.termsFromProfile("Senior C++ engineer.\nLearning: OpenCV, GoogleTest; ONNX Runtime (in progress)\nNOT: Kubernetes, game engines, no production ML model training\nGaps: people management of large orgs across many sites");
  check("item 2: Learning line parsed", JSON.stringify(lines.learning) === '["OpenCV","GoogleTest","ONNX Runtime"]', lines.learning);
  check("item 2: NOT/Gaps lines parsed (long phrases dropped)", JSON.stringify(lines.not) === '["Kubernetes","game engines","production ML model training"]', lines.not);
  const scProfile = ctx.JOB_FIT_SCREEN.screen("Requirements\n- Kubernetes operators\n- OpenCV", { hardRejects: {}, softWarnings: {}, domainFlags: { presets: [], phrases: [], patterns: [] }, learningFlags: { presets: [], phrases: [], patterns: [] } }, { profileText: "Learning: OpenCV\nNOT: Kubernetes" });
  check("item 2: profile lines feed screening", scProfile.domainFlags.includes("Kubernetes") && scProfile.learningFlags.includes("OpenCV") && !scProfile.domainFlags.includes("OpenCV"), scProfile);

  // --- screening ---------------------------------------------------------------
  const K = (phrases, learning = []) => ({
    hardRejects: { presets: [], phrases: [], patterns: [] },
    softWarnings: { presets: [], phrases: ["cloud"], patterns: [] },
    domainFlags: { presets: [], phrases, patterns: [] },
    learningFlags: { presets: [], phrases: learning, patterns: [] },
  });
  const posting =
    "Senior Graphics Engineer\nWhat you'll do\n- Build 3D rendering pipelines for point cloud data from LiDAR\nRequirements\n- 6+ years of C++\n- Experience with OpenCV";
  const sc = ctx.JOB_FIT_SCREEN.screen(posting, K(["3D rendering", "OpenCV"], ["OpenCV"]), {});
  check("'cloud' warning doesn't fire on 'point cloud'", !sc.softWarnings.some((w) => /cloud/i.test(w)), sc.softWarnings);
  check("learning term taken off the domain flags", !sc.domainFlags.includes("OpenCV") && sc.learningFlags.includes("OpenCV"), sc);
  check("core work diverges: 3D rendering only in responsibilities", JSON.stringify(sc.coreWorkOnly) === '["3D rendering"]', sc.coreWorkOnly);

  // --- Phase 2 (second round): job sections only, good signs --------------------
  {
    const KW = ctx.JOB_FIT_KEYWORDS;
    const kw = () => ({
      hardRejects: KW.defaultConfig("hardRejects"),
      softWarnings: { presets: KW.defaultConfig("softWarnings").presets, phrases: ["cloud"], patterns: [] },
      domainFlags: { presets: [], phrases: ["Kubernetes"], patterns: [] },
      learningFlags: KW.emptyConfig("learningFlags"),
      positiveSignals: KW.defaultConfig("positiveSignals"),
    });
    const mxCitizen = { workAuth: { US: "sponsor", MX: "citizen", CA: "sponsor" }, targetCountries: ["US", "MX", "CA"] };
    const posting =
      "Senior Imaging Engineer\nAustin, TX\nAbout Acme\nAcme is a leading cloud company running Kubernetes at scale for global customers across many industries and markets worldwide.\nWhat you'll do\n- Build image processing pipelines in C++\nRequirements\n- 6+ years of C++\nBenefits\n- Relocation assistance is available\n- TN visa holders welcome\nEqual Opportunity\nAcme is an equal opportunity employer.";
    let r = ctx.JOB_FIT_SCREEN.screen(posting, kw(), { jobSearch: mxCitizen, location: "Austin, TX" });
    check("item 7: 'cloud' in About-us doesn't warn", !r.softWarnings.some((w) => /cloud/i.test(w)), r.softWarnings);
    check("item 7: a flag only in About-us isn't a domain flag", !r.domainFlags.includes("Kubernetes"), r.domainFlags);
    check("item 8: relocation + TN shown for a Mexican citizen, US job", r.positiveSignals.length === 2, r.positiveSignals);
    r = ctx.JOB_FIT_SCREEN.screen(posting.replace("Acme is an equal opportunity employer.", "We are not able to sponsor visas for this role."), kw(), { jobSearch: mxCitizen, location: "Austin, TX" });
    check("item 7: sponsorship refusal in boilerplate still rejects", Boolean(r.hardReject), r.hardReject);
    r = ctx.JOB_FIT_SCREEN.screen("Engineer\nNashville, TN\nRequirements\n- C++\nWe are not able to offer relocation assistance.", kw(), { jobSearch: mxCitizen, location: "Nashville, TN" });
    check("item 8: Tennessee isn't TN; negated relocation isn't a good sign", r.positiveSignals.length === 0, r.positiveSignals);
    r = ctx.JOB_FIT_SCREEN.screen("Engineer\nRequirements\n- C++\nWe sponsor H-1B visas.", kw(), { jobSearch: { workAuth: { US: "citizen" }, targetCountries: ["US"] }, location: "Austin, TX" });
    check("item 8: sponsorship offer hidden for a US citizen", r.positiveSignals.length === 0, r.positiveSignals);
  }

  console.log(fails ? `${fails} FAILED` : "all scoring checks pass");
  process.exit(fails ? 1 : 0);
})();
