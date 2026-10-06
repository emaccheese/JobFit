(() => {
  // Glassdoor (glassdoor.com, .com.mx, .ca, .co.uk…). Its job search is a
  // single-page app: the results list on the left and the selected job on the
  // right, swapped in place as you click, and the address doesn't change when
  // you do. So the job on screen is read from the detail pane itself, never
  // from the address.
  //
  // Read from the detail pane only: the header (title, company, location,
  // pay) and the description. The pane also holds "Your qualifications for
  // this job", which Glassdoor builds from the reader's OWN Glassdoor
  // profile: sent with the posting, the model would take the user's skills
  // for the job's requirements. The results list, the salary module and the
  // company module below the description are left out too.
  //
  // Class names carry a build hash ("JobDetails_jobDescription__uW_fK"), so
  // only their stable prefix is matched, and data-test attributes where
  // Glassdoor has them.
  const MIN_WORDS = 50;

  function isGlassdoor() {
    return /(^|\.)glassdoor\.[a-z.]+$/i.test(location.hostname);
  }

  function detailHeader() {
    return document.querySelector('[data-test="job-details-header"]');
  }

  function digits(value) {
    return typeof value === "string" && /^\d+$/.test(value) ? value : null;
  }

  // The id of the job in the detail pane: from the pane's own header first
  // (what's on screen), then the selected card, then a job page's address.
  function glassdoorJobId() {
    if (!isGlassdoor()) return null;
    const header = detailHeader();
    if (header) {
      const fromBrand = (header.getAttribute("data-brandviews") || "").match(/jlid=(\d+)/);
      if (fromBrand) return fromBrand[1];
      const titleEl = header.querySelector('h1[id^="jd-job-title-"]');
      const fromTitle = titleEl && titleEl.id.match(/^jd-job-title-(\d+)$/);
      if (fromTitle) return fromTitle[1];
    }
    const selected = document.querySelector('[data-test="job-card-wrapper"][data-selected="true"]');
    const card = selected && selected.closest('[data-test="jobListing"]');
    const fromCard = card && digits(card.getAttribute("data-jobid"));
    if (fromCard) return fromCard;
    return digits(new URLSearchParams(location.search).get("jl"));
  }

  // The description that belongs to that job. While the next job loads, the
  // header can already be the new one and the description still the old one;
  // the description's own job id says which it is, and a mismatch is "still
  // loading", not a posting.
  function descriptionFor(jobId) {
    const candidates = Array.from(document.querySelectorAll('[class*="JobDetails_jobDescription"]'));
    if (!candidates.length) return null;
    const owner = (el) => {
      const tagged = el.closest('[data-brandviews*="jlid="]');
      const m = tagged && tagged.getAttribute("data-brandviews").match(/jlid=(\d+)/);
      return m ? m[1] : null;
    };
    if (!jobId) return candidates[0];
    return candidates.find((el) => owner(el) === jobId) || candidates.find((el) => owner(el) === null) || null;
  }

  function textOf(el) {
    return el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() || null : null;
  }

  // The header's pay, only when the employer gave it. Glassdoor otherwise
  // shows its own estimate there, which the model would report as the
  // posting's pay. The label is in the site's language.
  const EMPLOYER_PROVIDED = /employer|empleador|employeur|empregador|arbeitgeber/i;

  function employerPay(header) {
    const pay = textOf(header && header.querySelector('[data-test="detailSalary"]'));
    return pay && EMPLOYER_PROVIDED.test(pay) ? pay : null;
  }

  // "7 d", "+ 30 d", "24 h" on the job's card in the results list.
  function postedText(jobId) {
    if (!jobId) return null;
    const card = document.querySelector(`[data-test="jobListing"][data-jobid="${jobId}"]`);
    return textOf(card && card.querySelector('[data-test="job-age"]'));
  }

  function extractGlassdoor() {
    if (!isGlassdoor()) return null;
    const jobId = glassdoorJobId();
    const descEl = descriptionFor(jobId);
    if (!descEl) return null;
    // The description is clamped with CSS behind "Show more"; the full text
    // is already in the markup.
    const description = window.__jobFit.textFrom(descEl);
    if (description.split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;

    const header = detailHeader();
    const titleEl = header && header.querySelector("h1");
    const companyEl = header && (header.querySelector('[class*="EmployerProfile_employerNameHeading"] h4') || header.querySelector("h4"));
    const pay = employerPay(header);
    const posted = postedText(jobId);

    return {
      title: textOf(titleEl),
      company: textOf(companyEl),
      location: textOf(header && header.querySelector('[data-test="location"]')),
      text: pay ? `${description}\n\nPay: ${pay}` : description,
      postingFields: posted ? { postedText: posted } : null,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.glassdoor = extractGlassdoor;
  window.__jobFit.glassdoorJobId = glassdoorJobId;
})();
