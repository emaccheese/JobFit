// The generic reader (extractors/generic.js), the fallback for sites without
// their own: it reads a page only when it looks like a job posting, never a
// LinkedIn profile or the feed, and "Evaluate anyway" reads one regardless.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT, suite } = require("./support");

const { check, done } = suite("generic");
const source = fs.readFileSync(path.join(EXT, "extractors/generic.js"), "utf8");

// The page's text is what textFrom would return; the DOM around it is only
// what findRoot looks at (no dialogs, so the body).
function pageAt(url, text, { jobPostingJsonLd = false, forcedPage = null } = {}) {
  const u = new URL(url);
  const ctx = {
    location: { hostname: u.hostname, pathname: u.pathname, search: u.search, href: u.href },
    document: { title: "Page title", body: {}, querySelectorAll: () => [] },
    JOB_FIT_META: { jsonLdNodes: () => (jobPostingJsonLd ? [{ "@type": "JobPosting" }] : []) },
  };
  ctx.window = ctx;
  ctx.window.__jobFit = { textFrom: () => text, forcedPage };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "extractors/generic.js" });
  return ctx.window.__jobFit.generic;
}

// About 250 words of prose, so length alone never decides.
const filler = (topic) => Array.from({ length: 25 }, (_, i) => `${topic} sentence number ${i} goes on for a while here.`).join(" ");

const posting = [
  "Senior Backend Engineer",
  filler("Company intro"),
  "Responsibilities",
  "Build and run distributed services in Go.",
  "Requirements:",
  "Five years with Go. Experience with AWS.",
  "Benefits",
  "Health insurance and a learning budget.",
].join("\n");

const profile = [
  "Sam Rivera",
  "Backend engineer · Open to work",
  "About",
  filler("Profile"),
  "Experience",
  "Senior Engineer at Contoso Cloud",
  "Responsibilities",
  "Led the payments team.",
  "Requirements",
  "Wrote the hiring requirements for the team.",
  "Skills",
  "Go · AWS · Kubernetes",
].join("\n");

const article = [
  "Why hiring is slow this year",
  filler("Article"),
  "The requirements companies list have grown longer, and the responsibilities of each role broader, according to a survey of recruiters across the region.",
  filler("More"),
].join("\n");

// --- LinkedIn: only job pages ------------------------------------------------
let read = pageAt("https://www.linkedin.com/in/sam-rivera/", profile);
check("LinkedIn profile is not a posting", read() === null);
check("…even with posting-like headings in it", read() === null);
check("…but Evaluate anyway reads it", Boolean(read({ force: true })));
read = pageAt("https://www.linkedin.com/feed/", posting);
check("LinkedIn feed is not a posting", read() === null);
read = pageAt("https://www.linkedin.com/company/contoso/", posting);
check("LinkedIn company page is not a posting", read() === null);
read = pageAt("https://mx.linkedin.com/in/sam-rivera/", profile);
check("…on a country subdomain too", read() === null);
read = pageAt("https://www.linkedin.com/jobs/view/4435682676/", posting);
check("LinkedIn job page the LinkedIn reader missed still falls back", Boolean(read()));
read = pageAt("https://www.linkedin.com/in/sam-rivera/", profile, { forcedPage: "https://www.linkedin.com/in/sam-rivera/" });
check("a page evaluated anyway stays readable (its result can be shown)", Boolean(read()));
read = pageAt("https://www.linkedin.com/in/sam-rivera/", profile, { forcedPage: "https://www.linkedin.com/in/someone-else/" });
check("…only at the address it was evaluated at", read() === null);

// --- other sites: signs of a posting -----------------------------------------
read = pageAt("https://careers.northwind.example/jobs/42", posting);
const result = read();
check("career page with posting sections is read", Boolean(result) && result.text === posting);
read = pageAt("https://news.example/hiring-is-slow", article);
check("news article is not a posting", read() === null);
check("…the words in a sentence don't count as headings", read() === null);
check("…Evaluate anyway reads it", Boolean(read({ force: true })));
read = pageAt("https://careers.northwind.example/jobs/43", `${filler("Plain")}\nApply on our site.`, { jobPostingJsonLd: true });
check("a page with JobPosting markup is read without headings", Boolean(read()));
read = pageAt("https://careers.northwind.example/jobs/44", `${filler("Plain")}\nResponsibilities\nBuild things.`);
check("one posting section alone isn't enough", read() === null);

const es = ["Ingeniera de datos", filler("Empresa"), "Responsabilidades:", "Diseñar flujos de datos.", "Requisitos", "Tres años con Python.", "Lo que ofrecemos", "Prestaciones de ley."].join("\n");
check("Spanish posting is read", Boolean(pageAt("https://empleos.tierraviva.example/vacante/7", es)()));
const fr = ["Développeur", filler("Entreprise"), "Vos missions", "Construire des services.", "Profil recherché", "Trois ans d'expérience."].join("\n");
check("French posting is read", Boolean(pageAt("https://emplois.example.fr/offre/9", fr)()));
const pt = ["Desenvolvedora", filler("Empresa"), "Atribuições", "Construir serviços.", "Requisitos", "Três anos com Go.", "Benefícios", "Vale-refeição."].join("\n");
check("Portuguese posting is read", Boolean(pageAt("https://vagas.marisol.example/vaga/3", pt)()));

// --- too short is too short, even anyway --------------------------------------
read = pageAt("https://news.example/short", "Responsibilities\nRequirements\nA few words.");
check("a short page isn't read, even anyway", read() === null && read({ force: true }) === null);

done();
