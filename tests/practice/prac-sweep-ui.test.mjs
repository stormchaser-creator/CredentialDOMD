import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, field, pinClock } from '../harness/component-harness.mjs';
import { incomeByState } from '../../src/utils/taxEngine.js';

// The Practice sweep of 09-30, driven through the real screens. Synthetic
// facilities, amounts, numbers and notes only.
//  - PRAC-006: deleting a paid invoice named nothing about its payments,
//    which go with it (and Tax Prep income with them).
//  - PRAC-017: deleting an agreement with unbilled work stranded that work,
//    and Needs invoicing then opened a different agreement.
//  - PRAC-017: the agreement summary counted a write-off as outstanding.
//  - PRAC-022: a failed dictation parse put every spoken word (a patient
//    name included) in the synced billing note; nothing checked that note.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Invoices, Contracts, ContractSummary, WorkLog, TaskNotes } = await loadScreens([
  'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
  'export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";',
  'export {default as ContractSummary} from "./src/components/features/locum/ContractSummary.jsx";',
  'export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";',
  'export {default as TaskNotes} from "./src/components/features/locum/TaskNotes.jsx";',
].join(' '));

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, workState: 'CO', coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const ev = { stopPropagation() {} };
const confirms = (m) => m.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]);
const alerts = (m) => m.dialogs.filter(d => d[0] === 'alert').map(d => d[1]);

// ── PRAC-006: a paid invoice's delete names its payments ──────────────────
const PAID = {
  id: 'inv-p', number: 'INV-20260905-01', contractId: 'c1', totalAmount: 4000, sentAt: '2026-09-05T15:00:00.000Z', paidAt: '2026-09-20T15:00:00.000Z',
  lines: [{ date: '2026-09-04', label: 'Hourly', amount: 4000 }],
  payments: [{ amount: 2500, date: '2026-09-10', note: 'check 1041' }, { amount: 1500, date: '2026-09-20', note: '' }],
};
const W1 = { id: 'w1', contractId: 'c1', type: 'Consult', date: '2026-09-04', callDay: '2026-09-04', startTime: '2026-09-04T14:00:00.000Z', endTime: '2026-09-04T15:00:00.000Z', durationMin: 60, billedMin: 60, description: 'ED consult', invoiceId: 'inv-p' };
const cardOf = (m, id) => find(m.render(), n => n.type === 'div' && n.key === id, `card ${id}`);
const trashOf = (card) => find(card, n => n.type === 'button' && n.props['aria-label'] === 'Delete invoice', 'Delete invoice');

test('PRAC-006: deleting a $4,000 paid invoice names both payments and the $4,000 Tax Prep loses', () => {
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [W1], invoices: [PAID] } });
  trashOf(cardOf(m, 'inv-p')).props.onClick(ev);
  const [ask] = confirms(m);
  assert.equal(ask, 'Delete invoice INV-20260905-01? Its 1 work entry becomes unbilled again.'
    + ' It has 2 recorded payments: $2,500.00 on Sep 10, 2026 (check 1041), $1,500.00 on Sep 20, 2026.'
    + ' Deleting the invoice erases them, and Tax Prep income falls by $4,000.00.'
    + ' A rebuilt invoice starts with nothing paid or written off, so write these down to record again.');
  assert.ok(!ask.includes('—'), 'no em dash');
  // What the confirm promises is what happens: the income is gone with the row.
  assert.equal(incomeByState([PAID], [CONTRACT], 2026).total, 4000);
  assert.equal(incomeByState(m.data.invoices, [CONTRACT], 2026).total, 0);
});

test('PRAC-006: a declined confirm on a paid invoice keeps it and its payments', () => {
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], workLog: [W1], invoices: [PAID] }, confirm: () => false });
  trashOf(cardOf(m, 'inv-p')).props.onClick(ev);
  assert.equal(m.calls.length, 0);
  assert.deepEqual(m.data.invoices[0].payments, PAID.payments);
});

