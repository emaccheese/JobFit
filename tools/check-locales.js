#!/usr/bin/env node
// Checks the translation catalogs in job-fit-evaluator/locales/:
//  - every key the code and HTML use exists in English;
//  - Spanish, French and Portuguese have exactly the English keys;
//  - each translation uses the same {placeholders} and the same shape
//    (plain string vs { one, other }) as English.
// Keys built at runtime (`verdict.${v}` and the like) are listed in DYNAMIC.
//
// Usage: node tools/check-locales.js   (exits 1 on any problem)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "job-fit-evaluator");
const LANGS = ["en", "es", "fr", "pt"];

const each = (prefix, items) => items.map((i) => `${prefix}.${i}`);
const DYNAMIC = [
  ...each("arrangement", ["remote", "hybrid", "onsite"]),
  ...each("auth", ["citizen", "permit", "sponsor"]),
  ...each("boards", ["linkedin.desc", "indeed.desc", "greenhouse.desc", "workday.desc"]),
  ...each("history", ["countStale", "countDup", "countJobs"]),
  ...each("period", ["year", "month", "hour", "per.year", "per.month", "per.hour"]),
  ...each("profileLabel", ["core", "specialisms", "tooling", "leadership", "gaps", "workAuth", "target"]),
  ...each("qstate", ["pending", "processing", "done", "failed", "cancelled"]),
  ...each("salaryVs", ["within", "below", "above", "unknown"]),
  ...each("status", ["not_applied", "applied", "interviewing", "offer", "rejected", "ghosted", "withdrawn"]),
  ...["economy", "balanced", "best"].flatMap((id) => [`tier.${id}.label`, `tier.${id}.blurb`]),
  ...each("tz", ["ET", "CT", "MT", "PT"]),
  ...each("verdict", ["apply", "borderline", "skip"]),
  ...each("wiz.step", ["welcome", "where", "about", "work", "model", "profile", "salary", "rejects", "warnings", "flags", "review"]),
  "common.min",
  "common.max",
  "profile.template",
  "bg.openaiTimeoutFlex",
];

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" || e.name === "_locales" ? [] : sourceFiles(full);
    // i18n.js documents t("key") in its comments; it defines keys, not uses them.
    return /\.(js|html)$/.test(e.name) && e.name !== "i18n.js" ? [full] : [];
  });
}

const used = new Set(DYNAMIC);
for (const file of sourceFiles(root)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/\b(?:t|tr|JOB_FIT_I18N\.t|JOB_FIT_I18N\.has)\(\s*["']([\w.]+)["']/g)) used.add(m[1]);
  for (const m of text.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([\w.]+)"/g)) used.add(m[1]);
}
// Preset labels are looked up by id.
const keywords = fs.readFileSync(path.join(root, "keywords.js"), "utf8");
for (const m of keywords.matchAll(/id: "(\w+)"/g)) used.add(`preset.${m[1]}.label`).add(`preset.${m[1]}.example`);

const context = {};
vm.createContext(context);
for (const lang of LANGS) vm.runInContext(fs.readFileSync(path.join(root, "locales", `${lang}.js`), "utf8"), context);
const catalogs = context.JOB_FIT_MESSAGES;

const problems = [];
const placeholders = (v) => new Set((typeof v === "object" ? Object.values(v).join(" ") : v).match(/\{\w+\}/g) || []);

for (const key of used) if (!(key in catalogs.en)) problems.push(`en: missing "${key}" (used in code)`);
for (const lang of LANGS.slice(1)) {
  const cat = catalogs[lang];
  for (const key of Object.keys(catalogs.en)) {
    if (!(key in cat)) {
      problems.push(`${lang}: missing "${key}"`);
      continue;
    }
    if (typeof cat[key] !== typeof catalogs.en[key]) problems.push(`${lang}: "${key}" is a ${typeof cat[key]}, English is a ${typeof catalogs.en[key]}`);
    const want = placeholders(catalogs.en[key]);
    for (const p of placeholders(cat[key])) if (!want.has(p)) problems.push(`${lang}: "${key}" has unknown ${p}`);
  }
  for (const key of Object.keys(cat)) if (!(key in catalogs.en)) problems.push(`${lang}: extra "${key}"`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`OK: ${used.size} keys used, ${Object.keys(catalogs.en).length} in each of ${LANGS.join(", ")}.`);
