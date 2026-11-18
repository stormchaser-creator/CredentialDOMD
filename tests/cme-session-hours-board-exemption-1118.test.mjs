// H2: a topic accepted from one session counts that session's hours, not the
// whole conference. M2: the board certification exemption needs a current
// certificate, holds for one renewal, and the narrower states' conditions
// must be confirmed. Low: Undo of "Count this course" removes only its topic.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, complianceFor, sessionTopicHours, sessionCountText } from '../src/utils/compliance.js';
import {
  BOARD_EXEMPTION_FIELD, BOARD_EXEMPTION_RENEWAL_FIELD, BOARD_EXEMPTION_CONDITION_FIELD, BOARD_EXEMPTION_CONDITIONS,
  boardExemptionOn, boardExemptionFields, currentBoardCertificationOnFile, boardExemptionCondition,
} from '../src/utils/conditionalCme.js';
import { CME_SESSIONS_FIELD } from '../src/utils/topicSuggest.js';
import { withTopicAdded, withTopicRemoved } from '../src/utils/topicMatch.js';
import { getStateEntry } from '../src/constants/stateRequirements.js';

const EXP = '2027-03-31';
const conference = (extra = {}) => ({
  id: 'conf', title: 'Synthetic Annual Spine Meeting', category: 'AMA PRA Category 1', hours: '60', date: '2026-06-10',
  topics: ['Controlled Substances'],
  customFields: { [CME_SESSIONS_FIELD]: [
    { title: 'Intoxication and withdrawal from psychostimulants', hours: 1.5, topics: [] },
    { title: 'Cervical myelopathy update', hours: 2, topics: [] },
  ] },
  ...extra,
});
const ky = (cme) => computeCompliance(cme, 'KY', 'MD', { licenseExpiration: EXP }).topicResults.find(t => t.topic === 'Controlled Substances');

test('H2: one qualifying session in a 60 h conference counts 1.5 h toward the topic, 60 toward the total', () => {
  const comp = computeCompliance([conference()], 'KY', 'MD', { licenseExpiration: EXP });
  const row = comp.topicResults.find(t => t.topic === 'Controlled Substances');
  assert.equal(row.earned, 1.5);
  assert.equal(row.met, false);
  assert.equal(comp.totalEarned, 60);
  assert.deepEqual(row.fromSessions, [{ id: 'conf', title: 'Synthetic Annual Spine Meeting', hours: 1.5, sessions: 1, courseHours: 60 }]);
  assert.equal(sessionCountText(row.fromSessions[0]), '1.5 h from 1 session of Synthetic Annual Spine Meeting');
});

test('H2: a whole-course tag with no qualifying session counts the whole course; a qualifying session without printed hours counts 0', () => {
  const plain = { id: 'p', title: 'Prescribing controlled substances', category: 'AMA PRA Category 1', hours: '5', date: '2026-06-10', topics: ['Controlled Substances'] };
  const row = ky([plain]);
  assert.equal(row.earned, 5);
  assert.equal('fromSessions' in row, false, 'no new key on rows without sessions');
  const unrelated = conference({ customFields: { [CME_SESSIONS_FIELD]: [{ title: 'Cervical myelopathy update', hours: 2 }] } });
  assert.equal(ky([unrelated]).earned, 60);
  const noHours = conference({ customFields: { [CME_SESSIONS_FIELD]: [{ title: 'Intoxication and withdrawal from psychostimulants' }] } });
  assert.equal(ky([noHours]).earned, 0, 'one session of a 60 h conference is never 60 h of the topic');
});

test('H2: sessions are counted once, capped at the course hours, and a scan topic on a session counts', () => {
  const c = conference({ hours: '2', customFields: { [CME_SESSIONS_FIELD]: [
    { title: 'Intoxication and withdrawal from psychostimulants', hours: 1.5 },
    { title: 'Panel discussion', hours: 1.5, topics: ['Controlled Substances'] },
  ] } });
  assert.deepEqual(sessionTopicHours(c, ['Controlled Substances', 'Substance Use Disorders']), { hours: 2, sessions: 2 });
  assert.equal(ky([c]).earned, 2);
});

test('Low: Undo removes exactly the topic it added and keeps later edits', () => {
  const before = { id: 'a', topics: ['Ethics'] };
  const added = withTopicAdded(before, 'Pain Management');
  const laterEdit = { ...added, topics: [...added.topics, 'Risk Management'], notes: 'edited' };
  assert.deepEqual(withTopicRemoved(laterEdit, 'Pain Management'), { id: 'a', topics: ['Ethics', 'Risk Management'], notes: 'edited' });
  const untouched = { id: 'b', topics: ['Ethics'] };
  assert.equal(withTopicRemoved(untouched, 'Pain Management'), untouched);
});

