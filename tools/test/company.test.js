// Company history (evalstore.js): counts, copies counted once, the note.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");
const ctx = { console, chrome: {}, navigator: { languages: ["en"] }, Intl };
vm.createContext(ctx);
for (const f of ["locales/en.js", "i18n.js", "evalstore.js"]) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
vm.runInContext("this.S = JOB_FIT_EVALSTORE;", ctx);
const S = ctx.S;
let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) { fails++; console.log("FAIL", name, JSON.stringify(detail ?? "")); } else console.log("ok  ", name);
};

const VOCAB = "alpha beta gamma delta epsilon zeta theta iota kappa lambda omicron sigma tau upsilon phi chi psi omega river stone cloud field ember frost grove harbor island jungle meadow orchard".split(" ");
function soup(seed, n) {
  let x = seed * 7919 + 104729;
  const out = [];
  for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; out.push(VOCAB[x % VOCAB.length] + (x % 11)); }
  return out.join(" ");
}
const job = (jobKey, title, seed, o = {}) => ({ jobKey, title, company: "Garmin", location: "Olathe, KS", text: soup(seed, 250), status: "not_applied", ...o });

const current = job("linkedin:cur", "Embedded Software Engineer", 1);
const records = [
  current,
  job("workday:garmin:R1", "Embedded Software Engineer", 1, { status: "applied", statusChangedAt: 10 }), // copy of current: left out
  job("linkedin:b", "Graphics Engineer", 2, { status: "rejected", statusChangedAt: 100 }),
  job("workday:garmin:R2", "Sr. Graphics Engineer", 2, { status: "applied", statusChangedAt: 50 }), // copy of b: one application
  job("linkedin:c", "Camera Engineer", 3, { status: "rejected", statusChangedAt: 200, company: "Garmin Ltd." }),
  job("linkedin:d", "Firmware Engineer", 4, { status: "applied", statusChangedAt: 300 }),
  job("linkedin:e", "Test Engineer", 5),
  job("linkedin:f", "Offer Role", 6, { status: "offer", statusChangedAt: 400 }),
  job("linkedin:other", "Graphics Engineer", 7, { company: "NVIDIA", status: "rejected" }),
];

const h = S.companyHistory(records, "Garmin", { exclude: ["linkedin:cur", "workday:garmin:R1"] });
check("copies count once, last change wins", h.counts.rejected === 2 && h.counts.applied === 1 && h.counts.offer === 1, h);
check("tracked counts jobs, not copies", h.tracked === 5, h);
check("legal suffix matched, other company not", h.applied === 4, h);

const note = S.companyHistoryNote(records, current);
check("note leaves out the job and its copies", note === "At Garmin: 1 offer · 1 awaiting a reply · 2 rejections — 5 other jobs tracked there.", note);

const quiet = [current, job("linkedin:x", "Other", 8), job("linkedin:y", "Another", 9)];
check("nothing past Not applied: no note", S.companyHistoryNote(quiet, current) === null);
check("no company: no note", S.companyHistoryNote(records, { ...current, company: "" }) === null);
check("only its own copy applied: no note", S.companyHistoryNote(records.slice(0, 2), current) === null);
const one = [current, job("linkedin:z", "Data Engineer", 10, { status: "ghosted", statusChangedAt: 5 })];
check("singular wording", S.companyHistoryNote(one, current) === "At Garmin: 1 never answered — 1 other job tracked there.", S.companyHistoryNote(one, current));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
