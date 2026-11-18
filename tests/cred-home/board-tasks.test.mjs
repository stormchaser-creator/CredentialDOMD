// Board certification as its own item: dated tasks per board (AOBS, the
// Neurological Surgery discipline, ABNS), Done marks with Undo, first-cycle
// proration, no-expiration AOA certificates, alerts, no AOA "national" card
// for a DO with no board, and the state exemption as the physician's choice.
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOARD_TASKS } from '../../src/constants/boardRequirements.js';
import { boardComplianceFor, boardRecordFor, FIRST_CYCLE_FIELD } from '../../src/utils/boardCompliance.js';
import { boardTasksFor, boardTaskField, applyBoardTaskMark, boardTaskAlerts, taskPeriod, boardTaskKey } from '../../src/utils/boardTasks.js';
import { computeCompliance } from '../../src/utils/compliance.js';
import { BOARD_EXEMPTION_FIELD, BOARD_EXEMPTION_STATES } from '../../src/utils/conditionalCme.js';
import { getStateEntry } from '../../src/constants/stateRequirements.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const at = (iso) => new Date(`${iso}T12:00:00`);
const doData = (lic = {}, extra = {}) => ({
  settings: { degreeType: 'DO', specialties: [], ...extra },
  licenses: [{ id: 'bc', type: 'Board Certification (AOA)', name: 'AOBS Surgery', ...lic }],
  cme: [],
});
const aobs = (data) => boardComplianceFor(data).find(b => b.id === 'AOA:AOBS');

