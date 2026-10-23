// Product invariants exercise the actual coordinator and disk envelope,
// without CloudKit credentials, browser state, timers, or live network calls.
async function contaminatedFixture() {
  const f = fixture({}, { aliasReads: true });
  await f.coordinator.restore();
  const polluted = { "保存": 9, "accepted-command": { added: 1 } };
  Object.assign(f.disk.kanjiState, {
    revision: 9, generation: 3, syncToken: "retained-cursor", syncEnabled: true,
    seenKanji: { "保存": { count: 5, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "local-url" } },
    syncQueue: copy(polluted), completedCommands: copy(polluted),
  });
  Object.assign(f.disk.kanjiState.sync, { requested: true, phase: "waiting", stage: "push" });
  return f;
}

// A deletion the cloud refuses: the intent is durable, the job stopped at an
// error no automatic wake retries, and every save stays blocked meanwhile.
async function stuckResetFixture() {
  const f = fixture();
  await f.enable();
  await f.command("commitTerms", { terms: [record("学校", 4)] });
  await f.drain();
  await f.command("clearHistory", {}, "stuck-clear");
  f.native = async () => ({ ok: false, code: "account", error: "sign in required" });
  await f.coordinator.run();
  check(f.state().sync.resetPending, "the reset intent is durable");
  equal(f.state().sync.phase, "error", "a refused reset waits for the user");
  return f;
}

// An envelope no command can read, with recoverable fields worth carrying over.
async function unreadableFixture(legacy) {
  const f = fixture(legacy);
  await f.coordinator.restore();
  await f.command("setPreferences", { newOnlyEnabled: true, extractMode: "all-words" });
  f.disk.kanjiState.generation = 4;
  f.disk.kanjiState.syncQueue["unmatched-command"] = { added: 1 };
  return f;
}

const DAY = 86400000;
const RETENTION = 30 * DAY;
const LEGACY_COPIES = ["seenKanji", "newOnlyEnabled", "extractMode", "syncEnabled", "syncQueue", "syncToken", "syncLock"];

function legacyHistory(size) {
  const seen = {};
  for (let index = 0; index < (size || 1); index++) {
    seen["旧語" + index] = { count: index + 1, firstSeen: "2026-06-01", lastSeen: "2026-06-02", firstUrl: "legacy" };
  }
  return seen;
}
function bigPage(prefix, size) {
  return Array.from({ length: size || 20 }, (_, index) => record(prefix + index, 2));
}
function presentCopies(f) {
  return [...LEGACY_COPIES, "kanjiStateRepairBackup", "kanjiStateQuarantine"]
    .filter(key => Object.prototype.hasOwnProperty.call(f.disk, key));
}
// Refuse the next envelope write as a full store would, whatever its size.
function refuseNextEnvelope(f) {
  f.beforeWrite = async (patch) => {
    if (patch.kanjiState) { f.beforeWrite = null; throw f.quotaError(); }
  };
}

// A migrated installation: legacy keys (including the old sync lock) and a
// repair backup beside a valid envelope. Cases add a quarantine explicitly.
async function recoveryFixture(options, size) {
  const f = fixture({ seenKanji: legacyHistory(size), syncToken: "legacy-cursor", newOnlyEnabled: true,
    syncLock: { owner: "popup", ts: 1, tag: "legacy-lock" } }, options);
  await f.coordinator.restore();
  f.disk.kanjiStateRepairBackup = JSON.stringify({ retained: "repair backup", seenKanji: legacyHistory(size) });
  return f;
}
function quarantine(f) {
  f.disk.kanjiStateQuarantine = JSON.stringify({ retained: "only copy" });
}

