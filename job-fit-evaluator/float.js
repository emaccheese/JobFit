// The on-page button: a card in the bottom-left corner of job pages that
// evaluates the posting on screen with one click and shows its saved result.
//
// Opt-in per site. JobFit reads nothing on a page until asked, so this only
// runs on sites the user switched it on for in the popup — each one a Chrome
// permission granted for that site alone (background.js registers this file
// as a content script for exactly those origins). It never calls the model
// by itself: a click goes through the same path as the keyboard shortcut.
//
// Bottom-left because that's where the job list is on LinkedIn, and the
// bottom-right corner belongs to LinkedIn's messaging bar and Indeed's chat.
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
  // Re-reads after a navigation. Single-page job boards fill the posting in a
  // moment after the address changes, and LinkedIn empties the detail pane
  // while it loads the next job — so a miss before the last retry is
  // "still loading", not "no job here", and the card stays put.
  const RETRIES_MS = [0, 600, 1500, 3000, 6000];
  const HIDE_CONFIRM_MS = 4000;

  let root = null; // shadow root
  let card = null;
  let current = { jobKey: null, profileId: null };
  let starting = false;
  let navigating = false;
  let collapsed = false;
  let confirmingHide = false;
  let confirmTimer = null;
  let lastHref = location.href;
  let lastLook = null; // what was drawn last, to animate only real changes
  let timers = [];
  let seq = 0; // refreshes overlap; only the newest one may draw

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

  async function readSettings() {
    try {
      const { floatingButtonSites, floatCollapsed } = await chrome.storage.local.get(["floatingButtonSites", "floatCollapsed"]);
      return {
        enabled: Array.isArray(floatingButtonSites) && floatingButtonSites.includes(location.origin),
        collapsed: Boolean(floatCollapsed && floatCollapsed[location.origin]),
      };
    } catch (err) {
      // The extension was reloaded or removed: this script is orphaned.
      return { enabled: false, collapsed: false };
    }
  }

  // --- drawing ----------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; left: 24px; bottom: 24px; z-index: 2147483646;
      font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1d2330;
      animation: enter .34s cubic-bezier(.2, .9, .3, 1.25) both; }
    .wrap.leaving { animation: leave .2s ease-in both; }
    @keyframes enter { from { opacity: 0; transform: translateY(18px) scale(.94); } to { opacity: 1; transform: none; } }
    @keyframes leave { to { opacity: 0; transform: translateY(12px) scale(.96); } }

    .card { position: relative; display: flex; align-items: center; gap: 12px; min-width: 250px; max-width: 330px;
      padding: 10px 18px 10px 10px; border: 1px solid rgba(20, 30, 50, .08); border-radius: 18px; cursor: pointer;
      background: #fff; color: inherit; font: inherit; text-align: left;
      box-shadow: 0 10px 28px rgba(20, 30, 50, .20), 0 2px 6px rgba(20, 30, 50, .12);
      transition: transform .15s ease, box-shadow .15s ease; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 14px 34px rgba(20, 30, 50, .26), 0 3px 8px rgba(20, 30, 50, .14); }
    .card:active { transform: translateY(0) scale(.99); }
    .card:focus-visible { outline: 3px solid #2f6bd0; outline-offset: 3px; }
    .card.busy { cursor: default; }

    .badge { flex: 0 0 auto; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%;
      background: #2f6bd0; color: #fff; font-size: 17px; font-weight: 800; letter-spacing: -.02em;
      box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .12); }
    .badge.green { background: #177a3e; }
    .badge.amber { background: #9a6300; }
    .badge.red { background: #b3261e; }
    .badge.muted { background: #5f6b7c; }
    .badge.mark { font-size: 15px; letter-spacing: .02em; }
    .badge.pop { animation: pop .42s cubic-bezier(.2, .9, .3, 1.4); }
    @keyframes pop { 0% { transform: scale(.7); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }

    .spin { width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, .35); border-top-color: #fff; border-radius: 50%;
      animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .primary { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .primary .verdict { text-transform: capitalize; }
    .secondary { font-size: 12px; color: #5f6b7c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .arrow { margin-left: auto; padding-left: 4px; color: #5f6b7c; font-size: 20px; line-height: 1; }

    .controls { position: absolute; top: -10px; right: -10px; display: flex; gap: 4px; opacity: 0;
      transform: translateY(3px); transition: opacity .15s, transform .15s; }
    .wrap:hover .controls, .wrap:focus-within .controls, .controls.show { opacity: 1; transform: none; }
    .ctl { width: 24px; height: 24px; border-radius: 50%; border: 1px solid rgba(20, 30, 50, .12); background: #fff;
      color: #3d4757; font: 700 14px/22px -apple-system, sans-serif; padding: 0; cursor: pointer;
      box-shadow: 0 2px 6px rgba(20, 30, 50, .18); }
    .ctl:hover { background: #f0f2f5; }
    .ctl:focus-visible { outline: 2px solid #2f6bd0; outline-offset: 1px; }
    .ctl.danger { background: #b3261e; border-color: #b3261e; color: #fff; }

    /* Minimized: just the badge, still showing the score. */
    .wrap.collapsed .card { min-width: 0; padding: 5px; border-radius: 50%; gap: 0; }
    .wrap.collapsed .text, .wrap.collapsed .arrow, .wrap.collapsed .ctl.min { display: none; }

    @media (prefers-reduced-motion: reduce) {
      .wrap, .wrap.leaving, .badge.pop, .spin { animation: none; }
      .card, .controls { transition: none; }
    }
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

    card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    card.addEventListener("click", onCardClick);

    const controls = document.createElement("div");
    controls.className = "controls";
    const min = document.createElement("button");
    min.type = "button";
    min.className = "ctl min";
    min.textContent = "–";
    min.addEventListener("click", (e) => {
      e.stopPropagation();
      setCollapsed(true);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ctl close";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      onHideClick();
    });
    controls.appendChild(min);
    controls.appendChild(close);

    wrap.appendChild(card);
    wrap.appendChild(controls);
    root.appendChild(style);
    root.appendChild(wrap);
    // Sites built on Radix UI treat any click outside their dialog as a
    // dismiss; the banner stops these for the same reason.
    ["pointerdown", "mousedown", "click"].forEach((evt) => host.addEventListener(evt, (e) => e.stopPropagation()));
    document.documentElement.appendChild(host);
    lastLook = null;
  }

  // Only when there is really no job here, or the site was switched off —
  // never while a single-page board is between jobs.
  function removeRoot() {
    if (!root) return;
    const host = root.host;
    const wrap = root.querySelector(".wrap");
    root = null;
    card = null;
    lastLook = null;
    if (wrap && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wrap.classList.add("leaving");
      setTimeout(() => host.remove(), 200);
    } else {
      host.remove();
    }
  }

  function scoreClass(score) {
    return JOB_FIT_UI.scoreClass(score) || "red";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function siteName() {
    return location.hostname.replace(/^www\./, "");
  }

  // look: { kind, badge, badgeClass, spinner, primary, verdict, secondary, title, busy }
  function lookFor(state) {
    if (confirmingHide) {
      return {
        kind: "confirm",
        badge: "×",
        badgeClass: "red",
        primary: t("float.hideConfirm", { site: siteName() }),
        secondary: t("float.hideConfirmSub"),
        title: t("float.hide"),
      };
    }
    switch (state.kind) {
      case "loading":
        return { kind: "loading", spinner: true, badgeClass: "muted", primary: t("float.loading"), secondary: "JobFit", busy: true };
      case "starting":
        return { kind: "starting", spinner: true, primary: t("float.starting"), secondary: "JobFit", busy: true };
      case "queued":
        return {
          kind: `queued${state.position}`,
          spinner: true,
          primary: t("float.queued", { position: state.position }),
          secondary: t("float.queuedSub"),
          busy: true,
        };
      case "scoring":
        return { kind: "scoring", spinner: true, primary: t("float.scoring"), secondary: t("float.scoringSub"), busy: true };
      case "reject":
        return {
          kind: `reject:${state.jobKey}`,
          badge: "✕",
          badgeClass: "red",
          primary: t("float.reject"),
          secondary: state.label || t("float.scoreSub"),
          title: t("float.titleSaved"),
          arrow: true,
        };
      case "score": {
        const verdict = state.verdict && JOB_FIT_I18N.has(`verdict.${state.verdict}`) ? t(`verdict.${state.verdict}`) : state.verdict;
        return {
          kind: `score:${state.jobKey}:${state.score}`,
          badge: String(state.score),
          badgeClass: scoreClass(state.score),
          primary: verdict || t("float.saved"),
          verdict: Boolean(verdict),
          secondary: t("float.scoreSub"),
          title: t("float.titleSaved"),
          arrow: true,
        };
      }
      default:
        return {
          kind: `evaluate:${state.jobKey}`,
          badge: "JF",
          badgeClass: "mark",
          primary: t("float.evaluate"),
          secondary: t("float.evaluateSub"),
          title: t("float.title"),
          arrow: true,
        };
    }
  }

  function draw(state) {
    ensureRoot();
    const look = lookFor(state);
    const wrap = root.querySelector(".wrap");
    wrap.classList.toggle("collapsed", collapsed && !confirmingHide);

    card.textContent = "";
    card.classList.toggle("busy", Boolean(look.busy));
    const badge = el("span", `badge ${look.badgeClass || ""}`);
    if (look.spinner) badge.appendChild(el("span", "spin"));
    else badge.textContent = look.badge;
    // The pop is for news — a score arriving, a new job — not for every
    // redraw of the same state.
    if (lastLook && lastLook !== look.kind && !look.spinner) badge.classList.add("pop");
    lastLook = look.kind;

    const text = el("span", "text");
    const primary = el("span", "primary");
    if (look.verdict) primary.appendChild(el("span", "verdict", look.primary));
    else primary.textContent = look.primary;
    text.appendChild(primary);
    text.appendChild(el("span", "secondary", look.secondary));

    card.appendChild(badge);
    card.appendChild(text);
    if (look.arrow) card.appendChild(el("span", "arrow", "›"));

    const label = collapsed && !confirmingHide ? `${t("float.expand")} — ${look.primary}` : `${look.primary}. ${look.secondary}`;
    card.title = collapsed && !confirmingHide ? t("float.expand") : look.title || look.primary;
    card.setAttribute("aria-label", `JobFit: ${label}`);

    const min = root.querySelector(".ctl.min");
    const close = root.querySelector(".ctl.close");
    min.title = t("float.minimize");
    min.setAttribute("aria-label", t("float.minimize"));
    close.title = t("float.hide");
    close.setAttribute("aria-label", t("float.hide"));
    close.classList.toggle("danger", confirmingHide);
    root.querySelector(".controls").classList.toggle("show", confirmingHide);
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

  let lastState = { kind: "evaluate" };

  function show(state) {
    lastState = state;
    draw(state);
  }

  async function refresh({ final = false } = {}) {
    const mySeq = ++seq;
    try {
      const settings = await readSettings();
      if (mySeq !== seq) return;
      if (!settings.enabled) {
        removeRoot();
        current = { jobKey: null, profileId: null };
        return;
      }
      collapsed = settings.collapsed;
      await JOB_FIT_I18N.load();
      const result = extract();
      if (!result) {
        // Between jobs on a single-page board: keep the card, say so. Only a
        // page that still has no job after the last retry loses it.
        if (navigating && !final && root) show({ kind: "loading" });
        else if (!navigating || final) {
          removeRoot();
          current = { jobKey: null, profileId: null };
        }
        return;
      }
      const jobKey = JOB_FIT_JOBKEY.keyFor(result);
      const profile = await JOB_FIT_PROFILES.getActive();
      if (mySeq !== seq) return;
      if (jobKey !== current.jobKey) starting = false;
      current = { jobKey, profileId: profile.id };

      const inQueue = await queueState(jobKey, profile.id);
      if (mySeq !== seq) return;
      if (inQueue) {
        starting = false;
        show(inQueue);
        return;
      }
      if (starting) {
        show({ kind: "starting" });
        return;
      }
      const record = await JOB_FIT_EVALSTORE.get(profile.id, jobKey);
      if (mySeq !== seq) return;
      if (record && record.hardReject) show({ kind: "reject", jobKey, label: record.hardReject.label });
      else if (record && record.score != null) show({ kind: "score", jobKey, score: record.score, verdict: record.verdict });
      else show({ kind: "evaluate", jobKey });
    } catch (err) {
      // Orphaned after an extension reload; nothing useful to show.
      removeRoot();
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

  // --- actions ------------------------------------------------------------------

  async function setCollapsed(value) {
    collapsed = value;
    draw(lastState);
    try {
      const { floatCollapsed } = await chrome.storage.local.get("floatCollapsed");
      const next = { ...(floatCollapsed || {}) };
      if (value) next[location.origin] = true;
      else delete next[location.origin];
      await chrome.storage.local.set({ floatCollapsed: next });
    } catch (err) {
      /* orphaned */
    }
  }

  // Always the same path as the shortcut: the worker injects the page scripts
  // and content.js decides — a saved result is shown with Re-evaluate, a new
  // job is screened and queued.
  async function onCardClick() {
    if (confirmingHide) {
      cancelHide();
      return;
    }
    if (collapsed) {
      setCollapsed(false);
      return;
    }
    if (!card || card.classList.contains("busy")) return;
    starting = true;
    show({ kind: "starting" });
    try {
      await chrome.runtime.sendMessage({ type: "JOB_FIT_EVALUATE_TAB" });
    } catch (err) {
      /* the worker shows any failure as a red "!" on the toolbar icon */
    }
    // A saved result or a hard reject never enters the queue; stop showing
    // "Starting…" once the page has had time to show its banner.
    setTimeout(() => {
      starting = false;
      refresh();
    }, 3000);
  }

  // Two clicks, like deleting a tracked job: the first asks, the second hides.
  // Minimizing is the one-click way to get it out of the way.
  function onHideClick() {
    if (!confirmingHide) {
      confirmingHide = true;
      draw(lastState);
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(cancelHide, HIDE_CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer);
    confirmingHide = false;
    removeRoot();
    chrome.runtime.sendMessage({ type: "JOB_FIT_FLOAT_SITE", origin: location.origin, enabled: false }).catch(() => {});
  }

  function cancelHide() {
    clearTimeout(confirmTimer);
    if (!confirmingHide) return;
    confirmingHide = false;
    if (root) draw(lastState);
  }

  // --- wiring -------------------------------------------------------------------

  window.__jobFitFloat = { refresh };

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const recordKey = current.profileId && current.jobKey ? JOB_FIT_EVALSTORE.recordKey(current.profileId, current.jobKey) : null;
      if (
        changes.floatingButtonSites ||
        changes.floatCollapsed ||
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
  }, 500);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && confirmingHide) cancelHide();
  });

  scheduleRefreshes();
})();
