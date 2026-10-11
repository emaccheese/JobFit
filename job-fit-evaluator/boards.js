// The job boards the on-page button can be switched on for as a whole, each
// with the Chrome match pattern that covers every page of it. Shared by the
// service worker (which registers the button for them), the popup and
// Settings (which ask for them) and float.js (which checks it's wanted here).
//
// A board is one permission for what would otherwise be dozens of sites:
// Indeed has a subdomain per country, LinkedIn's public job pages have one
// too, and every employer on Workday has its own tenant. Company career sites
// (Jibe, Eightfold, a Greenhouse board embedded on the company's own domain)
// live on the company's domain and stay per site.
//
// Assigned with var so re-injection doesn't throw.
var JOB_FIT_BOARDS = (function () {
  const BOARDS = [
    { id: "linkedin", name: "LinkedIn", patterns: ["https://*.linkedin.com/*"] },
    { id: "indeed", name: "Indeed", patterns: ["https://*.indeed.com/*"] },
    // Already in the manifest's host_permissions (for embedded boards), so
    // Chrome grants it without asking and can't take it back.
    { id: "greenhouse", name: "Greenhouse", patterns: ["https://*.greenhouse.io/*"], alwaysGranted: true },
    { id: "workday", name: "Workday", patterns: ["https://*.myworkdayjobs.com/*"] },
    // A site per country, and a match pattern can't leave the ending open:
    // the Americas and the countries of Tino's languages.
    {
      id: "glassdoor",
      name: "Glassdoor",
      patterns: [
        "https://*.glassdoor.com/*",
        "https://*.glassdoor.ca/*",
        "https://*.glassdoor.com.mx/*",
        "https://*.glassdoor.com.br/*",
        "https://*.glassdoor.com.ar/*",
        "https://*.glassdoor.co.uk/*",
        "https://*.glassdoor.fr/*",
        "https://*.glassdoor.es/*",
        "https://*.glassdoor.de/*",
      ],
    },
  ];
  const IDS = BOARDS.map((b) => b.id);

  function byId(id) {
    return BOARDS.find((b) => b.id === id) || null;
  }

  // Chrome's match-pattern rules, for the patterns above: a scheme, a host
  // that may start with "*." (the domain itself or any subdomain), any path.
  function patternMatches(pattern, url) {
    const m = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(pattern);
    if (!m) return false;
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      return false;
    }
    const [, scheme, host] = m;
    if (scheme === "*" ? !/^https?:$/.test(u.protocol) : u.protocol !== `${scheme}:`) return false;
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      return u.hostname === base || u.hostname.endsWith(`.${base}`);
    }
    return u.hostname === host;
  }

  // The board a page (or an origin) belongs to, if any.
  function boardForUrl(url) {
    const href = /^https?:\/\/[^/]+$/.test(String(url)) ? `${url}/` : url;
    return BOARDS.find((b) => b.patterns.some((p) => patternMatches(p, href))) || null;
  }

  // Whether the on-page button is wanted on this page: its origin was switched
  // on by itself, or it's on a board that was.
  function enabledFor(url, { sites = [], boards = [] } = {}) {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch (err) {
      return false;
    }
    if (sites.includes(origin)) return true;
    const board = boardForUrl(url);
    return Boolean(board && boards.includes(board.id));
  }

  return { BOARDS, IDS, byId, patternMatches, boardForUrl, enabledFor };
})();
