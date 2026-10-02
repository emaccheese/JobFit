// Loads the real background.js in a VM with a mock chrome.* and exercises the
// on-page button's board support and the embedded-frame relay.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { EXT } = require("./support");

const store = {};
const granted = new Set(["*://*.greenhouse.io/*"]); // the manifest's own host
const listeners = { message: [], added: [], removed: [] };
const registered = new Map();
const sentToTabs = [];
const removedPerms = [];

// A pattern is "contained" when it's granted, or covered by the manifest's
// greenhouse host.
function contains(origins) {
  return origins.every((o) => granted.has(o) || (/greenhouse\.io/.test(o) && granted.has("*://*.greenhouse.io/*")));
}

const ev = () => ({ addListener() {} });
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...store };
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        list.forEach((k) => k in store && (out[k] = JSON.parse(JSON.stringify(store[k]))));
        return out;
      },
      async set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
      async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); },
      async getKeys() { return Object.keys(store); },
    },
    session: { async get() { return {}; }, async set() {} },
    onChanged: ev(),
  },
  runtime: { onMessage: { addListener: (f) => listeners.message.push(f) }, onStartup: ev(), onInstalled: ev(), getURL: (p) => `chrome-extension://x/${p}`, id: "x" },
  permissions: {
    async contains({ origins }) { return contains(origins); },
    async remove({ origins }) { removedPerms.push(...origins); origins.forEach((o) => granted.delete(o)); return true; },
    onAdded: { addListener: (f) => listeners.added.push(f) },
    onRemoved: { addListener: (f) => listeners.removed.push(f) },
  },
  scripting: {
    async registerContentScripts(list) { list.forEach((s) => { if (registered.has(s.id)) throw new Error("dup"); registered.set(s.id, s); }); },
    async unregisterContentScripts({ ids }) { const missing = ids.filter((i) => !registered.has(i)); if (missing.length) throw new Error("not registered"); ids.forEach((i) => registered.delete(i)); },
    async executeScript() { return []; },
  },
  tabs: { async sendMessage(tabId, msg, opts) { sentToTabs.push({ tabId, msg, opts }); }, onRemoved: ev(), onUpdated: ev(), async query() { return []; }, create() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  alarms: { onAlarm: ev(), async get() { return null; }, async create() {}, async clear() {} },
  commands: { onCommand: ev() },
  webNavigation: { async getAllFrames() { return []; } },
  i18n: { getUILanguage: () => "en" },
  contextMenus: { create() {}, onClicked: ev(), removeAll(cb) { cb && cb(); } },
};

const ctx = { chrome, console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, fetch: async () => ({ ok: false }), navigator: { languages: ["en"] }, Intl, AbortController };
ctx.self = ctx;
ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f }));
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });

// By default from the popup: an extension page, which may ask for anything.
// The frame senders below are scripts on a job site, which may not.
const POPUP = { id: "x", url: "chrome-extension://x/popup.html" };
function send(message, sender = POPUP) {
  return new Promise((resolve) => {
    let answered = false;
    for (const f of listeners.message) {
      const r = f(message, sender, (v) => { answered = true; resolve(v); });
      if (r === true) return;
    }
    if (!answered) setTimeout(() => resolve(undefined), 50);
  });
}
const tick = () => new Promise((r) => setTimeout(r, 30));
let fails = 0;
const check = (name, cond, detail) => { if (!cond) { fails++; console.log("FAIL", name, detail ?? ""); } else console.log("ok  ", name); };

