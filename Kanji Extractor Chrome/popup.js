// =============================================================================
// Kanji Extractor — shared popup logic (single source of truth).
//
// This ONE file ships unchanged to Chrome, Firefox, and Safari (macOS + iOS).
// Browser differences are handled at runtime via capability detection, not by
// maintaining separate copies:
//   * i18n falls back to the inline English text when no _locales are present.
//   * Download uses the best mechanism available on the platform.
//
// Build: ../build.sh copies this into each target package.
// =============================================================================

// Cross-browser API alias (Safari/Firefox expose `browser`, Chrome `chrome`).
const api = (typeof browser !== "undefined") ? browser : chrome;
const promiseAPI = typeof browser !== "undefined";

// ---------------------------------------------------------------------------
// Platform / i18n helpers
// ---------------------------------------------------------------------------

// Best-effort iOS detection. Used only to choose the download flow (native
// Share Sheet vs. a real file download).
function isIOS() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ reports "Macintosh" but is touch-enabled.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function localizedMessage(key, substitutions, fallback) {
  if (!api.i18n || !api.i18n.getMessage) return fallback || key;
  return api.i18n.getMessage(key, substitutions || []) || fallback || key;
}

function applyLocalization() {
  if (api.i18n && api.i18n.getUILanguage) {
    document.documentElement.lang = api.i18n.getUILanguage().split("-")[0];
  }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = localizedMessage(el.dataset.i18n, [], el.textContent);
  });
}

// ---------------------------------------------------------------------------
// Background-owned state and persistent work queue.
//
// The popup submits commands and renders snapshots. It never writes history,
// runs CloudKit work, or owns a sync loop. Once a command is acknowledged its
// work is persisted by the background coordinator and can resume after this
// popup closes or the worker restarts. Closing before acceptance is not a
// guarantee that a download was added to history.
// ---------------------------------------------------------------------------

let currentState = null;
let observedReset = false;
let abandonRunning = false;
let operationSequence = 0;
const popupSession = Date.now().toString(36) + ":" + Math.random().toString(36).slice(2);

function operationId() {
  return popupSession + ":" + (++operationSequence);
}

// The localized "background did not answer" text, shared by every path that
// reports a missing, empty or timed-out reply from the coordinator.
function backgroundUnavailableMessage() {
  return localizedMessage("background_unavailable", [], "The extension did not respond. Try again.");
}

function sendCommandOnce(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error(backgroundUnavailableMessage())), 30000);
    try {
      // browser.* validates Promise-style signatures: an extra callback can
      // be rejected by Firefox. Chrome's chrome.* path uses its callback form.
      // Select one form before sending; never probe by sending a second time.
      if (promiseAPI) {
        Promise.resolve(api.runtime.sendMessage(message)).then(
          (response) => finish(null, response), (error) => finish(error));
      } else {
        api.runtime.sendMessage(message, (response) => {
          const error = api.runtime.lastError;
          finish(error ? new Error(error.message) : null, response);
        });
      }
    } catch (error) { finish(error); }
  });
}

async function backgroundCommand(command, payload) {
  const message = { kind: "kanji", command, id: operationId() };
  if (payload !== undefined) message.payload = payload;
  let response;
  // Retry a lost response once with the SAME id. The coordinator deduplicates
  // accepted mutations, so a delayed response cannot apply an operation twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await sendCommandOnce(message);
      if (!response) throw new Error(backgroundUnavailableMessage());
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  if (!response.ok) {
    const error = new Error(response.error || backgroundUnavailableMessage());
    error.code = response.code;
    throw error;
  }
  if (response.state) renderState(response.state);
  return response;
}

async function getState() {
  const response = await backgroundCommand("getState");
  if (!response.state) throw new Error(backgroundUnavailableMessage());
  return currentState;
}

// Safari alone has the native CloudKit handler. This only controls visibility;
// the background coordinator independently validates command capabilities.
function isSafariNative() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const vendor = (typeof navigator !== "undefined" && navigator.vendor) || "";
  if (/Chrome|Chromium|Edg|Android|Firefox/i.test(ua)) return false;
  return /Apple/i.test(vendor) || /Safari/i.test(ua);
}

// Sync failure code -> [locale key, English fallback] for the messages that
// need no substitution. A table keeps the code/copy pairing in one place.
const RESET_COPY = ["sync_err_reset", "Sync data was reset in iCloud — it will re-sync on the next attempt."];
const SYNC_ERROR_COPY = {
  staleGeneration: ["sync_err_stale_history", "Sync paused: local history and the cloud reset state do not match. Export your history before choosing how to recover it."],
  notStale: ["sync_err_not_stale", "No recoverable sync generation is available. Refresh the sync status and try again."],
  storageSchema: ["history_err_format", "The saved history format is unsupported or damaged. No changes were made. Update the extension, or use Clear history to set the damaged data aside and start over."],
  journal: ["sync_err_journal", "The sync journal on this device is damaged. Export the history, then clear it to rebuild sync."],
  protocol: ["sync_err_protocol", "The extension received an invalid sync response. Update the extension and try again."],
  resetPending: ["history_clearing", "Clearing history… waiting for iCloud confirmation."],
  abandonPending: ["clear_abandon_pending", "Cancelling the iCloud deletion… try again in a moment."],
  account: ["sync_err_account", "Sign in to iCloud to sync."],
  accountTemporary: ["sync_err_account_temporary", "iCloud is temporarily unavailable. Check your Apple Account in Settings; sync will retry automatically."],
  schema: ["sync_err_schema", "CloudKit schema not deployed to Production yet."],
  network: ["sync_err_network", "Network unavailable — try again later."],
  quota: ["sync_err_quota", "iCloud storage is full."],
  // The browser's own storage, not iCloud: never a sync failure, and reads the
  // same in browsers without sync.
  storageQuota: ["storage_err_quota", "The extension's storage is full. Export your history, then clear it or free space."],
  zoneGone: RESET_COPY,
  expiredToken: RESET_COPY,
  zoneDeleted: ["sync_err_zone_deleted", "Sync data was deleted from iCloud in Settings. The history on this device is intact: turn sync back on to upload it again."],
  invalidGeneration: ["sync_failed_generic", "Sync failed — try again later."],
};