test('PRAC-006: a partly paid, written-off invoice names the payment and the $2,000 write off', () => {
  const inv = { ...PAID, id: 'inv-w', totalAmount: 3000, paidAt: null, writeOffAt: '2026-09-18T15:00:00.000Z', payments: [{ amount: 1000, date: '2026-09-12', note: '' }] };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [inv] } });
  trashOf(cardOf(m, 'inv-w')).props.onClick(ev);
  assert.equal(confirms(m)[0], 'Delete invoice INV-20260905-01?'
    + ' It has a recorded payment: $1,000.00 on Sep 12, 2026. Deleting the invoice erases it, and Tax Prep income falls by $1,000.00.'
    + ' Its $2,000.00 write off goes with it.'
    + ' A rebuilt invoice starts with nothing paid or written off, so write these down to record again.');
});

test('PRAC-006: a legacy invoice settled by paidAt alone says it is marked paid; an unpaid one says nothing more', () => {
  const legacy = { ...PAID, payments: undefined };
  const m = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [legacy] } });
  trashOf(cardOf(m, 'inv-p')).props.onClick(ev);
  assert.match(confirms(m)[0], /It is marked paid \(\$4,000\.00\)\. Deleting the invoice erases that payment, and Tax Prep income falls by \$4,000\.00\. .* write this down/);
  const open = { ...PAID, paidAt: null, payments: [] };
  const m2 = mount(Invoices, { data: { locumContracts: [CONTRACT], invoices: [open] } });
  trashOf(cardOf(m2, 'inv-p')).props.onClick(ev);
  assert.equal(confirms(m2)[0], 'Delete invoice INV-20260905-01?');
});

// ── PRAC-017: an agreement with unbilled work is not deleted ──────────────
const UNBILLED = [1, 2, 3, 4, 5, 6].map(i => ({ ...W1, id: `u${i}`, date: `2026-09-0${i}`, callDay: `2026-09-0${i}`, invoiceId: null }));
const deleteAgreement = (m) => find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete agreement', 'delete').props.onClick();

test('PRAC-017: an agreement with 6 unbilled entries and 1 unbilled day is refused, pointing to Archive', () => {
  const duty = [{ id: 'd1', contractId: 'c1', date: '2026-09-07', workedDay: true, invoiceId: null }, { id: 'd2', contractId: 'c1', date: '2026-09-08', workedDay: true, invoiceId: 'inv-x' }];
  const m = mount(Contracts, { data: { locumContracts: [CONTRACT], workLog: UNBILLED, dutyDays: duty } });
  deleteAgreement(m);
  assert.deepEqual(m.calls, [], 'nothing deleted');
  assert.deepEqual(confirms(m), [], 'no delete question asked');
  assert.deepEqual(alerts(m), ['Synthetic General still has 6 unbilled work entries and 1 unbilled day. Deleting the agreement would leave them where no screen can invoice them. Invoice or delete them first, or tap Archive to put the agreement away and keep its work.']);
});

test('PRAC-017: an agreement whose work is all billed still deletes behind its confirm', () => {
  const m = mount(Contracts, { data: { locumContracts: [CONTRACT], workLog: [W1] } });
  deleteAgreement(m);
  assert.equal(alerts(m).length, 0);
  assert.equal(confirms(m).length, 1);
  assert.deepEqual(m.calls, [['delete', 'locumContracts', 'c1']]);
});

test('PRAC-017: Needs invoicing names work left by a deleted agreement and never opens another one', () => {
  const opened = [];
  const other = { ...CONTRACT, id: 'c2', facility: 'Synthetic Regional' };
  const m = mount(Invoices, { data: { locumContracts: [other], workLog: UNBILLED.map(e => ({ ...e, contractId: 'gone' })), invoices: [] }, props: { onOpenContract: (id) => opened.push(id) } });
  const row = find(m.render(), n => n.key === 'gone', 'needs invoicing row');
  assert.match(textOf(row), /^Deleted agreement6 unbilled entries/);
  assert.equal(row.props.onClick, undefined, 'not a link');
  assert.equal(row.props.role, undefined);
  assert.deepEqual(opened, []);
});

