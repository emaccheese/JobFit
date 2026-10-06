(() => {
  // The site readers, in the order they're tried: the one list the
  // evaluation (content.js), the popup's lookup (popup.js) and the on-page
  // button (float.js) all use, so a new site can't be added to one and missed
  // in another. Loaded after the extractors it names.
  //
  // Greenhouse, Workday, Jibe and Eightfold are tried everywhere: they live on
  // companies' own domains and each returns null at once without its markup.
  // The generic reader isn't here: each caller decides when to fall back to it.
  const READERS = [
    { name: "greenhouse", on: () => true },
    { name: "linkedin", on: (host) => host.includes("linkedin.com") },
    { name: "indeed", on: (host) => host.includes("indeed.") },
    { name: "glassdoor", on: (host) => /(^|\.)glassdoor\.[a-z.]+$/i.test(host) },
    { name: "workday", on: () => true },
    { name: "jibe", on: () => true },
    { name: "eightfold", on: () => true },
  ];

  // { result, name } from the first reader that finds a posting, or null.
  // `safe`: a reader that throws on odd markup counts as "not this one"
  // instead of failing the caller.
  function readSite({ safe = false } = {}) {
    const jf = window.__jobFit || {};
    const host = location.hostname;
    for (const { name, on } of READERS) {
      if (!on(host) || typeof jf[name] !== "function") continue;
      let result = null;
      try {
        result = jf[name]();
      } catch (err) {
        if (!safe) throw err;
      }
      if (result) return { result, name };
    }
    return null;
  }

  // Which job is on screen, as far as the address can't tell: on Glassdoor's
  // search page, clicking another job swaps the detail pane and leaves the
  // address as it was. The on-page button watches this with the address.
  const ON_SCREEN_IDS = ["glassdoorJobId"];

  function jobOnScreen() {
    const jf = window.__jobFit || {};
    for (const name of ON_SCREEN_IDS) {
      if (typeof jf[name] !== "function") continue;
      try {
        const id = jf[name]();
        if (id) return id;
      } catch (err) {
        /* odd markup: no id */
      }
    }
    return "";
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.readSite = readSite;
  window.__jobFit.jobOnScreen = jobOnScreen;
})();
