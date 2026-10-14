// Sync across computers (sync.js): several "computers", each its own
// chrome.storage.local, sharing one chrome.storage.sync.
const { load, makeChrome, suite } = require("./support");

const { check, done } = suite("sync");
const FILES = ["locales/en.js", "i18n.js", "geo.js", "defaults.js", "keywords.js", "profiles.js", "sync.js"];

function computer(syncStore, local = {}, options = {}) {
  const mock = makeChrome({ store: local, syncStore, ...options });
  const ctx = load(FILES, { chrome: mock.chrome });
  return { local: mock.store, S: ctx.JOB_FIT_SYNC, P: ctx.JOB_FIT_PROFILES, defaults: ctx.JOB_FIT_DEFAULTS };
}

const profiles = (c) => c.local.profiles || [];
const byName = (c, name) => profiles(c).find((p) => p.name === name);

(async () => {
  const cloud = {};

  // --- the first computer ------------------------------------------------------------
  const a = computer(cloud, { uiLanguage: "es", openai: { apiKey: "sk-secret", model: "gpt-6-sol" }, "ev:seed:linkedin:1": { title: "a tracked job" } });
  await a.P.load(); // the install's first profile, "seed"
  const store = await a.P.load();
  store.profiles[0] = { ...store.profiles[0], name: "Sam — backend", profile: "Backend engineer, 8 years, Go and AWS. Gaps: Kubernetes." };
  await a.P.save(store);
  let result = await a.S.syncNow();
  check("turning sync on sends this computer's profiles", result.pushed && Boolean(cloud["prof:seed"]) && !result.conflicts.length);
  check("…and the language", cloud.prefs && cloud.prefs.uiLanguage === "es");
  const synced = JSON.stringify(cloud);
  check("never the OpenAI key, model settings or tracked jobs", !synced.includes("sk-secret") && !synced.includes("gpt-6-sol") && !synced.includes("a tracked job"));
  check("every item is under Chrome's 8 KB limit", Object.entries(cloud).every(([k, v]) => Buffer.byteLength(k + JSON.stringify(v)) < 8192));

  // --- a second computer, fresh ---------------------------------------------------------
  const b = computer(cloud);
  await b.P.load(); // its blank starting profile, also "seed"
  result = await b.S.syncNow();
  check("a fresh computer takes the synced profile over its blank one, without asking", !result.conflicts.length && byName(b, "Sam — backend"));
  check("…and the synced language", b.local.uiLanguage === "es");

  // --- edits travel both ways -----------------------------------------------------------------
  let s = await a.P.load();
  s.profiles[0].profile = "Backend engineer, 9 years, Go, AWS and Rust. Gaps: Kubernetes.";
  await a.P.save(s);
  await a.S.syncNow();
  await b.S.syncNow();
  check("an edit on one computer reaches the other", byName(b, "Sam — backend").profile.includes("Rust"));

  s = await b.P.load();
  s.profiles.push({ ...b.P.blankProfile("Designer"), profile: "Product designer, 5 years." });
  await b.P.save(s);
  await b.S.syncNow();
  await a.S.syncNow();
  check("a profile added on one computer appears on the other", Boolean(byName(a, "Designer")));

  s = await a.P.load();
  const designerId = byName(a, "Designer").id;
  s.profiles = s.profiles.filter((p) => p.id !== designerId);
  await a.P.save(s);
  b.local.activeProfileId = designerId;
  await a.S.syncNow();
  check("a deleted profile leaves a small marker in sync", cloud[`prof:${designerId}`] && cloud[`prof:${designerId}`].deleted === true && !Object.keys(cloud).some((k) => k.startsWith(`prof:${designerId}#`)));
  await b.S.syncNow();
  check("…and is removed on the other computer", !byName(b, "Designer"));
  check("…which switches to a profile that still exists", b.local.activeProfileId === "seed");

  // --- a computer with its own, different profile: the user decides -----------------------
  const c = computer(cloud);
  s = await c.P.load();
  s.profiles[0] = { ...s.profiles[0], name: "Sam (laptop)", profile: "Backend engineer, written differently on the laptop." };
  await c.P.save(s);
  result = await c.S.syncNow();
  check("a different, filled-in profile under the same id isn't overwritten: it's asked", result.conflicts.length === 1 && c.local.syncConflict && c.local.syncConflict.profiles[0].name === "Sam (laptop)");
  check("…nothing changed here", byName(c, "Sam (laptop)") && !byName(c, "Sam — backend"));
  check("…or in sync", JSON.parse(cloud["prof:seed#0"] + (cloud["prof:seed#1"] || "")).name === "Sam — backend");
  await c.S.resolve("remote");
  check('"Use the synced version" replaces this computer\'s', byName(c, "Sam — backend") && !c.local.syncConflict);

  const d = computer(cloud);
  s = await d.P.load();
  s.profiles[0] = { ...s.profiles[0], name: "Sam (desktop)", profile: "The desktop's own wording, which should win." };
  await d.P.save(s);
  await d.S.syncNow();
  await d.S.resolve("local");
  await a.S.syncNow();
  check('"Keep this computer\'s" sends it to the others', byName(a, "Sam (desktop)") && byName(d, "Sam (desktop)"));

  // --- long profiles are split ------------------------------------------------------------------
  s = await a.P.load();
  s.profiles[0].profile = "Distributed systems — 分散システム. ".repeat(220);
  await a.P.save(s);
  await a.S.syncNow();
  const parts = Object.keys(cloud).filter((k) => k.startsWith("prof:seed#")).length;
  check("a long CV summary is split into parts, each under 8 KB", parts > 3 && Object.entries(cloud).every(([k, v]) => Buffer.byteLength(k + JSON.stringify(v)) < 8192), parts);
  await b.S.syncNow();
  check("…and put back together on the other computer", byName(b, "Sam (desktop)").profile === s.profiles[0].profile);
  s.profiles[0].profile = "Short again.";
  await a.P.save(s);
  await a.S.syncNow();
  check("parts no longer needed are removed", Object.keys(cloud).filter((k) => k.startsWith("prof:seed#")).length === 1);

  // --- both edited before either synced: the first to reach sync wins ---------------------------
  s = await a.P.load();
  s.profiles[0].profile = "Edited on A.";
  await a.P.save(s);
  const sb = await b.P.load();
  sb.profiles[0].profile = "Edited on B.";
  await b.P.save(sb);
  await a.S.syncNow(Date.now() + 1000);
  await b.S.syncNow(Date.now() + 2000);
  check("both edited at once: the version that reached sync first is kept everywhere", profiles(b)[0].profile === "Edited on A." && JSON.parse(cloud["prof:seed#0"]).profile === "Edited on A.");

  // --- Chrome's size limit ------------------------------------------------------------------------
  const full = computer({}, {}, { syncFails: "QUOTA_BYTES quota exceeded" });
  s = await full.P.load();
  s.profiles[0].profile = "A real profile.";
  await full.P.save(s);
  await full.S.syncNow();
  check("over Chrome's limit: said in Settings, retried with the next change", full.local.syncStatus.error === "quota" && Object.keys(full.local.syncState.profiles).length === 0);

  // --- removing the synced copy ---------------------------------------------------------------------
  await a.S.removeSynced();
  check("removing the synced copy empties it and this computer's sync state", Object.keys(cloud).length === 0 && !a.local.syncState);
  check("…and keeps the profiles here", byName(a, "Sam (desktop)"));

  done();
})();
