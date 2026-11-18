import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance } from '../src/utils/compliance.js';
import { coursesThatMayCount, topicCountingPool, suggestTopicsForText, matchReasonText, withTopicAdded } from '../src/utils/topicMatch.js';

// Synthetic records only.
const EXP = '2027-09-30';
const cme = [
  { id: 'a', title: 'Safe Opioid Prescribing and Schedule II Risks', category: 'AOA Category 1-A', hours: 2, date: '2026-03-01', topics: [] },
  { id: 'b', title: 'Spine update', notes: 'Covered psychostimulant misuse and addiction screening', category: 'AOA Category 1-A', hours: 1, date: '2026-04-01', topics: 'Ethics' },
  { id: 'c', title: 'Opioid course already tagged', category: 'AOA Category 1-A', hours: 1, date: '2026-05-01', topics: ['Substance Use Disorders'] },
  { id: 'd', title: 'Opioid stewardship', category: 'AOA Category 1-A', hours: 1, date: '2020-01-01', topics: [] },
  { id: 'e', title: 'Painless suturing in Spain', category: 'AOA Category 1-A', hours: 1, date: '2026-06-01', topics: [] },
  { id: 'f', title: 'Grand rounds', customFields: { Sessions: 'Chronic pain after laminectomy' }, category: 'AOA Category 1-A', hours: 1, date: '2026-07-01', topics: [] },
  { id: 'g', title: 'Geriatric falls', category: 'AMA PRA Category 2', hours: 1, date: '2026-07-02', topics: [] },
];
const comp = computeCompliance(cme, 'CA', 'DO', { licenseExpiration: EXP, cycleStart: '2025-10-01' });
const row = (name) => comp.topicResults.find(t => t.topic === name);

test('keyword map names the topic and the word that matched', () => {
  const hits = suggestTopicsForText('Opioid use and Schedule II prescribing');
  assert.deepEqual(hits.find(h => h.topic === 'Substance Use Disorders'), { topic: 'Substance Use Disorders', term: 'opioid' });
  assert.ok(hits.some(h => h.topic === 'Controlled Substances'));
  assert.deepEqual(suggestTopicsForText('Spain, painless, Schedule III'), []);
  assert.deepEqual(suggestTopicsForText(''), []);
});

test('per-cycle topic: only untagged courses in the window that name it, with reasons', () => {
  const sud = row('Substance Use Disorders');
  const out = coursesThatMayCount(sud, topicCountingPool(comp, sud, cme));
  assert.deepEqual(out.map(m => m.entry.id), ['b', 'a'], 'newest first; tagged and out-of-window courses left out');
  assert.equal(matchReasonText(out[1].reasons), 'title mentions "opioid", "Schedule II"');
  assert.equal(matchReasonText(out[0].reasons), 'notes mention "psychostimulant", "addiction"');
});

test('one-time topic counts over all dates; session list matches; whole words only', () => {
  const pain = row('Pain Management');
  assert.equal(pain.period, 'lifetime');
  const out = coursesThatMayCount(pain, topicCountingPool(comp, pain, cme));
  assert.deepEqual(out.map(m => m.entry.id), ['f']);
  assert.equal(matchReasonText(out[0].reasons), 'session list mentions "pain"');
});

test('alsoTopics tags count and a course with an accepted tag is already counted', () => {
  const rule = { topic: 'Pain Management', alsoTopics: ['Opioid Prescribing'] };
  const out = coursesThatMayCount(rule, cme);
  assert.ok(out.some(m => m.entry.id === 'a' && m.reasons.some(r => r.tag === 'Opioid Prescribing')));
  const tagged = coursesThatMayCount(rule, [{ id: 'x', title: 'Opioid basics', topics: ['Opioid Prescribing'] }]);
  assert.deepEqual(tagged, []);
});

test('a credit type the rule does not accept is not suggested', () => {
  const rule = { topic: 'Geriatric Medicine', acceptedCategories: ['AMA PRA Category 1'] };
  assert.deepEqual(coursesThatMayCount(rule, cme), []);
  assert.deepEqual(coursesThatMayCount({ topic: 'Geriatric Medicine' }, cme).map(m => m.entry.id), ['g']);
});

test('counting a course adds the topic once and makes the topic count', () => {
  const added = withTopicAdded(cme[1], 'Substance Use Disorders');
  assert.deepEqual(added.topics, ['Ethics', 'Substance Use Disorders']);
  assert.deepEqual(withTopicAdded(added, 'Substance Use Disorders').topics, added.topics);
  const after = computeCompliance(cme.map(c => c.id === 'a' ? withTopicAdded(c, 'Substance Use Disorders') : c), 'CA', 'DO', { licenseExpiration: EXP, cycleStart: '2025-10-01' });
  assert.equal(after.topicResults.find(t => t.topic === 'Substance Use Disorders').earned, 3);
});

test('no window means no in-period courses for a per-cycle topic', () => {
  assert.deepEqual(topicCountingPool({}, { topic: 'Ethics', period: null }, cme), []);
  assert.equal(topicCountingPool({ windowStart: '2025-10-01', windowEnd: EXP }, { period: { years: 10 } }, cme).length, 7);
});
