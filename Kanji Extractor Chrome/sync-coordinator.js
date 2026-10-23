// The background is the only writer of history and sync state. The popup sends
// commands and observes the saved envelope; closing it never owns/cancels a job.
// Dependencies are injected so restart and network races can be tested without
// Safari or access to the user's iCloud account.
const KANJI_STATE_KEY = "kanjiState";
const KANJI_REPAIR_BACKUP_KEY = "kanjiStateRepairBackup";
// An envelope no command can read is moved here instead of being deleted.
const KANJI_STATE_QUARANTINE_KEY = "kanjiStateQuarantine";
// The advisory lock of the pre-envelope sync: a legacy key like STORE_DEFAULTS.
const LEGACY_SYNC_LOCK_KEY = "syncLock";
// Recovery copies of a history a valid envelope already holds are kept this
// long after this version first reads that envelope beside them.
const RECOVERY_RETENTION_MS = 30 * 86400000;
const KANJI_STATE_VERSION = 2;
const SYNC_BATCH_SIZE = 400;
const SYNC_RECOVERY_MS = 60000;
const SYNC_MAX_PAGES = 1000;
// One ceiling for every retry delay: a server value, an overflow, or a damaged
// counter must never park the next attempt beyond a session the user can see.
const SYNC_MAX_BACKOFF_MS = 30 * 60000;
// The extraction modes a preference may hold; anything else keeps the default.
const EXTRACT_MODES = ["kanji-words", "all-words"];
// Returned by a drain's first step when its job is not due or waits for the user.
const SYNC_NOT_DUE = Symbol("notDue");

function syncFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Browsers refuse a write over the quota differently: Chrome "QUOTA_BYTES
// quota exceeded", WebKit "Exceeded storage quota", Firefox/DOM a
// QuotaExceededError (legacy code 22), whose message may be empty.
function isQuotaError(error) {
  if (!error) return false;
  if (error.name === "QuotaExceededError" || error.code === 22) return true;
  return /quota/i.test(String(error.message || error));
}

// A storage failure is not a sync failure. Only the browser's short reason is
// kept for the popup; it never carries stored values.
function storageFailure(error) {
  if (isQuotaError(error)) return syncFailure("storageQuota", "Browser storage is full.");
  const detail = String((error && error.message) || error || "").slice(0, 160);
  return syncFailure("storage", detail || "Browser storage is unavailable.");
}

