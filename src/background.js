// Entry point for Safari/Chrome service workers and Firefox's event page.
// Register listeners synchronously on every load. Startup work restores saved
// jobs, but no timer or open popup is needed to remember what remains to do.
if (typeof importScripts === "function") importScripts("sync-core.js", "sync-coordinator.js");

const api = typeof browser !== "undefined" ? browser : chrome;
const promiseAPI = typeof browser !== "undefined";
const SYNC_ALARM = "kanji-sync";
const RECOVERY_ALARM = "kanji-sync-recovery";
const SYNC_PERIOD_MINUTES = 30;
const nativeAvailable = !!api.runtime.sendNativeMessage &&
  (api.runtime.getManifest().permissions || []).includes("nativeMessaging");

// Firefox/Safari expose Promise APIs; Chrome also supports the callback form.
// Use one form per invocation so a successful mutation is never sent twice.
function invoke(target, method, ...args) {
  if (promiseAPI) {
    try { return Promise.resolve(target[method](...args)); }
    catch (error) { return Promise.reject(error); }
  }
  return new Promise((resolve, reject) => {
    try {
      target[method](...args, result => {
        const error = api.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

function storageGet(keys) { return invoke(api.storage.local, "get", keys); }
function storageSet(value) { return invoke(api.storage.local, "set", value); }
// Only the coordinator's recovery-copy cleanup removes keys.
function storageRemove(keys) { return invoke(api.storage.local, "remove", keys); }

function callNative(message) {
  return new Promise((resolve, reject) => {
    // This timeout limits this caller's wait. It does NOT cancel CloudKit; the
    // Swift gate retains ownership until that operation actually finishes.
    const timer = setTimeout(() => reject(new Error("native request timed out")), 30000);
    invoke(api.runtime, "sendNativeMessage", "application.id", message).then(
      response => { clearTimeout(timer); resolve(response); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

let alarmUpdates = Promise.resolve();
function scheduleWake(deadline) {
  if (!nativeAvailable || !api.alarms) return Promise.resolve();
  const update = alarmUpdates.then(async () => {
    const existing = await invoke(api.alarms, "get", RECOVERY_ALARM);
    if (!deadline) {
      if (existing) await invoke(api.alarms, "clear", RECOVERY_ALARM);
      return;
    }
    // Keep an earlier alarm. Replacing it on every worker load could postpone
    // recovery indefinitely. The deadline itself is also saved in kanjiState.
    if (!existing || existing.scheduledTime > deadline) {
      await Promise.resolve(api.alarms.create(RECOVERY_ALARM, { when: deadline }));
    }
  });
  alarmUpdates = update.catch(() => {});
  return update;
}

async function ensurePeriodicAlarm() {
  if (!nativeAvailable || !api.alarms) return;
  const existing = await invoke(api.alarms, "get", SYNC_ALARM);
  if (!existing) {
    await Promise.resolve(api.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES }));
  }
}

const coordinator = createSyncCoordinator({
  storageGet, storageSet, storageRemove, callNative, scheduleWake, nativeAvailable,
});

// Safari on macOS has no downloads API: the native handler writes the file
// into Downloads and reports the name it actually used, so the popup commits
// terms only after a real write. No history state is involved.
const SAVE_FILE_TEXT_LIMIT = 5 * 1024 * 1024;
const recentSaves = new Map();

// The popup retries a lost response once with the SAME id. Answering that
// retry from the first attempt keeps it from writing a second copy. A worker
// restart between the attempts forgets the id; the retry may then write
// "name (2).txt", which is acceptable.
function saveFile(payload, id) {
  if (typeof id === "string" && recentSaves.has(id)) return recentSaves.get(id);
  const result = writeNativeFile(payload);
  if (typeof id === "string") {
    recentSaves.set(id, result);
    if (recentSaves.size > 16) recentSaves.delete(recentSaves.keys().next().value);
  }
  return result;
}

async function writeNativeFile(payload) {
  if (!nativeAvailable) {
    return { ok: false, code: "unavailable", error: "Saving to Downloads is unavailable in this browser." };
  }
  const { filename, text } = payload || {};
  // UTF-16 length never exceeds the UTF-8 byte count; native checks the bytes.
  if (typeof filename !== "string" || filename.length < 1 || filename.length > 255 ||
      typeof text !== "string" || text.length > SAVE_FILE_TEXT_LIMIT) {
    return { ok: false, code: "invalidFile", error: "The file name or contents are invalid." };
  }
  try {
    const response = await callNative({ action: "saveDownload", filename, text });
    // Only the written name proves that a file exists.
    if (response && response.ok && typeof response.filename === "string") {
      return { ok: true, filename: response.filename };
    }
    return { ok: false, code: (response && response.code) || "generic",
      error: (response && response.error) || "The file could not be saved." };
  } catch (error) {
    return { ok: false, code: "generic", error: (error && error.message) || "The file could not be saved." };
  }
}

// Do not log command payloads or vocabulary. Failures of a sync job are saved
// in its status for the popup; this covers failures before storage was readable.
function reportBackgroundFailure(error) {
  console.warn("Kanji Extractor background:", error?.code || "unavailable");
}

function resume() {
  coordinator.run().catch(reportBackgroundFailure);
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.kind !== "kanji") return undefined;
  if (message.command === "saveFile") {
    // Not a history command: it never reaches the coordinator or resumes a job.
    saveFile(message.payload, message.id).then(sendResponse).catch(reportBackgroundFailure);
    return true;
  }
  // runtime.onMessage is internal to the extension. There is no external
  // listener or content script; the command dispatcher also validates inputs.
  coordinator.command(message.command, message.payload, message.id).then(
    result => {
      // A popup can disappear between the durable commit and this reply.
      // Resuming the accepted job must not depend on a surviving receiver.
      try { sendResponse(result); } finally { resume(); }
    },
    error => {
      try { sendResponse({ ok: false, error: error.message || "Background unavailable", code: error.code || "generic" }); }
      finally { resume(); }
    }
  ).catch(reportBackgroundFailure);
  return true;
});

async function restore() {
  await ensurePeriodicAlarm();
  await coordinator.restore();
  resume();
}

api.runtime.onInstalled.addListener(() => { restore().catch(reportBackgroundFailure); });
if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { restore().catch(reportBackgroundFailure); });
if (api.alarms?.onAlarm) {
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm?.name === SYNC_ALARM) {
      coordinator.requestPeriodic().then(resume).catch(reportBackgroundFailure);
    } else if (alarm?.name === RECOVERY_ALARM) {
      coordinator.restore().then(resume).catch(reportBackgroundFailure);
    }
  });
}

restore().catch(reportBackgroundFailure);
