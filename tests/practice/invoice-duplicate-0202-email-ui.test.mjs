import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';
import { fakeWorld, fakePdfFor, IDS } from '../invoice-email/fakeWorld.mjs';
import { invoiceEmailKeys, emailDraftBody } from '../../src/utils/invoiceEmailDraft.js';

// 2026-10-02: on release/goal2 8bcb1c49 a page whose copy predated the Mac's
// record of INV-A checked the server before "Email it for me" and refused
// INV-A's days, while "Send invoice…" on the same preview handed them to the
// share sheet unchecked. Now the preview asks the server about its days as
// it opens: billed elsewhere, it closes before anything can go, by email or
// by the share sheet. And the server refuses to mail a draft whose items
// another invoice bills, whatever its number. Synthetic data only.

createRequire(import.meta.url)('jspdf');
pinClock(test, 'America/Chicago', '2026-09-10T21:03:00-05:00');
const S = await loadScreens([
  'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
  'export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";',
  'export {_resetInvoiceHandoff, setInvoiceHandoffReporter, _setHandoffTimes} from "./src/utils/invoiceHandoff.js";',
].join(' '));
const { DutyLog } = S;

const settle = async (n = 80) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred) => nodes(m.render()).find(n => n?.type === 'button' && pred(textOf(n)));
const recorded = (m) => m.calls.filter(c => c[0] === 'add' && c[1] === 'invoices').map(c => c[2]);
const tap = (m, pred, what) => { const b = btn(m, pred); assert.ok(b, `not found: ${what}`); assert.ok(!b.props.disabled, `"${what}" is disabled`); return b.props.onClick({ stopPropagation() {} }); };
function webStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}
const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });

const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', agency: 'Synthetic Staffing', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08'];
const BILLED = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];

test('a stale page: the preview asks the server about its days as it opens, and closes before Email it for me or Send invoice… can send the days -01 bills', async () => {
  S._resetInvoiceHandoff({ stores: true }); S._resetHeldInvoiceNumbers();
  S.setInvoiceHandoffReporter(() => {}); S._setHandoffTimes({ graceMs: 5, waitMs: 60000, reportMs: 5 });
  setGlobal('document', undefined);
  setGlobal('sessionStorage', webStorage()); setGlobal('localStorage', webStorage()); setGlobal('indexedDB', undefined);
  const shares = [];
  setGlobal('navigator', { onLine: true, clipboard: { writeText: async () => {} }, canShare: () => true, share: (d) => { shares.push(d); return Promise.resolve(); } });
  const env = fakeWorld();
  // The page's copy, from before the Mac's record of -01.
  const stale = { settings: { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999', email: 'doc@example.test' }, locumContracts: [DAILY],
    dutyDays: [...DATES, '2026-09-10'].map((date, i) => ({ id: `d${i + 1}`, contractId: 'c-day', date, workedDay: true, callPeriods: [], invoiceId: null })), invoices: [] };
  const m = mount(DutyLog, { data: stale, props: { contract: DAILY } });
  let next = 3;
  Object.assign(globalThis.__screen, {
    allocate: (kind, day) => Promise.resolve({ data: `${kind}-${day}-${String(next++).padStart(2, '0')}`, error: null }),
    markShared: () => Promise.resolve({ data: true, error: null }), listShared: () => Promise.resolve({ data: [], error: null }),
    recordState: (number, _c, ids = []) => Promise.resolve({ data: { numberTaken: number === 'INV-20260910-01', billedIds: ids.filter(id => BILLED.includes(id)), billedOn: Object.fromEntries(ids.filter(id => BILLED.includes(id)).map(id => [id, 'INV-20260910-01'])) }, error: null }),
    invoke: async (name, { body }) => {
      const r = await env.call(JSON.parse(JSON.stringify(body)));
      return r.status === 200 ? { data: r.body, error: null } : { data: null, error: { message: 'non-2xx', context: { status: r.status, json: async () => r.body } } };
    },
  });
  m.render(); await settle();
  tap(m, t => /Invoice 7 unbilled days/.test(t), 'Invoice CTA');
  find(m.render(), n => Array.isArray(n.props?.days) && n.props?.selected instanceof Set, 'picker').props.onChange(new Set(DATES));
  tap(m, t => t.startsWith('Invoice 6 days'), 'build');
  // Before the server answers, nothing can go.
  const send = btn(m, t => /^(Send invoice|Checking the days|Reserving the invoice number)/.test(t));
  assert.ok(send?.props.disabled, 'Send waits for the check');
  assert.ok(btn(m, t => t === 'Email it for me' || t === 'Checking…')?.props.disabled, 'Email it for me waits too');
  await settle();
  assert.equal(nodes(m.render()).find(n => n.props?.title === 'Invoice preview')?.props.open, false, 'the preview closed');
  assert.match(m.dialogs.map(d => d[1]).join('\n'), /Some of these days are already on INV-20260910-01 \(recorded on another device\), so this invoice was not sent\./);
  assert.equal(btn(m, t => t.startsWith('Send invoice')), undefined, 'no Send invoice… left to tap');
  assert.equal(env.world.mails.length, 0, 'nothing emailed');
  assert.equal(shares.length, 0, 'nothing to the share sheet');
  assert.deepEqual(recorded(m), []);
});

test('send-invoice-email refuses a draft whose days another invoice bills, at the check and at the send, and mails nothing', async () => {
  const env = fakeWorld();
  env.world.items.push({ id: 'd1', user_id: IDS.profile, invoice_id: 'aaaaaaaa-0000-4000-8000-0000000000b1' }, { id: 'd2', user_id: IDS.profile, invoice_id: null });
  const number = 'INV-20260910-03';
  const keys = invoiceEmailKeys('user_synthetic', number);
  const draft = emailDraftBody({ number, entryIds: ['d1', 'd2'], contractId: IDS.contract });
  const pdf = fakePdfFor({ number, total: 4000, lines: [] });
  const check = await env.call({ action: 'check', invoiceId: keys.invoiceId, pdfBytes: pdf.size, draft });
  assert.equal(check.status, 409);
  assert.equal(check.body.code, 'invoice_items_billed');
  assert.match(check.body.error, /Some of what INV-20260910-03 bills is already on another invoice \(recorded on another device\), so it was not emailed\. Nothing was sent\./);
  // Unbilled again (that invoice deleted on the other device): it goes.
  env.world.items[0].invoice_id = null;
  const ok = await env.call({ action: 'check', invoiceId: keys.invoiceId, pdfBytes: pdf.size, draft });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(env.world.mails.length, 0);
});