function createSyncCoordinator(dependencies) {
  const { storageGet, storageSet, storageRemove, callNative, scheduleWake, nativeAvailable } = dependencies;
  const now = dependencies.now || Date.now;
  const random = dependencies.random || Math.random;
  let mutations = Promise.resolve();
  let running = null;
  // Preserve the last durable revision even if a later storage read is damaged.
  let lastKnownRevision = null;
  // Recovery copies of a history the envelope already holds: the pre-envelope
  // keys, never read again once kanjiState exists, and the aliasing repair
  // backup. The quarantine is not one of them: it may be the only copy, and
  // while it exists these are kept too, until a confirmed Clear history.
  const legacyKeys = [...Object.keys(STORE_DEFAULTS), LEGACY_SYNC_LOCK_KEY];
  const recoveryKeys = [...legacyKeys, KANJI_REPAIR_BACKUP_KEY];

  // A single JSON value avoids WebKit's partial multi-key writes. There is no
  // claim of filesystem fsync or compare-and-swap: correctness also requires
  // this one writer. Every operation reads storage afresh, including after a
  // failed/ambiguous set(), so a stale in-memory copy cannot overwrite a commit.
  // Within one operation, the state it read or successfully saved stays what
  // storage holds until the operation ends, so the operation may still act on
  // it (arming the wake) without reading again; no copy outlives the operation.
  function serialize(operation) {
    const result = mutations.then(operation);
    mutations = result.catch(() => {});
    return result;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  async function storageRead(keys) {
    try { return await storageGet(keys); }
    catch (error) { throw storageFailure(error); }
  }

  async function readStorage(keys) {
    // Safari's Foundation/JavaScriptCore bridge can reuse one native object for
    // separate empty JSON dictionaries or arrays. Detach each branch before any
    // mutation, or adding a queue entry may also change the command receipts.
    // structuredClone preserves shared references, so it cannot fix this alias.
    return JSON.parse(JSON.stringify(await storageRead(keys)));
  }

  // A key list, never defaults: a default would make an absent key look present.
  async function presentKeys(keys) {
    const stored = await storageRead(keys);
    return keys.filter(key => isObject(stored) && Object.prototype.hasOwnProperty.call(stored, key));
  }

  async function removeKeys(keys) {
    try { await storageRemove(keys); }
    catch (error) { throw storageFailure(error); }
  }

  // Every write goes through here. One refused for the quota gets ONE
  // emergency cleanup of the copies in `removable`, then ONE retry. A write
  // whose own source is among those copies passes fewer keys, or none.
  async function write(patch, removable = recoveryKeys) {
    try {
      await storageSet(patch);
      return;
    } catch (error) {
      if (!isQuotaError(error) || !await freeRecoveryCopies(removable)) throw storageFailure(error);
    }
    try {
      await storageSet(patch);
    } catch (error) {
      throw storageFailure(error);
    }
  }

  // Returns whether anything was freed. A failed cleanup frees nothing, nor
  // does one beside a quarantine: legacy keys and the backup may then be the
  // only readable copies of a history, kept until a confirmed Clear history.
  async function freeRecoveryCopies(keys) {
    if (!keys.length) return false;
    try {
      const present = await presentKeys([...keys, KANJI_STATE_QUARANTINE_KEY]);
      if (!present.length || present.includes(KANJI_STATE_QUARANTINE_KEY)) return false;
      await removeKeys(present);
      return true;
    } catch (_) {
      return false;
    }
  }

  // A confirmed Clear history of a valid envelope ends every recovery copy,
  // the quarantine included, once the cleared envelope is saved. A failure
  // never fails the clear: retention (legacy keys and backup) or the next
  // confirmed clear (quarantine) removes what is left.
  async function discardRecoveryCopies() {
    try {
      const present = await presentKeys([...recoveryKeys, KANJI_STATE_QUARANTINE_KEY]);
      if (present.length) await removeKeys(present);
    } catch (_) {}
  }

  function isReceipt(value) {
    return isObject(value) && Object.keys(value).length === 1 &&
      Object.prototype.hasOwnProperty.call(value, "added") &&
      Number.isSafeInteger(value.added) && value.added >= 0;
  }

  function separateAliasedMaps(state) {
    if (!isObject(state) || state.schemaVersion !== KANJI_STATE_VERSION ||
        !isObject(state.seenKanji) || !isObject(state.syncQueue) ||
        !isObject(state.completedCommands)) return null;
    const keys = Object.keys(state.syncQueue);
    if (keys.length !== Object.keys(state.completedCommands).length) return null;
    const queue = {};
    const receipts = {};
    for (const key of keys) {
      if (!isSafeHistoryKey(key) || !Object.prototype.hasOwnProperty.call(state.completedCommands, key)) return null;
      const value = state.syncQueue[key];
      const other = state.completedCommands[key];
      const isTerm = Object.prototype.hasOwnProperty.call(state.seenKanji, key);
      if (isTerm && Number.isSafeInteger(value) && value >= 1 && value === other) {
        queue[key] = value;
      } else if (!isTerm && isReceipt(value) && isReceipt(other) && value.added === other.added) {
        receipts[key] = value;
      } else {
        return null;
      }
    }
    // Only repair the exact observed signature: two identical mixed maps whose
    // entries can all be classified without guessing. Unrelated corruption must
    // still fail validation; it must never trigger a reset or legacy migration.
    if (!Object.keys(queue).length || !Object.keys(receipts).length) return null;
    return { ...state, syncQueue: queue, completedCommands: receipts };
  }

  function nextGeneration(local, native = 0) {
    const current = Math.max(local, native);
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw syncFailure("invalidGeneration", "History generation limit reached.");
    }
    return current + 1;
  }

  function newSyncState(enabled) {
    return {
      requested: enabled, phase: enabled ? "waiting" : "idle", stage: "pull",
      nextAttemptAt: 0, lastSuccessAt: null, error: null,
      pages: 0, sent: 0, attempts: 0, resetPending: false, cycle: 0,
    };
  }

  // Empties the history, its upload queue and its read cursor: the local half
  // of a confirmed Clear history. Sync job and generation are the caller's.
  function wipeHistory(state) {
    state.seenKanji = {};
    state.syncQueue = {};
    state.syncToken = null;
  }

  // Concludes a job whose inbound pass finished and whose queue is empty.
  function completeJob(job) {
    job.requested = false;
    job.phase = "idle";
    job.nextAttemptAt = 0;
    job.lastSuccessAt = now();
    job.error = null;
    job.attempts = 0;
  }

  // The queued terms a push may send, in queue order. A queued term must exist
  // locally and fit the shared code point limit: an older version may have
  // queued a longer term that the native layer now rejects with `protocol`,
  // so such a term leaves the queue here, but not the history.
  function pushableTerms(state) {
    const terms = [];
    for (const term of Object.keys(state.syncQueue)) {
      if (Object.prototype.hasOwnProperty.call(state.seenKanji, term) && isHistoryTerm(term)) terms.push(term);
      else delete state.syncQueue[term];
    }
    return terms;
  }

  function validateState(state) {
    if (!isObject(state) || state.schemaVersion !== KANJI_STATE_VERSION ||
        !isObject(state.seenKanji) || !isObject(state.syncQueue) ||
        !isObject(state.sync) || !isObject(state.completedCommands) ||
        !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !Number.isSafeInteger(state.generation) || state.generation < 0 ||
        typeof state.syncEnabled !== "boolean" ||
        typeof state.sync.requested !== "boolean" || typeof state.sync.resetPending !== "boolean" ||
        !Number.isFinite(state.sync.nextAttemptAt) || state.sync.nextAttemptAt < 0 ||
        !["idle", "pull", "push", "waiting", "error", "reset"].includes(state.sync.phase) ||
        !["pull", "push", "reset", "abandon"].includes(state.sync.stage) ||
        (Object.prototype.hasOwnProperty.call(state, "recoveryRetainedSince") &&
          (!Number.isSafeInteger(state.recoveryRetainedSince) || state.recoveryRetainedSince < 0)) ||
        Object.values(state.seenKanji).some(record => !isObject(record) || !Number.isFinite(record.count) || record.count < 0) ||
        Object.values(state.syncQueue).some(revision => !Number.isSafeInteger(revision) || revision < 1) ||
        Object.values(state.completedCommands).some(value => !isReceipt(value))) {
      throw syncFailure("storageSchema", "Stored history has an unsupported or damaged format.");
    }
  }

  async function readState() {
    const stored = await readStorage([KANJI_STATE_KEY]);
    if (Object.prototype.hasOwnProperty.call(stored, KANJI_STATE_KEY)) {
      const state = stored[KANJI_STATE_KEY];
      const repaired = separateAliasedMaps(state);
      if (repaired) {
        validateState(repaired);
        // Preserve the original snapshot before changing the authoritative state.
        // A string also avoids native container aliasing when reading the backup.
        // If either write fails, the next read can safely retry this same repair.
        // A full store may free legacy keys for them, never this backup.
        const backup = await readStorage([KANJI_REPAIR_BACKUP_KEY]);
        if (!Object.prototype.hasOwnProperty.call(backup, KANJI_REPAIR_BACKUP_KEY)) {
          await write({ [KANJI_REPAIR_BACKUP_KEY]: JSON.stringify(state) }, legacyKeys);
        }
        await save(repaired, legacyKeys);
        return repaired;
      }
      validateState(state);
      lastKnownRevision = state.revision;
      return state;
    }

    // Migration is one-way. Old keys are left as a recovery backup but are
    // NEVER merged again once an envelope exists, even when its history is empty.
    const legacy = await readStorage(STORE_DEFAULTS);
    const seen = {};
    if (isObject(legacy.seenKanji)) importIntoHistory(seen, legacy.seenKanji);
    const enabled = !!legacy.syncEnabled && nativeAvailable;
    const queue = {};
    for (const rawTerm of Object.keys(legacy.syncQueue || {})) {
      const term = rawTerm.normalize("NFC");
      if (isHistoryTerm(term) && Object.prototype.hasOwnProperty.call(seen, term)) queue[term] = 1;
    }
    const state = {
      schemaVersion: KANJI_STATE_VERSION, revision: 1, generation: 0,
      seenKanji: sortSeenByCount(seen), newOnlyEnabled: !!legacy.newOnlyEnabled,
      extractMode: legacy.extractMode || "kanji-words", syncEnabled: enabled,
      syncQueue: queue, syncToken: legacy.syncToken || null,
      sync: newSyncState(enabled), completedCommands: {},
    };
    // The legacy keys are this write's source: a full store must not free them.
    await write({ [KANJI_STATE_KEY]: state }, []);
    lastKnownRevision = state.revision;
    return state;
  }

  async function save(state, removable) {
    if (state.revision >= Number.MAX_SAFE_INTEGER) throw syncFailure("storageSchema", "History revision limit reached.");
    state.revision++;
    await write({ [KANJI_STATE_KEY]: state }, removable);
    lastKnownRevision = state.revision;
  }

  // A deadline beyond one maximum backoff is from a clock that moved back;
  // treat it as due for both execution and alarm scheduling.
  function dueAt(job) {
    const current = now();
    return job.nextAttemptAt > current + SYNC_MAX_BACKOFF_MS ? current : job.nextAttemptAt;
  }

  function requestWork(state, force) {
    if (!nativeAvailable || (!state.syncEnabled && !state.sync.resetPending)) return;
    const job = state.sync;
    // A restored browser backup can precede the native reset journal. Only an
    // explicit retry advances an already requested reset to that newer fence.
    if (force && job.resetPending && job.error?.code === "staleGeneration" &&
        Number.isSafeInteger(job.nativeGeneration)) {
      state.generation = nextGeneration(state.generation, job.nativeGeneration);
      job.cycle = state.revision + 1;
    }
    if (!job.requested) {
      job.cycle = state.revision + 1;
      // An abandon already chose how this pending reset ends; only a job with
      // no chosen stage falls back to deleting the zone or reading changes.
      if (!job.resetPending) job.stage = "pull";
      else if (job.stage !== "abandon") job.stage = "reset";
      job.pages = 0;
      job.sent = 0;
      job.phase = job.resetPending ? "reset" : "waiting";
    }
    job.requested = true;
    if (force || !job.error) {
      if (job.error?.code === "pageLimit") job.pages = 0;
      job.nextAttemptAt = 0;
      job.error = null;
      job.attempts = 0;
      if (job.phase === "error") job.phase = "waiting";
    }
  }

  function markDirty(state, terms) {
    if (!state.syncEnabled || !nativeAvailable) return;
    for (const term of terms) state.syncQueue[term] = state.revision + 1;
    requestWork(state, false);
  }

  // Arms the recovery wake for `state`, or clears it when no job can run.
  // `state` must be what storage holds right now: callers run inside the
  // dispatcher, right after reading it or after saving it successfully, so no
  // other operation can have replaced it. Scheduling from the current state
  // inside the dispatcher is what keeps a delayed reply from an older command
  // from cancelling a newer job's recovery alarm. Rejects if scheduling fails.
  async function armWake(state, stalledRevision) {
    const job = state.sync;
    // A failure that could not be saved leaves the job as its step left it,
    // lease included. Arming from that lease would only repeat the step, so
    // the wake is cleared unless something newer was saved since.
    const stalled = state.revision === stalledRevision;
    const runnable = !stalled && job.requested && (state.syncEnabled || job.resetPending) && job.phase !== "error";
    await scheduleWake(runnable ? Math.max(now(), dueAt(job) || 0) : 0);
  }

  // Arms the wake from a fresh read, for callers that do not hold the stored
  // state: after a failed or ambiguous write only storage knows what it is.
  async function reconcileWake(stalledRevision) {
    return serialize(async () => armWake(await readState(), stalledRevision));
  }

  // An envelope that fails validation blocks every command, so the user could
  // neither read nor delete their own history. Deleting it is the way out, and
  // the unreadable value is kept aside: it is the only copy of that history.
  async function quarantine(damage, id) {
    const stored = await readStorage([KANJI_STATE_KEY]);
    const raw = stored[KANJI_STATE_KEY];
    try {
      await storageSet({ [KANJI_STATE_QUARANTINE_KEY]: JSON.stringify(raw === undefined ? null : raw) });
    } catch (_) {
      // Never destroy what could not be preserved: leave the damage in place.
      throw damage;
    }
    const valid = isObject(raw) ? raw : {};
    // The new envelope must outrun both the revision this coordinator last
    // saved and whatever the damaged envelope still reports: either one may be
    // the higher, and a repeated cycle number would let a stale pull page in.
    const safeRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const oldRevision = Math.max(safeRevision(lastKnownRevision), safeRevision(valid.revision));
    if (oldRevision >= Number.MAX_SAFE_INTEGER - 1) {
      throw syncFailure("storageSchema", "History revision limit reached.");
    }
    const state = {
      schemaVersion: KANJI_STATE_VERSION, revision: oldRevision + 1,
      generation: Number.isSafeInteger(valid.generation) && valid.generation >= 0 ? valid.generation : 0,
      seenKanji: {}, newOnlyEnabled: typeof valid.newOnlyEnabled === "boolean" ? valid.newOnlyEnabled : false,
      extractMode: EXTRACT_MODES.includes(valid.extractMode) ? valid.extractMode : "kanji-words",
      // Sync restarts from the user's own decision: the discarded envelope may
      // have held a cursor or a fence that no longer describes this history.
      syncEnabled: false, syncQueue: {}, syncToken: null,
      sync: newSyncState(false), completedCommands: { [id]: { added: 0 } },
    };
    // With the envelope unreadable, older copies may be the only good ones:
    // this clear keeps them all, and a full store frees none of them.
    await write({ [KANJI_STATE_KEY]: state }, []);
    lastKnownRevision = state.revision;
    return { ok: true, state, added: 0 };
  }

  // Command receipts keep their existing 128-code-unit limit independently of
  // the vocabulary length bound, so older callers remain compatible.
  function isCommandIdentifier(id) {
    return isSafeHistoryKey(id) && id.length <= 128;
  }

  // Runs one command inside the dispatcher and returns its reply, whose
  // `state` is the envelope storage holds once the command is done: the one
  // it saved, or the one it read when it changed nothing. Throws, saving
  // nothing, for an invalid or refused command.
  async function applyCommand(name, payload, id) {
    let state;
    try {
      state = await readState();
    } catch (error) {
      if (error.code !== "storageSchema" || name !== "clearHistory" || !isObject(payload) ||
          !isCommandIdentifier(id)) throw error;
      return quarantine(error, id);
    }
    if (name === "getState") return { ok: true, state };
    if (!isObject(payload)) throw syncFailure("invalidCommand", "Invalid command payload.");
    const remembersCommand = name !== "syncNow";
    if (remembersCommand) {
      if (!isCommandIdentifier(id)) throw syncFailure("invalidCommand", "A command identifier is required.");
      if (Object.prototype.hasOwnProperty.call(state.completedCommands, id)) {
        return { ok: true, state, ...state.completedCommands[id] };
      }
    }
    let added = 0;
    let cleared = false;
    switch (name) {
      case "commitTerms": {
        if (state.sync.resetPending) throw syncFailure("resetPending", "History deletion is still in progress.");
        if (!Array.isArray(payload.terms)) throw syncFailure("invalidCommand", "Expected a list of terms.");
        const date = localDateString(now());
        const touched = [];
        for (const record of payload.terms) {
          if (!record || !isHistoryTerm(record.term)) continue;
          const term = record.term.normalize("NFC");
          if (!isHistoryTerm(term)) continue;
          const count = termCount(record.count);
          if (count === null || count <= 0) continue;
          const existing = Object.prototype.hasOwnProperty.call(state.seenKanji, term);
          mergeRemoteIntoSeen(state.seenKanji, [{ term, count, firstSeen: date, lastSeen: date }]);
          if (!existing) {
            state.seenKanji[term].firstUrl = typeof payload.url === "string" ? payload.url : "";
            added++;
          }
          touched.push(term);
        }
        state.seenKanji = sortSeenByCount(state.seenKanji);
        markDirty(state, touched);
        break;
      }
      case "importHistory": {
        if (state.sync.resetPending) throw syncFailure("resetPending", "History deletion is still in progress.");
        if (!isObject(payload.incoming)) throw syncFailure("invalidCommand", "Expected a history object.");
        const result = importIntoHistory(state.seenKanji, payload.incoming);
        added = result.added;
        for (const term of result.removed) delete state.syncQueue[term];
        state.seenKanji = sortSeenByCount(state.seenKanji);
        markDirty(state, result.touched);
        break;
      }
      case "setPreferences":
        if (typeof payload.newOnlyEnabled === "boolean") state.newOnlyEnabled = payload.newOnlyEnabled;
        if (EXTRACT_MODES.includes(payload.extractMode)) state.extractMode = payload.extractMode;
        break;
      case "setSyncEnabled":
        if (typeof payload.enabled !== "boolean") throw syncFailure("invalidCommand", "Expected a sync preference.");
        if (payload.enabled && !nativeAvailable) throw syncFailure("unavailable", "Sync is unavailable in this browser.");
        if (payload.enabled && !state.syncEnabled) {
          state.syncEnabled = true;
          markDirty(state, Object.keys(state.seenKanji));
          requestWork(state, true);
        } else if (!payload.enabled) {
          state.syncEnabled = false;
          if (state.sync.resetPending) {
            // Turning sync off must not strand a reset the cloud refused.
            // Ask native to forget the fence instead; saves stay blocked, and
            // the retry clears the error, until that answer arrives.
            state.sync.stage = "abandon";
            requestWork(state, true);
          } else {
            state.sync.requested = false;
            state.sync.phase = "idle";
            state.sync.nextAttemptAt = 0;
          }
        }
        break;
      case "clearHistory":
        if (state.sync.resetPending) {
          // A running abandon ends this reset without deleting anything, so
          // accepting a clear now would acknowledge an intent it then drops.
          // It is journal-only and ends in seconds; with sync off, Clear is
          // then the local clear. One stopped at an error is restarted below.
          if (state.sync.stage === "abandon" && state.sync.phase !== "error") {
            throw syncFailure("abandonPending", "The iCloud deletion is being cancelled.");
          }
          // A deletion still in flight keeps its fence: a repeated command
          // must not make its confirmation stale. One stopped at an error is
          // restarted under a newer fence instead, so it proceeds whatever
          // that attempt, or an abandon, left in the native journal.
          if (state.sync.phase === "error") {
            state.generation = nextGeneration(state.generation, state.sync.nativeGeneration || 0);
            state.sync.stage = "reset";
            state.sync.cycle = state.revision + 1;
          }
          requestWork(state, true);
        } else {
          const nativeGeneration = state.sync.nativeGeneration || 0;
          state.sync = newSyncState(false);
          if (state.syncEnabled && nativeAvailable) {
            state.generation = nextGeneration(state.generation, nativeGeneration);
            // Keep the old local history until CloudKit confirms the reset.
            // The saved intent survives popup closure, timeout, and restart.
            state.sync.resetPending = true;
            state.sync.stage = "reset";
            state.sync.phase = "reset";
            state.sync.requested = true;
            state.sync.cycle = state.revision + 1;
          } else {
            wipeHistory(state);
            cleared = true;
          }
        }
        break;
      case "syncNow":
        requestWork(state, true);
        break;
      case "adoptNativeGeneration": {
        const job = state.sync;
        const generation = job.error?.currentGeneration;
        if (job.phase !== "error" || job.error?.code !== "staleGeneration" ||
            !Number.isSafeInteger(generation) || generation < 0 || job.resetPending) {
          throw syncFailure("notStale", "No recoverable native generation is available.");
        }
        state.generation = generation;
        // A reset may have replaced the cloud zone: pull from its beginning,
        // then push every local term under the adopted fence.
        state.syncToken = null;
        for (const term of Object.keys(state.seenKanji)) state.syncQueue[term] = state.revision + 1;
        job.cycle = state.revision + 1;
        job.stage = "pull";
        job.phase = "waiting";
        job.requested = true;
        job.nextAttemptAt = 0;
        job.error = null;
        job.attempts = 0;
        job.pages = 0;
        job.sent = 0;
        delete job.nativeGeneration;
        break;
      }
      default:
        throw syncFailure("invalidCommand", "Unknown background command.");
    }
    if (remembersCommand) {
      state.completedCommands[id] = { added };
      // Bound receipts, not history: recent transport retries remain harmless
      // without letting a long-lived installation accumulate command IDs.
      const ids = Object.keys(state.completedCommands);
      for (const oldID of ids.slice(0, Math.max(0, ids.length - 64))) delete state.completedCommands[oldID];
    }
    await save(state);
    if (cleared) await discardRecoveryCopies();
    return { ok: true, state, added };
  }

  // The popup's entry point: applies a command and arms the recovery wake in
  // the same dispatcher turn, from the state the command returns. No later
  // operation can have replaced that state yet, so no second read is needed.
  async function command(name, payload = {}, id) {
    return serialize(async () => {
      const reply = await applyCommand(name, payload, id);
      // The command is already durable. An alarm failure must not turn a saved
      // command into a false failure; startup and the periodic alarm also recover.
      try { await armWake(reply.state); } catch (_) {}
      return reply;
    });
  }

  function acceptsResponse(state, plan) {
    if (state.generation !== plan.generation || state.sync.cycle !== plan.cycle || !state.sync.requested) return false;
    // Only the intent still saved may be concluded: an abandon answer cannot
    // release a reset the user has since asked for again, or the reverse.
    if (plan.action === "reset") return state.sync.resetPending;
    if (plan.action === "abandonReset") return state.sync.resetPending && state.sync.stage === "abandon";
    return state.syncEnabled && !state.sync.resetPending;
  }

  // Decides the job's next step from `state`, inside the dispatcher, and
  // saves it: the lease of a request, or the completion of a job with nothing
  // left to push. Returns the request plan, or null when there is none.
  async function planStep(state) {
    const job = state.sync;
    if (!nativeAvailable || !job.requested || (!state.syncEnabled && !job.resetPending) || job.phase === "error") return null;
    // A pending reset owns the job until native answers it: it either deletes
    // the zone or forgets the fence, so no page or upload runs in between.
    const action = job.resetPending ? (job.stage === "abandon" ? "abandonReset" : "reset") : job.stage;
    const plan = { action, generation: state.generation, cycle: job.cycle };
    if (plan.action === "pull") {
      if (job.pages >= SYNC_MAX_PAGES) throw syncFailure("pageLimit", "Too many pages in one sync; retry to continue.");
      plan.since = state.syncToken;
    } else if (plan.action === "push") {
      const terms = pushableTerms(state);
      if (!terms.length) {
        // Completion is decided inside the same dispatcher as new commits.
        // A concurrent save either precedes this decision or starts a new job.
        completeJob(job);
        await save(state);
        return null;
      }
      plan.revisions = {};
      plan.terms = terms.slice(0, SYNC_BATCH_SIZE).map(term => {
        plan.revisions[term] = state.syncQueue[term];
        const { count, firstSeen, lastSeen } = state.seenKanji[term];
        return { term, count, firstSeen, lastSeen };
      });
    }
    // Both endings of a reset are shown as one deletion phase to the popup.
    job.phase = action === "abandonReset" ? "reset" : action;
    job.nextAttemptAt = now() + SYNC_RECOVERY_MS;
    await save(state);
    return plan;
  }

  // One dispatcher turn of a drain: reads the state, plans and saves the next
  // step, then arms the recovery wake from the state just saved, so recovery
  // is armed BEFORE any request starts and without a second read.
  // `progress` belongs to the drain: `read` turns true once the state was
  // read, `armed` once the wake matches the saved state. With `gate`, the same
  // read first applies a new drain's due-time check: a job not due yet, or
  // waiting for the user, returns SYNC_NOT_DUE with nothing changed or armed.
  // Otherwise returns { plan, armError }: plan is null when nothing is left to
  // run. A failure to arm after a lease was saved comes back as armError, so
  // the drain records it against this plan without starting the request;
  // without a plan it only leaves `armed` false for the drain to retry.
  async function prepareStep(progress, gate) {
    return serialize(async () => {
      const state = await readState();
      progress.read = true;
      if (gate && (dueAt(state.sync) > now() || state.sync.phase === "error")) return SYNC_NOT_DUE;
      const plan = await planStep(state);
      try {
        await armWake(state);
        progress.armed = true;
      } catch (error) {
        if (plan) return { plan, armError: error };
      }
      return { plan, armError: null };
    });
  }

  // Applies a native reply to the step `plan` describes, inside the
  // dispatcher and only if the saved job still expects it. Throws for a
  // failed or malformed reply, for the drain to record. Returns false for a
  // reply to a replaced job, after arming the wake from the unchanged state
  // (`progress.armed`); returns true once the reply is saved.
  async function acceptStep(plan, response, progress) {
    if (!response || response.ok !== true) {
      const error = syncFailure(response?.code || "generic", response?.error || "sync failed");
      error.retryAfter = response?.retryAfter;
      error.currentGeneration = response?.currentGeneration;
      throw error;
    }
    return serialize(async () => {
      const state = await readState();
      if (!acceptsResponse(state, plan)) {
        // Storage still holds what was just read: arm from it. On failure the
        // drain reconciles from a fresh read instead.
        try { await armWake(state); progress.armed = true; } catch (_) {}
        return false;
      }
      const job = state.sync;
      let cleared = false;
      if (plan.action === "pull") {
        if (!Array.isArray(response.records) || typeof response.more !== "boolean" ||
            (response.token != null && typeof response.token !== "string")) {
          throw syncFailure("protocol", "Invalid sync response.");
        }
        const next = response.token || (response.reset ? null : plan.since);
        if (response.more && (!next || (!response.reset && next === plan.since))) {
          throw syncFailure("noProgress", "Sync did not advance its cursor.");
        }
        // Every saved change to the history is sorted, so a page that changed
        // no record leaves an order that is already sorted: skip the re-sort.
        if (mergeRemoteIntoSeen(state.seenKanji, response.records)) {
          state.seenKanji = sortSeenByCount(state.seenKanji);
        }
        state.syncToken = next;
        job.pages++;
        if (!response.more) job.stage = "push";
      } else if (plan.action === "push") {
        // Older native handlers omit confirmed and acknowledge the whole plan.
        // A new handler may leave individual failures queued for a later push.
        const confirmed = response.confirmed === undefined ? Object.keys(plan.revisions) : response.confirmed;
        if (!Array.isArray(confirmed) || confirmed.some(term =>
          !isHistoryTerm(term) || !Object.prototype.hasOwnProperty.call(plan.revisions, term))) {
          throw syncFailure("protocol", "Invalid push confirmation.");
        }
        if (confirmed.length === 0) throw syncFailure("noProgress", "Push confirmed no terms.");
        for (const term of confirmed) {
          if (state.syncQueue[term] === plan.revisions[term]) delete state.syncQueue[term];
        }
        job.sent += new Set(confirmed).size;
      } else if (plan.action === "abandonReset") {
        if (!Number.isSafeInteger(response.generation) || response.generation < 0 ||
            typeof response.completed !== "boolean") {
          throw syncFailure("protocol", "Invalid abandon response.");
        }
        if (response.completed) {
          // The zone was deleted after all, so honor the reset the user asked
          // for: the records are gone and the local copy must follow.
          wipeHistory(state);
          cleared = true;
        } else {
          // Nothing was deleted. The native journal, not this browser, decides
          // which fence the next sync must carry.
          state.generation = response.generation;
        }
        state.sync = newSyncState(false);
        if (state.syncEnabled) {
          // Sync was turned back on while the abandon was in flight: resume it
          // with every surviving term queued for the adopted generation.
          markDirty(state, Object.keys(state.seenKanji));
          requestWork(state, true);
        }
      } else {
        wipeHistory(state);
        state.sync = newSyncState(false);
        cleared = true;
      }
      state.sync.error = null;
      state.sync.attempts = 0;
      if (state.sync.requested) {
        state.sync.phase = "waiting";
        state.sync.nextAttemptAt = now() + SYNC_RECOVERY_MS;
      }
      // A finished inbound pass with nothing left to upload completes the job
      // in this same write. It is the decision the next step would otherwise
      // save separately, taken from the same state in the same dispatcher
      // turn, so a concurrent commit still either precedes it (its queued term
      // keeps the job running) or starts a new job after it. A worker killed
      // before this write repeats the step; after it, the job is complete.
      if ((plan.action === "pull" || plan.action === "push") && state.sync.requested &&
          state.sync.stage === "push" && !pushableTerms(state).length) {
        completeJob(state.sync);
      }
      await save(state);
      // The confirmed reset is the user's Clear history reaching this history.
      if (cleared) await discardRecoveryCopies();
      return true;
    });
  }

  // Records `error` of the step `plan` describes into `state` and saves it,
  // unless the saved job no longer expects that step. A save that fails is
  // rethrown with `storedRevision`, the revision of the state it could not
  // replace. Runs inside the dispatcher, on the state just read.
  async function noteFailure(state, plan, error) {
    // Recording needs a write too, and a full store can refuse it as well.
    // The caller learns which saved state the failure could not replace.
    const storedRevision = state.revision;
    const record = async () => {
      try { await save(state); }
      catch (saveError) { saveError.storedRevision = storedRevision; throw saveError; }
    };
    if (plan && !acceptsResponse(state, plan)) return;
    // Sync was turned off while this deletion was in flight. Its failure
    // belongs to the replaced intent: its backoff or stop must not hold up
    // the journal-only abandon. (A success still counts: the zone is gone.)
    if (plan && plan.action === "reset" && state.sync.stage === "abandon") return;
    const job = state.sync;
    const code = error.code || "generic";
    // The native generation a staleGeneration failure reports, if usable.
    const nativeGeneration = code === "staleGeneration" && Number.isSafeInteger(error.currentGeneration) &&
      error.currentGeneration >= 0 ? error.currentGeneration : null;
    // The user deleted this app's iCloud data in Settings. Native already
    // refused to recreate the zone (respecting that deletion), so turn sync
    // off here too instead of retrying forever: the local history is left
    // exactly as-is, and re-enabling starts a fresh pull/push lineage.
    // A pending deletion is not stopped this way: native treats that zone as
    // already gone when resetting, so the reset is simply retried below.
    if (code === "zoneDeleted" && !job.resetPending) {
      state.syncEnabled = false;
      state.syncToken = null;
      job.requested = false;
      job.phase = "idle";
      job.stage = "pull";
      job.nextAttemptAt = 0;
      job.attempts = 0;
      job.pages = 0;
      job.sent = 0;
      job.error = { code, message: error.message || "sync failed" };
      await record();
      return;
    }
    // A freshly cleared browser store can lag the native journal. With no
    // local records there is nothing stale to resurrect, so adopt its fence.
    if (nativeGeneration !== null) {
      job.nativeGeneration = nativeGeneration;
      if (!job.resetPending && !Object.keys(state.seenKanji).length && !Object.keys(state.syncQueue).length) {
        state.generation = nativeGeneration;
        job.nextAttemptAt = now() + SYNC_RECOVERY_MS;
        job.phase = "waiting";
        job.error = null;
        await record();
        return;
      }
    }
    job.error = { code, message: error.message || "sync failed" };
    if (nativeGeneration !== null) job.error.currentGeneration = nativeGeneration;
    // A restored or damaged envelope can carry a missing, negative or unsafe
    // counter; the exponent below and the saved value must both stay sane.
    const attempts = Number.isSafeInteger(job.attempts) && job.attempts > 0
      ? Math.min(job.attempts, Number.MAX_SAFE_INTEGER - 1) : 0;
    job.attempts = attempts + 1;
    const needsAction = ["account", "schema", "quota", "storageQuota", "staleGeneration", "invalidGeneration", "resetPending", "protocol", "noProgress", "pageLimit", "journal"].includes(code);
    job.phase = needsAction ? "error" : "waiting";
    const exponential = Math.min(SYNC_MAX_BACKOFF_MS, SYNC_RECOVERY_MS * 2 ** Math.min(job.attempts - 1, 5));
    const retryAfter = Number(error.retryAfter);
    // An overflowing or hostile server interval must not push the retry years
    // ahead, nor make nextAttemptAt infinite: that envelope no longer loads.
    const requested = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, SYNC_MAX_BACKOFF_MS) : 0;
    const delay = Math.min(SYNC_MAX_BACKOFF_MS, Math.max(exponential * (1 + random() * 0.2), requested));
    job.nextAttemptAt = needsAction ? 0 : now() + delay;
    await record();
  }

  // Records a failed step in one dispatcher turn, then arms the wake from
  // the state now stored (`progress.armed`). A failed record leaves the wake
  // to the drain, which must reread: the write may have committed after all.
  async function recordFailure(plan, error, progress) {
    return serialize(async () => {
      const state = await readState();
      await noteFailure(state, plan, error);
      try { await armWake(state); progress.armed = true; } catch (_) {}
    });
  }

  // Runs up to `maxSteps` steps of the saved job. The first step's read also
  // serves the due-time check, so a drain that stops there (not due, waiting
  // for the user) or cannot read at all attempted nothing: it records no
  // failure and leaves the wake as it was. Every dispatcher turn that ends
  // with a known stored state arms the wake from it (`progress.armed`); only
  // a drain that ends otherwise (step budget, failed arm or failed record)
  // reconciles the wake from a fresh read.
  async function drain(maxSteps) {
    const started = now();
    const progress = { read: false, armed: false };
    let notDue = false;
    let plan = null;
    let stalledRevision;
    try {
      for (let step = 0; step < maxSteps && now() - started < 20000; step++) {
        progress.armed = false;
        const prepared = await prepareStep(progress, step === 0);
        if (prepared === SYNC_NOT_DUE) {
          notDue = true;
          return;
        }
        plan = prepared.plan;
        if (!plan) break;
        // Recovery is armed BEFORE a request starts: a terminated worker cannot
        // rely on finally, a popup unload handler, or a JavaScript timer.
        if (prepared.armError) throw prepared.armError;
        const { revisions, cycle, ...message } = plan;
        const response = await callNative(message);
        progress.armed = false;
        // A replaced job must run on its own next wake; this invocation may
        // still hold responses intended for the discarded cycle.
        if (await acceptStep(plan, response, progress) === false) break;
      }
    } catch (error) {
      if (!progress.read) throw error;
      progress.armed = false;
      try {
        await recordFailure(plan, error, progress);
      } catch (recordError) {
        // Nothing is retried. The saved job keeps the lease prepareStep wrote,
        // so no wake repeats the step before it expires, and the recovery wake
        // is cleared rather than re-armed from it: the periodic alarm, a
        // restart or a command is the next attempt, one step at most each.
        stalledRevision = recordError.storedRevision;
        throw recordError;
      }
    } finally {
      if (progress.read && !notDue && !progress.armed) await reconcileWake(stalledRevision);
    }
  }

  function run(maxSteps = 8) {
    if (running) return running;
    running = drain(maxSteps).finally(() => { running = null; });
    return running;
  }

  // Retention of recovery copies. The first read of a valid envelope beside a
  // legacy key or the repair backup starts the period; once it has run out,
  // those copies are removed and the field dropped. The quarantine is never
  // removed here, and while it exists the period neither starts nor ends: it
  // resumes untouched once the quarantine is gone. A start in the future (the
  // clock moved back) counts from now, so it neither deletes early nor waits
  // forever. This never fails or blocks a command: an error keeps the field
  // for the next maintenance. Its own writes free nothing: bookkeeping is no
  // reason to cut a period short.
  // Runs inside the dispatcher on `state`, the envelope just read or saved by
  // the caller's turn, and never throws. After a failed save `state` gets its
  // revision and retention field back, so the caller still holds the last
  // envelope known to be stored (its sync job is never touched here).
  async function maintainRecoveryCopies(state) {
    const revision = state.revision;
    const since = state.recoveryRetainedSince;
    try {
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) return;
      if (since !== undefined && since <= current && current - since < RECOVERY_RETENTION_MS) return;
      const present = await presentKeys([...recoveryKeys, KANJI_STATE_QUARANTINE_KEY]);
      if (present.includes(KANJI_STATE_QUARANTINE_KEY)) return;
      if (since === undefined) {
        if (!present.length) return;
        state.recoveryRetainedSince = current;
      } else if (since > current) {
        state.recoveryRetainedSince = current;
      } else {
        if (present.length) await removeKeys(present);
        delete state.recoveryRetainedSince;
      }
      await save(state, []);
    } catch (_) {
      state.revision = revision;
      if (since === undefined) delete state.recoveryRetainedSince;
      else state.recoveryRetainedSince = since;
    }
  }

  // Startup and recovery alarm: loads (or migrates) the envelope, runs the
  // retention maintenance and reconciles the wake, all in one dispatcher turn
  // on one read. Rejects if the envelope cannot be read or the wake cannot be
  // scheduled; maintenance failures are kept for its next run.
  async function restore() {
    return serialize(async () => {
      const state = await readState();
      await maintainRecoveryCopies(state);
      await armWake(state);
      return state;
    });
  }

  // Periodic alarm: arms an inbound pass when sync is on and idle, then does
  // what restore does, in the same dispatcher turn and on the same read. The
  // arming is saved before anything else, as its own durable request.
  async function requestPeriodic() {
    return serialize(async () => {
      const state = await readState();
      if (!state.sync.requested && state.syncEnabled && nativeAvailable) {
        requestWork(state, false);
        await save(state);
      }
      await maintainRecoveryCopies(state);
      await armWake(state);
      return state;
    });
  }

  return { command, run, restore, requestPeriodic };
}
