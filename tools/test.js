#!/usr/bin/env node
// Runs every JobFit check: a syntax check of each extension script, every
// suite in tools/test/ (each in its own process, so one that throws can't take
// the others down), and the locale catalogs.
//
// Usage: node tools/test.js [name-filter]   (exits 1 on any failure)
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const ext = path.join(root, "job-fit-evaluator");
const filter = process.argv[2] || "";
let failed = 0;

function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "_locales" ? [] : scripts(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

function report(name, result) {
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  const passes = (out.match(/^ok {2}/gm) || []).length;
  if (result.status === 0) {
    console.log(`  ok    ${name}${passes ? ` (${passes} checks)` : ""}`);
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}`);
  const failures = out.split("\n").filter((line) => line.startsWith("FAIL"));
  console.log((failures.length ? failures : out.trim().split("\n").slice(-15)).map((l) => `        ${l}`).join("\n"));
}

if (!filter) {
  const bad = scripts(ext).filter((file) => spawnSync(process.execPath, ["--check", file]).status !== 0);
  report("syntax of every extension script", { status: bad.length ? 1 : 0, stdout: bad.map((f) => `FAIL ${path.relative(root, f)}`).join("\n") });
}

fs.readdirSync(path.join(__dirname, "test"))
  .filter((f) => f.endsWith(".test.js") && f.includes(filter))
  .sort()
  .forEach((file) => {
    report(file.replace(/\.test\.js$/, ""), spawnSync(process.execPath, [path.join(__dirname, "test", file)], { encoding: "utf8" }));
  });

if (!filter) report("locales", spawnSync(process.execPath, [path.join(__dirname, "check-locales.js")], { encoding: "utf8" }));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
