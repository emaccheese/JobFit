// Duplicate detection and posting-details merge (evalstore.js).
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");
const ctx = { console, chrome: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, "evalstore.js"), "utf8") + "\nthis.S = JOB_FIT_EVALSTORE;", ctx);
const S = ctx.S;
let fails = 0;
const check = (name, cond, detail) => {
  if (!cond) { fails++; console.log("FAIL", name, JSON.stringify(detail ?? "")); } else console.log("ok  ", name);
};

// Deterministic word soup: `seed` picks the words, so two seeds share nothing.
const VOCAB = "alpha beta gamma delta epsilon zeta theta iota kappa lambda omicron sigma tau upsilon phi chi psi omega river stone cloud field ember frost grove harbor island jungle meadow orchard prairie quarry ridge summit tundra valley willow canyon delta forest glacier".split(" ");
function soup(seed, n) {
  let x = seed * 9301 + 49297;
  const out = [];
  for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; out.push(VOCAB[x % VOCAB.length] + (x % 7)); }
  return out.join(" ");
}
const role = soup(1, 300);
const boiler = soup(2, 120);
const otherRole = soup(3, 300);
const rec = (jobKey, o) => ({ jobKey, company: "Garmin", location: "Olathe, KS", ...o });

let groups = S.duplicateGroups([
  rec("linkedin:1", { title: "Sr. Software Engineer - Remote", text: `${role} ${boiler}` }),
  rec("workday:garmin:R100", { title: "Senior Software Engineer (Hybrid)", text: role }),
]);
check("sr vs senior, - Remote vs (Hybrid): duplicates", groups.has("linkedin:1"), [...groups.keys()]);

groups = S.duplicateGroups([
  rec("linkedin:2", { title: "Imaging Engineer", text: role, meta: { reqId: "R-100" } }),
  rec("workday:garmin:R100", { title: "Software Engineer III, Imaging", text: otherRole }),
]);
check("same req id (R-100 vs workday key R100), different titles and text: duplicates", groups.has("linkedin:2"));

groups = S.duplicateGroups([
  rec("workday:garmin:R200", { title: "Software Engineer II", text: role, location: "Austin, TX" }),
  rec("workday:garmin:R201", { title: "Software Engineer II", text: role, location: "Seattle, WA" }),
]);
check("same role, two req ids: not duplicates", groups.size === 0);

const mostlyRole = `${role.split(" ").slice(0, 210).join(" ")} ${soup(4, 90)}`; // ~70% shared
groups = S.duplicateGroups([
  rec("a", { title: "Graphics Engineer", text: role }),
  rec("b", { title: "Camera Firmware Engineer", text: mostlyRole }),
]);
check("different titles at 70% shared text: not duplicates", groups.size === 0);
groups = S.duplicateGroups([
  rec("a", { title: "Graphics Engineer", text: role }),
  rec("b", { title: "Graphics Engineer", text: mostlyRole }),
]);
check("same title at 70% shared text: duplicates", groups.size === 2);
groups = S.duplicateGroups([
  rec("a", { title: "Graphics Engineer", text: role }),
  rec("b", { title: "Engineer, Graphics Rendering", text: `${role} ${soup(5, 10)}` }),
]);
check("retitled copy with near-identical text: duplicates", groups.size === 2);

groups = S.duplicateGroups([
  rec("a", { title: "Graphics Engineer", text: role }),
  rec("b", { title: "Graphics Engineer", text: role, company: "NVIDIA" }),
]);
check("different companies: never", groups.size === 0);

groups = S.duplicateGroups([
  rec("a", { title: "Graphics Engineer", text: role, notDuplicateOf: ["b"] }),
  rec("b", { title: "Graphics Engineer", text: role }),
]);
check("'not a duplicate' still respected", groups.size === 0);

groups = S.duplicateGroups([
  rec("a", { title: "Engineering Manager" }),
  rec("b", { title: "Manager, Engineering & Ops", location: "Olathe" }),
  rec("c", { title: "Manager, Engineering", location: "Olathe, Kansas" }),
]);
check("no text: title words in any order + same city", groups.has("a") && groups.has("c") && !groups.has("b"), [...groups.keys()]);

check("titleKey sr/jr", S.titleKey("Sr. Developer") === S.titleKey("Senior Developer") && S.titleKey("Jr Dev") === S.titleKey("Junior Developer"));
check("titleKey keeps level numerals", S.titleKey("Software Engineer II") !== S.titleKey("Software Engineer III"));
check("titleKey: leading 'Remote -' falls back to whole title", S.titleKey("Remote - Senior Engineer") === S.titleKey("Senior Engineer"));
check("titleKey keeps C++ and .NET", S.titleKey("C++ Developer") !== S.titleKey("C Developer") && S.titleKey(".NET Developer") === ".net developer");

const three = S.duplicateGroups([
  rec("x1", { title: "Graphics Engineer", text: role }),
  rec("x2", { title: "Graphics Engineer", text: role }),
  rec("x3", { title: "Sr. Graphics Engineer", text: role, meta: { reqId: "Z9" } }),
]);
const sets = S.duplicateSets(three);
check("three copies, one set", new Set(sets.values()).size === 1 && sets.size === 3, [...sets]);

const candidate = rec("indeed:abc", { title: "Graphics Engineer", text: role });
const pool = [
  rec("linkedin:old", { title: "Graphics Engineer", text: role, evaluation: { score: 70 }, score: 70, lastEvaluatedAt: 1000 }),
  rec("greenhouse:new", { title: "Graphics Engineer", text: role, evaluation: { score: 78 }, score: 78, lastEvaluatedAt: 2000 }),
  rec("jibe:rej", { title: "Graphics Engineer", text: role, hardReject: { label: "x" }, score: 0, lastEvaluatedAt: 3000 }),
  rec("url:summary", { title: "Graphics Engineer", text: role, score: null, evaluation: null, lastSummarizedAt: 4000 }),
];
const d = S.scoredDuplicateOf(candidate, pool);
check("scoredDuplicateOf: newest model score, rejects and summaries skipped", d && d.jobKey === "greenhouse:new", d && d.jobKey);
pool.push(rec("greenhouse:applied", { title: "Graphics Engineer", text: role, evaluation: { score: 60 }, score: 60, lastEvaluatedAt: 500, status: "applied" }));
check("scoredDuplicateOf: a copy you applied to comes first", S.scoredDuplicateOf(candidate, pool).jobKey === "greenhouse:applied");
pool.pop();
check("scoredDuplicateOf: nothing scored", S.scoredDuplicateOf(candidate, pool.slice(2)) === null);

const m = S.mergeMeta({ reqId: "R1", deadline: "2026-10-10", postedOn: "2026-09-01", postedApprox: true }, { reqId: null, deadline: null, postedOn: "2026-09-02", postedApprox: false });
check("mergeMeta keeps what the new read lacks", m.reqId === "R1" && m.deadline === "2026-10-10" && m.postedOn === "2026-09-02" && m.postedApprox === false, m);
check("mergeMeta with nothing new", S.mergeMeta({ reqId: "R1" }, undefined).reqId === "R1");
check("mergeMeta with nothing old", S.mergeMeta(null, { reqId: "R2" }).reqId === "R2");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
