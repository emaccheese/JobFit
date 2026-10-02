// Backup, restore and the extraction-coverage report. Shared by Settings
// (Data) and Tracked jobs, which each show the result in their own status box.
//
// The CSV export covers tracked jobs only. Profiles, model settings and a
// job's status, notes and brief are not in it — and uninstalling the
// extension wipes chrome.storage.local with no warning, which is exactly how a
// search history gets lost. A backup is the full picture.

var JOB_FIT_BACKUP = (function () {
  const FORMAT = "jobfit-backup";
  const VERSION = 1;

  function download(text, type, filename) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // Downloads the backup file. Returns the confirmation to show.
  async function exportAll() {
    const stored = await chrome.storage.local.get(["profiles", "activeProfileId", "lmStudio", "modelProvider", "openai"]);
    // The queue and lastSummary are deliberately left out: both are transient
    // working state, and the queue holds tab ids that mean nothing on restore.
    const payload = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      profiles: stored.profiles || [],
      activeProfileId: stored.activeProfileId || null,
      lmStudio: stored.lmStudio || null,
      modelProvider: stored.modelProvider || "lmstudio",
      // The API key is deliberately left out: a backup file gets copied around,
      // and a leaked key is billed to its owner.
      openai: stored.openai ? { model: stored.openai.model || "", reasoningEffort: stored.openai.reasoningEffort || "" } : null,
      records: await JOB_FIT_EVALSTORE.exportRecords(),
    };
    download(JSON.stringify(payload, null, 2), "application/json", `tino-backup-${today()}.json`);
    return t("backup.done", { profiles: payload.profiles.length, jobs: payload.records.length });
  }

  // Everything here comes from a file on disk, so it is treated as untrusted:
  // only known fields are read, profiles go through normalize() before being
  // stored, and nothing existing is ever overwritten.
  // Returns { ok, text } — the summary (or the error) to show.
  async function importFile(file) {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (err) {
      return { ok: false, text: t("backup.badJson", { error: err.message }) };
    }
    if (!payload || payload.format !== FORMAT) return { ok: false, text: t("backup.notBackup") };
    if (payload.version > VERSION) return { ok: false, text: t("backup.newer", { version: payload.version }) };

    const store = await JOB_FIT_PROFILES.load();
    const existingIds = new Set(store.profiles.map((p) => p.id));
    let profilesAdded = 0;
    let profilesSkipped = 0;

    (Array.isArray(payload.profiles) ? payload.profiles : []).forEach((raw) => {
      if (!raw || typeof raw !== "object" || !raw.id) return;
      if (existingIds.has(raw.id)) {
        profilesSkipped++;
        return;
      }
      store.profiles.push(JOB_FIT_PROFILES.normalize(raw));
      existingIds.add(raw.id);
      profilesAdded++;
    });

    if (profilesAdded) await JOB_FIT_PROFILES.save(store);

    let added = 0;
    let skipped = 0;
    let invalid = 0;
    for (const record of Array.isArray(payload.records) ? payload.records : []) {
      // Only for profiles that exist here, so a job can't be orphaned into a
      // profile nothing references.
      if (!record || !existingIds.has(record.profileId)) {
        invalid++;
        continue;
      }
      const outcome = await JOB_FIT_EVALSTORE.importRecord(record);
      if (outcome === "added") added++;
      else if (outcome === "skipped") skipped++;
      else invalid++;
    }

    // Applied only when nothing is configured here, so restoring a friend's
    // backup can't silently repoint your endpoint at theirs.
    const current = await chrome.storage.local.get("lmStudio");
    let settingsNote = "";
    if (payload.lmStudio && typeof payload.lmStudio === "object" && !(current.lmStudio && current.lmStudio.model)) {
      // Never an endpoint off this machine: a shared backup would otherwise
      // send every later evaluation, CV included, wherever it said. That one
      // is named instead, to set in Settings › Model if it's really yours.
      const restored = { ...payload.lmStudio };
      const policy = JOB_FIT_PROVIDER.endpointPolicy(restored.url);
      if (policy.kind !== "loopback") {
        restored.url = (current.lmStudio && current.lmStudio.url) || JOB_FIT_DEFAULTS.lmStudio.url;
        if (policy.origin) settingsNote += `\n${t("backup.urlNotRestored", { origin: policy.origin })}`;
      }
      await chrome.storage.local.set({ lmStudio: restored });
      settingsNote = `\n${t("backup.lmRestored")}${settingsNote}`;
    } else if (payload.lmStudio) {
      settingsNote = `\n${t("backup.lmKept")}`;
    }
    // Only the OpenAI model choice is in a backup, never the key, and it's
    // restored only if none is set here. The provider switch itself is left as
    // it is: restoring onto a machine without a key would just break scoring.
    const currentOpenAi = (await chrome.storage.local.get("openai")).openai || {};
    if (payload.openai && payload.openai.model && !currentOpenAi.model) {
      await chrome.storage.local.set({
        openai: { ...currentOpenAi, model: String(payload.openai.model), reasoningEffort: String(payload.openai.reasoningEffort || "") },
      });
      settingsNote += `\n${t("backup.oaRestored")}`;
    }

    const lines = [
      t("backup.restoredFrom", { date: payload.exportedAt ? payload.exportedAt.slice(0, 10) : "—" }),
      t("backup.profilesLine", { added: profilesAdded, skipped: profilesSkipped }),
      t("backup.jobsLine", { added, skipped, invalid }),
      t("backup.nothingOverwritten"),
    ];
    return { ok: true, text: lines.join("\n") + settingsNote };
  }

  // Reports what the JSON-LD probe saw, so the decision to build JSON-LD
  // extraction (or not) comes from real browsing rather than an assumption.
  // The number that matters is the last column: not whether JSON-LD was
  // present, but whether it held something the extractor had missed.
  // Returns { empty, text }.
  async function probeReport() {
    const stored = await chrome.storage.local.get("jsonLdProbe");
    const samples = (stored.jsonLdProbe && stored.jsonLdProbe.samples) || [];
    if (!samples.length) return { empty: true, text: t("history.probeEmpty") };

    const byHost = new Map();
    samples.forEach((s) => {
      const row = byHost.get(s.host) || { seen: 0, found: 0, adds: 0 };
      row.seen++;
      if (s.found) row.found++;
      if ((s.wouldAdd || []).length) row.adds++;
      byHost.set(s.host, row);
    });

    const found = samples.filter((s) => s.found).length;
    const helped = samples.filter((s) => (s.wouldAdd || []).length).length;
    const fieldCounts = {};
    samples.forEach((s) => (s.wouldAdd || []).forEach((f) => (fieldCounts[f] = (fieldCounts[f] || 0) + 1)));

    const pct = (n) => `${Math.round((n / samples.length) * 100)}%`;
    const lines = [
      `${samples.length} pages sampled`,
      `JSON-LD JobPosting found on ${found} (${pct(found)})`,
      `Would have added something on ${helped} (${pct(helped)})`,
      Object.keys(fieldCounts).length
        ? `  fields: ${Object.entries(fieldCounts).map(([f, n]) => `${f} ×${n}`).join(", ")}`
        : "  fields: none",
      "",
      "host                                  seen  found  adds",
    ];
    [...byHost.entries()]
      .sort((a, b) => b[1].seen - a[1].seen)
      .forEach(([host, row]) => {
        lines.push(`${host.slice(0, 36).padEnd(36)}  ${String(row.seen).padStart(4)}  ${String(row.found).padStart(5)}  ${String(row.adds).padStart(4)}`);
      });
    return { empty: false, text: lines.join("\n") };
  }

  return { exportAll, importFile, probeReport, download };
})();
