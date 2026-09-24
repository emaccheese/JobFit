(() => {
  // Jibe (iCIMS) career sites — careers.keysight.com and many others on their
  // own domains. The markup is the platform's, not the company's, so it's
  // recognised by the <descriptions-app> component rather than by hostname.
  const MIN_WORDS = 100;

  function extractJibe() {
    if (!document.querySelector("descriptions-app")) return null;
    const descEl = document.querySelector("#description-body");
    if (!descEl) return null;

    const text = window.__jobFit.textFrom(descEl);
    if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;

    const titleEl = document.querySelector('h1[itemprop="title"]');
    const locationEl = document.querySelector("#header-locations .job-data-span");

    return {
      title: titleEl ? titleEl.innerText.trim() : null,
      // The DOM names the company only in the logo and page title.
      company: window.__jobFit.jsonLdCompany(),
      location: locationEl ? locationEl.innerText.trim() : null,
      text,
    };
  }

  // Jibe's path is /<context>/jobs/<req id>; the ?lang= param would otherwise
  // make the same job two history records.
  function jibeJobId() {
    if (!document.querySelector("descriptions-app")) return null;
    const m = location.pathname.match(/\/jobs\/(\d+)\/?$/);
    return m ? m[1] : null;
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.jibe = extractJibe;
  window.__jobFit.jibeJobId = jibeJobId;
})();
