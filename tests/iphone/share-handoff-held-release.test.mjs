// Review of 9484782c: the alert a share's hand-off holds (shareHandoff.js,
// holdWriteRefusalAlerts) waits for the sheet's answer or his return, never a
// timeout. Three ways that went wrong on the installed iPhone app:
//  1. a share log the check took back had its only alert in memory, waiting
//     on an event that may never come (the in-app compose sheet closes with
//     no focus event; or he swipes home and iOS discards the page);
//  2. a take-back the check refused later was caught by a hold dropped at
//     once, so a cancelled send stayed in Send history and nothing was said;
//  3. a focus while one sheet hands over to the next started the grace, and
//     no blur cancelled it, so the alert came over Mail's compose sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shareAtHandoff, watchShareUnanswered } from '../../src/utils/shareHandoff.js';
import { holdForAccess, takeHeldRefusalNotice, READ_ONLY_AFTER_CHECK_MESSAGE, HELD_REFUSAL_RELAUNCH_PREFIX } from '../../src/utils/limitedLaunchAccess.js';

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
  globalThis.window = target({ alert: m => shown.push(m) });
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, 'navigator', { value: { locks: new PageLocks() }, configurable: true, writable: true });
  // iOS discards the page: the next page starts with none of its locks.
  const discard = () => { globalThis.navigator.locks = new PageLocks(); };
  try { return await fn({ shown, storage, win: globalThis.window, discard }); }
  finally {
    for (const k of ['window', 'localStorage']) { if (had[k]) globalThis[k] = was[k]; else delete globalThis[k]; }
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator;
  }
}
const shareLogTakenBack = (authority, undone) => () => holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => undone.push('shareLog') }, authority);

test('1. a share log the check takes back while Mail is open is written down, and the next load of the app says it', async (t) => {
  await onPage(async ({ shown, storage, win, discard }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const doc = target();
      const { authority, refuse } = checkedLater();
      const undone = [];
      shareAtHandoff({ text: 'packet' }, {
        share: () => new Promise(() => {}), // Mail took over; the promise never settles
        onHanded: shareLogTakenBack(authority, undone),
        watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      });
      refuse();
      await settle();
      assert.deepEqual(undone, ['shareLog']);
      // He swipes home; iOS discards the page an hour later. Nothing was said.
      doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
      t.mock.timers.tick(60 * 60 * 1000);
      await settle();
      assert.deepEqual(shown, []);
      assert.equal(storage.map.size, 1, 'the held alert is on the device, not only in the page');
      // The page that loads next (a fresh copy of the module) says it once.
      discard();
      const relaunched = await import('../../src/utils/limitedLaunchAccess.js?relaunch-1');
      assert.equal(await relaunched.takeHeldRefusalNotice('user_another'), null, 'never to another account');
      assert.equal(await relaunched.takeHeldRefusalNotice('user_synthetic'), HELD_REFUSAL_RELAUNCH_PREFIX + READ_ONLY_AFTER_CHECK_MESSAGE);
      assert.equal(await relaunched.takeHeldRefusalNotice('user_synthetic'), null, 'said once');
    } finally { t.mock.timers.reset(); }
  });
});

test('1. the in-app compose sheet closing with no focus event: his first touch on the page says it, and the note on the device goes', async (t) => {
  await onPage(async ({ shown, storage, win }) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const doc = target();
      const { authority, refuse } = checkedLater();
      shareAtHandoff({ text: 'packet' }, {
        share: () => new Promise(() => {}),
        onHanded: shareLogTakenBack(authority, []),
        watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      });
      refuse();
      await settle();
      t.mock.timers.tick(10 * 60 * 1000);
      assert.deepEqual(shown, [], 'no timeout says it over the sheet');
      doc.fire('pointerdown');
      t.mock.timers.tick(3000);
      assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE]);
      assert.equal(storage.map.size, 0, 'said here, so not again on the next load');
      assert.equal(await takeHeldRefusalNotice('user_synthetic'), null);
    } finally { t.mock.timers.reset(); }
  });
});

