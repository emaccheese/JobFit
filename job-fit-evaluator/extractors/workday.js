(() => {
  // Workday career sites (<tenant>.wd<N>.myworkdayjobs.com, and the same app
  // behind some companies' own domains). Workday tags its components with
  // data-automation-id, which is stable across every tenant — unlike its
  // generated css-* class names.
  //
  // Reads only the posting's own components. The page header carries the
  // signed-in candidate's email, so it is never part of what's extracted.
  const MIN_WORDS = 100;

  function part(root, id) {
    return root.querySelector(`[data-automation-id="${id}"]`);
  }

  // The first few locations are listed, then "View All 61 Locations" hides
  // the rest; one location plus a count says as much in far less space.
  function locationOf(details) {
    const shown = Array.from(details.querySelectorAll('[data-automation-id="locations"] dd'))
      .map((dd) => dd.innerText.trim())
      .filter(Boolean);
    if (shown.length === 0) return null;
    const more = part(details, "locationButton-collapsed");
    const total = more && Number((more.innerText.match(/\d+/) || [])[0]);
    const count = total || shown.length;
    return count > 1 ? `${shown[0]} (+${count - 1} more)` : shown[0];
  }

  // Two layouts carry a posting: the job's own page (jobPostingPage), and the
  // search page's right-hand panel after clicking a result (jobDetails). The
  // panel holds the same components, without the job-posting-details wrapper.
  function postingRoot() {
    return part(document, "jobPostingPage") || part(document, "jobDetails");
  }

  // The search panel has no JSON-LD. The tenant subdomain is the company's
  // own Workday name, which is closer than nothing — but only on
  // myworkdayjobs.com, since a custom domain's first label is "careers".
  function companyName() {
    const fromJsonLd = window.__jobFit.jsonLdCompany();
    if (fromJsonLd) return fromJsonLd;
    if (!location.hostname.endsWith(".myworkdayjobs.com")) return null;
    const tenant = location.hostname.split(".")[0];
    return tenant.charAt(0).toUpperCase() + tenant.slice(1);
  }

  function extractWorkday() {
    const root = postingRoot();
    if (!root) return null;
    const descEl = part(root, "jobPostingDescription");
    if (!descEl) return null;

    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;

    const titleEl = part(root, "jobPostingHeader");
    const details = part(root, "job-posting-details") || root;

    return {
      title: titleEl ? titleEl.innerText.trim() : null,
      company: companyName(),
      location: locationOf(details),
      text,
    };
  }

  // The requisition id, scoped to the tenant: the same job is reachable as
  // /job/… or the search panel's /details/…, with or without the /en-US/
  // locale segment, and requisition ids are only unique within one company.
  function workdayJobId() {
    const root = postingRoot();
    if (!root) return null;
    const details = part(root, "job-posting-details") || root;
    const reqEl = details.querySelector('[data-automation-id="requisitionId"] dd');
    const fromUrl = location.pathname.match(/_([A-Za-z0-9-]+)\/?$/);
    const req = (reqEl && reqEl.innerText.trim()) || (fromUrl && fromUrl[1]);
    if (!req) return null;
    const tenant = location.hostname.split(".")[0];
    return `${tenant}:${req}`;
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.workday = extractWorkday;
  window.__jobFit.workdayJobId = workdayJobId;
})();
