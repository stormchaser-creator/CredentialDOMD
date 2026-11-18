// Review fixes for the all-boards release (2026-11-18): no day-one alert wave
// for steps the app has just started tracking, windows across the new year,
// no never-resetting marks, ABS/ABEM fees undated, and the AOA new-issue
// start delay. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TASKS } from '../../src/constants/boardRequirements.js';
import { boardComplianceFor } from '../../src/utils/boardCompliance.js';
import { boardTasksFor, taskPeriod, openBoardTasks, upcomingBoardSteps, datedBoardSteps } from '../../src/utils/boardTasks.js';
import { reminderBoardItems } from '../../supabase/functions/_shared/reminderBoardSteps.mjs';

const at = (iso) => new Date(`${iso}T12:00:00`);
const abms = (code, lic = {}) => ({ settings: { degreeType: 'MD', specialties: [`ABMS:${code}`] }, licenses: [{ id: 'r', type: 'Board Certification (ABMS)', name: `${code} synthetic`, ...lic }], cme: [] });
const aoa = (code, lic = {}) => ({ settings: { degreeType: 'DO', specialties: [`AOA:${code}`] }, licenses: [{ id: 'r', type: 'Board Certification (AOA)', name: `${code} synthetic`, ...lic }], cme: [] });
const card = (data, id) => boardComplianceFor(data).find(b => b.id === id);
const byId = (t) => Object.fromEntries(t.tasks.map(x => [x.id, x]));
const alerted = (data, now, lead = 90) => openBoardTasks(data, boardComplianceFor(data), lead, at(now)).flatMap(o => o.tasks.map(x => `${o.board.id}|${x.id}`));

test('ABS fee has no Dec 31 due date: the board assesses it on entry to the assessment', () => {
  const fee = BOARD_TASKS['ABMS:ABS'].tasks.find(x => x.id === 'fee');
  assert.equal(fee.due, undefined);
  assert.match(fee.dueRule, /enter the assessment process/);
  const data = abms('ABS');
  assert.equal(byId(boardTasksFor(data, card(data, 'ABMS:ABS'), at('2026-11-18'))).fee.due, null);
  assert.deepEqual(alerted(data, '2026-11-18'), []);
});

test('ABEM fee has no due date (the current ABEM fee page gives none)', () => {
  const fee = BOARD_TASKS['ABMS:ABEM'].tasks.find(x => x.id === 'fee');
  assert.equal(fee.due, undefined);
  assert.ok(fee.dueRule);
});

test('no day-one alert wave: unmarked steps of newly tracked boards are asked, listed, never alerted in their first period', () => {
  for (const [data, id, task] of [[abms('ABAI'), 'ABMS:ABAI', 'fee'], [abms('ABAI'), 'ABMS:ABAI', 'cme'], [aoa('AOBA'), 'AOA:AOBA', 'la'], [aoa('AOBFP'), 'AOA:AOBFP', 'la']]) {
    const t = byId(boardTasksFor(data, card(data, id), at('2026-11-18')))[task];
    assert.equal(t.status, 'due', `${id} ${task}`);
    assert.equal(t.askFirst, true, `${id} ${task}`);
    assert.ok(!alerted(data, '2026-11-18').includes(`${id}|${task}`), `${id} ${task} not alerted`);
    assert.ok(upcomingBoardSteps(data, boardComplianceFor(data), 90, at('2026-11-18')).some(s => s.taskId === task), `${id} ${task} still listed`);
  }
  // The reminder email runs the same code: nothing on day one.
  const profile = { specialties: ['ABMS:ABAI', 'AOA:AOBA'], degree_type: 'DO' };
  const rows = [{ id: 'r1', type: 'Board Certification (ABMS)', name: 'ABAI synthetic' }, { id: 'r2', type: 'Board Certification (AOA)', name: 'AOBA synthetic' }];
  assert.deepEqual(reminderBoardItems(profile, rows, { lead: 90, now: at('2026-11-18') }), []);
  assert.ok(reminderBoardItems(profile, rows, { lead: 90, now: at('2027-11-18') }).length > 0);
  // Next year the same steps alert as usual.
  assert.ok(alerted(abms('ABAI'), '2027-11-18').includes('ABMS:ABAI|fee'));
  assert.ok(alerted(aoa('AOBA'), '2027-11-18').includes('AOA:AOBA|la'));
});