// Map a sync failure to a clear, localized, actionable message.
function syncErrorMessage(err) {
  const code = err && err.code;
  const reason = (err && err.message) ? err.message : String(err);
  // hasOwnProperty: a code such as "constructor" must not hit Object.prototype.
  if (Object.prototype.hasOwnProperty.call(SYNC_ERROR_COPY, code)) {
    const [key, fallback] = SYNC_ERROR_COPY[code];
    return localizedMessage(key, [], fallback);
  }
  // Only this message embeds the underlying reason.
  if (code === "storage") {
    return localizedMessage("storage_err_generic", [reason], "Could not access the browser storage: " + reason);
  }
  // The native handler deliberately sends a generic "sync failed" string
  // (details stay in the on-device log) — don't echo it into
  // "Sync failed: sync failed".
  const detail = (reason && reason !== "sync failed" && reason !== "pull failed" && reason !== "push failed") ? reason : "";
  return detail
    ? localizedMessage("sync_failed", [detail], "Sync failed: " + detail)
    : localizedMessage("sync_failed_generic", [], "Sync failed — try again later.");
}

function formatSyncTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

function renderSyncState(state) {
  if (!syncRow) return;
  syncRow.hidden = !isSafariNative();
  const sync = state.sync || {};
  const pending = Object.keys(state.syncQueue || {}).length;
  const active = ["pull", "push", "reset"].includes(sync.phase);
  let text;
  if (sync.resetPending || sync.stage === "abandon") {
    // "abandon" (turning sync off while a reset is stuck) is not part of the
    // phase enum below — reuse the same neutral copy as an in-progress reset
    // so it can never fall through to a stale pull/push label.
    text = localizedMessage("history_clearing", [], "Clearing history… waiting for iCloud confirmation.");
  } else if (sync.error) {
    text = syncErrorMessage(sync.error);
  } else if (!state.syncEnabled) {
    text = localizedMessage("sync_paused", [], "Sync is off.");
  } else if (sync.phase === "pull") {
    text = localizedMessage("sync_receiving", [String(sync.pages || 0)],
      "Receiving from iCloud — pages completed: " + (sync.pages || 0));
  } else if (sync.phase === "push") {
    text = localizedMessage("sync_sending", [String(sync.sent || 0)],
      "Sending to iCloud — terms acknowledged: " + (sync.sent || 0));
  } else if (sync.phase === "waiting" || sync.requested || pending) {
    text = localizedMessage("sync_waiting", [], "Waiting to resume sync.");
  } else if (sync.lastSuccessAt && sync.phase !== "error") {
    text = localizedMessage("sync_complete", [], "Sync completed. No terms waiting to send.");
  } else {
    text = localizedMessage("sync_not_completed", [], "No completed sync yet.");
  }
  if (sync.resetPending && sync.error) text += " " + syncErrorMessage(sync.error);
  if (sync.resetPending && sync.phase === "error") {
    // The deletion stopped at an error no wake-up retries: say which controls
    // still work (background: sync off = abandonReset, clear again = retry).
    text += " " + localizedMessage("history_clear_stuck_hint", [],
      "Turn sync off to keep the local history, or use Clear history to retry.");
  }
  syncStatusEl.textContent = text;
  syncStatusEl.className = "sync-status" + (sync.error ? " error" : "");
  if (syncPendingEl) {
    syncPendingEl.textContent = localizedMessage("sync_pending", [String(pending)],
      pending + " terms waiting to send");
    syncPendingEl.hidden = !state.syncEnabled && !pending && !sync.resetPending;
  }
  if (syncLastEl) {
    syncLastEl.textContent = sync.lastSuccessAt
      ? localizedMessage("sync_last_completed", [formatSyncTime(sync.lastSuccessAt)],
        "Last completed: " + formatSyncTime(sync.lastSuccessAt)) : "";
  }
  if (syncNextEl) {
    syncNextEl.textContent = sync.nextAttemptAt && !active && (sync.requested || pending || sync.resetPending)
      ? localizedMessage("sync_next_attempt", [formatSyncTime(sync.nextAttemptAt)],
        "Next attempt from: " + formatSyncTime(sync.nextAttemptAt)) : "";
  }
  if (syncRetryBtn) {
    syncRetryBtn.hidden = !state.syncEnabled && !sync.resetPending;
    syncRetryBtn.disabled = active;
  }
  if (syncAdoptBtn) {
    // Recovery is offered only for a stopped stale job with a trustworthy fence.
    syncAdoptBtn.hidden = !state.syncEnabled || sync.resetPending || sync.phase !== "error" ||
      sync.error?.code !== "staleGeneration" ||
      !Number.isSafeInteger(sync.error?.currentGeneration) || sync.error.currentGeneration < 0;
  }
}

