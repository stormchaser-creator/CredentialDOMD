// QA (on main after the settings fix): a record added, edited, deleted or
// starred before the page load's first membership answer was refused
// (writeStatus "refuse", reason "no_answer") with the native "Reconnecting,
// try again in a moment." alert, and what was typed was dropped. The member
// app opens from the loaded profile before that answer, so a quick first tap
// met it. An invoice recorded with Mark as sent in that window was refused
// the same way, after it had already gone out.
//
// Such a write is now held the way a write meeting an old answer is: shown at
// once, written to the pending queue at once (so a reload keeps it), sent
// when the answer allows it, taken back with the read-only message when the
// answer refuses it (an invoice that went out is kept, marked refused), and
// kept, counted by the in-app notice, when no answer comes. A device that
// remembers a membership that already denies the change is refused at once,
// as read-only, never "no_answer".
//
// Runs AppContext's save path (cut from the source), the real
// src/lib/supabase.js and the real access authority (no-answer-harness.mjs).
// Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as access from '../../src/utils/limitedLaunchAccess.js';
import * as held from '../../src/utils/heldChanges.js';
import { ACCOUNT, settle, active, revoked, fixture, replayOnAnswer, reportMessages } from './no-answer-harness.mjs';

const CME = '00000000-0000-4000-8000-00000000c001';
const INV = '00000000-0000-4000-8000-00000000c101';
const ENTRY = '00000000-0000-4000-8000-00000000c201';
const course = (extra = {}) => ({ id: CME, name: 'Synthetic Stroke Update', hours: 2, ...extra });
const ids = list => Array.from(list || [], item => item.id);
const find = (f, key, id) => (f.state[key] || []).find(item => item.id === id);
const sent = f => f.writes().map(op => `${op.table}.${op.method}`);
const queued = f => f.queue().map(op => op.op);
const expire = storage => storage.set(`ops:${ACCOUNT}`, JSON.stringify(JSON.parse(storage.get(`ops:${ACCOUNT}`) || '[]').map(op => ({ ...op, decidingUntil: Date.now() - 1 }))));
const KEPT = 'Save kept on device awaiting membership check (no_answer, cme)';

// The four record writes, each with what it shows, what it sends live and on
// replay, and what it queues.
const KINDS = {
  add: {
    records: () => ({}),
    act: f => f.app.addItem('cme', course()),
    shown: f => ids(f.state.cme).includes(CME),
    original: f => !ids(f.state.cme).includes(CME),
    live: ['cme.insert'], replay: ['cme.upsert'], ops: ['upsert'],
  },
  edit: {
    records: () => ({ cme: [course()] }),
    act: f => f.app.editItem('cme', course({ name: 'Synthetic Stroke Update 2026' })),
    shown: f => find(f, 'cme', CME)?.name === 'Synthetic Stroke Update 2026',
    original: f => find(f, 'cme', CME)?.name === 'Synthetic Stroke Update',
    live: ['cme.update'], replay: ['cme.upsert'], ops: ['upsert'],
  },
  delete: {
    records: () => ({ cme: [course()] }),
    act: f => f.app.deleteItem('cme', CME),
    shown: f => !ids(f.state.cme).includes(CME),
    original: f => ids(f.state.cme).includes(CME),
    live: ['cme.delete', 'deleted_items.upsert'], replay: ['cme.delete', 'deleted_items.upsert', 'deleted_items.upsert'], ops: ['delete', 'tombstone'],
  },
  star: {
    records: () => ({ cme: [course()] }),
    act: f => f.app.toggleFavorite('cme', CME),
    shown: f => find(f, 'cme', CME)?.favorite === true,
    original: f => find(f, 'cme', CME)?.favorite !== true,
    live: ['cme.update'], replay: ['cme.update'], ops: ['favorite'],
  },
};

