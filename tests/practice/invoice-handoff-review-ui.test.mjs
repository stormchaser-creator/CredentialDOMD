import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// Review of the share-sheet hand-off (ticket "Invoicce", 2026-09-30), driven
// through the real Work Log, Days & call and Expenses on synthetic data:
//  - a share that answers after Mark as sent recorded the invoice and the
//    next one is open never records the same number a second time;
//  - Record it checks only the days a note says it billed, and asks before
//    recording a note's number for days that come to another total;
//  - a recorded invoice clears its share stamp on the server, so a delete or
//    a record under another number never brings back "never recorded", and
//    the Mac never offers to record again what the phone has recorded;
//  - a note known only from the server says so, and Record it asks first;
//  - the note is keyed by the Clerk id, the same offline and online, and a
//    stamp or an unstamp the server could not take is sent again later.
// Synthetic contracts, entries, amounts and numbers only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { WorkLog, DutyLog, Expenses } = S;

const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const inputOf = (m, label) => field(m.render(), label).props.children;
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const modal = (m, title) => find(m.render(), n => n.props?.title === title, title);

function webStorage() {
  const m = new Map();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }, clear: () => m.clear(),
  };
}
function indexedDb() {
  const rows = new Map();
  const later = (fn) => queueMicrotask(fn);
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        get: (k) => { const r = {}; later(() => { r.result = rows.has(k) ? JSON.parse(rows.get(k)) : undefined; r.onsuccess?.(); }); return r; },
        put: (v, k) => { rows.set(k, JSON.stringify(v)); later(() => tx.oncomplete?.()); return {}; },
        delete: (k) => { rows.delete(k); later(() => tx.oncomplete?.()); return {}; },
      });
      return tx;
    },
  };
  return { rows, open: () => { const r = { result: db }; later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
function device() {
  const d = { session: webStorage(), local: webStorage(), idb: indexedDb() };
  setGlobal('sessionStorage', d.session); setGlobal('localStorage', d.local); setGlobal('indexedDB', d.idb);
  return d;
}

const shares = [];
const nav = (share) => setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share });
const never = (d) => { shares.push(d); return new Promise(() => {}); };
// A share sheet that answers when the test says: a send, or (cancel) the
// AbortError iOS can give even after a completed share.
function later() {
  const pending = [];
  nav((d) => { shares.push(d); return new Promise((resolve, reject) => pending.push({ resolve, reject })); });
  return {
    answer: () => pending.shift()?.resolve(),
    cancel: () => { const err = new Error('Share canceled'); err.name = 'AbortError'; pending.shift()?.reject(err); },
  };
}

const reports = [];
const stamps = [];
function fresh() {
  shares.length = 0; reports.length = 0; stamps.length = 0;
  S._resetInvoiceHandoff(); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter((message, extra) => reports.push(extra.event));
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  return device();
}
// The server's side of the share stamps. `offline` makes every request fail
// as supabase-js answers a failed fetch (an error without a code);
// `offlineFor(shared)` only the stamps (true) or the unstamps (false).
const server = () => {
  const srv = {
    rows: new Map(), offline: false, offlineFor: null, listed: 0,
    markShared: (number, { shared, contractId }) => {
      stamps.push([number, shared, contractId]);
      if (srv.offline || srv.offlineFor === shared) return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } });
      if (shared) srv.rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else srv.rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => {
      srv.listed += 1;
      if (srv.offline) return Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } });
      return Promise.resolve({ data: [...srv.rows.values()], error: null });
    },
  };
  return srv;
};

const C = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000,
  stipendHours: 24, overageHourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-05', end: '2026-09-07' }] };
const e = (id, d, h) => ({ id, createdAt: `${d}T${h}:30:00Z`, contractId: 'c-s', type: 'Call', date: d, callDay: d,
  startTime: `${d}T${h}:00:00.000Z`, endTime: `${d}T${h}:30:00.000Z`, durationMin: 30, billedMin: 30, description: 'Consult', privateNote: '', invoiceId: null });
const ENTRIES = () => [e('a', '2026-09-05', '15'), e('b', '2026-09-06', '16'), e('c', '2026-09-07', '17')];