function renderState(state) {
  if (!state || !state.seenKanji) return;
  // Ignore an older command response that arrived after a storage notification.
  if (currentState && Number(state.revision) < Number(currentState.revision)) return;
  const resetFinished = observedReset && !(state.sync && state.sync.resetPending)
    && Object.keys(state.seenKanji).length === 0;
  currentState = state;
  const sync = state.sync || {};
  observedReset = !!sync.resetPending;
  // A pending reset must not trap the user, even offline where its retries
  // never stop at an error: turning sync off abandons it (journal-only, so it
  // works offline) and Clear retries it. Only an abandon already running
  // blocks both until it resolves; one stopped at an error stays actionable.
  abandonRunning = observedReset && sync.stage === "abandon" && sync.phase !== "error";
  if (newOnlyEl) newOnlyEl.checked = !!state.newOnlyEnabled;
  if (modeSelect) modeSelect.value = state.extractMode || "kanji-words";
  if (syncToggle) {
    syncToggle.checked = !!state.syncEnabled;
    syncToggle.disabled = abandonRunning;
  }
  updateKnownCount(Object.keys(state.seenKanji).length);
  if (clearBtn) clearBtn.disabled = abandonRunning;
  if (importBtn) importBtn.disabled = observedReset;
  if (lastResult) {
    lastResult.newTerms = lastResult.allTerms.filter(
      (term) => !Object.prototype.hasOwnProperty.call(state.seenKanji, term.term));
    applyMode(!!state.newOnlyEnabled, false);
  }
  // A pending reset blocks only the history update, never the file itself.
  updateDownloadButton();
  renderSyncState(state);
  if (resetFinished) setStatus(localizedMessage("history_cleared", [], "Known-terms history cleared."), "ok");
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const extractBtn  = document.getElementById("extractBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl    = document.getElementById("status");
const statsEl     = document.getElementById("stats");
const sourceEl    = document.getElementById("source");
const uniqueEl    = document.getElementById("uniqueCount");
const totalEl     = document.getElementById("totalCount");
const resultsEl   = document.getElementById("results");
const newOnlyEl   = document.getElementById("newOnlyToggle");
const modeSelect  = document.getElementById("modeSelect");
const knownEl     = document.getElementById("knownCount");
const clearBtn    = document.getElementById("clearBtn");
const exportBtn   = document.getElementById("exportBtn");
const importBtn   = document.getElementById("importBtn");
const importInput = document.getElementById("importInput");
const syncRow     = document.getElementById("syncRow");
const syncToggle  = document.getElementById("syncToggle");
const syncStatusEl = document.getElementById("syncStatus");
const syncPendingEl = document.getElementById("syncPending");
const syncLastEl = document.getElementById("syncLast");
const syncNextEl = document.getElementById("syncNext");
const syncRetryBtn = document.getElementById("syncRetryBtn");
const syncAdoptBtn = document.getElementById("syncAdoptBtn");

// lastResult = { url, allTerms:[{term,count}], newTerms:[...], display:[...],
//                totalOccurrences, newOnly }
let lastResult = null;
let saving = false;
// What the result list currently shows ({ terms, counts, total }), so a state
// update that leaves the displayed list unchanged does not rebuild its rows.
let renderedList = null;

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function setStatus(msg, kind) {
  if (!msg) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.className = "status " + (kind || "");
}

// The Download/Share button is enabled only when there is a non-empty list to
// save and no save is already in flight.
function updateDownloadButton() {
  downloadBtn.disabled = saving || !lastResult || lastResult.display.length === 0;
}

// How long the Download/Share button stays green with a checkmark after a
// successful save. Matches the `saved-pulse` animation length in popup.css.
const SAVED_FEEDBACK_MS = 1600;
let savedFeedbackTimer = null;

// Briefly turns the Download/Share button green with a checkmark to confirm the
// file was saved. The status line already announces the result to screen
// readers, so this is a purely visual cue. The class is removed by a timer
// rather than animationend so it also clears under prefers-reduced-motion,
// where the animation is disabled.
function showSavedFeedback() {
  clearTimeout(savedFeedbackTimer);
  // Restart the animation when two saves happen in quick succession.
  downloadBtn.classList.remove("saved");
  void downloadBtn.offsetWidth;
  downloadBtn.classList.add("saved");
  savedFeedbackTimer = setTimeout(clearSavedFeedback, SAVED_FEEDBACK_MS);
}

// Returns the Download/Share button to its normal look.
function clearSavedFeedback() {
  clearTimeout(savedFeedbackTimer);
  savedFeedbackTimer = null;
  downloadBtn.classList.remove("saved");
}

// Drops the current scan and everything shown for it (list, stats, button).
function clearResults() {
  lastResult = null;
  renderedList = null;
  resultsEl.innerHTML = "";
  statsEl.hidden = true;
  updateDownloadButton();
}

// A failed preference/sync command leaves the controls showing the rejected
// value: put them back from the last known state, then report the error.
function restoreControlsAndReport(error) {
  if (currentState) renderState(currentState);
  setStatus(syncErrorMessage(error), "error");
}

// Picks the singular or plural locale key by count. The English fallback is
// built by `fallback(suffix)` so it can append "" or "s" to its noun.
function countMessage(count, oneKey, manyKey, substitutions, fallback) {
  return localizedMessage(count === 1 ? oneKey : manyKey, substitutions,
    fallback(count === 1 ? "" : "s"));
}

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// Recognize browser-owned documents and extension stores before script injection.
function isRestrictedPage(url) {
  if (!url) return false;
  if (/^(?:safari-web-extension|chrome-extension|moz-extension|chrome|edge|about|file|view-source|devtools):/i.test(url)) return true;
  const page = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(url);
  if (!page) return false;
  const host = page[1].toLowerCase();
  return host === "chromewebstore.google.com" || host === "addons.mozilla.org" ||
    host === "microsoftedge.microsoft.com" ||
    (host === "chrome.google.com" && /^\/webstore(?:\/|$)/i.test(page[2] || ""));
}

// Browser permission failures have different wording but one useful popup message.
function isScriptPermissionError(error) {
  const message = (error && error.message) || String(error);
  return /permission|cannot access|can't access|not allowed|gallery cannot be scripted/i.test(message);
}

function updateKnownCount(n) {
  if (!knownEl) return;
  knownEl.textContent = localizedMessage("known_count", [String(n)], n + " terms known");
}

// ---------------------------------------------------------------------------
// Initial load: localize, show URL, restore toggle + known count.
// ---------------------------------------------------------------------------

applyLocalization();

if (isIOS()) {
  // Lets popup.css drop the fixed desktop width on the full-width iOS sheet.
  document.documentElement.classList.add("ios");
  downloadBtn.textContent = localizedMessage("share_button", [], "Share .txt");
}

// Observe persisted progress without polling or owning the work's lifetime.
if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.kanjiState && changes.kanjiState.newValue) {
      renderState(changes.kanjiState.newValue);
    }
  });
}

