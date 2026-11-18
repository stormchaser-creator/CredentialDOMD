import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance } from '../src/utils/compliance.js';
import { sessionTopicHours, topicHoursOf, CME_SESSIONS_FIELD } from '../src/utils/topicSuggest.js';
import { newBoardRecord } from '../src/utils/boardTasks.js';
import { isAlertable, awaitsBoardDate } from '../src/utils/lifecycle.js';
import { isNonExpiring } from '../src/utils/helpers.js';

const conf = (sessions) => ({ id: 'c', title: 'Synthetic Annual Meeting', category: 'AOA Category 1-A', hours: 60, date: '2026-11-10',
  topics: ['Substance Use Disorders', 'Opioid Prescribing'], customFields: { [CME_SESSIONS_FIELD]: sessions } });

test('a session with no printed credit counts 0 h toward its topic, never the whole conference', () => {
  const c = conf([{ title: 'Synthetic stimulant withdrawal', topics: [{ topic: 'Substance Use Disorders' }] }]);
  assert.deepEqual(sessionTopicHours(c, ['Substance Use Disorders']), { hours: 0, sessions: 1, unknown: 1 });
  assert.equal(topicHoursOf(c, ['Substance Use Disorders']), 0);
  assert.equal(topicHoursOf({ hours: 3, topics: ['Ethics'] }, ['Ethics']), 3, 'a whole-course tag counts whole');
});

test('MATE counts only the opioid session, not the conference', () => {
  const c = conf([{ title: 'Synthetic opioid prescribing', hours: 1.5, topics: [{ topic: 'Opioid Prescribing' }] }]);
  const comp = computeCompliance([c], 'CA', 'DO', { licenseExpiration: '2027-09-30', hasDEA: true });
  assert.equal(comp.mate.earned, 1.5);
  assert.equal(comp.mate.met, false);
});

test('a board record the app makes to hold a mark never warns about a missing date', () => {
  const rec = newBoardRecord('ABMS:ABNS', () => 'z');
  assert.equal(rec.noExpiration, undefined, 'no "does not expire" claim (2026-11-18 portal: AOA certificates show a valid thru date)');
  // App.jsx missingExpiration: !expirationDate && !isNonExpiring && !awaitsBoardDate && isAlertable
  assert.equal(!rec.expirationDate && !isNonExpiring(rec, 'licenses') && !awaitsBoardDate(rec) && isAlertable(rec), false);
});