(async function () {
  // A partial native acknowledgement must preserve only the unconfirmed
  // revisions; an older native reply without the field confirms the batch.
  await test("push removes only confirmed terms and retains older native compatibility", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校"), record("日本")] });
    f.native = async message => message.action === "pull" ? page() :
      ({ ok: true, confirmed: [message.terms[0].term] });
    await f.coordinator.run(2);
    equal(Object.keys(f.state().syncQueue).length, 1, "one unconfirmed revision remains queued");
    f.native = async message => message.action === "pull" ? page() : ({ ok: true });
    await f.drain();
    equal(f.state().syncQueue, {}, "an older native acknowledgement clears its sent batch");
  });

  // An all-failed native batch must stop the current job instead of retrying
  // the same unchanged terms within one drain cycle.
  await test("empty push confirmation stops with noProgress", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校")] });
    f.native = async message => message.action === "pull" ? page() : ({ ok: true, confirmed: [] });
    await f.coordinator.run(8);
    equal(f.state().sync.phase, "error", "a zero-progress push stops");
    equal(f.state().sync.error.code, "noProgress", "the failure is actionable");
    equal(Object.keys(f.state().syncQueue), ["学校"], "the failed term stays queued");
  });

  // Imported and freshly committed terms share the wire's code point ceiling.
  await test("overlong terms are rejected by commit and import", async () => {
    const f = fixture();
    await f.coordinator.restore();
    const longTerm = "語".repeat(65);
    const decomposed = "か\u3099".repeat(64);
    await f.command("commitTerms", { terms: [record(longTerm)] });
    await f.command("importHistory", { incoming: { [longTerm]: { count: 2 }, [decomposed]: { count: 2 } } });
    check(!Object.prototype.hasOwnProperty.call(f.state().seenKanji, longTerm), "overlong term was stored");
    check(!Object.prototype.hasOwnProperty.call(f.state().seenKanji, decomposed.normalize("NFC")),
      "an overlong decomposed import was stored after normalization");
  });

  // Command receipts retain their established 128-code-unit identifier limit
  // even though vocabulary terms now have a stricter length limit.
  await test("a long valid command identifier remains accepted", async () => {
    const f = fixture();
    await f.coordinator.restore();
    const id = "command-" + "x".repeat(70);
    await f.command("commitTerms", { terms: [record("学校")] }, id);
    check(!!f.state().completedCommands[id], "the long receipt identifier was preserved");
  });
  await test("R6 invalid merge fields are ignored independently and valid fields repair storage", async () => {
    const seen = { "日本": { count: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "local" } };
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 1e308, firstSeen: "01/09/2026", lastSeen: "zzzz" }]);
    equal(seen["日本"], { count: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "local" }, "invalid fields do not poison valid storage");
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 5, firstSeen: "2026-02-30", lastSeen: "2026-09-20" }]);
    equal(seen["日本"], { count: 5, firstSeen: "2026-09-01", lastSeen: "2026-09-20", firstUrl: "local" }, "valid fields merge despite an invalid date");
    seen["日本"] = { count: 1e308, firstSeen: "zzzz", lastSeen: "01/09/2026", firstUrl: "local" };
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 7, firstSeen: "2026-08-01", lastSeen: "2026-09-21" }]);
    equal(seen["日本"], { count: 7, firstSeen: "2026-08-01", lastSeen: "2026-09-21", firstUrl: "local" }, "valid incoming fields replace invalid stored fields");
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 1000001, firstSeen: "", lastSeen: "" }]);
    equal(seen["日本"].count, 1000000, "large safe counts clamp to the shared ceiling");
    for (const count of [-1, 1.5, "8", Number.MAX_SAFE_INTEGER + 1]) {
      mergeRemoteIntoSeen(seen, [{ term: "日本", count, firstSeen: "2026-07-01", lastSeen: "" }]);
      equal(seen["日本"].count, 1000000, "invalid count leaves the other fields intact");
      equal(seen["日本"].firstSeen, "2026-07-01", "valid date merges beside an invalid count");
    }
    const imported = {};
    importIntoHistory(imported, { "輸入": { count: 1e308, firstSeen: "2026-02-30", lastSeen: "2026-09-07" } });
    equal(imported["輸入"].count, 1, "invalid imported count falls back to one sighting");
    equal(imported["輸入"].lastSeen, "2026-09-07", "valid import date survives invalid sibling fields");
  });

  await test("D6 new saves use the local calendar day across midnight", async () => {
    const f = fixture();
    await f.coordinator.restore();
    const before = new Date(2026, 8, 7, 23, 59);
    const after = new Date(before.getTime() + 2 * 60000);
    // Compute the expected day from local getters on this test machine.
    const local = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    f.advance(before.getTime() - f.now());
    await f.command("commitTerms", { terms: [record("前日")] });
    f.advance(after.getTime() - f.now());
    await f.command("commitTerms", { terms: [record("翌日")] });
    equal(f.state().seenKanji["前日"].firstSeen, local(before), "before midnight uses local components");
    equal(f.state().seenKanji["翌日"].firstSeen, local(after), "after midnight uses local components");
    check(local(before) !== local(after), "dates cross a local calendar boundary");
  });

  await test("R1 a corrected clock makes a far future retry due", async () => {
    const f = fixture();
    await f.enable();
    f.advance(365 * DAY);
    f.native = async () => ({ ok: false, code: "network", error: "offline" });
    await f.coordinator.run();
    f.advance(-365 * DAY);
    const before = f.nativeCalls.length;
    f.native = async message => message.action === "pull" ? page() : { ok: true };
    await f.command("commitTerms", { terms: [record("新語", 3)] });
    await f.coordinator.requestPeriodic();
    const wake = f.wakes[f.wakes.length - 1];
    check(wake >= f.now() && wake - f.now() <= SYNC_MAX_BACKOFF_MS,
      "the pending job receives a near-term recovery alarm");
    await f.coordinator.run();
    check(f.nativeCalls.length > before, "queued work resumes after the clock correction");
  });

  await test("R4 quarantine uses a fresh cycle and rejects an old pull page", async () => {
    const f = fixture();
    await f.enable();
    const entered = deferred(), response = deferred();
    let calls = 0;
    f.native = async () => ++calls === 1 ? page([record("頁一", 2)], "T1", true) : (entered.resolve(), response.promise);
    const running = f.coordinator.run(8);
    await entered.promise;
    const oldCycle = f.state().sync.cycle;
    f.disk.kanjiState.seenKanji = "damaged";
    await f.command("clearHistory", {}, "escape");
    await f.command("setSyncEnabled", { enabled: true }, "re-enable");
    check(f.state().sync.cycle > oldCycle, "new job cycle advances beyond the old one");
    response.resolve(page([record("頁二", 2)], "T2", false));
    await running;
    equal(f.state().syncToken, null, "stale page does not skip the first page of the new job");
    f.native = async message => message.action === "pull"
      ? page([record("頁一", 2)], "fresh-cursor", false) : { ok: true };
    await f.drain();
    equal(Object.keys(f.state().seenKanji), ["頁一"], "a fresh pull keeps page one and rejects stale page two");
  });

  await test("quarantine on a fresh coordinator uses the damaged envelope's safe revision", async () => {
    const f = await unreadableFixture();
    const previous = f.state().revision;
    f.restart();
    await f.command("clearHistory", {}, "fresh-escape");
    equal(f.state().revision, previous + 1, "unreadable envelope supplies the revision after restart");
  });

  await test("R7 adopting the native generation keeps history and uploads every term", async () => {
    const f = fixture();
    await f.coordinator.restore();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.command("setSyncEnabled", { enabled: true });
    f.native = async () => ({ ok: false, code: "staleGeneration", currentGeneration: 3, error: "stale" });
    await f.coordinator.run();
    await f.command("adoptNativeGeneration");
    equal(f.state().generation, 3, "native generation adopted");
    equal(f.state().syncQueue["学校"], f.state().revision, "every local term requeued at the new revision");
    f.native = async message => message.action === "pull" ? page() : { ok: true };
    const before = f.nativeCalls.length;
    await f.drain();
    const resumed = f.nativeCalls.slice(before);
    check(resumed.length > 0 && resumed.every(message => message.generation === 3 && message.action !== "reset"), "recovery uses the adopted generation without reset");
    check(resumed.some(message => message.action === "push" && message.terms.some(term => term.term === "学校")), "local terms are pushed");
    equal(Object.keys(f.state().seenKanji), ["学校"], "history remains intact");
  });

  await test("adopting a native generation requires an actionable stale error", async () => {
    const f = fixture();
    await f.coordinator.restore();
    await rejects(() => f.command("adoptNativeGeneration"), "notStale");
    await f.command("setSyncEnabled", { enabled: true });
    f.native = async () => ({ ok: false, code: "staleGeneration", currentGeneration: -1, error: "stale" });
    await f.coordinator.run();
    await rejects(() => f.command("adoptNativeGeneration"), "notStale");
  });

  await test("remote merge retains dates, maxima and the local URL", async () => {
    const seen = { "日本": { count: 2, firstSeen: "2026-09-02",
      lastSeen: "2026-09-03", firstUrl: "https://example.jp/" } };
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 5, firstSeen: "2026-09-01",
      lastSeen: "2026-09-07", firstUrl: "https://remote.example/" }]);
    equal(seen["日本"], { count: 5, firstSeen: "2026-09-01",
      lastSeen: "2026-09-07", firstUrl: "https://example.jp/" }, "merged record");
  });

  await test("malformed remote terms do not mutate object prototypes", async () => {
    const seen = {};
    mergeRemoteIntoSeen(seen, [
      { term: ["__proto__"], count: 99 }, { term: { value: "学校" }, count: 99 },
      { term: "__proto__", count: 99 }, { term: "constructor", count: 99 },
      { term: "prototype", count: 99 }, { term: null, count: 99 },
    ]);
    equal(Object.keys(seen), [], "malformed records are rejected");
    equal(Object.prototype.hasOwnProperty.call(Object.prototype, "count"), false,
      "Object.prototype stays unchanged");
  });

  await test("an inherited property name becomes an own history entry", async () => {
    const seen = {};
    mergeRemoteIntoSeen(seen, [record("toString", 2)]);
    equal(Object.keys(seen), ["toString"], "own record inserted");
    equal(seen.toString.count, 2, "own count stored");
    equal(Object.prototype.hasOwnProperty.call(Object.prototype.toString, "count"), false,
      "prototype method stays unchanged");
  });

  await test("migration saves one envelope and retains legacy history", async () => {
    const old = { count: 7, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "local" };
    const f = fixture({ seenKanji: { "学校": old }, syncQueue: { "学校": true },
      syncEnabled: true, syncToken: "legacy-cursor", extractMode: "all-words", newOnlyEnabled: true });
    await f.coordinator.restore();
    const state = f.state();
    equal(state.schemaVersion, 2, "current schema");
    equal(state.seenKanji["学校"], old, "legacy term retained");
    equal(state.syncToken, "legacy-cursor", "legacy resume cursor retained");
    check(Number.isSafeInteger(state.syncQueue["学校"]) && state.syncQueue["学校"] > 0,
      "legacy dirty flag receives a revision");
    equal(state.newOnlyEnabled, true, "legacy preference retained");
    equal(state.extractMode, "all-words", "legacy mode retained");
    equal(f.nativeCalls, [], "restore never invokes native code");
    check(f.writes.every(patch => Object.keys(patch).length === 1 && patch.kanjiState),
      "each write updates one complete envelope");
  });

  await test("an empty current history never resurrects retained legacy keys", async () => {
    const f = fixture({ seenKanji: { "学校": { count: 5 } } }, { nativeAvailable: false });
    await f.coordinator.restore();
    // A refused removal is how a confirmed clear can leave the old keys behind.
    f.failNextRemove();
    await f.command("clearHistory");
    check(Object.keys(f.disk.seenKanji || {}).length > 0, "fixture retains the old keys");
    f.restart();
    await f.coordinator.restore();
    equal(f.state().seenKanji, {}, "current empty history is authoritative");
  });

  await test("future schema is preserved rather than overwritten or remigrated", async () => {
    const f = fixture({ kanjiState: { schemaVersion: 999, retained: "future data" },
      seenKanji: { "学校": { count: 5 } } });
    const original = copy(f.disk);
    await rejects(() => f.coordinator.restore(), "storageSchema");
    equal(f.disk, original, "unrecognized schema remains untouched");
    equal(f.nativeCalls, [], "invalid storage never starts sync");
  });

  await test("failed migration leaves the legacy data available for retry", async () => {
    const f = fixture({ seenKanji: { "学校": { count: 5 } } });
    f.failNextWrite();
    await rejects(() => f.coordinator.restore());
    equal(f.disk.seenKanji, { "学校": { count: 5 } }, "old history preserved");
    check(!f.disk.kanjiState, "failed write did not invent a committed envelope");
    f.restart();
    await f.coordinator.restore();
    equal(f.state().seenKanji["学校"].count, 5, "migration succeeds after restart");
  });

  await test("local-only history and preferences work without native calls", async () => {
    const f = fixture({}, { nativeAvailable: false });
    await f.coordinator.restore();
    await f.command("commitTerms", { terms: [record("日本", 3)], url: "https://example.jp" });
    await f.command("setPreferences", { newOnlyEnabled: true, extractMode: "all-words" });
    await f.command("importHistory", { incoming: { "学校": { count: 4,
      firstSeen: "2026-09-02", lastSeen: "2026-09-06", firstUrl: "imported" } } });
    await f.coordinator.run();
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "日本"].sort(), "both local sources retained");
    equal(f.state().newOnlyEnabled, true, "preference stored");
    equal(f.nativeCalls, [], "no calls to unavailable native backend");
    await f.command("clearHistory");
    equal(f.state().seenKanji, {}, "local clear succeeds");
  });

  await test("command replay after a lost response does not reapply old settings", async () => {
    const f = fixture();
    await f.coordinator.restore();
    await f.command("setPreferences", { newOnlyEnabled: true }, "lost-reply");
    f.restart();
    await f.coordinator.restore();
    await f.command("setPreferences", { newOnlyEnabled: false }, "later-preference");
    await f.command("setPreferences", { newOnlyEnabled: true }, "lost-reply");
    equal(f.state().newOnlyEnabled, false, "replay cannot revert a newer command");
  });

  await test("failed commit does not leak an unpersisted term into later writes", async () => {
    const f = fixture();
    await f.enable();
    f.failNextWrite();
    await rejects(() => f.command("commitTerms", { terms: [record("失敗")] }));
    await f.command("commitTerms", { terms: [record("成功")] });
    equal(Object.keys(f.state().seenKanji), ["成功"], "only acknowledged commit is present");
    equal(Object.keys(f.state().syncQueue), ["成功"], "only acknowledged term is queued");
  });

  await test("ambiguous storage acknowledgement is reread before the next mutation", async () => {
    const f = fixture();
    await f.enable();
    f.failNextWrite("after");
    await rejects(() => f.command("commitTerms", { terms: [record("先行")] }, "ambiguous-commit"));
    await f.command("commitTerms", { terms: [record("後続")] });
    equal(Object.keys(f.state().seenKanji).sort(), ["先行", "後続"].sort(),
      "later write retains the commit whose acknowledgement was lost");
    equal(Object.keys(f.state().syncQueue).sort(), ["先行", "後続"].sort(),
      "both revisions remain queued");
  });

  await test("page and cursor survive restart and continue at the saved cursor", async () => {
    const f = fixture();
    await f.enable();
    f.native = async (message) => {
      equal(message.action, "pull", "first action receives changes");
      equal(message.since, null, "initial cursor");
      return page([record("学校")], "saved-page", true);
    };
    await f.coordinator.run(1);
    equal(f.state().syncToken, "saved-page", "cursor committed");
    equal(f.state().seenKanji["学校"].count, 2, "same page committed");
    f.restart();
    await f.coordinator.restore();
    equal(f.nativeCalls.length, 1, "restore performs no native work");
    f.native = async (message) => {
      equal(message.since, "saved-page", "restart resumes from saved page");
      return page([record("日本")], "final-page", false);
    };
    await f.drain();
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "日本"].sort(), "all pages retained");
    equal(f.state().syncToken, "final-page", "final cursor committed");
  });

  await test("failed page checkpoint never advances past uncommitted records", async () => {
    const f = fixture({ syncToken: "previous", syncEnabled: true });
    await f.coordinator.restore();
    f.native = async () => {
      f.failNextWrite();
      return page([record("学校")], "uncommitted-page", false);
    };
    await f.coordinator.run(1);
    equal(f.state().syncToken, "previous", "cursor remains before failed page");
    check(!f.state().seenKanji["学校"], "failed page did not leak into the failure-state write");
    equal(f.state().sync.lastSuccessAt, null, "failed persistence is not completed sync");
    f.restart();
    await f.coordinator.restore();
    f.native = async (message) => {
      equal(message.since, "previous", "retry requests the uncommitted page again");
      return page([record("学校")], "uncommitted-page", false);
    };
    await f.drain();
    equal(f.state().seenKanji["学校"].count, 2, "retried page is present");
  });

  await test("confirmed native push is safely retried when its local checkpoint fails", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    const remote = {};
    let pushes = 0;
    f.native = async (message) => {
      if (message.action === "pull") return page();
      pushes++;
      mergeRemoteIntoSeen(remote, message.terms);
      f.failNextWrite();
      return { ok: true };
    };
    await f.coordinator.run(2);
    equal(pushes, 1, "server accepted the first push");
    equal(Object.keys(f.state().syncQueue), ["学校"], "uncheckpointed acknowledgement stays queued");
    f.restart();
    await f.coordinator.restore();
    f.native = async (message) => {
      equal(message.action, "push", "retry retains push stage");
      pushes++;
      mergeRemoteIntoSeen(remote, message.terms);
      return { ok: true };
    };
    await f.drain();
    equal(pushes, 2, "uncertain acknowledgement is retried");
    equal(Object.keys(remote), ["学校"], "retry does not duplicate the logical record");
    equal(remote["学校"].count, 4, "retry does not add occurrences twice");
    equal(f.state().syncQueue, {}, "successful retry is checkpointed");
  });

  await test("zone reset during pull does not requeue old local history", async () => {
    const f = fixture({ seenKanji: { "学校": { count: 4 } },
      syncToken: "expired", syncEnabled: true, syncQueue: {} });
    await f.coordinator.restore();
    f.native = async (message) => {
      equal(message.action, "pull", "old history must not be pushed after remote reset");
      return { ok: true, records: [], token: "new-lineage", more: false, reset: true };
    };
    await f.drain();
    equal(f.state().syncToken, "new-lineage", "new cursor adopted");
    equal(f.state().syncQueue, {}, "old local terms remain unqueued");
    equal(f.state().seenKanji["学校"].count, 4, "local-only history remains available");
  });

  await test("a bounded run schedules continuation while more pages remain", async () => {
    const f = fixture();
    await f.enable();
    let pages = 0;
    f.native = async () => page([], "page-" + (++pages), true);
    await f.coordinator.run(3);
    equal(pages, 3, "native work respects the step budget");
    check(f.state().sync.requested, "unfinished work remains requested");
    equal(f.state().sync.lastSuccessAt, null, "unfinished pull is not successful");
    check(f.wakes.length > 0, "continuation wake is scheduled");
    check(f.state().sync.nextAttemptAt > f.now(), "continuation has a durable deadline");
  });

  await test("each confirmed push group is checkpointed before the next group", async () => {
    const f = fixture();
    await f.enable();
    const terms = Array.from({ length: 405 }, (_, index) => record("語" + index));
    await f.command("commitTerms", { terms });
    let groups = 0;
    f.native = async (message) => {
      if (message.action === "pull") return page();
      groups++;
      equal(message.terms.length, groups === 1 ? 400 : 5, "bounded push size");
      if (groups === 2) {
        equal(Object.keys(f.state().syncQueue).length, 5, "first group already removed from queue");
        return { ok: false, code: "network", error: "offline" };
      }
      return { ok: true };
    };
    await f.coordinator.run(8);
    equal(groups, 2, "second group attempted");
    equal(Object.keys(f.state().syncQueue).length, 5, "only unconfirmed group remains queued");
    f.restart();
    await f.coordinator.restore();
    f.native = async (message) => {
      equal(message.action, "push", "restart retains the push phase");
      equal(message.terms.length, 5, "restart sends only unconfirmed records");
      return { ok: true };
    };
    await f.drain();
    equal(f.state().syncQueue, {}, "remaining group confirmed");
    check(f.state().sync.lastSuccessAt !== null, "final completion recorded");
  });

  await test("a failed later page preserves the earlier committed cursor", async () => {
    const f = fixture();
    await f.enable();
    let calls = 0;
    f.native = async () => ++calls === 1 ? page([record("学校")], "saved", true)
      : { ok: false, code: "network", error: "offline" };
    await f.coordinator.run(8);
    equal(f.state().syncToken, "saved", "cursor retained on failure");
    equal(f.state().seenKanji["学校"].count, 2, "received term retained on failure");
    equal(f.state().sync.lastSuccessAt, null, "failure cannot report completed sync");
  });

  await test("unchanged cursor cannot silently finish or discard queued terms", async () => {
    const f = fixture({ syncToken: "stalled", syncEnabled: true });
    await f.coordinator.restore();
    await f.command("commitTerms", { terms: [record("学校")] });
    f.native = async () => page([], "stalled", true);
    await f.coordinator.run(8);
    equal(f.state().syncToken, "stalled", "cursor retained");
    equal(Object.keys(f.state().syncQueue), ["学校"], "pending local record retained");
    equal(f.state().sync.lastSuccessAt, null, "stalled pull never reports success");
    check(!!f.state().sync.error, "no progress has a visible error");
  });

  await test("server retryAfter survives restart and blocks premature automatic retry", async () => {
    const f = fixture();
    await f.enable();
    const before = f.now();
    f.native = async () => ({ ok: false, code: "network", error: "retry later", retryAfter: 120 });
    await f.coordinator.run();
    check(f.state().sync.nextAttemptAt >= before + 120000, "server retry interval honored");
    const calls = f.nativeCalls.length;
    f.restart();
    await f.coordinator.restore();
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.length, calls, "restart and periodic wake respect backoff");
    f.native = async () => page();
    await f.drain();
    check(f.state().sync.lastSuccessAt !== null, "retry eventually completes");
  });

  await test("an explicit retry can bypass backoff after the user fixes a problem", async () => {
    const f = fixture();
    await f.enable();
    f.native = async () => ({ ok: false, code: "account", error: "sign in required" });
    await f.coordinator.run();
    const failedCalls = f.nativeCalls.length;
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.length, failedCalls, "automatic wake does not hammer an account error");
    f.native = async () => page();
    await f.command("syncNow");
    await f.coordinator.run();
    check(f.nativeCalls.length > failedCalls, "manual retry reaches native backend");
    check(f.state().sync.lastSuccessAt !== null, "manual retry may complete");
  });

  await test("a zone the user deleted in Settings turns sync off without touching history", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校")] });
    const seenBefore = f.state().seenKanji;
    const queueBefore = f.state().syncQueue;
    f.native = async () => ({ ok: false, code: "zoneDeleted", error: "zone deleted" });
    await f.coordinator.run();
    equal(f.state().syncEnabled, false, "sync turns itself off — the zone lineage is gone");
    equal(f.state().syncToken, null, "the old cursor cannot describe a new lineage");
    equal(f.state().sync.error.code, "zoneDeleted", "the reason is surfaced to the popup");
    equal(f.state().sync.phase, "idle", "this is not a retryable failure");
    equal(f.state().sync.stage, "pull", "a later re-enable starts by reading changes");
    equal(f.state().seenKanji, seenBefore, "local history is left exactly as-is");
    equal(f.state().syncQueue, queueBefore, "the dirty queue is left exactly as-is");
    const callsBeforeReenable = f.nativeCalls.length;
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.length, callsBeforeReenable, "no automatic retry against a zone that stays gone");

    // Re-enabling needs no new code: setSyncEnabled(true) already marks every
    // term dirty and clears the error; syncToken being null makes the next
    // pull start from scratch, and native recreates the zone on its own.
    await f.command("setSyncEnabled", { enabled: true });
    equal(f.state().sync.error, null, "re-enabling clears the previous error");
    equal(Object.keys(f.state().syncQueue).sort(), Object.keys(seenBefore).sort(), "every known term is queued again");
    let firstCallAfterReenable = null;
    f.native = async (message) => {
      if (!firstCallAfterReenable) firstCallAfterReenable = copy(message);
      return message.action === "pull" ? page() : { ok: true };
    };
    await f.drain();
    equal(firstCallAfterReenable.action, "pull", "sync restarts by reading changes");
    equal(firstCallAfterReenable.since, null, "the pull carries no token — a fresh lineage");
  });

  await test("accountTemporarilyUnavailable retries automatically instead of stopping sync", async () => {
    const f = fixture();
    await f.enable();
    const before = f.now();
    f.native = async () => ({ ok: false, code: "accountTemporary", error: "temporarily unavailable" });
    await f.coordinator.run();
    equal(f.state().syncEnabled, true, "a transient account state does not turn sync off");
    equal(f.state().sync.phase, "waiting", "the failure is retried automatically, not left needing user action");
    check(f.state().sync.nextAttemptAt > before, "a retry is scheduled in the future");
    check(f.state().sync.nextAttemptAt <= before + 30 * 60000, "the retry is capped at the max backoff (30 min)");
  });

  await test("sync disabled during a pull stops later requests", async () => {
    const f = fixture();
    await f.enable();
    const entered = deferred(), response = deferred();
    f.native = async () => { entered.resolve(); return response.promise; };
    const running = f.coordinator.run(8);
    await entered.promise;
    await f.command("setSyncEnabled", { enabled: false });
    response.resolve(page([], "received-before-disable", true));
    await running;
    equal(f.nativeCalls.length, 1, "no next page after disabling sync");
    equal(f.state().syncEnabled, false, "preference remains disabled");
  });

  await test("pending reset preserves history and blocks new saves until confirmed", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校")] });
    const generation = f.state().generation;
    await f.command("clearHistory", {}, "reset-request");
    check(f.state().generation > generation, "reset advances generation");
    equal(Object.keys(f.state().seenKanji), ["学校"], "history retained until cloud confirms");
    check(f.state().sync.resetPending, "reset intent is durable");
    await rejects(() => f.command("commitTerms", { terms: [record("新規")] }), "resetPending");
    await rejects(() => f.command("importHistory", { incoming: { "新規": { count: 4 } } }), "resetPending");
    f.native = async (message) => {
      equal(message.action, "reset", "reset runs before pull or push");
      return { ok: true };
    };
    await f.drain();
    equal(f.state().seenKanji, {}, "confirmed reset clears history");
    equal(f.state().syncQueue, {}, "confirmed reset clears dirty queue");
    equal(f.state().syncToken, null, "confirmed reset clears old cursor");
  });

  await test("repeated clear during a pending reset preserves its generation", async () => {
    const f = fixture();
    await f.enable();
    await f.command("clearHistory", {}, "first-clear");
    const generation = f.state().generation;
    await f.command("clearHistory", {}, "second-clear");
    equal(f.state().generation, generation, "one pending reset keeps one generation");
    f.restart();
    await f.coordinator.restore();
    f.native = async (message) => {
      equal(message.generation, generation, "restart reuses pending reset generation");
      return { ok: true };
    };
    await f.drain();
  });

  await test("explicit reset retry advances past a newer native generation", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校")] });
    await f.command("clearHistory");
    equal(f.state().generation, 1, "first reset generation");
    f.native = async (message) => {
      equal(message.action, "reset", "reset attempt");
      return { ok: false, code: "staleGeneration", currentGeneration: 3,
        error: "Native reset journal is ahead of local history" };
    };
    await f.coordinator.run();
    check(f.state().sync.resetPending, "rejected reset stays pending");
    equal(f.state().sync.error.code, "staleGeneration", "native mismatch is visible");
    equal(Object.keys(f.state().seenKanji), ["学校"], "rejected reset retains history");
    await f.command("syncNow");
    equal(f.state().generation, 4, "explicit retry fences beyond native generation");
    equal(Object.keys(f.state().seenKanji), ["学校"], "retry keeps history until confirmation");
    f.native = async (message) => {
      equal(message.action, "reset", "retry still performs reset");
      equal(message.generation, 4, "new native reset generation");
      return { ok: true };
    };
    await f.drain();
    equal(f.state().seenKanji, {}, "acknowledged reset clears history");
  });

  await test("replaying an acknowledged clear cannot erase newer saved terms", async () => {
    const f = fixture({}, { nativeAvailable: false });
    await f.coordinator.restore();
    await f.command("clearHistory", {}, "lost-clear-response");
    await f.command("commitTerms", { terms: [record("保存")] });
    f.restart();
    await f.coordinator.restore();
    await f.command("clearHistory", {}, "lost-clear-response");
    equal(Object.keys(f.state().seenKanji), ["保存"], "replayed clear is not executed again");
  });

  await test("generation overflow fails without making history unreadable", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("保存")] });
    f.disk.kanjiState.generation = Number.MAX_SAFE_INTEGER;
    await rejects(() => f.command("clearHistory"), "invalidGeneration");
    const response = await f.command("getState");
    equal(response.state.generation, Number.MAX_SAFE_INTEGER, "valid original fence retained");
    check(!!response.state.seenKanji["保存"], "history remains readable and exportable");
  });

  await test("damaged queue revisions fail without replacing stored history", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("保存")] });
    f.disk.kanjiState.syncQueue["保存"] = "damaged";
    const original = copy(f.disk);
    await rejects(() => f.command("getState"), "storageSchema");
    equal(f.disk, original, "damaged data is preserved for recovery");
  });

  await test("equal empty queue and receipts returned by storage remain independent on commit", async () => {
    const f = fixture({ seenKanji: { "以前": { count: 3 } }, syncEnabled: true }, { aliasReads: true });
    await f.coordinator.restore();
    await f.drain();
    check(f.state().sync.lastSuccessAt !== null, "initial sync has completed");
    const decoded = (await f.storageGet(["kanjiState"])).kanjiState;
    check(decoded.syncQueue === decoded.completedCommands, "fixture actually aliases equal empty dictionaries");
    const terms = Array.from({ length: 27 }, (_, index) => record("語" + index, index + 1));
    await f.command("commitTerms", { terms }, "alias-commit");
    const state = (await f.command("getState")).state;
    equal(Object.keys(state.syncQueue).sort(), terms.map(term => term.term).sort(), "queue contains only vocabulary revisions");
    equal(state.completedCommands, { "alias-commit": { added: 27 } }, "receipts contain only accepted command information");
    equal(Object.keys(state.seenKanji).length, 28, "all saved and existing terms remain readable");
  });

  await test("equal empty history, queue and receipts cannot contaminate each other", async () => {
    const f = fixture({}, { aliasReads: true });
    await f.coordinator.restore();
    const decoded = (await f.storageGet(["kanjiState"])).kanjiState;
    check(decoded.seenKanji === decoded.syncQueue && decoded.syncQueue === decoded.completedCommands,
      "fixture aliases all three empty dictionaries");
    await f.command("setPreferences", { newOnlyEnabled: true }, "empty-preference");
    const state = (await f.command("getState")).state;
    equal(state.seenKanji, {}, "a preference change cannot insert a command into history");
    equal(state.syncQueue, {}, "a preference change cannot insert a command into the queue");
    equal(state.completedCommands, { "empty-preference": { added: 0 } }, "receipt has its own dictionary");
    equal(state.newOnlyEnabled, true, "preference was saved");
  });

  await test("nonempty matching history records retain independent counts", async () => {
    const old = { count: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-02", firstUrl: "same-source" };
    const f = fixture({ seenKanji: { "学校": old, "日本": old } }, { aliasReads: true });
    await f.coordinator.restore();
    f.disk.kanjiState.completedCommands = { "earlier-command": { added: 0 } };
    const decoded = (await f.storageGet(["kanjiState"])).kanjiState;
    check(decoded.seenKanji["学校"] !== decoded.seenKanji["日本"], "fixture preserves distinct nonempty records");
    await f.command("commitTerms", { terms: [record("学校", 9)] });
    const state = (await f.command("getState")).state;
    equal(state.seenKanji["学校"].count, 9, "target term updated");
    equal(state.seenKanji["日本"], old, "other term retains its count and encounter dates");
  });

  await test("matching contaminated queue and receipts repair the observed 27-term pattern", async () => {
    const f = fixture({}, { aliasReads: true });
    await f.coordinator.restore();
    const commandID = "mtqx59af:jc784s05l4:5";
    const terms = Array.from({ length: 27 }, (_, index) => record("語" + index, index + 1));
    const seen = { "以前": { count: 99, firstSeen: "2020-01-01", lastSeen: "2026-09-06", firstUrl: "retained-local-url" } };
    const polluted = {};
    for (const term of terms) {
      seen[term.term] = { count: term.count, firstSeen: term.firstSeen,
        lastSeen: term.lastSeen, firstUrl: "https://example.jp/" };
      polluted[term.term] = 9;
    }
    polluted[commandID] = { added: 27 };
    Object.assign(f.disk.kanjiState, {
      revision: 9, generation: 3, seenKanji: seen, syncEnabled: true,
      syncToken: "preserved-cloud-cursor", syncQueue: copy(polluted), completedCommands: copy(polluted),
    });
    Object.assign(f.disk.kanjiState.sync, { requested: true, phase: "waiting", stage: "push",
      nextAttemptAt: f.now() + 60000, lastSuccessAt: f.now() - 120000 });
    const originalHistory = copy(seen);
    const originalEnvelope = f.state();
    const state = (await f.command("getState")).state;
    const expectedQueue = Object.fromEntries(terms.map(term => [term.term, 9]));
    equal(state.syncQueue, expectedQueue, "all 27 dirty revisions are recovered");
    equal(state.completedCommands, { [commandID]: { added: 27 } }, "receipt is retained separately");
    equal(state.seenKanji, originalHistory, "repair preserves every term and local URL");
    equal(state.syncToken, "preserved-cloud-cursor", "repair preserves the read cursor");
    equal(state.generation, 3, "repair preserves native generation");
    equal(state.sync.lastSuccessAt, f.now() - 120000, "repair preserves prior completion information");
    equal(f.nativeCalls, [], "repair performs no CloudKit action");
    check(typeof f.disk.kanjiStateRepairBackup === "string", "repair retains the original envelope as a JSON backup");
    equal(JSON.parse(f.disk.kanjiStateRepairBackup), originalEnvelope, "backup preserves the exact pre-repair state");
    const savedBackup = f.disk.kanjiStateRepairBackup;
    f.restart();
    await f.coordinator.restore();
    const revision = f.state().revision;
    const reply = await f.command("commitTerms", { terms: [record(terms[0].term, 999)] }, commandID);
    equal(reply.added, 27, "retry returns the original receipt");
    equal(f.state().revision, revision, "repaired receipt prevents a duplicate write after restart");
    equal(f.state().seenKanji, originalHistory, "replayed command cannot change saved counts");
    equal(f.state().syncQueue, expectedQueue, "replayed command cannot alter queued revisions");
    equal(f.disk.kanjiStateRepairBackup, savedBackup, "restart and retry preserve the original backup");
  });

  await test("unmatched contamination is preserved and rejected rather than guessed", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("保存")] });
    f.disk.kanjiState.syncQueue["unmatched-command"] = { added: 1 };
    const original = copy(f.disk);
    await rejects(() => f.command("getState"), "storageSchema");
    equal(f.disk, original, "a nonmatching damaged queue is not rewritten");
  });

  for (const scenario of ["unknown value", "missing vocabulary revision", "receipt collides with vocabulary"]) {
    await test("ambiguous matching dictionaries are not repaired: " + scenario, async () => {
      const f = fixture();
      await f.coordinator.restore();
      const seen = { "保存": { count: 1, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "" } };
      const polluted = { "保存": 9, "operation": { added: 1 } };
      if (scenario === "unknown value") polluted.mystery = "damaged";
      if (scenario === "missing vocabulary revision") {
        delete polluted["保存"];
        polluted["不明"] = 9;
      }
      if (scenario === "receipt collides with vocabulary") seen.operation = copy(seen["保存"]);
      Object.assign(f.disk.kanjiState, { revision: 9, seenKanji: seen,
        syncQueue: copy(polluted), completedCommands: copy(polluted) });
      const original = copy(f.disk);
      await rejects(() => f.command("getState"), "storageSchema");
      equal(f.disk, original, "uncertain data remains available for manual recovery");
    });
  }

  await test("a failed repair backup leaves the authoritative envelope untouched", async () => {
    const f = await contaminatedFixture();
    const original = copy(f.disk);
    f.failNextWrite();
    await rejects(() => f.command("getState"));
    equal(f.disk, original, "repair must not begin until its backup is saved");
    equal(f.nativeCalls, [], "failed backup does not start CloudKit work");
    f.restart();
    await f.coordinator.restore();
    equal(f.state().syncQueue, { "保存": 9 }, "restart can retry the backed-up repair");
    equal(JSON.parse(f.disk.kanjiStateRepairBackup), original.kanjiState, "retry backs up the unmodified original");
  });

  for (const priorBackup of [false, true]) {
    await test("failed repair envelope write resumes safely" + (priorBackup ? " with a previous backup" : " after creating its backup"), async () => {
      const f = await contaminatedFixture();
      const original = f.state();
      const previousBackup = JSON.stringify({ retained: "previous repair backup", generation: 2 });
      if (priorBackup) f.disk.kanjiStateRepairBackup = previousBackup;
      f.beforeWrite = async (patch) => {
        if (patch.kanjiState) {
          f.beforeWrite = null;
          f.failNextWrite();
        }
      };
      await rejects(() => f.command("getState"));
      equal(f.state(), original, "failed replacement leaves the original envelope available");
      const backup = f.disk.kanjiStateRepairBackup;
      if (priorBackup) equal(backup, previousBackup, "an earlier backup is not overwritten");
      else equal(JSON.parse(backup), original, "new backup precedes the failed envelope write");
      f.restart();
      await f.coordinator.restore();
      equal(f.state().syncQueue, { "保存": 9 }, "queued revision recovered after restart");
      equal(f.state().completedCommands, { "accepted-command": { added: 1 } }, "command receipt recovered after restart");
      equal(f.state().seenKanji, original.seenKanji, "repair preserves history");
      equal(f.state().syncToken, original.syncToken, "repair preserves cursor");
      equal(f.state().generation, original.generation, "repair preserves generation");
      equal(f.disk.kanjiStateRepairBackup, backup, "restart preserves the backup byte for byte");
    });
  }

  for (const retryAfter of [1e308, 1e12]) {
    await test("an absurd server retry interval cannot overflow the next attempt: " + retryAfter, async () => {
      const f = fixture();
      await f.enable();
      f.native = async () => ({ ok: false, code: "network", error: "later", retryAfter });
      await f.coordinator.run();
      const next = f.state().sync.nextAttemptAt;
      check(Number.isFinite(next), "next attempt remains a real timestamp");
      check(next > f.now(), "the failure still delays the retry");
      check(next <= f.now() + 30 * 60000, "the retry stays inside the maximum backoff");
      const reply = await f.command("getState");
      equal(reply.state.sync.nextAttemptAt, next, "the saved envelope remains readable");
    });
  }

  for (const attempts of [undefined, -3, 2.5, "many"]) {
    await test("a damaged attempt counter cannot poison the backoff: " + attempts, async () => {
      const f = fixture();
      await f.enable();
      if (attempts === undefined) delete f.disk.kanjiState.sync.attempts;
      else f.disk.kanjiState.sync.attempts = attempts;
      f.native = async () => ({ ok: false, code: "network", error: "offline" });
      await f.coordinator.run();
      equal(f.state().sync.attempts, 1, "the first failure counts once");
      const next = f.state().sync.nextAttemptAt;
      check(Number.isFinite(next) && next > f.now(), "the retry has a real deadline");
      check(next <= f.now() + 30 * 60000, "the retry stays inside the maximum backoff");
      check(!!(await f.command("getState")).state, "the envelope remains readable");
    });
  }

  await test("an impossible native generation is never adopted", async () => {
    const f = fixture();
    await f.enable();
    const generation = f.state().generation;
    f.native = async () => ({ ok: false, code: "staleGeneration", currentGeneration: -1,
      error: "Native reset journal is damaged" });
    await f.coordinator.run();
    equal(f.state().seenKanji, {}, "an empty history is the tempting case");
    equal(f.state().generation, generation, "a negative fence cannot replace a valid one");
    equal(f.state().sync.phase, "error", "the mismatch is surfaced to the user");
    equal((await f.command("getState")).state.generation, generation, "the envelope still validates");
  });

  await test("disabling sync escapes a reset the cloud refuses", async () => {
    const f = await stuckResetFixture();
    const generation = f.state().generation;
    await f.command("setSyncEnabled", { enabled: false });
    equal(f.state().sync.stage, "abandon", "the pending reset becomes an abandon request");
    check(f.state().sync.resetPending, "saves stay blocked until native answers");
    await rejects(() => f.command("commitTerms", { terms: [record("待機")] }), "resetPending");
    let sent = null;
    f.native = async (message) => { sent = copy(message); return { ok: true, generation, completed: false }; };
    await f.drain();
    equal(sent, { action: "abandonReset", generation }, "native is asked to forget that fence");
    check(!f.state().sync.resetPending, "an answered abandon releases new saves");
    equal(f.state().syncEnabled, false, "sync stays off");
    equal(f.state().generation, generation, "the native journal keeps its fence");
    equal(Object.keys(f.state().seenKanji), ["学校"], "an abandoned deletion keeps the history");
    await f.command("commitTerms", { terms: [record("新規")] });
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "新規"].sort(), "saving works again");
    await f.command("setSyncEnabled", { enabled: true });
    const actions = [];
    f.native = async (message) => {
      actions.push(message.action);
      equal(message.generation, generation, "resumed sync carries the same fence");
      return message.action === "pull" ? page() : { ok: true };
    };
    await f.drain();
    equal(actions[0], "pull", "resumed sync starts by reading changes");
    equal(f.state().syncQueue, {}, "the surviving history is uploaded again");
  });

  await test("an abandoned reset that native already completed still clears history", async () => {
    const f = await stuckResetFixture();
    const generation = f.state().generation;
    await f.command("setSyncEnabled", { enabled: false });
    f.native = async () => ({ ok: true, generation, completed: true });
    await f.drain();
    equal(f.state().seenKanji, {}, "a deletion that did happen is honored locally");
    equal(f.state().syncQueue, {}, "the dirty queue is cleared with it");
    equal(f.state().syncToken, null, "the cursor of the deleted zone is dropped");
    equal(f.state().generation, generation, "the completed fence is retained");
    check(!f.state().sync.resetPending, "the reset is finished");
  });

  await test("an abandon adopts a native journal older than this browser", async () => {
    const f = await stuckResetFixture();
    check(f.state().generation > 0, "the reset advanced the local fence");
    await f.command("setSyncEnabled", { enabled: false });
    f.native = async () => ({ ok: true, generation: 0, completed: false });
    await f.drain();
    equal(f.state().generation, 0, "a reset native never saw leaves the journal in charge");
    equal(Object.keys(f.state().seenKanji), ["学校"], "the history survives");
    await f.command("setSyncEnabled", { enabled: true });
    f.native = async (message) => {
      equal(message.generation, 0, "later work carries the adopted fence");
      return message.action === "pull" ? page() : { ok: true };
    };
    await f.drain();
    equal(f.state().syncQueue, {}, "sync completes at the adopted fence");
  });

  for (const answer of [{ ok: true, completed: false }, { ok: true, generation: -1, completed: false },
    { ok: true, generation: 1 }]) {
    await test("an unusable abandon reply is refused: " + JSON.stringify(answer), async () => {
      const f = await stuckResetFixture();
      await f.command("setSyncEnabled", { enabled: false });
      f.native = async () => answer;
      await f.coordinator.run();
      equal(f.state().sync.error.code, "protocol", "an unusable answer is not applied");
      check(f.state().sync.resetPending, "the fence waits for a valid answer");
      equal(Object.keys(f.state().seenKanji), ["学校"], "a bad answer cannot touch the history");
    });
  }

  await test("a second clear retries a reset that stopped at an error", async () => {
    const f = await stuckResetFixture();
    const generation = f.state().generation;
    const before = f.nativeCalls.length;
    const reply = await f.command("clearHistory", {}, "second-clear");
    equal(reply.added, 0, "clearing reports no additions");
    equal(f.state().generation, generation + 1, "the retry moves to a newer fence");
    check(f.state().sync.phase !== "error", "the stuck error is cleared");
    let sent = null;
    f.native = async (message) => { sent = copy(message); return { ok: true }; };
    await f.drain();
    equal(sent, { action: "reset", generation: generation + 1 }, "the deletion is attempted again under that fence");
    check(f.nativeCalls.length > before, "the retry reaches native code");
    equal(f.state().seenKanji, {}, "the confirmed reset finally clears the history");
  });

  await test("a clear after a failed abandon restarts the deletion under a newer fence", async () => {
    const f = await stuckResetFixture();
    const generation = f.state().generation;
    await f.command("setSyncEnabled", { enabled: false }, "abandon-off");
    f.native = async () => ({ ok: false, code: "journal", error: "invalid native sync journal" });
    await f.coordinator.run();
    equal(f.state().sync.stage, "abandon", "the abandon is what failed");
    equal(f.state().sync.phase, "error", "a damaged journal stops the abandon");
    let sent = null;
    f.native = async (message) => { sent = copy(message); return { ok: true }; };
    await f.command("clearHistory", {}, "clear-after-abandon");
    equal(f.state().sync.stage, "reset", "clearing again chooses deletion over the abandon");
    await f.drain();
    equal(sent, { action: "reset", generation: generation + 1 }, "the deletion restarts under a newer fence");
    equal(f.state().seenKanji, {}, "the confirmed reset clears the history");
    check(!f.state().sync.resetPending, "nothing stays pending");
  });

  // Offline, a deletion only ever fails with retryable codes, so it never
  // stops at an error. Turning sync off must still end it without the cloud.
  await test("an offline reset that keeps retrying can still be abandoned", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.drain();
    await f.command("clearHistory", {}, "offline-clear");
    const generation = f.state().generation;
    // Every CloudKit call fails; the journal-only abandon still answers.
    f.native = async (message) => message.action === "abandonReset"
      ? { ok: true, generation: message.generation, completed: false }
      : { ok: false, code: "network", error: "offline" };
    for (let i = 0; i < 5; i++) { f.advanceToDue(); await f.coordinator.run(); }
    equal(f.nativeCalls.slice(-5).map((m) => m.action), ["reset", "reset", "reset", "reset", "reset"], "each wake retries the deletion");
    equal(f.state().sync.phase, "waiting", "a retryable failure never stops at an error");
    equal(f.state().sync.error.code, "network", "the reason stays visible");
    check(f.state().sync.resetPending, "the deletion is still pending");
    await rejects(() => f.command("commitTerms", { terms: [record("待機")] }), "resetPending");
    await f.command("setSyncEnabled", { enabled: false }, "offline-off");
    equal(f.state().sync.stage, "abandon", "turning sync off abandons the deletion");
    equal(f.state().sync.nextAttemptAt, 0, "the abandon does not wait out the deletion's backoff");
    await f.drain();
    equal(f.nativeCalls[f.nativeCalls.length - 1], { action: "abandonReset", generation }, "native forgets that fence");
    check(!f.state().sync.resetPending, "the abandon releases the pending reset");
    equal(f.state().syncEnabled, false, "sync stays off");
    equal(Object.keys(f.state().seenKanji), ["学校"], "the history is intact");
    await f.command("commitTerms", { terms: [record("新規")] });
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "新規"].sort(), "saving works again");
  });

  // Native treats a zone the user deleted as already gone when resetting, so
  // this only guards the coordinator: the zoneDeleted shutdown is for pulls
  // and pushes, and must never strand a pending deletion with sync off.
  await test("a deletion failing with zoneDeleted keeps retrying the reset", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.drain();
    await f.command("clearHistory", {}, "zone-deleted-clear");
    f.native = async () => ({ ok: false, code: "zoneDeleted", error: "zone deleted" });
    await f.coordinator.run();
    check(f.state().sync.resetPending, "the deletion stays pending");
    equal(f.state().syncEnabled, true, "sync is not turned off under a pending deletion");
    equal(f.state().sync.phase, "waiting", "the deletion is retried automatically");
    f.native = async (message) => message.action === "pull" ? page() : { ok: true };
    await f.drain();
    check(!f.state().sync.resetPending, "the retried deletion completes");
    equal(f.state().seenKanji, {}, "and clears the history");
  });

  // An abandon ends the reset without deleting anything, so a clear accepted
  // meanwhile would be acknowledged and then silently dropped.
  await test("a clear during a running abandon is refused instead of acknowledged and dropped", async () => {
    const f = await stuckResetFixture();
    await f.command("setSyncEnabled", { enabled: false }, "abandon-off");
    const before = f.state();
    equal(before.sync.stage, "abandon", "sync off turned the reset into an abandon");
    equal(before.sync.phase, "waiting", "the abandon is due, not stopped at an error");
    await rejects(() => f.command("clearHistory", {}, "clear-during-abandon"), "abandonPending");
    equal(f.state(), before, "the refused clear changes nothing, not even a receipt");
    const entered = deferred(), answer = deferred();
    f.native = async (message) => {
      entered.resolve();
      await answer.promise;
      return { ok: true, generation: message.generation, completed: false };
    };
    const running = f.coordinator.run();
    await entered.promise;
    await rejects(() => f.command("clearHistory", {}, "clear-during-abandon"), "abandonPending");
    equal(f.state().sync.stage, "abandon", "an abandon in flight keeps its stage");
    equal(f.state().generation, before.generation, "and its fence");
    answer.resolve();
    await running;
    check(!f.state().sync.resetPending, "the abandon finished");
    equal(Object.keys(f.state().seenKanji), ["学校"], "the abandon kept the history");
    const calls = f.nativeCalls.length;
    await f.command("clearHistory", {}, "clear-during-abandon");
    equal(f.state().seenKanji, {}, "with sync off, the same clear is the local one");
    check(!f.state().sync.resetPending, "no deletion is left pending");
    equal(f.nativeCalls.length, calls, "the local clear needs no cloud call");
  });

  await test("clearing history escapes an envelope no command can read", async () => {
    const f = await unreadableFixture({ seenKanji: { "旧語": { count: 5,
      firstSeen: "2026-09-01", lastSeen: "2026-09-02", firstUrl: "legacy" } } });
    const damaged = f.state();
    await rejects(() => f.command("getState"), "storageSchema");
    await rejects(() => f.command("commitTerms", { terms: [record("新規")] }, "blocked"), "storageSchema");
    const reply = await f.command("clearHistory", {}, "escape-clear");
    equal(reply.added, 0, "the escape adds nothing");
    check(typeof f.disk.kanjiStateQuarantine === "string", "the unreadable value is set aside as a string");
    equal(JSON.parse(f.disk.kanjiStateQuarantine), damaged, "the quarantine preserves it verbatim");
    const state = (await f.command("getState")).state;
    equal(state.seenKanji, {}, "the replacement starts empty");
    equal(state.syncQueue, {}, "the damaged queue is not carried over");
    equal(state.syncToken, null, "a cursor from an unreadable envelope is not trusted");
    equal(state.generation, 4, "a valid fence survives the damage");
    equal(state.newOnlyEnabled, true, "valid preferences survive");
    equal(state.extractMode, "all-words", "valid preferences survive");
    equal(state.syncEnabled, false, "sync waits for the user to turn it on again");
    equal(f.nativeCalls, [], "the escape performs no cloud work");
    check(!!f.disk.seenKanji["旧語"], "the retained legacy keys are still on disk");
    await f.command("commitTerms", { terms: [record("再開")] }, "after-escape");
    equal(Object.keys(f.state().seenKanji), ["再開"], "saving resumes without resurrecting legacy keys");
  });

  await test("a failed quarantine write never destroys the unreadable envelope", async () => {
    const f = await unreadableFixture();
    const original = copy(f.disk);
    f.failNextWrite();
    await rejects(() => f.command("clearHistory", {}, "escape-clear"), "storageSchema");
    equal(f.disk, original, "what could not be copied is not replaced");
    const reply = await f.command("clearHistory", {}, "escape-clear");
    equal(reply.ok, true, "a retry can still escape");
    equal(JSON.parse(f.disk.kanjiStateQuarantine), original.kanjiState, "the retry sets the original aside");
  });

  await test("a later escape replaces the previous quarantine", async () => {
    const f = await unreadableFixture();
    await f.command("clearHistory", {}, "first-escape");
    const first = f.disk.kanjiStateQuarantine;
    f.disk.kanjiState.seenKanji = "damaged";
    const second = f.state();
    await f.command("clearHistory", {}, "second-escape");
    equal(JSON.parse(f.disk.kanjiStateQuarantine), second, "the newest unreadable envelope is the kept one");
    check(f.disk.kanjiStateQuarantine !== first, "one quarantine key holds the latest damage");
  });

  await test("a damaged native journal stops automatic retries", async () => {
    const f = fixture();
    await f.enable();
    f.native = async () => ({ ok: false, code: "journal", error: "native journal damaged" });
    await f.coordinator.run();
    equal(f.state().sync.phase, "error", "a damaged journal needs the user");
    equal(f.state().sync.error.code, "journal", "the reason stays visible");
    equal(f.state().sync.nextAttemptAt, 0, "no automatic retry is armed");
    const calls = f.nativeCalls.length;
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.length, calls, "the periodic wake does not hammer it");
  });

  await test("recovery copies are removed 30 days after a valid envelope is first read", async () => {
    const f = await recoveryFixture();
    const since = f.now();
    equal(f.state().recoveryRetainedSince, since, "the first read beside recovery copies starts the period");
    const all = presentCopies(f);
    equal(all, ["seenKanji", "newOnlyEnabled", "syncToken", "syncLock", "kanjiStateRepairBackup"],
      "the fixture holds every kind of timed copy");
    f.advance(RETENTION - 1);
    f.restart();
    await f.coordinator.restore();
    await f.coordinator.requestPeriodic();
    equal(presentCopies(f), all, "nothing is removed before 30 days");
    equal(f.state().recoveryRetainedSince, since, "a later read does not restart the period");
    f.advance(1);
    await f.coordinator.restore();
    equal(presentCopies(f), [], "legacy keys and the repair backup are removed");
    check(!Object.prototype.hasOwnProperty.call(f.state(), "recoveryRetainedSince"), "the finished period is dropped");
    equal(Object.keys(f.state().seenKanji), Object.keys(legacyHistory()), "the envelope keeps the migrated history");
    equal(f.nativeCalls, [], "retention needs no cloud call");
    quarantine(f);
    const revision = f.state().revision;
    f.advance(RETENTION);
    await f.coordinator.restore();
    await f.coordinator.requestPeriodic();
    equal(f.state().revision, revision, "a quarantine alone never starts a period");
    equal(presentCopies(f), ["kanjiStateQuarantine"], "the quarantine outlives any period");
  });

  await test("the retention period starts only when a legacy key or repair backup exists", async () => {
    const f = fixture();
    await f.coordinator.restore();
    check(!Object.prototype.hasOwnProperty.call(f.state(), "recoveryRetainedSince"), "a fresh installation has nothing to retain");
    f.advance(DAY);
    f.disk.kanjiStateRepairBackup = JSON.stringify({ retained: "repair backup" });
    await f.coordinator.restore();
    equal(f.state().recoveryRetainedSince, f.now(), "a repair backup starts the period at this read");
    f.advance(RETENTION);
    await f.coordinator.restore();
    equal(presentCopies(f), [], "the timed copy is removed");
  });

  await test("a retention start in the future neither deletes early nor waits forever", async () => {
    const f = await recoveryFixture();
    // Saved while the clock ran a year ahead, then corrected.
    f.disk.kanjiState.recoveryRetainedSince = f.now() + 365 * DAY;
    await f.coordinator.restore();
    equal(f.state().recoveryRetainedSince, f.now(), "a future start is treated as now");
    equal(presentCopies(f).length, 5, "nothing is removed");
    f.advance(-10 * DAY);
    await f.coordinator.restore();
    equal(f.state().recoveryRetainedSince, f.now(), "a clock moved back again restarts from the earlier time");
    f.advance(RETENTION - 1);
    await f.coordinator.restore();
    equal(presentCopies(f).length, 5, "the period runs from the corrected clock");
    f.advance(1);
    await f.coordinator.restore();
    equal(presentCopies(f), [], "and ends 30 days later, not a year later");
  });

  await test("a failed retention removal never blocks commands and is retried later", async () => {
    const f = await recoveryFixture();
    const since = f.state().recoveryRetainedSince;
    f.advance(RETENTION);
    f.failNextRemove();
    await f.coordinator.restore();
    equal(presentCopies(f).length, 5, "a refused removal deletes nothing");
    equal(f.state().recoveryRetainedSince, since, "the period is kept for the next attempt");
    const reply = await f.command("commitTerms", { terms: [record("新規")] });
    equal(reply.added, 1, "saving still works");
    await f.coordinator.requestPeriodic();
    equal(presentCopies(f), [], "the next maintenance removes them");
    check(!!f.state().seenKanji["新規"], "the saved term is kept");
  });

  await test("envelopes without the retention field load; a malformed one is refused", async () => {
    const f = fixture();
    await f.coordinator.restore();
    await f.command("commitTerms", { terms: [record("保存")] });
    check(!Object.prototype.hasOwnProperty.call(f.state(), "recoveryRetainedSince"), "the envelope has no field");
    check(!!(await f.command("getState")).state.seenKanji["保存"], "an existing envelope still validates");
    for (const value of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2]) {
      f.disk.kanjiState.recoveryRetainedSince = value;
      await rejects(() => f.command("getState"), "storageSchema");
    }
    f.disk.kanjiState.recoveryRetainedSince = 0;
    equal((await f.command("getState")).state.recoveryRetainedSince, 0, "zero is a valid start");
  });

  await test("a confirmed local clear removes legacy keys, the repair backup and the quarantine", async () => {
    const f = await recoveryFixture({ nativeAvailable: false });
    quarantine(f);
    await f.command("commitTerms", { terms: [record("学校")] });
    f.failNextWrite();
    await rejects(() => f.command("clearHistory", {}, "failed-clear"), "storage");
    equal(presentCopies(f).length, 6, "a clear that was not saved removes nothing");
    const reply = await f.command("clearHistory", {}, "local-clear");
    equal(reply.state.seenKanji, {}, "the history is cleared");
    equal(f.state().seenKanji, {}, "the empty envelope was saved");
    equal(presentCopies(f), [], "every recovery copy goes with it");
  });

  await test("a cloud reset removes every recovery copy once iCloud confirms it", async () => {
    const f = await recoveryFixture();
    quarantine(f);
    await f.command("setSyncEnabled", { enabled: true });
    await f.drain();
    await f.command("clearHistory", {}, "cloud-clear");
    check(f.state().sync.resetPending, "the reset waits for iCloud");
    equal(presentCopies(f).length, 6, "an unconfirmed reset removes nothing");
    f.native = async () => ({ ok: false, code: "network", error: "offline" });
    await f.coordinator.run();
    equal(presentCopies(f).length, 6, "a failed reset removes nothing");
    f.native = async () => ({ ok: true });
    await f.drain();
    equal(f.state().seenKanji, {}, "the confirmed reset clears the history");
    equal(presentCopies(f), [], "and every recovery copy");
  });

  for (const completed of [false, true]) {
    await test("an abandoned reset removes the recovery copies only if the deletion completed: " + completed, async () => {
      const f = await stuckResetFixture();
      Object.assign(f.disk, { seenKanji: legacyHistory(), kanjiStateRepairBackup: "{}", kanjiStateQuarantine: "null" });
      await f.command("setSyncEnabled", { enabled: false });
      const generation = f.state().generation;
      f.native = async () => ({ ok: true, generation, completed });
      await f.drain();
      check(!f.state().sync.resetPending, "the abandon finished");
      equal(presentCopies(f), completed ? [] : ["seenKanji", "kanjiStateRepairBackup", "kanjiStateQuarantine"],
        completed ? "a completed deletion is a confirmed clear" : "a kept history keeps its copies");
    });
  }

  await test("the clear that sets a damaged envelope aside keeps every copy; a later clear removes them", async () => {
    const f = await unreadableFixture({ seenKanji: legacyHistory() });
    f.disk.kanjiStateRepairBackup = "{}";
    const damaged = f.state();
    await f.command("clearHistory", {}, "escape-clear");
    equal(JSON.parse(f.disk.kanjiStateQuarantine), damaged, "the quarantine is created");
    equal(presentCopies(f), ["seenKanji", "kanjiStateRepairBackup", "kanjiStateQuarantine"], "nothing is removed by the escape");
    await f.command("clearHistory", {}, "confirmed-clear");
    equal(presentCopies(f), [], "a clear of the valid replacement removes the quarantine too");
  });

  await test("R2 quota: a pull page that no longer fits frees recovery copies, then commits and advances", async () => {
    const f = await recoveryFixture({}, 40);
    await f.command("setSyncEnabled", { enabled: true });
    await f.drain();
    f.quota = f.usage() + 400;
    f.native = async () => page(bigPage("遠隔"), "next-cursor", false);
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.state().syncToken, "next-cursor", "the cursor advances past the stored page");
    check(!!f.state().seenKanji["遠隔19"], "the whole page is stored");
    equal(f.state().sync.error, null, "no failure is recorded");
    equal(presentCopies(f), [], "legacy keys and the repair backup were freed");
    check(f.usage() <= f.quota, "the store stays within its quota");
  });

  await test("R2 quota: a page that cannot fit stops at storageQuota instead of being fetched again", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    f.disk.kanjiStateQuarantine = JSON.stringify({ retained: "only copy" });
    f.quota = f.usage() + 400;
    f.native = async () => page(bigPage("遠隔"), "next-cursor", false);
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    const calls = f.nativeCalls.length;
    const state = f.state();
    equal(state.sync.error.code, "storageQuota", "the reason is saved for the popup");
    equal(state.sync.phase, "error", "the job waits for the user");
    equal(state.sync.nextAttemptAt, 0, "no automatic retry is armed");
    equal(state.syncToken, "cursor-final", "the cursor stays before the page");
    check(!state.seenKanji["遠隔0"], "no part of the page is stored");
    check(!!f.disk.kanjiStateQuarantine, "the emergency cleanup never touches the quarantine");
    equal(f.removes, [], "nothing else was removable");
    for (let wake = 0; wake < 4; wake++) {
      f.advance(30 * 60000);
      await f.coordinator.restore();
      await f.coordinator.requestPeriodic();
      await f.coordinator.run();
    }
    equal(f.nativeCalls.length, calls, "no wake fetches the page again");
    await rejects(() => f.command("commitTerms", { terms: bigPage("局所") }), "storageQuota");
    f.quota = null;
    await f.command("syncNow");
    await f.drain();
    equal(f.state().syncToken, "next-cursor", "an explicit retry after space is freed completes the page");
  });

  await test("a quota failure that cannot be recorded keeps the lease and does not re-arm the wake", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    await f.coordinator.requestPeriodic();
    f.native = async () => {
      f.quota = f.usage();   // nothing more fits, not even the failure record
      return page(bigPage("遠隔"), "next-cursor", false);
    };
    await rejects(() => f.coordinator.run(), "storageQuota");
    const state = f.state();
    equal(state.sync.phase, "pull", "the saved job is the one prepared before the request");
    equal(state.syncToken, "cursor-final", "the cursor stays before the page");
    check(state.sync.nextAttemptAt > f.now(), "its lease still holds off the next attempt");
    equal(f.wakes[f.wakes.length - 1], 0, "the recovery wake is cleared, not re-armed from the lease");
    const calls = f.nativeCalls.length;
    await f.coordinator.run();
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.length, calls, "no wake fetches the page again within the lease");
  });

  for (const [browser, quotaError] of [
    ["Chrome", () => new Error("QUOTA_BYTES quota exceeded")],
    ["Safari", () => new Error("Exceeded storage quota.")],
    ["Firefox", () => Object.assign(new Error("The current transaction exceeded its quota limitations."), { name: "QuotaExceededError" })],
    ["DOM", () => Object.assign(new Error(""), { name: "QuotaExceededError", code: 22 })],
  ]) {
    await test("commands under a full quota reject with storageQuota: " + browser, async () => {
      const f = fixture({}, { nativeAvailable: false });
      await f.coordinator.restore();
      f.disk.kanjiStateQuarantine = JSON.stringify({ retained: "only copy" });
      const before = f.state();
      f.quota = f.usage() + 50;
      f.quotaError = quotaError;
      await rejects(() => f.command("commitTerms", { terms: bigPage("局所") }), "storageQuota");
      await rejects(() => f.command("importHistory", { incoming: { "輸入語": { count: 2 } } }), "storageQuota");
      equal(f.state(), before, "nothing was committed");
      check(!!f.disk.kanjiStateQuarantine, "the quarantine is never freed");
      equal(f.removes, [], "nothing else was removable");
    });
  }

  await test("commitTerms succeeds when the emergency cleanup frees enough, and fails when it cannot", async () => {
    const f = await recoveryFixture({ nativeAvailable: false }, 40);
    f.quota = f.usage() + 50;
    f.failNextRemove();
    await rejects(() => f.command("commitTerms", { terms: bigPage("局所") }, "refused-cleanup"), "storageQuota");
    equal(presentCopies(f).length, 5, "a failed cleanup removes nothing");
    check(!f.state().seenKanji["局所0"], "and commits nothing");
    const reply = await f.command("commitTerms", { terms: bigPage("局所") }, "freed-commit");
    equal(reply.added, 20, "the retried write is committed");
    equal(presentCopies(f), [], "legacy keys and the repair backup were freed");
    equal(f.removes.length, 1, "one emergency cleanup");
  });

  await test("writes whose source is at stake never trigger the emergency cleanup", async () => {
    // Migration: the legacy keys ARE the history being written.
    const migrating = fixture({ seenKanji: legacyHistory(), kanjiStateRepairBackup: "{}" });
    refuseNextEnvelope(migrating);
    await rejects(() => migrating.coordinator.restore(), "storageQuota");
    equal(migrating.removes, [], "a refused migration removes nothing");
    check(!!migrating.disk.seenKanji && !migrating.disk.kanjiState, "the legacy history remains the only copy");

    // Repair: the backup just written protects the envelope being replaced.
    const repairing = await contaminatedFixture();
    repairing.disk.seenKanji = legacyHistory();
    const original = repairing.state();
    refuseNextEnvelope(repairing);
    const state = (await repairing.command("getState")).state;
    equal(state.syncQueue, { "保存": 9 }, "the repair is saved after freeing legacy keys");
    equal(JSON.parse(repairing.disk.kanjiStateRepairBackup), original, "the backup it depends on is kept");
    check(!repairing.disk.seenKanji, "only legacy keys were freed");

    // Quarantine: the envelope is unreadable, so older copies may be all that is left.
    const damaged = await unreadableFixture({ seenKanji: legacyHistory() });
    damaged.disk.kanjiStateRepairBackup = "{}";
    refuseNextEnvelope(damaged);
    await rejects(() => damaged.command("clearHistory", {}, "escape"), "storageQuota");
    equal(damaged.removes, [], "a refused escape removes nothing");
    check(!!damaged.disk.seenKanji && !!damaged.disk.kanjiStateRepairBackup, "every older copy remains");
  });

  // Beside a quarantine, legacy keys and the backup may be the only readable
  // copies of a history: only a confirmed Clear history removes them.
  await test("retention is suspended while a quarantine exists and resumes once it is gone", async () => {
    const unstamped = fixture({ seenKanji: legacyHistory(), kanjiStateQuarantine: "null" });
    await unstamped.coordinator.restore();
    check(!Object.prototype.hasOwnProperty.call(unstamped.state(), "recoveryRetainedSince"), "no period starts beside a quarantine");

    const f = await recoveryFixture();
    const since = f.state().recoveryRetainedSince;
    quarantine(f);
    const all = presentCopies(f);
    const revision = f.state().revision;
    f.advance(RETENTION + DAY);
    await f.coordinator.restore();
    await f.coordinator.requestPeriodic();
    equal(presentCopies(f), all, "no copy is removed while the quarantine exists");
    equal(f.state().recoveryRetainedSince, since, "the running period is left untouched");
    equal(f.state().revision, revision, "not even rewritten");
    f.disk.kanjiStateQuarantine = "{\"retained\":\"moved clock\"}";
    f.disk.kanjiState.recoveryRetainedSince = f.now() + 365 * DAY;
    await f.coordinator.restore();
    equal(f.state().recoveryRetainedSince, f.now() + 365 * DAY, "a future start is not reset either");
    f.disk.kanjiState.recoveryRetainedSince = since;
    // A confirmed clear removes the quarantine with a multi-key removal that
    // WebKit may apply only in part: the countdown then resumes as it was.
    delete f.disk.kanjiStateQuarantine;
    await f.coordinator.restore();
    equal(presentCopies(f), [], "the overdue period completes once the quarantine is gone");
    check(!Object.prototype.hasOwnProperty.call(f.state(), "recoveryRetainedSince"), "and is dropped");
  });

  await test("the emergency cleanup frees nothing while a quarantine exists", async () => {
    const f = await recoveryFixture({ nativeAvailable: false }, 40);
    quarantine(f);
    const all = presentCopies(f);
    f.quota = f.usage() + 50;
    await rejects(() => f.command("commitTerms", { terms: bigPage("局所") }, "beside-quarantine"), "storageQuota");
    equal(presentCopies(f), all, "the legacy keys and the backup are still there");
    equal(f.removes, [], "nothing was removed");
    check(!f.state().seenKanji["局所0"], "and nothing was committed");
    await f.command("clearHistory", {}, "confirmed-clear");
    equal(presentCopies(f), [], "a confirmed clear removes all three");
    const reply = await f.command("commitTerms", { terms: bigPage("局所") }, "after-clear");
    equal(reply.added, 20, "saving works again");
  });

  await test("other storage failures surface as storage, not as generic sync failures", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    f.failNextWrite();
    await rejects(() => f.command("commitTerms", { terms: [record("失敗")] }), "storage");
    f.failNextRead();
    const failure = await rejects(() => f.command("getState"), "storage");
    check(failure.message.includes("simulated storage read failure"), "a short detail is kept for the popup");
    await f.coordinator.requestPeriodic();
    f.native = async () => { f.failNextWrite(); return page([record("学校")], "next-cursor", false); };
    await f.coordinator.run();
    equal(f.state().sync.error.code, "storage", "a failed page write is saved as a storage problem");
    equal(f.state().sync.phase, "waiting", "and still retried automatically");
    equal(f.state().syncToken, "cursor-final", "the cursor stays before the page");
  });

  await test("a queued term above the code point limit leaves the queue but not the history", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    // Simulate a history written by an older version that had no length bound.
    const long = "語".repeat(65);
    f.disk.kanjiState.seenKanji[long] = { count: 1, firstSeen: "2026-09-01", lastSeen: "2026-09-01", firstUrl: "" };
    f.disk.kanjiState.syncQueue[long] = f.state().revision;
    f.restart();
    const pushed = [];
    f.native = async message => {
      if (message.action === "push") pushed.push(...message.terms.map(record => record.term));
      return message.action === "pull" ? page() : { ok: true };
    };
    await f.command("syncNow");
    await f.drain();
    check(!pushed.includes(long), "the over-long term is never sent to the native layer");
    check(!Object.prototype.hasOwnProperty.call(f.state().syncQueue, long), "the over-long term leaves the queue");
    check(Object.prototype.hasOwnProperty.call(f.state().seenKanji, long), "the local history keeps the term");
  });

  // Storage cost. The envelope is the whole history (~1.6 MB at 12k terms):
  // each read is a browser clone plus a JSON deep copy, and each write also
  // reaches every open popup. These pin how many each common path performs.
  await test("an idle periodic sync reads the envelope four times and writes it three times", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    f.advance(30 * 60000);
    const calls = f.nativeCalls.length;
    f.resetCounters();
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(f.nativeCalls.slice(calls).map(message => message.action), ["pull"], "one empty pull");
    equal(f.envelopeReads(), 4, "arm, prepare the pull, accept it, check for newer work");
    equal(f.writes.map(patch => patch.kanjiState.sync.phase), ["waiting", "pull", "idle"],
      "the popup still sees the armed job, the running pull and the completion");
    const state = f.state();
    check(!state.sync.requested && state.sync.lastSuccessAt === f.now() && state.sync.error === null,
      "the empty pull completes the job in the same write that accepts it");
    equal(f.wakes[f.wakes.length - 1], 0, "no recovery wake is left armed");
  });

  await test("a sync cycle with one page and one push writes once per step", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    await f.command("commitTerms", { terms: [record("学校", 3)] });
    f.native = async message => message.action === "pull"
      ? page([record("日本", 4)], "cursor-2", false) : { ok: true };
    f.resetCounters();
    await f.coordinator.run();
    equal(f.envelopeReads(), 5, "two prepares, two accepts and the final check");
    equal(f.writes.map(patch => patch.kanjiState.sync.phase), ["pull", "waiting", "push", "idle"],
      "the last confirmed push also completes the job");
    equal(f.state().syncQueue, {}, "the queue is drained");
    equal(f.state().syncToken, "cursor-2", "the cursor is committed");
    equal(f.wakes[f.wakes.length - 1], 0, "no recovery wake is left armed");
  });

  await test("a command reads and writes the envelope once, and the drain after it only reads", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    f.resetCounters();
    await f.command("setPreferences", { newOnlyEnabled: true });
    equal(f.envelopeReads(), 1, "the wake is armed from the state the command saved");
    equal(f.envelopeWrites(), 1, "one write for the command");
    equal(f.wakes, [0], "an idle job clears the recovery wake");
    f.resetCounters();
    await f.coordinator.run();
    equal(f.envelopeReads(), 1, "the due check and the first step share one read");
    equal(f.envelopeWrites(), 0, "nothing to run, nothing written");
    equal(f.wakes, [0], "the idle job keeps no recovery wake");
    f.resetCounters();
    await f.command("commitTerms", { terms: [record("学校")] });
    equal(f.envelopeReads(), 1, "a commit reads once too");
    equal(f.wakes, [f.now()], "the queued job is armed at once");
    f.resetCounters();
    const reply = await f.command("getState");
    equal(f.envelopeReads(), 1, "a status read is one read");
    equal(f.envelopeWrites(), 0, "and writes nothing");
    equal(f.wakes, [f.now()], "it still re-arms the pending job");
    check(!!reply.state.seenKanji["学校"], "the reply carries the saved history");
  });

  await test("restore reads the envelope once", async () => {
    const f = fixture();
    await f.coordinator.restore();
    f.resetCounters();
    f.restart();
    await f.coordinator.restore();
    equal(f.envelopeReads(), 1, "load, retention check and wake share one read");
    equal(f.envelopeWrites(), 0, "an unchanged envelope is not rewritten");
    equal(f.wakes, [0], "the wake is reconciled");
  });

  await test("a drain that is not due reads once and leaves the wake alone", async () => {
    const f = fixture();
    await f.enable();
    f.native = async () => ({ ok: false, code: "network", error: "offline" });
    await f.coordinator.run();
    check(f.state().sync.nextAttemptAt > f.now(), "a backoff is pending");
    f.resetCounters();
    await f.coordinator.run();
    equal(f.envelopeReads(), 1, "one read decides that nothing is due");
    equal(f.writes, [], "nothing is written");
    equal(f.wakes, [], "the armed backoff wake is untouched");
  });

  await test("a failed first read of a drain records nothing", async () => {
    const f = fixture();
    await f.enable();
    const before = f.state();
    f.failNextRead();
    await rejects(() => f.coordinator.run(), "storage");
    equal(f.state(), before, "a drain that could not read attempted nothing");
    equal(f.nativeCalls, [], "no native call was made");
  });

  // The wake is armed from the saved lease in the same dispatcher turn; if
  // that fails, the request must not start without its recovery alarm.
  await test("a recovery wake that cannot be armed stops the step before its request", async () => {
    const f = fixture();
    await f.enable();
    f.failNextWake();
    await f.coordinator.run();
    equal(f.nativeCalls, [], "no request runs without its recovery wake");
    const state = f.state();
    equal(state.sync.error.code, "generic", "the failure is recorded against the step");
    equal(state.sync.phase, "waiting", "and retried automatically");
    equal(f.wakes[f.wakes.length - 1], state.sync.nextAttemptAt, "the retry is armed from the recorded backoff");
    f.advanceToDue();
    await f.drain();
    check(f.nativeCalls.length > 0 && !f.state().sync.requested, "the retry completes");
  });

  // The history is stored sorted by count (ties by Japanese collation): the
  // export keeps that order. A pull that changes nothing skips the re-sort,
  // so the order must already hold after every change.
  await test("history changes are saved sorted by count and an empty pull keeps that order", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    await f.command("commitTerms", { terms: [record("低", 1), record("高", 9), record("中", 5)] });
    await f.drain();
    equal(Object.keys(f.state().seenKanji), ["高", "中", "低"], "a commit is saved sorted");
    f.advance(30 * 60000);
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    equal(Object.keys(f.state().seenKanji), ["高", "中", "低"], "an empty pull keeps the order");
    f.native = async message => message.action === "pull"
      ? page([record("低", 20), record("新", 7), record("同", 5)], "cursor-2", false) : { ok: true };
    await f.command("syncNow");
    await f.drain();
    // 中 and 同 both have count 5: their relative order is the collator's.
    const tie = ["中", "同"].sort(new Intl.Collator("ja").compare);
    equal(Object.keys(f.state().seenKanji), ["低", "高", "新", ...tie],
      "a changing pull is saved sorted, ties by collation");
  });

  finishTests();
})().catch((error) => { print(error.stack || error); quit(1); });
