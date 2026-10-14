(() => {
  // The job id in a /jobs/view/ path. Signed in, it's the whole segment
  // (/jobs/view/4435682676/); signed out, and on links from search engines,
  // it trails a slug of the title (/jobs/view/senior-c-engineer-at-acme-4435682676).
  // Matching only the first form left those pages with no id, so history was
  // keyed on a URL that changes with every search.
  const JOB_VIEW_ID = /\/jobs\/view\/(?:[^/?#]*-)?(\d+)(?=[/?#]|$)/;

  function jobIdFromPath(path) {
    const match = String(path || "").match(JOB_VIEW_ID);
    return match ? match[1] : null;
  }

  function currentJobId() {
    const fromQuery = new URLSearchParams(location.search).get("currentJobId");
    if (fromQuery) return fromQuery;
    return jobIdFromPath(location.pathname);
  }

  // The search-results layout renders a card per job in the left rail, each
  // with its own /jobs/view/ link, so a blind first-match would frequently
  // name a different posting than the one on screen. Correlate on the job id
  // from the page URL instead — and return null rather than guess, since a
  // confidently wrong job title is worse than none.
  // Labels LinkedIn attaches to a job that are emphatically not its title.
  // Several of these are rendered as links to the job itself.
  const NOT_A_TITLE =
    /^(on-?site|remote|hybrid|full-?time|part-?time|contract|temporary|internship|volunteer|easy apply|apply|save|saved|promoted|actively hiring|be an early applicant|entry level|associate|mid-senior level|director|executive|\d+\+? applicants?|view job|see job)$/i;

  // Generic UI controls. Some of them link back to the job too — a "Show all"
  // on the skills section did, and with the title rendered as plain text it
  // was the longest link left, so the posting was filed as "Show all".
  const UI_CONTROL = /^(show|see|view|load)\s+(all|more|less)\b|^(more|less|learn more|read more|…\s*more|\.\.\.\s*more)$/i;

  // Pay pills ("$200K/yr - $220K/yr") also link to the job and are longer than
  // the other pills, so the longest-label fallback picked them as the title.
  const PAY = /[$€£¥₹]|\/\s*(yr|year|hr|hour|mo|month)\b/i;

  function notATitle(text) {
    return NOT_A_TITLE.test(text) || UI_CONTROL.test(text) || PAY.test(text);
  }

  // On a /jobs/view/<id> page the tab title is "Job title | Company | LinkedIn"
  // (with a "(3) " notification count in front when there are unread ones).
  // It's the one source that doesn't depend on which buttons happen to link
  // to the job, so it's trusted ahead of any guess. Only on the job's own page:
  // on search results the tab title describes the search, not this job.
  function tabTitle() {
    const parts = document.title
      .replace(/^\(\d+\+?\)\s*/, "")
      .split(" | ")
      .map((p) => p.trim());
    if (parts.length < 3 || !/^linkedin$/i.test(parts[parts.length - 1])) return null;
    const title = parts[0];
    if (!title || notATitle(title)) return null;
    return { title, company: parts[1] || null };
  }

  function fromDocumentTitle() {
    const pathId = jobIdFromPath(location.pathname);
    if (!pathId || pathId !== currentJobId()) return null;
    return tabTitle();
  }

  // The search page's newer layout (2026) also titles the tab after the job
  // on screen; the older one titled it after the search. So off the job's own
  // page the tab title is only taken when the page agrees with it: its title
  // is a link to this job, or its company is the header's company link.
  function agreeingTabTitle(header) {
    const tab = tabTitle();
    if (!tab) return null;
    const titles = titleCandidates().map(({ text }) => text);
    const companies = header ? companyNames(header) : [];
    return titles.includes(tab.title) || (tab.company && companies.includes(tab.company)) ? tab : null;
  }

  function inHeading(anchor) {
    return Boolean(anchor.closest("h1, h2, h3") || anchor.querySelector("h1, h2, h3"));
  }

  // Several anchors on the page point at the same job — the title, and also
  // pills like "On-site" and "Promoted". querySelector took whichever came
  // first in the DOM, which is how a posting ended up titled "On-site" or
  // "Remote". Worse, findHeaderContainer walks up FROM this anchor, so the
  // wrong pick poisoned the company and location too.
  function jobAnchors() {
    const jobId = currentJobId();
    if (!jobId) return [];
    // Compared on the parsed id, not a substring of the href, so slugged
    // links count and /jobs/view/123 doesn't also claim /jobs/view/1234.
    return Array.from(document.querySelectorAll('a[href*="/jobs/view/"]')).filter((anchor) => {
      try {
        return jobIdFromPath(new URL(anchor.href, location.href).pathname) === jobId;
      } catch (err) {
        return false;
      }
    });
  }

  function titleCandidates() {
    return jobAnchors()
      .map((anchor) => ({ anchor, text: (anchor.innerText || "").trim() }))
      .filter(({ text }) => text && !notATitle(text));
  }

  // The title is the heading for this job — checked in both nesting
  // directions, since the anchor may wrap the heading or sit inside it.
  function findHeadingAnchor() {
    const heading = titleCandidates().find(({ anchor }) => inHeading(anchor));
    return heading ? heading.anchor : null;
  }

  // Last resort: the longest remaining link label (pills are a word or two,
  // titles are not). A guess — it only runs once every better source failed.
  function longestAnchor() {
    const candidates = titleCandidates();
    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.text.length - a.text.length)[0].anchor;
  }

  // Every class in this UI is hashed (and changes between collapsed and
  // expanded states), so closest() has nothing stable to target. Walk up a
  // bounded number of levels to find the ancestor that also holds the
  // company link — that's the header block for this specific job.
  function findHeaderContainer(titleAnchor) {
    let el = titleAnchor;
    for (let i = 0; i < 8 && el; i++) {
      if (el.querySelector('a[href*="/company/"]')) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Some layouts render the title as plain text, with only the pills linking to
  // the job. The header is still reachable from a pill, and the title is its
  // first text block that isn't the company, a pill, a button or the
  // "location · posted · applicants" line.
  // The company's name from the header's links to it. The first link is often
  // the logo, with no text: taking it gave no company, and let the company's
  // name, written beside the logo, pass for the job title.
  function companyNames(header) {
    return Array.from(header.querySelectorAll('a[href*="/company/"]'))
      .map((a) => (a.innerText || "").trim().split("\n")[0].trim())
      .filter(Boolean);
  }

  function titleFromHeader(header) {
    const companies = companyNames(header);
    const blocks = header.querySelectorAll("h1, h2, h3, p");
    for (const block of blocks) {
      if (block.closest("a, button")) continue;
      const text = (block.innerText || "").trim();
      if (!text || companies.includes(text) || text.includes("·") || notATitle(text)) continue;
      return text;
    }
    return null;
  }

  // The description of the job on screen. The newer layout tags each part of
  // the job pane with the job's id ("JobDetails_AboutTheJob_<id>"), and has
  // many expandable boxes (About the company has several), so the box is taken
  // from that section. While the next job loads, the pane can still be the
  // last one's: no section for this id means nothing to read yet.
  const STILL_LOADING = {};

  function descriptionBox() {
    const sections = Array.from(document.querySelectorAll('[componentkey^="JobDetails_AboutTheJob_"]'));
    if (sections.length) {
      const jobId = currentJobId();
      const mine = jobId ? sections.find((s) => s.getAttribute("componentkey") === `JobDetails_AboutTheJob_${jobId}`) : sections[0];
      if (!mine) return STILL_LOADING;
      return mine.querySelector('[data-testid="expandable-text-box"]') || mine;
    }
    return document.querySelector('[data-testid="expandable-text-box"]');
  }

  function textOf(selector) {
    const el = document.querySelector(selector);
    const text = el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "";
    return text || null;
  }

  // The signed-out ("guest") page is a different, server-rendered layout with
  // stable class names and no expandable-text-box, so it fell through to the
  // generic extractor: the whole page — sign-in prompts, similar jobs, legal
  // text — went to the model, about 3.5x the posting, with the tab title as
  // the job title and no company or location. As on the signed-in page, the
  // "Show more" clamp is CSS only; the full text is already in the markup.
  function extractSignedOut() {
    const descEl = document.querySelector(".description__text .show-more-less-html__markup, .show-more-less-html__markup");
    if (!descEl) return null;
    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).length < 100) return null;

    const jobLocation = textOf(".top-card-layout .topcard__flavor--bullet:not(.num-applicants__caption)");
    const posted = textOf(".top-card-layout .posted-time-ago__text");
    // Built like the signed-in header's "location · posted · applicants"
    // line, which is what postingmeta.js reads the posted date from.
    const metaLine = [jobLocation, posted, textOf(".top-card-layout .num-applicants__caption")].filter(Boolean).join(" · ");

    return {
      title: textOf(".top-card-layout__title") || textOf(".topcard__title"),
      company: textOf(".topcard__org-name-link") || textOf(".top-card-layout .topcard__flavor"),
      location: jobLocation,
      text,
      postingFields: posted ? { postedText: metaLine } : null,
    };
  }

  function extractLinkedIn() {
    const descEl = descriptionBox();
    if (descEl === STILL_LOADING) return null;
    if (!descEl) return extractSignedOut();

    // The full description is already in the DOM while the box is visually
    // collapsed — the "…more" button only toggles CSS clamping — so there's
    // no need to expand it first. textFrom skips the button itself.
    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).length < 100) return null;

    // Most trustworthy first: a heading link, the tab title (on the job's own
    // page, or on a search page when the page agrees with it), the longest
    // link to the job, and the header's plain text last. The link once lost to
    // the header after a "Show all" link won as the title; UI controls are
    // filtered out of the links now (UI_CONTROL), and in the 2026 layout the
    // header's plain text is the company's name.
    const headingAnchor = findHeadingAnchor();
    const docTitle = fromDocumentTitle();
    const seed = headingAnchor || jobAnchors()[0];
    const header = seed ? findHeaderContainer(seed) : null;
    const guess = longestAnchor();
    const agreeing = docTitle ? null : agreeingTabTitle(header);
    // A link to this job comes ahead of the header's plain text: in the newer
    // layout the title is such a link, and the header's first plain text is
    // the company's name or "Responses managed off LinkedIn". Pills, buttons
    // and pay that also link to the job are filtered out of the candidates.
    const title =
      (headingAnchor && headingAnchor.innerText.trim()) ||
      (docTitle && docTitle.title) ||
      (agreeing && agreeing.title) ||
      (guess && guess.innerText.trim()) ||
      (header && titleFromHeader(header)) ||
      null;

    let company = null;
    let jobLocation = null;
    let metaLine = null;

    if (header) {
      company = companyNames(header)[0] || null;

      // e.g. "Bellevue, WA · Reposted 1 week ago · 96 people clicked apply"
      metaLine =
        window.__jobFit
          .textFrom(header)
          .split("\n")
          .find((line) => line.includes("·")) || null;
      if (metaLine) jobLocation = metaLine.split("·")[0].trim() || null;
    }

    // The header's company link is preferred; the tab title covers a header
    // that couldn't be found.
    if (!company && docTitle && docTitle.company) company = docTitle.company;
    if (!company && agreeing && agreeing.company) company = agreeing.company;

    return {
      title,
      company,
      location: jobLocation,
      text,
      // The "Reposted 1 week ago" in the same line, for when it was posted
      // (postingmeta.js).
      postingFields: metaLine ? { postedText: metaLine } : null,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.linkedin = extractLinkedIn;
  // Exposed so jobkey.js can key history records on the LinkedIn job id
  // rather than on a URL that changes with every search.
  window.__jobFit.linkedinJobId = currentJobId;
})();
