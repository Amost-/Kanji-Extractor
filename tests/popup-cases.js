function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}
function scan(terms, url) {
  const list = terms.map((term) => ({ term, count: 1 }));
  return { url: url || "https://example.jp/", allTerms: list, newTerms: list.slice(),
    display: list.slice(), newOnly: false, totalOccurrences: list.length };
}
function record(count) { return { count: count || 1, firstSeen: "2026-09-07", lastSeen: "2026-09-07", firstUrl: "https://first.jp/" }; }
let passed = 0;
let failed = 0;
async function test(name, callback) {
  stored = emptyState();
  commandMessages = [];
  commandHandler = async () => ({ ok: true, state: copy(stored) });
  navigator.userAgent = "Firefox";
  navigator.vendor = "";
  currentState = null;
  observedReset = false;
  abandonRunning = false;
  lastResult = null;
  saving = false;
  setStatus("");
  renderState(copy(stored));
  try { await callback(); passed++; }
  catch (error) { failed++; print("FAIL " + name + ": " + error.message); }
}
async function importHistory(seenKanji) {
  elements.importInput.files = [{ text: async () => JSON.stringify({
    type: "kanji-extractor-history", version: 1, seenKanji,
  }) }];
  await elements.importInput.handlers.change();
}
// Most cases stub the platform save; the Safari macOS cases run the real one.
const realSaveTextFile = saveTextFile;
function safariMac() {
  navigator.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  navigator.vendor = "Apple Computer, Inc.";
  saveTextFile = realSaveTextFile;
}
// Run a function injected into the page against a stub page, recording the
// order of blob URL work. Deferred callbacks are kept, not scheduled, and
// runDeferred() later runs them against the same stub page.
function runInjected(details) {
  const events = [];
  const deferred = [];
  const page = {
    Blob: function Blob(parts) { this.parts = parts; },
    URL: {
      createObjectURL: () => { events.push("create"); return "blob:page/1"; },
      revokeObjectURL: (url) => events.push("revoke " + url),
    },
    body: { appendChild: () => events.push("append"), removeChild: () => events.push("remove") },
    createElement: () => ({ click() { events.push("click " + this.download); } }),
    setTimeout: (callback, delay) => { deferred.push({ callback, delay }); return 0; },
  };
  function onPage(callback) {
    const saved = { Blob: globalThis.Blob, URL: globalThis.URL, setTimeout,
      body: document.body, createElement: document.createElement };
    globalThis.Blob = page.Blob;
    globalThis.URL = page.URL;
    setTimeout = page.setTimeout;
    document.body = page.body;
    document.createElement = page.createElement;
    try { callback(); }
    finally {
      globalThis.Blob = saved.Blob;
      globalThis.URL = saved.URL;
      setTimeout = saved.setTimeout;
      document.body = saved.body;
      document.createElement = saved.createElement;
    }
  }
  onPage(() => details.func(...details.args));
  return { events, deferred, runDeferred: () => onPage(() => deferred.forEach((timer) => timer.callback())) };
}