(async () => {
  // A restricted/missing tab must not prevent history and sync controls loading.
  try {
    const tab = await getActiveTab();
    if (tab && tab.url) {
      sourceEl.textContent = tab.url;
      sourceEl.title = tab.url;
    }
  } catch (_) {}
  try {
    const state = await getState();
    if (state.syncEnabled && isSafariNative() &&
        !(state.sync?.phase === "error" && state.sync.error?.code === "staleGeneration")) {
      // This waits only for acceptance, never for a CloudKit cycle to finish.
      backgroundCommand("syncNow").catch((error) => setStatus(syncErrorMessage(error), "error"));
    }
  } catch (error) { setStatus(syncErrorMessage(error), "error"); }
})();

if (newOnlyEl) {
  newOnlyEl.addEventListener("change", async () => {
    const enabled = newOnlyEl.checked;
    try {
      await backgroundCommand("setPreferences", { newOnlyEnabled: enabled });
      if (lastResult) applyMode(enabled);
    } catch (error) { restoreControlsAndReport(error); }
  });
}

if (modeSelect) {
  modeSelect.addEventListener("change", async () => {
    try {
      await backgroundCommand("setPreferences", { extractMode: modeSelect.value });
      // A different tokenization mode requires a fresh scan.
      clearResults();
      setStatus(localizedMessage("mode_changed", [], "Mode changed — press Extract to apply."), "");
    } catch (error) { restoreControlsAndReport(error); }
  });
}

if (syncToggle) {
  syncToggle.addEventListener("change", async () => {
    try { await backgroundCommand("setSyncEnabled", { enabled: syncToggle.checked }); }
    catch (error) { restoreControlsAndReport(error); }
  });
}

if (syncRetryBtn) {
  syncRetryBtn.addEventListener("click", async () => {
    syncRetryBtn.disabled = true;
    try { await backgroundCommand("syncNow"); }
    catch (error) { setStatus(syncErrorMessage(error), "error"); }
    finally { if (currentState) renderSyncState(currentState); }
  });
}

if (syncAdoptBtn) {
  // Keep the opt-in recovery separate from Retry and from the destructive Clear.
  syncAdoptBtn.addEventListener("click", async () => {
    syncAdoptBtn.disabled = true;
    try {
      await backgroundCommand("adoptNativeGeneration");
      setStatus(localizedMessage("sync_history_resync_started", [],
        "Local history kept. Resync started."), "ok");
    } catch (error) {
      setStatus(syncErrorMessage(error), "error");
    } finally {
      syncAdoptBtn.disabled = false;
      if (currentState) renderSyncState(currentState);
    }
  });
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

extractBtn.addEventListener("click", async () => {
  setStatus("");
  clearResults();

  extractBtn.disabled = true;
  let scanTab;
  try {
    const tab = await getActiveTab();
    scanTab = tab;
    if (!tab || !tab.id) {
      setStatus(localizedMessage("no_active_tab", [], "No active tab."), "error");
      return;
    }

    // Pages where content scripts cannot run.
    if (isRestrictedPage(tab.url)) {
      setStatus(localizedMessage("restricted_page", [], "This page can't be scanned by extensions."), "error");
      return;
    }
    setStatus(localizedMessage("extracting", [], "Extracting..."));
    // The one state read of this flow: it supplies the mode and, because it
    // must succeed, stops the scan when history is unreadable. renderState
    // keeps currentState current while the page is scanned, so the diff below
    // reuses it instead of paying for a second full-state read.
    const mode = (await getState()).extractMode;

    let injectionResults;
    try {
      injectionResults = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractKanjiInPage,
        args: [mode],
      });
    } catch (error) {
      // A tab can navigate to a reserved URL between the first check and injection.
      const permissionError = isScriptPermissionError(error);
      const currentTab = permissionError ? await getActiveTab().catch(() => null) : null;
      if (permissionError &&
          (isRestrictedPage(scanTab && scanTab.url) ||
            (currentTab && currentTab.id === tab.id && isRestrictedPage(currentTab.url)))) {
        setStatus(localizedMessage("restricted_page", [], "This page can't be scanned by extensions."), "error");
        return;
      }
      throw error;
    }

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus(localizedMessage("extraction_no_data", [], "Extraction returned no data."), "error");
      return;
    }

    // Diff against history.
    // The read above succeeded, so history is known and currentState is set.
    const seen = currentState.seenKanji;
    const allTerms = result.terms;
    const newTerms = allTerms.filter((t) => !Object.prototype.hasOwnProperty.call(seen, t.term));

    lastResult = {
      url: tab.url,
      allTerms,
      newTerms,
      totalOccurrences: result.totalOccurrences,
      display: allTerms,
      newOnly: false,
      fallback: result.engine === "runs", // segmenter unavailable on this browser
      partial: result.partial === true,
    };

    applyMode(newOnlyEl ? newOnlyEl.checked : false);
  } catch (err) {
    setStatus(localizedMessage("extraction_failed",
      [(err && err.message ? err.message : String(err))],
      "Extraction failed: " + (err && err.message ? err.message : err)), "error");
  } finally {
    extractBtn.disabled = false;
  }
});

