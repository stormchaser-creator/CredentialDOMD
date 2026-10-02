// Lab, release goal3: the device copy was written 300 ms after every change,
// so a record added and the page reloaded right away (or iOS discarding the
// app) was missing from it, and a weak-signal launch showed "No saved records
// in this section" until the server answered. The first change after a quiet
// spell is now written on the next turn of the event loop, a burst is written
// once at its end, and when the page is left (beforeunload, pagehide, hidden,
// a reload the app asks for) the trailing write is handed over and the save
// still under way is put into localStorage synchronously (storage.js
// spillOfflineSave): an IndexedDB write begun then never lands (measured in
// WebKit and Chromium; tests/offline-cache/reload-mid-save.test.mjs). Every
// guard is still checked when the write runs. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const cacheStart = source.indexOf('  // Persist the offline copy on change');
const cacheEnd = source.indexOf('  // ─── Subscription', cacheStart);
if (cacheStart < 0 || cacheEnd < cacheStart) throw new Error('AppContext cache effect could not be located');
const cacheCode = source.slice(cacheStart, cacheEnd);
const owner = 'user_syntheticA';

function fixture() {
  let now = 1_000_000;
  const timers = new Map(), writes = [], listeners = {}, docListeners = {}, calls = [], leaves = [];
  let nextId = 1;
  const refs = [];
  const effects = [];
  const document = { visibilityState: 'visible', addEventListener: (t, f) => { docListeners[t] = f; }, removeEventListener() {} };
  const context = {
    Date: { now: () => now },
    data: { settings: { name: 'Synthetic A' }, licenses: [] }, loaded: true,
    dataOwnerRef: { current: owner }, dataLoadGeneration: { current: 1 }, cachedRecordsRef: { current: null },
    loadedDeletionRef: { current: { owner, stamp: null, fence: null } }, WIPE_SEEN_KEY: 'synthetic-wipe',
    sameDeletionStamp: (a, b) => (a ?? null) === (b ?? null), lsGet: () => null, localCopyCurrent: () => true,
    getActiveUserId: () => owner,
    saveData: async (value, account) => { writes.push({ value, account, at: now }); calls.push(['saveData', value?.n ?? null]); },
    setCacheWritePending: (account, pending, how) => calls.push(['pending', account, pending, !!how?.current]),
    spillOfflineSave: (account) => { calls.push(['spill', account]); return 'spilled'; },
    onPageLeave: (fn) => { leaves.push(fn); return () => { leaves.splice(leaves.indexOf(fn), 1); }; },
    useRef: (v) => { const r = { current: v }; refs.push(r); return r; },
    useEffect: (fn) => { effects.push(fn); },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    window: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener() {} },
    document,
  };
  vm.runInNewContext(cacheCode, context);
  const [cacheEffect, pageEffect] = effects;
  pageEffect();
  let cleanup = null;
  return {
    writes, timers, listeners, docListeners, document, calls, leaves, context,
    change(next) { cleanup?.(); context.data = next; cleanup = cacheEffect(); },
    advance(ms) { now += ms; },
    runDue(limitMs) { for (const [id, t] of [...timers]) if (t.ms <= limitMs) { timers.delete(id); t.fn(); } },
  };
}

test('the first change after a quiet spell is written on the next turn, not 300 ms later', () => {
  const f = fixture();
  const added = { settings: { name: 'Synthetic A' }, licenses: [{ id: 'l1' }] };
  f.change(added);
  assert.deepEqual([...f.timers.values()].map((t) => t.ms), [0]);
  f.runDue(0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].value, added);
  assert.equal(f.writes[0].account, owner);
});

test('a burst of changes is written once, at its end, with the last records', () => {
  const f = fixture();
  f.change({ n: 1 }); f.runDue(0);
  f.advance(50); f.change({ n: 2 });
  f.advance(50); f.change({ n: 3 });
  assert.deepEqual([...f.timers.values()].map((t) => t.ms), [300]);
  f.runDue(300);
  assert.deepEqual(f.writes.map((w) => w.value.n), [1, 3]);
});

test('a write still waiting when the page is hidden or unloaded is written then', () => {
  const f = fixture();
  f.change({ n: 1 }); f.runDue(0);
  f.advance(10); f.change({ n: 2 });
  f.listeners.pagehide();
  assert.deepEqual(f.writes.map((w) => w.value.n), [1, 2]);
  assert.equal(f.timers.size, 0, 'the timer it replaced is cleared');
  f.listeners.pagehide();
  assert.equal(f.writes.length, 2, 'nothing is written twice');
  f.advance(10); f.change({ n: 3 });
  f.document.visibilityState = 'hidden';
  f.docListeners.visibilitychange();
  assert.deepEqual(f.writes.map((w) => w.value.n), [1, 2, 3]);
});

test('leaving the page hands the trailing write over and then puts the save under way into localStorage', () => {
  for (const leave of ['beforeunload', 'pagehide', 'hidden', 'reloadPage']) {
    const f = fixture();
    f.change({ n: 1 }); f.runDue(0);
    f.advance(10); f.change({ n: 2 });
    f.calls.length = 0;
    if (leave === 'hidden') { f.document.visibilityState = 'hidden'; f.docListeners.visibilitychange(); }
    else if (leave === 'reloadPage') { assert.equal(f.leaves.length, 1, 'registered for the reloads the app asks for'); f.leaves[0](); }
    else f.listeners[leave]();
    assert.deepEqual(f.calls, [['pending', owner, false, false], ['saveData', 2], ['spill', owner]], `${leave}: write, then spill, nothing awaited`);
    assert.equal(f.timers.size, 0, `${leave}: the trailing timer is cleared`);
  }
});

test('a change waiting for its write marks the copy behind; records a load already saved mark nothing', () => {
  const f = fixture();
  f.change({ n: 1 });
  assert.deepEqual(f.calls, [['pending', owner, true, false]], 'marked as it is scheduled');
  f.runDue(0);
  assert.deepEqual(f.calls.slice(1), [['pending', owner, false, false], ['saveData', 1]]);
  f.calls.length = 0;
  // A load put these records on screen and saved them itself (cachedRecordsRef).
  const loaded = { n: 7 };
  f.context.cachedRecordsRef.current = loaded;
  f.change(loaded);
  assert.equal(f.timers.size, 0, 'nothing scheduled');
  assert.deepEqual(f.calls, [['pending', owner, false, true]], 'current once that save lands');
});