for (const [name, kind] of Object.entries(KINDS)) {
  test(`${name} before the first answer: shown at once, no alert, sent when the answer allows it`, async () => {
    const f = fixture({ records: kind.records() });
    assert.equal(f.authority.state(), null, 'no answer yet this page load');
    assert.notEqual(kind.act(f), false, 'not refused');
    assert.ok(kind.shown(f), 'on screen at once');
    assert.deepEqual(f.alerts, [], 'no native "Reconnecting" alert');
    assert.deepEqual(f.reports, []);
    await settle();
    assert.deepEqual(f.writes(), [], 'nothing sent before the answer');
    assert.deepEqual(queued(f), kind.ops, 'written to the queue at once, so a reload keeps it');
    assert.ok(f.queue().every(op => op.awaitingAccess === true && typeof op.decidingUntil === 'number'));
    assert.equal(f.api.writtenAheadCount(ACCOUNT), kind.ops.length, 'the notice does not call it kept while this page decides it');
    assert.equal(f.checks.length, 1, 'it waits on the check that brings the answer');

    f.checks[0].answer(active());
    await settle();
    assert.deepEqual(sent(f), kind.live, 'sent once the answer allows it');
    if (name === 'star') assert.equal(f.writes()[0].value.favorite, true);
    if (name === 'edit') assert.equal(f.writes()[0].value.name, 'Synthetic Stroke Update 2026');
    assert.deepEqual(f.queue(), [], 'its queued copy is gone');
    assert.ok(kind.shown(f));
    // The replay AppContext runs on the same answer sends nothing twice.
    await replayOnAnswer(f);
    assert.deepEqual(sent(f), kind.live);
    assert.deepEqual(f.alerts, []);
    assert.deepEqual(f.reports, []);
  });

  test(`${name} before the first answer: taken back with the read-only message when the answer refuses it`, async () => {
    const f = fixture({ records: kind.records() });
    assert.notEqual(kind.act(f), false);
    assert.ok(kind.shown(f));
    assert.deepEqual(f.alerts, []);
    f.checks[0].answer(revoked());
    await settle();
    assert.ok(kind.original(f), 'taken back');
    assert.deepEqual(f.writes(), [], 'nothing sent');
    assert.deepEqual(f.queue(), [], 'nothing kept to send later');
    assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE], 'the existing read-only message, once the answer is in');
    assert.deepEqual(reportMessages(f), ['Save refused (read_only, cme)']);
  });

  test(`${name} before the first answer: kept and counted by the notice when no answer comes, never alerted`, async () => {
    const f = fixture({ records: kind.records() });
    assert.notEqual(kind.act(f), false);
    f.checks[0].fail(); // the check cannot reach the server
    await settle();
    assert.equal(f.authority.state(), null, 'still no answer');
    assert.ok(kind.shown(f), 'kept on screen');
    assert.deepEqual(f.writes(), [], 'nothing sent without an answer');
    assert.deepEqual(f.alerts, [], 'no alert');
    assert.deepEqual(queued(f), kind.ops, 'kept on the queue, once');
    assert.ok(f.queue().every(op => op.awaitingAccess === true && op.decidingUntil === undefined && op.accessRefused === undefined));
    assert.equal(f.api.writtenAheadCount(ACCOUNT), 0, 'counted by the notice now the wait is over');
    assert.deepEqual(reportMessages(f), [KEPT]);

    // A check that never answers at all ends at the backstop the same way.
    const g = fixture({ records: kind.records() });
    assert.notEqual(kind.act(g), false);
    await g.wait(access.ACCESS_VERIFY_TIMEOUT_MS);
    assert.ok(kind.shown(g));
    assert.deepEqual(g.alerts, []);
    assert.deepEqual(queued(g), kind.ops);

    // The connection comes back: the answer arrives and the replay sends it.
    f.authority.accept(ACCOUNT, active());
    await replayOnAnswer(f);
    assert.deepEqual(sent(f), kind.replay);
    assert.deepEqual(f.queue(), []);
    assert.deepEqual(f.alerts, []);
  });

  test(`${name} before the first answer survives a reload: the next page shows it and its answer sends it`, async () => {
    const storage = new Map();
    const first = fixture({ records: kind.records(), storage });
    assert.notEqual(kind.act(first), false);
    await settle();
    // The page is left while the answer is still out: nothing more runs there.
    assert.deepEqual(queued(first), kind.ops, 'already on the queue');

    const next = fixture({ records: kind.records(), storage });
    assert.deepEqual(queued(next), kind.ops, 'the reload still has it');
    assert.equal(next.api.writtenAheadCount(ACCOUNT), kind.ops.length, 'not counted while it is marked as being decided');
    expire(storage);
    assert.equal(next.api.writtenAheadCount(ACCOUNT), 0, 'counted once the mark runs out');
    // The load lays a kept delete or star over the records it reads back
    // (an add or an edit comes back from the device copy, the self-heal).
    const shown = held.applyHeldQueue({ settings: {}, cme: [course()] }, next.queue(), ['cme']).data;
    if (name === 'delete') assert.deepEqual(ids(shown.cme), []);
    if (name === 'star') assert.equal(shown.cme[0].favorite, true);
    // Before the answer, a load's replay sends nothing.
    await replayOnAnswer(next);
    assert.deepEqual(next.writes(), []);
    next.authority.accept(ACCOUNT, active());
    await replayOnAnswer(next);
    assert.deepEqual(sent(next), kind.replay);
    assert.deepEqual(next.queue(), []);

    // A refusing answer on the new page: kept, marked refused, never sent.
    const store2 = new Map();
    const a = fixture({ records: kind.records(), storage: store2 });
    kind.act(a);
    await settle();
    expire(store2);
    const b = fixture({ records: kind.records(), storage: store2 });
    b.authority.accept(ACCOUNT, revoked());
    const replayed = await replayOnAnswer(b);
    assert.deepEqual(b.writes(), []);
    assert.deepEqual(Array.from(replayed.refused), ['cme']);
    assert.ok(b.queue().every(op => op.accessRefused === true), 'the notice says it was not saved');
  });
}

