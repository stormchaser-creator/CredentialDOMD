import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encounterWRVU, estimatedBonus, bonusProgress, currentBonusPeriod, inBonusPeriod, bonusPeriodLabel,
  savedBonusTerms, hasBonusTerms, positiveNumber, validIsoDate, bonusMoney, bonusWRVU, BONUS_ESTIMATE_NOTE,
} from '../../src/utils/bonusTracking.js';

// The bonus calculation, on synthetic agreements and RVU entries only.
// Nothing here reads a clock: every case passes its own "today".

const enc = (date, wRVU, { units = 1, contractId = 'c1', id } = {}) => ({ id: id || `${date}-${wRVU}-${units}`, contractId, date, codes: [{ code: '99213', wRVU, units }] });
const TERMS = { id: 'c1', bonusWrvuTarget: 6000, bonusPeriod: 'annual', bonusPeriodStart: '2026-07-01', bonusRatePerWrvu: 52.5 };

test("an entry's wRVU is each code's wRVU times its units, as the RVUs tab sums it", () => {
  assert.equal(encounterWRVU({ codes: [{ wRVU: 1.3, units: 2 }, { wRVU: 22.5 }, { wRVU: 0, units: 3 }, { units: 4 }] }), 1.3 * 2 + 22.5);
  assert.equal(encounterWRVU({ codes: [] }), 0);
  assert.equal(encounterWRVU({}), 0);
  assert.equal(encounterWRVU(null), 0);
});

test('below the threshold the estimated bonus is $0', () => {
  assert.equal(estimatedBonus(5999.99, 6000, 52.5), 0);
  assert.equal(estimatedBonus(0, 6000, 52.5), 0);
  const p = bonusProgress(TERMS, [enc('2026-08-01', 4200)], '2026-11-16');
  assert.equal(p.status, 'ready');
  assert.equal(p.logged, 4200);
  assert.equal(p.percent, 70);
  assert.equal(p.remaining, 1800);
  assert.equal(p.over, 0);
  assert.equal(p.bonus, 0);
});

test('exactly at the threshold: 100%, nothing to go, and still $0', () => {
  assert.equal(estimatedBonus(6000, 6000, 52.5), 0);
  const p = bonusProgress(TERMS, [enc('2026-08-01', 6000)], '2026-11-16');
  assert.equal(p.percent, 100);
  assert.equal(p.remaining, 0);
  assert.equal(p.over, 0);
  assert.equal(p.fill, 1);
  assert.equal(p.bonus, 0);
});

test('above the threshold: (logged - threshold) x rate', () => {
  assert.equal(estimatedBonus(6120.5, 6000, 52.5), 6326.25);
  const p = bonusProgress(TERMS, [enc('2026-08-01', 6000), enc('2026-09-01', 120.5)], '2026-11-16');
  assert.equal(p.logged, 6120.5);
  assert.equal(p.over, 120.5);
  assert.equal(p.remaining, 0);
  assert.equal(p.percent, 102, 'the percent can pass 100');
  assert.equal(p.fill, 1, 'the bar stops at the target');
  assert.equal(p.bonus, 6326.25);
});

test('a missing target or rate gives no bonus figure, and a missing target no progress either', () => {
  for (const blank of [null, undefined, '', 0, '0', -5, 'abc', NaN, Infinity]) {
    assert.equal(estimatedBonus(7000, blank, 52.5), null, `target ${String(blank)}`);
    assert.equal(estimatedBonus(7000, 6000, blank), null, `rate ${String(blank)}`);
  }
  const entries = [enc('2026-08-01', 7000)];
  const noRate = bonusProgress({ ...TERMS, bonusRatePerWrvu: null }, entries, '2026-11-16');
  assert.equal(noRate.status, 'needs-rate');
  assert.equal(noRate.bonus, null);
  assert.equal(noRate.percent, 116, 'progress is still shown against the target');
  const noTarget = bonusProgress({ ...TERMS, bonusWrvuTarget: '' }, entries, '2026-11-16');
  assert.equal(noTarget.status, 'needs-target');
  assert.equal(noTarget.bonus, null);
  assert.equal(noTarget.percent, null);
  assert.equal(noTarget.remaining, null);
  const none = bonusProgress({ id: 'c1' }, entries, '2026-11-16');
  assert.equal(none.status, 'none');
  assert.equal(none.bonus, null);
  assert.equal(hasBonusTerms({ id: 'c1' }), false);
  assert.equal(hasBonusTerms({ bonusRatePerWrvu: 40 }), true);
});

