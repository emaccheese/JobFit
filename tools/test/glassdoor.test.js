// Glassdoor (extractors/glassdoor.js), the shared reader list
// (extractors/sites.js), Glassdoor job keys, its compact ages and its job
// board. The page is a small stand-in DOM shaped like Glassdoor's search page
// (results list on the left, the selected job on the right), with made-up
// companies.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT, suite, load } = require("./support");

const { check, done } = suite("glassdoor");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

// --- a just-enough DOM ----------------------------------------------------------
// Selectors: tag and [attr], [attr="v"], [attr^="v"], [attr*="v"] compounds,
// joined by spaces (descendant). That's all the Glassdoor reader uses.
function el(tag, attrs = {}, children = []) {
  const node = { tagName: tag.toUpperCase(), attrs: { ...attrs }, children: [], parent: null };
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    const child = typeof c === "string" ? { text: c, parent: node } : c;
    child.parent = node;
    node.children.push(child);
  });
  Object.defineProperty(node, "id", { get: () => node.attrs.id || "", set: (v) => (node.attrs.id = v) });
  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
  node.setAttribute = (name, value) => (node.attrs[name] = String(value));
  Object.defineProperty(node, "textContent", {
    get: () => node.children.map((c) => (c.tagName ? c.textContent : c.text)).join(node.tagName === "UL" ? "\n" : " "),
  });
  Object.defineProperty(node, "innerText", { get: () => node.textContent });
  node.querySelectorAll = (selector) => queryAll(node, selector);
  node.querySelector = (selector) => queryAll(node, selector)[0] || null;
  node.closest = (selector) => {
    for (let n = node; n && n.tagName; n = n.parent) if (matchesAll(n, selector)) return n;
    return null;
  };
  return node;
}

function parseCompound(part) {
  const tag = (part.match(/^[a-z0-9]+/i) || [""])[0].toUpperCase();
  const attrs = [...part.matchAll(/\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/g)].map(([, name, op, value]) => ({ name, op, value }));
  return { tag, attrs };
}

function matchesCompound(node, { tag, attrs }) {
  if (!node.tagName || (tag && node.tagName !== tag)) return false;
  return attrs.every(({ name, op, value }) => {
    const v = node.getAttribute(name);
    if (v === null) return false;
    if (!op) return true;
    if (op === "=") return v === value;
    if (op === "^=") return v.startsWith(value);
    return v.includes(value);
  });
}

function matchesAll(node, selector) {
  return selector.split(",").some((one) => {
    const parts = one.trim().split(/\s+/).map(parseCompound);
    if (!matchesCompound(node, parts[parts.length - 1])) return false;
    let at = node.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (at && at.tagName && !matchesCompound(at, parts[i])) at = at.parent;
      if (!at || !at.tagName) return false;
      at = at.parent;
    }
    return true;
  });
}

