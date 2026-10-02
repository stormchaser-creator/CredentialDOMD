import test from 'node:test';
import { settleOutcome } from '../helpers/settle-outcome.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, child, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { fakeWorld } from '../invoice-email/fakeWorld.mjs';

// "Email it for me" on Work log, Days & call and Expenses (2026-10-01). The
// owner sent an invoice from his iPhone and it did not show as sent: the
// share sheet answers AbortError after Gmail sent it, and Gmail and iOS Mail
// flatten the letter's paragraphs. The server email (send-invoice-email)
// keeps them, copies him, and its outcome is known, so a confirmed send now
// records the invoice with no further tap.
//
// The real screens and the real email screen, driven through the real
// send-invoice-email handler over a fake database, Storage and Resend
// (tests/invoice-email/fakeWorld.mjs). Synthetic contracts, entries,
// amounts, numbers and addresses only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const S = await loadScreens([
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";',
  'export {default as InvoiceEmailModal} from "./src/components/features/locum/InvoiceEmailModal.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes, invoiceNotes} from "./src/utils/invoiceHandoff.js";',
  'export {invoiceEmailKeys} from "./src/utils/invoiceEmailDraft.js";',
].join(' '));
const { WorkLog, DutyLog, Expenses, InvoiceEmailModal } = S;

// Bounded wait for the outcome, not a fixed number of turns (tests/helpers/settle-outcome.mjs).
const settle = (n = 80) => settleOutcome(n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shown = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(textOf).join('\n');
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => {
  const b = btn(m, pred, what);
  assert.ok(!b.props.disabled, `"${what}" is disabled`);
  return b.props.onClick({ stopPropagation() {} });
};
const YES = 'Yes, it was sent';
const NO = 'No, it did not go out';
const EMAIL_IT = 'Email it for me';
const TO = 'billing@synthetic-hospital.example';
const SENT_AT = '2026-09-10T17:30:00.000Z';

// ── The device ──
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
  return { open: () => { const r = { result: db }; later(() => { r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
function pageDoc() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
  };
  setGlobal('document', doc);
  return { back: () => { for (const fn of [...(listeners.get('visibilitychange') || [])]) fn(); } };
}
// The share sheet, answering when the test says.
const shares = [];
function sheet() {
  const pending = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true,
    share: (d) => { shares.push(d); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  return {
    answer: () => pending.shift()?.resolve(),
    abort: () => { const err = new Error('Abort due to cancellation of share.'); err.name = 'AbortError'; pending.shift()?.reject(err); },
  };
}
// The share stamps the server keeps (mark_invoice_number_shared).
const stamps = [];
function stampServer() {
  const rows = new Map();
  return {
    rows,
    markShared: (number, { shared, contractId }) => {
      stamps.push([number, shared]);
      if (shared) rows.set(number, { number, shared_at: new Date().toISOString(), contract_id: contractId }); else rows.delete(number);
      return Promise.resolve({ data: true, error: null });
    },
    listShared: () => Promise.resolve({ data: [...rows.values()], error: null }),
  };
}
function fresh() {
  shares.length = 0; stamps.length = 0;
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter(() => {});
  S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  setGlobal('sessionStorage', webStorage()); setGlobal('localStorage', webStorage()); setGlobal('indexedDB', indexedDb());
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} } });
}

// The send-invoice-email function behind supabase.functions.invoke. `lose`:
// the next n answers are lost on the way back (the request did reach it).
function connect(env) {
  const link = { calls: [], lose: 0 };
  globalThis.__screen.invoke = async (name, { body }) => {
    assert.equal(name, 'send-invoice-email');
    link.calls.push(JSON.parse(JSON.stringify(body)));
    const r = await env.call(JSON.parse(JSON.stringify(body)));
    if (link.lose > 0) { link.lose -= 1; throw new TypeError('Load failed'); }
    return r.status === 200 ? { data: r.body, error: null }
      : { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.status, json: async () => r.body } } };
  };
  return link;
}