(async () => {
  await popupReady;
  equal(commandMessages.map((message) => message.command), ["getState"], "initial state comes from coordinator");

  // A malformed native exchange needs a recognizable localized status.
  await test("protocol errors explain the native message mismatch", async () => {
    equal(syncErrorMessage({ code: "protocol", message: "sync failed" }),
      "The extension received an invalid sync response. Update the extension and try again.",
      "protocol status gives a recovery step");
  });

  // Each reserved URL must be rejected before injection, including store pages.
  for (const url of ["chrome-extension://abc/popup.html", "moz-extension://abc/popup.html",
    "safari-web-extension://abc/popup.html", "view-source:https://example.jp/",
    "devtools://devtools/bundled/inspector.html", "https://chromewebstore.google.com/detail/abc",
    "https://chrome.google.com/webstore/detail/abc", "https://addons.mozilla.org/en-US/firefox/addon/abc/",
    "https://microsoftedge.microsoft.com/addons/detail/abc"]) {
    await test("reserved page: " + url, async () => {
      const query = fixtureAPI.tabs.query;
      fixtureAPI.tabs.query = async () => [{ id: 1, url }];
      fixtureAPI.scripting = { executeScript: async () => { throw new Error("must not inject"); } };
      try {
        await elements.extractBtn.handlers.click();
        equal(elements.status.textContent, "This page can't be scanned by extensions.", "localized restriction");
        equal(commandMessages, [], "no page command");
      } finally { fixtureAPI.tabs.query = query; delete fixtureAPI.scripting; }
    });
  }

  await test("permission failure on a reserved page is localized", async () => {
    const query = fixtureAPI.tabs.query;
    let calls = 0;
    fixtureAPI.tabs.query = async () => [{ id: 1, url: calls++ ? "https://addons.mozilla.org/" : "https://example.jp/" }];
    fixtureAPI.scripting = { executeScript: async () => { throw new Error("Missing host permission"); } };
    try {
      await elements.extractBtn.handlers.click();
      equal(elements.status.textContent, "This page can't be scanned by extensions.", "permission error translated");
    } finally { fixtureAPI.tabs.query = query; delete fixtureAPI.scripting; }
  });

  await test("one added download term uses singular", async () => {
    fixtureAPI.i18n = { getMessage: (key) => ({ saved_added: "WRONG PLURAL", saved_added_one: "Download started: file — added 1 term to your known list." })[key] || "" };
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    commandHandler = async () => replyWith({ seenKanji: { "日本語": record() } }, 1);
    try {
      await elements.downloadBtn.handlers.click();
      equal(elements.status.textContent.includes("added 1 term to your known list."), true, "singular download");
    } finally { delete fixtureAPI.i18n; }
  });

  await test("one imported term uses singular", async () => {
    fixtureAPI.i18n = { getMessage: (key) => ({ import_done: "WRONG PLURAL", import_done_one: "Imported 1 new term." })[key] || "" };
    commandHandler = async () => replyWith({ seenKanji: { "日本語": record() } }, 1);
    try {
      await importHistory({ "日本語": record() });
      equal(elements.status.textContent, "Imported 1 new term.", "singular import");
    } finally { delete fixtureAPI.i18n; }
  });

  await test("one natively saved term uses singular", async () => {
    safariMac();
    fixtureAPI.i18n = { getMessage: (key) => ({ saved_downloads_added: "WRONG PLURAL",
      saved_downloads_added_one: "Saved to Downloads: file — added 1 term to your known list." })[key] || "" };
    lastResult = scan(["日本語"]);
    commandHandler = async (message) => message.command === "saveFile"
      ? { ok: true, filename: "file" } : replyWith({ seenKanji: { "日本語": record() } }, 1);
    try {
      await elements.downloadBtn.handlers.click();
      equal(elements.status.textContent, "Saved to Downloads: file — added 1 term to your known list.", "singular native save");
    } finally { delete fixtureAPI.i18n; }
  });

  await test("IPv6 host punctuation is absent from export filename", async () => {
    // JavaScriptCore lacks URL, so supply the browser's hostname shape here.
    const originalURL = globalThis.URL;
    globalThis.URL = class { constructor() { this.hostname = "[::1]"; } };
    try {
      equal(/[\[\]:]/.test(makeFilename("https://[::1]/", false)), false, "safe filename");
    } finally { globalThis.URL = originalURL; }
  });

  await test("partial page result is announced in the popup", async () => {
    fixtureAPI.scripting = { executeScript: async () => [{ result: {
      terms: [{ term: "日本語", count: 1 }], totalOccurrences: 1, engine: "segmenter", partial: true,
    } }] };
    try {
      await elements.extractBtn.handlers.click();
      equal(elements.status.textContent.includes("page scanned partially"), true, "partial status announced");
    } finally { delete fixtureAPI.scripting; }
  });

  await test("saving a previous scan submits exactly its exported terms and URL", async () => {
    lastResult = scan(["日本語"], "https://first.jp/");
    let finish;
    let savedText;
    saveTextFile = (text, filename) => { savedText = text; return new Promise((resolve) => { finish = () => resolve({ outcome: "downloaded", filename }); }); };
    commandHandler = async () => replyWith({ seenKanji: { "日本語": record() } }, 1);
    const savingPromise = elements.downloadBtn.handlers.click();
    lastResult = scan(["学校"], "https://second.jp/");
    finish();
    await savingPromise;
    equal(savedText.includes("日本語"), true, "file contains original term");
    equal(commandMessages.length, 1, "one accepted command, no popup sync call");
    equal(commandMessages[0].command, "commitTerms", "commit delegated");
    equal(commandMessages[0].payload, { terms: [{ term: "日本語", count: 1 }], url: "https://first.jp/" }, "snapshot sent");
    equal(lastResult.newTerms.map((t) => t.term), ["学校"], "new scan remains unsaved");
    equal(elements.status.textContent.startsWith("Download started:"), true, "initiation is not claimed as completed file write");
  });

  await test("mode change during saving preserves the submitted snapshot", async () => {
    lastResult = scan(["日本語"]);
    let finish;
    saveTextFile = (text, filename) => new Promise((resolve) => { finish = () => resolve({ outcome: "downloaded", filename }); });
    const promise = elements.downloadBtn.handlers.click();
    lastResult = null;
    finish();
    await promise;
    equal(commandMessages[0].payload.terms, [{ term: "日本語", count: 1 }], "history request survives result invalidation");
  });

  await test("cancelled sharing never submits history", async () => {
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "cancelled", filename });
    await elements.downloadBtn.handlers.click();
    equal(commandMessages, [], "no mutation sent");
    equal(lastResult.newTerms.length, 1, "unsaved term stays new");
  });

  await test("successful sharing submits history after acceptance", async () => {
    lastResult = scan(["日本語"]);
    let accepted = false;
    saveTextFile = async (text, filename) => { accepted = true; return { outcome: "shared", filename }; };
    commandHandler = async () => { equal(accepted, true, "sharing accepted before commit"); return replyWith({ seenKanji: { "日本語": record() } }, 1); };
    await elements.downloadBtn.handlers.click();
    equal(lastResult.newTerms, [], "server state updates known membership");
    equal(commandMessages[0].command, "commitTerms", "shared file accepted by coordinator");
  });

  await test("a confirmed save flashes the download button, then clears it", async () => {
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    commandHandler = async () => replyWith({ seenKanji: { "日本語": record() } }, 1);
    await elements.downloadBtn.handlers.click();
    equal(elements.downloadBtn.classList.contains("saved"), true, "checkmark shown after the history commit");
    // Run the pending clear timer, as the browser would after SAVED_FEEDBACK_MS.
    for (const [timerId, callback] of [...fixtureTimers]) { fixtureTimers.delete(timerId); callback(); }
    equal(elements.downloadBtn.classList.contains("saved"), false, "checkmark removed by its timer");
  });

  await test("a failed history commit does not flash the download button", async () => {
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    commandHandler = async () => ({ ok: false, error: "History write failed", code: "storage" });
    await elements.downloadBtn.handlers.click();
    equal(elements.downloadBtn.classList.contains("saved"), false, "no success cue on failure");
  });

  await test("history acceptance failure is distinguished from download failure", async () => {
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    commandHandler = async () => ({ ok: false, error: "History write failed", code: "storage" });
    await elements.downloadBtn.handlers.click();
    equal(elements.status.textContent.includes("history could not be confirmed"), true, "does not say download failed");
    equal(lastResult.newTerms.length, 1, "no optimistic history commit");
    equal(commandMessages.length, 1, "explicit rejection is not retried");
  });

  await test("import forwards parsed history for atomic coordinator validation", async () => {
    const incoming = { "火が": { count: 2 }, "火か\u3099": { count: 7 } };
    commandHandler = async () => replyWith({ seenKanji: { "火が": record(7) }, syncEnabled: true, syncQueue: { "火が": 2 } }, 1);
    await importHistory(incoming);
    equal(commandMessages[0].command, "importHistory", "import delegated");
    equal(commandMessages[0].payload, { incoming }, "no popup merge or normalization");
    equal(commandMessages.length, 1, "no separate sync request");
    equal(elements.knownCount.textContent, "1 terms known", "render acknowledged state");
  });

  await test("malformed history container never reaches coordinator", async () => {
    await importHistory([]);
    equal(commandMessages, [], "array history rejected before send");
    equal(elements.status.className, "status error", "validation error visible");
  });

  await test("storage updates render progress and membership without polling", async () => {
    navigator.userAgent = "Safari";
    navigator.vendor = "Apple Computer, Inc.";
    lastResult = scan(["日本語", "学校"]);
    publishState({ syncEnabled: true, seenKanji: { "日本語": record() }, syncQueue: { "学校": 3 },
      sync: { ...stored.sync, phase: "pull", pages: 3, requested: true } });
    equal(elements.syncStatus.textContent.includes("pages completed: 3"), true, "persisted page count shown");
    equal(elements.syncPending.textContent, "1 terms waiting to send", "pending count reflects queue");
    equal(lastResult.newTerms.map((t) => t.term), ["学校"], "known membership observes changes");
    equal(commandMessages, [], "notification triggers no requests");
  });

  await test("older response cannot overwrite a newer storage snapshot", async () => {
    publishState({ seenKanji: { "学校": record() } });
    const revision = currentState.revision;
    renderState({ ...emptyState(), revision: revision - 1 });
    equal(Object.keys(currentState.seenKanji), ["学校"], "newer snapshot kept");
  });

  await test("nonempty queue never displays completed sync", async () => {
    publishState({ syncEnabled: true, syncQueue: { "学校": 2 },
      sync: { ...stored.sync, phase: "idle", lastSuccessAt: 1000 } });
    equal(elements.syncStatus.textContent, "Waiting to resume sync.", "pending terms dominate historical success");
    equal(elements.syncLast.textContent.startsWith("Last completed:"), true, "previous completion has distinct label");
  });

  await test("retry requests accepted background work instead of running a loop", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error", error: { code: "network", message: "offline" } } });
    commandHandler = async () => replyWith({ sync: { ...stored.sync, phase: "waiting", requested: true, error: null } });
    await elements.syncRetryBtn.handlers.click();
    equal(commandMessages.map((message) => message.command), ["syncNow"], "single retry command");
    equal(elements.syncStatus.textContent, "Waiting to resume sync.", "acceptance does not claim completion");
  });

  await test("clear stays pending until CloudKit acknowledgement is observed", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true });
    commandHandler = async () => replyWith({ sync: { ...stored.sync, phase: "reset", resetPending: true } });
    await elements.clearBtn.handlers.click();
    equal(commandMessages[0].command, "clearHistory", "clear delegated");
    equal(elements.knownCount.textContent, "1 terms known", "history kept pending acknowledgement");
    equal(elements.status.textContent.includes("waiting for iCloud confirmation"), true, "clear is pending");
    equal(elements.importBtn.disabled, true, "new imports blocked while resetting");
    publishState({ seenKanji: {}, syncQueue: {}, sync: { ...stored.sync, phase: "idle", resetPending: false } });
    equal(elements.knownCount.textContent, "0 terms known", "clear confirmed by persisted state");
    equal(elements.status.textContent, "Known-terms history cleared.", "completion now shown");
    equal(elements.importBtn.disabled, false, "history controls restored");
  });

  await test("local clear reports immediate acknowledged completion", async () => {
    publishState({ seenKanji: { "日本語": record() } });
    commandHandler = async () => replyWith({ seenKanji: {} });
    await elements.clearBtn.handlers.click();
    equal(elements.status.textContent, "Known-terms history cleared.", "local operation complete");
  });

  await test("failed clear leaves visible history intact", async () => {
    publishState({ seenKanji: { "日本語": record() } });
    commandHandler = async () => ({ ok: false, error: "Storage unavailable", code: "storage" });
    await elements.clearBtn.handlers.click();
    equal(elements.knownCount.textContent, "1 terms known", "no optimistic delete");
    equal(elements.status.className, "status error", "rejection visible");
  });

  await test("a reset stuck on a native error lets the user turn sync off", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "error", requested: true,
        error: { code: "network", message: "offline" } } });
    equal(elements.syncToggle.disabled, false, "toggle escapes a stuck reset");
    equal(elements.clearBtn.disabled, false, "clear can retry a stuck reset");
    equal(elements.importBtn.disabled, true, "import stays blocked while the reset intent is still pending");

    commandHandler = async () => replyWith({ syncEnabled: false,
      sync: { ...stored.sync, resetPending: false, phase: "idle", requested: false, error: null } });
    elements.syncToggle.checked = false;
    await elements.syncToggle.handlers.change();
    equal(commandMessages.map((m) => m.command), ["setSyncEnabled"], "turning sync off is the abandon escape hatch");
    equal(commandMessages[0].payload, { enabled: false }, "toggle sends the plain preference change");
    equal(elements.syncToggle.disabled, false, "toggle stays usable once the intent clears");
  });

  await test("clear retries a reset that is stuck on a native error", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "error", requested: true,
        error: { code: "journal", message: "sync failed" } } });
    commandHandler = async () => replyWith({
      sync: { ...stored.sync, resetPending: true, phase: "reset", requested: true, error: null } });
    await elements.clearBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["clearHistory"], "retry re-sends clearHistory");
    equal(elements.status.textContent.includes("waiting for iCloud confirmation"), true, "retry reads as a fresh attempt");
    equal(elements.clearBtn.disabled, false, "a running retry can be forced again");
    equal(elements.syncToggle.disabled, false, "sync can still be turned off while the retry runs");
  });

  await test("a reset actively in progress keeps the toggle and Clear usable but blocks import", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "reset", requested: true } });
    equal(elements.syncToggle.disabled, false, "sync can be turned off while the deletion runs");
    equal(elements.clearBtn.disabled, false, "clear can force a retry of the same deletion");
    equal(elements.importBtn.disabled, true, "import blocked while reset is in flight");
    await elements.clearBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["clearHistory"], "the click handler's guard lets the retry through");
  });

  await test("a stuck reset tells the user which controls still work", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "error", requested: true,
        error: { code: "account", message: "sign in required" } } });
    const text = elements.syncStatus.textContent;
    equal(text.includes("Sign in to iCloud to sync."), true, "the real error is shown, not only the waiting copy");
    equal(text.endsWith("Turn sync off to keep the local history, or use Clear history to retry."), true, "the escape hatches are named");
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "reset", requested: true, error: null } });
    equal(elements.syncStatus.textContent.includes("Turn sync off"), false, "no hint while the deletion is actually running");
  });

  await test("an in-flight abandon shows the same neutral copy as a stuck reset", async () => {
    publishState({ syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, phase: "reset", stage: "abandon" } });
    equal(elements.syncStatus.textContent, "Clearing history… waiting for iCloud confirmation.", "abandon reuses the reset-phase message, never a pull/push label");
  });

  // Offline, a pending reset retries forever in "waiting" and never reaches
  // "error": the controls that end it must not depend on that phase.
  await test("an offline reset that keeps retrying lets the user turn sync off", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, stage: "reset", phase: "waiting", requested: true,
        error: { code: "network", message: "offline" } } });
    equal(elements.syncToggle.disabled, false, "sync can be turned off to abandon the deletion");
    equal(elements.clearBtn.disabled, false, "clear can retry the deletion");
    equal(elements.importBtn.disabled, true, "import stays blocked while the reset intent is pending");
    equal(elements.syncStatus.textContent.includes("Network unavailable — try again later."), true, "the retry reason is shown");
    commandHandler = async () => replyWith({ syncEnabled: false,
      sync: { ...stored.sync, stage: "abandon", error: null, nextAttemptAt: 0 } });
    elements.syncToggle.checked = false;
    await elements.syncToggle.handlers.change();
    equal(commandMessages.map((m) => m.command), ["setSyncEnabled"], "turning sync off is the abandon");
    equal(commandMessages[0].payload, { enabled: false }, "toggle sends the plain preference change");
    equal(elements.syncToggle.disabled, true, "the toggle waits for the abandon to resolve");
    equal(elements.clearBtn.disabled, true, "clear waits for the abandon too");
  });

  await test("clear retries a pending reset that is waiting to retry", async () => {
    publishState({ seenKanji: { "日本語": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, stage: "reset", phase: "waiting", requested: true,
        error: { code: "network", message: "offline" } } });
    commandHandler = async () => replyWith({ sync: { ...stored.sync, error: null, nextAttemptAt: 0 } });
    await elements.clearBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["clearHistory"], "the click forces a retry of the same deletion");
    equal(elements.status.textContent.includes("waiting for iCloud confirmation"), true, "the deletion is still pending");
    equal(elements.clearBtn.disabled, false, "clear stays usable");
  });

  await test("a running abandon blocks the toggle and Clear until it resolves", async () => {
    for (const phase of ["waiting", "reset"]) {
      publishState({ seenKanji: { "日本語": record() }, syncEnabled: false,
        sync: { ...stored.sync, resetPending: true, stage: "abandon", phase, requested: true, error: null } });
      equal(elements.syncToggle.disabled, true, "toggle waits for the abandon: " + phase);
      equal(elements.clearBtn.disabled, true, "clear waits for the abandon: " + phase);
      equal(elements.importBtn.disabled, true, "import stays blocked: " + phase);
      await elements.clearBtn.handlers.click();
      equal(commandMessages, [], "the click handler's own guard also waits: " + phase);
    }
    publishState({ sync: { ...stored.sync, phase: "error", error: { code: "journal", message: "sync failed" } } });
    equal(elements.syncToggle.disabled, false, "an abandon stopped at an error can be retried from the toggle");
    equal(elements.clearBtn.disabled, false, "or replaced by a new deletion");
    publishState({ sync: { ...stored.sync, resetPending: false, stage: "pull", phase: "idle", requested: false, error: null } });
    equal(elements.syncToggle.disabled, false, "toggle usable once the abandon resolves");
    equal(elements.clearBtn.disabled, false, "clear usable once the abandon resolves");
    equal(elements.importBtn.disabled, false, "import usable once the abandon resolves");
  });

  await test("a clear refused during an abandon asks to try again", async () => {
    // The popup has not observed the abandon yet; the coordinator refuses.
    publishState({ seenKanji: { "日本語": record() } });
    commandHandler = async () => ({ ok: false, error: "The iCloud deletion is being cancelled.", code: "abandonPending" });
    await elements.clearBtn.handlers.click();
    equal(elements.status.textContent, "Cancelling the iCloud deletion… try again in a moment.", "refusal explained");
    equal(elements.knownCount.textContent, "1 terms known", "nothing cleared");
  });

  for (const outcome of ["downloaded", "shared"]) {
    await test("saving during a pending reset keeps the file and leaves history untouched: " + outcome, async () => {
      lastResult = scan(["日本語"]);
      publishState({ seenKanji: { "学校": record() }, syncEnabled: true,
        sync: { ...stored.sync, resetPending: true, stage: "reset", phase: "waiting", requested: true,
          error: { code: "network", message: "offline" } } });
      equal(elements.downloadBtn.disabled, false, "the file does not depend on history");
      equal(elements.importBtn.disabled, true, "import stays blocked");
      let savedText;
      saveTextFile = async (text, filename) => { savedText = text; return { outcome, filename }; };
      await elements.downloadBtn.handlers.click();
      equal(savedText.includes("日本語"), true, "the file is saved");
      equal(commandMessages, [], "no history command during the reset");
      equal(elements.status.textContent.startsWith("File ready: kanji_"), true, "the file is named");
      equal(elements.status.textContent.endsWith("History not updated while the iCloud deletion is in progress."), true, "history is said to be untouched");
      equal(elements.status.className, "status ok", "not reported as a failure");
      equal(lastResult.newTerms.map((t) => t.term), ["日本語"], "the unsaved term stays new");
      equal(elements.downloadBtn.disabled, false, "the file can be saved again");
    });
  }

  await test("a reset that starts during the save leaves history untouched without an error", async () => {
    lastResult = scan(["日本語"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    commandHandler = async () => ({ ok: false, error: "History deletion is still in progress.", code: "resetPending" });
    await elements.downloadBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["commitTerms"], "the popup had not observed the reset");
    equal(elements.status.textContent.startsWith("File ready: kanji_"), true, "the file is named");
    equal(elements.status.textContent.endsWith("History not updated while the iCloud deletion is in progress."), true, "same outcome as a reset seen before saving");
    equal(elements.status.className, "status ok", "not reported as a failure");
    equal(lastResult.newTerms.map((t) => t.term), ["日本語"], "no membership refresh");
  });

  await test("a reset that completes during the save commits to the new history", async () => {
    lastResult = scan(["日本語"]);
    publishState({ seenKanji: { "学校": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, stage: "reset", phase: "reset", requested: true } });
    saveTextFile = async (text, filename) => {
      publishState({ seenKanji: {}, syncQueue: {},
        sync: { ...stored.sync, resetPending: false, stage: "pull", phase: "idle", requested: false } });
      return { outcome: "downloaded", filename };
    };
    commandHandler = async () => replyWith({ seenKanji: { "日本語": record() } }, 1);
    await elements.downloadBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["commitTerms"], "the finished reset no longer blocks history");
    equal(elements.status.textContent.startsWith("Download started:"), true, "normal save status");
    equal(lastResult.newTerms, [], "membership refreshed");
  });

  await test("preferences and sync enabling are coordinator mutations with unique ids", async () => {
    elements.newOnlyToggle.checked = true;
    commandHandler = async (message) => replyWith(message.command === "setPreferences" ? message.payload : { syncEnabled: message.payload.enabled });
    await elements.newOnlyToggle.handlers.change();
    elements.syncToggle.checked = true;
    await elements.syncToggle.handlers.change();
    equal(commandMessages.map((message) => message.command), ["setPreferences", "setSyncEnabled"], "explicit command protocol");
    equal(commandMessages[0].payload, { newOnlyEnabled: true }, "preference payload");
    equal(commandMessages[1].payload, { enabled: true }, "sync preference payload");
    equal(commandMessages[0].id !== commandMessages[1].id, true, "different mutations have unique ids");
  });

  await test("lost command response retries with the original operation id", async () => {
    let calls = 0;
    commandHandler = async () => {
      calls++;
      if (calls === 1) throw new Error("message channel closed after acceptance");
      return replyWith({ seenKanji: { "日本語": record() } }, 1);
    };
    await commitTerms([{ term: "日本語", count: 1 }], "https://first.jp/");
    equal(commandMessages.length, 2, "one transport retry");
    equal(commandMessages[0], commandMessages[1], "same id and payload reused");
  });

  await test("storage changes in unrelated namespaces do not change UI", async () => {
    storageListener({ kanjiState: { newValue: { ...emptyState(), revision: 20, seenKanji: { "学校": record() } } } }, "sync");
    equal(elements.knownCount.textContent, "0 terms known", "non-local change ignored");
  });

  await test("message transport uses exactly the platform API signature", async () => {
    const original = fixtureAPI.runtime.sendMessage;
    fixtureAPI.runtime.sendMessage = (...args) => {
      equal(args.length, POPUP_TEST_PROMISE_API ? 1 : 2, "only the supported signature is used");
      commandMessages.push(copy(args[0]));
      const response = { ok: true, state: copy(stored) };
      if (POPUP_TEST_PROMISE_API) return Promise.resolve(response);
      args[1](response);
    };
    try {
      const state = await getState();
      equal(state.revision, stored.revision, "platform response accepted");
      equal(commandMessages.length, 1, "no duplicate retry");
    } finally { fixtureAPI.runtime.sendMessage = original; }
  });

  await test("a failed new sync preserves the previous completion label", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error",
      lastSuccessAt: 1000, error: { code: "network", message: "offline" } } });
    equal(elements.syncStatus.textContent, "Network unavailable — try again later.", "current failure shown");
    equal(elements.syncLast.textContent.startsWith("Last completed:"), true, "past success is separate");
  });

  await test("history read failure prevents extraction with an invented empty history", async () => {
    let injected = false;
    fixtureAPI.scripting = { executeScript: async () => { injected = true; return [{ result: { terms: [{ term: "日本語", count: 1 }], totalOccurrences: 1 } }]; } };
    commandHandler = async () => ({ ok: false, error: "History read failed", code: "storage" });
    try {
      await elements.extractBtn.handlers.click();
      equal(injected, false, "no scan with unavailable history");
      equal(lastResult, null, "no invented new terms");
      equal(elements.status.className, "status error", "read failure visible");
      equal(elements.extractBtn.disabled, false, "extract button restored");
    } finally { delete fixtureAPI.scripting; }
  });

  // Counts the DOM nodes the popup creates while `callback` runs, so a test can
  // tell whether the result list was rebuilt (rows are built with createElement).
  async function countCreatedNodes(callback) {
    const original = document.createElement;
    let created = 0;
    document.createElement = () => { created++; return { appendChild() {} }; };
    try { await callback(); } finally { document.createElement = original; }
    return created;
  }

  await test("a state update that leaves the displayed list unchanged does not rebuild it", async () => {
    lastResult = scan(["日本語", "学校"]);
    applyMode(false);
    const rebuilt = await countCreatedNodes(async () => {
      // Unrelated change (sync phase) and a seenKanji change outside the scan.
      publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "pull", pages: 1 } });
      publishState({ seenKanji: { "図書館": record() } });
    });
    equal(rebuilt, 0, "no rows rebuilt for an identical list");
    equal(elements.uniqueCount.textContent, 2, "counter still current");
    equal(elements.downloadBtn.disabled, false, "button still current");
  });

  await test("new-only mode keeps its list when the new terms are unchanged", async () => {
    lastResult = scan(["日本語", "学校"]);
    lastResult.newOnly = true;
    publishState({ newOnlyEnabled: true });
    equal(lastResult.display.length, 2, "both terms are new");
    const rebuilt = await countCreatedNodes(async () => {
      publishState({ seenKanji: { "図書館": record() } });
    });
    equal(rebuilt, 0, "a new reference with the same terms is not a change");
  });

  await test("a state update that changes the displayed list rebuilds it", async () => {
    lastResult = scan(["日本語", "学校"]);
    publishState({ newOnlyEnabled: true });
    // Seen history now covers one scanned term: the new-only list shrinks.
    const rebuilt = await countCreatedNodes(async () => {
      publishState({ seenKanji: { "学校": record() } });
    });
    equal(rebuilt > 0, true, "rows rebuilt after the list changed");
    equal(lastResult.display.map((t) => t.term), ["日本語"], "list shows the remaining new term");
    equal(elements.uniqueCount.textContent, 1, "counter follows the list");
    // Going back to the full list is a change as well.
    const again = await countCreatedNodes(async () => { publishState({ newOnlyEnabled: false }); });
    equal(again > 0, true, "rows rebuilt when the mode shows a different list");
  });

  await test("a new scan with the same terms still fills a list that was cleared", async () => {
    lastResult = scan(["日本語"]);
    applyMode(false);
    clearResults();
    lastResult = scan(["日本語"]);
    const rebuilt = await countCreatedNodes(async () => { applyMode(false); });
    equal(rebuilt > 0, true, "cleared list is rebuilt");
  });

  await test("Extract reads the coordinator state exactly once", async () => {
    fixtureAPI.scripting = { executeScript: async () => [{ result: { terms: [{ term: "日本語", count: 2 }], totalOccurrences: 2 } }] };
    publishState({ seenKanji: { "学校": record() } });
    commandMessages = [];
    try {
      await elements.extractBtn.handlers.click();
      equal(commandMessages.map((m) => m.command), ["getState"], "a single getState per extraction");
      equal(lastResult.newTerms.map((t) => t.term), ["日本語"], "diff uses current history");
      equal(elements.status.className, "status ok", "extraction reported");
    } finally { delete fixtureAPI.scripting; }
  });

  await test("stale-generation error explains that recovery needs a decision", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error",
      error: { code: "staleGeneration", message: "sync failed" } } });
    equal(elements.syncStatus.textContent.includes("local history and the cloud reset state do not match"), true, "clear stale-history explanation");
    equal(elements.syncStatus.textContent.includes("Export your history"), true, "preserve history before deciding recovery");
  });

  await test("adopt button is shown only for a recoverable stale generation and sends one command", async () => {
    safariMac();
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error",
      error: { code: "staleGeneration", message: "stale", currentGeneration: 3 } } });
    equal(elements.syncAdoptBtn.hidden, false, "recovery button is visible");
    commandHandler = async message => {
      equal(message.command, "adoptNativeGeneration", "button sends adoption command");
      return replyWith({ generation: 3, sync: { ...stored.sync, phase: "waiting", error: null } });
    };
    await elements.syncAdoptBtn.handlers.click();
    equal(commandMessages.map(message => message.command), ["adoptNativeGeneration"], "one recovery command");
    equal(elements.syncAdoptBtn.hidden, true, "button hides after recovery");
    equal(elements.status.className, "status ok", "success status is visible");
    publishState({ sync: { ...stored.sync, phase: "error", error: { code: "staleGeneration", currentGeneration: -1 } } });
    equal(elements.syncAdoptBtn.hidden, true, "unsafe generation cannot be adopted");
    publishState({ sync: { ...stored.sync, phase: "error", error: { code: "network", currentGeneration: 3 } } });
    equal(elements.syncAdoptBtn.hidden, true, "other errors cannot be adopted");
  });

  await test("a damaged sync journal explains exporting before clearing", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error",
      error: { code: "journal", message: "sync failed" } } });
    equal(elements.syncStatus.textContent,
      "The sync journal on this device is damaged. Export the history, then clear it to rebuild sync.",
      "journal error explains the recovery path");
  });

  await test("a zone deleted in Settings explains that history is intact and sync can restart", async () => {
    // recordFailure turns sync off for this code, but its error must still be
    // shown instead of the plain "Sync is off." label.
    publishState({ syncEnabled: false, sync: { ...stored.sync, phase: "idle",
      error: { code: "zoneDeleted", message: "sync failed" } } });
    equal(elements.syncStatus.textContent,
      "Sync data was deleted from iCloud in Settings. The history on this device is intact: turn sync back on to upload it again.",
      "zone-deleted error explains the recovery path even while sync is off");
  });

  await test("a temporarily unavailable account shows an automatic-retry message", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "waiting",
      error: { code: "accountTemporary", message: "sync failed" } } });
    equal(elements.syncStatus.textContent,
      "iCloud is temporarily unavailable. Check your Apple Account in Settings; sync will retry automatically.",
      "transient account error explains that sync retries automatically");
  });

  await test("unsupported storage format does not imply history was cleared", async () => {
    commandHandler = async () => ({ ok: false, error: "Stored history has an unsupported or damaged format.", code: "storageSchema" });
    await elements.clearBtn.handlers.click();
    equal(elements.status.textContent.includes("unsupported or damaged"), true, "clear storage explanation");
    equal(elements.status.textContent.includes("No changes were made"), true, "no false deletion claim");
  });

  await test("an invalid generation limit falls back to the generic retry message", async () => {
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error",
      error: { code: "invalidGeneration", message: "History generation limit reached." } } });
    equal(elements.syncStatus.textContent, "Sync failed — try again later.", "reuses the existing generic sync-failed copy");
  });

  await test("clear recovers from a load-time storage-schema failure with no cached state", async () => {
    currentState = null;
    equal(elements.clearBtn.disabled, false, "clear stays enabled when no state was ever loaded");
    commandHandler = async () => replyWith({ seenKanji: {}, syncEnabled: false,
      sync: { ...stored.sync, resetPending: false, phase: "idle", error: null } });
    await elements.clearBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["clearHistory"], "recovery clear is delegated to the coordinator");
    equal(elements.knownCount.textContent, "0 terms known", "re-rendered from the returned empty state");
    equal(elements.status.textContent, "Known-terms history cleared.", "normal completion status, not an error");
    equal(elements.clearBtn.disabled, false, "control re-enabled after recovery");
  });

  await test("Safari macOS saves natively, then commits and names the file actually written", async () => {
    safariMac();
    lastResult = scan(["日本語"]);
    const finalName = "kanji_page_20260923_120000 (2).txt";
    commandHandler = async (message) => message.command === "saveFile"
      ? { ok: true, filename: finalName }
      : replyWith({ seenKanji: { "日本語": record() } }, 1);
    await elements.downloadBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["saveFile", "commitTerms"], "history is committed only after the native save");
    equal(commandMessages[0].payload.filename.startsWith("kanji_") && commandMessages[0].payload.filename.endsWith(".txt"), true, "requested name sent");
    equal(commandMessages[0].payload.text.includes("日本語"), true, "file contents sent to the background");
    equal(commandMessages[1].payload.terms, [{ term: "日本語", count: 1 }], "exactly the saved terms committed");
    equal(elements.status.textContent, "Saved to Downloads: " + finalName + " — added 1 term to your known list.",
      "the final name chosen by the native side is shown");
    equal(elements.status.className, "status ok", "reported as success");
    equal(lastResult.newTerms, [], "membership refreshed");
  });

  await test("a failed native save shows download_failed and commits nothing", async () => {
    safariMac();
    lastResult = scan(["日本語"]);
    commandHandler = async (message) => message.command === "saveFile"
      ? { ok: false, code: "file", error: "The file could not be written to Downloads." }
      : replyWith({ seenKanji: { "日本語": record() } }, 1);
    await elements.downloadBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["saveFile"], "no history command without a written file");
    equal(elements.status.textContent, "Download failed: The file could not be written to Downloads.", "download failure shown");
    equal(elements.status.className, "status error", "reported as an error");
    equal(lastResult.newTerms.map((t) => t.term), ["日本語"], "the unsaved term stays new");
  });

  for (const code of ["unavailable", "unsupported"]) {
    await test("without a native save the page download is the fallback: " + code, async () => {
      safariMac();
      lastResult = scan(["日本語"]);
      let injected;
      fixtureAPI.scripting = { executeScript: async (details) => { injected = details; return [{}]; } };
      commandHandler = async (message) => message.command === "saveFile"
        ? { ok: false, code, error: "Native saving is unavailable." }
        : replyWith({ seenKanji: { "日本語": record() } }, 1);
      try { await elements.downloadBtn.handlers.click(); }
      finally { delete fixtureAPI.scripting; }
      equal(commandMessages.map((m) => m.command), ["saveFile", "commitTerms"], "fallback keeps today's behaviour");
      equal(injected.target, { tabId: 1 }, "injected into the active tab");
      equal(injected.args[1], commandMessages[0].payload.filename, "same file name");
      equal(elements.status.textContent.startsWith("Download started:"), true, "initiation is not claimed as a written file");
      const page = runInjected(injected);
      equal(page.events, ["create", "append", "click " + injected.args[1], "remove"], "the blob URL is not revoked synchronously");
      equal(page.deferred.map((timer) => timer.delay), [40000], "revocation is deferred");
      page.runDeferred();
      equal(page.events[page.events.length - 1], "revoke blob:page/1", "the deferred callback revokes the URL");
    });
  }

  await test("a pending reset with a native save keeps history untouched and names the final file", async () => {
    safariMac();
    lastResult = scan(["日本語"]);
    publishState({ seenKanji: { "学校": record() }, syncEnabled: true,
      sync: { ...stored.sync, resetPending: true, stage: "reset", phase: "waiting", requested: true } });
    commandHandler = async (message) => message.command === "saveFile"
      ? { ok: true, filename: "renamed (2).txt" }
      : replyWith({ seenKanji: { "日本語": record() } }, 1);
    await elements.downloadBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["saveFile"], "no history command during the reset");
    equal(elements.status.textContent,
      "File ready: renamed (2).txt. History not updated while the iCloud deletion is in progress.", "final name reported");
    equal(elements.status.className, "status ok", "not reported as a failure");
    equal(lastResult.newTerms.map((t) => t.term), ["日本語"], "the unsaved term stays new");
  });

  await test("Safari macOS exports history natively and reports the final name", async () => {
    safariMac();
    commandHandler = async (message) => message.command === "saveFile"
      ? { ok: true, filename: "kanji_history (2).json" }
      : { ok: true, state: copy(stored) };
    await elements.exportBtn.handlers.click();
    equal(commandMessages.map((m) => m.command), ["getState", "saveFile"], "export saved natively");
    equal(commandMessages[1].payload.filename.endsWith(".json"), true, "export keeps its .json name");
    equal(elements.status.textContent, "Export requested: kanji_history (2).json", "final name shown");
  });

  // Storage problems are not sync problems, also where sync does not exist.
  const STORAGE_FULL = "The extension's storage is full. Export your history, then clear it or free space.";
  await test("a full extension storage is named as such, never as a sync failure", async () => {
    navigator.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    publishState({ seenKanji: { "日本語": record() } });
    equal(elements.syncRow.hidden, true, "this browser has no sync controls");
    commandHandler = async () => ({ ok: false, error: "Browser storage is full.", code: "storageQuota" });
    await elements.clearBtn.handlers.click();
    equal(elements.status.textContent, STORAGE_FULL, "a refused clear names the full storage");
    equal(elements.status.className, "status error", "reported as an error");
    lastResult = scan(["学校"]);
    saveTextFile = async (text, filename) => ({ outcome: "downloaded", filename });
    await elements.downloadBtn.handlers.click();
    equal(elements.status.textContent, "File request accepted, but history could not be confirmed: " + STORAGE_FULL,
      "a saved file whose terms could not be stored names the cause");
    await importHistory({ "学校": { count: 2 } });
    equal(elements.status.textContent, "Import failed: " + STORAGE_FULL, "a refused import names the cause");
  });

  await test("other storage failures show their detail without claiming a sync failure", async () => {
    commandHandler = async () => ({ ok: false, error: "IO error: disk unavailable", code: "storage" });
    await elements.clearBtn.handlers.click();
    equal(elements.status.textContent, "Could not access the browser storage: IO error: disk unavailable", "the storage detail is shown");
    elements.newOnlyToggle.checked = true;
    await elements.newOnlyToggle.handlers.change();
    equal(elements.status.textContent.includes("Sync failed"), false, "a refused preference is not a sync failure");
    equal(elements.status.className, "status error", "but it is still an error");
  });

  await test("a sync job stopped by storage shows the storage message", async () => {
    navigator.userAgent = "Safari";
    navigator.vendor = "Apple Computer, Inc.";
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "error", requested: true,
      error: { code: "storageQuota", message: "Browser storage is full." } } });
    equal(elements.syncStatus.textContent, STORAGE_FULL, "a page that did not fit is explained");
    publishState({ syncEnabled: true, sync: { ...stored.sync, phase: "waiting", requested: true,
      error: { code: "storage", message: "simulated storage write failure" } } });
    equal(elements.syncStatus.textContent, "Could not access the browser storage: simulated storage write failure",
      "a failed page write is not called a sync failure");
  });

  equal(fixtureTimers.size, 0, "all message timers cleared");
  print(passed + " popup cases passed; " + failed + " failed.");
  if (failed) quit(1);
  else print("KANJI_POPUP_TESTS_OK");
})().catch((error) => { print(String(error)); quit(1); });