test('another tab does not replay a record this tab is still deciding, which this tab\'s refusal then takes back', async () => {
  const storage = new Map();
  const a = fixture({ storage });
  assert.notEqual(a.app.addItem('cme', course()), false);
  await settle();
  const b = fixture({ storage, answered: true });
  await replayOnAnswer(b);
  assert.deepEqual(b.writes(), [], 'tab B leaves tab A\'s copy to tab A');
  assert.equal(b.api.writtenAheadCount(ACCOUNT), 1);
  a.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(ids(a.state.cme), []);
  assert.deepEqual(a.queue(), []);
  await replayOnAnswer(b);
  assert.deepEqual([...a.writes(), ...b.writes()], [], 'the refused add never reached the account');
});

// ─── An invoice recorded with Mark as sent / Record as sent (SENT_WORK) ───
const invoice = () => ({ id: INV, number: 'INV-0001', contractId: null, entryIds: [ENTRY], totalAmount: 1200, method: 'marked', sentAt: '2026-09-30T18:00:00.000Z', paidAt: null });
const entry = (extra = {}) => ({ id: ENTRY, contractId: null, type: 'Call', date: '2026-09-29', durationMin: 60, ...extra });
// markBilledAndLog: the invoice, then the entries it billed, both as sent work.
const record = f => {
  const recorded = f.app.addItem('invoices', invoice(), access.SENT_WORK);
  if (recorded !== false) f.app.editItem('workLog', entry({ invoiceId: INV }), access.SENT_WORK);
  return recorded;
};
const billed = f => find(f, 'invoices', INV) && find(f, 'workLog', ENTRY)?.invoiceId === INV;

test('an invoice recorded before the first answer is recorded at once and sent when the answer allows it', async () => {
  const f = fixture({ records: { workLog: [entry()] } });
  assert.notEqual(record(f), false, 'Mark as sent records it');
  assert.ok(billed(f), 'on the Invoices tab, its entry billed');
  assert.deepEqual(f.alerts, []);
  await settle();
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(queued(f), ['upsert', 'upsert']);
  f.checks[0].answer(active());
  await settle();
  assert.deepEqual(sent(f), ['invoices.insert', 'work_log.update']);
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(f.reports, []);
});