// The signed-in account as AppContext gives it: the Clerk user, and the
// profile id once an online load has run (null offline).
function signIn(m, { clerk = 'user_syntheticClerk', profile = null } = {}) {
  Object.assign(globalThis.__screen.app, { user: { id: clerk }, userIdRef: { current: profile } });
  return m;
}
function openWork({ data, srv, confirm, clerk, profile } = {}) {
  const m = mount(WorkLog, { data: data || { locumContracts: [C], workLog: ENTRIES(), invoices: [] }, storage: { lastContract: 'c-s' }, confirm });
  if (srv) Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  if (clerk !== undefined || profile !== undefined) signIn(m, { clerk, profile });
  return m;
}
// A new page: memory gone, the stores stay. `data` is what this page loads.
async function page(m, { srv, data, confirm, clerk, profile } = {}) {
  S._resetInvoiceHandoff();
  const again = openWork({ data: data || { locumContracts: m.data.locumContracts, workLog: m.data.workLog, invoices: m.data.invoices }, srv, confirm, clerk, profile });
  again.render();
  await settle();
  return again;
}
const build = (m, days = 3) => { tap(m, t => /Invoice \d+ unbilled/.test(t), 'Invoice CTA'); tap(m, t => new RegExp(`^Invoice ${days} days?`).test(t), `${days} days`); };
const numberOf = (m) => shown(m).match(/INV-\d{8}-\d+/)[0];
async function sendPdf(m) {
  tap(m, t => t.startsWith('Send invoice'), 'Send invoice');
  find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf');
  await settle();
}
const markSent = (m, number) => {
  tap(m, t => t === 'Sent it already? Mark as sent', 'Mark as sent');
  if (number) inputOf(m, 'Invoice number').props.onChange({ target: { value: number } });
  tap(m, t => t === 'Record as sent', 'Record as sent');
};
const picked = (m) => modal(m, 'Which days go on this invoice?');
const pickedDays = (m) => find(m.render(), n => n.props?.selected instanceof Set && typeof n.props?.onChange === 'function', 'day picker').props;

// ── A share that answers late ──

test('Work log: a share that answers after Mark as sent recorded it and the next invoice is open records nothing a second time', async () => {
  fresh(); const sheet = later(); const srv = server();
  const m = openWork({ srv });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  markSent(m);
  const [first] = recorded(m);
  assert.equal(first?.number, number);
  await wait(1600); // the preview closes after its check mark
  // One more covered day, logged and invoiced.
  m.data.locumContracts = [{ ...C, coveragePeriods: [{ start: '2026-09-05', end: '2026-09-08' }] }];
  m.data.workLog = [...m.data.workLog, e('d', '2026-09-08', '15')];
  build(m, 1);
  const next = numberOf(m);
  assert.notEqual(next, number);

  sheet.answer(); // the first share sheet finally says it sent
  await settle();
  assert.deepEqual(recorded(m).map(i => i.number), [number], 'one invoice numbered as the copy sent');
  for (const id of ['a', 'b', 'c']) assert.equal(m.data.workLog.find(x => x.id === id).invoiceId, first.id, `entry ${id} stays on the first record`);
  assert.equal(m.data.workLog.find(x => x.id === 'd').invoiceId, null, 'the new day is not billed by it');
  await wait(1600);
  assert.equal(modal(m, 'Invoice preview').props.open, true, 'the new preview is not closed by the old send');
  assert.match(shown(m), new RegExp(next));
});

