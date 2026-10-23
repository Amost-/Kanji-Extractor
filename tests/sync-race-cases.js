// These reproduce the old lost-update/reset bugs through the public commands.
// --known-races now expects all cases to pass against the real coordinator.
(async function () {
  await test("a save at the page write boundary cannot race its read-modify-write", async () => {
    const f = fixture();
    await f.enable();
    const reachedWrite = deferred(), resumeWrite = deferred();
    f.native = async () => page([record("日本", 2)], "received", false);
    f.beforeWrite = async (patch) => {
      if (patch.kanjiState?.seenKanji["日本"]) {
        f.beforeWrite = null;
        reachedWrite.resolve();
        await resumeWrite.promise;
      }
    };
    const running = f.coordinator.run(1);
    await reachedWrite.promise;
    // Submit while the pull owns a snapshot but its write is still pending.
    // A dispatcher must finish that write before this command reads its state.
    const saving = f.command("commitTerms", { terms: [record("学校", 4)] });
    resumeWrite.resolve();
    await Promise.all([running, saving]);
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "日本"].sort(), "neither update is lost");
    equal(f.state().syncToken, "received", "page cursor remains committed");
    equal(Object.keys(f.state().syncQueue), ["学校"], "local record remains queued");
  });

  await test("a pull response cannot overwrite a concurrently saved term", async () => {
    const f = fixture();
    await f.enable();
    const entered = deferred(), response = deferred();
    f.native = async () => { entered.resolve(); return response.promise; };
    const running = f.coordinator.run(1);
    await entered.promise;
    await f.command("commitTerms", { terms: [record("学校", 4)], url: "https://example.jp" });
    response.resolve(page([record("日本", 2)], "received", false));
    await running;
    equal(Object.keys(f.state().seenKanji).sort(), ["学校", "日本"].sort(), "both changes retained");
    equal(Object.keys(f.state().syncQueue), ["学校"], "saved term stays queued");
    check(f.state().sync.lastSuccessAt === null, "pending upload cannot be called complete");
  });

  await test("a confirmed push cannot remove a newer revision from the queue", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 2)] });
    const entered = deferred(), response = deferred();
    f.native = async (message) => {
      if (message.action === "pull") return page();
      equal(message.terms[0].count, 2, "old revision sent");
      entered.resolve();
      return response.promise;
    };
    const running = f.coordinator.run(2);
    await entered.promise;
    const oldRevision = f.state().syncQueue["学校"];
    await f.command("commitTerms", { terms: [record("学校", 8)] });
    check(f.state().syncQueue["学校"] > oldRevision, "new save advances queue revision");
    response.resolve({ ok: true });
    await running;
    equal(f.state().seenKanji["学校"].count, 8, "new data retained");
    check(!!f.state().syncQueue["学校"], "new revision remains dirty");
    equal(f.state().sync.lastSuccessAt, null, "not complete with newer work queued");
    f.native = async (message) => {
      equal(message.action, "push", "resume continues the upload");
      equal(message.terms[0].count, 8, "new revision sent on next step");
      return { ok: true };
    };
    await f.drain();
    equal(f.state().syncQueue, {}, "new revision eventually confirmed");
  });

  await test("reset invalidates an older in-flight pull and its cursor", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    const entered = deferred(), response = deferred();
    f.native = async () => { entered.resolve(); return response.promise; };
    const running = f.coordinator.run(1);
    await entered.promise;
    await f.command("clearHistory", {}, "clear-during-pull");
    const generation = f.state().generation;
    response.resolve(page([record("古文", 5)], "obsolete-cursor", false));
    await running;
    check(!f.state().seenKanji["古文"], "old page cannot enter the new generation");
    check(f.state().syncToken !== "obsolete-cursor", "old cursor cannot enter the new generation");
    check(f.state().sync.resetPending, "stale response cannot cancel reset");
    f.native = async (message) => {
      equal(message.action, "reset", "reset is the next native operation");
      equal(message.generation, generation, "native reset receives the new generation");
      return { ok: true };
    };
    await f.drain();
    equal(f.state().seenKanji, {}, "reset remains cleared");
    equal(f.state().syncToken, null, "deleted zone cursor remains cleared");
  });

  await test("disable, local clear and re-enable ignore an older pull without inventing a native generation", async () => {
    const f = fixture();
    await f.enable();
    const entered = deferred(), response = deferred();
    f.native = async () => { entered.resolve(); return response.promise; };
    const running = f.coordinator.run(1);
    await entered.promise;
    await f.command("setSyncEnabled", { enabled: false });
    await f.command("clearHistory");
    await f.command("setSyncEnabled", { enabled: true });
    equal(f.state().generation, 0, "local clear does not change native reset generation");
    response.resolve(page([record("旧語")], "cancelled-cycle", false));
    await running;
    equal(f.state().seenKanji, {}, "response from previous cycle cannot repopulate history");
    equal(f.state().syncToken, null, "previous cycle cannot advance the cursor");
    check(f.state().sync.requested, "newly enabled cycle remains pending");
    f.native = async (message) => {
      equal(message.action, "pull", "fresh cycle receives changes");
      equal(message.generation, 0, "native generation remains valid");
      equal(message.since, null, "fresh pull starts from current cursor");
      return page([record("新語")], "fresh-cycle", false);
    };
    await f.drain();
    equal(Object.keys(f.state().seenKanji), ["新語"], "only the fresh response is adopted");
  });

  // The popup lets sync be turned off while a deletion request is in flight.
  // Its late failure belongs to the replaced intent and must not park the
  // journal-only abandon behind a backoff or a stop meant for the deletion.
  for (const code of ["network", "account"]) {
    await test("a deletion failing after sync is turned off does not hold up the abandon: " + code, async () => {
      const f = fixture();
      await f.enable();
      await f.command("commitTerms", { terms: [record("学校", 4)] });
      await f.drain();
      await f.command("clearHistory", {}, "clear");
      const generation = f.state().generation;
      const entered = deferred(), response = deferred();
      f.native = async () => { entered.resolve(); return response.promise; };
      const running = f.coordinator.run(1);
      await entered.promise;
      await f.command("setSyncEnabled", { enabled: false }, "off-during-reset");
      response.resolve({ ok: false, code, error: "sync failed" });
      await running;
      equal(f.state().sync.stage, "abandon", "the abandon is still the saved intent");
      check(f.state().sync.phase !== "error", "the deletion's failure does not stop the abandon");
      equal(f.state().sync.nextAttemptAt, 0, "nor delay it with a backoff");
      f.native = async (message) => ({ ok: true, generation: message.generation, completed: false });
      await f.coordinator.run(1);
      equal(f.nativeCalls[f.nativeCalls.length - 1], { action: "abandonReset", generation }, "the abandon runs next");
      check(!f.state().sync.resetPending, "the abandon finished");
      equal(Object.keys(f.state().seenKanji), ["学校"], "the history is kept");
    });
  }

  await test("a deletion confirmed after sync is turned off is still honored", async () => {
    const f = fixture();
    await f.enable();
    await f.command("commitTerms", { terms: [record("学校", 4)] });
    await f.drain();
    await f.command("clearHistory", {}, "clear");
    const entered = deferred(), response = deferred();
    f.native = async () => { entered.resolve(); return response.promise; };
    const running = f.coordinator.run(1);
    await entered.promise;
    await f.command("setSyncEnabled", { enabled: false }, "off-during-reset");
    response.resolve({ ok: true });
    await running;
    equal(f.state().seenKanji, {}, "the zone is gone, so the local copy follows");
    check(!f.state().sync.resetPending, "nothing is left to abandon");
    equal(f.state().syncEnabled, false, "sync stays off");
  });

  finishTests();
})().catch((error) => { print(error.stack || error); quit(1); });
