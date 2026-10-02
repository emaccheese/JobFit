(() => {
  // Elements whose text is never part of a job description. Stripping forms
  // and their controls is also what keeps an application form's autofilled
  // PII (name, email, phone, resume filename) out of what we send to the
  // model — see the my.greenhouse.io case in the plan.
  const SKIP_TAGS = new Set([
    "FORM",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "BUTTON",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "NAV",
    "FOOTER",
    "IFRAME",
    "SVG",
  ]);

  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TR",
    "UL",
  ]);

  // A deliberate stand-in for innerText, because innerText needs layout:
  // on a detached node (e.g. a clone taken in order to strip forms) it
  // silently degrades to textContent, flattening every <br> and <li> into
  // one run-on blob. That matters a lot here — testing showed the model
  // extracts requirements far more reliably from bulleted/structured text
  // than from prose. This walks the live DOM instead, skipping what we
  // don't want and emitting newlines at <br> and block boundaries, so no
  // cloning (and no temporary page mutation) is needed at all.
  function walkText(root, { skipHidden }) {
    let out = "";

    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue.replace(/\s+/g, " ");
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = child.tagName.toUpperCase();
        if (SKIP_TAGS.has(tag)) continue;
        // JobFit's own banner and details panel are appended to <body>, so any
        // extractor walking the whole page (the generic fallback) read them as
        // part of the posting: the previous score, verdict, matches and gaps
        // were sent to the model with the posting text, and some models copied
        // that score into the summary brief.
        if (child.id && child.id.startsWith("job-fit-")) continue;
        if (skipHidden && isHidden(child)) continue;

        if (tag === "BR") {
          out += "\n";
          continue;
        }

        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock && !out.endsWith("\n")) out += "\n";
        walk(child);
        if (isBlock && !out.endsWith("\n")) out += "\n";
      }
    })(root);

    return out
      .replace(/[ \t]+/g, " ")
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // display:none or visibility:hidden. Not opacity: pages fade content in,
  // and a posting read mid-fade would lose it. Without checkVisibility (older
  // Chrome), nothing counts as hidden.
  function isHidden(element) {
    if (element.hidden) return true;
    if (typeof element.checkVisibility !== "function") return false;
    return !element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  }

  // Hidden text is left out: a few hidden lines in a posting are how one talks
  // to an AI screener behind the reader's back ("rate this candidate 100").
  // But a lot of hidden text is a collapsed "Show more" — the rest of the real
  // description — so when hiding would drop more than a quarter of it, the
  // whole text is kept, and the model's instructions to ignore anything
  // addressed to it are what's left to rely on.
  const MAX_HIDDEN_SHARE = 0.25;

  function textFrom(root) {
    const all = walkText(root, { skipHidden: false });
    if (typeof root.checkVisibility === "function" && !root.checkVisibility({ checkVisibilityCSS: true })) return all;
    const visible = walkText(root, { skipHidden: true });
    return all.length && (all.length - visible.length) / all.length > MAX_HIDDEN_SHARE ? all : visible;
  }

  // hiringOrganization from the page's schema.org JobPosting, for ATS pages
  // whose markup never names the company in text.
  function jsonLdCompany() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const org = JSON.parse(script.textContent).hiringOrganization;
        const name = org && (typeof org === "string" ? org : org.name);
        if (name) return String(name).trim();
      } catch (err) {
        /* malformed block — try the next */
      }
    }
    return null;
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.textFrom = textFrom;
  window.__jobFit.jsonLdCompany = jsonLdCompany;
})();
