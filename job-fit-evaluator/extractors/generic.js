(() => {
  const MIN_WORDS = 200;

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

  // A visible cookie banner is a role="dialog" too; taking it as the root
  // left a few dozen words and no posting. Only a dialog long enough to be
  // one counts.
  function findRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'))
      .filter(isVisible)
      .filter((d) => window.__jobFit.textFrom(d).split(/\s+/).length >= MIN_WORDS);
    if (dialogs.length > 0) {
      dialogs.sort((a, b) => area(b) - area(a));
      return dialogs[0];
    }
    return document.body;
  }

  function extractGeneric() {
    const root = findRoot();

    // Previously this cloned the root to strip forms, then read innerText —
    // but innerText on a detached clone degrades to textContent, so every
    // site falling through to this extractor was getting its <br>/<li>
    // structure flattened into one run-on blob. textFrom does the same
    // skipping (forms included, so the PII guarantee holds) while walking
    // the live DOM, where block boundaries are preserved.
    const text = window.__jobFit.textFrom(root);
    if (text.split(/\s+/).length < MIN_WORDS) return null;

    return {
      title: document.title || null,
      company: null,
      location: null,
      text,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.generic = extractGeneric;
})();
