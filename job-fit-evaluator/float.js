// The on-page button: keeps the card (card.js) on job postings of a site the
// user switched it on for, showing the job on screen and its saved score.
//
// Opt-in per site or per job board. JobFit reads nothing on a page until
// asked, so this only runs where the user switched it on, in the popup or in
// Settings — each a Chrome permission for that site or board alone
// (background.js registers this file for exactly those). It never calls the model
// by itself: a click goes through the same path as the keyboard shortcut.
//
// This file only decides whether there's a job here and which one; drawing,
// the result panel, the queue and score state, dragging and the per-site
// preferences are card.js's.
(() => {
  if (window !== window.top) return;
  // Injected again when the user switches it on for this tab (so it appears
  // without a reload); one instance is enough.
  if (window.__jobFitFloat) {
    window.__jobFitFloat.refresh();
    return;
  }

  // Re-reads after a navigation. Single-page job boards fill the posting in a
  // moment after the address changes, and LinkedIn empties the detail pane
  // while it loads the next job — so a miss before the last retry is
  // "still loading", not "no job here", and the card stays put.
  const RETRIES_MS = [0, 600, 1500, 3000, 6000];

  let lastHref = location.href;
  let timers = [];
  // The job in a Greenhouse board embedded in this page, as float-frame.js
  // read it in the iframe (via the worker). Only good for the address it
  // arrived at.
  let frameJob = null;
  let navigating = false;
  let seq = 0; // refreshes overlap; only the newest one may act

  // Same order as content.js's dispatchExtraction and the popup's
  // extractOnPage, so the card and an evaluation agree on the job.
  function extract() {
    const jf = window.__jobFit || {};
    const host = location.hostname;
    const chain = [
      jf.greenhouse,
      host.includes("linkedin.com") && jf.linkedin,
      host.includes("indeed.") && jf.indeed,
      jf.workday,
      jf.jibe,
      jf.eightfold,
    ];
    for (const run of chain) {
      if (typeof run !== "function") continue;
      try {
        const result = run();
        if (result) return result;
      } catch (err) {
        /* an extractor tripping on odd markup just means "not this one" */
      }
    }
    // The generic extractor finds text on almost any page, which would put the
    // card on a site's home page too. Only trust it when the page says it's a
    // job posting.
    if (typeof jf.generic === "function" && hasJobPostingJsonLd()) return jf.generic();
    return null;
  }

  function hasJobPostingJsonLd() {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) =>
      /"JobPosting"/.test(s.textContent || "")
    );
  }

  async function readState() {
    const { floatingButtonSites, floatingButtonBoards } = await chrome.storage.local.get(["floatingButtonSites", "floatingButtonBoards"]);
    const state = {
      sites: Array.isArray(floatingButtonSites) ? floatingButtonSites : [],
      boards: Array.isArray(floatingButtonBoards) ? floatingButtonBoards : [],
    };
    const board = JOB_FIT_BOARDS.boardForUrl(location.href);
    return {
      on: JOB_FIT_BOARDS.enabledFor(location.href, state),
      // What the card's × turns off: the whole board if that's why it's
      // here, otherwise this site.
      scope: board && state.boards.includes(board.id) && !state.sites.includes(location.origin) ? { board: board.id, label: board.name } : null,
    };
  }

  async function refresh({ final = false } = {}) {
    const mine = ++seq;
    try {
      const { on, scope } = await readState();
      if (mine !== seq) return;
      if (!on) {
        JOB_FIT_CARD.detach();
        return;
      }
      await JOB_FIT_I18N.load();
      // An embedded board's job wins over this page's own reading, as it does
      // in an evaluation: the page around an embed is the company's site.
      const result = (frameJob && frameJob.href === location.href ? frameJob : null) || extract();
      if (!result) {
        // Between jobs on a single-page board: keep the card, say so. Only a
        // page that still has no job after the last retry loses it.
        if (navigating && !final) JOB_FIT_CARD.setLoading();
        else JOB_FIT_CARD.detach();
        return;
      }
      const profile = await JOB_FIT_PROFILES.getActive();
      if (mine !== seq) return;
      await JOB_FIT_CARD.attach("site", scope);
      JOB_FIT_CARD.setJob({
        jobKey: result.jobKey || JOB_FIT_JOBKEY.keyFor(result),
        profileId: profile.id,
        title: result.title,
        company: result.company,
      });
    } catch (err) {
      // Orphaned after an extension reload; nothing useful to show.
      JOB_FIT_CARD.detach();
    }
  }

  function scheduleRefreshes() {
    timers.forEach(clearTimeout);
    navigating = true;
    timers = RETRIES_MS.map((ms, i) =>
      setTimeout(() => {
        const final = i === RETRIES_MS.length - 1;
        if (final) navigating = false;
        refresh({ final });
      }, ms)
    );
  }

  window.__jobFitFloat = { refresh };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.floatingButtonSites || changes.floatingButtonBoards || changes.activeProfileId || changes[JOB_FIT_I18N.STORAGE_KEY]) refresh();
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "JOB_FIT_FRAME_JOB" || !message.job) return;
      frameJob = { ...message.job, href: location.href };
      refresh();
    });
  } catch (err) {
    /* orphaned */
  }

  // Single-page job boards change the job without a page load. Polling the
  // address is cheaper and more reliable than patching history methods from
  // an isolated world, which can't see the page's own calls.
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    scheduleRefreshes();
  }, 500);

  scheduleRefreshes();
})();