test('an invoice recorded before the first answer stays recorded when the answer refuses it, marked refused', async () => {
  const f = fixture({ records: { workLog: [entry()] } });
  assert.notEqual(record(f), false);
  f.checks[0].answer(revoked());
  await settle();
  assert.ok(billed(f), 'the invoice went out: taking it back would leave its entry billable again');
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.queue().map(op => [op.collectionKey, op.awaitingAccess, op.accessRefused, op.decidingUntil]),
    [['invoices', true, true, undefined], ['workLog', true, true, undefined]], 'kept, and the notice says it was not saved');
  assert.deepEqual(f.alerts, [], 'told by the notice, not alerted');
  assert.deepEqual(reportMessages(f).sort(), ['Save refused (read_only, invoices)', 'Save refused (read_only, workLog)']);
});

test('an invoice recorded before the first answer is kept when no answer comes, and survives a reload', async () => {
  const f = fixture({ records: { workLog: [entry()] } });
  assert.notEqual(record(f), false);
  f.checks[0].fail();
  await settle();
  assert.ok(billed(f));
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(f.queue().map(op => [op.collectionKey, op.awaitingAccess, op.accessRefused]), [['invoices', true, undefined], ['workLog', true, undefined]]);
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
  f.authority.accept(ACCOUNT, active());
  await replayOnAnswer(f);
  assert.deepEqual(sent(f), ['invoices.upsert', 'work_log.upsert']);
  assert.deepEqual(f.queue(), []);

  const storage = new Map();
  const first = fixture({ records: { workLog: [entry()] }, storage });
  assert.notEqual(record(first), false);
  await settle();
  const next = fixture({ storage });
  expire(storage);
  next.authority.accept(ACCOUNT, active());
  await replayOnAnswer(next);
  assert.deepEqual(sent(next), ['invoices.upsert', 'work_log.upsert'], 'the reloaded page sends it on its answer');
  assert.deepEqual(next.queue(), []);
});

// ─── A device that remembers an answer that denies the change ──────────
const remembers = value => ({ read: () => value, write() {} });

test('a remembered answer that denies the change is refused as read-only, never as no_answer', () => {
  const f = fixture({ memory: remembers({ credential: false, practice: false }) });
  assert.deepEqual(f.authority.writeStatus('credential'), { status: 'refuse', reason: 'read_only' });
  assert.deepEqual(f.authority.settingsStatus({ npi: '1234567893' }), { status: 'refuse', reason: 'read_only' });
  assert.equal(access.writeRefusalReason(f.authority, 'credential'), 'read_only');
  // The lab's "Save refused (no_answer, settings)" for an ended membership.
  assert.equal(f.app.updateSettings({ npi: '1234567893' }), false);
  assert.deepEqual(reportMessages(f), ['Save refused (read_only, settings)']);
  assert.deepEqual(f.alerts, [], 'shown on the page already, not alerted');
  // Outdated still says so, and no check at all is still "not connected" for an open scope.
  const g = fixture({ memory: remembers({ credential: true, practice: false }) });
  g.authority.setRecheck(null);
  assert.equal(g.authority.writeStatus('credential').reason, 'not_connected');
  assert.equal(g.authority.writeStatus('practice').reason, 'read_only');
});

test('a record write on a device that remembers a denying answer is not held: refused at once as read-only', async () => {
  const f = fixture({ memory: remembers({ credential: false, practice: false }) });
  assert.equal(f.app.addItem('cme', course()), false);
  assert.deepEqual(ids(f.state.cme), [], 'not shown');
  await settle();
  assert.deepEqual(f.queue(), [], 'not queued');
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.alerts, [access.membershipWriteError().message], 'the read-only message, not "Reconnecting"');
  assert.deepEqual(reportMessages(f), ['Save refused (read_only, cme)']);

  // Only the scope the device remembers as ended: Credential is held, Practice is refused.
  const g = fixture({ memory: remembers({ credential: true, practice: false }) });
  assert.notEqual(g.app.addItem('cme', course()), false, 'held for the answer');
  assert.equal(g.app.addItem('invoices', invoice(), access.SENT_WORK), false, 'refused at once');
  assert.deepEqual(reportMessages(g), ['Save refused (read_only, invoices)']);
});

