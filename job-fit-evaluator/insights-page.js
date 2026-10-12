// Search insights page: draws what insights.js counts, for one profile and
// period. Everything is textContent, never HTML: titles and company names
// come from job pages.

const $ = (id) => document.getElementById(id);
let store = { profiles: [], activeProfileId: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const pct = (value) => JOB_FIT_I18N.formatNumber(value, { style: "percent", maximumFractionDigits: 0 });
const num = (value) => JOB_FIT_I18N.formatNumber(value);

function profileId() {
  return $("profileSelect").value;
}

function card(titleKey, subKey) {
  const section = el("section", "card");
  const id = `h-${titleKey.replace(/\W/g, "-")}`;
  const h2 = el("h2", null, t(titleKey));
  h2.id = id;
  section.setAttribute("aria-labelledby", id);
  section.appendChild(h2);
  if (subKey) section.appendChild(el("p", "sub", t(subKey)));
  return section;
}

// A row of the bar list: the label, the bar (decorative: the number beside
// it says the same, for everyone), the value, and a line of detail under it.
function barRow(list, { label, value, share, shown, detail, tooltip }) {
  list.appendChild(el("dt", null, label));
  const bar = el("dd");
  const track = el("div", "track");
  track.setAttribute("aria-hidden", "true");
  const fill = el("div", `fill${!share ? " zero" : ""}`);
  fill.style.width = `${Math.max(0, Math.min(1, share || 0)) * 100}%`;
  track.appendChild(fill);
  track.title = tooltip || "";
  bar.appendChild(track);
  list.appendChild(bar);
  const valueCell = el("dd", `value${shown == null ? " unknown" : ""}`, shown == null ? t("insights.tooFew") : shown);
  list.appendChild(valueCell);
  if (detail) list.appendChild(el("dd", "detail", detail));
  return list;
}

function emptyState(titleKey, textKey, vars) {
  const box = el("div", "empty");
  const img = el("img");
  img.src = "images/tino-curled.svg";
  img.alt = "";
  box.append(img, el("h2", null, t(titleKey)), el("p", null, t(textKey, vars)));
  const open = el("button", "primary", t("insights.backToTracked"));
  open.type = "button";
  open.addEventListener("click", openTracked);
  box.appendChild(open);
  return box;
}

function funnelCard(data) {
  const f = data.funnel;
  const section = card("insights.funnelTitle", "insights.funnelSub");
  const list = el("dl", "bars");
  const stage = (key, count, rateValue, rateKey) =>
    barRow(list, {
      label: t(`insights.stage.${key}`),
      value: count,
      share: f.evaluated ? count / f.evaluated : 0,
      shown: num(count),
      detail: rateKey ? (rateValue == null ? t("insights.tooFew") : t(rateKey, { pct: pct(rateValue) })) : null,
      tooltip: `${t(`insights.stage.${key}`)}: ${num(count)}`,
    });
  stage("evaluated", f.evaluated);
  stage("applied", f.applied, f.applyRate, "insights.ofEvaluated");
  stage("interviews", f.interviews, f.interviewRate, "insights.ofApplied");
  stage("offers", f.offers, f.offerRate, "insights.ofInterviews");
  section.appendChild(list);
  if (data.unknownPast) section.appendChild(el("p", "note", t("insights.unknownPast", { count: data.unknownPast })));
  return section;
}

function tile(value, what) {
  const box = el("div", "tile");
  box.append(el("div", "num", value), el("div", "what", what));
  return box;
}

function repliesCard(data) {
  const r = data.replies;
  const days = JOB_FIT_ATTENTION.SILENCE_DAYS;
  const section = card("insights.repliesTitle", "insights.repliesSub");
  const tiles = el("div", "tiles");
  tiles.append(
    tile(r.replyRate == null ? "—" : pct(r.replyRate), r.replyRate == null ? t("insights.replyRateFew") : t("insights.replyRate", { count: r.replied, total: data.funnel.applied })),
    tile(r.medianDays == null ? "—" : t("insights.days", { count: r.medianDays }), r.medianDays == null ? t("insights.noRepliesYet") : t("insights.medianDays", { count: r.measured })),
    tile(num(r.noReply), t("insights.noReply", { count: days })),
    tile(num(r.waiting), t("insights.waiting", { count: days }))
  );
  section.appendChild(tiles);
  return section;
}

// What the score bands say, in a sentence, once there's enough to say it:
// jobs scored green against everything below green.
function scoreFinding(data) {
  const [high, mid, low] = data.bands;
  const belowApplied = mid.applied + low.applied;
  const belowHits = mid.interviews + low.interviews;
  if (high.rate == null || belowApplied < JOB_FIT_INSIGHTS.MIN_SAMPLE) return null;
  const below = belowHits / belowApplied;
  const green = JOB_FIT_UI.GREEN_FROM;
  if (high.rate > 0 && below === 0) return t("insights.findingOnlyHigh", { min: green });
  if (high.rate === 0 && below === 0) return null;
  const ratio = below ? high.rate / below : Infinity;
  if (ratio >= 1.5) return t("insights.findingHigher", { min: green, times: JOB_FIT_I18N.formatNumber(ratio, { maximumFractionDigits: 1 }) });
  if (ratio <= 1 / 1.5) return t("insights.findingLower", { min: green });
  return t("insights.findingSimilar", { min: green });
}

function scoreCard(data) {
  const section = card("insights.scoreTitle", "insights.scoreSub");
  const list = el("dl", "bars");
  const green = JOB_FIT_UI.GREEN_FROM;
  const amber = JOB_FIT_UI.AMBER_FROM;
  const labels = {
    high: t("insights.band.high", { min: green }),
    mid: t("insights.band.mid", { min: amber, max: green - 1 }),
    low: t("insights.band.low", { max: amber }),
  };
  data.bands.forEach((b) =>
    barRow(list, {
      label: labels[b.band],
      share: b.rate || 0,
      shown: b.rate == null ? null : pct(b.rate),
      detail: t("insights.bandDetail", { count: b.applied, interviews: b.interviews }),
      tooltip: `${labels[b.band]}: ${t("insights.bandDetail", { count: b.applied, interviews: b.interviews })}`,
    })
  );
  section.appendChild(list);
  const finding = scoreFinding(data);
  if (finding) section.appendChild(el("p", "finding", finding));
  return section;
}

function tableCard(titleKey, subKey, firstColKey, rows, { outcomes = false } = {}) {
  const section = card(titleKey, subKey);
  const table = el("table");
  const head = el("tr");
  const th = (key, n) => {
    const cell = el("th", n ? "n" : null, t(key));
    cell.scope = "col";
    head.appendChild(cell);
  };
  th(firstColKey);
  th("insights.col.applied", true);
  th("insights.col.interviews", true);
  if (outcomes) {
    th("insights.col.rejected", true);
    th("insights.col.noReply", true);
  } else th("insights.col.rate", true);
  const thead = el("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const body = el("tbody");
  rows.forEach((row) => {
    const tr = el("tr");
    const name = el("th", null, row.label || "—");
    name.scope = "row";
    tr.appendChild(name);
    tr.appendChild(el("td", "n", num(row.applied)));
    tr.appendChild(el("td", "n", num(row.interviews)));
    if (outcomes) {
      tr.appendChild(el("td", "n", num(row.rejected)));
      tr.appendChild(el("td", "n", num(row.noReply)));
    } else tr.appendChild(el("td", "n", row.rate == null ? "—" : pct(row.rate)));
    body.appendChild(tr);
  });
  table.appendChild(body);
  const wrap = el("div", "table-wrap");
  wrap.appendChild(table);
  section.appendChild(wrap);
  if (!outcomes) section.appendChild(el("p", "note", t("insights.rateNote", { count: JOB_FIT_INSIGHTS.MIN_SAMPLE })));
  return section;
}

async function render() {
  const content = $("content");
  const records = await JOB_FIT_EVALSTORE.list(profileId()).catch(() => []);
  const sinceDays = Number($("periodSelect").value) || null;
  const data = JOB_FIT_INSIGHTS.compute(records, { sinceDays });
  content.textContent = "";

  if (!data.funnel.evaluated && !data.funnel.applied) {
    content.appendChild(emptyState("insights.emptyTitle", sinceDays ? "insights.emptyPeriod" : "insights.emptyNothing"));
    return;
  }
  if (!data.funnel.applied) {
    content.appendChild(emptyState("insights.emptyTitle", "insights.emptyNoApplied", { count: data.funnel.evaluated }));
    return;
  }
  content.append(funnelCard(data), repliesCard(data), scoreCard(data));
  if (data.bySite.length) content.appendChild(tableCard("insights.siteTitle", "insights.siteSub", "insights.col.site", data.bySite));
  if (data.byCompany.length) content.appendChild(tableCard("insights.companyTitle", "insights.companySub", "insights.col.company", data.byCompany, { outcomes: true }));
}

function openTracked() {
  window.location.href = `history.html?${new URLSearchParams({ profile: profileId() }).toString()}`;
}

// Kept in the address, so a reload or a bookmark comes back to the same view.
function rememberView() {
  const params = new URLSearchParams({ profile: profileId() });
  if ($("periodSelect").value) params.set("period", $("periodSelect").value);
  history.replaceState(null, "", `?${params.toString()}`);
}

async function init() {
  await JOB_FIT_I18N.load();
  JOB_FIT_I18N.translatePage();
  document.title = `${t("insights.title")} — Tino`;
  store = await JOB_FIT_PROFILES.load();

  const select = $("profileSelect");
  store.profiles.forEach((p) => {
    const opt = el("option", null, p.name);
    opt.value = p.id;
    select.appendChild(opt);
  });
  const params = new URLSearchParams(location.search);
  const wanted = params.get("profile");
  select.value = store.profiles.some((p) => p.id === wanted) ? wanted : store.activeProfileId;
  if (["30", "90"].includes(params.get("period"))) $("periodSelect").value = params.get("period");

  select.addEventListener("change", () => {
    rememberView();
    render();
  });
  $("periodSelect").addEventListener("change", () => {
    rememberView();
    render();
  });
  $("openTracked").addEventListener("click", openTracked);

  // A status changed in Tracked jobs in another tab: follow it.
  let timer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some((k) => k.startsWith(`ev:${profileId()}:`))) return;
    clearTimeout(timer);
    timer = setTimeout(render, 500);
  });

  await render();
}

init();
