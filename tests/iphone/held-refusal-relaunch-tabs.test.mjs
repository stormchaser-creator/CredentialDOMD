// Review of 5cb89c90: the "not kept" alert a share's hand-off holds
// (limitedLaunchAccess holdWriteRefusalAlerts) and writes to the device.
//  - A share log refused at once (a launch on a weak signal: no answer yet,
//    writes suspended, records view-only) was held in memory only, so iOS
//    discarding the app while Mail was in front lost it: "Sent", no Send
//    history row, and nothing said on relaunch.
//  - localStorage is shared by every desktop tab, so a second tab took a live
//    tab's held alert and said "Before the app closed:" though nothing closed,
//    and the live tab said it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shareAtHandoff, watchShareUnanswered } from '../../src/utils/shareHandoff.js';
import { alertWriteRefused, holdForAccess, READ_ONLY_AFTER_CHECK_MESSAGE, HELD_REFUSAL_RELAUNCH_PREFIX } from '../../src/utils/limitedLaunchAccess.js';

const named = name => Object.assign(new Error(name), { name });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

function target(extra = {}) {
  const l = {};
  return {
    visibilityState: 'visible',
    addEventListener(t, f) { (l[t] ??= new Set()).add(f); },
    removeEventListener(t, f) { l[t]?.delete(f); },
    fire(t) { for (const f of [...(l[t] || [])]) f(); },
    listening(t) { return l[t]?.size || 0; },
    ...extra,
  };
}
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, map: m };
}
function checkedLater() {
  let answer;
  let status = { status: 'verify', reason: 'stale' };
  return {
    authority: { enabled: true, verify: () => new Promise(r => { answer = r; }), statusFor: () => status, serves: () => true },
    refuse: () => { status = { status: 'refuse', reason: 'read_only' }; answer(Date.now()); },
  };
}
// One page's Web Locks: a page iOS discards lets go of all of its own.
class PageLocks {
  constructor() { this.held = new Set(); }
  request(name, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (this.held.has(name)) return opts.ifAvailable ? Promise.resolve(cb(null)) : new Promise(() => {});
    this.held.add(name);
    return Promise.resolve().then(() => cb({ name })).finally(() => this.held.delete(name));
  }
  async query() { return { held: [...this.held].map(name => ({ name })), pending: [] }; }
}
async function onPage(fn) {
  const had = { window: 'window' in globalThis, localStorage: 'localStorage' in globalThis };
  const was = { window: globalThis.window, localStorage: globalThis.localStorage };
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const shown = [];
  const storage = memoryStorage();
  globalThis.window = target({ alert: m => shown.push(m), Clerk: { user: { id: 'user_synthetic' } } });
  globalThis.localStorage = storage;
  // One origin's Web Locks, seen by every tab of it.
  Object.defineProperty(globalThis, 'navigator', { value: { locks: new PageLocks() }, configurable: true, writable: true });
  const discard = () => { globalThis.navigator.locks = new PageLocks(); };
  try { return await fn({ shown, storage, win: globalThis.window, discard }); }
  finally {
    for (const k of ['window', 'localStorage']) { if (had[k]) globalThis[k] = was[k]; else delete globalThis[k]; }
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator;
  }
}
// The weak-network launch: no answer yet, writes suspended, refused at once.
const suspended = () => ({ enabled: true, outdated: () => false, state: () => null, remembered: () => null, statusFor: () => ({ status: 'refuse', reason: 'suspended' }), serves: () => true, canCheck: () => false, requestCheck: () => false });

test('a share log refused at once is written down too, and the next load of the app says it after iOS discards the page', async (t) => {
  await onPage(async ({ shown, storage, win, discard }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const doc = target();
      const authority = suspended();
      let said = null;
      shareAtHandoff({ text: 'packet' }, {
        share: () => new Promise(() => {}), // Mail took over; the promise never settles
        // AppContext.addItem: the write is refused, then alertWriteRefused.
        onHanded: () => { alertWriteRefused({ authority, section: 'shareLog' }); said = 'Sent 2 documents as one packet.'; },
        watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      });
      await settle();
      assert.equal(said, 'Sent 2 documents as one packet.');
      doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
      t.mock.timers.tick(60 * 60 * 1000);
      await settle();
      assert.deepEqual(shown, []);
      assert.equal(storage.map.size, 1, 'the held alert is on the device, not only in the page');
      discard();
      const relaunched = await import('../../src/utils/limitedLaunchAccess.js?immediate-relaunch');
      assert.equal(await relaunched.takeHeldRefusalNotice('user_another'), null, 'never to another account');
      const notice = await relaunched.takeHeldRefusalNotice('user_synthetic');
      assert.ok(notice?.startsWith(HELD_REFUSAL_RELAUNCH_PREFIX), 'said on the next load');
      assert.equal(await relaunched.takeHeldRefusalNotice('user_synthetic'), null, 'said once');
    } finally { t.mock.timers.reset(); }
  });
});

test('a share log refused at once, then said on his return, leaves nothing on the device; a cancelled send leaves nothing either', async (t) => {
  await onPage(async ({ shown, storage, win }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const doc = target();
      const authority = suspended();
      shareAtHandoff({ text: 'packet' }, {
        share: () => new Promise(() => {}),
        onHanded: () => { alertWriteRefused({ authority, section: 'shareLog' }); },
        watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      });
      await settle();
      assert.equal(storage.map.size, 1);
      doc.fire('pointerdown');
      t.mock.timers.tick(3000);
      assert.equal(shown.length, 1, 'said once, here');
      assert.equal(storage.map.size, 0);
    } finally { t.mock.timers.reset(); }
    let cancel;
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }),
      onHanded: () => { alertWriteRefused({ authority: suspended(), section: 'shareLog' }); },
      watch: () => () => {},
    });
    cancel();
    assert.equal(await done, 'cancelled');
    assert.equal(storage.map.size, 0, 'the send did not happen: nothing to say');
  });
});

test('a second desktop tab leaves a live tab\'s held alert to that tab: no "Before the app closed", and it is said once', async (t) => {
  await onPage(async ({ shown, storage, win }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const doc = target();
      const { authority, refuse } = checkedLater();
      shareAtHandoff({ text: 'packet' }, {
        share: () => new Promise(() => {}),
        onHanded: () => holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => {} }, authority),
        watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      });
      refuse();
      await settle();
      assert.equal(storage.map.size, 1);
      // Tab B opens (its own copy of the module, the same origin).
      const tabB = await import('../../src/utils/limitedLaunchAccess.js?second-tab');
      assert.equal(await tabB.takeHeldRefusalNotice('user_synthetic'), null, 'tab A is still open');
      assert.equal(storage.map.size, 1, 'and its note stays for it');
      // He returns to tab A.
      doc.fire('pointerdown');
      t.mock.timers.tick(3000);
      assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE], 'said once, by the tab that held it');
      assert.equal(storage.map.size, 0);
      assert.equal(await tabB.takeHeldRefusalNotice('user_synthetic'), null);
    } finally { t.mock.timers.reset(); }
  });
});