function queryAll(root, selector) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (!c.tagName) continue;
      if (matchesAll(c, selector)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

// --- the page --------------------------------------------------------------------
const DESCRIPTION =
  "Northwind Robotics builds warehouse robots. You will design and run the services that coordinate the fleet. " +
  "Requirements: five years of backend development with Go or Rust, experience with distributed systems, " +
  "AWS, PostgreSQL and message queues. Nice to have: Kubernetes and robotics experience. " +
  "We offer remote work across Latin America, a learning budget and private health insurance for you and your family.";

function card(id, { company, title, age, selected = false }) {
  return el("li", { "data-test": "jobListing", "data-jobid": id, class: "JobsList_jobListItem__wjTHv" }, [
    el("div", { "data-test": "job-card-wrapper", "data-selected": String(selected), class: "JobCard_jobCardWrapper__vX29z" }, [
      el("span", { class: "EmployerProfile_compactEmployerName__9MGcV" }, company),
      el("a", { "data-test": "job-title", href: `https://www.glassdoor.com.mx/job-listing/x-JV_KO0,25.htm?jl=${id}` }, title),
      el("div", { "data-test": "job-age" }, age),
    ]),
  ]);
}

function page({ headerId = "1001", descriptionId = headerId, pay = "$40,000 - $55,000 (Proporcionado por el empleador)", description = DESCRIPTION } = {}) {
  const header = el("header", { "data-test": "job-details-header", "data-brandviews": `MODULE:n=joblisting-header:eid=0:jlid=${headerId}` }, [
    el("div", { class: "EmployerProfile_employerNameHeading__bXBYr" }, [el("h4", {}, "Northwind Robotics")]),
    el("h1", { id: `jd-job-title-${headerId}` }, "Senior Backend Engineer"),
    el("div", { "data-test": "location" }, "Trabajo desde casa"),
    el("div", { "data-test": "detailSalary" }, pay),
  ]);
  const qualifications = el("section", {}, [
    el("h2", { id: "verified-qualifications" }, "Tus cualificaciones para este empleo"),
    el("ul", {}, [el("li", {}, "Kubernetes"), el("li", {}, "Machine learning")]),
  ]);
  const descriptionModule = el("div", { "data-brandviews": `MODULE:n=joblisting-description:eid=0:jlid=${descriptionId}` }, [
    el("div", { class: "JobDetails_jobDescription__uW_fK JobDetails_blurDescription__vN7nh" }, description),
  ]);
  const salaryModule = el("div", { "data-brandviews": `MODULE:n=joblisting-salary:eid=0:jlid=${descriptionId}` }, [el("h2", {}, "Rango de sueldo base")]);
  const list = el("ul", {}, [
    card("1001", { company: "Northwind Robotics", title: "Senior Backend Engineer", age: "+ 30 d", selected: headerId === "1001" }),
    card("1002", { company: "Contoso Cloud", title: "Platform Engineer", age: "7 d", selected: headerId === "1002" }),
  ]);
  return el("body", {}, [list, el("div", { class: "TwoColumnLayout_jobDetailsContainer__qyvJZ" }, [header, qualifications, descriptionModule, salaryModule])]);
}

// Loads the readers into a context whose page is `body` at `url`.
function at(url, body, extraFiles = []) {
  const u = new URL(url);
  const ctx = {
    URL,
    URLSearchParams,
    Intl,
    console,
    location: { hostname: u.hostname, pathname: u.pathname, search: u.search, href: u.href },
    document: { title: "123 empleos | Glassdoor", body, querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.window.__jobFit = { textFrom: (node) => node.textContent.trim() };
  ["extractors/glassdoor.js", ...extraFiles].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  return ctx;
}

const SEARCH = "https://www.glassdoor.com.mx/Empleo/trabajo-desde-casa-software-engineer-empleos-SRCH_IL.0,18_IS12602_KO19,44.htm?uvk=abc&utm_source=jobsForYou";

// --- reading the job on screen -----------------------------------------------------
let ctx = at(SEARCH, page());
let job = ctx.window.__jobFit.glassdoor();
check("reads the selected job's title, company and location", job && job.title === "Senior Backend Engineer" && job.company === "Northwind Robotics" && job.location === "Trabajo desde casa", job);
check("reads the description", job && job.text.startsWith("Northwind Robotics builds warehouse robots"));
check("never the reader's own qualifications", job && !job.text.includes("Machine learning") && !job.text.includes("cualificaciones"));
check("nor the results list or the salary module", job && !job.text.includes("Contoso") && !job.text.includes("Rango de sueldo"));
check("adds the pay the employer gave", job && job.text.endsWith("Pay: $40,000 - $55,000 (Proporcionado por el empleador)"));
check("reads the posted age from the job's card", job && job.postingFields && job.postingFields.postedText === "+ 30 d", job && job.postingFields);
check("the job id comes from the detail pane", ctx.window.__jobFit.glassdoorJobId() === "1001");

ctx = at(SEARCH, page({ pay: "$38K - $52K (Estimación de Glassdoor)" }));
job = ctx.window.__jobFit.glassdoor();
check("leaves out Glassdoor's own pay estimate", job && !job.text.includes("Pay:") && !job.text.includes("38K"));

ctx = at(SEARCH, page({ headerId: "1002", descriptionId: "1001" }));
check("between jobs (new header, old description): nothing yet, not a mix", ctx.window.__jobFit.glassdoor() === null);
check("…but the job on screen is already the new one", ctx.window.__jobFit.glassdoorJobId() === "1002");
ctx = at(SEARCH, page({ headerId: "1002" }));
job = ctx.window.__jobFit.glassdoor();
check("after switching jobs, the new job's age", job && job.postingFields.postedText === "7 d");

ctx = at(SEARCH, page({ description: "Apply now." }));
check("a description too short to be one isn't read", ctx.window.__jobFit.glassdoor() === null);
ctx = at("https://www.example.com/careers/1", page());
check("not on other sites, even with the same markup", ctx.window.__jobFit.glassdoor() === null && ctx.window.__jobFit.glassdoorJobId() === null);
ctx = at("https://www.glassdoor.com/job-listing/x-JV_KO0,25.htm?jl=1003", el("body", {}, []));
check("a job page's address gives the id when the pane has none", ctx.window.__jobFit.glassdoorJobId() === "1003");

// --- the shared reader list and the job key ------------------------------------------------
ctx = at(SEARCH, page(), ["extractors/sites.js", "jobkey.js"]);
const site = ctx.window.__jobFit.readSite();
check("the shared reader list picks Glassdoor", site && site.name === "glassdoor");
ctx.JOB_FIT_JOBKEY = vm.runInContext("JOB_FIT_JOBKEY", ctx);
check("the job key is Glassdoor's listing id", ctx.JOB_FIT_JOBKEY.keyFor(site.result) === "glassdoor:1001");
check("…and the on-page button can see which job is on screen", ctx.window.__jobFit.jobOnScreen() === "1001");
const com = at("https://www.glassdoor.com/Job/remote-software-engineer-jobs-SRCH_IL.0,6.htm", page(), ["extractors/sites.js", "jobkey.js"]);
const comKey = vm.runInContext("JOB_FIT_JOBKEY", com).keyFor(com.window.__jobFit.readSite().result);
check("the same job on glassdoor.com has the same key", comKey === "glassdoor:1001");

const throwing = { window: {}, location: { hostname: "www.glassdoor.com" } };
throwing.window = throwing;
vm.createContext(throwing);
throwing.__jobFit = { glassdoor: () => { throw new Error("odd markup"); }, workday: () => ({ title: "From Workday" }) };
vm.runInContext(read("extractors/sites.js"), throwing);
let threw = false;
try {
  throwing.__jobFit.readSite();
} catch (err) {
  threw = true;
}
check("a reader that throws fails an evaluation (it's a bug to see)", threw);
check("…but the popup and on-page button move on to the next reader", throwing.__jobFit.readSite({ safe: true }).name === "workday");

// --- Glassdoor's compact ages ---------------------------------------------------------------
const meta = load(["postingmeta.js"]).JOB_FIT_META;
const age = (t, o) => JSON.stringify(meta.parseAge(t, o));
check('"7 d" is seven days', age("7 d") === JSON.stringify({ days: 7, approx: false }));
check('"+ 30 d" is at least thirty', age("+ 30 d") === JSON.stringify({ days: 30, approx: true }));
check('"30d+" is at least thirty', age("30d+") === JSON.stringify({ days: 30, approx: true }));
check('"24 h" is today', age("24 h") === JSON.stringify({ days: 0, approx: false }));
check("a compact age in a posting's text is not a posting date", meta.parseAge("Ship features within 7 d of a request.", { strict: true }) === null && meta.parseAge("7 d", { strict: true }) === null);

// --- the job board ----------------------------------------------------------------------------
const boards = load(["boards.js"]).JOB_FIT_BOARDS;
check("Glassdoor is a job board for the on-page button", Boolean(boards.byId("glassdoor")));
check(
  "…covering its country sites",
  ["https://www.glassdoor.com.mx/Empleo/x.htm", "https://www.glassdoor.com/Job/x.htm", "https://www.glassdoor.ca/Job/x.htm", "https://www.glassdoor.com.br/Vaga/x.htm"].every(
    (u) => boards.boardForUrl(u) && boards.boardForUrl(u).id === "glassdoor"
  )
);
check("…and nothing else", boards.boardForUrl("https://glassdoor.example.com/") === null);

// --- every reader is injected where it's used ---------------------------------------------------
const inject = read("inject.js");
check("glassdoor.js and sites.js are injected, sites.js after every reader", /"extractors\/eightfold\.js",\s*"extractors\/glassdoor\.js",\s*"extractors\/sites\.js",\s*"jobkey\.js"/.test(inject));
const chains = ["content.js", "popup.js", "float.js"].filter((f) => !read(f).includes("readSite("));
check("the evaluation, the popup and the on-page button all use the shared list", chains.length === 0, chains);

done();
