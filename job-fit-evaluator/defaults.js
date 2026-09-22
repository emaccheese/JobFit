var JOB_FIT_DEFAULTS = {
  // Name given to the profile that migration builds out of the pre-profiles
  // settings, so an existing install keeps its data under a sensible label.
  seedProfileName: "Me — C++ / Imaging",
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
  keywords: {
    hardRejects: [
      "without (current or future )?sponsorship",
      "not (able|available) to sponsor",
      "no sponsorship",
      "must be (a )?(u\\.?s\\.? citizen|us citizen)",
      "u\\.?s\\.? citizen(ship)? (is )?required",
      "permanent resident",
      "green card holder",
      "\\bITAR\\b",
      "security clearance",
      "graduat(ing|ion) (date )?(between|in) (20\\d\\d)",
      "currently pursuing a (bachelor|master)",
      "not able to (offer|provide) relocation",
      "no relocation (assistance|support)",
      "within (a )?(reasonable )?commut(ing|e) distance",
      "local candidates only",
    ],
    softWarnings: [
      "export control",
      "master'?s degree (is )?required",
    ],
    domainFlags: [
      "\\bmachine learning\\b",
      "\\bdeep learning\\b",
      "\\bneural network",
      "\\bPyTorch\\b",
      "\\bTensorFlow\\b",
      "\\bmodel training\\b",
      "\\bcomputer vision model",
    ],
  },
  lmStudio: {
    url: "http://localhost:1234/v1/chat/completions",
    model: "",
    timeoutSeconds: 300,
    reasoningEffort: "low",
    enableThinking: false,
  },
  expectedSalary: {
    USD: { min: null, max: null },
    CAD: { min: null, max: null },
    MXN: { min: null, max: null },
  },
};
