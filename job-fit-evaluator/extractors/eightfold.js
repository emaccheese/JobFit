(() => {
  // Eightfold career sites — careers.qualcomm.com and other companies' career
  // sites on their own domains. Like Jibe, the markup is the platform's, so
  // it's recognised by Eightfold's app root (#pcsx) and its job header rather
  // than by hostname.
  //
  // The search page is a single-page app: a results list on the left and the
  // selected job on the right, swapped in place as you click. The job id is
  // `pid` in the address (/careers?...&pid=446720778443) or the path on a
  // direct link (/careers/job/446720778443). Class names carry a build hash
  // ("position-title-3TPtN"), so only the stable prefix is matched.
  const MIN_WORDS = 100;

  function isEightfold() {
    return Boolean(document.querySelector("#pcsx") && document.querySelector("#job-description-container"));
  }

  function jobHeader() {
    const title = document.querySelector('h2[class^="position-title-"], h2[class*=" position-title-"]');
    return title ? title.closest('[class*="position-header-container-"]') || title.parentElement : null;
  }

  // The id of the job actually on screen. The header's "Add to Job Cart"
  // button and Apply link carry it, so it's read from there first: after
  // clicking through the results list, that's what's displayed even if the
  // address were ever a step behind.
  function eightfoldJobId() {
    if (!isEightfold()) return null;
    const header = jobHeader();
    if (header) {
      const cart = header.querySelector('[data-test-id^="add-to-cart-"]');
      const fromCart = cart && cart.getAttribute("data-test-id").match(/add-to-cart-(\d+)/);
      if (fromCart) return fromCart[1];
      const apply = header.querySelector('a[href*="pid="]');
      const fromApply = apply && new URL(apply.href, location.href).searchParams.get("pid");
      if (fromApply && /^\d+$/.test(fromApply)) return fromApply;
    }
    const fromQuery = new URLSearchParams(location.search).get("pid");
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
    const fromPath = location.pathname.match(/\/job\/(\d+)/);
    return fromPath ? fromPath[1] : null;
  }

  // The page's schema.org JobPosting, but only if it's for the job on screen:
  // it's written once when the page loads, so after clicking another job in
  // the results list it still describes the first one.
  function matchingJsonLd(jobId) {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        if (!data || data["@type"] !== "JobPosting") continue;
        const pid = data.url ? new URL(data.url, location.href).searchParams.get("pid") : null;
        if (pid && pid === jobId) return data;
      } catch (err) {
        /* malformed block — try the next */
      }
    }
    return null;
  }

  // "Qualcomm" from a tab title like "C++ at Tijuana, B.C., Mexico | Qualcomm".
  function companyFromTitle() {
    const parts = document.title.split(" | ").map((p) => p.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }

  function extractEightfold() {
    if (!isEightfold()) return null;
    const descEl = document.querySelector("#job-description-container");
    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;

    const header = jobHeader();
    const titleEl = header && header.querySelector('[class^="position-title-"], [class*=" position-title-"]');
    const locationEl = header && header.querySelector('[class^="position-location-"], [class*=" position-location-"]');
    const ld = matchingJsonLd(eightfoldJobId());

    return {
      title: (titleEl && titleEl.innerText.trim()) || (ld && ld.title) || null,
      // The company isn't named in the job header; the hiring organization is
      // the same for every job on one company's site, so the JobPosting block
      // is usable for it even when it describes a different job.
      company: window.__jobFit.jsonLdCompany() || companyFromTitle(),
      location: (locationEl && locationEl.innerText.trim()) || null,
      text,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.eightfold = extractEightfold;
  window.__jobFit.eightfoldJobId = eightfoldJobId;
})();
