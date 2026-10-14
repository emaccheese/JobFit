// Sync profiles and two preferences across the user's Chrome browsers, through
// chrome.storage.sync (their Google account, via Chrome Sync). Opt-in, per
// computer, from Settings → Data. The service worker runs it.
//
// What syncs: profiles (CV summary, salary, screening rules, job search),
// the interface language and the toolbar count switch. What doesn't:
// - tracked jobs: a long search is megabytes of posting text, and Chrome
//   allows about 100 KB in all;
// - the model settings: an LM Studio address is one computer's, and the
//   OpenAI key never leaves the vault;
// - which profile is active, and where the on-page button is on (that's a
//   Chrome permission on each computer).
//
// Layout in chrome.storage.sync, under 8 KB per item:
//   prof:<id>        { updatedAt, parts } or { updatedAt, deleted: true }
//   prof:<id>#<n>    a slice of the profile's JSON
//   prefs            { updatedAt, uiLanguage, attentionBadge }
//
// What this computer last agreed with sync is kept locally (`syncState`: a hash
// per profile). A profile changed here since then is pushed; one changed
// elsewhere and not here is pulled. Both changed before either synced: the
// version that reached sync first is kept everywhere. Each computer syncs two
// seconds after an edit, so that takes two edits within seconds of each other.
//
// The first time sync is turned on, both computers may hold a different
// profile under the same id (every install starts with "seed"). That's never
// settled silently: `syncConflict` lists them, Settings asks which side to
// keep, and nothing is overwritten until it's answered.
var JOB_FIT_SYNC = (function () {
  const PART_CHARS = 1800; // 4 bytes a character at worst, under the 8 KB item limit
  const PROFILE = "prof:";
  const PREF_KEYS = ["uiLanguage", "attentionBadge"];

  function hash(value) {
    const str = JSON.stringify(value);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // --- reading and writing the synced copy -----------------------------------------

  async function readRemote() {
    const all = await chrome.storage.sync.get(null);
    const profiles = new Map();
    Object.keys(all)
      .filter((k) => k.startsWith(PROFILE) && !k.includes("#"))
      .forEach((key) => {
        const id = key.slice(PROFILE.length);
        const meta = all[key] || {};
        if (meta.deleted) {
          profiles.set(id, { updatedAt: meta.updatedAt || 0, deleted: true });
          return;
        }
        const parts = [];
        for (let i = 0; i < (meta.parts || 0); i++) parts.push(all[`${key}#${i}`]);
        if (parts.some((p) => typeof p !== "string")) return; // half-written: next change completes it
        try {
          const profile = JOB_FIT_PROFILES.normalize({ ...JSON.parse(parts.join("")), id });
          profiles.set(id, { updatedAt: meta.updatedAt || 0, profile });
        } catch (err) {
          /* unreadable: left alone */
        }
      });
    return { profiles, prefs: all.prefs || null, keys: Object.keys(all) };
  }

  // One profile's items, ready to write, and the stale parts to remove.
  function profileItems(profile, updatedAt, existingKeys) {
    const json = JSON.stringify(profile);
    const items = {};
    const parts = Math.max(1, Math.ceil(json.length / PART_CHARS));
    for (let i = 0; i < parts; i++) items[`${PROFILE}${profile.id}#${i}`] = json.slice(i * PART_CHARS, (i + 1) * PART_CHARS);
    items[`${PROFILE}${profile.id}`] = { updatedAt, parts };
    const stale = existingKeys.filter((k) => k.startsWith(`${PROFILE}${profile.id}#`) && !(k in items));
    return { items, stale };
  }

  function tombstoneItems(id, updatedAt, existingKeys) {
    return {
      items: { [`${PROFILE}${id}`]: { updatedAt, deleted: true } },
      stale: existingKeys.filter((k) => k.startsWith(`${PROFILE}${id}#`)),
    };
  }

  // A profile nobody has filled in yet: the template every install starts with.
  // Never worth asking about: the other side's real one simply wins.
  function isBlank(profile) {
    const text = String((profile && profile.profile) || "").trim();
    return !text || text === String(JOB_FIT_DEFAULTS.profile).trim();
  }

  // --- local state ----------------------------------------------------------------

  async function readLocal() {
    const stored = await chrome.storage.local.get(["syncState", "syncConflict", ...PREF_KEYS]);
    const store = await JOB_FIT_PROFILES.load();
    const state = stored.syncState && typeof stored.syncState === "object" ? stored.syncState : {};
    return {
      store,
      state: { profiles: { ...(state.profiles || {}) }, prefs: state.prefs || null, pushedAt: { ...(state.pushedAt || {}) } },
      conflict: stored.syncConflict || null,
      prefs: Object.fromEntries(PREF_KEYS.map((k) => [k, stored[k] === undefined ? null : stored[k]])),
    };
  }

  const prefsOf = (source) => Object.fromEntries(PREF_KEYS.map((k) => [k, source[k] === undefined ? null : source[k]]));

  // --- one round: pull what changed elsewhere, then push what changed here ----------

  async function syncNow(now = Date.now()) {
    const local = await readLocal();
    const remote = await readRemote();
    const { state } = local;
    const byId = new Map(local.store.profiles.map((p) => [p.id, p]));
    const conflicts = [];
    let localChanged = false;

    // Pull.
    remote.profiles.forEach((entry, id) => {
      const mine = byId.get(id);
      const known = state.profiles[id];
      if (entry.deleted) {
        // Deleted elsewhere: removed here unless it was edited here since.
        if (mine && known === hash(mine)) {
          byId.delete(id);
          localChanged = true;
        }
        if (!mine || known === hash(mine)) delete state.profiles[id];
        return;
      }
      const theirs = hash(entry.profile);
      if (!mine) {
        // Deleted here since the last sync: the push below says so. Otherwise new.
        if (known) return;
        byId.set(id, entry.profile);
        state.profiles[id] = theirs;
        localChanged = true;
        return;
      }
      const ours = hash(mine);
      if (ours === theirs) {
        state.profiles[id] = ours;
        return;
      }
      if (known === undefined) {
        // Never synced on this computer and different. A blank one gives way;
        // otherwise the user decides.
        if (isBlank(mine)) {
          byId.set(id, entry.profile);
          state.profiles[id] = theirs;
          localChanged = true;
        } else if (!isBlank(entry.profile)) {
          conflicts.push({ id, name: mine.name, otherName: entry.profile.name });
        }
        return;
      }
      const changedHere = known !== ours;
      const changedThere = known !== theirs;
      if (changedThere && (!changedHere || entry.updatedAt > (state.pushedAt[id] || 0))) {
        byId.set(id, entry.profile);
        state.profiles[id] = theirs;
        localChanged = true;
      }
    });

    // Preferences: same rule, as one item.
    const myPrefs = local.prefs;
    const remotePrefs = remote.prefs ? prefsOf(remote.prefs) : null;
    let prefsToApply = null;
    if (remotePrefs && hash(remotePrefs) !== hash(myPrefs)) {
      const changedHere = state.prefs !== hash(myPrefs);
      // The first time, the other computers' choice is adopted (nothing was
      // pushed from here yet, so theirs is the newer).
      if (!changedHere || remote.prefs.updatedAt > (state.pushedAt.prefs || 0)) {
        prefsToApply = remotePrefs;
        state.prefs = hash(remotePrefs);
      }
    } else if (remotePrefs) state.prefs = hash(myPrefs);

    // Push: everything here that sync doesn't have yet, except what's waiting
    // on the user's answer.
    const waiting = new Set(conflicts.map((c) => c.id));
    const writes = {};
    let stale = [];
    byId.forEach((profile, id) => {
      if (waiting.has(id)) return;
      const ours = hash(profile);
      if (state.profiles[id] === ours && remote.profiles.has(id) && !remote.profiles.get(id).deleted) return;
      const out = profileItems(profile, now, remote.keys);
      Object.assign(writes, out.items);
      stale = stale.concat(out.stale);
      state.profiles[id] = ours;
      state.pushedAt[id] = now;
    });
    Object.keys(state.profiles).forEach((id) => {
      if (byId.has(id) || waiting.has(id)) return;
      const out = tombstoneItems(id, now, remote.keys);
      Object.assign(writes, out.items);
      stale = stale.concat(out.stale);
      delete state.profiles[id];
      state.pushedAt[id] = now;
    });
    const effectivePrefs = prefsToApply || myPrefs;
    if (!prefsToApply && hash(effectivePrefs) !== state.prefs) {
      writes.prefs = { updatedAt: now, ...effectivePrefs };
      state.prefs = hash(effectivePrefs);
      state.pushedAt.prefs = now;
    }

    // Local first, so the change it fires finds nothing new to push.
    const localWrites = { syncState: state, syncStatus: { at: now, error: null } };
    if (conflicts.length) localWrites.syncConflict = { at: now, profiles: conflicts };
    if (localChanged) {
      const profiles = [...byId.values()];
      localWrites.profiles = profiles;
      if (!profiles.some((p) => p.id === local.store.activeProfileId)) localWrites.activeProfileId = profiles[0] ? profiles[0].id : null;
    }
    if (prefsToApply) {
      PREF_KEYS.forEach((k) => {
        if (prefsToApply[k] !== null) localWrites[k] = prefsToApply[k];
      });
    }
    await chrome.storage.local.set(localWrites);
    if (!conflicts.length && local.conflict) await chrome.storage.local.remove("syncConflict");

    try {
      if (Object.keys(writes).length) await chrome.storage.sync.set(writes);
      if (stale.length) await chrome.storage.sync.remove(stale);
    } catch (err) {
      // Most likely Chrome's size limit. Forget what was "pushed", so the next
      // change tries again, and say why in Settings.
      await chrome.storage.local.set({
        syncState: { profiles: {}, prefs: null, pushedAt: {} },
        syncStatus: { at: now, error: /quota/i.test(String(err && err.message)) ? "quota" : "failed" },
      });
    }
    return { conflicts, pulled: localChanged || Boolean(prefsToApply), pushed: Object.keys(writes).length > 0 };
  }

  // The user's answer to a first-time conflict: "remote" takes the other
  // computer's version of each listed profile, "local" keeps this one's and
  // sends it to the others.
  async function resolve(choice, now = Date.now()) {
    const local = await readLocal();
    if (!local.conflict) return;
    const remote = await readRemote();
    const ids = local.conflict.profiles.map((c) => c.id);
    const state = local.state;
    let profiles = local.store.profiles;
    ids.forEach((id) => {
      const entry = remote.profiles.get(id);
      if (choice === "remote" && entry && entry.profile) {
        profiles = profiles.map((p) => (p.id === id ? entry.profile : p));
        state.profiles[id] = hash(entry.profile);
      } else {
        // Keeping this computer's: marked as never pushed, so syncNow sends it.
        delete state.profiles[id];
      }
    });
    await chrome.storage.local.set({ profiles, syncState: state });
    await chrome.storage.local.remove("syncConflict");
    if (choice !== "remote") {
      const remoteIds = new Set(ids);
      const forced = {};
      let stale = [];
      profiles
        .filter((p) => remoteIds.has(p.id))
        .forEach((p) => {
          const out = profileItems(p, now, remote.keys);
          Object.assign(forced, out.items);
          stale = stale.concat(out.stale);
          state.profiles[p.id] = hash(p);
          state.pushedAt[p.id] = now;
        });
      await chrome.storage.local.set({ syncState: state });
      if (Object.keys(forced).length) await chrome.storage.sync.set(forced);
      if (stale.length) await chrome.storage.sync.remove(stale);
    }
    return syncNow(now);
  }

  // Turning sync off on this computer stops it here; the synced copy stays for
  // the others. removeSynced() erases that copy from the Google account too.
  async function disable() {
    await chrome.storage.local.remove(["syncState", "syncConflict", "syncStatus"]);
  }

  async function removeSynced() {
    await chrome.storage.sync.clear();
    await disable();
  }

  return { PREF_KEYS, hash, syncNow, resolve, disable, removeSynced, readRemote };
})();
