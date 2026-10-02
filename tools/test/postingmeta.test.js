// Posting details (postingmeta.js): req id, deadline, posted date.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");
const ctx = { console, Date, Intl, navigator: { languages: ["en"] } };
vm.createContext(ctx);
for (const f of ["locales/en.js", "i18n.js", "postingmeta.js"]) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
vm.runInContext("this.JOB_FIT_META = JOB_FIT_META;", ctx);
const M = ctx.JOB_FIT_META;
let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) { fails++; console.log("FAIL", name, JSON.stringify(detail ?? "")); } else console.log("ok  ", name);
};
const NOW = new Date(2026, 9, 1, 15, 0).getTime(); // Oct 1 2026, 3pm local
const read = (text, opts = {}) => M.read(text, { now: NOW, ...opts });

let m = read("Requirements\n- C++\nJob ID: R-12345\nApply by October 15, 2026.");
check("req id from text", m.reqId === "R-12345", m);
check("deadline from 'apply by'", m.deadline === "2026-10-15", m);

m = read("Applications close on 15 de octubre de 2026", { country: "MX" });
check("spanish long date", m.deadline === "2026-10-15", m);
m = read("Fecha límite: 15/10/2026", { country: "MX" });
check("fecha límite numeric, day first", m.deadline === "2026-10-15", m);
m = read("Deadline: 05/10/2026");
check("ambiguous numeric, unknown country: no guess", m.deadline === null, m);
m = read("Deadline: 05/10/2026", { country: "US" });
check("ambiguous numeric, US: month first", m.deadline === "2026-05-10" || m.deadline === null, m); // May 10 is >60 days past → dropped
m = read("Deadline: 10/05/2026", { country: "US" });
check("US numeric", m.deadline === "2026-10-05", m);
m = read("Deadline: within 30 days, by Oct. 20th");
check("skips a non-month word, year inferred", m.deadline === "2026-10-20", m);
m = read("Applications close Sept 30");
check("just passed stays this year", m.deadline === "2026-09-30", m);
m = read("Applications close January 10");
check("january next year", m.deadline === "2027-01-10", m);
m = read("You will meet tight deadlines. Founded October 12, 1999.");
check("'deadlines' is not a label", m.deadline === null, m);
m = read("Date limite de candidature : 1er novembre 2026");
check("french 1er novembre", m.deadline === "2026-11-01", m);
m = read("Inscrições até 20 de outubro de 2026");
check("portuguese até", m.deadline === "2026-10-20", m);
m = read("time left to apply\nEnd Date: October 31, 2026 (30 days left to apply)");
check("workday end date", m.deadline === "2026-10-31", m);
m = read("blah", { fields: { detailsText: "posted on\nPosted 30+ Days Ago\ntime left to apply\n12 days left to apply\njob requisition id\nJR0099887" } });
check("workday details: days left", m.deadline === "2026-10-13", m);
check("workday details: req id", m.reqId === "JR0099887", m);
check("workday details: posted 30+ days, approx", m.postedOn === "2026-09-01" && m.postedApprox === true, m);

m = read("text", { jsonLd: { identifier: { "@type": "PropertyValue", name: "Garmin", value: "R0045678" }, validThrough: "2026-10-08T23:59:59", datePosted: "2026-08-20" } });
check("json-ld identifier", m.reqId === "R0045678", m);
check("json-ld validThrough", m.deadline === "2026-10-08", m);
check("json-ld datePosted", m.postedOn === "2026-08-20" && !m.postedApprox, m);
m = read("text", { jsonLd: { validThrough: "2099-12-31", datePosted: "2030-01-01" } });
check("placeholder dates dropped", m.deadline === null && m.postedOn === null, m);

