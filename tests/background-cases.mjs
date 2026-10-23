// Exercise the actual background entry point, including browser API signatures,
// event registration, alarms, and a receiver disappearing after a saved command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = ['sync-core.js', 'sync-coordinator.js', 'background.js']
  .map(name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')).join('\n');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const bytes = store => Object.keys(store).reduce((total, key) => total + key.length + JSON.stringify(store[key]).length, 0);

// `storage` may set a byte `quota` (with the browser's `quotaMessage`) or a
// `failure` that every write rejects with; it can change after startup.
async function worker({ promiseStyle = true, native = true, disk = {}, alarms = new Map(), nativeCall, storage = {} } = {}) {
  const listeners = {};
  const calls = [];
  const created = [];
  const nativeCalls = [];
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  function method(fn) {
    return (...args) => {
      if (promiseStyle) {
        assert.notEqual(typeof args.at(-1), 'function', 'Promise APIs must not receive a callback');
        return Promise.resolve().then(() => fn(...args));
      }
      const callback = args.pop();
      assert.equal(typeof callback, 'function', 'Chrome callback API must receive a callback');
      // Chrome reports a failed call through runtime.lastError inside the callback.
      Promise.resolve().then(() => fn(...args)).then(callback, error => {
        api.runtime.lastError = { message: error.message };
        try { callback(); } finally { delete api.runtime.lastError; }
      });
    };
  }
  const api = {
    runtime: {
      getManifest: () => ({ permissions: native ? ['storage', 'nativeMessaging', 'alarms'] : ['storage'] }),
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
      sendNativeMessage: method(async (application, message) => {
        assert.equal(application, 'application.id');
        nativeCalls.push(copy(message));
        return nativeCall ? nativeCall(message) : message.action === 'pull'
          ? { ok: true, records: [], token: 'cursor', more: false } : { ok: true };
      }),
    },
    storage: { local: {
      get: method(keys => {
        const result = Array.isArray(keys) ? {} : copy(keys);
        for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
          if (Object.hasOwn(disk, key)) result[key] = copy(disk[key]);
        }
        return result;
      }),
      set: method(patch => {
        if (storage.failure) throw storage.failure;
        if (storage.quota !== undefined && bytes({ ...disk, ...copy(patch) }) > storage.quota) {
          throw new Error(storage.quotaMessage);
        }
        Object.assign(disk, copy(patch));
      }),
      remove: method(keys => { for (const key of [].concat(keys)) delete disk[key]; }),
    } },
    alarms: {
      get: method(name => copy(alarms.get(name))),
      clear: method(name => alarms.delete(name)),
      create(name, details) {
        calls.push(name);
        created.push({ name, details });
        alarms.set(name, { name, scheduledTime: details.when || Date.now() + details.periodInMinutes * 60000 });
        // Chrome alarms.create historically returns void; do not wait for a callback.
        return promiseStyle ? Promise.resolve() : undefined;
      },
      onAlarm: event('alarm'),
    },
  };
  const context = vm.createContext({ [promiseStyle ? 'browser' : 'chrome']: api, console, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  for (let i = 0; i < 15; i++) await flush();
  return { disk, alarms, created, nativeCalls, listeners, context,
    command: message => new Promise(resolve => {
      const result = listeners.message({ kind: 'kanji', ...message }, {}, resolve);
      assert.equal(result, true);
    }),
    settled: async () => {
      for (let i = 0; i < 10; i++) await flush();
      await vm.runInContext('coordinator.run()', context);
      for (let i = 0; i < 5; i++) await flush();
    },
  };
}

for (const promiseStyle of [true, false]) {
  test(`${promiseStyle ? 'Safari/Firefox' : 'Chrome'} API style accepts a durable save`, async () => {
    const w = await worker({ promiseStyle, native: false });
    const result = await w.command({ command: 'commitTerms', payload: { terms: [{ term: '日本', count: 3 }] }, id: 'save-1' });
    assert.equal(result.ok, true);
    assert.equal(w.disk.kanjiState.seenKanji['日本'].count, 3);
    assert.equal(w.nativeCalls.length, 0);
    assert.equal(w.created.length, 0);
  });
}

test('worker reload preserves the existing periodic alarm deadline', async () => {
  const first = await worker();
  const original = copy(first.alarms.get('kanji-sync'));
  const second = await worker({ disk: first.disk, alarms: first.alarms });
  assert.deepEqual(second.alarms.get('kanji-sync'), original);
  assert.equal(second.created.filter(alarm => alarm.name === 'kanji-sync').length, 0);
});

test('receiver closing after a commit does not prevent the saved job from running', async () => {
  const w = await worker();
  await w.command({ command: 'setSyncEnabled', payload: { enabled: true }, id: 'enable' });
  await w.settled();
  w.listeners.message({ kind: 'kanji', command: 'commitTerms',
    payload: { terms: [{ term: '学校', count: 4 }] }, id: 'save-closed-popup' }, {}, () => {
    throw new Error('The popup no longer exists');
  });
  await w.settled();
  assert.equal(w.disk.kanjiState.seenKanji['学校'].count, 4);
  assert.ok(w.nativeCalls.some(call => call.action === 'push' && call.terms.some(term => term.term === '学校')));
  assert.equal(Object.keys(w.disk.kanjiState.syncQueue).length, 0);
  assert.equal(w.disk.kanjiState.sync.requested, false);
});

test('failed reply is structured and unknown native relay messages are ignored', async () => {
  const w = await worker();
  const result = await w.command({ command: 'unknown', id: 'unknown' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalidCommand');
  assert.equal(w.listeners.message({ kind: 'native', message: { action: 'reset' } }, {}, () => {}), undefined);
  assert.equal(w.nativeCalls.length, 0);
});

const saveCalls = w => w.nativeCalls.filter(call => call.action === 'saveDownload');
const savePayload = { filename: 'kanji_example.jp_20260923_120000.txt', text: 'Source: https://example.jp/\n日本語\n' };

for (const promiseStyle of [true, false]) {
  test(`${promiseStyle ? 'Safari/Firefox' : 'Chrome'} API style saves a file natively without touching history`, async () => {
    const w = await worker({ promiseStyle, nativeCall: message => message.action === 'saveDownload'
      ? { ok: true, filename: 'kanji_example.jp_20260923_120000 (2).txt' } : { ok: true } });
    const coordinatorCommands = [];
    w.context.recordCoordinatorCommand = name => coordinatorCommands.push(name);
    vm.runInContext(`(() => {
      const original = coordinator.command;
      coordinator.command = (...args) => { recordCoordinatorCommand(args[0]); return original(...args); };
    })()`, w.context);
    const before = copy(w.disk);
    const result = await w.command({ command: 'saveFile', payload: savePayload, id: 'file-1' });
    assert.deepEqual(copy(result), { ok: true, filename: 'kanji_example.jp_20260923_120000 (2).txt' });
    assert.deepEqual(saveCalls(w), [{ action: 'saveDownload', ...savePayload }]);
    assert.deepEqual(coordinatorCommands, []);
    assert.deepEqual(w.disk, before);
  });
}

test('saveFile relays native and transport failures with a code', async () => {
  const failing = await worker({ nativeCall: message => message.action === 'saveDownload'
    ? { ok: false, code: 'file', error: 'The file could not be written to Downloads.' } : { ok: true } });
  const failed = copy(await failing.command({ command: 'saveFile', payload: savePayload, id: 'file-fail' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'file');
  assert.equal(typeof failed.error, 'string');

  const broken = await worker({ nativeCall: message => {
    if (message.action === 'saveDownload') throw new Error('native host disconnected');
    return { ok: true };
  } });
  const lost = copy(await broken.command({ command: 'saveFile', payload: savePayload, id: 'file-lost' }));
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'generic');
  assert.equal(typeof lost.error, 'string');

  // A reply without the written name cannot prove a file exists.
  const vague = await worker({ nativeCall: () => ({ ok: true }) });
  const unproven = copy(await vague.command({ command: 'saveFile', payload: savePayload, id: 'file-vague' }));
  assert.equal(unproven.ok, false);
});

test('invalid saveFile payloads are rejected without a native call', async () => {
  const w = await worker();
  const invalid = [
    undefined, {}, { filename: '', text: 'x' }, { filename: 'a'.repeat(256), text: 'x' },
    { filename: 7, text: 'x' }, { filename: 'a.txt' }, { filename: 'a.txt', text: 5 },
    { filename: 'a.txt', text: 'a'.repeat(5 * 1024 * 1024 + 1) },
  ];
  for (const [index, payload] of invalid.entries()) {
    const result = copy(await w.command({ command: 'saveFile', payload, id: 'invalid-' + index }));
    assert.equal(result.ok, false, 'rejected: ' + index);
    assert.equal(result.code, 'invalidFile', 'invalidFile: ' + index);
  }
  assert.equal(saveCalls(w).length, 0);
});

test('saveFile without native messaging answers unavailable', async () => {
  const w = await worker({ native: false });
  const result = copy(await w.command({ command: 'saveFile', payload: savePayload, id: 'file-web' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unavailable');
  assert.equal(saveCalls(w).length, 0);
});

test('a retried saveFile id returns the first result instead of writing again', async () => {
  let release;
  const w = await worker({ nativeCall: message => message.action === 'saveDownload'
    ? new Promise(resolve => { release = () => resolve({ ok: true, filename: 'kanji (2).txt' }); }) : { ok: true } });
  const first = w.command({ command: 'saveFile', payload: savePayload, id: 'file-retry' });
  for (let i = 0; i < 10 && !release; i++) await flush();
  const retry = w.command({ command: 'saveFile', payload: savePayload, id: 'file-retry' });
  release();
  const results = (await Promise.all([first, retry])).map(copy);
  assert.deepEqual(results, [{ ok: true, filename: 'kanji (2).txt' }, { ok: true, filename: 'kanji (2).txt' }]);
  assert.deepEqual(copy(await w.command({ command: 'saveFile', payload: savePayload, id: 'file-retry' })), results[0]);
  assert.equal(saveCalls(w).length, 1);
});

test('remembered saveFile ids are bounded', async () => {
  const w = await worker({ nativeCall: message => message.action === 'saveDownload'
    ? { ok: true, filename: 'kanji.txt' } : { ok: true } });
  for (let i = 0; i <= 16; i++) await w.command({ command: 'saveFile', payload: savePayload, id: 'bounded-' + i });
  await w.command({ command: 'saveFile', payload: savePayload, id: 'bounded-16' });
  assert.equal(saveCalls(w).length, 17, 'a recent id is still remembered');
  await w.command({ command: 'saveFile', payload: savePayload, id: 'bounded-0' });
  assert.equal(saveCalls(w).length, 18, 'the oldest id was forgotten');
});

test('restart rebuilds a missing recovery alarm from the persisted future deadline', async () => {
  const deadline = Date.now() + 300000;
  const first = await worker();
  const state = first.disk.kanjiState;
  state.syncEnabled = true;
  state.sync.requested = true;
  state.sync.phase = 'waiting';
  state.sync.nextAttemptAt = deadline;
  const second = await worker({ disk: first.disk });
  assert.equal(second.alarms.get('kanji-sync-recovery').scheduledTime, deadline);
  assert.equal(second.nativeCalls.length, 0);
});

const legacyHistory = Object.fromEntries(Array.from({ length: 40 }, (_, index) => ['旧語' + index,
  { count: index + 1, firstSeen: '2026-06-01', lastSeen: '2026-06-02', firstUrl: 'legacy' }]));

for (const promiseStyle of [true, false]) {
  test(`${promiseStyle ? 'Safari/Firefox' : 'Chrome'} API style frees recovery copies, then reports a full storage as storageQuota`, async () => {
    const storage = {};
    const w = await worker({ promiseStyle, native: false, storage, disk: { seenKanji: legacyHistory,
      kanjiStateRepairBackup: JSON.stringify({ seenKanji: legacyHistory }) } });
    assert.ok(w.disk.kanjiState, 'the legacy history was migrated at startup');
    storage.quota = bytes(w.disk) + 50;
    storage.quotaMessage = promiseStyle ? 'Exceeded storage quota.' : 'QUOTA_BYTES quota exceeded';
    const terms = Array.from({ length: 20 }, (_, index) => ({ term: '局所' + index, count: 1 }));
    const saved = copy(await w.command({ command: 'commitTerms', payload: { terms }, id: 'freed' }));
    assert.equal(saved.ok, true, 'the write fits once recovery copies are freed');
    assert.deepEqual(Object.keys(w.disk), ['kanjiState'],
      'legacy keys and the repair backup went through storage.local.remove');
    storage.quota = bytes(w.disk) + 50;   // nothing removable is left
    const more = terms.map(term => ({ ...term, term: term.term + '追加' }));
    const full = copy(await w.command({ command: 'commitTerms', payload: { terms: more }, id: 'full' }));
    assert.equal(full.ok, false);
    assert.equal(full.code, 'storageQuota', 'a full storage is not relayed as generic');
  });
}

test('any other storage write failure is relayed as storage, not generic', async () => {
  const storage = {};
  const w = await worker({ native: false, storage });
  storage.failure = new Error('IO error');
  const result = copy(await w.command({ command: 'commitTerms', payload: { terms: [{ term: '日本', count: 1 }] }, id: 'io' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'storage');
  assert.match(result.error, /IO error/);
});
