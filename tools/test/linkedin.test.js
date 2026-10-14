// LinkedIn job ids (extractors/linkedin.js): the id history is keyed on.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");
const source = fs.readFileSync(path.join(EXT, "extractors/linkedin.js"), "utf8");
let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) { fails++; console.log("FAIL", name, JSON.stringify(detail ?? "")); } else console.log("ok  ", name);
};

function jobIdAt(url) {
  const u = new URL(url);
  const ctx = { URLSearchParams, URL, location: { pathname: u.pathname, search: u.search, href: u.href } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "extractors/linkedin.js" });
  return ctx.window.__jobFit.linkedinJobId();
}

let id = jobIdAt("https://www.linkedin.com/jobs/view/4435682676/");
check("signed-in /jobs/view/<id>/", id === "4435682676", id);
id = jobIdAt("https://www.linkedin.com/jobs/view/4435682676");
check("no trailing slash", id === "4435682676", id);
id = jobIdAt("https://www.linkedin.com/jobs/view/senior-software-engineer-c%2B%2B-market-data-at-flow-traders-4435682676");
check("signed-out slug before the id", id === "4435682676", id);
id = jobIdAt("https://www.linkedin.com/jobs/view/senior-engineer-at-3m-4435682676?refId=abc&trackingId=x");
check("slug with digits, and a query", id === "4435682676", id);
id = jobIdAt("https://mx.linkedin.com/jobs/view/ingeniero-c%2B%2B-senior-at-acme-4435682676/?originalSubdomain=mx");
check("country subdomain, trailing slash", id === "4435682676", id);
id = jobIdAt("https://www.linkedin.com/jobs/search/?keywords=c%2B%2B&currentJobId=4450733192");
check("search panel: currentJobId wins", id === "4450733192", id);
id = jobIdAt("https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4450733192");
check("collections panel", id === "4450733192", id);
id = jobIdAt("https://www.linkedin.com/jobs/view/senior-engineer-at-acme/");
check("slug without an id: none, not a guess", id === null, id);
id = jobIdAt("https://www.linkedin.com/jobs/search/?keywords=c%2B%2B");
check("search with no job selected", id === null, id);


// --- the 2026 search page: title, company and description ------------------------
// A made-up page shaped like LinkedIn's newer layout: a logo link to the company
// with no text, the company's name beside it, the title as a link to the job,
// and the job pane's parts tagged with the job's id.
const { el } = require("./support");
const DESCRIPTION = Array.from({ length: 30 }, (_, i) => `Build and run the services behind the fleet, part ${i}.`).join(" ");

function newLayout({ paneId = "111", tab = "Senior Backend Engineer | Northwind Robotics | LinkedIn" } = {}) {
  const company = "https://www.linkedin.com/company/northwind/life/";
  const header = el("div", {}, [
    el("a", { href: company }, []),
    el("p", {}, "Northwind Robotics"),
    el("a", { href: company }, "Northwind Robotics"),
    el("a", { href: `https://www.linkedin.com/jobs/view/${paneId}/?trackingId=abc` }, "Senior Backend Engineer"),
    el("p", {}, "Responses managed off LinkedIn"),
    el("p", {}, "Remote, Mexico · Reposted 3 days ago · 40 people clicked apply"),
    el("a", { href: `https://www.linkedin.com/jobs/search-results/?currentJobId=${paneId}` }, "Remote"),
  ]);
  const aboutJob = el("div", { componentkey: `JobDetails_AboutTheJob_${paneId}` }, [
    el("h2", {}, "About the job"),
    el("span", { "data-testid": "expandable-text-box" }, DESCRIPTION),
  ]);
  const aboutCompany = el("div", { componentkey: `JobDetails_AboutTheCompany_${paneId}` }, [
    el("span", { "data-testid": "expandable-text-box" }, "Northwind builds warehouse robots. ".repeat(30)),
  ]);
  return { body: el("body", {}, [el("div", {}, [header, aboutJob, aboutCompany])]), tab };
}

function readAt(url, { body, tab }) {
  const u = new URL(url);
  const ctx = {
    URL,
    URLSearchParams,
    location: { hostname: u.hostname, pathname: u.pathname, search: u.search, href: u.href },
    document: { title: tab, querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) },
  };
  ctx.window = ctx;
  ctx.__jobFit = { textFrom: (node) => node.textContent.trim() };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "extractors/linkedin.js" });
  return ctx.__jobFit.linkedin();
}

const SEARCH = "https://www.linkedin.com/jobs/search-results/?currentJobId=111&keywords=go";
let job = readAt(SEARCH, newLayout());
check("2026 layout: the title is the job's link, not the company's name beside the logo", job && job.title === "Senior Backend Engineer", job && job.title);
check("…the company comes from the link that has text (the logo's has none)", job && job.company === "Northwind Robotics", job && job.company);
check("…the description is About the job, not About the company", job && job.text.startsWith("Build and run") && !job.text.includes("warehouse robots"));
check("…the location and the reposted date come from the header's line", job && job.location === "Remote, Mexico" && /Reposted 3 days ago/.test(job.postingFields.postedText), job);
job = readAt("https://www.linkedin.com/jobs/search-results/?currentJobId=222&keywords=go", newLayout({ paneId: "111" }));
check("while the next job loads (the pane is still the last one's): nothing, not a mix", job === null);
job = readAt(SEARCH, newLayout({ tab: "Staff Engineer | Contoso Cloud | LinkedIn" }));
check("a tab title that disagrees with the page isn't used", job && job.title === "Senior Backend Engineer" && job.company === "Northwind Robotics", job);
job = readAt(SEARCH, newLayout({ tab: "Go jobs in Mexico | LinkedIn" }));
check("a tab title naming the search isn't used", job && job.title === "Senior Backend Engineer");
job = readAt("https://www.linkedin.com/jobs/view/111/", newLayout());
check("the job's own page reads the same", job && job.title === "Senior Backend Engineer" && job.company === "Northwind Robotics");

// The older layout: no tagged sections, one description box.
const older = el("body", {}, [
  el("div", {}, [
    el("h1", {}, [el("a", { href: "https://www.linkedin.com/jobs/view/333/" }, "Platform Engineer")]),
    el("a", { href: "https://www.linkedin.com/company/contoso/" }, "Contoso Cloud"),
    el("p", {}, "Toronto, ON · 2 days ago · 12 applicants"),
  ]),
  el("div", { "data-testid": "expandable-text-box" }, DESCRIPTION),
]);
job = readAt("https://www.linkedin.com/jobs/search/?currentJobId=333", { body: older, tab: "Platform engineer jobs | LinkedIn" });
check("the older layout still reads", job && job.title === "Platform Engineer" && job.company === "Contoso Cloud" && job.location === "Toronto, ON", job);

if (fails) process.exit(1);