m = read("x", { fields: { postedText: "Bellevue, WA · Reposted 1 week ago · 96 people clicked apply" } });
check("linkedin reposted 1 week ago", m.postedOn === "2026-09-24", m);
m = read("x", { fields: { postedText: "Ciudad de México · hace 3 semanas · Más de 100 solicitudes" } });
check("linkedin es hace 3 semanas", m.postedOn === "2026-09-10", m);
m = read("x", { fields: { postedText: "Paris · il y a 2 mois" } });
check("fr il y a 2 mois", m.postedOn === "2026-08-02", m);
m = read("x", { fields: { postedText: "São Paulo · há 5 dias" } });
check("pt há 5 dias", m.postedOn === "2026-09-26", m);
m = read("x", { fields: { postedText: "Just posted" } });
check("just posted", m.postedOn === "2026-10-01", m);
m = read("We shipped v2 two weeks ago and 3 weeks ago we raised money.");
check("free-text age needs a posted word", m.postedOn === null, m);
m = read("Posted 6 days ago\nAbout the role");
check("free-text posted N days ago", m.postedOn === "2026-09-25", m);
m = read("Published research at CVPR, October 2024. Date posted: September 2, 2026");
check("posted label, not 'published research'", m.postedOn === "2026-09-02", m);

// req id false positives
check("no id: reference designs", read("Build reference designs for 3 customers").reqId === null);
check("no id: requisition process", read("Own the requisition process for 2026 hiring").reqId === null);
check("no id: year", read("Job ID: 2026").reqId === null);
check("oracle job identification", read("Job Identification\n12345678").reqId === "12345678");
check("req #", read("Req # 45-112").reqId === "45-112");
check("french référence", read("Référence : 2026-0457AB").reqId === "2026-0457AB");
check("spanish id de la vacante", read("ID de la vacante: VAC-9912").reqId === "VAC-9912");

// helpers
check("daysUntil", M.daysUntil("2026-10-08", NOW) === 7);
check("closingSoon in window", M.closingSoon({ deadline: "2026-10-08" }, NOW) === 7);
check("closingSoon outside window", M.closingSoon({ deadline: "2026-10-09" }, NOW) === null);
check("closingSoon today", M.closingSoon({ deadline: "2026-10-01" }, NOW) === 0);
check("hasClosed", M.hasClosed({ deadline: "2026-09-30" }, NOW) && !M.hasClosed({ deadline: "2026-10-01" }, NOW));
check("old posting: 22 days → 3 weeks", M.oldPostingWeeks({ postedOn: "2026-09-09" }, NOW) === 3);
check("old posting: 21 days → none", M.oldPostingWeeks({ postedOn: "2026-09-10" }, NOW) === null);
// wording (describe)
let w = M.describe({ reqId: "R-1", deadline: "2026-10-04", postedOn: "2026-09-02", postedApprox: false }, { now: NOW });
check("describe: details", w.details.length === 3 && /R-1/.test(w.details[0]) && /Oct 4 \(in 3 days\)/.test(w.details[1]) && /Sep 2 \(4 weeks ago\)/.test(w.details[2]), w.details);
check("describe: closing-soon and age notes", /close in 3 days/.test(w.deadlineNote) && /4 weeks ago/.test(w.ageNote) && w.notes.length === 2, w);
w = M.describe({ deadline: "2026-10-04", postedOn: "2026-09-02" }, { now: NOW, applied: true });
check("describe: no notes once applied", w.notes.length === 0 && w.details.length === 2, w);
w = M.describe({ deadline: "2026-09-28" }, { now: NOW });
check("describe: closed", /closed/.test(w.details[0]) && /closed on/.test(w.deadlineNote), w);
w = M.describe({ postedOn: "2026-09-01", postedApprox: true }, { now: NOW });
check("describe: approx age", /or earlier/.test(w.details[0]) && /over 4 weeks/.test(w.ageNote), w);
w = M.describe({ deadline: "2027-01-10" }, { now: NOW });
check("describe: other year shows the year", /2027/.test(w.details[0]) && !w.deadlineNote, w);
check("describe: nothing", M.describe(null).details.length === 0 && M.describe(undefined).notes.length === 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
