(() => {
  // MV3 service workers go idle after ~30s. Waking one via sendMessage can
  // lose a race the first time (message dispatched before its listener is
  // registered), throwing "Receiving end does not exist" even though a
  // manual retry would succeed immediately after. Retry transparently
  // instead of surfacing that as a real error.
  async function sendMessageWithRetry(message, retries = 2, delayMs = 250) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await chrome.runtime.sendMessage(message);
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // Takes a keyword config (ticked categories + phrases + raw patterns),
  // compiles it, and carries each entry's human label alongside the regex so
  // the UI can name the rule that fired without ever showing a pattern.
  function compileConfig(config, kind) {
    return JOB_FIT_KEYWORDS.compile(config, kind)
      .map((entry) => {
        try {
          return { ...entry, re: new RegExp(entry.source, "i") };
        } catch (e) {
          console.warn(`[Job Fit Evaluator] invalid keyword pattern skipped: ${entry.source}`, e);
          return null;
        }
      })
      .filter(Boolean);
  }

  // Shows the words the POSTING actually used, not the pattern that matched
  // them. Trying to prettify a regex into prose never worked — stripping
  // backslashes left things like "master'?s degree (is )?required" and
  // "graduat(ing|ion) (date )?(between|in) (20\d\d)" on screen — and the
  // matched text is the more useful thing anyway: it says what tripped the
  // flag rather than what the rule looks like.
  const MAX_LABEL_CHARS = 80;

  function matchedLabels(patterns, text) {
    const seen = new Set();
    const labels = [];

    patterns.forEach((item) => {
      const m = text.match(item.re);
      if (!m) return;
      const label = cleanMatch(m[0]);
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      labels.push(label);
    });

    return labels;
  }

  // Matched text comes straight out of the posting, so it can carry newlines
  // from textFrom's block boundaries, and a loose pattern can match a long
  // span.
  function cleanMatch(raw) {
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…` : collapsed;
  }

  // The pattern is still worth showing for a hard reject — it's the thing
  // you'd go and edit — but labelled as a rule rather than presented as prose.
  function describeHardReject(hardReject) {
    return `"${cleanMatch(hardReject.matchedText)}" — ${hardReject.label}`;
  }

  function dispatchExtraction() {
    const host = location.hostname;
    let result = null;
    let extractorName = "generic";

    // No host check on Greenhouse: as well as greenhouse.io itself, its board
    // is embedded by company career sites on their own domain, so the
    // extractor has to get a look regardless of hostname. It returns null
    // quickly when its selectors aren't present.
    if (window.__jobFit && window.__jobFit.greenhouse) {
      result = window.__jobFit.greenhouse();
      if (result) extractorName = "greenhouse";
    }

    if (!result && host.includes("linkedin.com") && window.__jobFit && window.__jobFit.linkedin) {
      result = window.__jobFit.linkedin();
      if (result) extractorName = "linkedin";
    }

    if (!result && window.__jobFit && window.__jobFit.generic) {
      result = window.__jobFit.generic();
      extractorName = "generic";
    }

    return { result, extractorName };
  }

  function runLayer1(text, hardRejects) {
    for (const item of hardRejects) {
      const m = text.match(item.re);
      // label is the category name ("US citizenship or permanent residency")
      // or the user's own phrase — never the underlying pattern.
      if (m) return { hardReject: { label: item.label, matchedText: m[0] } };
    }
    return { hardReject: null };
  }

  function removeExistingBanner() {
    document.getElementById("job-fit-banner")?.remove();
    document.getElementById("job-fit-details")?.remove();
  }

  // Sites built on Radix UI (e.g. my.greenhouse.io's candidate portal) treat
  // any click outside the dialog's own DOM subtree as a "dismiss" signal.
  // Our banner/details live in document.body, so without this they'd close
  // the job dialog every time you clicked Evaluate/Details/Dismiss.
  function stopOutsideClickDetection(el) {
    ["pointerdown", "mousedown", "click"].forEach((evt) =>
      el.addEventListener(evt, (e) => e.stopPropagation())
    );
  }

  function renderDetailsPanel(sections) {
    const existing = document.getElementById("job-fit-details");
    if (existing) {
      existing.remove();
      return;
    }

    const panel = document.createElement("div");
    panel.id = "job-fit-details";
    stopOutsideClickDetection(panel);

    // The stylesheet's 48px offset is a magic number that never matched: the
    // banner measures 50px, so the panel's first rows sat under it on every
    // render, not just in some edge case. The banner's height comes from its
    // padding and button sizing (the summary is nowrap + ellipsis, so it never
    // wraps), which means any later change to either would silently widen the
    // gap again. Measure it instead of guessing.
    const banner = document.getElementById("job-fit-banner");
    if (banner) panel.style.top = `${Math.round(banner.getBoundingClientRect().height)}px`;

    sections.forEach(({ title, items, tagClass }) => {
      if (!items || items.length === 0) return;
      const h = document.createElement("h4");
      h.textContent = title;
      panel.appendChild(h);
      items.forEach((text) => {
        const tag = document.createElement("span");
        tag.className = `jf-tag ${tagClass}`;
        tag.textContent = text;
        panel.appendChild(tag);
      });
    });

    document.body.appendChild(panel);
  }

  function renderBanner({ status, label, summary, sections, extraActions, score }) {
    removeExistingBanner();

    const banner = document.createElement("div");
    banner.id = "job-fit-banner";
    banner.className = `jf-${status}`;
    stopOutsideClickDetection(banner);

    const main = document.createElement("div");
    main.className = "jf-main";

    if (score != null) {
      const scoreEl = document.createElement("span");
      scoreEl.className = `jf-score ${statusForScore(score)}`;
      scoreEl.textContent = String(score);
      main.appendChild(scoreEl);
    }

    const labelEl = document.createElement("span");
    labelEl.className = "jf-label";
    labelEl.textContent = label;

    const summaryEl = document.createElement("span");
    summaryEl.className = "jf-summary";
    summaryEl.textContent = summary;

    main.appendChild(labelEl);
    main.appendChild(summaryEl);

    const actions = document.createElement("div");
    actions.className = "jf-actions";

    // The banner line is single-line with an ellipsis, so a long one_line
    // (or a long error message) gets cut off. Lead the Details panel with
    // the full text so it's always readable somewhere.
    const detailSections = [
      summary ? { title: "Summary", items: [summary], tagClass: "jf-tag-neutral" } : null,
      ...(sections || []),
    ].filter(Boolean);

    if (detailSections.length) {
      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.textContent = "Details";
      detailsBtn.addEventListener("click", () => renderDetailsPanel(detailSections));
      actions.appendChild(detailsBtn);
    }

    (extraActions || []).forEach(({ label: btnLabel, onClick }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = btnLabel;
      btn.addEventListener("click", onClick);
      actions.appendChild(btn);
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", removeExistingBanner);
    actions.appendChild(dismissBtn);

    banner.appendChild(main);
    banner.appendChild(actions);

    document.body.appendChild(banner);
  }

  function statusForScore(score) {
    if (score >= 75) return "green";
    if (score >= 55) return "amber";
    return "red";
  }

  // A genuine embedded board: hosted on greenhouse.io AND served from an embed
  // path. Substring matching the whole src is what produced the false positive
  // described above.
  function findEmbeddedBoardFrame() {
    return Array.from(document.querySelectorAll("iframe[src]")).find((frame) => {
      try {
        const url = new URL(frame.src, location.href);
        return url.hostname.endsWith("greenhouse.io") && url.pathname.includes("/embed/");
      } catch (err) {
        return false;
      }
    });
  }

  function timeAgo(ts) {
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? "a month ago" : `${months} months ago`;
  }

  // Single renderer for both a fresh evaluation and one read back out of
  // history, so the two can't drift into showing different things.
  function openInTrackedJobs(record) {
    // Content scripts can't open tabs, so the worker does it — and it carries
    // the job key so the page can scroll to and expand that record rather than
    // dropping you at the top of a long list.
    sendMessageWithRetry({
      type: "JOB_FIT_OPEN_HISTORY",
      profileId: record.profileId,
      jobKey: record.jobKey,
    }).catch(() => {});
  }

  function renderResult(record, { cached, profileName, onReevaluate, saveError }) {
    const warnings = [];
    if (saveError) warnings.push(`Result shown but NOT saved to history: ${saveError}`);
    if (record.evaluation && record.evaluation.input_truncated) {
      warnings.push(
        "This posting was too long to send in full — the middle was omitted. The start and end (where requirements and comp usually are) were included."
      );
    }
    const warningSection = warnings.length
      ? [{ title: "Heads up", items: warnings, tagClass: "jf-tag-amber" }]
      : [];

    const prefix = cached ? `[saved · evaluated ${timeAgo(record.lastEvaluatedAt)}] ` : "";
    const extraActions = [
      ...(cached ? [{ label: "Re-evaluate", onClick: onReevaluate }] : []),
      ...(record.jobKey ? [{ label: "Tracked jobs", onClick: () => openInTrackedJobs(record) }] : []),
    ];

    if (record.hardReject) {
      renderBanner({
        status: "red",
        label: "✕ Reject",
        summary: `${prefix}Hard reject: "${cleanMatch(record.hardReject.matchedText)}"`,
        sections: [
          ...warningSection,
          { title: "Evaluated as", items: [profileName], tagClass: "jf-tag-neutral" },
          {
            title: "Reject reason",
            items: [describeHardReject(record.hardReject)],
            tagClass: "jf-tag-red",
          },
        ],
        extraActions,
      });
      return;
    }

    const e = record.evaluation || {};
    const salaryItems = e.salary
      ? [
          `Posting: ${e.salary.posting_stated}`,
          `Market estimate: ${e.salary.estimated_market_range}`,
          `vs. your expectation: ${e.salary.vs_candidate_expectation}`,
          e.salary.note,
        ].filter(Boolean)
      : [];

    renderBanner({
      status: statusForScore(e.score),
      score: e.score,
      label: e.verdict || "",
      summary: prefix + (e.one_line || ""),
      sections: [
        ...warningSection,
        { title: "Evaluated as", items: [profileName], tagClass: "jf-tag-neutral" },
        { title: "Matches", items: e.matches, tagClass: "jf-tag-green" },
        { title: "Gaps", items: e.gaps, tagClass: "jf-tag-amber" },
        { title: "Required gaps", items: e.required_gaps, tagClass: "jf-tag-red" },
        { title: "Seniority/comp check", items: e.seniority_flag ? [e.seniority_flag] : [], tagClass: "jf-tag-red" },
        {
          title: "Score cap applied",
          items: (e.score_cap_reasons || []).map((reason) =>
            e.raw_score != null ? `${reason} (model scored ${e.raw_score}, capped to ${e.score})` : reason
          ),
          tagClass: "jf-tag-amber",
        },
        {
          title: "Warnings — worth asking about, not automatic rejects",
          items: record.softWarnings,
          tagClass: "jf-tag-amber",
        },
        {
          title: "Domain flags detected (keyword scan, independent of the model)",
          items: record.domainFlags,
          tagClass: "jf-tag-neutral",
        },
        { title: "Salary", items: salaryItems, tagClass: "jf-tag-neutral" },
      ],
      extraActions,
    });
  }

  // The rendered result must not depend on the storage write succeeding: a
  // throw here used to reject run() and leave the banner stuck on "scoring
  // with local model..." forever, discarding a generation that had just taken
  // several minutes. Save if we can, show it either way.
  async function saveAndRender(pending, profileName) {
    let record = pending;
    let saveError = null;
    try {
      record = await JOB_FIT_EVALSTORE.saveEvaluation(pending);
    } catch (err) {
      saveError = err && err.message ? err.message : String(err);
      console.error("[Job Fit Evaluator] could not write history record", err);
    }
    renderResult(record, { cached: false, profileName, saveError });
  }

  async function run({ ignoreCache } = {}) {
    // Logged on every run so it's immediately visible whether the injection
    // reached the iframe: a page with an embedded board should produce two of
    // these, the second with framed=true on a greenhouse.io host.
    console.log(`[Job Fit Evaluator] running on ${location.hostname} (framed=${window !== window.top})`);

    const { result, extractorName } = dispatchExtraction();

    // On the top frame of a page that EMBEDS a Greenhouse board, the posting is
    // never in this document, so hand off to the iframe. Two conditions, and
    // neither alone was enough:
    //
    // Defer only when this document produced no site-specific extraction. A
    // real Greenhouse board is read by the greenhouse extractor right here, and
    // deferring away from a page that can read itself is never right.
    //
    // And identify the board by the iframe's HOST, not by a substring of its
    // URL. A real board page loads a Google API proxy iframe whose hash carries
    // "#parent=https%3A%2F%2Fjob-boards.greenhouse.io" — only :// is encoded, so
    // the hostname sits there in plain text and matched src*="greenhouse.io".
    // The board then deferred to a Google RPC shim and evaluated nothing.
    if (window === window.top && (!result || extractorName === "generic") && findEmbeddedBoardFrame()) {
      console.log("[Job Fit Evaluator] posting lives in an embedded Greenhouse iframe — deferring to it");
      return;
    }

    if (!result) {
      if (window !== window.top) return;
      console.log(`[Job Fit Evaluator] extraction failed on ${location.hostname} (no usable text found)`);
      renderBanner({
        status: "amber",
        label: "⚠ No text",
        summary: "Couldn't extract job posting text on this page.",
        sections: [],
      });
      return;
    }

    const jobKey = JOB_FIT_JOBKEY.keyFor(result);
    console.log(
      `[Job Fit Evaluator] extractor=${extractorName} jobKey=${jobKey} title="${result.title}" company="${result.company}" location="${result.location}" chars=${result.text.length}`
    );

    // Everything below comes from ONE read of the active profile. The service
    // worker used to re-read the salary expectations from storage on its own,
    // which meant switching profiles mid-evaluation could score a posting
    // against one profile's keywords and another's salary. It's all passed
    // through in the message now instead.
    const activeProfile = await JOB_FIT_PROFILES.getActive();
    const fingerprint = JOB_FIT_PROFILES.fingerprint(activeProfile);

    const settings = await chrome.storage.local.get("lmStudio");
    const currentModel = (settings.lmStudio && settings.lmStudio.model) || "";

    const cached = ignoreCache ? null : await JOB_FIT_EVALSTORE.get(activeProfile.id, jobKey);
    if (cached) {
      // A cached result is only valid for the profile AND the model that
      // produced it. Profile: if the CV, keyword lists or salary expectations
      // changed, re-run rather than showing a score those edits would change.
      // Model: scores from different models aren't comparable, and the history
      // page ranks by score — a cached number from a model you've since
      // swapped out would sit in that ranking pretending to belong.
      const profileChanged = cached.profileFingerprint !== fingerprint;
      const modelChanged = (cached.model || "") !== currentModel;

      if (!profileChanged && !modelChanged) {
        renderResult(cached, {
          cached: true,
          profileName: activeProfile.name,
          onReevaluate: () => start({ ignoreCache: true }),
        });
        return;
      }
      console.log(
        `[Job Fit Evaluator] cached result is stale (${profileChanged ? "profile" : ""}${
          profileChanged && modelChanged ? " and " : ""
        }${modelChanged ? "model" : ""} changed since) — re-evaluating`
      );
    }

    const baseRecord = {
      jobKey,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      url: location.href,
      title: result.title,
      company: result.company,
      location: result.location,
      text: result.text,
      extractor: extractorName,
      profileFingerprint: fingerprint,
    };

    const hardRejects = compileConfig(activeProfile.keywords.hardRejects, "hardRejects");
    const layer1 = runLayer1(result.text, hardRejects);

    if (layer1.hardReject) {
      // Stored like any other result, and deliberately so: without it you'd
      // re-screen the same dead posting every time you came across it. Score 0
      // keeps it sortable and parks it at the bottom of the history page.
      await saveAndRender(
        {
          ...baseRecord,
          hardReject: layer1.hardReject,
          evaluation: null,
          score: 0,
          verdict: "hard reject",
          domainFlags: [],
          softWarnings: [],
        },
        activeProfile.name
      );
      return;
    }

    const domainFlagMatches = matchedLabels(
      compileConfig(activeProfile.keywords.domainFlags, "domainFlags"),
      result.text
    );
    const softWarningMatches = matchedLabels(
      compileConfig(activeProfile.keywords.softWarnings, "softWarnings"),
      result.text
    );

    const flagNotes = [
      domainFlagMatches.length ? `domain flags: ${domainFlagMatches.join(", ")}` : null,
      softWarningMatches.length ? `warnings: ${softWarningMatches.join(", ")}` : null,
    ].filter(Boolean);

    // Handed to the service worker rather than run from here. Everything the
    // model needs is captured NOW — the posting text and a snapshot of the
    // profile — because by the time the queue reaches this item the tab will
    // very likely be showing a different job, or be gone.
    let response;
    try {
      response = await sendMessageWithRetry({
        type: "JOB_FIT_ENQUEUE",
        item: {
          kind: "evaluate",
          jobKey,
          profileId: activeProfile.id,
          profileName: activeProfile.name,
          profileSnapshot: {
            profile: activeProfile.profile,
            expectedSalary: activeProfile.expectedSalary,
            fingerprint,
          },
          postingText: result.text,
          title: result.title,
          company: result.company,
          location: result.location,
          url: location.href,
          extractor: extractorName,
          domainFlags: domainFlagMatches,
          softWarnings: softWarningMatches,
        },
      });
    } catch (err) {
      renderBanner({
        status: "amber",
        label: "⚠ Error",
        summary: `Could not reach the extension's background service: ${err.message}`,
        sections: [],
      });
      return;
    }

    if (!response || !response.ok) {
      renderBanner({
        status: "amber",
        label: "⚠ Queue full",
        summary:
          response && response.full
            ? `The queue already holds ${response.max} jobs. Let some finish, or clear them on the tracked-jobs page.`
            : (response && response.error) || "Could not queue this posting.",
        sections: [],
      });
      return;
    }

    const flagSuffix = flagNotes.length ? ` — ${flagNotes.join(" · ")}` : "";
    const queueNote =
      response.position <= 1
        ? "sending to the local model now"
        : `queued — ${ordinal(response.position)} in line of ${response.total}`;

    renderBanner({
      status: "neutral",
      label: "…",
      summary: response.duplicate
        ? `[${activeProfile.name}] Already queued — ${ordinal(response.position)} in line`
        : `[${activeProfile.name}] Passed Layer 1${flagSuffix} — ${queueNote}`,
      sections: [],
    });
  }

  function ordinal(n) {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
    return `${n}${suffix}`;
  }

  // Backstop so no unexpected throw — a storage read, a malformed stored
  // record, an extractor blowing up on odd markup — can leave the banner
  // stuck mid-progress with no explanation.
  //
  // Also the single-flight guard. The popup's Evaluate button has had one
  // since a double-click there fired two generations at once; Re-evaluate sits
  // in the banner for minutes while a model runs and is far easier to click
  // twice, and LM Studio serving two requests at once roughly halves the
  // throughput of both.
  let inFlight = false;

  function start(options) {
    if (inFlight) return;
    inFlight = true;
    run(options)
      .catch((err) => {
        console.error("[Job Fit Evaluator] evaluation failed", err);
        renderBanner({
          status: "amber",
          label: "⚠ Error",
          summary: `Something went wrong: ${err && err.message ? err.message : String(err)}`,
          sections: [],
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }

  // Installed once per page. content.js is re-injected on every click, and a
  // second listener in the same isolated world would repaint the banner twice.
  if (!window.__jobFit.resultListenerInstalled) {
    window.__jobFit.resultListenerInstalled = true;

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "JOB_FIT_RESULT") return;

      // Re-derived from the live DOM, not remembered from enqueue time. On a
      // single-page app the tab id stays the same while you click through
      // jobs and this script is never re-injected, so a remembered key would
      // still say "job A" while the page shows job B — and we would paint A's
      // score over B.
      const current = dispatchExtraction();
      if (!current.result) return;
      if (JOB_FIT_JOBKEY.keyFor(current.result) !== message.jobKey) return;

      renderResult(message.record, { cached: false, profileName: message.profileName });
    });
  }

  start();
})();
