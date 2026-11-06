import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlacement } from '../src/utils/scheduleGuard.js';

// Ticket 8acf7241 (11-06): two contracts at one facility shared a coverage
// block; the physician archived the old one and every save still warned
// "Two contracts cover this date". Synthetic contracts only.
const block = [{ start: '2026-11-05', end: '2026-11-12', startTime: '06:00', endTime: '06:00', tz: 'America/Chicago' }];
const OLD = { id: 'old', facility: 'Synthetic Fargo', payModel: 'stipend', callStipend: 3000, coveragePeriods: block, customFields: { archivedAt: '2026-11-06T12:02:21Z' } };
const NEW = { id: 'new', facility: 'Synthetic Fargo', payModel: 'stipend', callStipend: 3000, coveragePeriods: block };
const ELSEWHERE = { id: 'else', facility: 'Synthetic Elsewhere', payModel: 'stipend', callStipend: 2000, coveragePeriods: [{ start: '2026-11-06', end: '2026-11-07' }] };

test('an archived contract never makes a date look claimed twice', () => {
  assert.equal(checkPlacement([OLD, NEW], NEW, '2026-11-06'), null);
});
test('the same contract not archived still warns, and so does another active contract', () => {
  const unarchived = { ...OLD, customFields: {} };
  assert.equal(checkPlacement([unarchived, NEW], NEW, '2026-11-06')?.level, 'conflict');
  assert.equal(checkPlacement([OLD, NEW, ELSEWHERE], NEW, '2026-11-06')?.level, 'conflict');
});