test('a load\'s replay before the answer marks nothing refused on a remembered answer alone', async () => {
  const storage = new Map();
  const a = fixture({ storage });
  a.app.addItem('cme', course());
  a.checks[0].fail();
  await settle();
  assert.deepEqual(queued(a), ['upsert']);
  const b = fixture({ storage, memory: remembers({ credential: false, practice: false }) });
  const replayed = await replayOnAnswer(b);
  assert.deepEqual(b.writes(), []);
  assert.deepEqual(Array.from(replayed?.refused || []), []);
  assert.equal(b.queue()[0].accessRefused, undefined, 'still kept for the answer, not called refused');
  b.authority.accept(ACCOUNT, active());
  await replayOnAnswer(b);
  assert.deepEqual(sent(b), ['cme.upsert']);
});

test('once the answer is in, nothing changes: allowed records go straight up, refused ones are refused as before', async () => {
  const f = fixture({ answered: true });
  assert.notEqual(f.app.addItem('cme', course()), false);
  await settle();
  assert.deepEqual(sent(f), ['cme.insert']);
  assert.equal(f.checks.length, 0, 'no wait');
  assert.deepEqual(f.queue(), []);

  const r = fixture();
  r.authority.accept(ACCOUNT, revoked());
  assert.equal(r.app.addItem('cme', course()), false);
  assert.deepEqual(r.alerts, [access.membershipWriteError().message]);
  assert.deepEqual(r.writes(), []);

  // No check that could bring an answer: refused as before.
  const n = fixture();
  n.authority.setRecheck(null);
  assert.equal(n.app.addItem('cme', course()), false);
  assert.deepEqual(n.alerts, [access.NOT_CONNECTED_MESSAGE]);
});

test('a document with its file is held before the first answer but not written ahead: one copy of its bytes, queued once when no answer comes', async () => {
  const DOC = '00000000-0000-4000-8000-00000000d001';
  const f = fixture();
  assert.notEqual(f.app.addItem('documents', { id: DOC, name: 'Synthetic licence.pdf', type: 'application/pdf', size: 4, data: 'data:application/pdf;base64,JVBERg==' }), false);
  assert.deepEqual(ids(f.state.documents), [DOC], 'shown at once');
  await settle();
  assert.deepEqual(f.queue(), [], 'its bytes are not copied to the queue while it waits');
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.collectionKey, op.awaitingAccess]), [['upsert', 'documents', true]]);
  assert.deepEqual(f.alerts, []);
});

// ─── Review of the fix (2026-09-30, round 4) ───────────────────────────

// R4.1: the Clerk session was replaced (or ended: an expired session keeps
// the queue for the same account's next sign-in, storageScope.js) while a
// write waited for the first answer. heldForAccess's catch, and saveSettings'
// rejection handler, took its written-ahead copy off the queue, while the
// change stayed on screen and was reported kept: the next sign-in lost a
// delete or a star outright. The copy now stays for that account's replay.
for (const [name, kind] of Object.entries(KINDS)) {
  test(`R4.1 ${name} before the first answer: the session changing while it waits keeps its queued copy`, async () => {
    const f = fixture({ records: kind.records() });
    assert.notEqual(kind.act(f), false);
    await settle();
    assert.deepEqual(queued(f), kind.ops);
    // The session object is gone (expired); the same user is still listed.
    f.clerk.session = { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token-2' };
    f.checks[0].fail();
    await settle();
    assert.deepEqual(queued(f), kind.ops, 'still on the queue for this account\'s next load');
    assert.ok(f.queue().every(op => op.awaitingAccess === true && op.decidingUntil === undefined), 'decided: kept, counted by the notice');
    assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
    assert.deepEqual(f.writes(), [], 'nothing sent under the new session');
    assert.ok(kind.shown(f));
    assert.deepEqual(f.alerts, []);
  });
}

test('R4.1 settings before the first answer: the session changing while it waits keeps its queued copy', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings({ name: 'Synthetic Physician MD' }), false);
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.payload?.name]), [['settings', 'Synthetic Physician MD']]);
  f.clerk.session = { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token-2' };
  f.checks[0].fail();
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.payload?.name, op.decidingUntil]), [['settings', 'Synthetic Physician MD', undefined]]);
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.state.settings.name, 'Synthetic Physician MD');
  assert.deepEqual(f.alerts, []);
});

