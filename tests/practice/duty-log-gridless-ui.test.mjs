import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, pinClock } from '../harness/component-harness.mjs';

// PRAC-003 / PRAC-012: on a day-rate contract with no call rate grid, a call
// period can be logged (it was silently dropped on save) and it invoices at
// the contract's call stipend. Driven through the real Days & call screen.
// Synthetic contracts only.

pinClock(test, 'America/Chicago', '2026-09-10T12:00:00-05:00');
const { DutyLog } = await loadScreens('export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";');

const GRIDLESS = { id: 'c-day', facility: 'Synthetic Valley Hospital', shortName: 'SVH', agency: '', payModel: 'daily', dayRate: 2000, callStipend: 1000, callRateGrid: null };

const logDay = (m, date) => {
  click(m, '+ Log a day');
  find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: date } });
  click(m, '+ Add a call period');
  click(m, 'Save');
};

test('a call period on a gridless contract is kept on save and prices at the stipend', () => {
  const m = mount(DutyLog, { data: { locumContracts: [GRIDLESS], dutyDays: [] }, props: { contract: GRIDLESS } });
  logDay(m, '2026-09-01');
  const adds = m.calls.filter(c => c[0] === 'add' && c[1] === 'dutyDays').map(c => c[2]);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].callPeriods.length, 1, 'the call period survives the save');
  assert.equal(adds[0].callPeriods[0].hospital, 'SVH');
  assert.equal(adds[0].amount, 3000);
});

test('three worked days with call invoice $9,000, with stipend terms', async () => {
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true, writable: true });
  const m = mount(DutyLog, { data: { locumContracts: [GRIDLESS], dutyDays: [], invoices: [] }, props: { contract: GRIDLESS } });
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) logDay(m, d);
  const cta = find(m.render(), n => n.type === 'button' && textOf(n).includes('Invoice 3 unbilled days'), 'invoice CTA');
  assert.match(textOf(cta), /\$9,000\.00/);
  cta.props.onClick();
  click(m, 'Invoice 3 days');
  assert.equal(m.dialogs.filter(d => d[0] === 'confirm').length, 0, 'no $0 call warning');
  const table = find(m.render(), n => n.type?.name === 'InvoiceLinesTable', 'lines table');
  assert.equal(table.props.inv.total, 9000);
  click(m, 'Copy text');
  await new Promise(r => setImmediate(r));
  const inv = m.calls.find(c => c[0] === 'add' && c[1] === 'invoices')?.[2];
  assert.ok(inv, 'invoice recorded');
  assert.equal(inv.totalAmount, 9000);
  assert.equal(inv.lines.filter(l => l.label.startsWith('On call')).reduce((s, l) => s + l.amount, 0), 3000);
  assert.match(inv.terms, /per the call stipend \(\$1,000\.00 per period\)/);
  assert.doesNotMatch(inv.terms, /grid/);
  assert.match(copied[0], /9,000\.00/);
});

test('the call row on a gridless contract is a text field, not an empty picker', () => {
  const m = mount(DutyLog, { data: { locumContracts: [GRIDLESS], dutyDays: [] }, props: { contract: GRIDLESS } });
  click(m, '+ Log a day');
  click(m, '+ Add a call period');
  const tree = m.render();
  assert.equal(nodes(tree).filter(n => n.type === 'select').length, 0);
  const site = find(tree, n => n.type === 'input' && n.props['aria-label'] === 'Call period 1 site', 'site input');
  assert.equal(site.props.value, 'SVH');
});
