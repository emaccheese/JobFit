var JOB_FIT_DEFAULTS = {
  // Tino's public site: the privacy policy, and the page Chrome opens after
  // an uninstall. GitHub Pages, served from docs/ in the repository; change
  // it here (and homepage_url in manifest.json) if it moves to its own domain.
  siteUrl: "https://emaccheese.github.io/JobFit/",
  // Name given to the first profile: the one migration builds out of the
  // pre-profiles settings, and the one a fresh install starts with. Neutral on
  // purpose — on a fresh install the setup wizard asks for a real name.
  seedProfileName: "My profile",
  // First-run template only. Your real profile is stored in
  // chrome.storage.local the moment you hit Save, so this is never anyone's
  // actual CV — replace it with your own in the popup. Keep it under ~400
  // words: the model reads it in full on every evaluation, and the shape
  // below (specifics, honest gaps, work authorisation, target) is what makes
  // the scoring useful.
  profile: `Senior <language> engineer, N years at <company/industry>.
Core: the systems you have actually built — name the domain, the scale, and
the part you owned, not job titles.
Specialisms: the two or three things you are genuinely strong at, with the
concrete techniques or standards involved.
Tooling/platform: languages, frameworks, OS, hardware you work with.
Leadership: team size, scope, and a result if you have one.
Gaps: the things you have NOT done, stated plainly (e.g. Kubernetes,
distributed systems, mobile). This matters — the evaluator uses it to tell a
real gap from a silence, and a profile with no gaps scores everything too
generously.
Work authorisation: citizenship/visa status and whether you need sponsorship.
Target: the roles, seniority and locations you actually want.`,
  // Configured as ticked categories and plain phrases, not regexes — see
  // keywords.js, which compiles these and owns the word-boundary handling.
  // The category ids come from JOB_FIT_KEYWORDS.PRESETS.
  keywords: {
    hardRejects: {
      presets: ["citizenship", "sponsorship", "clearance", "itar", "locality", "relocation", "student"],
      phrases: [],
      patterns: [],
    },
    softWarnings: {
      presets: ["exportcontrol", "workauth", "masters", "outsidetargets", "relocationneeded", "arrangement", "timezone", "language"],
      phrases: [],
      patterns: [],
    },
    // Personal by construction, so no categories — just the terms this
    // candidate's profile doesn't cover.
    domainFlags: {
      presets: [],
      phrases: [
        "machine learning",
        "deep learning",
        "neural network",
        "PyTorch",
        "TensorFlow",
        "model training",
        "computer vision model",
      ],
      patterns: [],
    },
  },
  lmStudio: {
    url: "http://localhost:1234/v1/chat/completions",
    model: "",
    timeoutSeconds: 300,
    reasoningEffort: "low",
    enableThinking: false,
    // Fixed so the same posting scores the same twice. Without it the list is
    // ranked partly by sampling noise: re-running a batch reshuffled adjacent
    // positions even though nothing about the posting or the profile changed.
    // Temperature stays above zero — the seed makes sampling reproducible
    // without forcing greedy decoding.
    seed: 7,
  },
  // Used only when the model provider is set to OpenAI (see provider.js). No
  // model is preselected: the list comes from the account's own /v1/models.
  openai: {
    apiKey: "",
    // The Balanced tier. Scoring is a judgment task — required vs preferred,
    // "or" lists, domain flags — and the cheapest tier saves cents at the cost
    // of misreads. See openaiTiers below.
    model: "gpt-6-sol",
    reasoningEffort: "low",
    // Per-request ceiling. A scoring answer is well under 1k tokens; the rest
    // is headroom for reasoning.
    maxOutputTokens: 4000,
    // Input + output tokens per local day; 0 = no limit. About 80 evaluations:
    // a safety net for a service billed per request.
    dailyTokenBudget: 200000,
    // Flex processing (half price, slower): "bulk" = only for re-evaluations
    // queued from Tracked jobs, where nobody is waiting on the result.
    flex: "bulk",
  },
  // The model choices offered first, instead of a raw list of model ids. The
  // one place to update when OpenAI releases new models. Prices are per 1M
  // tokens (input, output) from OpenAI's pricing page, September 2026 —
  // shown only as an estimate, never used for billing decisions.
  openaiTiers: [
    { id: "economy", label: "Economy", model: "gpt-6-luna", blurb: "Cheapest. Good for screening lots of postings.", price: { standard: [0.1, 0.5], flex: [0.05, 0.25] } },
    { id: "balanced", label: "Balanced", model: "gpt-6-sol", blurb: "Reliable scoring at a low cost.", price: { standard: [2, 10], flex: [1, 5] } },
    { id: "best", label: "Best", model: "gpt-6-astra", blurb: "Most capable. For the postings you're serious about.", price: { standard: [10, 50], flex: [5, 25] } },
  ],
  // Effort levels: the one choice of model and reasoning effort, for Tino
  // Cloud and for your own OpenAI key alike. Higher levels read postings more
  // carefully and cost more per evaluation. On Tino Cloud the server has the
  // same table (cloud/supabase/migrations, `levels`) and decides from it;
  // `estCost` is only a first guess at a typical evaluation, in dollars,
  // until real costs come back.
  modelLevels: [
    { id: "quick", model: "gpt-6-luna", effort: "low", estCost: 0.001 },
    { id: "careful", model: "gpt-6-luna", effort: "medium", estCost: 0.002 },
    { id: "thorough", model: "gpt-6-sol", effort: "low", estCost: 0.025 },
    { id: "deep", model: "gpt-6-sol", effort: "medium", estCost: 0.04 },
  ],
  modelLevel: "quick",
  // Tino Cloud: the Supabase project the extension talks to. Empty until the
  // project exists, and then Tino Cloud is offered as "coming soon" only.
  // `publishableKey` is Supabase's public client key (it identifies the
  // project; what a user may do is decided by their own session).
  cloud: {
    url: "",
    publishableKey: "",
  },
  expectedSalary: {
    USD: { min: null, max: null },
    CAD: { min: null, max: null },
    MXN: { min: null, max: null },
  },
};
