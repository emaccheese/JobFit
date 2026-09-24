(() => {
  // Indeed (any country subdomain). Two layouts carry a posting: the
  // homepage/search right-hand panel after clicking a card, and the
  // standalone /viewjob page. Both are read through data-testid and ids,
  // which are stable; the css-* class names are generated per build.
  //
  // Reads only the posting. The page's own config blobs carry the signed-in
  // user's email and resume details, so nothing outside the description,
  // title and card metadata is ever touched.
  const MIN_WORDS = 100;

  function text(el) {
    return el ? el.innerText.trim() : null;
  }

  function descriptionEl() {
    return (
      document.querySelector("#jobDescriptionText") ||
      document.querySelector('[data-testid="viewjob-job-content"] .simple-job-description-html') ||
      document.querySelector(".simple-job-description-html")
    );
  }

  // The job key identifies the posting across every Indeed URL shape:
  // ?vjk= on the homepage/search panel, ?jk= on /viewjob, and data-jk on the
  // highlighted card as a fallback.
  function indeedJobKey() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("vjk") || params.get("jk");
    if (fromUrl && /^[0-9a-f]{16}$/i.test(fromUrl)) return fromUrl.toLowerCase();
    const card = document.querySelector(".vjs-highlight a[data-jk]");
    return card ? card.getAttribute("data-jk").toLowerCase() : null;
  }

  function extractIndeed() {
    if (!location.hostname.includes("indeed.")) return null;
    const descEl = descriptionEl();
    if (!descEl) return null;

    const body = window.__jobFit.textFrom(descEl);
    if (body.split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;

    const card = document.querySelector(".vjs-highlight");
    const title =
      text(document.querySelector('[data-testid="vj-job-title"]')) ||
      text(document.querySelector("h1.jobsearch-JobInfoHeader-title")) ||
      text(card && card.querySelector("h3.jobTitle span[title]"));
    const company =
      text(document.querySelector('[data-testid="inlineHeader-companyName"]')) ||
      text(card && card.querySelector('[data-testid="company-name"]')) ||
      text(document.querySelector('[data-testid="company-info-metadata"] a[href*="/cmp/"]'));
    const where =
      text(document.querySelector('[data-testid="inlineHeader-companyLocation"]')) ||
      text(document.querySelector('[data-testid="job-location"]')) ||
      text(card && card.querySelector('[data-testid="text-location"]'));

    return {
      title: title ? title.replace(/\s*-\s*job post$/i, "") : null,
      company,
      location: where,
      text: body,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.indeed = extractIndeed;
  window.__jobFit.indeedJobKey = indeedJobKey;
})();