// ── PRAC-017: the agreement summary reads write-offs as the Invoices tab ──
const summaryText = (invoices) => {
  const m = mount(ContractSummary, { data: { locumContracts: [CONTRACT], invoices }, props: { contract: CONTRACT, onClose() {} } });
  return textOf(m.render());
};

test('PRAC-017: a $3,000 invoice with $1,000 paid and the rest written off is not $2,000 outstanding', () => {
  const inv = { id: 'i1', number: 'INV-20260901-01', contractId: 'c1', totalAmount: 3000, periodStart: '2026-09-01', payments: [{ amount: 1000, date: '2026-09-10' }], writeOffAt: '2026-09-15T00:00:00.000Z' };
  const t = summaryText([inv]);
  assert.match(t, /Outstanding\$0\.00/);
  assert.match(t, /WRITTEN OFF/);
  assert.doesNotMatch(t, /PARTIAL/);
  const full = summaryText([{ ...inv, payments: [] }]);
  assert.match(full, /WRITTEN OFF/);
  assert.doesNotMatch(full, /UNPAID/);
  // An open partial invoice still reads its balance.
  const open = summaryText([{ ...inv, writeOffAt: null }]);
  assert.match(open, /Outstanding\$2,000\.00/);
  assert.match(open, /PARTIAL: \$2,000\.00 due/);
});

// ── PRAC-022: a failed dictation keeps the words off the invoice ──────────
const SPOKEN = 'transfer call at 8:08 last night about Jane Roe, ten minutes';

test('PRAC-022: a failed parse puts the transcript in the private note, says so in the form, and nothing spoken syncs', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    const m = mount(WorkLog, { data: { settings: { apiKey: 'synthetic-key' }, locumContracts: [CONTRACT], workLog: [] }, storage: { lastContract: 'c1' } });
    const made = [];
    globalThis.window.SpeechRecognition = class { constructor() { made.push(this); } start() {} stop() {} };
    click(m, 'Dictate an entry');
    made[0].onresult({ results: [Object.assign([{ transcript: SPOKEN }], { isFinal: true })] });
    click(m, 'Done, build the entry');
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    const tree = m.render();
    const billing = find(field(tree, 'Billing note (optional)'), n => n.type === 'textarea', 'billing note');
    assert.equal(billing.props.value, '', 'nothing spoken is in the billing note');
    const priv = find(field(tree, 'Private note (optional)'), n => n.type === 'input', 'private note');
    assert.equal(priv.props.value, SPOKEN);
    const note = find(tree, n => n.props?.role === 'alert' && /private note/.test(textOf(n)), 'reason in the form');
    assert.match(textOf(note), /Your words are in the private note, kept on this device\./);
    // Log it with a length: the row syncs no spoken word; the words stay on the device.
    find(field(m.render(), '…or minutes (when you only know the length)'), n => n.type === 'input', 'minutes').props.onChange({ target: { value: '10' } });
    click(m, 'Log it');
    const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
    if (yes) yes.props.onClick();
    const rows = m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog').map(c => c[2]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, '');
    assert.ok(!JSON.stringify(rows).includes('Jane Roe'));
    assert.equal(globalThis.__screen.vault[`workLog:${rows[0].id}`], SPOKEN);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PRAC-022: a billing note carrying an MRN is refused before anything is written; the form keeps it', () => {
  const draft = { date: '2026-09-19', type: 'Call', start: '09:00', end: '09:30', description: 'ED call, MRN 4471203', privateNote: '', contractId: 'c1' };
  const m = mount(WorkLog, { data: { locumContracts: [CONTRACT], workLog: [] }, storage: { lastContract: 'c1' }, props: { billDraft: draft, onBillDraftDone() {} } });
  m.render();
  click(m, 'Log it');
  assert.deepEqual(m.calls, []);
  assert.deepEqual(alerts(m), ['Not saved: the billing note contains a medical record number. It prints on the invoice, and CredentialDOMD doesn\'t keep patient identifiers. Move it to the private note (kept on this device) and save again.']);
  const billing = find(field(m.render(), 'Billing note (optional)'), n => n.type === 'textarea', 'billing note');
  assert.equal(billing.props.value, 'ED call, MRN 4471203');
  // The same note without the number saves.
  billing.props.onChange({ target: { value: 'ED call' } });
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  assert.equal(m.calls.filter(c => c[0] === 'add' && c[1] === 'workLog')[0][2].description, 'ED call');
});

