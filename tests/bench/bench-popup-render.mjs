// =============================================================================
// bench-popup-render.mjs -- measures popup.js `renderState` on large histories.
//
// Purpose: popup.js calls renderState on every storage.onChanged event of
// `kanjiState` and on every background command reply, each time with the
// WHOLE state (seenKanji included). This script times that call for 1k / 12k /
// 50k terms, and, for context, the structured clone a browser performs to
// deliver such a state to the popup.
//
// How it fits: reuses tests/popup-fixture.js (fake DOM, fake runtime/storage)
// exactly like tests/test_popup.py does, but in a Node `vm` context instead of
// JavaScriptCore. src/popup.js is read unchanged; only its init IIFE is named
// so the script can wait for it, as test_popup.py does. DOM work is a fake, so
// the numbers show the JavaScript cost only, not real layout/paint.
//
// Run (node is not on PATH on this Mac):
//   node \
//     tests/bench/bench-popup-render.mjs
// =============================================================================
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIZES = [1000, 12000, 50000];
const LAST_RESULT_TERMS = 500;   // size of a typical scan result held by the popup

// Loads fixture + popup.js into a fresh context (same order as test_popup.py,
// Promise-API flavour) and returns it after the popup's init has settled.
async function loadPopup() {
  const popup = fs.readFileSync(path.join(ROOT, "src/popup.js"), "utf8")
    .replace("(async () => {", "const popupReady = (async () => {");
  const fixture = fs.readFileSync(path.join(ROOT, "tests/popup-fixture.js"), "utf8");
  const context = vm.createContext({ print: () => {}, console });
  vm.runInContext("const POPUP_TEST_PROMISE_API = true;\n" + fixture + "\n" + popup, context);
  await vm.runInContext("popupReady", context);
  return context;
}

// Builds a state with `n` distinct CJK terms (content is irrelevant to
// renderState; only the key count and lookups matter) and a revision.
function buildState(n, revision) {
  const seenKanji = {};
  for (let i = 0; i < n; i++) {
    seenKanji[String.fromCodePoint(0x4E00 + (i % 3000)) + String.fromCodePoint(0x4E00 + Math.floor(i / 3000)) + "語"] =
      { count: 1 + (i % 9), firstSeen: "2025-03-01", lastSeen: "2026-01-01",
        firstUrl: "https://www.example.jp/news/article/abcdefgh/2026/09/index.html" };
  }
  return { schemaVersion: 2, revision, generation: 0, seenKanji, newOnlyEnabled: true,
    extractMode: "kanji-words", syncEnabled: true, syncQueue: {}, syncToken: "t",
    sync: { phase: "idle", requested: false, stage: "pull", nextAttemptAt: 0, lastSuccessAt: null,
      error: null, pages: 0, sent: 0, resetPending: false },
    completedCommands: {} };
}

// Median of a list of numbers.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Times `callback` over `runs` runs after one warm-up; returns the median ms.
function time(callback, runs = 15) {
  callback();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    callback();
    times.push(performance.now() - started);
  }
  return median(times);
}

async function main() {
  let nextRevision = 1000;
  const context = await loadPopup();
  console.log("Node " + process.version + "; fake DOM (JS cost only, no layout/paint)");
  console.log("terms  operation                                         median ms");
  console.log("-----  ------------------------------------------------  ---------");
  for (const size of SIZES) {
    // renderState ignores a state older than the one it already shows, so the
    // revision must keep growing across sizes and runs, or the call would exit early.
    context.state = buildState(size, nextRevision);
    context.bump = () => { context.state.revision = ++nextRevision; };
    // Without a scan result: the popup just opened, or a background-only update.
    const plain = time(() => vm.runInContext("bump(); renderState(state)", context));
    // With a scan result held (user extracted, then a sync event arrives): the
    // popup re-filters its terms against the whole history on every render.
    vm.runInContext(`lastResult = { url: "https://example.jp/", newOnly: false,
      allTerms: Array.from({ length: ${LAST_RESULT_TERMS} }, (_, i) => ({ term: "x" + i, count: 1 })),
      newTerms: [], display: [], totalOccurrences: ${LAST_RESULT_TERMS} };`, context);
    const withResult = time(() => vm.runInContext("bump(); renderState(state)", context));
    vm.runInContext("lastResult = null;", context);
    // What the browser does to hand the state to the popup (not popup.js code).
    const clone = time(() => structuredClone(context.state), 5);
    for (const [name, ms] of [["renderState, no scan result", plain],
      ["renderState, " + LAST_RESULT_TERMS + "-term scan result held", withResult],
      ["structuredClone of the state (delivery cost)", clone]]) {
      console.log(String(size).padStart(5) + "  " + name.padEnd(48) + "  " + ms.toFixed(2).padStart(9));
    }
  }
}

main().catch(error => { console.error(error); process.exit(1); });
