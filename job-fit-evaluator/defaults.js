var JOB_FIT_DEFAULTS = {
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
      presets: ["exportcontrol", "masters"],
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
    model: "",
    reasoningEffort: "low",
    // Per-request ceiling. A scoring answer is well under 1k tokens; the rest
    // is headroom for reasoning.
    maxOutputTokens: 4000,
    // Input + output tokens per local day; 0 = no limit.
    dailyTokenBudget: 0,
  },
  expectedSalary: {
    USD: { min: null, max: null },
    CAD: { min: null, max: null },
    MXN: { min: null, max: null },
  },
};
