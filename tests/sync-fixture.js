// Shared deterministic harness for the real coordinator. Every storage and
// native boundary clones its payload, as browser messaging does in production.
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}
// Reproduce Foundation's shared empty dictionaries/arrays on Safari's bridge.
// Nonempty containers remain distinct even when their contents match. The
// source is untouched; aliasing exists only inside one returned snapshot.
function withAliasedObjects(value) {
  const empty = {};
  const emptyArray = [];
  function decode(item) {
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.length ? item.map(decode) : emptyArray;
    const entries = Object.entries(item);
    if (!entries.length) return empty;
    return Object.fromEntries(entries.map(([key, child]) => [key, decode(child)]));
  }
  return decode(value);
}
function equal(actual, expected, message) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(message + "\nExpected: " + JSON.stringify(expected)
      + "\nActual:   " + JSON.stringify(actual));
  }
}
function check(condition, message) { if (!condition) throw new Error(message); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function rejects(callback, code) {
  let caught;
  try { await callback(); } catch (error) { caught = error; }
  check(!!caught, "Expected rejection" + (code ? " with code " + code : ""));
  if (code) equal(caught.code, code, "rejection code");
  return caught;
}
function record(term, count) {
  return { term, count: count === undefined ? 2 : count,
    firstSeen: "2026-09-01", lastSeen: "2026-09-07" };
}
function page(records, token, more) {
  return { ok: true, records: records || [], token: token || "cursor-final", more: !!more };
}
// Bytes as a browser quota counts them: every key and its serialized value.
function usage(store) {
  return Object.keys(store).reduce((total, key) => total + key.length + JSON.stringify(store[key]).length, 0);
}
function fixture(initial, options) {
  const disk = copy(initial || {});
  const writes = [], nativeCalls = [], wakes = [], writeFailures = [];
  const removes = [], removeFailures = [], readFailures = [];
  // Every storage.get, as the key list (or defaults object) it asked for, so
  // cases can count how often the whole envelope is read.
  const reads = [];
  // Pending scheduleWake failures, as an alarms API refusal would cause.
  const wakeFailures = [];
  const settings = options || {};
  let clock = Date.UTC(2026, 8, 7, 12);
  let sequence = 0;
  const f = {
    disk, writes, nativeCalls, wakes, removes, reads,
    // Number of reads that fetched the kanjiState envelope (its full cost).
    envelopeReads: () => reads.filter(keys => Array.isArray(keys) && keys.includes("kanjiState")).length,
    // Number of writes that replaced the kanjiState envelope.
    envelopeWrites: () => writes.filter(patch => Object.prototype.hasOwnProperty.call(patch, "kanjiState")).length,
    // Forget the counted reads, writes and wakes before the measured step.
    resetCounters() { reads.length = 0; writes.length = 0; wakes.length = 0; },
    beforeWrite: null,
    // A byte limit over every stored key; null means no quota. A write that
    // would not fit is refused whole, before anything is committed.
    quota: null,
    quotaError: () => new Error("QUOTA_BYTES quota exceeded"),
    usage: () => usage(disk),
    native: async (message) => message.action === "pull" ? page() : { ok: true },
    now: () => clock,
    advance(ms) { clock += ms; },
    advanceToDue() {
      const state = f.state();
      clock = Math.max(clock, (state && state.sync.nextAttemptAt) || 0);
    },
    state: () => copy(disk.kanjiState),
    failNextWrite(mode) { writeFailures.push(mode || "before"); },
    failNextRemove() { removeFailures.push(true); },
    failNextRead() { readFailures.push(true); },
    failNextWake() { wakeFailures.push(true); },
    async storageGet(keys) {
      reads.push(copy(keys));
      if (readFailures.shift()) throw new Error("simulated storage read failure");
      const result = Array.isArray(keys) ? {} : copy(keys || {});
      for (const key of (Array.isArray(keys) ? keys : Object.keys(keys || disk))) {
        if (Object.prototype.hasOwnProperty.call(disk, key)) result[key] = copy(disk[key]);
      }
      return settings.aliasReads ? withAliasedObjects(result) : result;
    },
    async storageSet(patch) {
      if (f.beforeWrite) await f.beforeWrite(copy(patch));
      const mode = writeFailures.shift();
      if (mode === "before") throw new Error("simulated storage write failure");
      if (f.quota !== null && usage({ ...disk, ...copy(patch) }) > f.quota) throw f.quotaError();
      writes.push(copy(patch));
      Object.assign(disk, copy(patch));
      // The browser may commit a write before its reply is lost. The next
      // command must consult committed state rather than an obsolete cache.
      if (mode === "after") throw new Error("simulated lost storage acknowledgement");
    },
    async storageRemove(keys) {
      if (removeFailures.shift()) throw new Error("simulated storage remove failure");
      removes.push(copy(keys));
      for (const key of Array.isArray(keys) ? keys : [keys]) delete disk[key];
    },
    async callNative(message) {
      nativeCalls.push(copy(message));
      return copy(await f.native(copy(message)));
    },
    async scheduleWake(epochMs) {
      if (wakeFailures.shift()) throw new Error("simulated alarm failure");
      wakes.push(epochMs);
    },
    restart() {
      f.coordinator = createSyncCoordinator({
        storageGet: f.storageGet, storageSet: f.storageSet, storageRemove: f.storageRemove,
        callNative: f.callNative, scheduleWake: f.scheduleWake,
        nativeAvailable: settings.nativeAvailable !== false,
        now: f.now, random: () => 0.5,
      });
      return f.coordinator;
    },
    command(name, payload, id) {
      return f.coordinator.command(name, payload || {}, id || "test-command-" + (++sequence));
    },
    async enable() {
      await f.coordinator.restore();
      await f.command("setSyncEnabled", { enabled: true });
    },
    async drain(limit) {
      for (let attempt = 0; attempt < (limit || 20); attempt++) {
        const state = f.state();
        if (state && !state.sync.requested && !state.sync.resetPending) return;
        f.advanceToDue();
        await f.coordinator.run(8);
      }
      throw new Error("Sync did not finish within the fixture budget");
    },
  };
  f.restart();
  return f;
}
let passed = 0, failed = 0;
async function test(name, callback) {
  try { await callback(); passed++; print("PASS " + name); }
  catch (error) { failed++; print("FAIL " + name + ": " + (error.stack || error.message)); }
}
function finishTests() {
  print(passed + " sync cases passed; " + failed + " failed.");
  if (failed) quit(1);
  else print("KANJI_SYNC_TESTS_OK");
}
