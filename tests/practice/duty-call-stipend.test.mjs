import test from 'node:test';
import assert from 'node:assert/strict';
import { dutyDayPay, summarizeDuties } from '../../src/utils/dutyPay.js';

// PRAC-003: a day-rate contract with no call rate grid prices each call
// period at the contract's call stipend. A contract WITH a grid keeps pricing
// from the grid, and a hospital the grid no longer names still prices $0 (the
// invoice builder asks before it goes out). Synthetic contracts only.

const GRIDLESS = { id: 'c-day', facility: 'Synthetic Valley Hospital', payModel: 'daily', dayRate: 2000, callStipend: 1000, callRateGrid: null };
const GRADED = {
  id: 'c-grid', facility: 'Synthetic Group', payModel: 'daily', dayRate: 1875.40, callStipend: 800,
  callRateGrid: [{ hospital: 'Synthetic Regional (SR)', primary: 1000, backup: 400 }, { hospital: 'Synthetic Mercy (SM)', primary: 2200, backup: 800 }],
};
const workedPlusCall = (date, hospital = 'Synthetic Valley Hospital') => ({ id: `d-${date}`, date, workedDay: true, callPeriods: [{ hospital, role: 'primary' }] });

test('gridless day-rate contract: 3 worked days with call invoice $9,000, not $6,000', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03'].map(d => workedPlusCall(d));
  const pays = days.map(d => dutyDayPay(GRIDLESS, d));
  assert.deepEqual(pays[0].lines.map(l => l.amount), [2000, 1000]);
  assert.deepEqual(pays.map(p => p.total), [3000, 3000, 3000]);
  const sum = summarizeDuties(GRIDLESS, days);
  assert.equal(sum.total, 9000);
  assert.equal(sum.dayWork, 6000);
  assert.equal(sum.callPay, 3000);
  assert.equal(sum.byHospital.reduce((s, h) => s + h.amount, 0), 3000, 'the per-hospital split adds up to the call pay');
});

test('an empty grid counts as no grid', () => {
  assert.equal(dutyDayPay({ ...GRIDLESS, callRateGrid: [] }, workedPlusCall('2026-09-01')).total, 3000);
});

test('graded contract: the grid prices call, the stipend is never a fallback for a mismatched hospital', () => {
  assert.equal(dutyDayPay(GRADED, workedPlusCall('2026-09-01', 'Synthetic Mercy (SM)')).total, 4075.40);
  const mismatched = dutyDayPay(GRADED, workedPlusCall('2026-09-01', 'Synthetic Elsewhere'));
  assert.deepEqual(mismatched.lines.map(l => l.amount), [1875.40, 0]);
  assert.equal(summarizeDuties(GRADED, [workedPlusCall('2026-09-01', 'Synthetic Elsewhere')]).callPay, 0);
});

test('gridless contract with no stipend prices call at $0', () => {
  assert.equal(dutyDayPay({ ...GRIDLESS, callStipend: 0 }, workedPlusCall('2026-09-01')).total, 2000);
});