test('decimals: wRVUs to the hundredth, the rate to four places, the bonus to the cent with halves up', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point; the logged total is not.
  const p = bonusProgress({ ...TERMS, bonusWrvuTarget: 0.25, bonusRatePerWrvu: 10 }, [enc('2026-08-01', 0.1), enc('2026-08-02', 0.2)], '2026-11-16');
  assert.equal(p.logged, 0.3);
  assert.equal(p.over, 0.05);
  assert.equal(p.bonus, 0.5);
  // 0.01 wRVU over at $52.375 is $0.52375: 52 cents.
  assert.equal(estimatedBonus(6000.01, 6000, 52.375), 0.52);
  // 0.02 over is $1.0475: rounds up to $1.05.
  assert.equal(estimatedBonus(6000.02, 6000, 52.375), 1.05);
  // Exactly half a cent rounds up: 0.01 x $0.50 = $0.005.
  assert.equal(estimatedBonus(1.01, 1, 0.5), 0.01);
  // A fractional threshold and a rate past the cent.
  assert.equal(estimatedBonus(1500.75, 1250.25, 57.4532), 14392.03);
  // Units multiply before anything is rounded: 3 x 1.115 = 3.345, shown as 3.35.
  assert.equal(bonusProgress({ id: 'c1', bonusWrvuTarget: 1 }, [enc('2026-08-01', 1.115, { units: 3 })], '2026-11-16').logged, 3.35);
  // Large figures stay exact.
  assert.equal(estimatedBonus(123456.78, 100000, 99.9999), 2345675.65);
});

test('the percent is rounded down, so 99.99% never reads as reached', () => {
  assert.equal(bonusProgress(TERMS, [enc('2026-08-01', 5999.99)], '2026-11-16').percent, 99);
  assert.equal(bonusProgress(TERMS, [enc('2026-08-01', 59.99)], '2026-11-16').percent, 0);
  assert.equal(bonusProgress(TERMS, [], '2026-11-16').percent, 0);
});

test('annual period from a start date: a fiscal year, with both boundary days inside', () => {
  const w = currentBonusPeriod(TERMS, '2026-11-16');
  assert.deepEqual([w.start, w.end, w.calendar, w.upcoming], ['2026-07-01', '2027-06-30', false, false]);
  // The first and last day belong to the period; the days either side do not.
  assert.deepEqual(['2026-06-30', '2026-07-01', '2027-06-30', '2027-07-01'].map(d => inBonusPeriod(d, w)), [false, true, true, false]);
  // On the last day it is still this period; the next morning it is the next one.
  assert.equal(currentBonusPeriod(TERMS, '2027-06-30').start, '2026-07-01');
  assert.deepEqual([currentBonusPeriod(TERMS, '2027-07-01').start, currentBonusPeriod(TERMS, '2027-07-01').end], ['2027-07-01', '2028-06-30']);
  // Years later it has rolled forward by whole years.
  assert.equal(currentBonusPeriod(TERMS, '2031-03-10').start, '2030-07-01');
  const entries = [enc('2026-06-30', 100), enc('2026-07-01', 10), enc('2027-06-30', 20), enc('2027-07-01', 1000)];
  assert.equal(bonusProgress(TERMS, entries, '2026-11-16').logged, 30);
  assert.equal(bonusProgress(TERMS, entries, '2027-07-01').logged, 1000, 'a new period starts from zero');
});

test('quarterly and monthly periods from a start date', () => {
  const q = { ...TERMS, bonusPeriod: 'quarterly', bonusPeriodStart: '2026-02-15' };
  assert.deepEqual([currentBonusPeriod(q, '2026-05-14').start, currentBonusPeriod(q, '2026-05-14').end], ['2026-02-15', '2026-05-14']);
  assert.deepEqual([currentBonusPeriod(q, '2026-05-15').start, currentBonusPeriod(q, '2026-05-15').end], ['2026-05-15', '2026-08-14']);
  const m = { ...TERMS, bonusPeriod: 'monthly', bonusPeriodStart: '2026-01-15' };
  assert.deepEqual([currentBonusPeriod(m, '2026-11-14').start, currentBonusPeriod(m, '2026-11-14').end], ['2026-10-15', '2026-11-14']);
  assert.deepEqual([currentBonusPeriod(m, '2026-11-15').start, currentBonusPeriod(m, '2026-11-15').end], ['2026-11-15', '2026-12-14']);
});