// Render the current scan according to the new-only toggle. No re-scan.
function applyMode(newOnly, updateStatus = true) {
  if (!lastResult) return;
  lastResult.newOnly = newOnly;
  lastResult.display = newOnly ? lastResult.newTerms : lastResult.allTerms;

  renderResults(lastResult);
  updateDownloadButton();
  if (!updateStatus) return;

  const total = lastResult.allTerms.length;
  const note = lastResult.fallback
    ? localizedMessage("fallback_runs_note", [], " (segmenter unavailable — kanji runs)")
    : "";
  const partialNote = lastResult.partial
    ? localizedMessage("partial_scan_note", [], " (page scanned partially; try again on a smaller page)")
    : "";
  if (total === 0) {
    setStatus(localizedMessage("no_terms_found", [], "No kanji terms (2+ chars) found on this page.") + note + partialNote, "");
  } else if (newOnly) {
    const n = lastResult.newTerms.length;
    // The list is filtered to terms absent from history; describe that count
    // directly, without mixing it with the terms excluded by the filter.
    setStatus(countMessage(n, "found_new_term", "found_new_terms", [String(n)],
      (s) => `Found ${n} new term${s}.`) + note + partialNote,
      n === 0 ? "" : "ok");
  } else {
    setStatus(localizedMessage("found_unique_terms", [String(total)],
      `Found ${total} unique term${total === 1 ? "" : "s"}.`) + note + partialNote, "ok");
  }
}

// ---------------------------------------------------------------------------
// Download / Share  (commit-to-history happens here — option A)
// ---------------------------------------------------------------------------

downloadBtn.addEventListener("click", async () => {
  if (saving || !lastResult || lastResult.display.length === 0) return;
  // A rescan, mode toggle or sync can replace/mutate lastResult while sharing
  // is pending. Commit exactly the terms and URL written into this file.
  const savedResult = { ...lastResult, display: lastResult.display.map((t) => ({ ...t })) };
  // The native save may pick another name ("name (2).txt"); report that one.
  let filename = makeFilename(savedResult.url, savedResult.newOnly);
  // History edits are refused while a reset is pending: the file is kept and
  // its terms simply stay new, so this is reported as a notice, not a failure.
  const historyPaused = () => setStatus(localizedMessage("history_paused_saved", [filename],
    "File ready: " + filename + ". History not updated while the iCloud deletion is in progress."), "ok");
  let accepted = false;
  saving = true;
  clearSavedFeedback();
  downloadBtn.disabled = true;
  try {
    const text = buildFileContents(savedResult);

    const saved = await saveTextFile(text, filename);
    const outcome = saved.outcome;
    if (outcome === "cancelled") { setStatus(""); return; }
    filename = saved.filename;

    accepted = true;
    // Checked after saving: a reset that completed meanwhile has cleared the
    // old history, and these terms belong in the new one as usual.
    if (currentState && currentState.sync && currentState.sync.resetPending) { historyPaused(); return; }
    // The native save confirms a written file. The download API acknowledges
    // initiation, not a completed file write. Share acknowledges acceptance by
    // the destination. Only then do we submit the history command; its
    // acknowledgement confirms persistent acceptance.
    const added = await commitTerms(savedResult.display, savedResult.url);

    // Refresh new-only membership even if that toggle was off at save time.
    // If another scan is now showing, leave its unsaved terms available.
    if (lastResult) {
      const savedTerms = new Set(savedResult.display.map((t) => t.term));
      lastResult.newTerms = lastResult.newTerms.filter((t) => !savedTerms.has(t.term));
      applyMode(lastResult.newOnly);
    }

    if (outcome === "shared") {
      setStatus(localizedMessage("shared_file", [filename], "Shared " + filename), "ok");
    } else if (outcome === "saved") {
      setStatus(countMessage(added, "saved_downloads_added_one", "saved_downloads_added", [filename, String(added)],
        (s) => `Saved to Downloads: ${filename} — added ${added} term${s} to your known list.`), "ok");
    } else {
      setStatus(countMessage(added, "saved_added_one", "saved_added", [filename, String(added)],
        (s) => `Download started: ${filename} — added ${added} term${s} to your known list.`), "ok");
    }
    showSavedFeedback();

  } catch (err) {
    if (err && err.name === "AbortError") { setStatus(""); return; }
    const reason = err && err.message ? err.message : String(err);
    // A reset this popup had not observed yet: the same outcome as above.
    if (accepted && err && err.code === "resetPending") { historyPaused(); return; }
    if (accepted) {
      setStatus(localizedMessage("history_save_failed", [syncErrorMessage(err)],
        "File request accepted, but history could not be confirmed: " + syncErrorMessage(err)), "error");
    } else if (isIOS()) {
      setStatus(localizedMessage("share_failed", [reason], "Share failed: " + reason), "error");
    } else {
      setStatus(localizedMessage("download_failed", [reason], "Download failed: " + reason), "error");
    }
  } finally {
    saving = false;
    updateDownloadButton();
  }
});