test('Days & call and Expenses: a share that answers after Mark as sent and a new invoice records nothing a second time', async () => {
  fresh(); const sheet = later();
  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const day = (id, date) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null });
  const d = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-08')], invoices: [] }, props: { contract: DAILY } });
  tap(d, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA');
  tap(d, t => t.startsWith('Invoice 1 day'), 'build');
  const dn = numberOf(d);
  await sendPdf(d);
  markSent(d);
  const [first] = recorded(d);
  await wait(1600);
  d.data.dutyDays = [...d.data.dutyDays, day('d2', '2026-09-09')];
  tap(d, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA');
  tap(d, t => t.startsWith('Invoice 1 day'), 'build');
  sheet.answer();
  await settle();
  assert.deepEqual(recorded(d).map(i => i.number), [dn]);
  assert.equal(d.data.dutyDays.find(x => x.id === 'd1').invoiceId, first.id);
  assert.equal(d.data.dutyDays.find(x => x.id === 'd2').invoiceId, null);

  S._resetHeldInvoiceNumbers();
  const x = mount(Expenses, { data: { travelExpenses: [
    { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
    { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Other Synthetic Agency', invoiceId: null },
  ], invoices: [], documents: [] } });
  tap(x, t => t.startsWith('Invoice'), 'Invoice');
  await settle();
  btn(x, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  markSent(x);
  const [exp] = recorded(x);
  assert.equal(exp.entryIds.length, 1, 'one agency\'s expense');
  const [billedId] = exp.entryIds;
  tap(x, t => t.startsWith('Invoice'), 'Invoice'); // the other agency's expense
  await settle();
  sheet.answer();
  await settle();
  assert.deepEqual(recorded(x).map(i => i.number), [exp.number], 'one expense invoice');
  assert.equal(x.data.travelExpenses.find(z => z.id === billedId).invoiceId, exp.id);
  assert.equal(modal(x, 'Invoice expenses').props.open, true, 'the new sheet is not closed by the old send');
});

// ── A cancel that answers late ──

test('a share sheet that answers "cancelled" only after its preview or sheet was closed keeps the note, its banner and its stamp (Work log, Days & call, Expenses)', async () => {
  fresh(); const sheet = later(); const srv = server();
  const m = openWork({ srv });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  // Sent from Mail, the sheet still silent: the preview is closed, and the
  // banner says the invoice went to the share sheet.
  modal(m, 'Invoice preview').props.onClose();
  await settle();
  assert.match(shown(m), new RegExp(`${number} went to the share sheet .* and was never recorded`));
  sheet.cancel(); // iOS answers AbortError late, though the invoice went
  await settle();
  assert.match(shown(m), new RegExp(`${number} went to the share sheet .* and was never recorded`), 'the banner stays');
  btn(m, t => t === 'Yes, it was sent', 'Yes, it was sent');
  assert.equal(srv.rows.has(number), true, 'the server keeps the stamp');
  assert.deepEqual(stamps.map(s => s[1]), [true], 'no unstamp sent');
  assert.deepEqual(recorded(m), []);

  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const d = mount(DutyLog, { data: { locumContracts: [DAILY], dutyDays: [{ id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null }], invoices: [] }, props: { contract: DAILY } });
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  tap(d, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA');
  tap(d, t => t.startsWith('Invoice 1 day'), 'build');
  const dn = numberOf(d);
  await sendPdf(d);
  modal(d, 'Invoice preview').props.onClose();
  await settle();
  sheet.cancel();
  await settle();
  assert.match(shown(d), new RegExp(`${dn} went to the share sheet .* and was never recorded`), 'Days & call: the banner stays');
  assert.equal(srv.rows.has(dn), true, 'Days & call: the stamp stays');

  // The expense sheet closes during a send only once it says the share
  // sheet has not answered.
  S._resetHeldInvoiceNumbers();
  S._setHandoffTimes({ graceMs: 5, waitMs: 20, reportMs: 5 });
  const x = mount(Expenses, { data: { travelExpenses: [
    { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
  ], invoices: [], documents: [] } });
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  tap(x, t => t.startsWith('Invoice'), 'Invoice');
  await settle();
  btn(x, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  await wait(40);
  await settle();
  const xn = [...srv.rows.keys()].find(k => k.startsWith('EXP-'));
  assert.ok(xn, 'the expense invoice was stamped');
  modal(x, 'Invoice expenses').props.onClose();
  await settle();
  sheet.cancel();
  await settle();
  assert.match(shown(x), new RegExp(`${xn} went to the share sheet .* and was never recorded`), 'Expenses: the banner stays');
  assert.equal(srv.rows.has(xn), true, 'Expenses: the stamp stays');
});

// ── Record it: only the days the note billed ──

test('Record it from a note known only from the server checks no day and asks first; the picker says to match the copy sent', async () => {
  fresh(); nav(never); const srv = server();
  const phone = openWork({ srv });
  build(phone);
  const number = numberOf(phone);
  await sendPdf(phone);

  fresh(); // the Mac: nothing of the phone's stores, the phone's record not synced
  const mac = await page(phone, { srv, data: { locumContracts: [C], workLog: ENTRIES(), invoices: [] } });
  assert.match(shown(mac), new RegExp(`${number} went to the share sheet Sep 10, 2026 \\(noted on the server\\)`));
  assert.match(shown(mac), /If another device sent it, open the app there first: its record may not have synced yet/);
  tap(mac, t => t === 'Record it', 'Record it');
  assert.match(mac.dialogs.at(-1)[1], new RegExp(`${number} is noted only on the server\\. If another device recorded it and has not synced yet, recording it here too makes a second ${number}`));
  assert.equal(picked(mac).props.open, true);
  assert.equal(pickedDays(mac).selected.size, 0, 'the server knows no days: none checked');
  assert.match(shown(mac), new RegExp(`This device does not know which days ${number} billed`));
  assert.equal(btn(mac, t => /^Invoice 0 days/.test(t), 'build').props.disabled, true);
});

test('Yes after a day of the note was deleted checks none, and a different total is asked about before it records', async () => {
  const dev = fresh(); nav(never); const srv = server();
  const m = openWork({ srv });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  dev.session.clear();
  // Sep 6 deleted since (its entry, and the coverage that made it a stipend
  // day); the note billed three days for $6,000.00.
  const answers = [];
  const edited = { ...C, coveragePeriods: [{ start: '2026-09-05', end: '2026-09-05' }, { start: '2026-09-07', end: '2026-09-07' }] };
  const again = await page(m, { srv, data: { locumContracts: [edited], workLog: ENTRIES().filter(x => x.id !== 'b'), invoices: [] },
    confirm: (q) => { answers.push(q); return !/went out for/.test(q); } });
  // Its days changed: Yes cannot record it in one tap, so it opens the picker.
  tap(again, t => t === 'Yes, it was sent', 'Yes, it was sent');
  assert.deepEqual(recorded(again), []);
  assert.equal(pickedDays(again).selected.size, 0, 'not the two days left of three');
  assert.match(shown(again), new RegExp(`This device does not know which days ${number} billed, or they have changed since`));
  pickedDays(again).onChange(new Set(['2026-09-05', '2026-09-07']));
  tap(again, t => /^Invoice 2 days/.test(t), 'build two days');
  assert.equal(inputOf(again, 'Invoice number').props.value, number);
  tap(again, t => t === 'Record as sent', 'Record as sent');
  assert.match(answers.at(-1), new RegExp(`${number} went out for \\$6,000\\.00, and the days checked here come to \\$4,000\\.00\\. Record ${number} for these days anyway\\?`));
  assert.deepEqual(recorded(again), [], 'declined: nothing recorded');
});

test('Yes, it was sent on this device\'s own note records exactly its days in one tap, with no question when the total matches', async () => {
  const dev = fresh(); nav(never); const srv = server();
  const m = openWork({ srv });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  dev.session.clear(); dev.local.clear();
  // An entry logged since on a day the invoice did not bill stays unbilled.
  const again = await page(m, { srv, data: { locumContracts: [C], workLog: [...ENTRIES(), e('z', '2026-09-04', '15')], invoices: [] } });
  const yes = btn(again, t => t === 'Yes, it was sent', 'Yes, it was sent');
  yes.props.onClick();
  yes.props.onClick(); // a second tap on the same render records nothing more
  await settle(); // Yes first checks it is still unrecorded (invoiceRecordCheck.js)
  const [inv] = recorded(again);
  assert.equal(inv?.number, number);
  assert.equal(inv.method, 'share-confirmed');
  assert.equal(inv.totalAmount, 6000);
  assert.deepEqual([...inv.entryIds].sort(), ['a', 'b', 'c']);
  assert.equal(picked(again).props.open, false);
  assert.equal(again.dialogs.length, 0);
  await settle();
  assert.equal(srv.rows.has(number), false, 'the stamp is cleared');
  assert.equal(recorded(again).length, 1, 'one record for two taps');
  assert.equal(again.data.workLog.find(x => x.id === 'z').invoiceId, null);
  assert.doesNotMatch(shown(again), /is not recorded/);
});

// ── A recorded invoice clears its stamp ──

test('a recorded invoice clears its share stamp: deleting it later, or the Mac loading before the phone syncs, brings back no "never recorded"', async () => {
  fresh(); const sheet = later(); const srv = server();
  const phone = openWork({ srv });
  build(phone);
  const number = numberOf(phone);
  await sendPdf(phone);
  sheet.answer();
  await settle();
  assert.equal(recorded(phone)[0]?.number, number, 'the share answered: recorded');
  assert.deepEqual(stamps, [[number, true, 'c-s'], [number, false, null]], 'stamped as it went, cleared once recorded, in that order');
  assert.equal(srv.rows.has(number), false);

  // The Mac, before the phone's record has reached it (queued on the phone).
  fresh();
  const mac = await page(phone, { srv, data: { locumContracts: [C], workLog: ENTRIES(), invoices: [] } });
  assert.doesNotMatch(shown(mac), /is not recorded/);
  assert.equal(btn(mac, t => /Invoice 3 unbilled/.test(t), 'CTA').props.disabled ?? false, false);
  assert.throws(() => btn(mac, t => t === 'Record it', 'Record it'));

  // The invoice deleted on the Invoices tab later (its entries unbilled).
  const after = await page(phone, { srv, data: { locumContracts: [C], workLog: ENTRIES(), invoices: [] } });
  assert.doesNotMatch(shown(after), /is not recorded/);
});

test('Mark as sent under the number on the copy that was sent clears the stamp of the preview\'s own number too', async () => {
  fresh(); nav(never); const srv = server();
  const m = openWork({ srv });
  build(m);
  const preview = numberOf(m);
  await sendPdf(m);
  markSent(m, 'INV-20260910-07');
  assert.equal(recorded(m)[0]?.number, 'INV-20260910-07');
  await settle();
  assert.equal(srv.rows.has(preview), false, 'the preview\'s number bills nothing now');
  const again = await page(m, { srv });
  assert.doesNotMatch(shown(again), /is not recorded/);
});

// ── Stamps the server could not take ──

test('"No, it did not go out" whose unstamp was lost to the signal is sent again on the next page, and no "never recorded" comes back', async () => {
  fresh();
  nav(async () => { const err = new Error('Share canceled'); err.name = 'AbortError'; throw err; });
  const srv = server();
  srv.offlineFor = false; // the signal went between the tap and the answer
  const m = openWork({ srv });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  tap(m, t => t === 'No, it did not go out', 'No');
  await settle();
  assert.equal(srv.rows.has(number), true, 'the server still holds the stamp');
  find(m.render(), n => n.props?.title === 'Invoice preview', 'preview').props.onClose();

  srv.offlineFor = null; // back online, a new page
  const again = await page(m, { srv });
  assert.doesNotMatch(shown(again), /is not recorded/);
  assert.equal(srv.rows.has(number), false, 'the owed unstamp went');
  const later2 = await page(m, { srv });
  assert.doesNotMatch(shown(later2), /is not recorded/);
});

test('a note written offline (Clerk id, no profile yet) is found by the next online load, and its stamp is sent then', async () => {
  const dev = fresh(); nav(never); const srv = server();
  srv.offline = true;
  const m = openWork({ srv, clerk: 'user_syntheticClerk', profile: null });
  build(m);
  const number = numberOf(m);
  await sendPdf(m);
  assert.equal(srv.rows.size, 0, 'offline: the server has nothing');

  // iOS dropped the page; it opens online, where AppContext knows the profile id.
  dev.session.clear();
  srv.offline = false;
  const again = await page(m, { srv, clerk: 'user_syntheticClerk', profile: '00000000-0000-4000-8000-0000000000aa' });
  assert.match(shown(again), new RegExp(`${number} went to the share sheet Sep 10, 2026 for \\$6,000\\.00 and was never recorded`));
  assert.equal(srv.rows.has(number), true, 'the stamp owed since offline went');
  assert.equal(srv.rows.get(number).contract_id, 'c-s');
});
