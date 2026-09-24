// Derives a stable identity for the job on the current page.
//
// A raw URL is not a job identity. The same LinkedIn posting is reachable as
// /jobs/view/<id>/ and as /jobs/search-results/?currentJobId=<id>&refId=… with
// a fresh refId on every search, so keying on href would file the same job
// three times and stop the "already evaluated this" check from ever firing.
//
// Runs in the page, after the extractors, so it can reuse the job id
// linkedin.js already computed.
var JOB_FIT_JOBKEY = (function () {
  // Conservative: only params that are known to carry no meaning for which
  // job is being shown. Anything unrecognized is kept, because plenty of ATS
  // put the job id in a query param.
  const TRACKING_PARAMS = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "refid", "trackingid", "trk", "trkemail", "lipi", "licu",
    "midtoken", "midsig", "ebp", "originalsubdomain", "savedsearchid",
    "gh_src", "source", "src", "gclid", "fbclid", "position", "pagenum",
    // Greenhouse embeds carry a signed token that is re-issued on every page
    // load, so it can never be part of a job's identity.
    "validitytoken",
  ]);

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function normalizedUrl() {
    const u = new URL(location.href);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`);
    const path = u.pathname.replace(/\/+$/, "");
    return host + path + (params.length ? `?${params.join("&")}` : "");
  }

  function greenhouseId() {
    // Classic board: /<company>/jobs/<id>
    const fromPath = location.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
    if (fromPath) return `${fromPath[1]}:${fromPath[2]}`;

    // Embedded board, as used by company career sites that iframe Greenhouse:
    //   /embed/job_app?for=<company>&token=<jobPostId>&validityToken=<rotating>
    // The path carries no job id and the page exposes it only inside a JSON
    // blob, so without this the key falls back to the URL — and that URL
    // contains a token re-signed on every visit, which would file a fresh
    // history record each time and stop the already-evaluated check ever
    // firing. Reading for+token also produces exactly the same key as the
    // plain board URL for the same job, so it's recognised from either route.
    if (location.pathname.includes("/embed/")) {
      const params = new URLSearchParams(location.search);
      const board = params.get("for");
      const jobId = params.get("token") || params.get("gh_jid");
      if (board && jobId && /^\d+$/.test(jobId)) return `${board}:${jobId}`;
    }

    // my.greenhouse.io candidate portal: the posting is in a dialog and the
    // URL stays on /jobs/search, so look for the link the dialog's title
    // points at.
    const link = document.querySelector('a[href*="/jobs/"][href*="greenhouse"], [role="dialog"] a[href*="/jobs/"]');
    const fromLink = link && link.getAttribute("href").match(/\/(?:([^/]+)\/)?jobs\/(\d+)/);
    if (fromLink) return `${fromLink[1] || "portal"}:${fromLink[2]}`;

    return null;
  }

  // extracted: the { title, company, ... } the extractor just returned, used
  // only for the last-resort fallback below.
  function keyFor(extracted) {
    const host = location.hostname;

    if (host.includes("linkedin.com")) {
      const id = window.__jobFit && window.__jobFit.linkedinJobId && window.__jobFit.linkedinJobId();
      if (id) return `linkedin:${id}`;
    }

    if (host.includes("greenhouse.io")) {
      const id = greenhouseId();
      if (id) return `greenhouse:${id}`;
    }

    const jibeId = window.__jobFit && window.__jobFit.jibeJobId && window.__jobFit.jibeJobId();
    if (jibeId) return `jibe:${host.replace(/^www\./, "")}:${jibeId}`;

    // Last resort for a page whose URL identifies a *list*, not a job — the
    // Greenhouse portal's /jobs/search is the same href for every posting you
    // open in its dialog, so normalizing the URL there would file every job
    // under one key and overwrite each with the next. Falling back to the
    // posting's own title+company keeps them distinct. Deliberately narrow:
    // this is a no-id fallback, not cross-site content matching.
    if (extracted && (extracted.title || extracted.company)) {
      const looksLikeListing = /\/(search|search-results|jobs)\/?$/.test(location.pathname);
      if (looksLikeListing) {
        return `content:${hash(`${extracted.title || ""}|${extracted.company || ""}`)}`;
      }
    }

    return `url:${normalizedUrl()}`;
  }

  return { keyFor, normalizedUrl, hash };
})();
