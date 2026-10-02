import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadScreens, mount, nodes, textOf, find, field, pinClock } from '../harness/component-harness.mjs';

// The deferred sent-formatting patches on the invoice screens (D1, D3, D4 and
// the phone): a first send from Work log, Days & call or Expenses names the
// physician the way a resend from the Invoices tab does (physicianLabel: the
// degree once, the phone under FROM), a receipt leaves named for what it is,
// and the day note on Days & call says it prints on the invoice.
// Synthetic contracts, names and numbers only.
createRequire(import.meta.url)('jspdf');
const clock = pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const { WorkLog, DutyLog, Expenses, _resetHeldInvoiceNumbers } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx"; export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {_resetHeldInvoiceNumbers} from "./src/utils/invoiceNumber.js";');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const btn = (m, pred, what) => find(m.render(), n => n.type === 'button' && pred(textOf(n)), what);
const shownText = (m) => nodes(m.render()).filter(n => typeof n === 'object').map(n => textOf(n)).join('\n');
const shares = [];
const copied = [];
function setNavigator() {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { onLine: true, clipboard: { writeText: async (t) => { copied.push(t); } }, canShare: () => true, share: async (d) => { shares.push(d); } } });
}
const pdfText = async (file) => Buffer.from(await file.arrayBuffer()).toString('latin1');
const sendPdf = async (m) => { find(m.render(), n => typeof n.props?.onPick === 'function', 'format chooser').props.onPick('pdf'); await settle(); };

// The degree typed into the name as well as the degree field: the hand-built
// label printed "Jordan Sample DO, DO", and the first send carried no phone.
const settings = { name: 'Jordan Sample DO', degreeType: 'DO', npi: '9999999901', email: 'jordan@example.test', phone: '555-010-0199' };

test('work log: the first send names the physician once and carries the phone', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  _resetHeldInvoiceNumbers(); shares.length = 0; setNavigator();
  const HOURLY = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, callHourlyRate: 250, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
  const day = '2026-09-09';
  const entry = { id: 'w1', createdAt: `${day}T20:00:00Z`, contractId: 'c1', type: 'Consult', date: day, callDay: day, startTime: `${day}T19:00:00.000Z`, endTime: `${day}T20:00:00.000Z`, durationMin: 60, billedMin: 60, description: 'ED consult', privateNote: '', invoiceId: null };
  const open = () => {
    _resetHeldInvoiceNumbers();
    const m = mount(WorkLog, { data: { settings, locumContracts: [HOURLY], workLog: [{ ...entry }], invoices: [] }, storage: { lastContract: 'c1' } });
    btn(m, t => /Invoice \d+ unbilled/.test(t), 'invoice CTA').props.onClick();
    btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
    return m;
  };
  copied.length = 0;
  const c = open();
  await btn(c, t => t === 'Copy', 'Copy').props.onClick();
  await settle();
  const text = copied.join('\n');
  assert.match(text, /Phone: 555-010-0199/, 'the text invoice carries the phone');
  assert.match(text, /Jordan Sample DO/);
  assert.doesNotMatch(text, /DO, DO/);
  const m = open();
  await sendPdf(m);
  assert.equal(shares.length, 1);
  const [pdf] = shares[0].files;
  assert.equal(pdf.name, 'Invoice INV-20260910-01 from Jordan Sample DO.pdf');
  const raw = await pdfText(pdf);
  assert.ok(raw.includes('555-010-0199'), 'the PDF prints the phone');
  assert.ok(!raw.includes('DO, DO'), 'the PDF prints the degree once');
});