test('1. a held alert dropped with a cancelled send leaves nothing on the device', async () => {
  await onPage(async ({ shown, storage }) => {
    const { authority, refuse } = checkedLater();
    let cancel;
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }),
      onHanded: shareLogTakenBack(authority, []),
      watch: () => () => {},
    });
    refuse();
    await settle();
    assert.equal(storage.map.size, 1);
    cancel();
    assert.equal(await done, 'cancelled');
    assert.equal(storage.map.size, 0);
    assert.deepEqual(shown, []);
  });
});

test('1. App says a held alert from a discarded page once the records are on screen', () => {
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /import \{ takeHeldRefusalNotice \} from "\.\/utils\/limitedLaunchAccess"/);
  assert.match(app, /if \(!loaded \|\| !user\?\.id\) return;[^]*?takeHeldRefusalNotice\(user\.id\)\.then\(\(notice\) => \{\s*if \(notice\) \{ try \{ window\.alert\(notice\); \}/);
  // Above the loading early returns: hooks are never conditional.
  assert.ok(app.indexOf('takeHeldRefusalNotice(user.id)') < app.indexOf('if (!authChecked'), 'effect sits above the early returns');
});

test('2. a cancel whose take-back the check refuses later is said: the send he cancelled stays in Send history', async () => {
  await onPage(async ({ shown }) => {
    const { authority, refuse } = checkedLater();
    const rows = [];
    let cancel;
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }),
      onHanded: () => { rows.push('log'); }, // allowed at once
      // deleteItem: the answer is old by now, so the delete waits for the check.
      onUndo: () => { rows.pop(); holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => rows.push('log') }, authority); },
      watch: () => () => {},
    });
    cancel();
    assert.equal(await done, 'cancelled');
    refuse();
    await settle();
    assert.deepEqual(rows, ['log'], 'the read-only answer puts the row back');
    assert.deepEqual(shown, [READ_ONLY_AFTER_CHECK_MESSAGE], 'and he is told his cancel was not applied');
  });
});

test('2. a cancel of a share log that itself waits for the check stays silent whatever the answer', async () => {
  await onPage(async ({ shown }) => {
    const { authority, refuse } = checkedLater();
    const rows = [];
    let cancel;
    const done = shareAtHandoff({ text: 'x' }, {
      share: () => new Promise((_, reject) => { cancel = () => reject(named('AbortError')); }),
      onHanded: () => { rows.push('log'); holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => rows.pop() }, authority); },
      onUndo: () => { rows.pop(); holdForAccess({ scopes: ['credential'], accountId: 'user_synthetic', section: 'shareLog', undo: () => rows.push('log') }, authority); },
      watch: () => () => {},
    });
    cancel();
    assert.equal(await done, 'cancelled');
    refuse();
    await settle();
    assert.deepEqual(rows, [], 'both taken back: nothing recorded for a send that did not happen');
    assert.deepEqual(shown, []);
  });
});

test('3. a focus then a blur (the share sheet handing over to Mail) does not say a held alert over the compose sheet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const doc = target(), win = target();
    let shown = 0;
    const holdAlerts = () => ({ stop() {}, show() { shown++; }, drop() {}, pending: false, awaiting: 0 });
    let rejectShare;
    const done = shareAtHandoff({}, {
      share: () => new Promise((_, reject) => { rejectShare = reject; }),
      holdAlerts,
      watch: (fn, opts) => watchShareUnanswered(fn, { ...opts, doc, win }),
      onHanded() {},
    });
    win.fire('focus');
    win.fire('blur');
    t.mock.timers.tick(3000);
    assert.equal(shown, 0, 'nothing over the compose sheet');
    assert.equal(win.listening('blur'), 1);
    // He is back: a touch on the page, then the grace.
    doc.fire('pointerdown');
    t.mock.timers.tick(3000);
    assert.equal(shown, 1);
    rejectShare(named('AbortError'));
    assert.equal(await done, 'cancelled');
    assert.equal(win.listening('blur') + win.listening('focus') + doc.listening('pointerdown') + doc.listening('visibilitychange'), 0, 'every listener removed');
  } finally { t.mock.timers.reset(); }
});