(async () => {
  // A site switched on by itself, then its board.
  granted.add("https://www.linkedin.com/*");
  await send({ type: "JOB_FIT_FLOAT_SITE", origin: "https://www.linkedin.com", enabled: true });
  await tick();
  check("site registers", registered.get("jobfit-float")?.matches.includes("https://www.linkedin.com/*"));
  check("frame script registered", registered.get("jobfit-float-frame")?.matches[0] === "https://*.greenhouse.io/embed/*" && registered.get("jobfit-float-frame").allFrames);

  granted.add("https://*.linkedin.com/*");
  granted.add("https://*.indeed.com/*");
  const r = await send({ type: "JOB_FIT_FLOAT_BOARD", boards: ["linkedin", "indeed"], enabled: true });
  await tick();
  check("boards stored", JSON.stringify(store.floatingButtonBoards) === '["linkedin","indeed"]', store.floatingButtonBoards);
  check("covered site dropped", !store.floatingButtonSites.includes("https://www.linkedin.com"), store.floatingButtonSites);
  check("covered site permission given back", removedPerms.includes("https://www.linkedin.com/*"));
  const m = registered.get("jobfit-float").matches;
  check("board patterns registered", m.includes("https://*.linkedin.com/*") && m.includes("https://*.indeed.com/*") && !m.includes("https://www.linkedin.com/*"), m);
  check("float files include boards.js before float.js", (() => { const js = registered.get("jobfit-float").js; return js.indexOf("boards.js") > -1 && js.indexOf("boards.js") < js.indexOf("float.js") && js.includes("card.js"); })());

  // Greenhouse is always granted: no permission is removed when it's turned off.
  await send({ type: "JOB_FIT_FLOAT_BOARD", boards: ["greenhouse"], enabled: true });
  await tick();
  check("greenhouse on without a grant", store.floatingButtonBoards.includes("greenhouse"));
  const before = removedPerms.length;
  await send({ type: "JOB_FIT_FLOAT_BOARD", boards: ["greenhouse"], enabled: false });
  await tick();
  check("greenhouse off, nothing removed", removedPerms.length === before && !store.floatingButtonBoards.includes("greenhouse"));

  // Revoked in Chrome's settings: dropped on the next sync.
  granted.delete("https://*.indeed.com/*");
  listeners.removed.forEach((f) => f({ origins: ["https://*.indeed.com/*"] }));
  await tick();
  await tick();
  check("revoked board dropped", !store.floatingButtonBoards.includes("indeed"), store.floatingButtonBoards);
  check("revoked board unregistered", !registered.get("jobfit-float").matches.includes("https://*.indeed.com/*"));

  // A pending board grant finished by the worker after the popup closed.
  store.floatPending = { boards: ["workday"], tabId: 3, ts: Date.now() };
  granted.add("https://*.myworkdayjobs.com/*");
  listeners.added.forEach((f) => f({ origins: ["https://*.myworkdayjobs.com/*"] }));
  await tick();
  await tick();
  check("pending board finished", store.floatingButtonBoards.includes("workday") && store.floatPending === null, store);

  // Embedded frame on an enabled company site vs. one that isn't.
  granted.add("https://careers.acme.com/*");
  await send({ type: "JOB_FIT_FLOAT_SITE", origin: "https://careers.acme.com", enabled: true });
  await tick();
  const frameUrl = "https://boards.greenhouse.io/embed/job_app?for=acme&token=1";
  const onSender = { id: "x", url: frameUrl, tab: { id: 9, url: "https://careers.acme.com/jobs?gh_jid=1" }, frameId: 4 };
  const offSender = { id: "x", url: frameUrl, tab: { id: 10, url: "https://other.example/jobs" }, frameId: 4 };
  check("frame asks: enabled page", (await send({ type: "JOB_FIT_FRAME_ENABLED" }, onSender)) === true);
  check("frame asks: other page", (await send({ type: "JOB_FIT_FRAME_ENABLED" }, offSender)) === false);
  check("frame asks: top frame refused", (await send({ type: "JOB_FIT_FRAME_ENABLED" }, { ...onSender, frameId: 0 })) === false);
  await send({ type: "JOB_FIT_FRAME_JOB", job: { jobKey: "greenhouse:acme:1", title: "SRE" } }, onSender);
  await send({ type: "JOB_FIT_FRAME_JOB", job: { jobKey: "greenhouse:x:2", title: "X" } }, offSender);
  await tick();
  const relayed = sentToTabs.filter((s) => s.msg.type === "JOB_FIT_FRAME_JOB");
  check("frame job relayed to top frame of enabled page only", relayed.length === 1 && relayed[0].tabId === 9 && relayed[0].opts.frameId === 0, relayed);

  // Everything off: nothing registered.
  await send({ type: "JOB_FIT_FLOAT_BOARD", boards: ["linkedin", "workday"], enabled: false });
  await send({ type: "JOB_FIT_FLOAT_SITE", origin: "https://careers.acme.com", enabled: false });
  await tick();
  check("all off unregisters both scripts", !registered.has("jobfit-float") && !registered.has("jobfit-float-frame"), [...registered.keys()]);

  console.log(fails ? `${fails} FAILED` : "all worker checks pass");
  process.exit(fails ? 1 : 0);
})();
