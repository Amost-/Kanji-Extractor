// This fixture models the background MESSAGE CONTRACT only. Coordinator tests
// exercise persistence/merging separately; no popup test implements a sync loop.
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function emptyState() {
  return { schemaVersion: 2, revision: 1, generation: 1, seenKanji: {},
    newOnlyEnabled: false, extractMode: "kanji-words", syncEnabled: false,
    syncQueue: {}, syncToken: null,
    sync: { phase: "idle", requested: false, nextAttemptAt: 0,
      lastSuccessAt: null, error: null, pages: 0, sent: 0, resetPending: false } };
}
let stored = emptyState();
let commandMessages = [];
let storageListener;
let commandHandler = async () => ({ ok: true, state: copy(stored) });
const elements = {};
function element(id) {
  return elements[id] || (elements[id] = {
    id, handlers: {}, style: {}, dataset: {}, checked: false, disabled: false,
    textContent: "", value: "", files: [],
    addEventListener(type, callback) { this.handlers[type] = callback; },
    appendChild() {}, click() {},
    // Minimal classList for the save-confirmation class on the download button.
    classes: new Set(),
    classList: {
      add(name) { elements[id].classes.add(name); },
      remove(name) { elements[id].classes.delete(name); },
      contains(name) { return elements[id].classes.has(name); },
    },
  });
}
var document = {
  documentElement: {},
  getElementById: element,
  querySelectorAll: () => [],
  createElement: () => ({ appendChild() {} }),
  createDocumentFragment: () => ({ appendChild() {} }),
};
var navigator = { userAgent: "Firefox", vendor: "" };
var confirm = () => true;
let timerSequence = 0;
const fixtureTimers = new Map();
var setTimeout = (callback) => { const id = ++timerSequence; fixtureTimers.set(id, callback); return id; };
var clearTimeout = (id) => fixtureTimers.delete(id);
const fixtureAPI = {
  runtime: {
    sendMessage(...args) {
      if (args.length !== (POPUP_TEST_PROMISE_API ? 1 : 2)) {
        throw new Error("Wrong runtime.sendMessage signature for this platform");
      }
      const [message, callback] = args;
      commandMessages.push(copy(message));
      if (POPUP_TEST_PROMISE_API) return commandHandler(copy(message));
      Promise.resolve().then(() => commandHandler(copy(message))).then(
        (response) => callback(response),
        (error) => {
          fixtureAPI.runtime.lastError = { message: error.message };
          try { callback(undefined); } finally { delete fixtureAPI.runtime.lastError; }
        }
      );
    },
  },
  tabs: { query: async () => [{ id: 1, url: "https://example.jp/" }] },
  storage: {
    local: {
      get() { throw new Error("Popup must not read storage directly"); },
      set() { throw new Error("Popup must not mutate storage directly"); },
    },
    onChanged: { addListener(callback) { storageListener = callback; } },
  },
};
var browser = POPUP_TEST_PROMISE_API ? fixtureAPI : undefined;
var chrome = POPUP_TEST_PROMISE_API ? undefined : fixtureAPI;

function publishState(patch) {
  stored = { ...stored, ...copy(patch), revision: stored.revision + 1 };
  storageListener({ kanjiState: { newValue: copy(stored) } }, "local");
}
function replyWith(patch, added) {
  stored = { ...stored, ...copy(patch), revision: stored.revision + 1 };
  return { ok: true, state: copy(stored), added: added || 0 };
}
