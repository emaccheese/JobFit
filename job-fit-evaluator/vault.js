// Secrets — the OpenAI API key now, an account session later — kept where the
// scripts JobFit runs on job sites can't reach them.
//
// chrome.storage.local is shared with content scripts: anything in it can be
// read, and rewritten, by a script running on linkedin.com. That's fine for
// settings and saved jobs, which those scripts need. A key there, though, is
// one compromised page renderer away from being someone else's. IndexedDB
// belongs to an origin, and the extension's own origin is one no page script
// runs in.
//
// Usable from the service worker and the extension's pages only. Anywhere else
// reads come back empty and writes refuse, so a page script that loads this by
// mistake can't create a store on the site's origin.
//
// Assigned with var so re-injection doesn't throw.
var JOB_FIT_VAULT = (function () {
  const DB_NAME = "jobfit-vault";
  const STORE = "secrets";
  const OPENAI_KEY = "openaiApiKey";
  const APPROVED_ORIGINS = "approvedEndpointOrigins";

  function inExtensionOrigin() {
    try {
      // Compared as text: by the URL standard an extension URL's origin is
      // "null", which would match nothing (or worse, everything opaque).
      return typeof indexedDB !== "undefined" && chrome.runtime.getURL("") === `${self.location.origin}/`;
    } catch (err) {
      return false;
    }
  }

  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // A failed open is retried next time rather than remembered.
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  // One request in its own transaction; resolves once the transaction has
  // committed, so a write is durable by the time the caller moves on.
  function request(mode, run) {
    return db().then(
      (database) =>
        new Promise((resolve, reject) => {
          const tx = database.transaction(STORE, mode);
          const req = run(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  async function get(name) {
    if (!inExtensionOrigin()) return null;
    const value = await request("readonly", (store) => store.get(name));
    return value == null ? null : value;
  }

  // An empty value deletes.
  async function set(name, value) {
    if (!inExtensionOrigin()) throw new Error("Tino's key store is only available to the extension itself.");
    await request("readwrite", (store) => (value == null || value === "" ? store.delete(name) : store.put(value, name)));
  }

  async function openAiKey() {
    return (await get(OPENAI_KEY)) || "";
  }

  // Whether the key actually changed, so the caller can stamp keySavedAt in
  // chrome.storage.local — the stamp is what other pages and the service
  // worker watch, since IndexedDB writes fire no storage event.
  async function saveOpenAiKey(key) {
    const next = String(key || "").trim();
    if (next === (await openAiKey())) return false;
    await set(OPENAI_KEY, next);
    return true;
  }

  // Keys saved before the vault existed sit in chrome.storage.local. Moved
  // here once, then removed there. Safe to call any number of times, from
  // any extension page or the worker: with no key left in storage it does
  // nothing. A key already in the vault wins over a leftover copy.
  let migrating = null;

  function migrate() {
    if (!inExtensionOrigin()) return Promise.resolve(false);
    if (!migrating) {
      migrating = (async () => {
        const { openai } = await chrome.storage.local.get("openai");
        if (!openai || !Object.prototype.hasOwnProperty.call(openai, "apiKey")) return false;
        const key = String(openai.apiKey || "").trim();
        if (key && !(await openAiKey())) await set(OPENAI_KEY, key);
        const { apiKey, ...rest } = openai;
        await chrome.storage.local.set({ openai: { ...rest, keySavedAt: key ? Date.now() : rest.keySavedAt || null } });
        return Boolean(key);
      })().finally(() => {
        migrating = null;
      });
    }
    return migrating;
  }

  // Model endpoints off this machine that you've agreed may receive your CV
  // (provider.js endpointPolicy). Here rather than in storage, so a page
  // script can't approve its own server.
  async function approvedOrigins() {
    const list = await get(APPROVED_ORIGINS);
    return Array.isArray(list) ? list : [];
  }

  async function isApprovedOrigin(origin) {
    return Boolean(origin) && (await approvedOrigins()).includes(origin);
  }

  async function approveOrigin(origin) {
    if (!origin) return;
    const list = await approvedOrigins();
    if (!list.includes(origin)) await set(APPROVED_ORIGINS, [...list, origin]);
  }

  async function revokeOrigin(origin) {
    const list = await approvedOrigins();
    if (list.includes(origin)) await set(APPROVED_ORIGINS, list.filter((o) => o !== origin));
  }

  return {
    openAiKey,
    saveOpenAiKey,
    migrate,
    inExtensionOrigin,
    approvedOrigins,
    isApprovedOrigin,
    approveOrigin,
    revokeOrigin,
  };
})();