test('R4.1 a refusal still takes the written-ahead copy off the queue (records and settings)', async () => {
  const f = fixture({ records: { cme: [course()] } });
  f.app.deleteItem('cme', CME);
  f.app.updateSettings({ name: 'Synthetic Physician MD' });
  await settle();
  assert.deepEqual(queued(f).sort(), ['delete', 'settings', 'tombstone']);
  f.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(f.queue(), []);
  assert.deepEqual(f.writes(), []);
});

// R4.2: a Setup board stamp made before the first answer, refused by that
// answer, was taken back quietly but still reported "Save refused
// (read_only, settings)": a refused save nobody made. updateSettings promises
// an automatic stamp is never reported, as its immediate refusal is not.
test('R4.2 a board stamp before the first answer that the answer refuses is neither alerted nor reported', async () => {
  const f = fixture();
  const stamp = { setupState: { v: 1, startedAt: '2026-09-30T10:00:00.000Z', tasks: {}, declared: {} } };
  assert.notEqual(f.app.updateSettings(stamp, { automatic: true }), false);
  await settle();
  f.checks[0].answer(revoked());
  await settle();
  assert.equal(f.state.settings.setupState, undefined, 'taken back');
  assert.deepEqual(f.alerts, []);
  assert.deepEqual(f.reports, [], 'no "Save refused (read_only, settings)" for a stamp nobody made');
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.queue(), []);

  // A member's edit in the same round is still reported, once.
  const g = fixture();
  g.app.updateSettings(stamp, { automatic: true });
  g.app.updateSettings({ name: 'Synthetic Physician MD' });
  await settle();
  g.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(reportMessages(g), ['Save refused (read_only, settings)']);
  assert.deepEqual(g.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE]);
});

// ─── Review of the fix (2026-09-30, round 5) ───────────────────────────

// R5.1: the session object was replaced for the same account while a write
// waited, and the answer then refused it. authorizeOwner's identity guard ran
// before the refusal was read, so the write failed as an account change and
// its written-ahead copy was kept, while the screen (the account still
// served) took the change back with the read-only alert. The next load laid
// the delete over the restored record again, and once the membership allowed
// changes the delete went out. A refused change now leaves the queue whatever
// failed first.
const replaceSession = f => { f.clerk.session = { user: { id: ACCOUNT }, getToken: async () => 'synthetic-token-2' }; };
for (const [name, kind] of Object.entries(KINDS)) {
  test(`R5.1 ${name} before the first answer: a session replaced while it waits, then a refusal, leaves nothing queued`, async () => {
    const f = fixture({ records: kind.records() });
    assert.notEqual(kind.act(f), false);
    await settle();
    assert.deepEqual(queued(f), kind.ops);
    replaceSession(f);
    f.checks[0].answer(revoked());
    await settle();
    assert.ok(kind.original(f), 'taken back on screen');
    assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE]);
    assert.deepEqual(f.queue(), [], 'what was taken back is not queued');
    assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
    assert.deepEqual(f.writes(), []);

    // The next load, the membership allowing changes again: nothing is sent.
    const next = fixture({ records: kind.records(), storage: f.values, answered: true });
    assert.ok(kind.original(next), 'the next load shows what the member was told was kept');
    await replayOnAnswer(next);
    await settle();
    assert.deepEqual(next.writes(), []);
  });
}

test('R5.1 settings before the first answer: a session replaced while it waits, then a refusal, leaves nothing queued', async () => {
  const f = fixture();
  assert.notEqual(f.app.updateSettings({ name: 'Synthetic Physician MD' }), false);
  await settle();
  assert.deepEqual(queued(f), ['settings']);
  replaceSession(f);
  f.checks[0].answer(revoked());
  await settle();
  assert.equal(f.state.settings.name, 'Synthetic Physician', 'taken back on screen');
  assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE]);
  assert.deepEqual(f.queue(), []);
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
  const next = fixture({ storage: f.values, answered: true });
  await replayOnAnswer(next);
  await settle();
  assert.deepEqual(next.writes(), [], 'the name the member was told was not kept is never sent');
});

