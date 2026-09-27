// The on-page button: a small pill in the corner of job pages that evaluates
// the posting on screen with one click and shows its saved result.
//
// Opt-in per site. JobFit reads nothing on a page until asked, so this only
// runs on sites the user switched it on for in the popup — each one a Chrome
// permission granted for that site alone (background.js registers this file
// as a content script for exactly those origins). It never calls the model
// by itself: a click goes through the same path as the keyboard shortcut.
//
// Everything is drawn inside a shadow root so the site's CSS can't reach it,
// and the host element's id starts with job-fit- so the text extractor skips
// it (textFrom ignores #job-fit-*).
(() => {
  if (window !== window.top) return;
  // Injected again when the user switches it on for this tab (so it appears
  // without a reload); one instance is enough.
  if (window.__jobFitFloat) {
    window.__jobFitFloat.refresh();
    return;
  }

  const t = JOB_FIT_I18N.t;
  const HOST_ID = "job-fit-float";
  // Retries after a navigation: single-page job boards fill in the posting a
  // moment after the address changes.
  const RETRIES_MS = [0, 800, 2000, 5000];

  let root = null;
  let pill = null;
  let current = { jobKey: null, profileId: null };
  let starting = false;
  let lastHref = location.href;
  let timers = [];

  // Same order as content.js's dispatchExtraction and the popup's
  // extractOnPage, so the button and an evaluation agree on the job.
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
    // button on a site's home page too. Only trust it when the page says it's
    // a job posting.
    if (typeof jf.generic === "function" && hasJobPostingJsonLd()) return jf.generic();
    return null;
  }

  function hasJobPostingJsonLd() {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) =>
      /"JobPosting"/.test(s.textContent || "")
    );
  }

  async function enabledHere() {
    try {
      const { floatingButtonSites } = await chrome.storage.local.get("floatingButtonSites");
      return Array.isArray(floatingButtonSites) && floatingButtonSites.includes(location.origin);
    } catch (err) {
      // The extension was reloaded or removed: this script is orphaned.
      return false;
    }
  }

  // --- drawing ----------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    .wrap { position: fixed; right: 20px; bottom: 96px; z-index: 2147483646; display: flex; align-items: center; gap: 4px;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .pill { display: inline-flex; align-items: center; gap: 8px; border: none; cursor: pointer; border-radius: 999px;
      padding: 9px 14px 9px 9px; color: #fff; background: #3574d6; box-shadow: 0 3px 10px rgba(0,0,0,.22);
      font: inherit; letter-spacing: .01em; }
    .pill:hover { filter: brightness(1.06); }
    .pill:focus-visible { outline: 3px solid #a9c4ef; outline-offset: 2px; }
    .pill[disabled] { cursor: default; }
    .mark { display: grid; place-items: center; min-width: 26px; height: 26px; padding: 0 5px; box-sizing: border-box;
      border-radius: 999px; background: rgba(255,255,255,.22); font-size: 12px; font-weight: 700; }
    .pill.green { background: #1e8e3e; }
    .pill.amber { background: #b7791f; }
    .pill.red { background: #c0392b; }
    .pill.busy { background: #52627a; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%;
      animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hide { opacity: 0; transition: opacity .15s; border: none; cursor: pointer; width: 22px; height: 22px; border-radius: 50%;
      background: rgba(30,35,45,.75); color: #fff; font: 700 13px/22px sans-serif; padding: 0; }
    .wrap:hover .hide, .hide:focus-visible { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  function ensureRoot() {
    if (root && document.documentElement.contains(root.host)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "hide";
    hide.textContent = "×";
    hide.addEventListener("click", hideOnThisSite);

    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill";
    pill.addEventListener("click", onClick);

    wrap.appendChild(hide);
    wrap.appendChild(pill);
    root.appendChild(style);
    root.appendChild(wrap);
    // Sites built on Radix UI treat any click outside their dialog as a
    // dismiss; the banner stops these for the same reason.
    ["pointerdown", "mousedown", "click"].forEach((evt) => host.addEventListener(evt, (e) => e.stopPropagation()));
    document.documentElement.appendChild(host);
  }

  function removeRoot() {
    if (root && root.host) root.host.remove();
    root = null;
    pill = null;
  }

  function scoreClass(score) {
    if (score >= 75) return "green";
    if (score >= 55) return "amber";
    return "red";
  }

  // state: { kind: "evaluate" | "queued" | "scoring" | "score" | "reject", ... }
  function draw(state) {
    ensureRoot();
    const hide = root.querySelector(".hide");
    hide.title = t("float.hide");
    hide.setAttribute("aria-label", t("float.hide"));
    pill.className = "pill";
    pill.disabled = false;
    pill.textContent = "";
    const mark = document.createElement("span");
    mark.className = "mark";
    const text = document.createElement("span");

    if (state.kind === "scoring" || state.kind === "queued") {
      pill.classList.add("busy");
      mark.className = "spin";
      text.textContent = state.kind === "scoring" ? t("float.scoring") : t("float.queued", { position: state.position });
      pill.title = text.textContent;
    } else if (state.kind === "reject") {
      pill.classList.add("red");
      mark.textContent = "✕";
      text.textContent = t("float.reject");
      pill.title = t("float.titleSaved");
    } else if (state.kind === "score") {
      pill.classList.add(scoreClass(state.score));
      mark.textContent = String(state.score);
      const verdict = state.verdict && JOB_FIT_I18N.has(`verdict.${state.verdict}`) ? t(`verdict.${state.verdict}`) : state.verdict || "";
      text.textContent = verdict || t("float.saved");
      pill.title = t("float.titleSaved");
    } else {
      mark.textContent = "JF";
      text.textContent = starting ? t("float.starting") : t("float.evaluate");
      pill.title = t("float.title");
    }
    pill.setAttribute("aria-label", `JobFit: ${text.textContent}`);
    pill.appendChild(mark);
    pill.appendChild(text);
  }

  // --- state ------------------------------------------------------------------

  async function queueState(jobKey, profileId) {
    const { queue } = await chrome.storage.local.get("queue");
    const active = ((queue && queue.items) || []).filter(
      (i) => i.kind !== "summarize" && (i.state === "pending" || i.state === "processing")
    );
    const mine = active.find((i) => i.jobKey === jobKey && i.profileId === profileId);
    if (!mine) return null;
    if (mine.state === "processing") return { kind: "scoring" };
    return { kind: "queued", position: active.indexOf(mine) + 1 };
  }

  async function refresh() {
    try {
      if (!(await enabledHere())) {
        removeRoot();
        current = { jobKey: null, profileId: null };
        return;
      }
      await JOB_FIT_I18N.load();
      const result = extract();
      if (!result) {
        removeRoot();
        current = { jobKey: null, profileId: null };
        return;
      }
      const jobKey = JOB_FIT_JOBKEY.keyFor(result);
      const profile = await JOB_FIT_PROFILES.getActive();
      if (jobKey !== current.jobKey) starting = false;
      current = { jobKey, profileId: profile.id };

      const inQueue = await queueState(jobKey, profile.id);
      if (inQueue) {
        starting = false;
        draw(inQueue);
        return;
      }
      const record = await JOB_FIT_EVALSTORE.get(profile.id, jobKey);
      if (record && record.hardReject) draw({ kind: "reject" });
      else if (record && record.score != null) draw({ kind: "score", score: record.score, verdict: record.verdict });
      else draw({ kind: "evaluate" });
    } catch (err) {
      // Orphaned after an extension reload; nothing useful to show.
      removeRoot();
    }
  }

  function scheduleRefreshes() {
    timers.forEach(clearTimeout);
    timers = RETRIES_MS.map((ms) => setTimeout(refresh, ms));
  }

  // --- actions ------------------------------------------------------------------

  // Always the same path as the shortcut: the worker injects the page scripts
  // and content.js decides — a saved result is shown with Re-evaluate, a new
  // job is screened and queued.
  async function onClick() {
    if (!pill || pill.classList.contains("busy")) return;
    starting = true;
    draw({ kind: "evaluate" });
    try {
      await chrome.runtime.sendMessage({ type: "JOB_FIT_EVALUATE_TAB" });
    } catch (err) {
      /* the worker shows any failure as a red "!" on the toolbar icon */
    }
    setTimeout(() => {
      starting = false;
      refresh();
    }, 4000);
  }

  function hideOnThisSite() {
    removeRoot();
    chrome.runtime.sendMessage({ type: "JOB_FIT_FLOAT_SITE", origin: location.origin, enabled: false }).catch(() => {});
  }

  // --- wiring -------------------------------------------------------------------

  window.__jobFitFloat = { refresh };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const recordKey = current.profileId && current.jobKey ? JOB_FIT_EVALSTORE.recordKey(current.profileId, current.jobKey) : null;
      if (
        changes.floatingButtonSites ||
        changes.queue ||
        changes.activeProfileId ||
        changes[JOB_FIT_I18N.STORAGE_KEY] ||
        (recordKey && changes[recordKey])
      ) {
        refresh();
      }
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
  }, 700);

  scheduleRefreshes();
})();