test('steps tracked before this release (ABNS, AOBS) keep alerting as before', () => {
  assert.ok(alerted(abms('ABNS'), '2027-09-01', 60).includes('ABMS:ABNS|alt'));
  assert.ok(alerted(abms('ABNS'), '2026-09-01', 60).includes('ABMS:ABNS|alt'));
  assert.ok(!alerted(abms('ABNS'), '2026-09-01', 60).includes('ABMS:ABNS|dues'), 'the newly added ABNS dues step asks in 2026');
});

test('a window across the new year is dated to the year it closes', () => {
  const reg = BOARD_TASKS['AOA:AOBOS'].tasks.find(x => x.id === 'laReg');
  const p = taskPeriod(reg, at('2026-11-18'));
  assert.deepEqual(p, { label: '2027', start: '2026-10-01', end: '2027-01-05', due: '2027-01-05', opens: '2026-10-01' });
  assert.equal(taskPeriod(reg, at('2027-01-03')).due, '2027-01-05');
  assert.equal(taskPeriod(reg, at('2027-03-01')).due, '2028-01-05');
  const data = aoa('AOBOS');
  const t = byId(boardTasksFor(data, card(data, 'AOA:AOBOS'), at('2026-11-18'))).laReg;
  assert.equal(t.status, 'due');
  assert.equal(t.daysLeft, 48);
  assert.ok(datedBoardSteps(data, boardComplianceFor(data), 90, at('2026-11-18')).some(s => s.taskId === 'laReg' && s.due === '2027-01-05'));
  const between = byId(boardTasksFor(data, card(data, 'AOA:AOBOS'), at('2027-03-01'))).laReg;
  assert.equal(between.status, 'upcoming');
  assert.equal(between.opens, '2027-10-01');

  const cap2 = BOARD_TASKS['ABMS:ABAI'].tasks.find(x => x.id === 'cap2');
  assert.equal(taskPeriod(cap2, at('2026-11-18')).due, '2027-01-15');
  assert.equal(taskPeriod(cap2, at('2026-11-18')).opens, '2026-08-15');
  const a = abms('ABAI');
  const c = byId(boardTasksFor(a, card(a, 'ABMS:ABAI'), at('2026-11-18'))).cap2;
  assert.equal(c.status, 'due');
  assert.equal(c.period, '2027');
  // A mark made in the open window still matches after New Year.
  const marked = abms('ABAI', { customFields: { [c.field]: '2026-12-01' } });
  assert.equal(byId(boardTasksFor(marked, card(marked, 'ABMS:ABAI'), at('2027-01-10'))).cap2.status, 'done');
});

test('a step with no period the app can place offers no mark', () => {
  const data = abms('ABPN');
  const t = byId(boardTasksFor(data, card(data, 'ABMS:ABPN'), at('2026-11-18')));
  assert.equal(t.block.markable, false);
  assert.equal(t.fee.markable, true);
  const blank = abms('ABEM');
  assert.equal(byId(boardTasksFor(blank, card(blank, 'ABMS:ABEM'), at('2026-11-18'))).myemcert.markable, false);
  const dated = abms('ABEM', { expirationDate: '2029-12-31' });
  assert.equal(byId(boardTasksFor(dated, card(dated, 'ABMS:ABEM'), at('2026-11-18'))).myemcert.markable, true);
});

test('AOA new issue: the assessment starts two years after the issue year where the board says so', () => {
  const data = aoa('AOBA', { issuedDate: '2026-06-01', expirationDate: '2027-12-31' });
  const la = byId(boardTasksFor(data, card(data, 'AOA:AOBA'), at('2026-11-18'))).la;
  assert.equal(la.status, 'not-yet');
  assert.equal(la.startsYear, 2028);
  assert.equal(la.startsWhy, 'newIssue');
  assert.ok(!alerted(data, '2026-11-18').includes('AOA:AOBA|la'));
  assert.equal(byId(boardTasksFor(data, card(data, 'AOA:AOBA'), at('2028-11-18'))).la.status, 'due');
  // Old track still starts in the expiration year.
  const old = aoa('AOBA', { issuedDate: '2015-06-01', expirationDate: '2029-12-31' });
  const o = byId(boardTasksFor(old, card(old, 'AOA:AOBA'), at('2026-11-18'))).la;
  assert.equal(o.startsWhy, 'expiration');
  assert.equal(o.startsYear, 2029);
  // A board whose page was not read for the rule gets no delay.
  assert.equal(BOARD_TASKS['AOA:AOBS'].newIssueStartsAfterYears, undefined);
});
