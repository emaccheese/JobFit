// Shared by JobFit's test suites: the extension's own scripts, run in a Node VM
// against stand-ins for chrome.* and IndexedDB, so the tests exercise the code
// that ships rather than a copy of it. No dependencies.
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "..", "job-fit-evaluator");
const EXT_ID = "jobfit-test";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

// Who a message comes from, as chrome.runtime.onMessage reports it: one of the
// extension's own pages, or a script JobFit injected into a job site.
const senders = {
  page(file = "popup.html") {
    return { id: EXT_ID, url: `${EXT_ORIGIN}/${file}`, origin: EXT_ORIGIN };
  },
  content(url, { tabId = 7, frameId = 0, tabUrl = url } = {}) {
    return { id: EXT_ID, url, origin: new URL(url).origin, tab: { id: tabId, url: tabUrl }, frameId };
  },
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// chrome.* with an in-memory storage.local and every listener captured.
function makeChrome({ store = {}, granted = new Set() } = {}) {
  const listeners = { message: [], storage: [], added: [], removed: [] };
  const registered = new Map();
  const sentToTabs = [];
  const removedPerms = [];
  const uninstallUrls = [];
  const ev = () => ({ addListener() {} });

  const local = {
    async get(keys) {
      if (keys == null) return clone(store);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      list.forEach((k) => {
        if (k in store) out[k] = clone(store[k]);
      });
      return out;
    },
    async set(obj) {
      const changes = {};
      Object.entries(obj).forEach(([k, v]) => {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      });
      listeners.storage.forEach((f) => f(changes, "local"));
    },
    async remove(k) {
      (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]);
    },
    async getKeys() {
      return Object.keys(store);
    },
  };

  const chrome = {
    storage: {
      local,
      session: { async get() { return {}; }, async set() {} },
      onChanged: { addListener: (f) => listeners.storage.push(f) },
    },
    runtime: {
      id: EXT_ID,
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onStartup: ev(),
      onInstalled: ev(),
      getURL: (p) => `${EXT_ORIGIN}/${String(p).replace(/^\//, "")}`,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")),
      async setUninstallURL(url) {
        uninstallUrls.push(url);
      },
    },
    permissions: {
      async contains({ origins }) {
        return origins.every((o) => granted.has(o) || (/greenhouse\.io/.test(o) && granted.has("*://*.greenhouse.io/*")));
      },
      async remove({ origins }) {
        removedPerms.push(...origins);
        origins.forEach((o) => granted.delete(o));
        return true;
      },
      onAdded: { addListener: (f) => listeners.added.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) },
    },
    scripting: {
      async registerContentScripts(list) {
        list.forEach((s) => {
          if (registered.has(s.id)) throw new Error("duplicate id");
          registered.set(s.id, s);
        });
      },
      async unregisterContentScripts({ ids }) {
        if (ids.some((i) => !registered.has(i))) throw new Error("not registered");
        ids.forEach((i) => registered.delete(i));
      },
      async executeScript() {
        return [];
      },
    },
    tabs: {
      async sendMessage(tabId, msg, opts) {
        sentToTabs.push({ tabId, msg, opts });
      },
      onRemoved: ev(),
      onUpdated: ev(),
      async query() {
        return [];
      },
      create() {},
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    alarms: { onAlarm: ev(), async get() { return null; }, async create() {}, async clear() {} },
    commands: { onCommand: ev() },
    webNavigation: { async getAllFrames() { return []; } },
    i18n: { getUILanguage: () => "en" },
    contextMenus: { create() {}, onClicked: ev(), removeAll(cb) { if (cb) cb(); } },
  };
  return { chrome, store, granted, listeners, registered, sentToTabs, removedPerms, uninstallUrls };
}

// A just-enough IndexedDB: open, one object store, get/put/delete, each in a
// transaction that completes asynchronously like the real one.
function fakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          createObjectStore(store) {
            stores.set(store, new Map());
          },
          transaction(store) {
            const tx = {};
            const data = stores.get(store);
            const request = (run) => {
              const r = {};
              r.result = run();
              later(() => tx.oncomplete && tx.oncomplete());
              return r;
            };
            tx.objectStore = () => ({
              get: (k) => request(() => clone(data.get(k))),
              put: (v, k) => request(() => data.set(k, clone(v)) && k),
              delete: (k) => request(() => data.delete(k) && undefined),
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

// A VM context with the globals the extension's scripts expect. `origin`
// sets self.location, which decides whether the vault opens.
function makeContext(chrome, { origin = null, indexedDB = null, fetch = async () => ({ ok: false, status: 503 }) } = {}) {
  const ctx = {
    chrome,
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    navigator: { languages: ["en"] },
    Intl,
    AbortController,
  };
  if (origin) ctx.location = { origin, href: `${origin}/` };
  if (indexedDB) ctx.indexedDB = indexedDB;
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach((f) => run(ctx, f));
  vm.createContext(ctx);
  return ctx;
}

function run(ctx, file) {
  vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), ctx, { filename: file });
}

// Loads scripts into a fresh context; returns the context. Top-level `var`s
// (JOB_FIT_*) land on it.
function load(files, { chrome = makeChrome().chrome, ...options } = {}) {
  const ctx = makeContext(chrome, options);
  files.forEach((f) => run(ctx, f));
  return ctx;
}

// The service worker, as Chrome would run it, with a send() that delivers a
// message to its onMessage listener and resolves with the reply.
function loadWorker(options = {}) {
  const mock = makeChrome(options);
  const ctx = makeContext(mock.chrome, options);
  run(ctx, "background.js");
  function send(message, sender = senders.page()) {
    return new Promise((resolve) => {
      let answered = false;
      for (const f of mock.listeners.message) {
        const kept = f(message, sender, (value) => {
          answered = true;
          resolve(value);
        });
        if (kept === true) return;
      }
      if (!answered) setTimeout(() => resolve(undefined), 50);
    });
  }
  return { ctx, send, ...mock };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// check() prints a line per assertion; done() sets the exit code.
function suite(title) {
  let fails = 0;
  let passes = 0;
  return {
    check(name, cond, detail) {
      if (cond) {
        passes++;
        console.log("ok  ", name);
      } else {
        fails++;
        console.log("FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
      }
    },
    done() {
      console.log(fails ? `\n${title}: ${fails} FAILED, ${passes} passed` : `\n${title}: all ${passes} passed`);
      process.exitCode = fails ? 1 : 0;
    },
  };
}

module.exports = { EXT, EXT_ID, EXT_ORIGIN, senders, makeChrome, fakeIndexedDB, makeContext, load, loadWorker, suite, tick };
