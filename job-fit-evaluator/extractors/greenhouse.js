(() => {
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  // Minimum length before we'll treat extracted text as a real posting. The
  // portal branch used to accept any non-empty string while the classic board
  // required 100 words, so a dialog that hadn't finished rendering could send
  // a fragment to the model as though it were the whole job.
  const MIN_WORDS = 100;

  function longEnough(text) {
    return text.split(/\s+/).filter(Boolean).length >= MIN_WORDS;
  }

  // my.greenhouse.io candidate portal: the posting renders inside a visible
  // Radix dialog, sitting next to a <form> that carries the applicant's own
  // PII (name, email, phone, resume filename). Only ever read from a
  // confirmed-visible dialog's .application-description - never fall back
  // to document.body here, or the PII leaks in.
  function extractMyPortal() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(isVisible);
    if (dialogs.length === 0) return null;
    dialogs.sort((a, b) => area(b) - area(a));
    const dialog = dialogs[0];

    const descEl = dialog.querySelector(".application-description");
    if (!descEl) return null;

    const titleEl = dialog.querySelector(".application-form-header--title");
    const companyEl = dialog.querySelector(".application-form-header--company-name");

    // textFrom rather than innerText, matching the other extractors: it strips
    // form subtrees (a second line of defence for the PII sitting next to this
    // dialog) along with buttons and nav, and it emits the block boundaries
    // that make requirements legible to the model.
    const text = window.__jobFit.textFrom(descEl);
    if (!longEnough(text)) return null;

    return {
      title: titleEl ? titleEl.innerText.trim() : null,
      company: companyEl ? companyEl.innerText.trim() : null,
      location: null,
      text,
    };
  }

  // Classic static job board (boards.greenhouse.io / job-boards.greenhouse.io):
  // the posting is the page itself, no dialog involved.
  function extractClassicBoard() {
    const descEl = document.querySelector(".job__description");
    if (!descEl) return null;

    const titleEl = document.querySelector(".job__title h1");
    const locationEl = document.querySelector(".job__location");
    const logoEl = document.querySelector(".image-container img");

    const text = window.__jobFit.textFrom(descEl);
    if (!longEnough(text)) return null;

    return {
      title: titleEl ? titleEl.innerText.trim() : null,
      company: logoEl && logoEl.alt ? logoEl.alt.replace(/\s*logo$/i, "").trim() : null,
      location: locationEl ? locationEl.innerText.trim() : null,
      text,
    };
  }

  function extractGreenhouse() {
    return extractMyPortal() || extractClassicBoard();
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.greenhouse = extractGreenhouse;
})();
