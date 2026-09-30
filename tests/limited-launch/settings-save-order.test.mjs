// SETTINGS-007: every keystroke in a profile field (Languages, Address,
// Phone, CV highlight line...) calls updateSettings, which calls saveSettings
// with that one field. Each save was its own PATCH, sent side by side, so the
// one the server committed last won. A keystroke's PATCH held up on a slow
// network landed after the next letter's and the profile kept "Spanis"; the
// QA lab stored 'QA phone highligh' and '(555) 010-017' this way, and the app
// kept showing the full text until a reload.
//
// The real saveSettings (src/lib/supabase.js) against the recording in-memory
// client; the "server" below commits a PATCH when it answers it. Synthetic
// account, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture, deferred, tick } from './persistence-fixture.mjs';

const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const accountChanged = error => error.code === 'membership_account_changed';

/** A profile row that takes each PATCH when it answers it; the first `slow` requests wait for release(). */
function server(f, slow = 1) {
  const row = {}, gate = deferred();
  let n = 0;
  f.onRequest = async op => {
    if (++n <= slow) await gate.promise;
    if (op.error) return { error: op.error };
    Object.assign(row, op.value);
    return { data: { ...row }, error: null };
  };
  return { row, release: () => gate.resolve() };
}

test('a slow save for an earlier keystroke no longer overwrites the later one', async () => {
  const f = fixture();
  const s = server(f);
  const first = f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
  await settle();
  const second = f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
  await settle();
  assert.equal(f.requests.length, 1, 'the next save waits for the one on the wire');
  s.release();
  await Promise.all([first, second]);
  assert.deepEqual(f.requests.map(op => op.value.languages), ['Spanis', 'Spanish'], 'sent in the order typed');
  assert.equal(s.row.languages, 'Spanish', 'the profile keeps the whole word');
});

test('saves queued behind a slow one collapse to the newest value per field', async () => {
  const f = fixture();
  const s = server(f);
  const saves = [f.api.saveSettings('profileA', { cvHighlights: 'QA phone high' }, 'user_syntheticA')];
  await settle();
  for (const change of [{ cvHighlights: 'QA phone highl' }, { phone: '(555) 010-0170' }, { cvHighlights: 'QA phone highlight' }]) {
    saves.push(f.api.saveSettings('profileA', change, 'user_syntheticA'));
  }
  s.release();
  const results = await Promise.all(saves);
  assert.deepEqual(f.requests.map(op => Object.keys(op.value).filter(k => k !== 'updated_at')), [['cv_highlights'], ['phone'], ['cv_highlights']],
    'the waiting "QA phone highl" is not sent: the later save carries the same field');
  assert.equal(results[1], null, 'the save it replaced resolves with nothing to report');
  assert.equal(s.row.cv_highlights, 'QA phone highlight');
  assert.equal(s.row.phone, '(555) 010-0170', 'a different field waiting in between is still sent');
});

test('a save that fails does not stop the next one', async () => {
  const f = fixture();
  const row = {}, gate = deferred();
  let n = 0;
  f.onRequest = async op => {
    if (++n === 1) { await gate.promise; return { error: { code: 'offline', message: 'Synthetic offline' } }; }
    Object.assign(row, op.value);
    return { data: { ...row }, error: null };
  };
  const first = f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
  await settle();
  const second = f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 2);
  assert.equal(row.languages, 'Spanish');
  // The failed "Spanis" was queued for replay, and left the queue when the
  // newer value was stored (the next test).
  assert.equal(f.queue().length, 0);
});

test('a save waiting its turn when the account changes is never sent under the new account', async () => {
  const f = fixture();
  const s = server(f);
  const first = f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
  await settle();
  const second = f.api.saveSettings('profileA', { name: 'Synthetic A' }, 'user_syntheticA');
  f.switchAccount();
  s.release();
  await assert.rejects(first, accountChanged);
  await assert.rejects(second, accountChanged);
  assert.equal(f.requests.length, 1);
  assert.equal(f.queue('user_syntheticB').length, 0);
});

test('a device-only key typed while a save is on the wire is kept on this device at once', async () => {
  const f = fixture();
  const s = server(f);
  const first = f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
  await settle();
  const key = f.api.saveSettings('profileA', { apiKey: 'synthetic-device-value' }, 'user_syntheticA');
  assert.equal(JSON.parse(f.values.get('device:user_syntheticA')).apiKey, 'synthetic-device-value');
  s.release();
  await Promise.all([first, key]);
  for (const op of f.requests) assert.equal(Object.hasOwn(op.value, 'api_key'), false);
});

test('a keystroke queued after a network blip is not replayed over the text saved after it', async () => {
  const f = fixture();
  const row = {};
  let offline = true;
  f.onRequest = async op => {
    if (op.table === 'profiles' && offline) return { error: { code: 'offline', message: 'Synthetic offline' } };
    Object.assign(row, op.value);
    return { data: { ...row }, error: null };
  };
  await f.api.saveSettings('profileA', { languages: 'Spanis', address: '1 Synthetic Way' }, 'user_syntheticA');
  assert.deepEqual(f.queue().map(op => op.payload), [{ languages: 'Spanis', address: '1 Synthetic Way' }]);
  offline = false;
  await f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
  assert.deepEqual(f.queue().map(op => op.payload), [{ address: '1 Synthetic Way' }], 'only the field nothing newer saved stays queued');
  await f.api.replayPendingOps('profileA', 'user_syntheticA');
  assert.equal(row.languages, 'Spanish', 'the next load keeps the whole word');
  assert.equal(row.address, '1 Synthetic Way');
  assert.equal(f.queue().length, 0);
});