test('every task has an id, a label, a cadence and an official source URL', () => {
  for (const [key, set] of Object.entries(BOARD_TASKS)) {
    assert.match(key, /^(AOA|ABMS):[A-Za-z_]+$/);
    assert.match(set.sourceUrl, /^https:\/\/(certification\.osteopathic\.org|www\.abns\.org)\//);
    for (const t of set.tasks) {
      assert.ok(t.id && t.label, `${key} task`);
      assert.ok(t.every === 'year' || (t.every.years > 0), `${key} ${t.id} cadence`);
      assert.match(t.source, /^https:\/\//, `${key} ${t.id} source`);
    }
  }
});

test('AOBS: Longitudinal Assessment due Nov 15 2026, $225; license yearly; QI by the end of the 2025-2027 cycle', () => {
  const t = boardTasksFor(doData(), aobs(doData()), at('2026-03-01'));
  const by = Object.fromEntries(t.tasks.map(x => [x.id, x]));
  assert.equal(by.la.due, '2026-11-15');
  assert.equal(by.la.opens, '2026-01-26');
  assert.equal(by.la.cost, 225);
  assert.equal(by.la.status, 'due');
  assert.equal(by.license.due, null, 'no published date: text only');
  assert.equal(by.qi.period, '2025-2027');
  assert.equal(by.qi.due, '2027-12-31');
});

test('before the window opens the assessment is upcoming; after Nov 15 unmarked it is overdue', () => {
  assert.equal(boardTasksFor(doData(), aobs(doData()), at('2026-01-10')).tasks[0].status, 'upcoming');
  assert.equal(boardTasksFor(doData(), aobs(doData()), at('2026-11-18')).tasks[0].status, 'overdue');
});

test('a year with no published window has no dated deadline', () => {
  const t = boardTasksFor(doData(), aobs(doData()), at('2027-03-01'));
  assert.equal(t.tasks[0].due, null);
  assert.equal(t.tasks[0].daysLeft, null);
  assert.equal(t.tasks[0].status, 'due');
});

test('Mark done stores a dated mark per period on the board record; Undo removes it', () => {
  const data = doData();
  const b = aobs(data);
  const field = boardTaskField(b.id, BOARD_TASKS['AOA:AOBS'].tasks[0], '2026');
  assert.equal(field, 'AOBS Longitudinal Assessment done for 2026');
  const { record } = applyBoardTaskMark(data, b.id, field, '2026-04-02');
  assert.equal(record.id, 'bc');
  assert.equal(record.customFields[field], '2026-04-02');
  const marked = { ...data, licenses: [record] };
  const la = boardTasksFor(marked, b, at('2026-11-18')).tasks[0];
  assert.equal(la.status, 'done');
  assert.equal(la.doneOn, '2026-04-02');
  // The next year is a new period: owed again.
  assert.equal(boardTasksFor(marked, b, at('2027-02-01')).tasks[0].status, 'due');
  const undone = applyBoardTaskMark(marked, b.id, field, null).record;
  assert.equal(field in undone.customFields, false);
});

test('with no Board Certification record the mark goes to settings', () => {
  const data = { settings: { degreeType: 'MD', specialties: ['ABMS:ABNS'] }, licenses: [], cme: [] };
  const b = boardComplianceFor(data)[0];
  const t = boardTasksFor(data, b, at('2026-05-01'));
  const out = applyBoardTaskMark(data, b.id, t.tasks[0].field, '2026-05-01');
  assert.equal(out.record, undefined);
  assert.deepEqual(out.settings, { boardTaskMarks: { 'ABNS Adaptive Learning Tool done for 2026': '2026-05-01' } });
  const after = boardTasksFor({ ...data, settings: { ...data.settings, ...out.settings } }, b, at('2026-05-02'));
  assert.equal(after.tasks[0].status, 'done');
});

test('ABNS: four annual tasks due Sept 30', () => {
  const data = { settings: { degreeType: 'MD', specialties: [] }, licenses: [{ id: 'n', type: 'Board Certification (ABMS)', name: 'ABNS Neurological Surgery' }], cme: [] };
  const t = boardTasksFor(data, boardComplianceFor(data)[0], at('2026-06-01'));
  assert.deepEqual(t.tasks.map(x => x.label), ['Adaptive Learning Tool', 'CC Pledge and standing questionnaire', 'Privileges attestation', 'IHHC quality improvement attestation']);
  assert.ok(t.tasks.every(x => x.due === '2026-09-30'));
});

test('the Neurological Surgery discipline card uses the AOBS tasks with its own marks', () => {
  const data = doData({ name: 'AOBS Neurological Surgery' }, { specialties: ['AOA-SUB:AOBS:Neurological Surgery'] });
  const card = boardComplianceFor(data).find(b => b.id.startsWith('AOA-SUB'));
  assert.equal(boardTaskKey(card.id), 'AOA:AOBS');
  const t = boardTasksFor(data, card, at('2026-03-01'));
  assert.equal(t.tasks[0].field, 'AOBS Neurological Surgery Longitudinal Assessment done for 2026');
  assert.equal(boardRecordFor(data.licenses, card.id).id, 'bc');
});

test('a board with no task data keeps its sentence and gets no tasks', () => {
  const data = { settings: { degreeType: 'MD', specialties: ['ABMS:ABA'] }, licenses: [], cme: [] };
  assert.equal(boardTasksFor(data, boardComplianceFor(data)[0]), null);
  assert.ok(boardComplianceFor(data)[0].assessment);
});

test('AOA certificate issued after 2018: no expiration date, a typed date is not its end and is left as typed', () => {
  const data = doData({ issuedDate: '2020-06-01', expirationDate: '2030-12-31' });
  const t = boardTasksFor(data, aobs(data), at('2026-03-01'));
  assert.deepEqual(t.noExpiration?.typedExpiration, '2030-12-31');
  assert.equal(data.licenses[0].expirationDate, '2030-12-31');
  assert.equal(t.tasks[0].status, 'due', 'a typed date never delays the assessment');
  assert.equal(boardTasksFor(doData({ issuedDate: '2015-06-01' }), aobs(doData()), at('2026-03-01')).noExpiration, null);
});

test('a time-limited certificate (issued 2018 or before) starts the assessment the year it expires', () => {
  const data = doData({ issuedDate: '2016-05-01', expirationDate: '2028-12-31' });
  const la = boardTasksFor(data, aobs(data), at('2026-03-01')).tasks[0];
  assert.equal(la.status, 'not-yet');
  assert.equal(la.startsYear, 2028);
});

test('first-cycle proration from the issued date: Jul-Dec of cycle year 1 owes 67% of 60 = 40', () => {
  const data = doData({ issuedDate: '2025-08-15' });
  const b = aobs(data);
  assert.equal(b.required, 40);
  assert.deepEqual({ ...b.firstCycle, url: undefined }, { issued: '2025-08-15', share: 0.67, hours: 40, fullHours: 60, url: undefined, recordId: 'bc', off: false });
  assert.equal(aobs(doData({ issuedDate: '2025-02-01' })).required, 49.5, '83% of 60 rounded down to the half');
  assert.equal(aobs(doData({ issuedDate: '2027-09-01' })).required, 0, 'last half year: none until next cycle');
  assert.equal(aobs(doData({ issuedDate: '2020-01-01' })).required, 60, 'issued before the cycle: full hours');
  assert.equal(aobs(doData()).firstCycle, undefined, 'no issued date: nothing added');
});

test('the physician can turn proration off on the record (a recertification date)', () => {
  const b = aobs(doData({ issuedDate: '2025-08-15', customFields: { [FIRST_CYCLE_FIELD]: 'No' } }));
  assert.equal(b.required, 60);
  assert.equal(b.firstCycle.off, true);
});

test('alerts: an overdue or soon-due task is listed until marked done', () => {
  const data = doData();
  const boards = boardComplianceFor(data);
  const soon = boardTaskAlerts(data, boards, 90, at('2026-10-01'));
  assert.equal(soon.length, 1);
  assert.deepEqual(soon[0].issues, ['Longitudinal Assessment: due 2026-11-15']);
  assert.equal(soon[0].key, 'board:AOA:AOBS');
  assert.equal(boardTaskAlerts(data, boards, 30, at('2026-10-01')).length, 0, 'outside the lead window');
  const field = 'AOBS Longitudinal Assessment done for 2026';
  const done = { ...data, licenses: [{ ...data.licenses[0], customFields: { [field]: '2026-09-01' } }] };
  assert.equal(boardTaskAlerts(done, boardComplianceFor(done), 90, at('2026-10-01')).length, 0);
});

test('no AOA "national 120" entry for a DO with no board anywhere', () => {
  const src = ['src/App.jsx', 'src/components/features/CMESection.jsx', 'src/utils/cmeTranscriptPdf.js', 'src/utils/boardCompliance.js'].map(read).join('\n');
  assert.doesNotMatch(src, /aoaNationalEntry/);
  assert.match(read('src/utils/cmeTranscriptPdf.js'), /osteopathic\.org\/cme\/cme-faqs/);
});

test('periods: a yearly task runs Jan 1 to Dec 31; the QI task runs on the AOA cycle', () => {
  assert.deepEqual(taskPeriod({ every: 'year', due: '09-30' }, at('2026-02-01')), { label: '2026', start: '2026-01-01', end: '2026-12-31', due: '2026-09-30', opens: null });
  assert.equal(taskPeriod({ every: { years: 3, anchor: 'aoaCycle' } }, at('2028-02-01')).label, '2028-2030');
});

test('state exemption: offered only where the rule data names one, applied only when chosen', () => {
  for (const st of BOARD_EXEMPTION_STATES) {
    const moc = String(getStateEntry(st, 'MD')?.moc || '').trim();
    assert.ok(moc && !/^no$/i.test(moc), `${st} names an exemption`);
  }
  const cme = [{ id: 'c', category: 'AMA PRA Category 1', hours: '2', date: '2026-01-10' }];
  const opts = { licenseExpiration: '2027-03-31' };
  const plain = computeCompliance(cme, 'ND', 'MD', { ...opts, topicApplicability: {} });
  assert.equal(plain.totalMet, false);
  assert.equal(plain.boardExemption, undefined);
  const chosen = computeCompliance(cme, 'ND', 'MD', { ...opts, topicApplicability: { [BOARD_EXEMPTION_FIELD]: '2026-11-18' } });
  assert.equal(chosen.totalMet, true);
  assert.equal(chosen.cat1Met, true);
  assert.equal(chosen.hoursRemaining, 0);
  assert.equal(chosen.boardExemption.usedOn, '2026-11-18');
  assert.match(chosen.boardExemption.rule, /exempt/);
  // A state whose data names no exemption ignores the field.
  const ga = computeCompliance(cme, 'GA', 'MD', { ...opts, topicApplicability: { [BOARD_EXEMPTION_FIELD]: '2026-11-18' } });
  assert.equal(ga.boardExemption, undefined);
  assert.equal(ga.totalMet, false);
});

test('the exemption keeps topic courses on the card', () => {
  const chosen = computeCompliance([], 'TX', 'MD', { licenseExpiration: '2027-03-31', topicApplicability: { [BOARD_EXEMPTION_FIELD]: '2026-11-18' } });
  assert.equal(chosen.totalMet, true);
  assert.ok(chosen.topicResults.some(t => !t.met), 'Texas topics still owed');
});
