// An offline copy that no store would take (full, IndexedDB closed) or that a
// load could not read is tried again on its own (AppContext): when the app
// comes back to the front, the device comes online, the window regains focus
// or is shown again, and on a backoff timer. It used to be tried again only
// when the member next changed Protected Identity or the Answer Bank, so a
// change accepted just before the store stopped answering stayed in memory
// until the app closed. AppContext's own effect, cut from the source.
// Synthetic account only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'src/context/AppContext.jsx'), 'utf8');
const start = source.indexOf('  // An offline copy that could not be saved (full, a store that would not');
const endMarker = '  }, [offlineCopyStale, loaded, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps\n';
const end = source.indexOf(endMarker, start);
assert.ok(start > 0 && end > start, 'the retry effect could not be located in AppContext');
const effectCode = source.slice(start, end + endMarker.length);

const U = 'user_syntheticRetry';
const tick = () => new Promise(r => setImmediate(r));

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); },
    fire(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    count() { return [...listeners.values()].reduce((n, l) => n + l.length, 0); },
  };
}

function mountEffect({ stale, unread = false, readable = true }) {
  const calls = [];
  const timers = [];
  const win = target(), doc = Object.assign(target(), { visibilityState: 'visible' });
  const ctx = {
    user: { id: U }, loaded: true, offlineCopyStale: stale,
    window: win, document: doc,
    dataOwnerRef: { current: U }, getActiveUserId: () => U,
    offlineCopyUnread: () => unread,
    probeOfflineFile: async (id) => { calls.push(['probe', id]); return readable; },
    retryOfflineSave: async (id) => { calls.push(['retrySave', id]); return true; },
    loadDataForUser: (id) => { calls.push(['load', id]); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    useEffect: (fn) => { ctx.cleanup = fn(); },
  };
  vm.runInNewContext(effectCode, ctx);
  return { ctx, calls, timers, win, doc };
}

test('a save no store took is made again when the device comes online, the app is shown again, and on a backoff timer', async () => {
  const e = mountEffect({ stale: 'unavailable' });
  assert.equal(e.timers[0].ms, 5000, 'first try five seconds on');
  e.win.fire('online');
  await tick();
  assert.deepEqual(e.calls, [['retrySave', U]]);
  e.doc.fire('visibilitychange');
  await tick();
  e.win.fire('pageshow');
  await tick();
  e.win.fire('focus');
  await tick();
  assert.equal(e.calls.filter(c => c[0] === 'retrySave').length, 4);
  await e.timers[0].fn();
  assert.equal(e.timers[1].ms, 15000, 'backing off');
  e.ctx.cleanup();
  assert.equal(e.win.count() + e.doc.count(), 0, 'every listener removed once the copy is current');
});

test('a copy a load could not read is loaded again once a read gets through', async () => {
  const e = mountEffect({ stale: 'unread', unread: true, readable: false });
  e.win.fire('online');
  await tick(); await tick();
  assert.deepEqual(e.calls, [['probe', U]], 'still unreadable: nothing loaded');
  const ok = mountEffect({ stale: 'unread', unread: true, readable: true });
  ok.doc.fire('visibilitychange');
  await tick(); await tick();
  assert.deepEqual(ok.calls, [['probe', U], ['load', U]]);
  ok.ctx.cleanup();
});

test('nothing is set up while the offline copy is current', () => {
  const e = mountEffect({ stale: null });
  assert.equal(e.timers.length, 0);
  assert.equal(e.win.count() + e.doc.count(), 0);
});
