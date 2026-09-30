// The on-page button's reader for a Greenhouse board embedded in a company's
// own career site. The posting lives in the iframe, where the top frame's
// float.js can't see it, so this says which job the embed shows and the
// worker passes it to the top frame's card.
//
// Registered for every *.greenhouse.io/embed/ frame (the manifest already has
// that host), but it asks the worker first and reads nothing unless the page
// around it has the button switched on.
(() => {
  if (window === window.top || window.__jobFitFloatFrame) return;
  window.__jobFitFloatFrame = true;

  const RETRIES_MS = [0, 800, 2000, 4000];

  function read() {
    const extract = window.__jobFit && window.__jobFit.greenhouse;
    if (typeof extract !== "function") return null;
    try {
      const result = extract();
      return result ? { jobKey: JOB_FIT_JOBKEY.keyFor(result), title: result.title, company: result.company } : null;
    } catch (err) {
      return null;
    }
  }

  async function run() {
    let wanted = false;
    try {
      wanted = await chrome.runtime.sendMessage({ type: "JOB_FIT_FRAME_ENABLED" });
    } catch (err) {
      return; // orphaned after an extension reload
    }
    if (!wanted) return;
    // The embed may still be filling itself in.
    for (const ms of RETRIES_MS) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const job = read();
      if (job) {
        chrome.runtime.sendMessage({ type: "JOB_FIT_FRAME_JOB", job }).catch(() => {});
        return;
      }
    }
  }

  run();
})();
