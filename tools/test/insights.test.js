// Search insights (insights.js): the funnel, replies, interview rate by score,
// by site and company; and the interview and offer milestones that
// evalstore.js now keeps past a later status.
const { load, makeChrome, suite } = require("./support");

const { check, done } = suite("insights");
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 20, 12);

const ctx = load(["locales/en.js", "i18n.js", "geo.js", "evalstore.js", "postingmeta.js", "ui-shared.js", "attention.js", "insights.js"]);
const I = ctx.JOB_FIT_INSIGHTS;

let n = 0;
const job = (fields) => ({
  jobKey: `linkedin:${++n}`,
  profileId: "p1",
  company: "Northwind Robotics",
  score: 80,
  status: "not_applied",
  firstSeenAt: NOW - 40 * DAY,
  lastEvaluatedAt: NOW - 40 * DAY,
  ...fields,
});
const applied = (days, fields = {}) => job({ status: "applied", appliedAt: NOW - days * DAY, statusChangedAt: NOW - days * DAY, ...fields });

const records = [
  // Evaluated only.
  job({ score: 50 }),
  job({ score: 62 }),
  job({ score: 90 }),
  job({ score: null, summary: "brief only" }), // summarised, never evaluated: not counted
  job({ score: 0, hardReject: { reason: "citizenship" } }),
  // Applied, high scores: 2 interviews out of 4 (one ended in a rejection, kept by its milestone).
  applied(30, { status: "interviewing", interviewAt: NOW - 20 * DAY, statusChangedAt: NOW - 20 * DAY }),
  applied(35, { status: "rejected", interviewAt: NOW - 28 * DAY, statusChangedAt: NOW - 10 * DAY, company: "Contoso Cloud", jobKey: "indeed:a" }),
  applied(20), // 20 days, no reply
  applied(3), // waiting
  // Applied, lower scores: 1 offer out of 3.
  applied(25, { score: 60, status: "offer", interviewAt: NOW - 18 * DAY, offerAt: NOW - 5 * DAY, statusChangedAt: NOW - 5 * DAY, company: "Contoso Cloud", jobKey: "indeed:b" }),
  applied(40, { score: 58, status: "rejected", statusChangedAt: NOW - 36 * DAY, interviewAt: undefined }),
  applied(50, { score: 40, status: "ghosted", statusChangedAt: NOW - 10 * DAY }),
];

const data = I.compute(records, { now: NOW });
const f = data.funnel;
check("evaluated counts scores and hard rejects, not summaries", f.evaluated === records.length - 1, f);
check("applied counts every status past Not applied", f.applied === 7, f);
check("an interview that ended in a rejection still counts", f.interviews === 3, f);
check("offers", f.offers === 1, f);
check("rates between the steps", Math.abs(f.applyRate - 7 / 11) < 1e-9 && Math.abs(f.interviewRate - 3 / 7) < 1e-9 && Math.abs(f.offerRate - 1 / 3) < 1e-9, f);

const r = data.replies;
check("replies: interviews, offers and rejections", r.replied === 4, r);
check("no reply: ghosted, and applied 14+ days ago", r.noReply === 2, r);
check("waiting: applied less than 14 days ago", r.waiting === 1, r);
// Days to reply: 10 (interview), 7 (interview then rejected), 7 (offer's interview), 4 (rejection).
check("typical days to a reply is the median", r.medianDays === 7 && r.measured === 4, r);

const band = (id) => data.bands.find((b) => b.band === id);
check("score bands: 75+ got 2 interviews from 4 applications", band("high").applied === 4 && band("high").interviews === 2 && band("high").rate === 0.5, band("high"));
check("a band with fewer than 3 applications has no rate", band("low").applied === 1 && band("low").rate === null && band("mid").applied === 2 && band("mid").rate === null);

const linkedin = data.bySite.find((s) => s.label === "LinkedIn");
const indeed = data.bySite.find((s) => s.label === "Indeed");
check("by site", linkedin && linkedin.applied === 5 && linkedin.interviews === 1 && indeed && indeed.applied === 2 && indeed.interviews === 2, data.bySite);
check("…biggest first", data.bySite[0].label === "LinkedIn");
const contoso = data.byCompany.find((c) => c.label === "Contoso Cloud");
check("by company, with outcomes", contoso && contoso.applied === 2 && contoso.interviews === 2 && data.byCompany[0].label === "Northwind Robotics");
check("rejections since Tino kept interviews aren't flagged", data.unknownPast === 0, data.unknownPast);

const S = ctx.JOB_FIT_EVALSTORE;
check("Glassdoor and Eightfold jobs are named, not \"another site\"", S.siteLabel({ jobKey: "glassdoor:1" }) === "Glassdoor" && S.siteLabel({ jobKey: "eightfold:careers.example.com:9" }) === "company career site");

const recent = I.compute(records, { now: NOW, sinceDays: 30 });
check("a period keeps the jobs seen or applied to within it", recent.funnel.applied === 4 && recent.funnel.evaluated === 4, recent.funnel);
check("nothing tracked: all zero, no rates", I.compute([], { now: NOW }).funnel.interviewRate === null);

const old = I.compute([applied(400, { status: "rejected", statusChangedAt: Date.UTC(2026, 0, 5) })], { now: NOW });
check("a rejection from before Tino kept interviews is flagged", old.unknownPast === 1);

// --- milestones kept past a later status ------------------------------------------------
(async () => {
  const mock = makeChrome({ store: { "ev:p1:j": { profileId: "p1", jobKey: "j", status: "not_applied", score: 80 } } });
  const store = load(["evalstore.js"], { chrome: mock.chrome }).JOB_FIT_EVALSTORE;
  await store.setStatus("p1", "j", "applied");
  await store.setStatus("p1", "j", "interviewing");
  let rec = await store.get("p1", "j");
  const interviewAt = rec.interviewAt;
  check("reaching an interview is dated", typeof interviewAt === "number" && rec.appliedAt <= interviewAt);
  await store.setStatus("p1", "j", "rejected");
  rec = await store.get("p1", "j");
  check("…and kept when the job is rejected", rec.status === "rejected" && rec.interviewAt === interviewAt);
  await store.setStatus("p1", "j", "offer");
  rec = await store.get("p1", "j");
  check("an offer is dated, the interview date kept", typeof rec.offerAt === "number" && rec.interviewAt === interviewAt);
  await store.setStatus("p1", "j", "applied");
  rec = await store.get("p1", "j");
  check("moving back to Applied is a correction: both cleared", rec.interviewAt === null && rec.offerAt === null && rec.appliedAt != null);

  done();
})();