test('PRAC-020: a to-do carrying an MRN is not captured; a plain one is', () => {
  const m = mount(TaskNotes, { data: { locumContracts: [CONTRACT], taskNotes: [] }, props: { onBill() {} } });
  const box = () => find(m.render(), n => n.type === 'input' && n.props['aria-label'] === 'New to-do', 'capture box');
  box().props.onChange({ target: { value: 'call back about MRN 4471203' } });
  box().props.onKeyDown({ key: 'Enter' });
  assert.deepEqual(m.calls, []);
  assert.match(alerts(m)[0], /^Not saved: the note contains a medical record number\./);
  assert.equal(box().props.value, 'call back about MRN 4471203', 'the note stays in the box');
  box().props.onChange({ target: { value: 'call back Dr. Synthetic' } });
  box().props.onKeyDown({ key: 'Enter' });
  assert.equal(m.calls.filter(c => c[0] === 'add' && c[1] === 'taskNotes').length, 1);
});

// ── PRAC-022: clearing a call-coverage billing note clears the synced one ──
// A coverage entry saved before the gate, its note carrying an MRN. The
// refusal says to move it to the private note; doing that must leave no
// trace of the number in the row that syncs and prints on the invoice.
const STIPEND = { ...CONTRACT, id: 'c3', payModel: 'stipend', hourlyRate: 0, callStipend: 2000, stipendHours: 4, overageHourlyRate: 300 };
const COVER = { id: 'cd1', createdAt: '2026-09-18T13:00:00Z', contractId: 'c3', type: 'CallDay', date: '2026-09-18', callDay: '2026-09-18',
  startTime: '2026-09-18T12:00:00.000Z', endTime: '2026-09-18T16:00:00.000Z', durationMin: 0, billedMin: 0, description: 'MRN 00481234 consult', privateNote: '', invoiceId: null };

test('PRAC-022: a coverage entry whose MRN note is moved to the private note saves with an empty billing note', () => {
  const m = mount(WorkLog, { data: { locumContracts: [STIPEND], workLog: [COVER] }, storage: { lastContract: 'c3' } });
  find(m.render(), n => n.type === 'div' && n.key === 'cd1' && typeof n.props.onClick === 'function', 'coverage row').props.onClick();
  click(m, 'Edit');
  const billing = () => find(field(m.render(), 'Billing note (optional)'), n => n.type === 'textarea', 'billing note');
  assert.equal(billing().props.value, 'MRN 00481234 consult');
  click(m, 'Save changes');
  assert.deepEqual(m.calls, [], 'the note with the number is refused');
  assert.match(alerts(m)[0], /^Not saved: the billing note contains a medical record number\./);
  // Do what the refusal says: clear the billing note, keep the words on the device.
  billing().props.onChange({ target: { value: '' } });
  find(field(m.render(), 'Private note (optional)'), n => n.type === 'input', 'private note').props.onChange({ target: { value: 'MRN 00481234 consult' } });
  click(m, 'Save changes');
  const written = m.calls.filter(c => c[0] === 'edit' && c[1] === 'workLog').map(c => c[2]);
  assert.equal(written.length, 1);
  assert.equal(written[0].description, '');
  assert.ok(!JSON.stringify(m.data.workLog).includes('00481234'), 'no MRN in the synced row');
  assert.equal(globalThis.__screen.vault['workLog:cd1'], 'MRN 00481234 consult');
});
