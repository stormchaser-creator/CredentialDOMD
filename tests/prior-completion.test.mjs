import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, complianceFor } from '../src/utils/compliance.js';
import { priorCompletionField, priorCompletionOn } from '../src/utils/conditionalCme.js';

const EXP = '2027-09-30';
const cme = [{ id: 'c1', title: 'Synthetic course', category: 'AOA Category 1-A', hours: 60, date: '2026-11-17', topics: ['Substance Use Disorders'] }];
const ca = (answers) => computeCompliance(cme, 'CA', 'DO', { licenseExpiration: EXP, cycleStart: '2025-07-01', topicApplicability: answers });
const topic = (comp, name) => comp.topicResults.find(t => t.topic === name);

test('a one-time topic done before logging is met by the physician confirmation', () => {
  const before = ca({});
  assert.equal(topic(before, 'Pain Management').met, false);
  assert.equal('priorCompletedOn' in topic(before, 'Pain Management'), false, 'unconfirmed output unchanged');
  const after = ca({ [priorCompletionField('Pain Management')]: '2026-11-18' });
  const pain = topic(after, 'Pain Management');
  assert.equal(pain.met, true);
  assert.equal(pain.priorCompletedOn, '2026-11-18');
  assert.equal(pain.earned, 0, 'logged hours are not invented');
  assert.equal(topic(after, 'Substance Use Disorders').met, true, 'tagged course meets the per-cycle hour');
});

test('a per-cycle topic cannot be confirmed away', () => {
  const none = computeCompliance([], 'CA', 'DO', { licenseExpiration: EXP, topicApplicability: { [priorCompletionField('Substance Use Disorders')]: '2026-11-18' } });
  const sud = topic(none, 'Substance Use Disorders');
  assert.equal(sud.met, false);
  assert.equal('priorCompletedOn' in sud, false);
});

test('only a real date counts as a confirmation', () => {
  for (const v of [true, 'Yes', '', 'soon', null]) assert.equal(priorCompletionOn('Pain Management', { [priorCompletionField('Pain Management')]: v }), null);
  assert.equal(priorCompletionOn('Pain Management', { [priorCompletionField('Pain Management')]: '2026-11-18' }), '2026-11-18');
});

test('a confirmation on the old licence survives a renewal into a new record', () => {
  const key = priorCompletionField('Pain Management');
  const data = { cme: [], settings: { degreeType: 'DO' }, licenses: [
    { id: 'old', type: 'State Medical License (DO)', state: 'CA', expirationDate: '2025-09-30', supersededBy: 'new', lifecycleStatus: 'superseded', customFields: { [key]: '2024-01-02' } },
    { id: 'new', type: 'State Medical License (DO)', state: 'CA', expirationDate: '2027-09-30' },
    { id: 'co', type: 'State Medical License (DO)', state: 'CO', expirationDate: '2027-04-30', customFields: { [key]: '2024-01-02' } },
  ] };
  const pain = complianceFor(data, 'CA').topicResults.find(t => t.topic === 'Pain Management');
  assert.equal(pain.met, true);
  assert.equal(pain.priorCompletedOn, '2024-01-02');
  const only = { ...data, licenses: data.licenses.filter(l => l.id !== 'old') };
  assert.equal(complianceFor(only, 'CA').topicResults.find(t => t.topic === 'Pain Management').met, false, 'another state never counts');
});
