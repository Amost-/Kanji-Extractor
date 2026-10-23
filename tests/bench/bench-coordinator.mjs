// =============================================================================
// bench-coordinator.mjs -- runtime MEASUREMENT harness for sync-coordinator.js.
//
// Purpose: show what each coordinator operation costs as the history grows
// (1k / 12k / 50k terms). Every operation reads the whole `kanjiState`, deep
// copies it, validates it and writes it back; this script quantifies that.
// It is a measurement tool, not a test: it asserts nothing about product
// behaviour except sanity checks that the measured operation really did its job.
//
// How it fits: loads src/sync-core.js + src/sync-coordinator.js unchanged into
// a Node `vm` context (the same files the tests and the browser use), and
// drives them with an in-memory storage that structured-clones on get/set like
// a real browser, plus a fake native layer. Nothing in src/ is touched.
//
// Run (node is not on PATH on this Mac):
//   node \
//     tests/bench/bench-coordinator.mjs
// Any Node >= 18 works; there are no npm dependencies.
// =============================================================================
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIZES = [1000, 12000, 50000];
const EXTRA_TERMS = 1000;       // spare unique terms: new commits and remote records
const COMMIT_COUNT = 200;       // terms committed by the big commitTerms case
const PULL_RECORDS = 400;       // one pull page (SYNC_BATCH_SIZE in the coordinator)
const PUSH_QUEUE = 200;         // terms waiting to be pushed in the sync cycle case

// ---------------------------------------------------------------------------
// Loading the real sources
// ---------------------------------------------------------------------------