test('R5.1 an invoice recorded before the first answer stays kept, marked refused, when the session is replaced and the answer refuses', async () => {
  const f = fixture({ records: { workLog: [entry()] } });
  assert.notEqual(record(f), false);
  await settle();
  replaceSession(f);
  f.checks[0].answer(revoked());
  await settle();
  assert.ok(billed(f), 'the invoice went out: kept on screen');
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.queue().map(op => [op.collectionKey, op.awaitingAccess, op.accessRefused, op.decidingUntil]),
    [['invoices', true, true, undefined], ['workLog', true, true, undefined]], 'kept, and the notice says it was not saved');
});

// R5.2: a settings save's written-ahead copy was decided only when the whole
// save settled, after its PATCH. A session replaced after the PATCH landed
// but before its response was read failed the identity guard, and the copy
// that had already reached the server stayed queued, counted as unsent and
// replayed on the next load over whatever changed meanwhile. The copy is now
// decided with the wait, as a record's is, before the PATCH goes out.
test('R5.2 a settings save that reached the server is not left queued when the session changes before its response is read', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ onRequest: async op => {
    if (op.table === 'profiles' && op.method === 'update') { await gate; return { data: { name: 'Synthetic Physician MD' }, error: null }; }
    return { data: [], error: null };
  } });
  assert.notEqual(f.app.updateSettings({ name: 'Synthetic Physician MD' }), false);
  await settle();
  assert.deepEqual(queued(f), ['settings'], 'written ahead');
  f.checks[0].answer(active());
  await settle();
  assert.deepEqual(sent(f), ['profiles.update'], 'the PATCH is out');
  assert.deepEqual(f.queue(), [], 'decided with the answer, before the PATCH');
  replaceSession(f);
  release();
  await settle();
  assert.deepEqual(f.queue(), [], 'a save that landed is not queued to be sent again');
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
});

test('R5.2 a settings save allowed by the first answer whose PATCH fails is still queued for replay', async () => {
  const f = fixture({ onRequest: async op => (op.table === 'profiles' && op.method === 'update'
    ? { data: null, error: { message: 'synthetic network failure' } } : { data: [], error: null }) });
  assert.notEqual(f.app.updateSettings({ name: 'Synthetic Physician MD' }), false);
  await settle();
  f.checks[0].answer(active());
  await settle();
  assert.deepEqual(f.queue().map(op => [op.op, op.payload?.name, op.decidingUntil]), [['settings', 'Synthetic Physician MD', undefined]]);
  assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
});

// ─── Review of the fix (2026-09-30, round 6) ───────────────────────────

