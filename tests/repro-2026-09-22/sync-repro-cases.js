// Repro cases: each test PASSES when the suspected defect is reproduced.
const DAY = 86400000;
function show(label, value) { print("   " + label + ": " + JSON.stringify(value)); }

(async function () {
  await test("R1 clock correction after a failure parks automatic sync far in the future", async () => {
    const f = fixture();
    await f.enable();
    f.advance(365 * DAY);                       // clock wrongly one year ahead
    f.native = async () => ({ ok: false, code: "network", error: "offline" });
    await f.coordinator.run();
    f.advance(-365 * DAY);                      // clock corrected
    show("nextAttemptAt - now (days)", (f.state().sync.nextAttemptAt - f.now()) / DAY);
    const before = f.nativeCalls.length;
    f.native = async (m) => m.action === "pull" ? page() : { ok: true };
    await f.command("commitTerms", { terms: [record("新語", 3)] });
    await f.coordinator.run();
    await f.coordinator.requestPeriodic();
    await f.coordinator.run();
    show("native calls after commit + periodic + run", f.nativeCalls.length - before);
    show("last scheduled wake - now (days)", (f.wakes[f.wakes.length - 1] - f.now()) / DAY);
    check(f.nativeCalls.length === before, "stalled: no native call although work is queued");
  });

  await test("R2 quota: a pull page that grows the envelope is refetched forever, cursor never advances", async () => {
    const f = fixture();
    await f.enable();
    await f.drain();
    const limit = JSON.stringify(f.disk.kanjiState).length + 400;   // little headroom left
    const set = f.storageSet;
    f.storageSet = async (patch) => {
      if (patch.kanjiState && JSON.stringify(patch.kanjiState).length > limit) throw new Error("exceeded storage quota");
      return set(patch);
    };
    f.restart();
    await f.coordinator.requestPeriodic();
    const big = Array.from({ length: 20 }, (_, i) => record("遠隔" + i, 2));
    f.native = async () => page(big, "next-cursor", false);
    let pulls = 0;
    for (let i = 0; i < 4; i++) {
      f.advanceToDue();
      const n = f.nativeCalls.length;
      await f.coordinator.run();
      pulls += f.nativeCalls.length - n;
    }
    show("pull calls over 4 wakes", pulls);
    show("syncToken", f.state().sync && f.state().syncToken);
    show("sync.error / phase", [f.state().sync.error, f.state().sync.phase]);
    const reply = await f.coordinator.command("commitTerms", { terms: [record("局所語", 1)] }, "c-quota").catch(e => ({ rejected: e.message, code: e.code }));
    show("commit reply", reply);
    check(pulls === 4 && f.state().syncToken === "cursor-final" && f.state().sync.phase === "waiting", "page refetched each wake, never committed");
  });

  await test("R3 reset pending + retryable failure never reaches phase 'error' (popup keeps download/toggle/clear disabled)", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.drain();
    await f.command("clearHistory", {}, "offline-clear");
    f.native = async () => ({ ok: false, code: "network", error: "offline" });
    for (let i = 0; i < 12; i++) { f.advanceToDue(); await f.coordinator.run(); }
    const s = f.state().sync;
    show("after 12 failed attempts: phase/resetPending/attempts/error", [s.phase, s.resetPending, s.attempts, s.error && s.error.code]);
    const blocked = await f.command("commitTerms", { terms: [record("新規")] }).catch(e => e.code);
    show("commitTerms", blocked);
    check(s.phase === "waiting" && s.resetPending && blocked === "resetPending", "never escalates; saves blocked");
  });

  await test("R4 quarantine restarts revision at 1: a stale in-flight pull page is accepted into the new envelope", async () => {
    const f = fixture();
    await f.enable();                            // job cycle = 2
    let call = 0;
    const entered = deferred(), response = deferred();
    f.native = async (m) => {
      call++;
      if (call === 1) return page([record("頁一", 2)], "T1", true);   // page 1 accepted
      entered.resolve(); return response.promise;                     // page 2 in flight
    };
    const running = f.coordinator.run(8);
    await entered.promise;
    show("old job cycle/generation", [f.state().sync.cycle, f.state().generation]);
    f.disk.kanjiState.seenKanji = "damaged";                          // envelope becomes unreadable
    await f.command("clearHistory", {}, "escape");                     // quarantine: revision 1
    await f.command("setSyncEnabled", { enabled: true }, "re-enable"); // new job
    show("new job cycle/generation/token", [f.state().sync.cycle, f.state().generation, f.state().syncToken]);
    response.resolve(page([record("頁二", 2)], "T2", false));
    await running;
    show("after stale reply: token/terms", [f.state().syncToken, Object.keys(f.state().seenKanji)]);
    check(f.state().syncToken === "T2" && !f.state().seenKanji["頁一"], "stale page adopted; page 1 permanently skipped");
  });

  await test("R5 clear during a pending abandon (phase not error) is acknowledged but the abandon keeps the history", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.drain();
    await f.command("clearHistory", {}, "first-clear");
    f.native = async () => ({ ok: false, code: "account", error: "signed out" });
    await f.coordinator.run();
    await f.command("setSyncEnabled", { enabled: false }, "off");       // stage abandon, phase waiting
    const reply = await f.command("clearHistory", {}, "second-clear");   // user asks to clear again
    show("clear reply ok / stage / phase", [reply.ok, f.state().sync.stage, f.state().sync.phase]);
    const g = f.state().generation;
    f.native = async (m) => ({ ok: true, generation: g, completed: false });
    await f.drain();
    show("history after acknowledged clear", Object.keys(f.state().seenKanji));
    check(Object.keys(f.state().seenKanji).length === 1, "acknowledged clear did not clear");
  });

  await test("R6 malformed dates / huge counts are stored verbatim and win min/max forever", async () => {
    const seen = { "日本": { count: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-07", firstUrl: "" } };
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 1e308, firstSeen: "01/09/2026", lastSeen: "zzzz" }]);
    show("merged", seen["日本"]);
    mergeRemoteIntoSeen(seen, [{ term: "日本", count: 5, firstSeen: "2026-08-01", lastSeen: "2026-09-20" }]);
    show("after a later valid record", seen["日本"]);
    check(seen["日本"].lastSeen === "zzzz" && seen["日本"].firstSeen === "01/09/2026" && seen["日本"].count === 1e308, "poisoned");
  });

  await test("R7 staleGeneration with any local history: retry resends the old fence; only Clear (zone delete) moves on", async () => {
    const f = fixture();
    await f.coordinator.restore();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.command("setSyncEnabled", { enabled: true });
    f.native = async (m) => ({ ok: false, code: "staleGeneration", currentGeneration: 3, error: "stale" });
    await f.coordinator.run();
    await f.command("syncNow");
    await f.coordinator.run();
    show("generations sent", f.nativeCalls.map(m => m.action + "@" + m.generation));
    show("phase/error", [f.state().sync.phase, f.state().sync.error.code]);
    await f.command("clearHistory", {}, "user-clear");
    f.native = async (m) => { show("next native op", m); return { ok: true }; };
    await f.coordinator.run(1);
    check(f.nativeCalls[f.nativeCalls.length - 1].action === "reset", "recovery path deletes the iCloud zone");
  });

  finishTests();
})().catch((error) => { print(error.stack || error); quit(1); });
