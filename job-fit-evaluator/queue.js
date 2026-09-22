// Serial queue for local-model work.
//
// Why the queue owns the work rather than the page that started it: the
// content script used to drive an evaluation end to end, which only works
// while that page sits still. The whole point of queueing is that you click
// job after job — and on LinkedIn's search layout clicking the next job
// replaces the description DOM, while a direct job page navigates outright.
// Either way the script waiting for a result is gone. So the posting text is
// extracted at ENQUEUE time and handed over; processing needs no tab at all.
//
// Runs in the service worker. Dependencies are injected via configure() so
// the state machine can be exercised without Chrome.
var JOB_FIT_QUEUE = (function () {
  const KEY = "queue";
  const MAX_ITEMS = 10;
  // Only re-attempts caused by a lost worker count here. A model-level failure
  // goes straight to `failed` — the same posting through the same model at
  // temperature 0.2 will not parse differently on a second go, and the user
  // has a Retry button for the cases where something really did change.
  const MAX_ATTEMPTS = 2;
  const LEASE_SLACK_MS = 30000;

  let deps = {
    evaluate: async () => ({ ok: false, error: "queue not configured", failure: "config" }),
    summarize: async () => ({ ok: false, error: "queue not configured", failure: "config" }),
    timeoutMs: async () => 300000,
    setBadge: async () => {},
    now: () => Date.now(),
  };

  // Guards the pump loop within one worker lifetime. Cross-lifetime safety is
  // the lease, not this.
  let pumping = false;

  function configure(next) {
    deps = { ...deps, ...next };
  }

  function emptyQueue() {
    return { items: [], state: "idle", consecutiveTimeouts: 0, pauseReason: null };
  }

  function newId() {
    return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function read() {
    const stored = await chrome.storage.local.get(KEY);
    const queue = stored[KEY];
    if (!queue || !Array.isArray(queue.items)) return emptyQueue();
    return { ...emptyQueue(), ...queue };
  }

  async function write(queue) {
    await chrome.storage.local.set({ [KEY]: queue });
    await deps.setBadge(activeCount(queue), queue.state);
    return queue;
  }

  function activeCount(queue) {
    return queue.items.filter((i) => i.state === "pending" || i.state === "processing").length;
  }

  function positionOf(queue, id) {
    const active = queue.items.filter((i) => i.state === "pending" || i.state === "processing");
    return active.findIndex((i) => i.id === id) + 1;
  }

  // A `processing` item whose lease has expired means the worker died holding
  // it. Without reclaiming, one crash leaves the item processing forever and
  // the queue never moves again.
  function reclaimExpired(queue) {
    const now = deps.now();
    let reclaimed = 0;
    queue.items.forEach((item) => {
      if (item.state !== "processing" || !item.leaseUntil || item.leaseUntil > now) return;
      reclaimed++;
      item.leaseUntil = null;
      if ((item.attempts || 0) >= MAX_ATTEMPTS) {
        item.state = "failed";
        item.error = "Interrupted repeatedly — the browser or extension restarted mid-evaluation.";
      } else {
        item.state = "pending";
      }
    });
    return reclaimed;
  }

  // "Pause on connection errors, continue on model errors." An unreachable
  // server or a bad HTTP status will fail identically for every remaining
  // item, so burning the whole queue on it wastes the walk-away time the queue
  // exists to protect. Two timeouts in a row is the machine, not the posting.
  function shouldPause(failure, consecutiveTimeouts) {
    if (failure === "unreachable" || failure === "http" || failure === "config") return true;
    if (failure === "timeout") return consecutiveTimeouts >= 2;
    return false;
  }

  async function enqueue(entry, { priority = false } = {}) {
    const queue = await read();
    reclaimExpired(queue);

    const kind = entry.kind || "evaluate";
    const active = queue.items.filter((i) => i.state === "pending" || i.state === "processing");

    const duplicate = active.find(
      (i) => i.kind === kind && i.profileId === entry.profileId && i.jobKey === entry.jobKey
    );
    if (duplicate) {
      await write(queue);
      return { ok: true, duplicate: true, position: positionOf(queue, duplicate.id), total: active.length };
    }

    if (active.length >= MAX_ITEMS) {
      await write(queue);
      return { ok: false, full: true, max: MAX_ITEMS, total: active.length };
    }

    const item = {
      id: newId(),
      kind,
      state: "pending",
      attempts: 0,
      leaseUntil: null,
      error: null,
      enqueuedAt: deps.now(),
      ...entry,
    };

    if (priority) {
      // Ahead of the pending items but never ahead of the one in flight —
      // aborting a generation that is minutes in would waste more than it saves.
      const firstPending = queue.items.findIndex((i) => i.state === "pending");
      if (firstPending === -1) queue.items.push(item);
      else queue.items.splice(firstPending, 0, item);
    } else {
      queue.items.push(item);
    }

    if (queue.state !== "paused") queue.state = "running";
    await write(queue);
    return { ok: true, position: positionOf(queue, item.id), total: active.length + 1, id: item.id };
  }

  // A throw here — a storage write failing, a malformed record, anything
  // unforeseen — must not escape into pump(). It would reject the loop, leave
  // the item stuck in `processing`, and wedge the queue until the lease
  // expired minutes later. Turned into an ordinary item-level failure instead,
  // which the pump already knows how to skip past.
  async function runOne(item) {
    try {
      const result = item.kind === "summarize" ? await deps.summarize(item) : await deps.evaluate(item);
      return result || { ok: false, failure: "internal", error: "No result returned" };
    } catch (err) {
      return { ok: false, failure: "internal", error: err && err.message ? err.message : String(err) };
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;

    try {
      for (;;) {
        let queue = await read();
        reclaimExpired(queue);

        if (queue.state === "paused") {
          await write(queue);
          break;
        }

        const next = queue.items.find((i) => i.state === "pending");
        if (!next) {
          queue.state = "idle";
          queue.pauseReason = null;
          await write(queue);
          break;
        }

        next.state = "processing";
        next.attempts = (next.attempts || 0) + 1;
        next.startedAt = deps.now();
        next.leaseUntil = deps.now() + (await deps.timeoutMs()) + LEASE_SLACK_MS;
        queue.state = "running";
        await write(queue);

        const outcome = await runOne(next);

        // Re-read rather than reusing the object above: the item may have been
        // cancelled, or the whole queue cleared, while the model was running.
        queue = await read();
        const item = queue.items.find((i) => i.id === next.id);
        if (!item || item.state === "cancelled") {
          await write(queue);
          continue;
        }

        item.leaseUntil = null;
        item.finishedAt = deps.now();

        if (outcome.ok) {
          item.state = "done";
          item.error = null;
          queue.consecutiveTimeouts = 0;
          await write(queue);
          continue;
        }

        item.error = outcome.error || "Unknown error";
        queue.consecutiveTimeouts = outcome.failure === "timeout" ? (queue.consecutiveTimeouts || 0) + 1 : 0;

        if (shouldPause(outcome.failure, queue.consecutiveTimeouts)) {
          // Kept pending, not failed: nothing is wrong with the item, so
          // resuming should just run it.
          item.state = "pending";
          item.attempts = Math.max(0, (item.attempts || 1) - 1);
          queue.state = "paused";
          queue.pauseReason = outcome.error || "Local model unavailable";
          await write(queue);
          break;
        }

        item.state = "failed";
        await write(queue);
      }
    } finally {
      pumping = false;
    }
  }

  async function cancel(id) {
    const queue = await read();
    const item = queue.items.find((i) => i.id === id);
    if (!item) return { ok: false };
    // An in-flight item is marked cancelled and dropped when the pump comes
    // back to it; the fetch itself is left alone so a nearly-finished
    // generation isn't thrown away.
    const wasProcessing = item.state === "processing";
    item.state = "cancelled";
    item.leaseUntil = null;
    await write(queue);
    return { ok: true, wasProcessing };
  }

  async function retry(id) {
    const queue = await read();
    const item = queue.items.find((i) => i.id === id);
    if (!item) return { ok: false };
    item.state = "pending";
    item.attempts = 0;
    item.error = null;
    item.leaseUntil = null;
    if (queue.state !== "paused") queue.state = "running";
    await write(queue);
    return { ok: true };
  }

  async function resume() {
    const queue = await read();
    queue.state = activeCount(queue) ? "running" : "idle";
    queue.pauseReason = null;
    queue.consecutiveTimeouts = 0;
    await write(queue);
    return { ok: true };
  }

  async function clearFinished() {
    const queue = await read();
    queue.items = queue.items.filter((i) => i.state === "pending" || i.state === "processing");
    if (!queue.items.length && queue.state !== "paused") queue.state = "idle";
    await write(queue);
    return { ok: true };
  }

  async function snapshot() {
    const queue = await read();
    return { ...queue, active: activeCount(queue) };
  }

  return {
    MAX_ITEMS,
    configure,
    enqueue,
    pump,
    cancel,
    retry,
    resume,
    clearFinished,
    snapshot,
    read,
    write,
    reclaimExpired,
    shouldPause,
    activeCount,
    positionOf,
  };
})();