test('days & call: the first send names the physician once and carries the phone; the day note says it prints', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  _resetHeldInvoiceNumbers(); shares.length = 0; setNavigator();
  const DAILY = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 0, callRateGrid: null };
  const DAY = { id: 'd1', contractId: 'c-day', date: '2026-09-08', workedDay: true, callPeriods: [], invoiceId: null, notes: 'Covered the second clinic' };
  const open = () => {
    _resetHeldInvoiceNumbers();
    const m = mount(DutyLog, { data: { settings, locumContracts: [DAILY], dutyDays: [{ ...DAY }], invoices: [] }, props: { contract: DAILY } });
    btn(m, t => /Invoice 1 unbilled day/.test(t), 'invoice CTA').props.onClick();
    btn(m, t => t.startsWith('Invoice 1 day'), 'build').props.onClick();
    return m;
  };
  copied.length = 0;
  const c = open();
  await btn(c, t => t === 'Copy text & mark sent', 'Copy').props.onClick();
  await settle();
  const text = copied.join('\n');
  assert.match(text, /Phone: 555-010-0199/);
  assert.match(text, /Covered the second clinic/, 'the day note is on the bill');
  assert.doesNotMatch(text, /DO, DO/);
  const m = open();
  await sendPdf(m);
  const [pdf] = shares[0].files;
  assert.equal(pdf.name, 'Invoice INV-20260910-01 from Jordan Sample DO.pdf');
  const raw = await pdfText(pdf);
  assert.ok(raw.includes('555-010-0199'));
  assert.ok(!raw.includes('DO, DO'));
  const src = readFileSync(new URL('../../src/components/features/locum/DutyLog.jsx', import.meta.url), 'utf8');
  assert.match(src, /<Field label="Note on the invoice">[^\n]*placeholder="optional, printed on the invoice"/, 'the field says the note prints (D1)');
});

test('expenses: the first send names the physician once with the phone, and each receipt goes out named for what it is', async () => {
  clock.setNow('2026-09-10T12:00:00-05:00');
  _resetHeldInvoiceNumbers(); shares.length = 0; setNavigator();
  const EXPENSES = [
    { id: 'x1', date: '2026-09-05', amount: 412.4, category: 'Lodging', vendor: 'Synthetic Inn', agency: 'Synthetic Staffing', invoiceId: null },
    { id: 'x2', date: '2026-09-06', amount: 38.5, category: 'Meals', vendor: 'Synthetic Diner', agency: 'Synthetic Staffing', invoiceId: null },
  ];
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const documents = [
    { id: 'r1', name: 'IMG_0269.jpeg', type: 'image/jpeg', data: jpeg, linkedTo: 'travelExpenses:x1' },
    { id: 'r2', name: 'image.jpg', type: 'image/jpeg', data: jpeg, linkedTo: 'travelExpenses:x2' },
  ];
  const m = mount(Expenses, { data: { settings, travelExpenses: EXPENSES.map(e => ({ ...e })), documents, invoices: [] } });
  btn(m, t => t.startsWith('Invoice'), 'Invoice').props.onClick();
  await settle();
  await btn(m, t => t.includes('Create & send'), 'send').props.onClick();
  await settle();
  assert.equal(shares.length, 1);
  const [pdf, ...receipts] = shares[0].files;
  assert.equal(pdf.name, 'Invoice EXP-20260910-01 from Jordan Sample DO.pdf');
  const raw = await pdfText(pdf);
  assert.ok(raw.includes('555-010-0199'));
  assert.ok(!raw.includes('DO, DO'));
  assert.equal(receipts.length, 2, 'both receipts ride along');
  for (const r of receipts) assert.doesNotMatch(r.name, /^(IMG_\d+|image)\./, `${r.name} is named for what it is`);
  assert.ok(receipts.every(r => r.name.includes('Jordan Sample DO') && /\.jpe?g$/.test(r.name)), receipts.map(r => r.name).join(' | '));
});

test('no invoice screen builds the physician by hand any more', () => {
  for (const f of ['WorkLog', 'DutyLog', 'Expenses']) {
    const src = readFileSync(new URL(`../../src/components/features/locum/${f}.jsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /s\.name \? `\$\{s\.name\}\$\{s\.degreeType/, f);
    assert.match(src, /physicianLabel\(s\)|invoiceSenderFields\(s\)/, f);
    assert.match(src, /email: s\.email, phone: s\.phone/, f);
  }
});