// Evaluates sync-core.js then sync-coordinator.js in one fresh vm context (the
// second file sees the first one's globals, as in the background page) and
// returns the pieces the benchmark needs.
function loadSources() {
  const context = vm.createContext({ console });
  for (const file of ["src/sync-core.js", "src/sync-coordinator.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  }
  return {
    createSyncCoordinator: vm.runInContext("createSyncCoordinator", context),
    sortSeenByCount: vm.runInContext("sortSeenByCount", context),
  };
}
const { createSyncCoordinator, sortSeenByCount } = loadSources();

// ---------------------------------------------------------------------------
// Realistic data generation (deterministic, so runs are comparable)
// ---------------------------------------------------------------------------

// Small seeded PRNG (mulberry32) so every run builds identical histories.
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns `count` unique 2-4 character CJK terms. Characters are drawn from a
// 3000-kanji pool with a skew towards common ones, like real vocabulary.
function makeTerms(count, random) {
  const POOL = 3000;
  const seen = new Set();
  const terms = [];
  while (terms.length < count) {
    const r = random();
    const length = r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
    let term = "";
    for (let i = 0; i < length; i++) {
      term += String.fromCodePoint(0x4E00 + Math.floor(random() * random() * POOL));
    }
    if (!seen.has(term)) { seen.add(term); terms.push(term); }
  }
  return terms;
}

// ISO date (YYYY-MM-DD) from a day offset after 2025-01-01.
function isoDay(offset) {
  return new Date(Date.UTC(2025, 0, 1) + offset * 86400000).toISOString().slice(0, 10);
}

// A ~60 character first-seen URL, as stored in real histories.
function makeUrl(random) {
  const slug = Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0");
  return ("https://www.example.jp/news/article/" + slug + "/2026/09/index.html").slice(0, 60);
}

// Builds a complete valid `kanjiState` envelope with `terms` as its history
// (Zipf-like counts, sorted by count as the coordinator keeps it). Options:
// syncEnabled, requested (a pending job), queue (terms in syncQueue).
function buildState(terms, options = {}) {
  const random = makeRandom(7);
  const seen = {};
  terms.forEach((term, rank) => {
    const first = Math.floor(random() * 600);
    seen[term] = {
      count: Math.max(1, Math.floor(20000 / (rank + 1) ** 0.9)),
      firstSeen: isoDay(first), lastSeen: isoDay(first + Math.floor(random() * 200)),
      firstUrl: makeUrl(random),
    };
  });
  // A long-lived install carries a full set of 64 recent command receipts.
  const receipts = {};
  for (let i = 0; i < 64; i++) receipts["popup-abc123:" + i] = { added: i % 7 };
  const revision = 100;
  const queue = {};
  for (const term of options.queue || []) queue[term] = 1;
  return {
    schemaVersion: 2, revision, generation: 0,
    seenKanji: sortSeenByCount(seen),
    newOnlyEnabled: true, extractMode: "kanji-words",
    syncEnabled: !!options.syncEnabled, syncQueue: queue,
    syncToken: options.syncEnabled ? "token-0" : null,
    sync: {
      requested: !!options.requested, phase: options.requested ? "waiting" : "idle",
      stage: "pull", nextAttemptAt: 0, lastSuccessAt: null, error: null,
      pages: 0, sent: 0, attempts: 0, resetPending: false, cycle: revision + 1,
    },
    completedCommands: receipts,
  };
}

// ---------------------------------------------------------------------------
// Instrumented environment: storage mock + fake native layer
// ---------------------------------------------------------------------------

// Creates a coordinator over an in-memory storage seeded with `state`.
// Storage structured-clones on get and set (as browsers do) and meters calls
// and bytes. Time spent only on metering (JSON.stringify for the byte count)
// is accumulated in `meterMs` so the runner can subtract it: the metering is
// not part of what a real browser would do.
function makeEnv(state, { nativeAvailable = true, native } = {}) {
  const disk = { kanjiState: state };
  const env = { gets: 0, sets: 0, bytes: 0, nativeCalls: 0, meterMs: 0, disk };
  env.coordinator = createSyncCoordinator({
    async storageGet(keys) {
      env.gets++;
      const names = Array.isArray(keys) ? keys : Object.keys(keys || disk);
      const result = {};
      for (const key of names) if (key in disk) result[key] = structuredClone(disk[key]);
      return result;
    },
    async storageSet(patch) {
      env.sets++;
      const started = performance.now();
      for (const key of Object.keys(patch)) env.bytes += JSON.stringify(patch[key]).length;
      env.meterMs += performance.now() - started;
      Object.assign(disk, structuredClone(patch));
    },
    async storageRemove(keys) { for (const key of [].concat(keys)) delete disk[key]; },
    async callNative(message) {
      env.nativeCalls++;
      return structuredClone(await native(structuredClone(message)));
    },
    async scheduleWake() {},
    nativeAvailable,
  });
  return env;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Fixed command id generator: each command needs a fresh receipt id.
let commandSequence = 0;
const nextId = () => "bench-" + (++commandSequence);

// Each scenario builds its own start state from the shared term pool
// (`terms` = seed history, `extra` = unused unique terms) and returns
// { state, options, run(env) -> result, check(env, result) }.
// `check` throws if the measured work did not really happen.
function scenarios(terms, extra) {
  const fresh = (count, from = 0) => extra.slice(from, from + count)
    .map((term, i) => ({ term, count: 1 + (i % 5) }));
  const must = (condition, message) => { if (!condition) throw new Error("sanity check failed: " + message); };
  const nativeOk = async (message) => {
    if (message.action === "pull") {
      // 300 unseen terms plus 100 known ones whose count rose remotely.
      const records = extra.slice(COMMIT_COUNT, COMMIT_COUNT + 300)
        .concat(terms.slice(0, 100)).map((term, i) => ({
          term, count: 50000 + i, firstSeen: "2025-02-01", lastSeen: "2026-09-01" }));
      return { ok: true, records, token: "token-1", more: false };
    }
    if (message.action === "push") return { ok: true, confirmed: message.terms.map(t => t.term) };
    return { ok: true };
  };
  const nativeIdle = async (message) =>
    message.action === "pull" ? { ok: true, records: [], token: "token-0", more: false } : { ok: true };
  return [
    { name: "restore()", state: buildState(terms, { syncEnabled: true }), options: {},
      run: env => env.coordinator.restore() },
    { name: "getState command", state: buildState(terms), options: {},
      run: env => env.coordinator.command("getState", {}, nextId()) },
    { name: "setPreferences", state: buildState(terms), options: {},
      run: env => env.coordinator.command("setPreferences", { newOnlyEnabled: false }, nextId()) },
    { name: "commitTerms x1 (sync off)", state: buildState(terms), options: {},
      run: env => env.coordinator.command("commitTerms", { terms: fresh(1), url: "https://example.jp/a" }, nextId()),
      check: (env, r) => must(r.added === 1, "1 term added") },
    { name: "commitTerms x200 (sync off)", state: buildState(terms), options: {},
      run: env => env.coordinator.command("commitTerms", { terms: fresh(COMMIT_COUNT), url: "https://example.jp/a" }, nextId()),
      check: (env, r) => must(r.added === COMMIT_COUNT, "200 terms added") },
    { name: "commitTerms x200 (sync on)", state: buildState(terms, { syncEnabled: true }), options: {},
      run: env => env.coordinator.command("commitTerms", { terms: fresh(COMMIT_COUNT), url: "https://example.jp/a" }, nextId()),
      check: (env, r) => must(r.added === COMMIT_COUNT &&
        Object.keys(env.disk.kanjiState.syncQueue).length === COMMIT_COUNT, "200 queued") },
    { name: "sync cycle (pull 400 + push 200)",
      state: buildState(terms, { syncEnabled: true, requested: true, queue: terms.slice(0, PUSH_QUEUE) }),
      options: { native: nativeOk },
      run: env => env.coordinator.run(8),
      check: (env) => {
        const s = env.disk.kanjiState;
        must(!s.sync.requested && s.sync.phase === "idle" && !s.sync.error, "job finished: " + JSON.stringify(s.sync));
        must(Object.keys(s.syncQueue).length === 0, "queue drained");
        must(Object.keys(s.seenKanji).length === terms.length + 300, "300 remote terms merged");
        must(env.nativeCalls === 2, "one pull and one push");
      } },
    { name: "periodic sync, nothing new",
      state: buildState(terms, { syncEnabled: true }), options: { native: nativeIdle },
      // requestPeriodic arms the job (as the alarm does); run() then does the empty pull.
      run: async env => { await env.coordinator.requestPeriodic(); await env.coordinator.run(8); },
      check: (env) => must(!env.disk.kanjiState.sync.requested && env.nativeCalls === 1, "idle cycle done") },
  ];
}

// ---------------------------------------------------------------------------
// Runner and report
// ---------------------------------------------------------------------------

// Median of a list of numbers.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Runs one scenario: one untimed warm-up, then `runs` timed runs, each on a
// fresh clone of the start state (cloning is outside the timed region).
// Returns the median time plus the (deterministic) call and byte counters.
async function measure(scenario, runs) {
  const times = [];
  let last;
  for (let i = -1; i < runs; i++) {
    const env = makeEnv(structuredClone(scenario.state), scenario.options);
    const started = performance.now();
    const result = await scenario.run(env);
    const elapsed = performance.now() - started - env.meterMs;
    if (scenario.check) scenario.check(env, result);
    if (i >= 0) times.push(elapsed);
    last = { env, result };
  }
  const reply = last.result && last.result.state ? JSON.stringify(last.result.state).length : 0;
  return { ms: median(times), min: Math.min(...times), gets: last.env.gets, sets: last.env.sets,
    bytes: last.env.bytes, reply };
}

// Formats bytes as MB with two decimals ("-" for zero).
const mb = bytes => bytes ? (bytes / 1048576).toFixed(2) : "-";

async function main() {
  const rows = [];
  const started = performance.now();
  for (const size of SIZES) {
    const all = makeTerms(size + EXTRA_TERMS, makeRandom(size));
    const terms = all.slice(0, size), extra = all.slice(size);
    const stateBytes = JSON.stringify(buildState(terms)).length;
    // Fewer repetitions where one run takes seconds, to stay within the time budget.
    const runs = size >= 50000 ? 5 : 9;
    for (const scenario of scenarios(terms, extra)) {
      const r = await measure(scenario, runs);
      rows.push({ size, name: scenario.name, stateBytes, ...r });
    }
    console.error("done N=" + size + " (" + ((performance.now() - started) / 1000).toFixed(1) + " s)");
  }
  const header = ["terms", "state MB", "operation", "median ms", "min ms", "gets", "sets", "written MB", "reply MB"];
  const table = rows.map(r => [String(r.size), mb(r.stateBytes), r.name, r.ms.toFixed(1), r.min.toFixed(1),
    String(r.gets), String(r.sets), mb(r.bytes), mb(r.reply)]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map(row => row[i].length)));
  const line = row => row.map((cell, i) => i === 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join("  ");
  console.log("Node " + process.version + "; storage mock structured-clones on get/set; time excludes byte metering.");
  console.log(line(header));
  console.log(widths.map(w => "-".repeat(w)).join("  "));
  let previous = null;
  for (let i = 0; i < table.length; i++) {
    if (previous !== null && rows[i].size !== previous) console.log("");
    previous = rows[i].size;
    console.log(line(table[i]));
  }
}

main().catch(error => { console.error(error); process.exit(1); });