// ─── A save with no answer (review of SETTINGS-007) ──────────────────
// Saves wait for the one on the wire, and a PATCH has no timeout of its own.
// On a captive portal or a dead cellular link the first keystroke's PATCH
// could hang for minutes, and every later change to the profile (the rest of
// the field, the theme, a notification switch) waited in memory, neither sent
// nor queued: a reload lost them and the cloud's older profile came back. A
// save now gives up at SETTINGS_SEND_LIMIT_MS: its request is cancelled, it is
// queued like any save the network lost, and the next one goes.
const fieldsOf = op => Object.keys(op.value).filter(k => k !== 'updated_at');

test('a save with no answer is cancelled at the limit and queued, and the saves behind it go on', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const row = {}, never = deferred();
  f.onRequest = async op => {
    if (f.requests.length === 1) return never.promise;
    Object.assign(row, op.value);
    return { data: { ...row }, error: null };
  };
  const first = f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
  await settle();
  const theme = f.api.saveSettings('profileA', { theme: 'dark' }, 'user_syntheticA');
  const second = f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
  await settle();
  assert.equal(f.requests.length, 1, 'the later saves wait for the one on the wire');
  t.mock.timers.tick(f.api.SETTINGS_SEND_LIMIT_MS - 1);
  await settle();
  assert.equal(f.requests.length, 1, 'not before the limit');
  t.mock.timers.tick(1);
  assert.deepEqual(await Promise.all([first, theme, second]).then(r => r.map(x => x === null)), [true, false, false]);
  assert.equal(f.requests[0].signal?.aborted, true, 'the stalled request is cancelled, so it cannot land later over newer text');
  assert.deepEqual(f.requests.slice(1).map(fieldsOf), [['theme'], ['languages']], 'the saves behind it are sent, in order');
  assert.equal(row.theme, 'dark');
  assert.equal(row.languages, 'Spanish');
  // The cancelled 'Spanis' was queued, and left the queue when 'Spanish' landed.
  assert.equal(f.queue().length, 0);
});

test('while the network stays dead, each waiting save is queued within the limit, so a reload keeps them', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.onRequest = () => new Promise(() => {});
  const saves = [
    f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA'),
    f.api.saveSettings('profileA', { theme: 'dark' }, 'user_syntheticA'),
    f.api.saveSettings('profileA', { phone: '(555) 010-0170' }, 'user_syntheticA'),
  ];
  for (let i = 1; i <= saves.length; i++) {
    await settle();
    assert.equal(f.requests.length, i, 'one request on the wire at a time');
    t.mock.timers.tick(f.api.SETTINGS_SEND_LIMIT_MS);
  }
  assert.deepEqual(await Promise.all(saves), [null, null, null]);
  assert.ok(f.requests.every(op => op.signal?.aborted === true));
  assert.deepEqual(f.queue().map(op => op.payload), [{ languages: 'Spanish' }, { theme: 'dark' }, { phone: '(555) 010-0170' }],
    'every change is on the device for the next load to send');
});

test('a save that answers in time keeps no timer running', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  server(f, 0);
  await f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
  assert.equal(f.requests[0].signal?.aborted, false);
  t.mock.timers.tick(f.api.SETTINGS_SEND_LIMIT_MS);
  assert.equal(f.requests[0].signal.aborted, false, 'the timer was cleared when the answer came');
});

// ─── The notice hears when a queued keystroke leaves the queue ────────
// A keystroke whose save failed is queued, and the notice says "1 change has
// not reached your account yet". When the next keystroke's save lands it takes
// the older text out of the queue, but the notice was never told: it went on
// counting a change that was no longer queued for the rest of the session.
test('when a landed save takes a queued keystroke out of the queue, the notice hears of it', async () => {
  const f = fixture();
  const row = {};
  let offline = true;
  f.onRequest = async op => {
    if (op.table === 'profiles' && offline) return { error: { code: 'offline', message: 'Synthetic offline' } };
    Object.assign(row, op.value);
    return { data: { ...row }, error: null };
  };
  const heard = [];
  const stop = f.api.onSyncChange(account => heard.push(account));
  try {
    await f.api.saveSettings('profileA', { languages: 'Spanis' }, 'user_syntheticA');
    assert.equal(f.queue().length, 1);
    heard.length = 0;
    offline = false;
    await f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
    assert.deepEqual(heard, ['user_syntheticA'], 'the queue changed, so the notice counts it again');
    assert.equal(f.queue().length, 0, 'and finds nothing waiting');
    assert.equal(f.values.has('ops:user_syntheticA'), false, 'an emptied queue is removed, as the record queue does');
  } finally { stop(); }
});

test('a landed save that leaves the queue as it was does not wake the notice', async () => {
  const f = fixture();
  server(f, 0);
  const heard = [];
  const stop = f.api.onSyncChange(account => heard.push(account));
  try {
    await f.api.saveSettings('profileA', { languages: 'Spanish' }, 'user_syntheticA');
    assert.deepEqual(heard, []);
  } finally { stop(); }
});
