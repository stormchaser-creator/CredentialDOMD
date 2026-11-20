// Owner tickets 2026-11-20 (synthetic data shaped like the real case).
// de954247: an archived stipend contract added a phantom stipend to the
// calendar's billed figure. 29874d99 / 85f2d177: coverage blocks that turn
// over at 6:00 on a contract whose call day starts at 7:00 filed a 6:37
// call under the next day; the form now flags and aligns them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actualByDate } from '../src/utils/forecast.js';
import { deriveCallDay } from '../src/utils/billing.js';
import { turnoverConflicts, alignTurnovers } from '../src/utils/coverageBlocks.js';

const block = (extra = {}) => ({ tz: 'America/Chicago', start: '2026-11-05', end: '2026-11-12', startTime: '07:00', endTime: '07:00', ...extra });
const stipend = (id, extra = {}) => ({ id, name: 'Synthetic Hospital', location: 'Fargo, ND', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, dayStartHour: 7, coveragePeriods: [block()], ...extra });

test('de954247: an archived stipend contract adds no stipend for coverage days it has no work on', () => {
  const live = stipend('live');
  const old = stipend('old', { customFields: { archivedAt: '2026-11-06T12:02:21Z' } });
  const work = [{ id: 'w1', contractId: 'live', type: 'Call', startTime: '2026-11-05T15:00:00Z', endTime: '2026-11-05T16:00:00Z', callDay: '2026-11-05' }];
  const both = actualByDate({ locumContracts: [live, old], workLog: work, invoices: [], dutyDays: [] });
  const liveOnly = actualByDate({ locumContracts: [live], workLog: work, invoices: [], dutyDays: [] });
  assert.equal(both['2026-11-05'], liveOnly['2026-11-05'], 'the archived duplicate adds nothing');
  assert.ok(liveOnly['2026-11-05'] >= 3000, 'the live contract still bills its stipend day');
});

test('de954247: work logged under an archived contract still counts', () => {
  const old = stipend('old', { customFields: { archivedAt: '2026-11-06T12:02:21Z' } });
  const work = [{ id: 'w1', contractId: 'old', type: 'Call', startTime: '2026-11-06T15:00:00Z', endTime: '2026-11-06T16:00:00Z', callDay: '2026-11-06' }];
  const m = actualByDate({ locumContracts: [old], workLog: work, invoices: [], dutyDays: [] });
  assert.ok(m['2026-11-06'] >= 3000);
  assert.equal(m['2026-11-07'], undefined, 'no sweep onto other coverage days');
});

test('85f2d177: a 6:00 block files a 6:37 call under the new day; aligned to 7:00 it stays on the call day it belongs to', () => {
  const six = stipend('c', { coveragePeriods: [block({ startTime: '06:00', endTime: '06:00' })] });
  assert.equal(deriveCallDay('2026-11-07T12:37:35Z', six), '2026-11-07', 'the reported behaviour');
  assert.deepEqual(turnoverConflicts(six.coveragePeriods, 7), [0]);
  const fixed = { ...six, coveragePeriods: alignTurnovers(six.coveragePeriods, 7) };
  assert.equal(fixed.coveragePeriods[0].startTime, '07:00');
  assert.equal(fixed.coveragePeriods[0].endTime, '07:00');
  assert.equal(deriveCallDay('2026-11-07T12:37:35Z', fixed), '2026-11-06');
  assert.equal(deriveCallDay('2026-11-06T13:00:00Z', fixed), '2026-11-06', '7:00 Central opens the new call day');
  assert.deepEqual(turnoverConflicts(fixed.coveragePeriods, 7), []);
});

test('turnover check: only blocks with an end time that differs; a block with its own start time keeps it', () => {
  const periods = [block(), block({ startTime: '16:00', endTime: '06:00' }), { start: '2026-12-01', end: '2026-12-03' }];
  assert.deepEqual(turnoverConflicts(periods, 7), [1]);
  const out = alignTurnovers(periods, 7);
  assert.equal(out[1].startTime, '16:00');
  assert.equal(out[1].endTime, '07:00');
  assert.equal(out[0], periods[0]);
  assert.equal(out[2], periods[2]);
});

test('c3f23aa8: the summary email\'s prepared report kinds are the app\'s', async () => {
  const { PREPARED_KINDS } = await import('../src/utils/requestReports.js');
  const { PREPARED_REPORT_KINDS } = await import('../supabase/functions/_shared/requestFlow.ts');
  assert.deepEqual([...PREPARED_REPORT_KINDS].sort(), [...PREPARED_KINDS].sort());
});