test('a start on the 31st uses the last day of a short month, then returns to the 31st', () => {
  const m = { ...TERMS, bonusPeriod: 'monthly', bonusPeriodStart: '2026-01-31' };
  assert.deepEqual([currentBonusPeriod(m, '2026-02-27').start, currentBonusPeriod(m, '2026-02-27').end], ['2026-01-31', '2026-02-27']);
  assert.deepEqual([currentBonusPeriod(m, '2026-02-28').start, currentBonusPeriod(m, '2026-02-28').end], ['2026-02-28', '2026-03-30']);
  assert.deepEqual([currentBonusPeriod(m, '2026-03-31').start, currentBonusPeriod(m, '2026-03-31').end], ['2026-03-31', '2026-04-29']);
  // Leap day: an annual period from Feb 29 starts Feb 28 in other years.
  const a = { ...TERMS, bonusPeriodStart: '2024-02-29' };
  assert.deepEqual([currentBonusPeriod(a, '2026-11-16').start, currentBonusPeriod(a, '2026-11-16').end], ['2026-02-28', '2027-02-27']);
  assert.deepEqual([currentBonusPeriod(a, '2028-03-01').start, currentBonusPeriod(a, '2028-03-01').end], ['2028-02-29', '2029-02-27']);
});

test('a period with no start date is the calendar year, quarter or month', () => {
  const at = (bonusPeriod, day) => { const w = currentBonusPeriod({ ...TERMS, bonusPeriod, bonusPeriodStart: null }, day); return [w.start, w.end, w.calendar]; };
  assert.deepEqual(at('annual', '2026-11-16'), ['2026-01-01', '2026-12-31', true]);
  assert.deepEqual(at('annual', '2026-12-31'), ['2026-01-01', '2026-12-31', true]);
  assert.deepEqual(at('annual', '2027-01-01'), ['2027-01-01', '2027-12-31', true]);
  assert.deepEqual(at('quarterly', '2026-11-16'), ['2026-10-01', '2026-12-31', true]);
  assert.deepEqual(at('quarterly', '2026-09-30'), ['2026-07-01', '2026-09-30', true]);
  assert.deepEqual(at('monthly', '2026-11-16'), ['2026-11-01', '2026-11-30', true]);
  assert.deepEqual(at('monthly', '2028-02-29'), ['2028-02-01', '2028-02-29', true]);
});

test('no period: everything under the agreement, or everything since the start date', () => {
  const all = { id: 'c1', bonusWrvuTarget: 100, bonusRatePerWrvu: 50 };
  const entries = [enc('2019-01-01', 40), enc('2026-11-16', 70)];
  assert.deepEqual(currentBonusPeriod(all, '2026-11-16'), { start: null, end: null, period: null, calendar: false, upcoming: false });
  assert.equal(bonusProgress(all, entries, '2026-11-16').logged, 110);
  assert.equal(bonusProgress(all, entries, '2026-11-16').bonus, 500);
  const since = { ...all, bonusPeriodStart: '2026-01-01' };
  assert.equal(bonusProgress(since, entries, '2026-11-16').logged, 70);
  // An unknown period value is treated as no period, never as a guess.
  assert.equal(currentBonusPeriod({ ...since, bonusPeriod: 'weekly' }, '2026-11-16').period, null);
});

test('a start date still ahead: the first period, marked as not started, with nothing counted before it', () => {
  const w = currentBonusPeriod({ ...TERMS, bonusPeriodStart: '2027-01-01' }, '2026-11-16');
  assert.deepEqual([w.start, w.end, w.upcoming], ['2027-01-01', '2027-12-31', true]);
  const p = bonusProgress({ ...TERMS, bonusPeriodStart: '2027-01-01' }, [enc('2026-11-01', 500)], '2026-11-16');
  assert.equal(p.logged, 0);
  assert.equal(p.bonus, 0);
});

test("only this agreement's entries count; entries with no agreement are reported, not added", () => {
  const entries = [
    enc('2026-08-01', 100),
    enc('2026-08-02', 900, { contractId: 'other' }),
    enc('2026-08-03', 12.5, { contractId: null }),
    enc('2026-08-04', 7.5, { contractId: '' }),
    enc('2026-01-04', 300, { contractId: null }),   // outside the period
    { id: 'no-date', contractId: 'c1', codes: [{ wRVU: 50 }] },
    { id: 'bad-date', contractId: 'c1', date: 'last Tuesday', codes: [{ wRVU: 50 }] },
  ];
  const p = bonusProgress(TERMS, entries, '2026-11-16');
  assert.equal(p.logged, 100);
  assert.equal(p.entries, 1);
  assert.equal(p.unassigned, 20);
  // With no period and no start date it is everything under the agreement,
  // dated or not: the agreement summary's own Total wRVU.
  assert.equal(bonusProgress({ id: 'c1', bonusWrvuTarget: 10 }, entries, '2026-11-16').logged, 200);
  // A start date alone needs a date to compare, so the undated ones drop out.
  assert.equal(bonusProgress({ id: 'c1', bonusWrvuTarget: 10, bonusPeriodStart: '2026-01-01' }, entries, '2026-11-16').logged, 100);
});

