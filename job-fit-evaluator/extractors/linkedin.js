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
  function findTitleAnchor() {
    const jobId = currentJobId();
    if (!jobId) return null;
    return document.querySelector(`a[href*="/jobs/view/${jobId}"]`);
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

  function extractLinkedIn() {
    const descEl = document.querySelector('[data-testid="expandable-text-box"]');
    if (!descEl) return null;

    // The full description is already in the DOM while the box is visually
    // collapsed — the "…more" button only toggles CSS clamping — so there's
    // no need to expand it first. textFrom skips the button itself.
    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).length < 100) return null;

    const titleAnchor = findTitleAnchor();
    const header = titleAnchor ? findHeaderContainer(titleAnchor) : null;

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
      title: titleAnchor ? titleAnchor.innerText.trim() || null : null,
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