const lowCme = [{ id: 'c', category: 'AMA PRA Category 1', hours: '2', date: '2026-01-10' }];
const chosen = (state, deg = 'MD') => boardExemptionFields({}, state, '2026-11-18', EXP, '2026-11-18', deg);

test('M2: the exemption applies only for the renewal it was chosen for', () => {
  const answers = chosen('ND');
  assert.equal(answers[BOARD_EXEMPTION_RENEWAL_FIELD], EXP);
  assert.equal(answers[BOARD_EXEMPTION_CONDITION_FIELD], undefined, 'ND has no narrower condition');
  assert.equal(computeCompliance(lowCme, 'ND', 'MD', { licenseExpiration: EXP, topicApplicability: answers }).totalMet, true);
  const renewed = computeCompliance(lowCme, 'ND', 'MD', { licenseExpiration: '2029-03-31', topicApplicability: answers });
  assert.equal(renewed.totalMet, false);
  assert.equal(renewed.boardExemption, undefined);
  // A choice stored without its renewal lapses.
  assert.equal(boardExemptionOn('ND', { [BOARD_EXEMPTION_FIELD]: '2026-11-18' }, EXP), null);
  // Undo clears every key.
  assert.deepEqual(boardExemptionFields(answers, 'ND', null, EXP), {});
});

test('M2: LA, TX, KY, NH, ME (MD) and WA need their condition confirmed', () => {
  for (const [st, deg] of [['LA', 'MD'], ['TX', 'MD'], ['KY', 'DO'], ['NH', 'MD'], ['ME', 'MD'], ['WA', 'MD'], ['WA', 'DO']]) {
    assert.ok(boardExemptionCondition(st, deg), `${st} ${deg}`);
    const unconfirmed = { [BOARD_EXEMPTION_FIELD]: '2026-11-18', [BOARD_EXEMPTION_RENEWAL_FIELD]: EXP };
    assert.equal(boardExemptionOn(st, unconfirmed, EXP, deg), null, `${st} ${deg} unconfirmed`);
    assert.equal(boardExemptionOn(st, chosen(st, deg), EXP, deg), '2026-11-18', `${st} ${deg} confirmed`);
  }
  const tx = computeCompliance(lowCme, 'TX', 'MD', { licenseExpiration: EXP, topicApplicability: chosen('TX') });
  assert.equal(tx.totalMet, true);
  assert.ok(tx.topicResults.some(t => !t.met), 'Texas topics still owed');
});

test('M2: each condition restates its state rule text and invents nothing', () => {
  const words = { LA: ['within the past year', 'ABMS member board', 'AOA-recognized'], TX: ['36 months', 'one renewal', 'ABMS MOC', 'AOA OCC'],
    KY: ['passing an ABMS or AOA board certification or recertification exam'], NH: ['ABMS board exam'], ME: ['ABMS certification with MOC', 'lifetime certs excluded'],
    WA: ['ABMS cert in last 4 yrs', 'ABMS MOC participation'] };
  for (const [st, list] of Object.entries(words)) {
    const moc = getStateEntry(st, 'MD').moc;
    for (const w of list) assert.ok(moc.includes(w), `${st} rule text still says "${w}"`);
  }
  for (const w of ['ABOMS or ABMS cert/recert within last 6 yrs', 'ABOMS or ABMS MOC participation']) {
    assert.ok(getStateEntry('WA', 'DO').moc.includes(w), `WA DO rule text still says "${w}"`);
  }
});

test('M2: offered and applied only with a current board certification on file', () => {
  const today = '2026-11-18';
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (ABMS)', name: 'ABNS', expirationDate: '2026-01-01' }], today), false);
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (ABMS)', name: 'ABNS', expirationDate: '2030-01-01', lifecycleStatus: 'superseded' }], today), false);
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (ABMS)', name: 'ABNS', expirationDate: '2030-01-01' }], today), true);
  assert.equal(currentBoardCertificationOnFile([{ type: 'Board Certification (ABMS)', name: 'ABNS' }], today), true);
  assert.equal(currentBoardCertificationOnFile([], today), false);

  const lic = { id: 'nd', type: 'Medical License', state: 'ND', expirationDate: EXP, customFields: chosen('ND') };
  const data = (certExp) => ({ settings: { degreeType: 'MD', specialties: [] }, cme: lowCme,
    licenses: [lic, { id: 'bc', type: 'Board Certification (ABMS)', name: 'ABNS Neurological Surgery', expirationDate: certExp }] });
  assert.equal(complianceFor(data('2099-12-31'), 'ND').totalMet, true);
  const lapsed = complianceFor(data('2020-12-31'), 'ND');
  assert.equal(lapsed.totalMet, false);
  assert.equal(lapsed.boardExemption, undefined);
});
