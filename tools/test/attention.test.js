// What needs doing this week (attention.js), shared by Tracked jobs, the
// popup and the toolbar icon; the icon's count (background.js drawBadge); and
// the backup reminder's bookkeeping.
const { load, loadWorker, suite, tick } = require("./support");

const { check, done } = suite("attention");
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0); // a Wednesday afternoon
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

const ctx = load(["locales/en.js", "i18n.js", "geo.js", "postingmeta.js", "ui-shared.js", "attention.js"]);
const A = ctx.JOB_FIT_ATTENTION;

// Jobs a search has after a few weeks, most of them needing nothing.
const job = (jobKey, fields) => ({ jobKey, profileId: "p1", title: `Job ${jobKey}`, company: "Northwind Robotics", status: "not_applied", score: 60, ...fields });
const records = [
  job("quiet-applied", { status: "applied", appliedAt: NOW - 20 * DAY }),
  job("recent-applied", { status: "applied", appliedAt: NOW - 3 * DAY }),
  job("interview", { status: "interviewing", statusChangedAt: NOW - DAY }),
  job("offer", { status: "offer", statusChangedAt: NOW - 2 * DAY }),
  job("closes-in-2", { meta: { deadline: isoDay(NOW + 2 * DAY) } }),
  job("closes-today", { meta: { deadline: isoDay(NOW) } }),
  job("closes-skip", { score: 40, meta: { deadline: isoDay(NOW + DAY) } }),
  job("strong", { score: 88 }),
  job("strong-closed", { score: 90, meta: { deadline: isoDay(NOW - 3 * DAY) } }),
  job("rejected-hard", { status: "offer", hardReject: { reason: "citizenship" } }),
  job("ghosted", { status: "ghosted", appliedAt: NOW - 40 * DAY }),
];

// --- the rules ---------------------------------------------------------------------
const reason = (key) => A.reasonFor(records.find((r) => r.jobKey === key), NOW);
check("an offer: decide", reason("offer") === "offer — decide");
check("an interview", reason("interview") === "interview scheduled");
check("no reply in 14+ days, with the number", reason("quiet-applied") === "no reply in 20 days");
check("…not after 3 days", reason("recent-applied") === null);
check("closing soon, not applied", reason("closes-in-2") === "closes in 2 days — not applied");
check("closing today", reason("closes-today") === "closes today — not applied");
check("a weak match closing soon isn't a to-do", reason("closes-skip") === null);
check("a strong match not applied to", reason("strong") === "strong match (88) — not applied");
check("…unless applications closed", reason("strong-closed") === null);
check("a hard reject never needs anything", reason("rejected-hard") === null);
check("ghosted is decided, not pending", reason("ghosted") === null);

// --- this week ------------------------------------------------------------------------
const week = A.thisWeek(records, NOW);
check(
  "this week: offers, interviews, deadlines (soonest first), then silences",
  week.items.map((i) => i.record.jobKey).join(",") === "offer,interview,closes-today,closes-in-2,quiet-applied",
  week.items.map((i) => i.record.jobKey)
);
check("…each with its reason", week.items[0].kind === "offer" && week.items[0].label === "offer — decide");
check("strong matches are counted, not listed", week.strongMatches === 1 && !week.items.some((i) => i.kind === "strongMatch"));
check("nothing to do, nothing listed", A.thisWeek([records[1]], NOW).items.length === 0);

// --- the toolbar icon ---------------------------------------------------------------------
(async () => {
  const store = { activeProfileId: "p1" };
  records.forEach((r) => (store[`ev:p1:${r.jobKey}`] = { ...r }));
  // Another profile's jobs don't count for this one.
  store["ev:p2:other-offer"] = job("other-offer", { profileId: "p2", status: "offer" });

  const w = loadWorker({ store });
  await tick(30);
  // Real time inside the worker: the deadlines above are relative to NOW, so
  // only the ones that don't depend on today's date are counted here.
  const live = A.thisWeek(records, Date.now()).items.length;
  await w.ctx.drawBadge();
  check("idle: the icon counts this week's to-do for the active profile", w.badge.text === String(live) && live > 0, { badge: w.badge, live });
  check("…in coral", w.badge.color === "#a4462f");
  check("…with the reason in the tooltip", /^Tino — \d+ tracked jobs? needs? something this week$/.test(w.badge.title), w.badge.title);

  await w.ctx.setBadge(4, "running");
  check("while the queue works, its count wins", w.badge.text === "4" && w.badge.color === "#2350c4" && w.badge.title === "Tino");
  await w.ctx.setBadge(2, "paused");
  check("…amber when paused", w.badge.text === "2" && w.badge.color === "#9a6300");
  await w.ctx.setBadge(0, "idle");
  check("back to the week's count when the queue empties", w.badge.text === String(live));

  w.store.attentionBadge = false;
  await w.ctx.drawBadge();
  check("turned off in Settings: no count", w.badge.text === "" && w.badge.title === "Tino");

  w.store.attentionBadge = true;
  Object.keys(w.store).filter((k) => k.startsWith("ev:p1:")).forEach((k) => delete w.store[k]);
  await w.ctx.drawBadge();
  check("nothing to do: no badge", w.badge.text === "");

  await w.ctx.scheduleAttentionRedraw();
  const alarm = w.alarmsCreated.find((a) => a.name === "jobfit-attention-day");
  const at = alarm && new Date(alarm.info.when);
  check("redrawn just after the next local midnight", at && at.getHours() === 0 && at.getMinutes() === 1 && alarm.info.when > Date.now() && alarm.info.when - Date.now() <= DAY + 60000);

  // --- the backup reminder's bookkeeping ------------------------------------------------------
  const b = loadWorker({ store: { "ev:p1:a": job("a", {}), "ev:p1:b": job("b", {}), "ev:p2:c": job("c", { profileId: "p2" }) } });
  check("jobs are counted across every profile", (await b.ctx.JOB_FIT_EVALSTORE.countAll()) === 3);

  done();
})();
