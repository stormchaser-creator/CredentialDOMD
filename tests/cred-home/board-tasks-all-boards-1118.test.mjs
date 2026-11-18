// Board steps for every verified ABMS and AOA board (checked 2026-11): the
// new cadence shapes (a cycle ending on the certificate's expiration date,
// an AOA-cycle step with its own day, an opening day, an undated rule),
// discipline cards, and the upcoming list. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TASKS } from '../../src/constants/boardRequirements.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardTasksFor, taskPeriod, boardTaskSet, openBoardTasks, upcomingBoardSteps } from '../../src/utils/boardTasks.js';

const at = (iso) => new Date(`${iso}T12:00:00`);
const abms = (code, lic = {}) => ({ settings: { degreeType: 'MD', specialties: [`ABMS:${code}`] }, licenses: [{ id: 'r', type: 'Board Certification (ABMS)', name: `${code} synthetic`, ...lic }], cme: [] });
const aoa = (code, lic = {}, specialties = [`AOA:${code}`]) => ({ settings: { degreeType: 'DO', specialties }, licenses: [{ id: 'r', type: 'Board Certification (AOA)', name: `${code} synthetic`, ...lic }], cme: [] });
const card = (data, id) => boardComplianceFor(data).find(b => b.id === id);
const byId = (t) => Object.fromEntries(t.tasks.map(x => [x.id, x]));

test('a step tied to the certificate is due on its expiration date; with no date it says so and is never alerted', () => {
  const dated = abms('ABEM', { expirationDate: '2029-12-31' });
  const t = byId(boardTasksFor(dated, card(dated, 'ABMS:ABEM'), at('2026-11-18')));
  assert.equal(t.myemcert.due, '2029-12-31');
  assert.equal(t.myemcert.period, 'cycle ending 2029-12-31');
  assert.equal(t.myemcert.status, 'due');
  const blank = abms('ABEM');
  const u = byId(boardTasksFor(blank, card(blank, 'ABMS:ABEM'), at('2026-11-18')));
  assert.equal(u.myemcert.due, null);
  assert.match(u.myemcert.dueRule, /expiration date/);
  assert.ok(!openBoardTasks(blank, boardComplianceFor(blank), 365, at('2026-11-18'))[0]?.tasks.some(x => x.id === 'myemcert'));
});

test('ABOS: the Professional Standing Update is due Dec 1 of year 9, the year before the expiration year', () => {
  const data = abms('ABOS', { expirationDate: '2027-12-31' });
  const t = byId(boardTasksFor(data, card(data, 'ABMS:ABOS'), at('2026-03-01')));
  assert.equal(t.psu.due, '2026-12-01');
  assert.equal(t.cme.due, '2027-12-31');
  assert.equal(t.wla.due, '2026-05-22');
  assert.equal(t.wla.opens, '2026-04-03');
});

test('AOA cycle steps: QI by Dec 31 of the last cycle year, AOBOG by Sept 15 of it', () => {
  const ana = aoa('AOBA');
  assert.equal(byId(boardTasksFor(ana, card(ana, 'AOA:AOBA'), at('2026-11-18'))).qi.due, '2027-12-31');
  const og = aoa('AOBOG');
  const q = byId(boardTasksFor(og, card(og, 'AOA:AOBOG'), at('2026-11-18'))).qi;
  assert.equal(q.period, '2025-2027');
  assert.equal(q.due, '2027-09-15');
  assert.deepEqual(taskPeriod({ every: { years: 3, anchor: 'aoaCycle' }, due: '09-15' }, at('2028-02-01')).due, '2030-09-15');
});

test('an annual step with a stated opening day is upcoming before it', () => {
  const data = aoa('AOBP');
  const la = byId(boardTasksFor(data, card(data, 'AOA:AOBP'), at('2026-01-10'))).la;
  assert.equal(la.status, 'upcoming');
  assert.equal(la.opens, '2026-01-30');
  assert.equal(la.due, '2026-09-30');
});

test('a cycle the app cannot place has no date, shows the board rule and never appears in alerts or the upcoming list', () => {
  const data = abms('ABPN');
  const t = byId(boardTasksFor(data, card(data, 'ABMS:ABPN'), at('2026-11-18')));
  assert.equal(t.block.due, null);
  assert.match(t.block.dueRule, /Dec 31 of the last year of your 3-year block/);
  const steps = upcomingBoardSteps(data, boardComplianceFor(data), 30, at('2026-11-18'));
  assert.ok(!steps.some(s => s.taskId === 'block'));
  assert.ok(openBoardTasks(data, boardComplianceFor(data), 60, at('2026-11-18'))[0].tasks.some(x => x.id === 'fee'), 'the Dec 31 fee is inside a 60-day window');
});

test('an old-track AOA certificate starts the assessment in its expiration year', () => {
  const data = aoa('AOBNP', { issuedDate: '2018-06-01', expirationDate: '2028-12-31' });
  const la = byId(boardTasksFor(data, card(data, 'AOA:AOBNP'), at('2026-05-01'))).la;
  assert.equal(la.status, 'not-yet');
  assert.equal(la.startsYear, 2028);
});

test('only AOBS discipline cards share the parent steps; an AOBIM subspecialty card gets none and the parent keeps its own', () => {
  assert.ok(boardTaskSet('AOA-SUB:AOBS:Neurological Surgery'));
  assert.equal(boardTaskSet('AOA-SUB:AOBIM:Cardiology'), null);
  const data = aoa('AOBIM', {}, ['AOA:AOBIM', 'AOA-SUB:AOBIM:Cardiology']);
  assert.ok(boardTasksFor(data, card(data, 'AOA:AOBIM'), at('2026-05-01')));
});

test('far-off dated steps from the new boards are listed as upcoming and not alerted', () => {
  const data = abms('ABA', { expirationDate: '2030-12-31' });
  const steps = upcomingBoardSteps(data, boardComplianceFor(data), 30, at('2026-11-18'));
  assert.ok(steps.some(s => s.taskId === 'qi' && s.due === '2030-12-31'));
  assert.ok(steps.every(s => !s.alerted));
});

test('ABIM and AOBPr are not encoded (no official page read)', () => {
  assert.equal(BOARD_TASKS['ABMS:ABIM'], undefined);
  assert.equal(BOARD_TASKS['AOA:AOBPr'], undefined);
});