// Platform-aware save. "saved" means the native handler wrote the file, under
// the returned name (it may differ from the one requested); "downloaded" means
// download initiation was accepted; "shared" means the share request was
// accepted. Only "saved" proves a file write.
// Returns { outcome: "saved" | "downloaded" | "shared" | "cancelled", filename }.
async function saveTextFile(text, filename) {
  // iOS: no real downloads API + no Files write — use the native Share Sheet.
  if (isIOS()) {
    const file = new File([text], filename, { type: "text/plain;charset=utf-8" });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: filename });
        return { outcome: "shared", filename };
      } catch (e) {
        if (e && e.name === "AbortError") return { outcome: "cancelled", filename };
        throw e;
      }
    }
    throw new Error(localizedMessage("web_share_unavailable", [], "Web Share is unavailable on this device."));
  }

  // Desktop: prefer the downloads API (Chrome, Firefox).
  if (api.downloads && api.downloads.download) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      await api.downloads.download({ url, filename, saveAs: false });
    } finally {
      // Defer revoke so the browser can start the download first.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    return { outcome: "downloaded", filename };
  }

  // Safari macOS has no downloads API: the native handler writes into
  // Downloads and reports the real outcome. Its failures propagate, so no
  // history is committed for a file that was not written.
  try {
    const response = await backgroundCommand("saveFile", { filename, text });
    return { outcome: "saved", filename: response.filename };
  } catch (error) {
    if (!error || (error.code !== "unavailable" && error.code !== "unsupported")) throw error;
  }

  // Fallback without a native handler: inject an <a download> click into the
  // page. This only proves the click was dispatched.
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error(localizedMessage("no_active_tab_download", [], "No active tab for download."));
  }
  await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: (content, name) => {
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoking right after the click can cancel a download not yet started.
      setTimeout(() => URL.revokeObjectURL(url), 40000);
    },
    args: [text, filename],
  });
  return { outcome: "downloaded", filename };
}

// The coordinator atomically accepts history + queued work. No follow-up sync
// command is necessary, and losing this popup after acknowledgement is safe.
async function commitTerms(terms, url) {
  const response = await backgroundCommand("commitTerms", { terms, url: url || "" });
  return response.added || 0;
}

// ---------------------------------------------------------------------------
// History management: clear / export / import
// ---------------------------------------------------------------------------

if (clearBtn) {
  clearBtn.addEventListener("click", async () => {
    // A pending reset is still actionable: this same click retries it, under a
    // newer fence if it stopped at an error. Only a running abandon waits.
    if (abandonRunning || !confirm(localizedMessage("confirm_clear", [], "Clear your entire known-terms history?"))) return;
    clearBtn.disabled = true;
    try {
      await backgroundCommand("clearHistory");
      // Cloud reset acceptance is not completion. The old history stays visible
      // until the coordinator receives iCloud acknowledgement and clears it.
      if (currentState && currentState.sync && currentState.sync.resetPending) {
        setStatus(localizedMessage("history_clearing", [], "Clearing history… waiting for iCloud confirmation."), "");
      } else if (currentState && Object.keys(currentState.seenKanji).length === 0) {
        setStatus(localizedMessage("history_cleared", [], "Known-terms history cleared."), "ok");
      }
    } catch (error) { setStatus(syncErrorMessage(error), "error"); }
    finally { clearBtn.disabled = abandonRunning; }
  });
}

if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    try {
      const state = await getState();
      const payload = {
        type: "kanji-extractor-history", version: 1,
        exported: new Date().toISOString(), seenKanji: state.seenKanji,
      };
      const filename = `kanji_history_${new Date().toISOString().slice(0, 10)}.json`;
      const saved = await saveTextFile(JSON.stringify(payload, null, 2), filename);
      if (saved.outcome !== "cancelled") {
        setStatus(localizedMessage("history_exported", [saved.filename], "Export requested: " + saved.filename), "ok");
      }
    } catch (error) { setStatus(syncErrorMessage(error), "error"); }
  });
}

