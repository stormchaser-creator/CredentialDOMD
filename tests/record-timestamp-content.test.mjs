import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';
const { recordContent } = fixture().api;
const content = paidAt => recordContent('invoices', { id: 'synthetic', paidAt });
test('only schema-known timestamptz fields compare equal across equivalent server timezone formats', () => {
  const expected = content('2026-09-30T12:30:00.000Z');
  for (const value of ['2026-09-30T12:30:00+00:00', '2026-09-30T05:30:00.000000-07:00', '2026-10-01T01:30:00+13:00', '2026-09-30 12:30:00Z']) assert.equal(content(value), expected);
  for (const [collection, field] of [['customCategories', 'archivedAt'], ['taskNotes', 'capturedAt'], ['workLog', 'startTime'], ['shareLog', 'sentAt'], ['notificationLog', 'date']]) {
    assert.equal(recordContent(collection, { id: 'synthetic', [field]: '2026-09-30T12:30:00Z' }), recordContent(collection, { id: 'synthetic', [field]: '2026-09-30T05:30:00-07:00' }));
  }
  for (const field of ['date', 'notes', 'customFields']) {
    const a = field === 'customFields' ? { date: '2026-09-30T12:30:00Z' } : '2026-09-30T12:30:00Z';
    const b = field === 'customFields' ? { date: '2026-09-30T05:30:00-07:00' } : '2026-09-30T05:30:00-07:00';
    assert.notEqual(recordContent('licenses', { id: 'synthetic', [field]: a }), recordContent('licenses', { id: 'synthetic', [field]: b }));
  }
});
test('microsecond differences and invalid/zone-less values remain distinct', () => {
  assert.notEqual(content('2026-09-30T12:30:00.000001Z'), content('2026-09-30T12:30:00.000002Z'));
  assert.equal(content('2026-09-30T12:30:00.123400Z'), content('2026-09-30T05:30:00.1234-07:00'));
  for (const invalid of ['2026-02-30T12:30:00Z', '2026-09-30T12:30:00', '2026-09-30', 'tomorrow', 'infinity', '2026-09-30T25:00:00Z', '2026-09-30T12:30:00.0000001Z', ['timestamptz', 1790771400000, '000000']]) assert.notEqual(content(invalid), content('2026-09-30T12:30:00Z'));
  assert.notEqual(content('2026-02-30T12:30:00Z'), content('2026-03-02T12:30:00Z'), 'invalid dates cannot roll forward into a valid date');
});
