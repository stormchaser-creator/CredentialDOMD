import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, click, pinClock } from '../harness/component-harness.mjs';

// PRAC-008: the running timer's "Will bill as" is the figure Stop & Log saves.
// Orientation bills the span between its start and end, each rounded to the
// nearest 15 minutes; other work rounds the rounded minutes up to the
// increment. Synthetic contract only.

const clock = pinClock(test, 'America/Chicago', '2026-09-10T10:24:30-05:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, orientationHourlyRate: 150, callStipend: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };

const run = (type, startedAt) => {
  const m = mount(WorkLog, { data: { locumContracts: [CONTRACT], workLog: [] }, storage: { timer: { contractId: 'c1', type, startedAt }, lastContract: 'c1' } });
  const shown = Number((textOf(m.render()).match(/Will bill as (\d+) min/) || [])[1]);
  click(m, 'Stop & Log');
  const saved = m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2];
  return { shown, saved: saved?.billedMin };
};

test('Orientation 10:08 to 10:24:30: the card and the saved entry both say 15 min', () => {
  const r = run('Orientation', '2026-09-10T15:08:00.000Z');
  assert.deepEqual(r, { shown: 15, saved: 15 });
});

test('Procedure at 15:20 elapsed: the card and the saved entry both say 15 min', () => {
  clock.setNow('2026-09-10T10:35:20-05:00');
  try {
    const r = run('Procedure', '2026-09-10T15:20:00.000Z');
    assert.deepEqual(r, { shown: 15, saved: 15 });
  } finally { clock.setNow('2026-09-10T10:24:30-05:00'); }
});

// PRAC-008: the clock reads 00:00 when the timer starts, never "-1:-1:-1",
// however long the Work tab had been open before Start was tapped.
test('the clock starts at 00:00 when the Work tab was opened a while before Start', () => {
  const m = mount(WorkLog, { data: { locumContracts: [CONTRACT], workLog: [] }, storage: { lastContract: 'c1' } });
  m.render();
  clock.setNow('2026-09-10T10:29:30-05:00'); // five minutes on the page
  try {
    click(m, 'Got a call? Start the timer');
    const page = textOf(m.render());
    assert.match(page, /Call in progress/);
    assert.match(page, /(^|[^\d:])00:00([^:\d]|$)/, 'the clock reads 00:00');
    assert.doesNotMatch(page, /-\d+:-?\d+/, 'no negative clock');
  } finally { clock.setNow('2026-09-10T10:24:30-05:00'); }
});