// ── The three screens ──
const SETTINGS = { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999', email: 'doc@example.test' };
const STIPEND = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000,
  stipendHours: 24, overageHourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-05', end: '2026-09-07' }], billTo: TO };
const entry = (id, d, h) => ({ id, createdAt: `${d}T${h}:30:00Z`, contractId: 'c-s', type: 'Call', date: d, callDay: d,
  startTime: `${d}T${h}:00:00.000Z`, endTime: `${d}T${h}:30:00.000Z`, durationMin: 30, billedMin: 30, description: 'Consult', privateNote: '', invoiceId: null });
const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const day = (id, date) => ({ id, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null });
const AGENCY_TO = 'ap@synthetic-staffing.example';

const SCREENS = {
  'Work log': {
    seed: () => ({ settings: SETTINGS, locumContracts: [STIPEND], workLog: [entry('a', '2026-09-05', '15'), entry('b', '2026-09-06', '16'), entry('c', '2026-09-07', '17')], invoices: [] }),
    mount: (data) => mount(WorkLog, { data, storage: { lastContract: 'c-s' } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    share: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    close: (m) => find(m.render(), n => n.props?.title === 'Invoice preview', 'preview').props.onClose(),
    key: 'workLog', items: ['a', 'b', 'c'], total: 6000, prefilled: TO, contractId: 'c-s',
  },
  'Days & call': {
    seed: () => ({ settings: SETTINGS, locumContracts: [DAILY], dutyDays: [day('d1', '2026-09-07'), day('d2', '2026-09-08'), day('d3', '2026-09-09')], invoices: [] }),
    mount: (data) => mount(DutyLog, { data, props: { contract: DAILY } }),
    build: (m) => { tap(m, t => /Invoice 3 unbilled days/.test(t), 'Invoice CTA'); tap(m, t => /^Invoice 3 days/.test(t), 'build'); },
    share: async (m) => { tap(m, t => t.startsWith('Send invoice'), 'Send invoice'); find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); },
    close: (m) => find(m.render(), n => n.props?.title === 'Invoice preview', 'preview').props.onClose(),
    key: 'dutyDays', items: ['d1', 'd2', 'd3'], total: 6000, prefilled: '', contractId: 'c-day',
  },
  Expenses: {
    seed: () => ({ settings: SETTINGS, locumContracts: [{ ...DAILY, billTo: AGENCY_TO }], travelExpenses: [
      { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
      { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
    ], invoices: [], documents: [] }),
    mount: (data) => mount(Expenses, { data }),
    build: async (m) => { tap(m, t => t.startsWith('Invoice'), 'Invoice'); await settle(); },
    share: async (m) => { await settle(); btn(m, t => t.includes('Create & send'), 'send').props.onClick(); await settle(); },
    close: (m) => find(m.render(), n => n.props?.title === 'Invoice expenses', 'sheet').props.onClose(),
    key: 'travelExpenses', items: ['x1', 'x2'], total: 450.9, prefilled: AGENCY_TO, contractId: null, firstNumber: 'EXP-20260910-01',
  },
};

const emailModalEl = (m) => nodes(m.render()).find(n => n?.props && n.props.invoiceDraft && n.type === InvoiceEmailModal) || null;
// The invoice number the preview (or the expense sheet) holds: printed on
// Work log and Days & call; the expense sheet prints none, so it is read off
// the email screen, or the share's stamp.
const numberShown = (m) => (shown(m).match(/\b(?:INV|EXP)-20260910-\d+\b/) || [])[0];

async function setup(name, { world = {} } = {}) {
  fresh();
  const s = SCREENS[name];
  const env = fakeWorld();
  env.world.now = Date.parse(SENT_AT);
  Object.assign(env.world, world);
  const m = s.mount(s.seed());
  const srv = stampServer();
  Object.assign(globalThis.__screen, { markShared: srv.markShared, listShared: srv.listShared });
  const link = connect(env);
  m.render();
  await s.build(m);
  await settle();
  return { s, m, env, srv, link, number: numberShown(m) || s.firstNumber };
}
// Email it for me, as the physician taps it: the check, then the email screen.
async function openEmail(m) {
  tap(m, t => t === EMAIL_IT, EMAIL_IT);
  await settle();
  assert.ok(emailModalEl(m), 'the email screen is open');
  const modal = child(InvoiceEmailModal, () => emailModalEl(m).props);
  modal.render();
  await settle();
  return modal;
}
const modalButton = (modal, pred, what) => find(modal.render(), n => n.type === 'button' && pred(textOf(n)), what);
const toField = (modal) => find(modal.render(), n => n.type === 'input' && n.props.type === 'email', 'To');
async function fillTo(modal, value) {
  toField(modal).props.onChange({ target: { value } });
  modal.render();
}
const sendButton = (modal) => modalButton(modal, t => t.startsWith('Send'), 'Send');
async function send(modal) {
  const b = sendButton(modal);
  assert.ok(!b.props.disabled, 'Send is disabled');
  await b.props.onClick();
  await settle();
}
function oneEmailed(m, s, number, name) {
  const all = recorded(m);
  assert.equal(all.length, 1, `${name}: one invoice`);
  const [inv] = all;
  assert.equal(inv.number, number, `${name}: under the previewed number`);
  assert.equal(inv.method, 'emailed', `${name}: recorded as emailed`);
  assert.equal(inv.id, S.invoiceEmailKeys('', number).invoiceId, `${name}: under the id the server's ledger names`);
  assert.equal(inv.totalAmount, s.total, `${name}: its total`);
  assert.deepEqual([...inv.entryIds].sort(), s.items, `${name}: exactly the previewed items`);
  assert.deepEqual((m.data[s.key] || []).filter(x => x.invoiceId === inv.id).map(x => x.id).sort(), s.items, `${name}: and they are billed`);
  return inv;
}

for (const name of Object.keys(SCREENS)) {
  test(`${name}: Email it for me sends this preview's PDF from the server, then records it once as emailed, dated at the send`, async () => {
    const { s, m, env, srv, link, number } = await setup(name);
    assert.match(number || '', /^(INV|EXP)-20260910-\d+$/);
    assert.match(shown(m), /Sent from CredentialDOMD with its paragraphs kept and a copy to you/);
    const modal = await openEmail(m);
    assert.equal(link.calls[0].action, 'check');
    assert.equal(link.calls[0].draft.number, number, 'checked as a draft: nothing recorded yet');
    assert.deepEqual([...link.calls[0].draft.entryIds].sort(), s.items);
    assert.equal(toField(modal).props.value, s.prefilled, `${name}: the agreement's address, or empty`);
    if (!s.prefilled) {
      const hint = find(modal.render(), n => n.props?.label === 'To', 'To field').props.hint;
      assert.equal(hint, "No invoice email is saved for Synthetic Valley Hospital. Type the billing office's address.");
      assert.equal(sendButton(modal).props.disabled, true, 'nothing to send to yet');
      await fillTo(modal, TO);
    }
    assert.match(textOf(modal.render()), new RegExp(`Once it is sent, ${number} goes on the Invoices tab as emailed and these \\w+ are billed\\.`));
    assert.deepEqual(recorded(m), [], 'nothing recorded before the send');

    await send(modal);
    assert.equal(env.world.mails.length, 1, 'one email');
    const mail = env.world.mails[0];
    assert.deepEqual(mail.to, [s.prefilled || TO]);
    assert.deepEqual(mail.cc, ['doc.verified@example.test'], 'a copy to the physician');
    assert.equal(mail.attachments[0].filename, `Invoice ${number} from Synthetic Physician, DO.pdf`, 'the PDF of this preview');
    assert.ok(mail.text.includes('\n\n') && mail.html.includes('<p'), 'paragraphs kept, text and HTML');
    const pdf = Buffer.from(mail.attachments[0].content, 'base64').toString('latin1');
    assert.ok(pdf.includes(number), 'the PDF carries this number');
    const ledger = env.world.ledger[0];
    assert.equal(ledger.client_request_id, S.invoiceEmailKeys('', number).requestId, 'the number is the idempotency key');

    const inv = oneEmailed(m, s, number, name);
    assert.equal(inv.sentAt, SENT_AT, 'dated at the send');
    assert.equal(emailModalEl(m), null, 'the email screen closed');
    assert.deepEqual(m.dialogs, [], 'no dialog: zero extra taps');
    assert.match(shown(m), new RegExp(`Invoice ${number} was emailed to ${(s.prefilled || TO).replace(/\./g, '\\.')}\\. A copy went to doc\\.verified@example\\.test\\. Replies come to you\\. It is on the Invoices tab as emailed`));
    assert.equal(S.invoiceNotes('').some(n => n.number === number), false, 'no note left behind');
    assert.equal(stamps.some(([n, shared]) => n === number && shared), false, 'never noted on the server as maybe sent');
    assert.equal(srv.rows.size, 0);
  });

  test(`${name}: a send that fails records nothing, keeps nothing, says what to do, and does not spend the number`, async () => {
    const { s, m, env, number } = await setup(name, { world: { mailOutcome: () => ({ state: 'failed' }) } });
    const modal = await openEmail(m);
    if (!s.prefilled) await fillTo(modal, TO);
    await send(modal);
    assert.equal(env.world.mails.length, 0);
    assert.deepEqual(recorded(m), [], 'nothing recorded');
    assert.match(textOf(modal.render()), /The email was not sent\. Nothing went out\. Try again in a minute\./);
    assert.equal(S.invoiceNotes('').some(n => n.number === number), false, 'no note: it did not go');
    assert.equal(stamps.length, 0, 'nothing told to the server');
    // The email screen closes, and so does the preview: the next one carries the same number.
    modalButton(modal, t => t === 'Cancel', 'Cancel').props.onClick();
    await settle();
    assert.equal(emailModalEl(m), null);
    s.close(m);
    await settle();
    await s.build(m);
    await settle();
    let again = numberShown(m);
    if (!again) { await openEmail(m); again = emailModalEl(m).props.invoice.number; }
    assert.equal(again, number, 'not spent: nothing went out under it');
  });

  test(`${name}: a double tap on Send mails once and records once`, async () => {
    const { s, m, env, number } = await setup(name);
    const modal = await openEmail(m);
    if (!s.prefilled) await fillTo(modal, TO);
    const b = sendButton(modal);
    const first = b.props.onClick();
    const second = b.props.onClick();
    await Promise.all([first, second]);
    await settle();
    assert.equal(env.world.mails.length, 1);
    assert.equal(env.world.keys.length, 1, 'one request to the provider');
    oneEmailed(m, s, number, name);
  });

  test(`${name}: a lost answer on a weak network: Send again is a replay, mailed once and recorded once`, async () => {
    const { s, m, env, link, number } = await setup(name);
    const modal = await openEmail(m);
    if (!s.prefilled) await fillTo(modal, TO);
    link.lose = 1;
    await send(modal);
    assert.equal(env.world.mails.length, 1, 'it did go');
    assert.deepEqual(recorded(m), [], 'not recorded on no answer');
    assert.match(textOf(modal.render()), /The connection dropped before the answer came back, so this email may have gone\. Tap Send again: if it went, it is not sent twice\./);
    assert.ok(S.invoiceNotes('').some(n => n.number === number && n.via === 'email'), 'noted on the device while unknown');
    await send(modal);
    assert.equal(env.world.mails.length, 1, 'not mailed twice');
    assert.equal(link.calls.filter(c => c.action === 'send').length, 2);
    assert.equal(new Set(link.calls.filter(c => c.action === 'send').map(c => c.requestId)).size, 1, 'one request id for one number');
    oneEmailed(m, s, number, name);
    assert.equal(S.invoiceNotes('').some(n => n.number === number), false);
  });

  test(`${name}: share, AbortError, No, then Email it for me: the same number goes by email and is recorded once`, async () => {
    const { s, m, env, srv, number } = await setup(name);
    const sh = sheet();
    await s.share(m);
    assert.equal(shares.length, 1);
    assert.equal(stamps[0]?.[0], number, 'the share went under the sheet number');
    sh.abort();
    await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    assert.equal(btn(m, t => t === EMAIL_IT, EMAIL_IT).props.disabled, true, 'answer first: the same number never goes twice unasked');
    tap(m, t => t === NO, NO);
    await settle();
    assert.equal(srv.rows.has(number), false, 'No took the stamp back');
    const modal = await openEmail(m);
    if (!s.prefilled) await fillTo(modal, TO);
    await send(modal);
    assert.equal(env.world.mails.length, 1);
    oneEmailed(m, s, number, name);
    assert.equal(srv.rows.has(number), false);
  });

  test(`${name}: email while the share sheet still holds the file (No answered), then the sheet answers a send late: one invoice`, async () => {
    const { s, m, env, srv, number } = await setup(name);
    const sh = sheet();
    const page = pageDoc();
    await s.share(m);
    assert.equal(btn(m, t => t === EMAIL_IT, EMAIL_IT).props.disabled, true, 'not while the share sheet has it');
    page.back();
    await wait(20); await settle();
    assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
    tap(m, t => t === NO, NO);
    await settle();
    const modal = await openEmail(m);
    if (!s.prefilled) await fillTo(modal, TO);
    await send(modal);
    oneEmailed(m, s, number, name);
    sh.answer(); // iOS answers the old share after all
    await settle(); await wait(20); await settle();
    assert.equal(recorded(m).length, 1, 'the late share answer records nothing more');
    assert.equal(env.world.mails.length, 1);
    assert.equal(S.invoiceNotes('').some(n => n.number === number), false, 'and keeps no note');
    assert.equal(srv.rows.has(number), false, 'nor a stamp');
  });
}

test('an email that cannot be confirmed: the number is spent, the server is told, and the preview asks; Yes records it as emailed', async () => {
  const { s, m, srv, number } = await setup('Work log', { world: { mailOutcome: () => ({ state: 'unknown' }) } });
  const modal = await openEmail(m);
  await send(modal);
  assert.match(textOf(modal.render()), /could not be confirmed\. Check your copy at doc\.verified@example\.test before sending again\./);
  assert.deepEqual(recorded(m), []);
  assert.equal(srv.rows.has(number), true, 'noted on the server: every device asks');
  const note = S.invoiceNotes('').find(n => n.number === number);
  assert.equal(note?.via, 'email');
  modalButton(modal, t => t === 'Close', 'Close').props.onClick();
  await settle();
  assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
  assert.match(shown(m), new RegExp(`The email of ${number} could not be confirmed, so it may have gone\\. Check your copy at doc\\.verified@example\\.test\\.`));
  tap(m, t => t === YES, YES);
  await settle();
  const inv = oneEmailed(m, s, number, 'Work log');
  assert.equal(inv.method, 'emailed');
  assert.equal(srv.rows.has(number), false, 'recorded: the stamp is cleared');
});

test('a lost answer and then Close: it may have gone, so the preview asks, the number is spent, and the reminder records it as emailed', async () => {
  const { s, m, link, srv, number } = await setup('Days & call');
  const modal = await openEmail(m);
  await fillTo(modal, TO);
  link.lose = 1;
  await send(modal);
  modalButton(modal, t => t === 'Cancel', 'Cancel').props.onClick();
  await settle();
  assert.equal(emailModalEl(m), null);
  assert.match(shown(m), new RegExp(`Did ${number} go out\\?`));
  assert.equal(srv.rows.has(number), true, 'the server is told it may have gone');
  // It may have gone: the device never issues the number again (invoiceNumber.js's spent list).
  const spent = JSON.parse(globalThis.sessionStorage.getItem('credentialdomd-spent-invoice-numbers') || '{}');
  assert.ok((spent[''] || []).includes(number), 'spent');
  s.close(m);
  await settle();
  assert.match(shown(m), new RegExp(`${number} was emailed without a confirmation Sep 10, 2026`));
  tap(m, t => t === YES, YES);
  await settle();
  const inv = oneEmailed(m, s, number, 'Days & call');
  assert.equal(inv.method, 'emailed');
  assert.equal(srv.rows.has(number), false);
});

test('a lost answer, Close, then No: nothing recorded and the server forgets it', async () => {
  const { m, link, srv, number } = await setup('Work log');
  const modal = await openEmail(m);
  link.lose = 1;
  await send(modal);
  modalButton(modal, t => t === 'Cancel', 'Cancel').props.onClick();
  await settle();
  tap(m, t => t === NO, NO);
  await settle();
  assert.deepEqual(recorded(m), []);
  assert.equal(srv.rows.has(number), false);
});

test('offline: Email it for me is off and says why; Send and Copy are still there', async () => {
  const { m } = await setup('Work log');
  setGlobal('navigator', { onLine: false });
  const b = btn(m, t => t === EMAIL_IT, EMAIL_IT);
  assert.equal(b.props.disabled, true);
  assert.match(shown(m), /Email it for me needs a connection\. Send invoice… or Copy still works\./);
  assert.equal(btn(m, t => t.startsWith('Send invoice'), 'Send invoice').props.disabled, false);
  setGlobal('navigator', { onLine: true });
  assert.equal(btn(m, t => t === EMAIL_IT, EMAIL_IT).props.disabled, false, 'back online: on again');
});

test('the membership check still running (or timing out) does not hold the email: the server decides, and the record follows', async () => {
  const { s, m, env, number } = await setup('Work log');
  Object.assign(globalThis.__screen.app, { limitedLaunch: { enabled: true }, canWritePractice: false, practiceReadOnly: false });
  const modal = await openEmail(m);
  assert.doesNotMatch(textOf(modal.render()), /Reconnecting/);
  await send(modal);
  assert.equal(env.world.mails.length, 1);
  oneEmailed(m, s, number, 'Work log');
});

test('a membership the server says is read-only sends nothing and records nothing', async () => {
  const { m, env } = await setup('Work log', { world: { access: { enforcementEnabled: true, credential: true, practice: false } } });
  const modal = await openEmail(m);
  assert.match(textOf(modal.render()), /does not include sending Practice records/);
  assert.equal(env.world.mails.length, 0);
  assert.deepEqual(recorded(m), []);
});

test('the send cap and a CredentialDOMD address: refused, nothing recorded, and the screen says why', async () => {
  const capped = await setup('Work log', { world: { reserveResult: { data: [], error: null } } });
  const modal = await openEmail(capped.m);
  await send(modal);
  assert.match(textOf(modal.render()), /Send limit reached \(30 emails per hour\)\. Try again later\./);
  assert.deepEqual(recorded(capped.m), []);
  assert.equal(S.invoiceNotes('').length, 0);

  const own = await setup('Work log');
  const modal2 = await openEmail(own.m);
  await fillTo(modal2, 'billing@credentialdomd.com');
  assert.equal(sendButton(modal2).props.disabled, true);
  assert.match(textOf(modal2.render()), /That is a CredentialDOMD address\. Enter the billing office's email\./);
});

test('already recorded on another device: Email it for me says so and sends nothing', async () => {
  const { m, env, number } = await setup('Days & call');
  globalThis.__screen.recordState = () => Promise.resolve({ data: { numberTaken: true, billedIds: [] }, error: null });
  tap(m, t => t === EMAIL_IT, EMAIL_IT);
  await settle();
  assert.equal(emailModalEl(m), null, 'no email screen');
  assert.ok(m.dialogs.some(([k, msg]) => k === 'alert' && msg.includes(`${number} is already on the Invoices tab`)));
  assert.equal(env.world.mails.length, 0);
  assert.deepEqual(recorded(m), []);
});
