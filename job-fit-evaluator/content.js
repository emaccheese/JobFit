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

  // Screening helpers are shared with the service worker's queue (screening.js).
  const { cleanMatch } = JOB_FIT_SCREEN;
  const t = JOB_FIT_I18N.t;

  // The pattern is still worth showing for a hard reject — it's the thing
  // you'd go and edit — but labelled as a rule rather than presented as prose.
  function describeHardReject(hardReject) {
    return `"${cleanMatch(hardReject.matchedText)}" — ${hardReject.label}`;
  }

  function verdictLabel(verdict) {
    return verdict && JOB_FIT_I18N.has(`verdict.${verdict}`) ? t(`verdict.${verdict}`) : verdict || "";
  }

  // --- JSON-LD probe -------------------------------------------------------
  //
  // Measures only. Changes nothing about extraction, and exists to answer one
  // question from real browsing rather than assumption: on the sites you
  // actually visit, would schema.org/JobPosting have told us anything the
  // extractor missed? Greenhouse emits none at all, so the premise needed
  // testing before any of it was built on.

  function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function isJobPosting(node) {
    return node && typeof node === "object" && asArray(node["@type"]).some((t) => String(t).includes("JobPosting"));
  }

  // A page may carry several blocks, each of which may be a bare object, an
  // array, or a @graph wrapper.
  function findJobPostingNodes() {
    const nodes = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch (err) {
        return;
      }
      asArray(parsed).forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        asArray(entry["@graph"]).concat([entry]).forEach((node) => {
          if (isJobPosting(node)) nodes.push(node);
        });
      });
    });
    return nodes;
  }

  function jsonLdFields(node) {
    const org = node.hiringOrganization;
    const location = asArray(node.jobLocation)[0];
    const address = location && location.address;
    const salary = node.baseSalary;
    const salaryValue = salary && salary.value;
    return {
      title: Boolean(node.title),
      company: Boolean(org && (typeof org === "string" ? org : org.name)),
      location: Boolean(
        (address && (address.addressLocality || address.addressRegion || address.addressCountry)) ||
          node.jobLocationType
      ),
      // Jibe emits a 0–0 placeholder even when the posting states a range.
      salary: Boolean(salaryValue && (salaryValue.minValue > 0 || salaryValue.maxValue > 0)),
      description: Boolean(node.description),
    };
  }

  function probeJsonLd(result, extractorName) {
    try {
      const nodes = findJobPostingNodes();
      const fields = nodes.length ? jsonLdFields(nodes[0]) : null;
      // The extractor never reads salary — the model does — so JSON-LD salary
      // is always an addition, and is counted separately from the fields the
      // extractor merely failed to find.
      const domHad = {
        title: Boolean(result && result.title),
        company: Boolean(result && result.company),
        location: Boolean(result && result.location),
      };
      const wouldAdd = fields
        ? ["title", "company", "location"].filter((k) => fields[k] && !domHad[k]).concat(fields.salary ? ["salary"] : [])
        : [];

      sendMessageWithRetry({
        type: "JOB_FIT_PROBE",
        probe: { host: location.hostname, extractor: extractorName, found: nodes.length > 0, fields, domHad, wouldAdd },
      }).catch(() => {});
    } catch (err) {
      /* a measurement must never affect the thing it measures */
    }
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

    if (!result && host.includes("indeed.") && window.__jobFit && window.__jobFit.indeed) {
      result = window.__jobFit.indeed();
      if (result) extractorName = "indeed";
    }

    if (!result && window.__jobFit && window.__jobFit.workday) {
      result = window.__jobFit.workday();
      if (result) extractorName = "workday";
    }

    if (!result && window.__jobFit && window.__jobFit.jibe) {
      result = window.__jobFit.jibe();
      if (result) extractorName = "jibe";
    }

    // No host check, like Jibe: Eightfold runs companies' career sites on
    // their own domains. It returns null at once without Eightfold's app root.
    if (!result && window.__jobFit && window.__jobFit.eightfold) {
      result = window.__jobFit.eightfold();
      if (result) extractorName = "eightfold";
    }

    if (!result && window.__jobFit && window.__jobFit.generic) {
      result = window.__jobFit.generic();
      extractorName = "generic";
    }

    return { result, extractorName };
  }

  // The posting's location from its schema.org JobPosting, for sites whose
  // extractor finds none (Greenhouse boards, the generic fallback) — the
  // country is what makes screening per country.
  function jsonLdLocation() {
    const node = findJobPostingNodes()[0];
    if (!node) return null;
    const remote = asArray(node.jobLocationType).some((t) => /telecommute/i.test(String(t)));
    const address = asArray(node.jobLocation).map((l) => l && l.address).find(Boolean);
    const country = address && address.addressCountry;
    const parts = address
      ? [address.addressLocality, address.addressRegion, typeof country === "object" && country ? country.name : country]
      : [];
    const text = parts.filter((p) => typeof p === "string" && p.trim()).join(", ");
    if (!text && !remote) return null;
    return [text, remote ? "Remote" : null].filter(Boolean).join(" · ");
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
      summary ? { title: t("banner.summary"), items: [summary], tagClass: "jf-tag-neutral" } : null,
      ...(sections || []),
    ].filter(Boolean);

    if (detailSections.length) {
      const detailsBtn = document.createElement("button");
      detailsBtn.type = "button";
      detailsBtn.textContent = t("banner.details");
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
    dismissBtn.textContent = t("banner.dismiss");
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
    const rtf = new Intl.RelativeTimeFormat(JOB_FIT_I18N.locale(), { numeric: "auto" });
    if (days < 30) return rtf.format(-days, "day");
    return rtf.format(-Math.floor(days / 30), "month");
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

  // The job this banner is currently showing, so a late duplicate check can't
  // paint its warning onto a different job's banner.
  let bannerJobKey = null;

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

  function renderResult(record, options) {
    const { cached, profileName, onReevaluate, saveError, staleNote, duplicateNote } = options;
    bannerJobKey = record.jobKey;
    // Checked after the banner is up rather than before, so a slow storage
    // read never delays the result; redrawn with the note if there is one.
    if (duplicateNote === undefined) {
      duplicateNoteFor(record).then((note) => {
        if (note && bannerJobKey === record.jobKey) renderResult(record, { ...options, duplicateNote: note });
      });
    }
    const warnings = [];
    if (duplicateNote) warnings.push(duplicateNote);
    if (staleNote) warnings.push(staleNote);
    if (saveError) warnings.push(t("banner.notSaved", { error: saveError }));
    if (record.evaluation && record.evaluation.input_truncated) {
      warnings.push(t("banner.truncated"));
    }
    const warningSection = warnings.length
      ? [{ title: t("banner.headsUp"), items: warnings, tagClass: "jf-tag-amber" }]
      : [];

    const prefix = cached ? `[${t("banner.savedPrefix", { when: timeAgo(record.lastEvaluatedAt) })}] ` : "";
    const extraActions = [
      ...(cached ? [{ label: t("banner.reevaluate"), onClick: onReevaluate }] : []),
      ...(record.jobKey ? [{ label: t("banner.trackedJobs"), onClick: () => openInTrackedJobs(record) }] : []),
    ];

    if (record.hardReject) {
      renderBanner({
        status: "red",
        label: `✕ ${t("banner.reject")}`,
        summary: `${prefix}${t("banner.hardRejectSummary", { match: cleanMatch(record.hardReject.matchedText) })}`,
        sections: [
          ...warningSection,
          { title: t("banner.evaluatedAs"), items: [profileName], tagClass: "jf-tag-neutral" },
          {
            title: t("banner.rejectReason"),
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
          `${t("result.salaryPosting")}: ${e.salary.posting_stated}`,
          `${t("result.salaryMarket")}: ${e.salary.estimated_market_range}`,
          `${t("result.salaryVs")}: ${JOB_FIT_EVALSTORE.salaryVerdictLabel(e.salary.vs_candidate_expectation)}`,
          e.salary.note,
        ].filter(Boolean)
      : [];

    renderBanner({
      status: statusForScore(e.score),
      score: e.score,
      label: verdictLabel(e.verdict),
      summary: prefix + (e.one_line || ""),
      sections: [
        ...warningSection,
        { title: t("banner.evaluatedAs"), items: [profileName], tagClass: "jf-tag-neutral" },
        { title: t("result.matches"), items: e.matches, tagClass: "jf-tag-green" },
        { title: t("result.gaps"), items: e.gaps, tagClass: "jf-tag-amber" },
        { title: t("result.requiredGaps"), items: e.required_gaps, tagClass: "jf-tag-red" },
        { title: t("result.seniority"), items: e.seniority_flag ? [e.seniority_flag] : [], tagClass: "jf-tag-red" },
        {
          title: t("result.scoreCap"),
          items: (e.score_cap_reasons || []).map((reason) =>
            e.raw_score != null ? `${reason} ${t("result.capDetail", { raw: e.raw_score, score: e.score })}` : reason
          ),
          tagClass: "jf-tag-amber",
        },
        {
          title: t("banner.warningsTitle"),
          items: record.softWarnings,
          tagClass: "jf-tag-amber",
        },
        {
          title: t("banner.domainFlagsTitle"),
          items: record.domainFlags,
          tagClass: "jf-tag-neutral",
        },
        { title: t("result.salary"), items: salaryItems, tagClass: "jf-tag-neutral" },
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

    await JOB_FIT_I18N.load();
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
        label: `⚠ ${t("banner.noText")}`,
        summary: t("banner.noTextSummary"),
        sections: [],
      });
      return;
    }

    probeJsonLd(result, extractorName);
    if (!result.location) result.location = jsonLdLocation();

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

    const currentModel = JOB_FIT_PROVIDER.currentModel(await chrome.storage.local.get(JOB_FIT_PROVIDER.KEYS));

    const cached = ignoreCache ? null : await JOB_FIT_EVALSTORE.get(activeProfile.id, jobKey);
    if (cached) {
      // A saved result is shown even when a different model or an older
      // profile produced it — re-scoring is the user's call, made with the
      // banner's Re-evaluate button, never something opening a page does on
      // its own. The banner says why the score may be out of date.
      //
      // The exception is a hard reject under a changed profile: that verdict
      // came from the profile's own keyword lists, and re-checking it is a
      // keyword scan, not a model call.
      const profileChanged = cached.profileFingerprint !== fingerprint;
      const modelChanged = !cached.hardReject && (cached.model || "") !== currentModel;

      if (!(cached.hardReject && profileChanged)) {
        const reasons = [
          modelChanged &&
            t("banner.staleModel", {
              model: cached.model || t("banner.aDifferentModel"),
              current: currentModel || t("banner.notSet"),
            }),
          profileChanged && t("banner.staleProfile"),
        ].filter(Boolean);
        renderResult(cached, {
          cached: true,
          profileName: activeProfile.name,
          onReevaluate: () => start({ ignoreCache: true }),
          staleNote: reasons.length ? t("banner.staleNote", { reasons: JOB_FIT_I18N.list(reasons) }) : null,
        });
        return;
      }
      console.log("[Job Fit Evaluator] saved hard reject predates a profile change — re-checking");
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

    // Layer 1, with the posting's location and the profile's work
    // authorization, so the rules that depend on the country apply to this
    // posting's country (screening.js).
    const layer1 = JOB_FIT_SCREEN.screen(result.text, activeProfile.keywords, {
      location: result.location,
      jobSearch: activeProfile.jobSearch,
    });
    baseRecord.place = layer1.place;

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

    const domainFlagMatches = layer1.domainFlags;
    const softWarningMatches = layer1.softWarnings;

    const flagNotes = [
      domainFlagMatches.length ? `${t("banner.flagsNote")}: ${domainFlagMatches.join(", ")}` : null,
      softWarningMatches.length ? `${t("banner.warningsNote")}: ${softWarningMatches.join(", ")}` : null,
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
            jobSearch: activeProfile.jobSearch,
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
        label: `⚠ ${t("banner.error")}`,
        summary: t("banner.noWorker", { detail: err.message }),
        sections: [],
      });
      return;
    }

    if (!response || !response.ok) {
      renderBanner({
        status: "amber",
        label: `⚠ ${t("banner.queueFull")}`,
        summary:
          response && response.full
            ? t("banner.queueFullSummary", { count: response.max })
            : (response && response.error) || t("banner.couldNotQueue"),
        sections: [],
      });
      return;
    }

    const flagSuffix = flagNotes.length ? ` — ${flagNotes.join(" · ")}` : "";
    const queueNote =
      response.position <= 1
        ? t("banner.sendingNow")
        : t("banner.queuedPosition", { position: response.position, total: response.total });

    renderBanner({
      status: "neutral",
      label: "…",
      summary: response.duplicate
        ? `[${activeProfile.name}] ${t("banner.alreadyQueued", { position: response.position })}`
        : `[${activeProfile.name}] ${t("banner.passedLayer1")}${flagSuffix} — ${queueNote}`,
      sections: [],
    });
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
          label: `⚠ ${t("banner.error")}`,
          summary: t("banner.somethingWrong", { detail: err && err.message ? err.message : String(err) }),
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

      JOB_FIT_I18N.load().then(() =>
        renderResult(message.record, { cached: false, profileName: message.profileName })
      );
    });
  }

  start();
})();
