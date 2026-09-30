import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, pinClock } from './harness/component-harness.mjs';
import { LAYOUT_LINE_FIELDS } from '../src/utils/billing.js';
import { NORTHFIELD, NORTHFIELD_CONTRACT, northfieldEntries } from './billing/fixtures/northfield.mjs';

// The synthetic Northfield invoice built through the real Work Log (pick the
// days, preview, Copy) and opened again from the Invoices tab: the preview,
// the saved text and the stored invoice all read as day blocks with a total
// per day (src/utils/invoiceLayout.js). Synthetic contract and settings; the
// entries are rebuilt from the fixture (tests/billing/fixtures/northfield.mjs).

pinClock(test, 'America/Chicago', '2026-10-19T12:00:00-05:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";');

const settings = { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999', email: 'doc@example.test' };
const buttonText = (tree, pred) => nodes(tree).find(n => n.type === 'button' && pred(textOf(n)));
const strip = (line) => Object.fromEntries(Object.entries(line).filter(([k]) => !LAYOUT_LINE_FIELDS.includes(k)));
const DAY_TOTALS = ['Total for Fri, Oct 16, 2026', '$4,800.00', 'Total for Sat, Oct 17, 2026', '$6,150.00', 'Total for Sun, Oct 18, 2026', '$6,300.00', 'Total for Mon, Oct 19, 2026', '$3,000.00'];

test('Work Log: the invoice preview and the saved text show every day with its total, and the saved lines are the stored invoice plus its numbers', async () => {
  const m = mount(screens.WorkLog, { data: { settings, locumContracts: [NORTHFIELD_CONTRACT], workLog: northfieldEntries() } });
  buttonText(m.render(), t => /Invoice \d+ unbilled entries/.test(t)).props.onClick();
  const build = buttonText(m.render(), t => t.startsWith('Invoice 4 days'));
  assert.ok(build, 'the four Northfield call days are picked');
  build.props.onClick();
  // Rendering to markup runs the Modal's own hooks, whose effects need a
  // real document; so the Copy button is taken from the tree first.
  const copy = buttonText(m.render(), t => t === 'Copy');
  const html = m.html();
  for (const want of [...DAY_TOTALS, 'in $3,000.00 stipend', 'Callback beyond 4 h', '24-hour call stipend', 'call day 7:00 AM Oct 16 to 7:00 AM Oct 17', '$20,250.00']) {
    assert.ok(html.includes(want.replace(/&/g, '&amp;')), `preview: ${want}`);
  }

  // Copy marks the invoice sent and saves it: text, lines and all.
  const copied = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t) => { copied.push(t); } } } });
  try {
    await copy.props.onClick();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
  }
  const invoice = m.calls.find(c => c[0] === 'add' && c[1] === 'invoices')[2];
  assert.equal(invoice.totalAmount, 20250);
  assert.equal(copied[0], invoice.text);
  for (const t of ['Total for Fri, Oct 16, 2026: $4,800.00', 'Total for Sat, Oct 17, 2026: $6,150.00', 'Total for Sun, Oct 18, 2026: $6,300.00', 'Total for Mon, Oct 19, 2026: $3,000.00', 'TOTAL DUE: $20,250.00']) {
    assert.ok(invoice.text.split('\n').includes(t), `text: ${t}`);
  }
  assert.match(invoice.text, /^ {5}Rounding: Ward list and handoff notes \u{b7} 3:30 PM\u{2013}7:30 PM \u{b7} 4\.00 h \u{b7} in \$3,000\.00 stipend$/mu);
  assert.ok(!invoice.text.includes(String.fromCodePoint(0x2014)), 'no em dash');
  assert.equal(JSON.stringify(invoice.lines.map(strip)), JSON.stringify(NORTHFIELD.lines), 'the same lines the stored invoice holds');
  assert.equal(invoice.lines[0].kind, 'stipendDay');
  assert.equal(invoice.lines[0].dayStartHour, 7);
});

test('Invoices tab: a stored invoice from before the layout opens as day blocks with day totals', () => {
  const stored = { id: 'inv-northfield', number: 'INV-20261019-01', contractId: NORTHFIELD_CONTRACT.id, periodStart: '2026-10-16', periodEnd: '2026-10-19', entryIds: [], totalAmount: NORTHFIELD.total, totalMinutes: NORTHFIELD.totalMin, dayOverMin: NORTHFIELD.dayOverMin, sentAt: '2026-10-19T17:00:00Z', lines: NORTHFIELD.lines, text: 'stored text', terms: 'Synthetic terms' };
  const m = mount(screens.Invoices, { data: { settings, locumContracts: [NORTHFIELD_CONTRACT], invoices: [stored] } });
  const card = nodes(m.render()).find(n => n.key === stored.id && typeof n.props?.onClick === 'function');
  card.props.onClick({ stopPropagation() {} });
  const html = m.html();
  for (const want of [...DAY_TOTALS, 'in $3,000.00 stipend', 'Callback beyond 4 h', 'call day 7:00 AM Oct 19 to 7:00 AM Oct 20']) {
    assert.ok(html.includes(want), `view: ${want}`);
  }
});

test('Work Log: an agreement that bills fractions of a cent previews without day totals, and says why', () => {
  // $262.50/hr: a quarter-hour call is $65.625, two of them $131.25; rounded
  // one by one they would print $131.26 of lines against a $131.25 total.
  const contract = { id: 'c-fraction', facility: 'Synthetic Hospital', agency: 'Synthetic Locums', payModel: 'hourly', callStipend: 0, hourlyRate: 262.5, callHourlyRate: 262.5, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] };
  const call = (id, start, end) => ({ id, createdAt: '2026-09-01T00:00:00Z', contractId: contract.id, type: 'Call', date: '2026-08-04', callDay: '2026-08-04', startTime: start, endTime: end, durationMin: 5, billedMin: 15, description: '', privateNote: '', invoiceId: null });
  const m = mount(screens.WorkLog, { data: { settings, locumContracts: [contract], workLog: [call('f1', '2026-08-04T20:00:00-05:00', '2026-08-04T20:05:00-05:00'), call('f2', '2026-08-04T21:00:00-05:00', '2026-08-04T21:05:00-05:00')] } });
  buttonText(m.render(), t => /Invoice 2 unbilled entries/.test(t)).props.onClick();
  buttonText(m.render(), t => t.startsWith('Invoice 1 day')).props.onClick();
  const html = m.html();
  assert.match(html, /No day totals on this invoice: this agreement bills fractions of a cent \(one line comes to \$65\.625\), so day totals rounded to the cent would not add up to the total due\./);
  assert.ok(!html.includes('Total for Tue, Aug 4, 2026'), 'no day total');
  assert.ok(html.includes('$131.25'), 'the total due');
  // Northfield's whole cents say nothing of the kind.
  const northfield = mount(screens.WorkLog, { data: { settings, locumContracts: [NORTHFIELD_CONTRACT], workLog: northfieldEntries() } });
  buttonText(northfield.render(), t => /Invoice \d+ unbilled entries/.test(t)).props.onClick();
  buttonText(northfield.render(), t => t.startsWith('Invoice 4 days')).props.onClick();
  assert.doesNotMatch(northfield.html(), /fractions of a cent/);
});
