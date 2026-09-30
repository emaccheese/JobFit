// The on-page card and its result panel: the one place JobFit shows anything
// on a job page. It replaced a bar fixed to the top of the page, which covered
// the site's own navigation and appeared in the opposite corner from the card
// you'd just clicked.
//
// Two ways onto a page:
//   - "site": the on-page button is switched on for this site (float.js). The
//     card is there before anyone clicks, shows the job's saved score, and its
//     × turns the button off for the site.
//   - "page": an evaluation someone started (shortcut, popup, Re-evaluate) on a
//     site without the button. The card appears with the result, its × just
//     dismisses it, and it leaves when the page moves to another job.
//
// Whatever started the evaluation, the result opens as a panel from the card.
// Everything is in a closed shadow root so the site's CSS can't reach it, and
// the host's id starts with job-fit- so the text extractor skips it.
//
// Inside an iframe (a company site embedding a Greenhouse board) nothing is
// drawn: the calls are relayed through the service worker to the top frame,
// so the card sits on the page, not clipped inside the embed — and the result
// never passes through the embedding page, which could read a postMessage.
(() => {
  if (window.__jobFitCard) return;

  const t = (key, vars) => JOB_FIT_I18N.t(key, vars);
  const FRAMED = window !== window.top;

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (err) {
      return Promise.resolve(null); // orphaned after an extension reload
    }
  }

  // --- building a result (pure; used in every frame) --------------------------

  function clean(text, max = 140) {
    const collapsed = String(text || "").replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
  }

  function verdictLabel(verdict) {
    return verdict && JOB_FIT_I18N.has(`verdict.${verdict}`) ? t(`verdict.${verdict}`) : verdict || "";
  }

  function timeAgo(ts) {
    const days = Math.floor((Date.now() - ts) / 86400000);
    const rtf = new Intl.RelativeTimeFormat(JOB_FIT_I18N.locale(), { numeric: "auto" });
    if (days < 30) return rtf.format(-days, "day");
    return rtf.format(-Math.floor(days / 30), "month");
  }

  // Why a saved score may no longer mean what it did: another model, or a
  // profile edited since. A hard reject is a keyword verdict, so only the
  // profile matters for it.
  function staleNoteFor(record, profile, currentModel) {
    const profileChanged = record.profileFingerprint !== JOB_FIT_PROFILES.fingerprint(profile);
    const modelChanged = !record.hardReject && (record.model || "") !== currentModel;
    const reasons = [
      modelChanged &&
        t("banner.staleModel", { model: record.model || t("banner.aDifferentModel"), current: currentModel || t("banner.notSet") }),
      profileChanged && t("banner.staleProfile"),
    ].filter(Boolean);
    return reasons.length ? t("banner.staleNote", { reasons: JOB_FIT_I18N.list(reasons) }) : null;
  }

  // Same posting, tracked from another site under this profile? Flag only —
  // the two records are left alone; Tracked jobs is where you pick one.
  async function duplicateNoteFor(record) {
    if (!record.jobKey || !record.profileId) return null;
    try {
      const others = await JOB_FIT_EVALSTORE.list(record.profileId);
      const dups = JOB_FIT_EVALSTORE.findDuplicatesOf(record, others);
      if (!dups.length) return null;
      const d = dups[0];
      const score = d.hardReject ? t("result.hardReject") : d.score != null ? d.score : t("result.noScore");
      const when = JOB_FIT_I18N.formatDate(JOB_FIT_EVALSTORE.activityTs(d), { month: "short", day: "numeric" });
      const status = d.status && d.status !== "not_applied" ? `, ${JOB_FIT_EVALSTORE.statusLabel(d.status).toLowerCase()}` : "";
      return t("banner.duplicate", { site: JOB_FIT_EVALSTORE.siteLabel(d), detail: `${score}, ${when}${status}` });
    } catch (err) {
      return null;
    }
  }

  // A record, as the panel shows it. Serializable on purpose: from an iframe
  // it travels to the top frame as a message.
  function resultFromRecord(record, { cached = false, profileName = "", staleNote = null, duplicateNote = null, saveError = null } = {}) {
    const notes = [];
    if (duplicateNote) notes.push(duplicateNote);
    if (staleNote) notes.push(staleNote);
    if (saveError) notes.push(t("banner.notSaved", { error: saveError }));
    if (record.evaluation && record.evaluation.input_truncated) notes.push(t("banner.truncated"));
    const coreWork = record.coreWorkOnly || (record.evaluation && record.evaluation.core_work_only) || [];
    if (coreWork.length) notes.push(t("result.coreWorkDiverges", { terms: coreWork.join(", ") }));

    const when = record.lastEvaluatedAt ? t("float.evaluatedWhen", { when: timeAgo(record.lastEvaluatedAt) }) : null;
    const meta = [cached ? when : null, profileName ? t("float.asProfile", { name: profileName }) : null].filter(Boolean).join(" · ");
    const base = {
      kind: "result",
      jobKey: record.jobKey,
      profileId: record.profileId,
      subtitle: [record.title, record.company].filter(Boolean).join(" — "),
      meta,
      notes,
      actions: [cached ? "reevaluate" : null, record.jobKey ? "tracked" : null].filter(Boolean),
    };

    if (record.hardReject) {
      const match = clean(record.hardReject.matchedText);
      return {
        ...base,
        tone: "red",
        badge: "✕",
        score: null,
        title: t("float.reject"),
        summary: t("banner.hardRejectSummary", { match }),
        sections: [{ title: t("banner.rejectReason"), tone: "red", items: [`“${match}” — ${record.hardReject.label}`], open: true }],
        announce: t("float.announceReject", { reason: record.hardReject.label }),
      };
    }

    const e = record.evaluation || {};
    const score = e.score ?? record.score;
    const verdict = verdictLabel(e.verdict || record.verdict);
    const salary = e.salary
      ? [
          `${t("result.salaryPosting")}: ${e.salary.posting_stated}`,
          `${t("result.salaryMarket")}: ${e.salary.estimated_market_range}`,
          `${t("result.salaryVs")}: ${JOB_FIT_EVALSTORE.salaryVerdictLabel(e.salary.vs_candidate_expectation)}`,
          e.salary.note,
        ].filter(Boolean)
      : [];
    const sections = [
      { title: t("result.requiredGaps"), tone: "red", items: e.required_gaps, open: true },
      { title: t("result.seniority"), tone: "red", items: [e.seniority_flag, e.level_flag].filter(Boolean) },
      { title: t("result.matches"), tone: "green", items: e.matches },
      { title: t("result.gaps"), tone: "amber", items: e.gaps },
      {
        title: t("result.scoreCap"),
        tone: "amber",
        items: (e.score_cap_reasons || []).map((reason) =>
          e.raw_score != null ? `${reason} ${t("result.capDetail", { raw: e.raw_score, score })}` : reason
        ),
      },
      { title: t("banner.warningsTitle"), tone: "amber", items: record.softWarnings },
      { title: t("banner.domainFlagsTitle"), tone: "neutral", items: record.domainFlags },
      { title: t("result.learningFlags"), tone: "neutral", items: record.learningFlags },
      { title: t("result.salary"), tone: "neutral", items: salary },
    ].filter((s) => s.items && s.items.length);

    return {
      ...base,
      tone: JOB_FIT_UI.scoreClass(score) || "neutral",
      badge: score != null ? String(score) : "—",
      score: score ?? null,
      title: verdict || t("float.saved"),
      summary: e.one_line || "",
      sections,
      announce: t("float.announceScore", { score: score ?? "—", verdict }),
    };
  }

  const api = { resultFromRecord, staleNoteFor, duplicateNoteFor };
  const RELAYED = ["attach", "detach", "setJob", "setLoading", "starting", "showResult", "showNotice"];

  if (FRAMED) {
    RELAYED.forEach((method) => {
      api[method] = (...args) => send({ type: "JOB_FIT_CARD_RELAY", method, args });
    });
    window.__jobFitCard = api;
    window.JOB_FIT_CARD = api;
    return;
  }

  // --- the card (top frame only) -------------------------------------------------

  const HOST_ID = "job-fit-float";
  const HIDE_CONFIRM_MS = 4000;
  const DRAG_THRESHOLD = 5;
  const EDGE = 24;
  // Room for the card's controls, which sit 12px above its top edge.
  const PANEL_GAP = 22;

  let root = null; // closed shadow root
  let els = {};
  let mode = null; // "site" | "page" | null (not attached)
  let siteScope = null; // site mode: { board, label } when a whole job board is why the card is here
  let job = null; // { jobKey, profileId, title, company }
  let jobState = null; // what storage says about the job: evaluate / queued / scoring / score / reject
  let override = null; // "loading" between jobs
  let notice = null; // an amber/red notice for the job (or the page)
  let panelContent = null; // what the panel shows
  let panelOpen = false;
  let collapsed = false;
  let position = { side: "left", bottom: EDGE };
  let confirmingHide = false;
  let confirmTimer = null;
  let startingUntil = 0;
  let startingTimer = null;
  let lastLook = null;
  let lastAnnounced = null;
  let pageHref = null;
  let seq = 0;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      --bg: #ffffff; --text: #1d2330; --muted: #5f6b7c; --line: rgba(20, 30, 50, .12); --soft: #f3f5f8; --chip: #eef1f5;
      --accent: #2f6bd0; --focus: #2f6bd0; --green: #177a3e; --amber: #9a6300; --red: #b3261e; --grey: #5f6b7c;
      --amber-soft: #fdf3e2; --amber-fg: #8a5700; --amber-line: #e8cfa0;
      --shadow: 0 10px 28px rgba(20, 30, 50, .20), 0 2px 6px rgba(20, 30, 50, .12);
      position: fixed; z-index: 2147483646;
      font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text);
      animation: enter .34s cubic-bezier(.2, .9, .3, 1.25) both;
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: #1c2027; --text: #e6e9ee; --muted: #a3acba; --line: rgba(255, 255, 255, .14); --soft: #232830; --chip: #2a3039;
        --focus: #8ab4f8; --amber-soft: #35290f; --amber-fg: #f0b85a; --amber-line: #6b5220;
        --shadow: 0 10px 28px rgba(0, 0, 0, .55), 0 2px 6px rgba(0, 0, 0, .4);
      }
    }
    .wrap.leaving { animation: leave .2s ease-in both; }
    @keyframes enter { from { opacity: 0; transform: translateY(18px) scale(.94); } to { opacity: 1; transform: none; } }
    @keyframes leave { to { opacity: 0; transform: translateY(12px) scale(.96); } }

    .card { position: relative; display: flex; align-items: center; gap: 12px; min-width: 250px; max-width: 330px;
      padding: 10px 18px 10px 10px; border: 1px solid var(--line); border-radius: 18px; cursor: pointer;
      background: var(--bg); color: inherit; font: inherit; text-align: left; box-shadow: var(--shadow);
      touch-action: none; user-select: none; transition: transform .15s ease, box-shadow .15s ease; }
    .card:hover { transform: translateY(-2px); }
    .card:active { transform: translateY(0) scale(.99); }
    .card:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    .card.busy { cursor: default; }
    .wrap.dragging .card { cursor: grabbing; transform: scale(1.02); transition: none; }

    .badge { flex: 0 0 auto; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%;
      background: var(--accent); color: #fff; font-size: 17px; font-weight: 800; letter-spacing: -.02em;
      box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .12); }
    .badge.green { background: var(--green); } .badge.amber { background: var(--amber); }
    .badge.red { background: var(--red); } .badge.muted, .badge.neutral { background: var(--grey); }
    .badge.mark { font-size: 15px; letter-spacing: .02em; }
    .badge.pop { animation: pop .42s cubic-bezier(.2, .9, .3, 1.4); }
    @keyframes pop { 0% { transform: scale(.7); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }
    .spin { width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, .35); border-top-color: #fff; border-radius: 50%;
      animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .primary { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cap { display: inline-block; }
    .cap::first-letter { text-transform: uppercase; }
    .secondary { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .arrow { margin-left: auto; padding-left: 4px; color: var(--muted); font-size: 20px; line-height: 1; transition: transform .15s; }
    .wrap.panel-open .arrow { transform: rotate(-90deg); }
    .wrap.panel-open.below .arrow { transform: rotate(90deg); }

    .controls { position: absolute; top: -12px; right: -10px; display: flex; gap: 4px; opacity: 0;
      transform: translateY(3px); transition: opacity .15s, transform .15s; }
    .wrap.right .controls { right: auto; left: -10px; flex-direction: row-reverse; }
    .wrap:hover .controls, .wrap:focus-within .controls, .wrap.panel-open .controls, .controls.show { opacity: 1; transform: none; }
    @media (hover: none) { .controls { opacity: 1; transform: none; } }
    .ctl { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--line);
      background: var(--bg); color: var(--text); font: 700 14px/1 -apple-system, sans-serif; padding: 0; cursor: pointer;
      box-shadow: 0 2px 6px rgba(20, 30, 50, .18); }
    .ctl:hover { background: var(--soft); }
    .ctl:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .ctl.danger { background: var(--red); border-color: var(--red); color: #fff; }
    .ctl svg { width: 14px; height: 14px; }

    /* Minimized: just the badge, still showing the score. */
    .wrap.collapsed .card { min-width: 0; padding: 5px; border-radius: 50%; gap: 0; }
    .wrap.collapsed .text, .wrap.collapsed .arrow, .wrap.collapsed .ctl.min { display: none; }

    /* --- the result panel ----------------------------------------------------- */
    .panel { position: absolute; left: 0; bottom: calc(100% + ${PANEL_GAP}px); width: 380px; max-width: calc(100vw - 32px);
      max-height: var(--panel-max, 70vh); display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow);
      overflow: hidden; animation: panel-in .22s ease-out both; }
    .panel[hidden] { display: none; }
    .wrap.right .panel { left: auto; right: 0; }
    .wrap.below .panel { bottom: auto; top: calc(100% + ${PANEL_GAP}px); }
    .wrap.dragging .panel { display: none; }
    @keyframes panel-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .p-head { display: flex; gap: 12px; align-items: center; padding: 14px 12px 10px 14px; }
    .p-head .badge { width: 40px; height: 40px; font-size: 15px; }
    .p-titles { min-width: 0; flex: 1; }
    .p-title { font-size: 16px; font-weight: 700; margin: 0; outline: none; }
    .p-title:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
    .p-sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .p-close { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: var(--muted);
      font: 400 20px/1 -apple-system, sans-serif; cursor: pointer; }
    .p-close:hover { background: var(--soft); color: var(--text); }
    .p-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .p-body { overflow-y: auto; padding: 0 14px 12px; overscroll-behavior: contain; }
    .p-summary { margin: 0 0 8px; font-size: 14px; line-height: 1.45; }
    .p-meta { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
    .p-notes { list-style: none; margin: 0 0 10px; padding: 8px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.4;
      background: var(--amber-soft); color: var(--amber-fg); border: 1px solid var(--amber-line); }
    .p-notes li + li { margin-top: 5px; }
    details.sec { border-top: 1px solid var(--line); }
    details.sec > summary { display: flex; align-items: center; gap: 8px; padding: 9px 2px; cursor: pointer; list-style: none;
      font-size: 13px; font-weight: 600; border-radius: 6px; }
    details.sec > summary::-webkit-details-marker { display: none; }
    details.sec > summary::before { content: "›"; color: var(--muted); font-size: 16px; line-height: 1; width: 10px; transition: transform .12s; }
    details.sec[open] > summary::before { transform: rotate(90deg); }
    details.sec > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .tone { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--grey); }
    .tone.green { background: var(--green); } .tone.amber { background: var(--amber); } .tone.red { background: var(--red); }
    .count { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--muted); background: var(--chip); border-radius: 999px; padding: 0 8px; }
    .sec ul { margin: 0 0 10px; padding-left: 26px; font-size: 13px; line-height: 1.4; }
    .sec li + li { margin-top: 3px; }
    .p-foot { display: flex; gap: 8px; padding: 10px 14px 14px; border-top: 1px solid var(--line); }
    .p-foot button { flex: 1; font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 9px 10px;
      border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
    .p-foot button:hover { background: var(--soft); }
    .p-foot button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .p-foot button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) {
      .wrap, .wrap.leaving, .badge.pop, .spin, .panel { animation: none; }
      .card, .controls, .arrow { transition: none; }
    }
  `;

  const ICON_SWAP =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8h13M16 4l4 4-4 4M17 16H4M8 12l-4 4 4 4"/></svg>';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function origin() {
    return location.origin;
  }

  function siteName() {
    return siteScope ? siteScope.label : location.hostname.replace(/^www\./, "");
  }

  function ctl(className, label, content, onClick) {
    const button = el("button", `ctl ${className}`);
    button.type = "button";
    if (content.startsWith("<svg")) button.innerHTML = content;
    else button.textContent = content;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return button;
  }

  function ensureRoot() {
    if (root && document.documentElement.contains(root.host)) return;
    // A host left behind by an earlier copy of this script (the extension was
    // reloaded) can't be reached any more; take it away rather than stack.
    const stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "closed" });
    const style = el("style");
    style.textContent = STYLE;

    const wrap = el("div", "wrap");
    const card = el("button", "card");
    card.type = "button";
    card.addEventListener("click", onCardClick);
    wireDrag(card, wrap);

    const controls = el("div", "controls");
    controls.appendChild(ctl("min", t("float.minimize"), "–", () => setCollapsed(true)));
    controls.appendChild(ctl("swap", t("float.moveSide"), ICON_SWAP, swapSide));
    controls.appendChild(ctl("close", t("float.hide"), "×", onCloseClick));

    const panel = el("section", "panel");
    panel.id = "jobfit-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "jobfit-panel-title");

    const live = el("div", "sr");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");

    wrap.appendChild(panel);
    wrap.appendChild(card);
    wrap.appendChild(controls);
    wrap.appendChild(live);
    wrap.addEventListener("keydown", onKeydown);
    root.appendChild(style);
    root.appendChild(wrap);
    // Sites built on Radix UI treat any click outside their dialog as a
    // dismiss; stop ours at the host so using the card doesn't close theirs.
    ["pointerdown", "mousedown", "click"].forEach((evt) => host.addEventListener(evt, (e) => e.stopPropagation()));
    document.documentElement.appendChild(host);
    els = { wrap, card, controls, panel, live };
    lastLook = null;
    applyPosition();
  }

  // --- per-site preferences: minimized, and where the card sits ------------------

  async function loadPrefs() {
    try {
      const { floatCollapsed, floatPosition } = await chrome.storage.local.get(["floatCollapsed", "floatPosition"]);
      collapsed = Boolean(floatCollapsed && floatCollapsed[origin()]);
      const saved = floatPosition && floatPosition[origin()];
      position = {
        side: saved && saved.side === "right" ? "right" : "left",
        bottom: saved && Number.isFinite(saved.bottom) ? saved.bottom : EDGE,
      };
    } catch (err) {
      /* orphaned */
    }
  }

  async function savePref(key, value) {
    try {
      const stored = (await chrome.storage.local.get(key))[key] || {};
      const next = { ...stored };
      if (value == null) delete next[origin()];
      else next[origin()] = value;
      await chrome.storage.local.set({ [key]: next });
    } catch (err) {
      /* orphaned */
    }
  }

  function setCollapsed(value) {
    collapsed = value;
    if (value) closePanel({ restoreFocus: false });
    draw();
    savePref("floatCollapsed", value ? true : null);
    if (!value && els.card) els.card.focus();
  }

  // Kept on screen: a window made shorter since the spot was saved would
  // otherwise leave the card below the fold.
  function applyPosition() {
    if (!els.wrap) return;
    const height = els.card ? els.card.offsetHeight || 66 : 66;
    const maxBottom = Math.max(EDGE, window.innerHeight - height - 12);
    const bottom = Math.min(Math.max(12, position.bottom), maxBottom);
    els.wrap.style.bottom = `${bottom}px`;
    els.wrap.style.left = position.side === "left" ? `${EDGE}px` : "auto";
    els.wrap.style.right = position.side === "right" ? `${EDGE}px` : "auto";
    els.wrap.style.top = "auto";
    els.wrap.classList.toggle("right", position.side === "right");
    placePanel();
  }

  function swapSide() {
    position = { ...position, side: position.side === "left" ? "right" : "left" };
    applyPosition();
    savePref("floatPosition", position);
    announce(t(position.side === "left" ? "float.movedLeft" : "float.movedRight"));
  }

  // Drag anywhere up the left or right edge. A press that moves less than a
  // few pixels is still a click. On release the card snaps to the nearer
  // edge at the height it was dropped, remembered for this site.
  let suppressClick = false;

  function wireDrag(card, wrap) {
    let start = null;
    let dragging = false;

    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, id: e.pointerId };
      dragging = false;
      // Captured from the press, not from the threshold: a quick flick can
      // leave the card before its first move event, which then goes to the
      // page instead. A press that doesn't move is still a click.
      try {
        card.setPointerCapture(e.pointerId);
      } catch (err) {
        /* synthetic pointer */
      }
    });
    card.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragging = true;
        wrap.classList.add("dragging");
      }
      const rect = wrap.getBoundingClientRect();
      const left = Math.min(Math.max(8, start.left + dx), window.innerWidth - rect.width - 8);
      const top = Math.min(Math.max(8, start.top + dy), window.innerHeight - rect.height - 8);
      wrap.style.left = `${left}px`;
      wrap.style.right = "auto";
      wrap.style.top = `${top}px`;
      wrap.style.bottom = "auto";
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (dragging) {
        const rect = wrap.getBoundingClientRect();
        position = {
          side: rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right",
          bottom: Math.round(window.innerHeight - rect.bottom),
        };
        wrap.classList.remove("dragging");
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
        applyPosition();
        savePref("floatPosition", position);
      }
      start = null;
      dragging = false;
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  window.addEventListener("resize", () => {
    if (root) applyPosition();
  });

  // --- the compact card -----------------------------------------------------------

  // look: { kind, badge, badgeClass, spinner, primary, capitalize, secondary, title, busy, arrow, expands }
  function lookFor() {
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
    if (override === "loading") {
      return { kind: "loading", spinner: true, badgeClass: "muted", primary: t("float.loading"), secondary: "JobFit", busy: true };
    }
    const state = jobState || { kind: job ? "evaluate" : "none" };
    const noticeApplies = notice && (!notice.jobKey || (job && notice.jobKey === job.jobKey));
    if (noticeApplies && ["evaluate", "none", "starting"].includes(state.kind)) {
      return {
        kind: `notice:${notice.title}`,
        badge: "!",
        badgeClass: notice.tone === "red" ? "red" : "amber",
        primary: notice.title,
        secondary: t("float.detailsSub"),
        title: notice.title,
        arrow: true,
        expands: true,
      };
    }
    switch (state.kind) {
      case "starting":
        return { kind: "starting", spinner: true, primary: t("float.starting"), secondary: "JobFit", busy: true };
      case "queued":
        return {
          kind: `queued${state.position}`,
          spinner: true,
          primary: t("float.queued", { position: state.position }),
          secondary: t("float.queuedSub"),
          busy: !panelContent,
          expands: Boolean(panelContent),
        };
      case "scoring":
        return {
          kind: "scoring",
          spinner: true,
          primary: t("float.scoring"),
          secondary: t("float.scoringSub"),
          busy: !panelContent,
          expands: Boolean(panelContent),
        };
      case "reject":
        return {
          kind: `reject:${job.jobKey}`,
          badge: "✕",
          badgeClass: "red",
          primary: t("float.reject"),
          secondary: state.label || t("float.scoreSub"),
          title: t("float.titleSaved"),
          arrow: true,
          expands: true,
        };
      case "score": {
        const verdict = verdictLabel(state.verdict);
        return {
          kind: `score:${job.jobKey}:${state.score}`,
          badge: String(state.score),
          badgeClass: JOB_FIT_UI.scoreClass(state.score) || "red",
          primary: verdict || t("float.saved"),
          capitalize: Boolean(verdict),
          secondary: t("float.scoreSub"),
          title: t("float.titleSaved"),
          arrow: true,
          expands: true,
        };
      }
      case "none":
        return { kind: "none", badge: "JF", badgeClass: "mark", primary: "JobFit", secondary: "", busy: true };
      default:
        return {
          kind: `evaluate:${job && job.jobKey}`,
          badge: "JF",
          badgeClass: "mark",
          primary: t("float.evaluate"),
          secondary: t("float.evaluateSub"),
          title: t("float.title"),
          arrow: true,
        };
    }
  }

  let currentLook = null;

  function draw() {
    if (!mode) return;
    ensureRoot();
    const look = lookFor();
    currentLook = look;
    const { wrap, card, controls } = els;
    wrap.classList.toggle("collapsed", collapsed && !confirmingHide);
    wrap.classList.toggle("panel-open", panelOpen);

    card.textContent = "";
    card.classList.toggle("busy", Boolean(look.busy));
    const badge = el("span", `badge ${look.badgeClass || ""}`);
    badge.setAttribute("aria-hidden", "true");
    if (look.spinner) badge.appendChild(el("span", "spin"));
    else badge.textContent = look.badge;
    // The pop is for news — a score arriving, a new job — not every redraw.
    if (lastLook && lastLook !== look.kind && !look.spinner) badge.classList.add("pop");
    lastLook = look.kind;

    const text = el("span", "text");
    const primary = el("span", "primary");
    if (look.capitalize) primary.appendChild(el("span", "cap", look.primary));
    else primary.textContent = look.primary;
    text.appendChild(primary);
    if (look.secondary) text.appendChild(el("span", "secondary", look.secondary));
    card.appendChild(badge);
    card.appendChild(text);
    if (look.arrow) card.appendChild(el("span", "arrow", "›"));

    const isCollapsed = collapsed && !confirmingHide;
    const scoreWords = look.kind.startsWith("score:") ? `${look.badge}/100, ` : "";
    // "Hide on example.com?" already ends a sentence; don't add a period.
    const sep = /[.?!…:]$/.test(look.primary) ? " " : ". ";
    card.setAttribute(
      "aria-label",
      `JobFit: ${isCollapsed ? `${t("float.expand")} — ${scoreWords}${look.primary}` : `${scoreWords}${look.primary}${look.secondary ? `${sep}${look.secondary}` : ""}`}`
    );
    card.title = isCollapsed ? t("float.expand") : look.title || look.primary;
    if (look.expands && !isCollapsed) {
      card.setAttribute("aria-expanded", String(panelOpen));
      card.setAttribute("aria-controls", "jobfit-panel");
    } else {
      card.removeAttribute("aria-expanded");
      card.removeAttribute("aria-controls");
    }
    card.setAttribute("aria-disabled", String(Boolean(look.busy)));

    const close = controls.querySelector(".ctl.close");
    const closeLabel = mode === "site" ? t("float.hide") : t("float.dismiss");
    close.title = closeLabel;
    close.setAttribute("aria-label", closeLabel);
    close.classList.toggle("danger", confirmingHide);
    controls.classList.toggle("show", confirmingHide);
  }

  function announce(text) {
    if (!els.live || !text) return;
    els.live.textContent = "";
    setTimeout(() => {
      if (els.live) els.live.textContent = text;
    }, 60);
  }

  // --- what storage says about the job ---------------------------------------------

  async function deriveJobState() {
    if (!job) return null;
    const { queue } = await chrome.storage.local.get("queue");
    const active = ((queue && queue.items) || []).filter(
      (i) => i.kind !== "summarize" && (i.state === "pending" || i.state === "processing")
    );
    const mine = active.find((i) => i.jobKey === job.jobKey && i.profileId === job.profileId);
    if (mine) return mine.state === "processing" ? { kind: "scoring" } : { kind: "queued", position: active.indexOf(mine) + 1 };
    if (startingUntil > Date.now()) return { kind: "starting" };
    const record = await JOB_FIT_EVALSTORE.get(job.profileId, job.jobKey);
    if (record && record.hardReject) return { kind: "reject", label: record.hardReject.label, record };
    if (record && record.score != null) return { kind: "score", score: record.score, verdict: record.verdict, record };
    return { kind: "evaluate" };
  }

  async function refresh() {
    if (!mode) return;
    const mine = ++seq;
    try {
      const state = await deriveJobState();
      if (mine !== seq) return;
      const before = jobState;
      jobState = state;
      // A notice is about the job as it was; real progress replaces it.
      if (state && ["queued", "scoring", "score", "reject"].includes(state.kind)) notice = null;
      draw();
      // A score landing while you watch is news worth reading out.
      if (state && (state.kind === "score" || state.kind === "reject") && before && before.kind !== state.kind) {
        const text =
          state.kind === "score"
            ? t("float.announceScore", { score: state.score, verdict: verdictLabel(state.verdict) })
            : t("float.announceReject", { reason: state.label });
        if (text !== lastAnnounced) {
          lastAnnounced = text;
          announce(text);
        }
      }
    } catch (err) {
      detach(); // orphaned after an extension reload
    }
  }

  // --- the panel ------------------------------------------------------------------

  async function buildFromStorage(record) {
    const profile = await JOB_FIT_PROFILES.getActive();
    const currentModel = JOB_FIT_PROVIDER.currentModel(await chrome.storage.local.get(JOB_FIT_PROVIDER.KEYS));
    const content = resultFromRecord(record, {
      cached: true,
      profileName: profile.name,
      staleNote: staleNoteFor(record, profile, currentModel),
      duplicateNote: await duplicateNoteFor(record),
    });
    content.fromStorage = true;
    return content;
  }

  function actionButton(action, isPrimary) {
    const labels = {
      reevaluate: t("banner.reevaluate"),
      tracked: t("banner.trackedJobs"),
      evaluate: t("float.tryAgain"),
    };
    const button = el("button", isPrimary ? "primary" : "", labels[action]);
    button.type = "button";
    button.addEventListener("click", () => runAction(action));
    return button;
  }

  function renderPanel() {
    const { panel } = els;
    if (!panel || !panelContent) return;
    const c = panelContent;
    panel.textContent = "";

    const head = el("div", "p-head");
    const badge = el("span", `badge ${c.tone || "neutral"}`, c.badge || "!");
    badge.setAttribute("aria-hidden", "true");
    head.appendChild(badge);
    const titles = el("div", "p-titles");
    const title = el("h2", "p-title");
    title.id = "jobfit-panel-title";
    title.tabIndex = -1;
    if (c.score != null) title.appendChild(el("span", "sr", `${c.score}/100 `));
    title.appendChild(el("span", "cap", c.title));
    titles.appendChild(title);
    if (c.subtitle) titles.appendChild(el("div", "p-sub", c.subtitle));
    head.appendChild(titles);
    const close = el("button", "p-close", "×");
    close.type = "button";
    close.title = t("float.closePanel");
    close.setAttribute("aria-label", t("float.closePanel"));
    close.addEventListener("click", () => closePanel({ restoreFocus: true }));
    head.appendChild(close);
    panel.appendChild(head);

    const body = el("div", "p-body");
    if (c.summary) body.appendChild(el("p", "p-summary", c.summary));
    if (c.meta) body.appendChild(el("p", "p-meta", c.meta));
    if (c.notes && c.notes.length) {
      const notes = el("ul", "p-notes");
      notes.setAttribute("aria-label", t("banner.headsUp"));
      c.notes.forEach((n) => notes.appendChild(el("li", null, n)));
      body.appendChild(notes);
    }
    (c.sections || []).forEach((section) => {
      const details = el("details", "sec");
      details.open = Boolean(section.open);
      const summary = el("summary");
      const tone = el("span", `tone ${section.tone || ""}`);
      tone.setAttribute("aria-hidden", "true");
      summary.appendChild(tone);
      summary.appendChild(el("span", null, section.title));
      summary.appendChild(el("span", "count", String(section.items.length)));
      details.appendChild(summary);
      const list = el("ul");
      section.items.forEach((item) => list.appendChild(el("li", null, item)));
      details.appendChild(list);
      body.appendChild(details);
    });
    panel.appendChild(body);

    const actions = c.actions || [];
    if (actions.length) {
      const foot = el("div", "p-foot");
      // Re-evaluate leads only when the saved score is out of date.
      const primary = c.notes && c.notes.length && actions.includes("reevaluate") ? "reevaluate" : null;
      actions.forEach((a) => foot.appendChild(actionButton(a, a === primary || (a === "evaluate" && actions.length === 1))));
      panel.appendChild(foot);
    }
    placePanel();
  }

  // Upward from the card when there's room, downward when the card has been
  // dragged near the top; never taller than the space it has.
  function placePanel() {
    if (!els.wrap || !els.card) return;
    const rect = els.card.getBoundingClientRect();
    const above = rect.top - PANEL_GAP - 12;
    const below = window.innerHeight - rect.bottom - PANEL_GAP - 12;
    const openBelow = above < 280 && below > above;
    els.wrap.classList.toggle("below", openBelow);
    els.wrap.style.setProperty("--panel-max", `${Math.max(160, openBelow ? below : above)}px`);
  }

  function openPanel({ focus = false } = {}) {
    if (!panelContent || !els.panel) return;
    renderPanel();
    els.panel.hidden = false;
    panelOpen = true;
    draw();
    placePanel();
    if (focus) {
      const title = els.panel.querySelector(".p-title");
      if (title) title.focus();
    }
  }

  function closePanel({ restoreFocus = false } = {}) {
    if (!els.panel) return;
    els.panel.hidden = true;
    const wasOpen = panelOpen;
    panelOpen = false;
    draw();
    if (restoreFocus && wasOpen && els.card) els.card.focus();
  }

  // --- actions ----------------------------------------------------------------------

  function markStarting() {
    startingUntil = Date.now() + 4000;
    clearTimeout(startingTimer);
    // A saved result or a hard reject never enters the queue; stop saying
    // "Starting…" once the page has had time to answer.
    startingTimer = setTimeout(() => {
      startingUntil = 0;
      refresh();
    }, 4000);
    refresh();
  }

  function runAction(action) {
    if (action === "reevaluate" || action === "evaluate") {
      closePanel({ restoreFocus: true });
      notice = null;
      markStarting();
      send({ type: "JOB_FIT_EVALUATE_TAB", ignoreCache: action === "reevaluate" });
      return;
    }
    if (action === "tracked" && panelContent) {
      send({ type: "JOB_FIT_OPEN_HISTORY", profileId: panelContent.profileId, jobKey: panelContent.jobKey });
    }
  }

  async function onCardClick() {
    if (suppressClick) return;
    if (confirmingHide) {
      cancelHide();
      return;
    }
    if (collapsed) {
      setCollapsed(false);
      return;
    }
    const look = currentLook || lookFor();
    if (look.expands) {
      if (panelOpen) {
        closePanel();
        return;
      }
      const state = jobState;
      const needsBuild =
        !panelContent || (job && panelContent.jobKey !== job.jobKey) || (state && state.record && panelContent.kind !== "result");
      if (needsBuild && state && state.record) panelContent = await buildFromStorage(state.record);
      openPanel({ focus: true });
      return;
    }
    if (look.busy || !job) return;
    // Always the same path as the shortcut: the worker injects the page
    // scripts and content.js decides.
    markStarting();
    send({ type: "JOB_FIT_EVALUATE_TAB" });
  }

  // The site's button (site mode) asks first, like deleting a tracked job:
  // the first click asks, the second turns the button off for the site and
  // gives the permission back. On a page the card only visited, × just
  // dismisses it.
  function onCloseClick() {
    if (mode !== "site") {
      detach();
      return;
    }
    if (!confirmingHide) {
      confirmingHide = true;
      closePanel();
      draw();
      announce(t("float.hideConfirm", { site: siteName() }));
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(cancelHide, HIDE_CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer);
    confirmingHide = false;
    const scope = siteScope;
    detach();
    if (scope && scope.board) send({ type: "JOB_FIT_FLOAT_BOARD", boards: [scope.board], enabled: false });
    else send({ type: "JOB_FIT_FLOAT_SITE", origin: origin(), enabled: false });
  }

  function cancelHide() {
    clearTimeout(confirmTimer);
    if (!confirmingHide) return;
    confirmingHide = false;
    draw();
  }

  function onKeydown(e) {
    if (e.key !== "Escape") return;
    if (confirmingHide) {
      e.stopPropagation();
      cancelHide();
    } else if (panelOpen) {
      e.stopPropagation();
      closePanel({ restoreFocus: true });
    }
  }

  // --- public ---------------------------------------------------------------------

  // "page" never downgrades "site": the button being on is the stronger fact.
  // In site mode, `scope` says whether a whole job board is why it's here.
  async function attach(nextMode, scope = null) {
    if (mode === "site" && nextMode === "page") return;
    const wasAttached = Boolean(mode);
    mode = nextMode;
    if (nextMode === "site") siteScope = scope;
    if (!wasAttached) {
      await loadPrefs();
      pageHref = location.href;
    }
    draw();
  }

  function detach() {
    const host = root && root.host;
    const wrap = els.wrap;
    root = null;
    els = {};
    mode = null;
    siteScope = null;
    job = null;
    jobState = null;
    override = null;
    notice = null;
    panelContent = null;
    panelOpen = false;
    confirmingHide = false;
    lastLook = null;
    if (!host) return;
    if (wrap && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wrap.classList.add("leaving");
      setTimeout(() => host.remove(), 200);
    } else {
      host.remove();
    }
  }

  function sameJob(a, b) {
    return Boolean(a && b && a.jobKey === b.jobKey && a.profileId === b.profileId);
  }

  function setJob(next) {
    override = null;
    if (!sameJob(job, next)) {
      if (panelOpen) closePanel();
      panelContent = null;
      notice = null;
      jobState = null;
      startingUntil = 0;
    }
    job = next ? { jobKey: next.jobKey, profileId: next.profileId, title: next.title, company: next.company } : null;
    pageHref = location.href;
    refresh();
  }

  function setLoading() {
    override = "loading";
    draw();
  }

  // An evaluation just started for this job (from anywhere): the card says so
  // at once, where its answer will appear.
  async function starting(next) {
    await attach(mode || "page");
    if (next) setJob(next);
    notice = null;
    markStarting();
  }

  // A result someone asked for: shown in the panel, opened unless the card is
  // minimized. Focus stays where it is — this can arrive minutes later — and
  // the score is read out instead.
  async function showResult(result, { open = true } = {}) {
    await attach(mode || "page");
    if (result.jobKey) setJob({ jobKey: result.jobKey, profileId: result.profileId });
    startingUntil = 0;
    notice = null;
    panelContent = result;
    if (open && !collapsed) openPanel();
    else if (panelOpen) renderPanel();
    if (result.announce && result.announce !== lastAnnounced) {
      lastAnnounced = result.announce;
      announce(result.announce);
    }
    refresh();
  }

  // Something the page needs to hear that isn't a score: no posting found,
  // the queue is full, an error — or, quietly, where the job is in the queue.
  // Amber and red notices take over the card; a neutral one only fills the
  // panel for whoever opens it.
  async function showNotice(n, { open } = {}) {
    await attach(mode || "page");
    if (n.jobKey) setJob({ jobKey: n.jobKey, profileId: n.profileId });
    startingUntil = 0;
    const loud = n.tone === "amber" || n.tone === "red";
    const content = { kind: "notice", badge: loud ? "!" : "…", tone: loud ? n.tone : "neutral", ...n };
    panelContent = content;
    if (loud) notice = { jobKey: n.jobKey || null, title: n.title, tone: n.tone };
    const shouldOpen = open === undefined ? loud : open;
    if (shouldOpen && !collapsed) openPanel();
    else if (panelOpen) renderPanel();
    if (loud) announce(`${n.title}. ${n.summary || ""}`);
    draw();
    refresh();
  }

  Object.assign(api, { attach, detach, setJob, setLoading, starting, showResult, showNotice, refresh });
  window.__jobFitCard = api;
  window.JOB_FIT_CARD = api;

  // Calls relayed from a frame on this page (see the top of the file).
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "JOB_FIT_CARD_CALL" || !RELAYED.includes(message.method)) return;
      JOB_FIT_I18N.load().then(() => api[message.method](...(message.args || [])));
    });
  } catch (err) {
    /* orphaned */
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !mode) return;
      if (changes.floatCollapsed || changes.floatPosition) {
        loadPrefs().then(() => {
          applyPosition();
          draw();
        });
      }
      if (changes.activeProfileId && job) {
        // Scores are per profile: the panel was about the other one.
        closePanel();
        panelContent = null;
        job = { ...job, profileId: changes.activeProfileId.newValue };
      }
      if (changes[JOB_FIT_I18N.STORAGE_KEY]) {
        JOB_FIT_I18N.load().then(() => {
          closePanel();
          panelContent = null;
          if (els.controls) {
            els.controls.querySelector(".ctl.min").setAttribute("aria-label", t("float.minimize"));
            els.controls.querySelector(".ctl.min").title = t("float.minimize");
            els.controls.querySelector(".ctl.swap").setAttribute("aria-label", t("float.moveSide"));
            els.controls.querySelector(".ctl.swap").title = t("float.moveSide");
          }
          draw();
        });
      }
      const recordKey = job ? JOB_FIT_EVALSTORE.recordKey(job.profileId, job.jobKey) : null;
      // An open panel showing this job's saved result follows the record —
      // only when the record itself changes, so a queue tick doesn't redraw
      // it and fold up a section someone just opened.
      if (recordKey && changes[recordKey] && changes[recordKey].newValue && panelOpen && panelContent && panelContent.fromStorage) {
        buildFromStorage(changes[recordKey].newValue).then((content) => {
          panelContent = content;
          renderPanel();
        });
      }
      if (changes.queue || changes.activeProfileId || (recordKey && changes[recordKey])) refresh();
    });
  } catch (err) {
    /* orphaned */
  }

  // On a page the card only visited, it belongs to the job it was opened for:
  // when a single-page board moves on to another job, the card goes.
  setInterval(() => {
    if (mode === "page" && pageHref && location.href !== pageHref) detach();
  }, 700);
})();