test('the same for every profession and pay model: nothing but the terms and the RVU log is read', () => {
  const entries = [enc('2026-08-01', 6120.5)];
  const base = bonusProgress(TERMS, entries, '2026-11-16');
  for (const extra of [{ payModel: 'daily', dayRate: 2000 }, { payModel: 'hourly', hourlyRate: 110, agency: 'Synthetic Staffing' }, { payModel: 'stipend', callStipend: 3000 }, { facility: 'Synthetic Clinic', notes: 'employed, W-2' }]) {
    assert.deepEqual(bonusProgress({ ...TERMS, ...extra }, entries, '2026-11-16'), base);
  }
});

test('labels', () => {
  const fmt = (d) => `<${d}>`;
  assert.equal(bonusPeriodLabel(currentBonusPeriod(TERMS, '2026-11-16'), fmt), 'This year (<2026-07-01> to <2027-06-30>)');
  assert.equal(bonusPeriodLabel(currentBonusPeriod({ ...TERMS, bonusPeriod: 'quarterly', bonusPeriodStart: '' }, '2026-11-16'), fmt), 'This calendar quarter (<2026-10-01> to <2026-12-31>)');
  assert.equal(bonusPeriodLabel(currentBonusPeriod({ ...TERMS, bonusPeriod: 'monthly', bonusPeriodStart: '2027-01-01' }, '2026-11-16'), fmt), 'First month starts <2027-01-01>');
  assert.equal(bonusPeriodLabel(currentBonusPeriod({ id: 'c1', bonusPeriodStart: '2026-07-01' }, '2026-11-16'), fmt), 'Since <2026-07-01>');
  assert.equal(bonusPeriodLabel(currentBonusPeriod({ id: 'c1' }, '2026-11-16'), fmt), 'All wRVUs logged under this agreement');
  assert.equal(bonusMoney(6326.25), '$6,326.25');
  assert.equal(bonusMoney(0), '$0.00');
  assert.equal(bonusWRVU(6120.5), '6,120.5');
  assert.equal(bonusWRVU(6000), '6,000');
  assert.match(BONUS_ESTIMATE_NOTE, /^Estimated bonus based on your logged wRVUs; your employer's statement is the official number\.$/);
});

test('what the form saves: blank is null (never 0), numbers are numbers, bad values are named', () => {
  assert.deepEqual(savedBonusTerms({}).terms, { bonusWrvuTarget: null, bonusPeriod: null, bonusPeriodStart: null, bonusRatePerWrvu: null });
  assert.deepEqual(savedBonusTerms({ bonusWrvuTarget: '', bonusRatePerWrvu: '  ', bonusPeriod: '', bonusPeriodStart: '' }).terms, { bonusWrvuTarget: null, bonusPeriod: null, bonusPeriodStart: null, bonusRatePerWrvu: null });
  assert.deepEqual(savedBonusTerms({ bonusWrvuTarget: '6000', bonusRatePerWrvu: '52.375', bonusPeriod: 'annual', bonusPeriodStart: '2026-07-01' }).terms,
    { bonusWrvuTarget: 6000, bonusPeriod: 'annual', bonusPeriodStart: '2026-07-01', bonusRatePerWrvu: 52.375 });
  // Stored precision: the target to two places, the rate to four.
  assert.deepEqual(savedBonusTerms({ bonusWrvuTarget: '1250.256', bonusRatePerWrvu: '57.45327' }).terms, { bonusWrvuTarget: 1250.26, bonusPeriod: null, bonusPeriodStart: null, bonusRatePerWrvu: 57.4533 });
  assert.match(savedBonusTerms({ bonusWrvuTarget: '-1' }).problem, /wRVU target must be a number above 0/);
  assert.match(savedBonusTerms({ bonusWrvuTarget: '0' }).problem, /wRVU target must be a number above 0/);
  assert.match(savedBonusTerms({ bonusRatePerWrvu: 'fifty' }).problem, /\$ per wRVU rate must be a number above 0/);
  assert.match(savedBonusTerms({ bonusPeriodStart: '2026-02-30' }).problem, /not a valid date/);
  assert.equal(savedBonusTerms({ bonusPeriod: 'weekly' }).terms.bonusPeriod, null);
  assert.equal(positiveNumber('52.50'), 52.5);
  assert.equal(validIsoDate('2028-02-29'), '2028-02-29');
  assert.equal(validIsoDate('2027-02-29'), null);
});
