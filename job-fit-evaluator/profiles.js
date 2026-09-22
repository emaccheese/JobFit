// Multiple candidate profiles — one per person, or per job family for the
// same person. A profile owns the candidate text, the salary expectations,
// and all three keyword lists. LM Studio settings are deliberately NOT part
// of a profile: there is one LM Studio on this machine, so scoping the
// endpoint per profile would only mean fixing it in two places.
//
// Loaded in the popup, injected into pages alongside content.js, and
// assigned (not declared with const/let) so re-injection into an isolated
// world that already ran it doesn't throw "already declared".
var JOB_FIT_PROFILES = (function () {
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function newId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // A profile added later inherits the hard rejects and the warnings, but
  // starts with NO domain flags. The rejects encode visa/legal facts about a
  // person — both people this is set up for need sponsorship — and an empty
  // hardRejects list would silently stop filtering sponsorship-blocked
  // postings, which is the one check you never want to lose. Domain flags are
  // the opposite: they encode one specific person's skill gaps, so inheriting
  // them would flag requirements that aren't gaps for whoever this is for.
  function blankProfile(name) {
    return {
      id: newId(),
      name: name || "New profile",
      profile: "",
      keywords: {
        hardRejects: clone(JOB_FIT_DEFAULTS.keywords.hardRejects),
        softWarnings: clone(JOB_FIT_DEFAULTS.keywords.softWarnings),
        domainFlags: JOB_FIT_KEYWORDS.emptyConfig(),
      },
      expectedSalary: clone(JOB_FIT_DEFAULTS.expectedSalary),
    };
  }

  // Fills in keys a profile predates rather than requiring a manual reset.
  // Array.isArray, not `||`: a list the user deliberately emptied is an empty
  // array and must stay empty, while a key that never existed is undefined
  // and should pick up the current default. Without this, every new keyword
  // tier would need a "Reset defaults → Save" round trip to take effect.
  function normalize(profile) {
    const keywords = profile.keywords || {};
    return {
      id: profile.id || newId(),
      name: profile.name || "Unnamed profile",
      profile: typeof profile.profile === "string" ? profile.profile : "",
      // normalizeConfig also migrates: a profile saved before this change holds
      // a flat array of raw regexes, which gets read back as ticked categories
      // plus whatever didn't belong to one. A key that never existed still
      // picks up the current default; a list deliberately emptied stays empty.
      keywords: {
        hardRejects: keywords.hardRejects
          ? JOB_FIT_KEYWORDS.normalizeConfig(keywords.hardRejects, "hardRejects")
          : clone(JOB_FIT_DEFAULTS.keywords.hardRejects),
        softWarnings: keywords.softWarnings
          ? JOB_FIT_KEYWORDS.normalizeConfig(keywords.softWarnings, "softWarnings")
          : clone(JOB_FIT_DEFAULTS.keywords.softWarnings),
        domainFlags: keywords.domainFlags
          ? JOB_FIT_KEYWORDS.normalizeConfig(keywords.domainFlags, "domainFlags")
          : clone(JOB_FIT_DEFAULTS.keywords.domainFlags),
      },
      expectedSalary: profile.expectedSalary || clone(JOB_FIT_DEFAULTS.expectedSalary),
    };
  }

  // Wraps the pre-profiles settings (top-level `profile` / `keywords` /
  // `expectedSalary`) into the first profile. The id is fixed rather than
  // generated so that if the popup and an injected content script both hit an
  // unmigrated store at the same time, the two writes are identical instead
  // of producing two duplicate profiles.
  function seedProfile(legacy) {
    return normalize({
      id: "seed",
      name: JOB_FIT_DEFAULTS.seedProfileName,
      profile: legacy.profile || JOB_FIT_DEFAULTS.profile,
      keywords: legacy.keywords || clone(JOB_FIT_DEFAULTS.keywords),
      expectedSalary: legacy.expectedSalary || clone(JOB_FIT_DEFAULTS.expectedSalary),
    });
  }

  async function load() {
    const stored = await chrome.storage.local.get([
      "profiles",
      "activeProfileId",
      "profile",
      "keywords",
      "expectedSalary",
    ]);

    if (!Array.isArray(stored.profiles) || stored.profiles.length === 0) {
      // The legacy keys are left on disk rather than deleted: nothing reads
      // them after this point, and keeping them means downgrading the
      // extension doesn't lose the original settings.
      const profiles = [seedProfile(stored)];
      const activeProfileId = profiles[0].id;
      await chrome.storage.local.set({ profiles, activeProfileId });
      return { profiles, activeProfileId };
    }

    const profiles = stored.profiles.map(normalize);
    const activeProfileId = profiles.some((p) => p.id === stored.activeProfileId)
      ? stored.activeProfileId
      : profiles[0].id;
    return { profiles, activeProfileId };
  }

  async function getActive() {
    const { profiles, activeProfileId } = await load();
    return profiles.find((p) => p.id === activeProfileId) || profiles[0];
  }

  async function save(store) {
    await chrome.storage.local.set({
      profiles: store.profiles,
      activeProfileId: store.activeProfileId,
    });
  }

  // Identifies everything about a profile that can change an evaluation's
  // outcome, so a cached result can tell whether it's still valid. Without
  // this, editing a keyword list and re-running a posting would silently
  // return the old score and look like the edit did nothing.
  function fingerprint(profile) {
    const material = JSON.stringify({
      profile: profile.profile,
      hardRejects: profile.keywords.hardRejects,
      softWarnings: profile.keywords.softWarnings,
      domainFlags: profile.keywords.domainFlags,
      expectedSalary: profile.expectedSalary,
    });
    // FNV-1a, 32-bit. Not cryptographic — it only needs to change when the
    // material changes.
    let hash = 0x811c9dc5;
    for (let i = 0; i < material.length; i++) {
      hash ^= material.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  return { load, getActive, save, blankProfile, normalize, clone, newId, fingerprint };
})();
