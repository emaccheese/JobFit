(() => {
  function currentJobId() {
    const fromQuery = new URLSearchParams(location.search).get("currentJobId");
    if (fromQuery) return fromQuery;
    const fromPath = location.pathname.match(/\/jobs\/view\/(\d+)/);
    return fromPath ? fromPath[1] : null;
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

  // Pay pills ("$200K/yr - $220K/yr") also link to the job and are longer than
  // the other pills, so the longest-label fallback picked them as the title.
  const PAY = /[$€£¥₹]|\/\s*(yr|year|hr|hour|mo|month)\b/i;

  function notATitle(text) {
    return NOT_A_TITLE.test(text) || PAY.test(text);
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
    return Array.from(document.querySelectorAll(`a[href*="/jobs/view/${jobId}"]`));
  }

  function findTitleAnchor() {
    const candidates = jobAnchors()
      .map((anchor) => ({ anchor, text: (anchor.innerText || "").trim() }))
      .filter(({ text }) => text && !notATitle(text));

    if (!candidates.length) return null;

    // The title is the heading for this job — checked in both nesting
    // directions, since the anchor may wrap the heading or sit inside it.
    const heading = candidates.find(({ anchor }) => inHeading(anchor));
    if (heading) return heading.anchor;

    // Otherwise the longest label: pills are a word or two, titles are not.
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
  function titleFromHeader(header) {
    const company = header.querySelector('a[href*="/company/"]');
    const companyName = company ? company.innerText.trim() : "";
    const blocks = header.querySelectorAll("h1, h2, h3, p");
    for (const block of blocks) {
      if (block.closest("a, button")) continue;
      const text = (block.innerText || "").trim();
      if (!text || text === companyName || text.includes("·") || notATitle(text)) continue;
      return text;
    }
    return null;
  }

  function extractLinkedIn() {
    const descEl = document.querySelector('[data-testid="expandable-text-box"]');
    if (!descEl) return null;

    // The full description is already in the DOM while the box is visually
    // collapsed — the "…more" button only toggles CSS clamping — so there's
    // no need to expand it first. textFrom skips the button itself.
    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).length < 100) return null;

    const titleAnchor = findTitleAnchor();
    const seed = titleAnchor || jobAnchors()[0];
    const header = seed ? findHeaderContainer(seed) : null;
    const title =
      (titleAnchor && titleAnchor.innerText.trim()) || (header && titleFromHeader(header)) || null;

    let company = null;
    let jobLocation = null;

    if (header) {
      const companyEl = header.querySelector('a[href*="/company/"]');
      company = companyEl ? companyEl.innerText.trim() || null : null;

      // e.g. "Bellevue, WA · Reposted 1 week ago · 96 people clicked apply"
      const metaLine = window.__jobFit
        .textFrom(header)
        .split("\n")
        .find((line) => line.includes("·"));
      if (metaLine) jobLocation = metaLine.split("·")[0].trim() || null;
    }

    return {
      title,
      company,
      location: jobLocation,
      text,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.linkedin = extractLinkedIn;
  // Exposed so jobkey.js can key history records on the LinkedIn job id
  // rather than on a URL that changes with every search.
  window.__jobFit.linkedinJobId = currentJobId;
})();
