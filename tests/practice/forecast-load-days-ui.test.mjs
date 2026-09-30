import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, click, pinClock } from '../harness/component-harness.mjs';

// Forecast's "Load contract coverage dates onto the calendar" (PRAC-025):
// each loaded day is estimated as the day editor suggests for it. A Day on a
// day-rate agreement is its day rate, not the call stipend the blended
// average fell back to. Synthetic agreements only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Forecast } = await loadScreens('export {default as Forecast} from "./src/components/features/locum/Forecast.jsx";');

const DAILY = { id: 'd1', facility: 'Synthetic Day Rate Hospital', payModel: 'daily', dayRate: 2000, callStipend: 1500, coveragePeriods: [{ start: '2026-10-05', end: '2026-10-12' }] };
const STIPEND = { id: 's1', facility: 'Synthetic Stipend Hospital', payModel: 'stipend', hourlyRate: 250, callStipend: 1200, stipendHours: 4, overageHourlyRate: 300, coveragePeriods: [{ start: '2026-10-20', end: '2026-10-21' }] };
const loaded = (m, id) => m.calls.filter(c => c[0] === 'add' && c[1] === 'scheduleDays' && c[2].contractId === id).map(c => c[2]);

test('PRAC-025: loaded days on a $2,000/day agreement with a $1,500 stipend are estimated at $2,000', () => {
  const m = mount(Forecast, { data: { locumContracts: [DAILY], scheduleDays: [] } });
  click(m, 'Load contract coverage dates onto the calendar');
  const days = loaded(m, 'd1');
  assert.equal(days.length, 8);
  assert.deepEqual([...new Set(days.map(d => `${d.kind} ${d.expected}`))], ['day 2000']);
});

test('PRAC-025: a stipend agreement with no billing history still loads its call days at the stipend', () => {
  const m = mount(Forecast, { data: { locumContracts: [STIPEND], scheduleDays: [] } });
  click(m, 'Load contract coverage dates onto the calendar');
  assert.deepEqual(loaded(m, 's1').map(d => [d.date, d.kind, d.expected]), [['2026-10-20', 'call', 1200], ['2026-10-21', 'call', 1200]]);
});

test('PRAC-025: with billed history, a stipend call day loads at the call-day average the editor suggests, not the blend', () => {
  // Two on-call days at $1,800 and a $300 sign-out: the blend was $1,300.
  const invoices = [{ id: 'i1', contractId: 's1', lines: [
    { date: '2026-08-01', label: 'On-call', amount: 1800 },
    { date: '2026-08-02', label: 'On-call', amount: 1800 },
    { date: '2026-08-03', label: 'Sign-out', amount: 300 },
  ] }];
  const m = mount(Forecast, { data: { locumContracts: [STIPEND], scheduleDays: [], invoices } });
  click(m, 'Load contract coverage dates onto the calendar');
  assert.deepEqual([...new Set(loaded(m, 's1').map(d => d.expected))], [1800]);
});