if (importBtn && importInput) {
  importBtn.addEventListener("click", () => { if (!observedReset) importInput.click(); });
  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = (parsed && parsed.seenKanji) || (parsed && parsed.type === undefined ? parsed : null);
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        throw new Error(localizedMessage("import_bad_file", [], "Not a valid history file."));
      }
      // Validation, normalization, merging and enqueueing belong to one atomic
      // background operation, shared with every other history mutation.
      const response = await backgroundCommand("importHistory", { incoming });
      const added = response.added || 0;
      setStatus(countMessage(added, "import_done_one", "import_done", [String(added)],
        (s) => `Imported ${added} new term${s}.`), "ok");
    } catch (error) {
      const reason = error && error.code ? syncErrorMessage(error) : (error.message || String(error));
      setStatus(localizedMessage("import_failed", [reason], "Import failed: " + reason), "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// True when `result.display` shows exactly what the list was last built from:
// same length, total, and term/count sequence. Compared by content because
// renderState rebuilds `newTerms` as a fresh array on every state update.
function sameAsRenderedList(result) {
  const shown = renderedList;
  const display = result.display;
  if (!shown || shown.total !== result.totalOccurrences || shown.terms.length !== display.length) return false;
  for (let i = 0; i < display.length; i++) {
    if (shown.terms[i] !== display[i].term || shown.counts[i] !== display[i].count) return false;
  }
  return true;
}

// Shows `result.display` in the list and updates the counters. The rows are
// rebuilt only when the content changed: a sync cycle publishes the state
// several times, and rebuilding up to 1000 rows each time is wasted work.
function renderResults(result) {
  uniqueEl.textContent = result.display.length;
  totalEl.textContent = result.totalOccurrences;
  statsEl.hidden = false;
  if (sameAsRenderedList(result)) return;
  renderedList = {
    terms: result.display.map((entry) => entry.term),
    counts: result.display.map((entry) => entry.count),
    total: result.totalOccurrences,
  };

  resultsEl.innerHTML = "";
  // Cap the rendered rows so a content-heavy page (thousands of unique terms)
  // can't freeze the popup. The downloaded file and history always keep them all.
  const MAX_RENDER = 1000;
  const shown = Math.min(result.display.length, MAX_RENDER);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i++) {
    const entry = result.display[i];
    const li = document.createElement("li");

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = (i + 1) + ".";

    const w = document.createElement("span");
    w.className = "word";
    w.textContent = entry.term;

    const freq = document.createElement("span");
    freq.className = "freq";
    freq.textContent = localizedMessage("freq_count", [String(entry.count)], entry.count + "×");

    const len = document.createElement("span");
    len.className = "len";
    const charCount = [...entry.term].length; // code points (surrogate-safe)
    len.textContent = localizedMessage("char_count", [String(charCount)], charCount + " chars");

    li.appendChild(idx);
    li.appendChild(w);
    li.appendChild(freq);
    li.appendChild(len);
    frag.appendChild(li);
  }
  if (result.display.length > MAX_RENDER) {
    const li = document.createElement("li");
    li.className = "more";
    const rest = result.display.length - MAX_RENDER;
    li.textContent = localizedMessage("more_terms", [String(rest)], "+ " + rest + " more (in the saved file)");
    frag.appendChild(li);
  }
  resultsEl.appendChild(frag);
}

function buildFileContents(r) {
  const terms = r.display;
  const lines = [];
  lines.push(localizedMessage("file_source", [r.url || ""], "Source: " + (r.url || "")));
  lines.push(localizedMessage("file_extracted", [new Date().toISOString()], "Extracted: " + new Date().toISOString()));
  if (r.newOnly) {
    lines.push(localizedMessage("file_new_terms", [String(terms.length)], "New kanji terms (not previously seen): " + terms.length));
  } else {
    lines.push(localizedMessage("file_unique_terms", [String(terms.length)], "Unique kanji terms (2+ chars): " + terms.length));
  }
  lines.push(localizedMessage("file_total_occurrences", [String(r.totalOccurrences)], "Total occurrences (with duplicates): " + r.totalOccurrences));
  lines.push("-".repeat(40));
  for (const t of terms) lines.push(t.term);
  return lines.join("\n") + "\n";
}

function makeFilename(url, newOnly) {
  let host = "page";
  try { host = new URL(url).hostname || "page"; } catch (_) {}
  // IPv6 hostnames carry brackets and colons, which are unsafe in file names.
  host = host.replace(/[\[\]:]/g, "");
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
  return `kanji_${newOnly ? "new_" : ""}${host}_${stamp}.txt`;
}

// ---------------------------------------------------------------------------
// Injected into the active page. MUST be self-contained — it has no access to
// anything in this file's scope at runtime.
//
// mode:
//   "kanji-words" (B) — whole words made ONLY of kanji, 2+ chars (default)
//   "all-words"   (A) — any word containing at least one kanji
// Both segment with Intl.Segmenter. When unavailable (e.g. Firefox <125) we
// fall back to contiguous kanji runs of 2+ and report engine:"runs".
// "Kanji" includes the ideographic iteration mark (人々, 時々) — KANJI_BASE and
// KANJI_MARKS below are the exact set.
// ---------------------------------------------------------------------------
function extractKanjiInPage(mode) {
  if (!document.body) return { terms: [], totalOccurrences: 0, engine: "none" };

  // --- Kanji character class ------------------------------------------------
  // ONE definition; every regex below is built from these two constants, so they
  // can never disagree. Rules when editing:
  //   1. Escapes only, never a literal CJK character — U+8C48 and U+F900 are
  //      indistinguishable on screen, and mistaking one for the other here
  //      silently widens the class over Hangul and the Private Use Area.
  //   2. Ascending order, so an overlap or a typo'd bound is visible on review.
  //   3. Add ranges only here, never to a regex directly.
  const KANJI_BASE =
    "\\u{3400}-\\u{4DBF}"   + // CJK Unified Ideographs Extension A
    "\\u{4E00}-\\u{9FFF}"   + // CJK Unified Ideographs
    "\\u{F900}-\\u{FAFF}"   + // CJK Compatibility Ideographs
    "\\u{20000}-\\u{2A6DF}" + // Extension B
    "\\u{2A700}-\\u{2B73F}" + // Extension C
    "\\u{2B740}-\\u{2B81F}" + // Extension D
    "\\u{2B820}-\\u{2CEAF}" + // Extension E
    "\\u{2CEB0}-\\u{2EBEF}" + // Extension F
    "\\u{2EBF0}-\\u{2EE5F}" + // Extension I
    "\\u{2F800}-\\u{2FA1F}" + // CJK Compatibility Ideographs Supplement
    "\\u{30000}-\\u{3134F}" + // Extension G
    "\\u{31350}-\\u{323AF}";  // Extension H
  // Iteration marks repeat the PRECEDING kanji (人々, 時々, 様々, 我々): part of the
  // word, but not a kanji on their own and never able to start one. They stay out
  // of KANJI_BASE because a mark inside the fallback's repeat class fuses the
  // words on either side of it (時々 + 大雨 would match as one "時々大雨"), and a
  // lone mark would be storable as a term in "all-words" mode.
  const KANJI_MARKS =
    "\\u{3005}" +             // U+3005 ideographic iteration mark
    "\\u{303B}";              // U+303B vertical form of the same mark
  // Left out on purpose: U+3007 and U+3006 are split off by Intl.Segmenter
  // (二〇二六年 → 二|〇|二|六年, 〆切 → 〆|切) so they recover no word, and U+3007
  // would make 〇〇 placeholders extract as vocabulary. Kana, the kana iteration
  // marks, and CJK punctuation are not kanji.

  // "Contains a kanji at all" — marks excluded, so a bare mark is not a word.
  const KANJI_BASE_CHAR = new RegExp("[" + KANJI_BASE + "]", "u");
  // "Is nothing but kanji" — a mark bound to a kanji counts, so 人々 qualifies.
  const KANJI_CHAR = new RegExp("[" + KANJI_BASE + KANJI_MARKS + "]", "u");
  // Fallback only: one kanji plus its mark, or a run of 2+ kanji. The mark branch
  // MUST come first — with the run branch first, 時々大雨 matches as one term.
  const KANJI_RUN = new RegExp(
    "[" + KANJI_BASE + "][" + KANJI_MARKS + "]|[" + KANJI_BASE + "]{2,}", "gu");
  // A Japanese segmenter is not a language filter: Hangul tone marks U+302E/F
  // can stay attached to a kanji. Reject the entire token in all-words mode.
  // Script (not Script_Extensions) avoids excluding shared Japanese punctuation.
  const HANGUL_CHAR = /\p{Script=Hangul}/u;

  function hasKanji(s) { for (const c of s) if (KANJI_BASE_CHAR.test(c)) return true; return false; }
  function isAllKanji(s) { for (const c of s) if (!KANJI_CHAR.test(c)) return false; return true; }

  const counts = new Map(); // term -> count, insertion order = first-seen order
  let total = 0;
  const canSegment = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
  const seg = canSegment ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
  const keep = (mode === "all-words")
    ? (s) => hasKanji(s) && !HANGUL_CHAR.test(s)
    : (s) => [...s].length >= 2 && hasKanji(s) && isAllKanji(s);

  function addTerm(term) {
    total++;
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  // Inline markup does not create word boundaries. In particular, splitting
  // <ruby>食<rt>た</rt></ruby>べる into individual text nodes loses the okurigana.
  // Collect a rendered inline run, omitting ruby readings, before tokenizing.
  let textParts = [];
  function flushText() {
    if (!textParts.length) return;
    // Remove both Unicode variation-selector ranges before segmentation: an
    // IVS can otherwise split one kanji word into multiple rejected tokens.
    const text = textParts.join("").replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "");
    textParts = [];
    if (!hasKanji(text)) return;
    if (seg) {
      for (const part of seg.segment(text)) {
        if (!part.isWordLike) continue;
        const term = part.segment.normalize("NFC");
        if (!keep(term)) continue;
        addTerm(term);
      }
    } else {
      // Fallback: contiguous kanji runs of 2+ (no word segmentation available).
      KANJI_RUN.lastIndex = 0;
      let match;
      while ((match = KANJI_RUN.exec(text)) !== null) {
        addTerm(match[0].normalize("NFC"));
      }
    }
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const INLINE_DISPLAYS = new Set(["inline", "contents", "ruby", "ruby-base", "ruby-base-container"]);
  const SCAN_BUDGET_MS = 1500;
  const scanStartedAt = Date.now();
  let partial = false;
  // Enter/exit events retain block boundaries without recursive DOM traversal.
  // display:none prunes a subtree; visibility is tested for each element because
  // a descendant may explicitly restore visibility. BODY follows the same rules.
  const stack = [{ node: document.body, visible: true }];
  while (stack.length) {
    if (Date.now() - scanStartedAt >= SCAN_BUDGET_MS) {
      partial = true;
      break;
    }
    const entry = stack.pop();
    if (entry.boundary) {
      flushText();
      continue;
    }
    const node = entry.node;
    if (node.nodeType === 3) {
      if (entry.visible) textParts.push(node.nodeValue || "");
      else flushText();
      continue;
    }
    if (node.nodeType !== 1) continue;
    // Ruby annotations are not part of the base word or a boundary within it.
    if (node.tagName === "RT" || node.tagName === "RP") continue;
    if (SKIP_TAGS.has(node.tagName) || node.tagName === "BR") {
      flushText();
      continue;
    }
    const style = getComputedStyle(node);
    if (style.display === "none") {
      flushText();
      continue;
    }
    const visible = style.visibility !== "hidden" && style.visibility !== "collapse";
    const boundary = !visible || !INLINE_DISPLAYS.has(style.display);
    if (boundary) {
      flushText();
      stack.push({ boundary: true });
    }
    // Shadow content is rendered separately from the host's light children.
    // A boundary prevents words on either side from being joined accidentally.
    if (node.shadowRoot) {
      stack.push({ boundary: true });
      for (let i = node.shadowRoot.childNodes.length - 1; i >= 0; i--) {
        stack.push({ node: node.shadowRoot.childNodes[i], visible });
      }
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      stack.push({ node: node.childNodes[i], visible });
    }
  }
  flushText();
  const terms = [];
  counts.forEach((count, term) => terms.push({ term, count }));
  const result = { terms, totalOccurrences: total, engine: canSegment ? "segmenter" : "runs" };
  if (partial) result.partial = true;
  return result;
}
