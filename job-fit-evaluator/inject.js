// Starting an evaluation = injecting the page scripts into the tab; content.js
// takes it from there (extract, screen, queue, banner). Shared by the popup's
// button, the toolbar icon on job pages and the keyboard shortcut, which all
// used to be the popup alone — loaded by popup.html and importScripts()'d by
// the service worker.

const JOB_FIT_CONTENT_FILES = [
  "defaults.js",
  "provider.js",
  "keywords.js",
  "screening.js",
  "profiles.js",
  "evalstore.js",
  "extractors/text.js",
  "extractors/generic.js",
  "extractors/greenhouse.js",
  "extractors/linkedin.js",
  "extractors/jibe.js",
  "extractors/workday.js",
  "extractors/indeed.js",
  "extractors/eightfold.js",
  "jobkey.js",
  "content.js",
];

// chrome.scripting refuses to inject into chrome:// pages, the Web Store,
// PDF viewers, other extensions' pages, and any tab whose host the extension
// can't access. Left unhandled, the rejection stranded the popup: the button
// stayed disabled, the popup never closed, and nothing said why.
function injectionErrorMessage(err) {
  const raw = err && err.message ? err.message : String(err);
  if (/cannot be scripted|Cannot access|chrome:\/\/|Extension manifest|blocked/i.test(raw)) {
    return "Chrome won't let the extension run on this page (browser pages, the Web Store and PDFs are off-limits). Open the posting on a normal web page and try again.";
  }
  return `Couldn't run on this tab: ${raw}`;
}

// Injects the job content script into cross-origin iframes that host a job
// board (a company career site embedding Greenhouse). Reports what it found
// into the PAGE console, next to the content script's own logs, because the
// popup closes immediately and its own console is a separate window nobody
// thinks to open.
//
// Failures here are reported but never rethrown: the top frame has already
// been injected by this point, and losing that to an iframe problem would be
// worse than the iframe being missed.
async function injectJobFrames(tabId, files, { withCss = true } = {}) {
  const report = (info) =>
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: (payload) => console.log("[Job Fit Evaluator] frame scan:", payload),
        args: [info],
      })
      .catch(() => {});

  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
    await report({ error: "chrome.webNavigation unavailable — reload the extension after the manifest change" });
    return [];
  }

  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (err) {
    await report({ error: `getAllFrames failed: ${err.message}` });
    return [];
  }

  // Matched on the frame's HOST, not on a substring of its URL. A real
  // Greenhouse board page loads a Google API proxy iframe whose hash contains
  // "#parent=https%3A%2F%2Fjob-boards.greenhouse.io" — plain text once you
  // account for :// being encoded — which a substring test happily matched,
  // and the content script was then injected into a Google RPC shim.
  const candidates = (frames || []).filter((f) => {
    if (f.frameId === 0 || !f.url) return false;
    try {
      const url = new URL(f.url);
      return url.hostname.endsWith("greenhouse.io");
    } catch (err) {
      return false;
    }
  });

  // Asks Chrome directly whether the permission is actually held at runtime.
  // This separates "the extension lacks the grant" from "this particular frame
  // can't be scripted", which the injection error alone does not distinguish —
  // it reports both as "manifest must request permission".
  let granted = null;
  try {
    granted = await chrome.permissions.contains({ origins: ["https://job-boards.greenhouse.io/*"] });
  } catch (err) {
    granted = `check failed: ${err.message}`;
  }

  if (candidates.length === 0) {
    await report({
      permissionGranted: granted,
      framesSeen: (frames || []).map((f) => ({ id: f.frameId, url: f.url })),
      note: "no greenhouse.io subframe found in this tab",
    });
    return [];
  }

  // One frame at a time. A single executeScript call listing several frameIds
  // is rejected as a whole if ANY of them is inaccessible — an about:blank or
  // sandboxed frame that still reports a greenhouse URL would take the real
  // job frame down with it. Injecting individually means one bad frame costs
  // only itself, and the report names which frame failed and why.
  const injected = [];
  const outcomes = [];

  for (const frame of candidates) {
    const frameIds = [frame.frameId];
    try {
      if (withCss) {
        await chrome.scripting.insertCSS({ target: { tabId, frameIds }, files: ["content.css"] });
      }
      await chrome.scripting.executeScript({ target: { tabId, frameIds }, files });
      injected.push(frame.frameId);
      outcomes.push({ id: frame.frameId, url: frame.url, injected: true });
    } catch (err) {
      outcomes.push({ id: frame.frameId, url: frame.url, injected: false, error: err.message });
    }
  }

  await report({ permissionGranted: granted, frames: outcomes });
  return injected;
}

// Returns { ok: true } or { ok: false, error } with a message for a person.
async function startEvaluation(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: JOB_FIT_CONTENT_FILES });
    // Find cross-origin iframes that host job content (e.g. embedded
    // Greenhouse boards on custom-domain career sites) and inject into those
    // specifically. allFrames: true would reject the entire call if ANY frame
    // in the tab (ads, analytics) is on a domain we lack permission for.
    await injectJobFrames(tabId, JOB_FIT_CONTENT_FILES);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: injectionErrorMessage(err) };
  }
}
