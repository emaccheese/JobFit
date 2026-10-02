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

if (fails) process.exit(1);
