// The board certification exemption follows the physician's own board:
// Maine offers it to MDs (Board of Licensure in Medicine ch. 1 s. 11) and
// never to DOs (Board of Osteopathic Licensure, 100 hours, no substitute);
// Washington's MD and DO conditions differ (WAC 246-919-430, 246-853-080);
// Texas counts ethics as met under the exemption but never human
// trafficking (TMB CME hours chart). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance } from '../src/utils/compliance.js';
import {
  BOARD_EXEMPTION_FIELD, BOARD_EXEMPTION_RENEWAL_FIELD, BOARD_EXEMPTION_STATES,
  boardExemptionOffered, boardExemptionCondition, boardExemptionOn, boardExemptionFields,
} from '../src/utils/conditionalCme.js';
import { getStateEntry, hasSeparateBoards } from '../src/constants/stateRequirements.js';

const EXP = '2027-03-31';
const DAY = '2026-11-18';
const chosen = (st) => boardExemptionFields({}, st, DAY, EXP, DAY);
const lowCme = [{ id: 'c1', category: 'AMA PRA Category 1', hours: '2', date: '2026-01-10' }];

test('Maine DO: not offered, never applied, even with a stored choice and confirmed condition', () => {
  assert.equal(boardExemptionOffered('ME', 'DO'), false);
  assert.equal(boardExemptionCondition('ME', 'DO'), null);
  assert.equal(boardExemptionOn('ME', chosen('ME'), EXP, 'DO'), null);
  const comp = computeCompliance(lowCme, 'ME', 'DO', { licenseExpiration: EXP, topicApplicability: chosen('ME') });
  assert.equal(comp.boardExemption, undefined);
  assert.equal(comp.totalMet, false);
  assert.equal(getStateEntry('ME', 'DO').moc, 'No');
});

test('Maine MD: offered with the ABMS-with-MOC condition and applied once confirmed', () => {
  assert.equal(boardExemptionOffered('ME', 'MD'), true);
  assert.match(boardExemptionCondition('ME', 'MD'), /ABMS certification is current with MOC/);
  assert.match(boardExemptionCondition('ME', 'MD'), /lifetime certificate does not qualify/i);
  const comp = computeCompliance(lowCme, 'ME', 'MD', { licenseExpiration: EXP, topicApplicability: chosen('ME') });
  assert.equal(comp.boardExemption.usedOn, DAY);
  assert.equal(comp.totalMet, true);
  // Opioid prescribing is still owed.
  assert.equal(comp.topicResults.find(t => t.topic === 'Opioid Prescribing').met, false);
  const unconfirmed = { [BOARD_EXEMPTION_FIELD]: DAY, [BOARD_EXEMPTION_RENEWAL_FIELD]: EXP };
  assert.equal(boardExemptionOn('ME', unconfirmed, EXP, 'MD'), null);
});

test('Split-board states: not offered before MD or DO is chosen, nor to a PA or NP', () => {
  for (const st of BOARD_EXEMPTION_STATES) {
    if (hasSeparateBoards(st)) {
      assert.equal(boardExemptionOffered(st, null), false, `${st} blank degree`);
      assert.equal(boardExemptionOffered(st, ''), false, `${st} empty degree`);
    }
    assert.equal(boardExemptionOffered(st, 'PA'), false, `${st} PA`);
    assert.equal(boardExemptionOffered(st, 'NP'), false, `${st} NP`);
  }
  const blank = computeCompliance(lowCme, 'ME', null, { licenseExpiration: EXP, topicApplicability: chosen('ME') });
  assert.equal(blank.boardExemption, undefined, 'MD stand-in numbers never apply the MD exemption to an unknown degree');
});

test('Combined-board states are offered to MDs and DOs alike', () => {
  for (const st of BOARD_EXEMPTION_STATES.filter(s => !hasSeparateBoards(s))) {
    assert.equal(boardExemptionOffered(st, 'MD'), true, `${st} MD`);
    assert.equal(boardExemptionOffered(st, 'DO'), true, `${st} DO`);
    assert.equal(boardExemptionCondition(st, 'MD'), boardExemptionCondition(st, 'DO'), `${st} one condition`);
  }
});

test('Washington: MD and DO each get their own board rule condition', () => {
  const md = boardExemptionCondition('WA', 'MD');
  const dO = boardExemptionCondition('WA', 'DO');
  assert.match(md, /ABMS member board in the four years/);
  assert.match(md, /ABMS board's MOC participation/);
  assert.doesNotMatch(md, /ABOMS/);
  assert.match(dO, /ABOMS or ABMS within the last six years/);
  assert.match(dO, /ABOMS or ABMS board's MOC participation/);
  for (const deg of ['MD', 'DO']) {
    assert.equal(boardExemptionOffered('WA', deg), true, deg);
    const unconfirmed = { [BOARD_EXEMPTION_FIELD]: DAY, [BOARD_EXEMPTION_RENEWAL_FIELD]: EXP };
    assert.equal(computeCompliance(lowCme, 'WA', deg, { licenseExpiration: EXP, topicApplicability: unconfirmed }).boardExemption, undefined, `${deg} unconfirmed`);
    const comp = computeCompliance(lowCme, 'WA', deg, { licenseExpiration: EXP, topicApplicability: chosen('WA') });
    assert.equal(comp.totalMet, true, deg);
    assert.equal(comp.topicResults.find(t => t.topic === 'Suicide Prevention').met, false, `${deg} state mandates still owed`);
  }
});

test('Texas: the exemption meets ethics with the rule named; human trafficking still shows', () => {
  const opts = { licenseExpiration: EXP, topicApplicability: chosen('TX') };
  const comp = computeCompliance(lowCme, 'TX', 'MD', opts);
  assert.equal(comp.totalMet, true);
  const ethics = comp.topicResults.find(t => t.topic === 'Ethics');
  assert.equal(ethics.met, true);
  assert.equal(ethics.metByBoardExemption, true);
  assert.match(ethics.note, /156\.052/);
  assert.match(ethics.note, /ethics/);
  const trafficking = comp.topicResults.find(t => t.topic === 'Human Trafficking');
  assert.equal(trafficking.met, false);
  assert.equal(trafficking.metByBoardExemption, undefined);
  const opioid = comp.topicResults.find(t => t.topic === 'Opioid Prescribing');
  if (opioid) assert.equal(opioid.met, false, 'opioid depends on the specialty board, so it is not assumed');
  assert.equal(comp.allTopicsMet, false);
  // Without the exemption ethics is counted from logged hours as before.
  const plain = computeCompliance(lowCme, 'TX', 'MD', { licenseExpiration: EXP });
  const plainEthics = plain.topicResults.find(t => t.topic === 'Ethics');
  assert.equal(plainEthics.met, false);
  assert.equal(plainEthics.metByBoardExemption, undefined);
  // A DO under the same Texas board gets the same result.
  assert.equal(computeCompliance(lowCme, 'TX', 'DO', opts).topicResults.find(t => t.topic === 'Ethics').met, true);
});
