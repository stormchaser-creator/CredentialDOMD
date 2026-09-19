import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBilling } from '../src/utils/billing.js';
import { actualByDate } from '../src/utils/forecast.js';

// Synthetic persisted invoice/work-log records only; no DB or provider access.
const originalTimezone = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-18T12:00:00-07:00'])); }
  static now() { return new RealDate('2026-09-18T12:00:00-07:00').getTime(); }
};
test.after(() => {
  globalThis.Date = RealDate;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});
const DAY = '2026-09-18';
const contract = { id: 'synthetic-contract', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, orientationHourlyRate: 150, coveragePeriods: [{ start: DAY, end: DAY }] };
const entry = (id, billedMin, extra = {}) => ({ id, contractId: contract.id, type: 'Call', date: DAY, callDay: DAY, billedMin, ...extra });
const calculate = (list, all = list, invoices = [], terms = contract) => computeBilling(terms, list, true, all, invoices, new Set([DAY]));
const asInvoice = (id, priced, entries = []) => ({ id, contractId: contract.id, entryIds: entries.map(e => e.id), lines: priced.lines, dayOverMin: priced.dayOverMin, totalAmount: priced.total });
const quietInvoice = () => asInvoice('quiet-invoice', calculate([]));

test('normal first quiet-day invoice charges one stipend and emits numeric-zero day stamp', () => {
  const priced = calculate([]); assert.equal(priced.total, 3000); assert.deepEqual(priced.dayOverMin, { [DAY]: 0 }); assert.deepEqual(priced.emptyStipendDays, [DAY]);
});
test('modern day stamp prevents a second stipend after its zero-minute marker is deleted', () => {
  const old = quietInvoice(); const late = entry('late', 60);
  const priced = calculate([late], [late], [old]);
  assert.equal(priced.total, 0); assert.equal(priced.lines.find(l => l.date === DAY).label, 'Additional work (daily total)'); assert.deepEqual(priced.emptyStipendDays, []);
});
test('coverage sweep alone does not re-invoice a modern quiet-day stamp', () => {
  const old = quietInvoice(); const priced = calculate([], [], [old]);
  assert.equal(priced.total, 0); assert.deepEqual(priced.lines, []); assert.deepEqual(priced.emptyStipendDays, []);
});
test('late overage beyond original quiet-day allowance still bills at its rate', () => {
  const old = quietInvoice(); const late = entry('late', 300);
  const priced = calculate([late], [late], [old]);
  assert.equal(priced.total, 300); assert.deepEqual(priced.dayOverMin, { [DAY]: 60 });
});
test('orientation-only invoice does not suppress legitimate later coverage stipend', () => {
  const orientation = entry('orientation', 120, { type: 'Orientation' });
  const initial = calculate([orientation], [orientation], [], { ...contract, coveragePeriods: [] });
  assert.equal(initial.total, 300); assert.deepEqual(initial.dayOverMin, {});
  const old = asInvoice('orientation-invoice', initial, [orientation]);
  const late = entry('coverage', 300);
  const priced = calculate([late], [{ ...orientation, invoiceId: old.id }, late], [old]);
  assert.equal(priced.total, 3300); assert.equal(old.totalAmount + priced.total, 3600);
});
test('new orientation on an already stamped day remains separately billable', () => {
  const orientation = entry('orientation', 120, { type: 'Orientation' }); const old = quietInvoice();
  const priced = calculate([orientation], [orientation], [old]); assert.equal(priced.total, 300);
});
test('deleting the original coverage invoice reopens stipend despite a retained orientation-only stamp', () => {
  const original = quietInvoice();
  const marker = entry('marker', 0, { type: 'CallDay', invoiceId: original.id });
  const orientation = entry('orientation', 120, { type: 'Orientation' });
  const priced = calculate([orientation], [marker, orientation], [original]);
  assert.equal(priced.total, 300);
  assert.deepEqual(priced.dayOverMin, { [DAY]: 0 });
  assert.deepEqual(priced.lines.map(line => line.label), ['Orientation']);
  const supplemental = asInvoice('orientation-invoice', priced, [orientation]);
  const remaining = [{ ...orientation, invoiceId: supplemental.id }];
  const reopened = calculate([], remaining, [supplemental]);
  assert.equal(reopened.total, 3000);
  assert.deepEqual(reopened.emptyStipendDays, [DAY]);
  assert.equal(actualByDate({ locumContracts: [contract], workLog: remaining, invoices: [supplemental] })[DAY], 3300);
});
test('an additional-work stamp alone cannot stand in for a deleted coverage invoice and entries', () => {
  const original = quietInvoice();
  const marker = entry('marker', 0, { type: 'CallDay', invoiceId: original.id });
  const late = entry('late', 300);
  const priced = calculate([late], [marker, late], [original]);
  assert.equal(priced.total, 300);
  assert.equal(priced.lines[0].label, 'Additional work (daily total)');
  const supplemental = asInvoice('additional-invoice', priced, [late]);
  assert.equal(calculate([], [], [supplemental]).total, 3000);
});
test('remaining invoiced work retains the legacy fallback after deleting a shared-day primary invoice', () => {
  const late = entry('late', 300, { invoiceId: 'supplemental' });
  const supplemental = { id: 'supplemental', contractId: contract.id, entryIds: [late.id], dayOverMin: { [DAY]: 60 }, lines: [{ date: DAY, label: 'Additional work (daily total)', amount: 300 }] };
  // Existing shared-day deletion limitation: the UI warns to delete both
  // invoices and regenerate. This repair does not reinterpret surviving work.
  assert.equal(calculate([], [late], [supplemental]).total, 0);
});
test('a stamp belonging to a different contract cannot suppress this stipend', () => {
  const unrelated = { ...quietInvoice(), contractId: 'another-contract' }; const late = entry('late', 60);
  assert.equal(calculate([late], [late], [unrelated]).total, 3000);
});
test('a stamp on a different day cannot suppress this stipend', () => {
  const otherDay = { ...quietInvoice(), dayOverMin: { '2026-09-17': 0 } }; const late = entry('late', 60);
  assert.equal(calculate([late], [late], [otherDay]).total, 3000);
});
test('legacy missing-stamp invoice retains its existing marker fallback', () => {
  const legacy = quietInvoice(); delete legacy.dayOverMin;
  const marker = entry('marker', 0, { type: 'CallDay', invoiceId: legacy.id }); const late = entry('late', 60);
  assert.equal(calculate([late], [marker, late], [legacy]).total, 0);
});
test('legacy invoice missing both stamp and marker remains explicit unresolved case', () => {
  const legacy = quietInvoice(); delete legacy.dayOverMin; const late = entry('late', 60);
  assert.equal(calculate([late], [late], [legacy]).total, 3000);
});
test('null stamp is not accepted as durable coverage evidence', () => {
  const unstamped = { ...quietInvoice(), dayOverMin: { [DAY]: null } }; const late = entry('late', 60);
  assert.equal(calculate([late], [late], [unstamped]).total, 3000);
});
test('same-invoice coverage proof must match the stamped day, not merely another line', () => {
  const old = quietInvoice(); old.lines[0].date = '2026-09-17';
  assert.equal(calculate([], [], [old]).total, 3000);
});
test('a zero-dollar coverage line is not durable stipend proof', () => {
  const old = quietInvoice(); old.lines[0].amount = 0;
  assert.equal(calculate([], [], [old]).total, 3000);
});
test('missing or older noncanonical invoice lines without a marker remain unresolved', () => {
  for (const lines of [undefined, [], [{ date: DAY, label: 'On-call coverage', amount: 3000 }]]) {
    const old = { ...quietInvoice(), lines };
    assert.equal(calculate([], [], [old]).total, 3000);
  }
});
test('malformed saved lines cannot crash calculation or falsely suppress a stipend', () => {
  for (const lines of [null, {}, 'invalid', [null], [null, {}]]) {
    const old = { ...quietInvoice(), lines };
    assert.equal(calculate([], [], [old]).total, 3000);
    const marker = entry('marker', 0, { type: 'CallDay', invoiceId: old.id });
    assert.equal(calculate([], [marker], [old]).total, 0);
  }
  const old = quietInvoice(); old.lines.unshift(null);
  assert.equal(calculate([], [], [old]).total, 0);
});
test('durable coverage proof requires finite positive numeric money', () => {
  for (const amount of [null, undefined, true, '3000', -1, NaN, Infinity, -Infinity]) {
    const old = quietInvoice(); old.lines[0].amount = amount;
    assert.equal(calculate([], [], [old]).total, 3000);
  }
});
test('frozen prior overage remains netted and later minutes still add correctly', () => {
  const earlier = entry('old', 600); const first = calculate([earlier]);
  assert.equal(first.total, 4800); assert.deepEqual(first.dayOverMin, { [DAY]: 360 });
  const old = asInvoice('earlier-invoice', first, [earlier]); const later = entry('late', 60);
  const priced = calculate([later], [{ ...earlier, invoiceId: old.id }, later], [old]);
  assert.equal(priced.total, 300); assert.deepEqual(priced.dayOverMin, { [DAY]: 60 });
});
test('two invoice stamps do not erase orientation or bill a third stipend', () => {
  const old = quietInvoice(); const followup = { ...old, id: 'supplement', lines: [], dayOverMin: { [DAY]: 0 } };
  const orientation = entry('orientation', 120, { type: 'Orientation' });
  assert.equal(calculate([orientation], [orientation], [old, followup]).total, 300);
});
test('calculation leaves source invoices and work entries unchanged', () => {
  const old = quietInvoice(); const late = entry('late', 300); const input = [[late], [old]]; const before = JSON.stringify(input);
  calculate(input[0], input[0], input[1]); assert.equal(JSON.stringify(input), before);
});
test('Schedule uses the retained modern coverage invoice once after marker loss', () => {
  const old = quietInvoice();
  for (const workLog of [[], [entry('late', 60)]]) {
    assert.equal(actualByDate({ locumContracts: [contract], workLog, invoices: [old] })[DAY], 3000);
  }
});
test('Schedule adds only new overage to a retained modern coverage invoice', () => {
  assert.equal(actualByDate({ locumContracts: [contract], workLog: [entry('late', 300)], invoices: [quietInvoice()] })[DAY], 3300);
});
test('Schedule preserves paid orientation and a legitimate later coverage stipend', () => {
  const orientation = entry('orientation', 120, { type: 'Orientation' });
  const priced = calculate([orientation], [orientation], [], { ...contract, coveragePeriods: [] });
  const old = asInvoice('orientation-invoice', priced, [orientation]);
  const workLog = [{ ...orientation, invoiceId: old.id }, entry('late', 300)];
  assert.equal(actualByDate({ locumContracts: [contract], workLog, invoices: [old] })[DAY], 3600);
});
test('selected-day invoice calculation excludes a different stamped coverage day', () => {
  const yesterday = '2026-09-17';
  const terms = { ...contract, coveragePeriods: [{ start: yesterday, end: DAY }] };
  const old = quietInvoice();
  const priced = computeBilling(terms, [], true, [], [old], new Set([yesterday]));
  assert.equal(priced.total, 3000);
  assert.deepEqual(priced.dayOverMin, { [yesterday]: 0 });
  assert.deepEqual(priced.lines.map(line => line.date), [yesterday]);
});
