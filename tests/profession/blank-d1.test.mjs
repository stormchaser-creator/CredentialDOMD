// Owner decision D-1 (DESIGN 1.3, 7.2): a blank or unrecognised profession is
// unknown in every state. The only differences from the MD result are
// degreeUnknown, assessmentStatus "needs-confirmation" and fullyCompliant
// false; hours, rules and windows are the MD stand-in's, unchanged. Alerts
// still list hour shortfalls only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, standingScore } from '../../src/utils/compliance.js';
import { STATE_REQS, hasSeparateBoards } from '../../src/constants/stateRequirements.js';
import { cmeReviewSummary, cmeAssessmentLabel } from '../../src/utils/cmePresentation.js';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });
const notifications = await bundle('src/utils/notifications.js');

const entries = [
  { category: 'AMA PRA Category 1', hours: '120', date: '2026-01-10', topics: [] },
  { category: 'AMA PRA Category 1', hours: '30', date: '2025-11-10', topics: ['Opioid Prescribing', 'Ethics', 'Pain Management', 'Implicit Bias', 'Human Trafficking'] },
];
const opts = { licenseExpiration: '2026-12-15' };
const ONLY = new Set(['degreeUnknown', 'assessmentStatus', 'fullyCompliant']);

test('blank, null, MBBS and lowercase: identical to MD except the three fields, in every state', () => {
  for (const st of Object.keys(STATE_REQS)) {
    const md = computeCompliance(entries, st, 'MD', opts);
    for (const deg of ['', null, undefined, 'MBBS', 'md']) {
      const blank = computeCompliance(entries, st, deg, opts);
      for (const k of Object.keys(md)) {
        if (ONLY.has(k)) continue;
        assert.deepEqual(blank[k], md[k], `${st} ${deg} ${k}`);
      }
      assert.equal(blank.degreeUnknown, true);
      // D-1 never hides a recorded shortfall: in a combined-board state a
      // blank member who is short keeps "needs-hours" (DESIGN 7.2).
      const expected = md.assessmentStatus === 'needs-hours' && !hasSeparateBoards(st) ? 'needs-hours' : 'needs-confirmation';
      assert.equal(blank.assessmentStatus, expected, `${st} ${deg}`);
      assert.equal(blank.fullyCompliant, false);
    }
  }
});

test('combined-board state: a blank member who met the MD numbers reads provisional, and the ring counts it', () => {
  assert.ok(!STATE_REQS.MN.md, 'MN is a combined board');
  const md = computeCompliance(entries, 'MN', 'MD', opts);
  const blank = computeCompliance(entries, 'MN', '', opts);
  assert.equal(md.fullyCompliant, true, 'the MD fixture is met');
  assert.equal(blank.fullyCompliant, false);
  const ring = (comp) => standingScore({ stateComps: [{ st: 'MN', comp }], leadDays: 90 });
  assert.equal(ring(md).percent, 100);
  assert.equal(ring(blank).percent, 0);
  assert.equal(ring(blank).needsAction[0].item.needsConfirmation, true);
});

test('alerts never start listing a blank member who has the hours', () => {
  const data = (deg) => ({ settings: { name: 'Alex Example', degreeType: deg, primaryState: 'MN', additionalStates: [], reminderLeadDays: 90 },
    licenses: [{ id: 'l', type: 'State Medical License', state: 'MN', expirationDate: '2026-12-15' }], cme: entries,
    privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [] });
  assert.deepEqual(notifications.generateAlerts(data('MD')).cmeIssues, [], 'the MD member has no CME gap');
  assert.deepEqual(notifications.generateAlerts(data('')).cmeIssues, [], 'nor does the blank member: needs-confirmation is not a shortfall');
});

test('combined-board state: a blank member who is short keeps the gap on the card, the review list and the alert (review finding 1)', () => {
  // Synthetic: MN medical license expiring 2026-11-30, 20 h Cat 1 and 40 h Cat 2.
  const short = [
    { category: 'AMA PRA Category 1', hours: '20', date: '2026-03-01', topics: [] },
    { category: 'AMA PRA Category 2', hours: '40', date: '2026-04-01', topics: [] },
  ];
  const o = { licenseExpiration: '2026-11-30' };
  const md = computeCompliance(short, 'MN', 'MD', o);
  const blank = computeCompliance(short, 'MN', '', o);
  assert.equal(md.assessmentStatus, 'needs-hours');
  assert.equal(blank.assessmentStatus, 'needs-hours', 'the gap is not hidden behind the profession prompt');
  assert.equal(blank.degreeUnknown, true, 'the profession is still unknown');
  assert.equal(cmeAssessmentLabel(blank), 'Recorded CME gaps: review hours and topics');
  const summary = cmeReviewSummary([{ st: 'MN', comp: blank }]);
  assert.deepEqual(summary.records, ['MN']);
  assert.ok(summary.confirmation.includes('MN'), 'the profession prompt stays');
  // A split-board state keeps the provisional stand-in (as before D-1).
  assert.ok(hasSeparateBoards('CA'));
  assert.equal(computeCompliance(short, 'CA', '', o).assessmentStatus, 'needs-confirmation');
});