// R6.1: the R5.1 reorder read any settled refusal as the answer's, before
// the identity guard. A Clerk session that really ends takes Clerk.user with
// it, so the authority (which reads window.Clerk.user) had no state for the
// account and the settled status was refuse "no_answer" (or "not_connected"
// once the access hook unmounted with <SignedIn>), while the authority still
// served it: no reset(null) runs on an involuntary sign-out. The written-ahead
// copy was dropped, the change taken back, and the native "Reconnecting"
// alert shown: the R4.1 copy for the next sign-in was lost. A status settled
// after Clerk stopped reporting the write's account is now "account_changed",
// which is not an answer: the copy stays and nothing is said or reported.
const endSession = f => { f.clerk.session = null; f.clerk.user = null; };
const switchAccount = f => { const id = 'user_SyntheticGateB'; f.clerk.user = { id }; f.clerk.session = { user: { id }, getToken: async () => 'synthetic-token-B' }; };
// <SignedIn> unmounts AppProvider: the access hook's cleanups drop the check
// in flight (its promise resolves with no answer) and unsubscribe recheck.
const unmount = f => { f.authority.setRecheck(null); f.checks[0].done(); };
const ENDINGS = {
  'the session ends and the check fails': f => { endSession(f); f.checks[0].fail(); },
  'the session ends and the provider unmounts': f => { endSession(f); unmount(f); },
  'another account signs in before the reset': f => { switchAccount(f); f.checks[0].fail(); },
};
for (const [how, end] of Object.entries(ENDINGS)) {
  for (const [name, kind] of Object.entries(KINDS)) {
    test(`R6.1 ${name} before the first answer, then ${how}: the queued copy stays, no alert`, async () => {
      const f = fixture({ records: kind.records() });
      assert.notEqual(kind.act(f), false);
      await settle();
      assert.deepEqual(queued(f), kind.ops);
      end(f);
      await settle();
      assert.ok(f.authority.serves(ACCOUNT), 'no reset(null) ran');
      assert.deepEqual(queued(f), kind.ops, 'kept for this account\'s next sign-in');
      assert.ok(f.queue().every(op => op.awaitingAccess === true && op.decidingUntil === undefined), 'decided: kept');
      assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
      assert.ok(kind.shown(f), 'not taken back');
      assert.deepEqual(f.alerts, [], 'no "Reconnecting" alert');
      assert.ok(!reportMessages(f).some(message => message.startsWith('Save refused')), 'not reported refused');
      assert.deepEqual(f.writes(), []);

      // The same account's next sign-in, membership allowing changes: sent.
      const next = fixture({ records: kind.records(), storage: f.values, answered: true });
      await replayOnAnswer(next);
      await settle();
      assert.deepEqual(sent(next), kind.replay);
    });
  }

  test(`R6.1 settings before the first answer, then ${how}: the queued copy stays, no alert`, async () => {
    const f = fixture();
    assert.notEqual(f.app.updateSettings({ name: 'Synthetic Physician MD' }), false);
    await settle();
    assert.deepEqual(queued(f), ['settings']);
    end(f);
    await settle();
    assert.deepEqual(f.queue().map(op => [op.op, op.payload?.name, op.decidingUntil]), [['settings', 'Synthetic Physician MD', undefined]]);
    assert.equal(f.api.writtenAheadCount(ACCOUNT), 0);
    assert.equal(f.state.settings.name, 'Synthetic Physician MD', 'not taken back');
    assert.deepEqual(f.alerts, []);
    assert.ok(!reportMessages(f).some(message => message.startsWith('Save refused')));
    assert.deepEqual(f.writes(), []);
  });
}

test('R6.1 an invoice recorded before the first answer stays kept, not marked refused, when the session ends', async () => {
  const f = fixture({ records: { workLog: [entry()] } });
  assert.notEqual(record(f), false);
  await settle();
  endSession(f);
  f.checks[0].fail();
  await settle();
  assert.ok(billed(f));
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.queue().map(op => [op.collectionKey, op.awaitingAccess, op.accessRefused, op.decidingUntil]),
    [['invoices', true, undefined, undefined], ['workLog', true, undefined, undefined]]);
  assert.deepEqual(f.alerts, []);
});

// Must still pass: with the account still signed in, the same settled
// no-answer status keeps the copy (R4.1), and a real answer refuses (R5.1).
test('R6.1 with the account still signed in, a refusal by the answer still takes the copy off the queue', async () => {
  const f = fixture({ records: { cme: [course()] } });
  f.app.deleteItem('cme', CME);
  await settle();
  f.checks[0].answer(revoked());
  await settle();
  assert.deepEqual(f.queue(), []);
  assert.ok(ids(f.state.cme).includes(CME), 'taken back');
  assert.deepEqual(f.alerts, [access.READ_ONLY_AFTER_CHECK_MESSAGE]);
});

test('R6.1 a settled status for an account Clerk no longer reports is account_changed, not an answer', () => {
  const f = fixture();
  assert.equal(f.authority.statusFor(['credential'], ACCOUNT, { awaitAnswer: true }).reason, 'no_answer');
  endSession(f);
  assert.deepEqual(f.authority.statusFor(['credential'], ACCOUNT, { settled: true, awaitAnswer: true }), { status: 'refuse', reason: 'account_changed' });
  // Before settling, what the screens ask is unchanged.
  assert.equal(f.authority.statusFor(['credential'], ACCOUNT, { awaitAnswer: true }).reason, 'no_answer');
});
