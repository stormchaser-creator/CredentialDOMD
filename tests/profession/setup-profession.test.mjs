// Setup for a PA and an NP (DESIGN 1.8, 4.1): About you accepts four
// professions, the board opens once one is chosen, and the licence,
// certification, education and life support rows ask for the profession's
// own records. MD and DO are pinned by tests/profession/md-do-golden.test.mjs
// and scripts/setup-tasks.test.mjs. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetup, datable, evidenceQueue } from '../../src/utils/setupTasks.js';

const NOW = new Date('2026-10-01T17:00:00Z');
const base = (degreeType, over = {}) => ({
  settings: { name: 'Pat Example', degreeType, primaryState: 'TX', email: 'pat@example.test', notifyEmail: true, reminderLeadDays: 90 },
  licenses: [], cme: [], documents: [], education: [], ...over,
});
const build = (d) => buildSetup(d, { now: NOW });
const status = (d, id) => build(d).byId[id].status;
const done = (d, id) => ['done', 'documented'].includes(status(d, id));

test('About you is done for a PA and an NP; MBBS and blank stay pending and ask for the profession', () => {
  assert.ok(done(base('PA'), 'identity'));
  assert.ok(done(base('NP'), 'identity'));
  for (const deg of ['', 'MBBS']) {
    const b = build(base(deg));
    assert.equal(b.byId.identity.status, 'pending', deg);
    assert.match(b.byId.identity.detail, /Still needed: your profession\./);
    assert.match(b.byId.identity.why, /MD, DO, PA or NP/);
  }
});

test('a PA or NP sees the whole board once the profession is chosen; blank sees only About you and the CV', () => {
  const blank = build(base(''));
  assert.deepEqual(blank.open.map(t => t.id).sort(), ['cv', 'identity']);
  for (const deg of ['PA', 'NP']) {
    const b = build(base(deg));
    assert.ok(b.open.some(t => t.id === 'licenses'), deg);
    assert.ok(b.open.some(t => t.id === 'boards'), deg);
  }
});

const paLic = { id: 'p1', type: 'State Physician Assistant License', state: 'TX', licenseNumber: 'PA100', expirationDate: '2027-05-31' };
const med = { id: 'm1', type: 'State Medical License', state: 'TX', licenseNumber: 'Q1', expirationDate: '2027-05-31' };
const aprn = { id: 'n1', type: 'APRN License (NP)', state: 'TX', licenseNumber: 'AP1', expirationDate: '2027-05-31' };
const rnMulti = { id: 'r1', type: 'RN License (Multistate)', state: 'TX', licenseNumber: 'RN1', expirationDate: '2027-05-31' };

test('the licence row: a PA licence for a PA, never a medical licence', () => {
  assert.ok(done(base('PA', { licenses: [paLic] }), 'licenses'));
  const withMedical = build(base('PA', { licenses: [med] }));
  assert.equal(withMedical.byId.licenses.status, 'pending');
  assert.match(withMedical.byId.licenses.detail, /physician assistant license/);
  assert.doesNotMatch(withMedical.byId.licenses.detail, /medical license/);
  // MD unchanged: a medical licence closes it.
  assert.ok(done(base('MD', { licenses: [med] }), 'licenses'));
});

test('the licence row for an NP needs the APRN licence and the RN licence', () => {
  assert.equal(status(base('NP', { licenses: [aprn] }), 'licenses'), 'pending');
  assert.match(build(base('NP', { licenses: [aprn] })).byId.licenses.detail, /Add your RN license/);
  assert.match(build(base('NP', { licenses: [rnMulti] })).byId.licenses.detail, /Add your APRN license/);
  assert.ok(done(base('NP', { licenses: [aprn, rnMulti] }), 'licenses'));
  assert.equal(status(base('NP', { licenses: [aprn, { ...rnMulti, lifecycleStatus: 'historical' }] }), 'licenses'), 'pending', 'a historical RN licence is not held');
});

test('dates and proof follow the profession\'s practice licence', () => {
  const undated = { ...paLic, expirationDate: '' };
  assert.deepEqual(datable(base('PA', { licenses: [undated, med] })).map(l => l.id), ['p1']);
  assert.deepEqual(datable(base('MD', { licenses: [undated, med] })).map(l => l.id), ['m1']);
  assert.deepEqual(evidenceQueue(base('NP', { licenses: [aprn, rnMulti, med] }), 'proof').records.map(l => l.id), ['n1', 'r1']);
});

test('the certification row: NCCPA for a PA, a national NP certification for an NP, dated, by role', () => {
  const nccpa = { id: 'c1', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2027-12-31' };
  const b = build(base('PA', { licenses: [nccpa] }));
  assert.equal(b.byId.boards.label, 'NCCPA certification');
  assert.ok(['done', 'documented'].includes(b.byId.boards.status));
  assert.equal(status(base('PA', { licenses: [{ ...nccpa, expirationDate: '' }] }), 'boards'), 'pending', 'NCCPA expires: a date is needed');
  const caq = { ...nccpa, id: 'c2', name: 'CAQ Emergency Medicine', customFields: { 'Certification role': 'CAQ or other' } };
  assert.equal(status(base('PA', { licenses: [caq] }), 'boards'), 'pending', 'a CAQ is not the PA-C');
  assert.equal(status(base('PA', { licenses: [{ id: 'a', type: 'Board Certification (ABMS)', name: 'ABEM' }] }), 'boards'), 'pending');
  const fnp = { id: 'c3', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2029-06-30' };
  assert.equal(build(base('NP', { licenses: [fnp] })).byId.boards.label, 'National NP certification');
  assert.ok(done(base('NP', { licenses: [fnp] }), 'boards'));
  const ccrn = { id: 'c4', type: 'Board Certification (ANCC)', name: 'RN-BC', expirationDate: '2029-06-30', customFields: { 'Certification role': 'RN specialty' } };
  assert.equal(status(base('NP', { licenses: [ccrn] }), 'boards'), 'pending', 'an RN specialty certificate is not an NP certification');
  // No specialty is asked of a PA or NP.
  assert.doesNotMatch(build(base('PA', { licenses: [nccpa] })).byId.boards.detail || '', /specialty/i);
});

test('education: a PA program for a PA, MSN, DNP or a post-graduate APRN certificate for an NP; no residency', () => {
  assert.equal(build(base('PA')).byId.education.label, 'PA program');
  assert.ok(done(base('PA', { education: [{ id: 'e', type: 'Master of Physician Assistant Studies (MPAS)' }] }), 'education'));
  assert.equal(status(base('PA', { education: [{ id: 'e', type: 'Bachelor of Science (BS)' }] }), 'education'), 'pending');
  assert.equal(build(base('NP')).byId.education.label, 'Nursing education');
  assert.ok(done(base('NP', { education: [{ id: 'e', type: 'Doctor of Nursing Practice (DNP)' }] }), 'education'));
  assert.ok(done(base('NP', { education: [{ id: 'e', type: 'Post-Graduate APRN Certificate' }] }), 'education'));
  assert.equal(status(base('NP', { education: [{ id: 'e', type: 'Associate Degree in Nursing (ADN)' }] }), 'education'), 'pending');
});

test('row labels never call a PA or NP a physician', () => {
  for (const deg of ['PA', 'NP']) {
    const b = build(base(deg));
    const text = b.tasks.map(t => [t.label, t.why, t.detail, t.cardLine, t.nextPhrase].join(' ')).join(' ');
    assert.doesNotMatch(text, /medical school|medical license|MD or DO/i, deg);
  }
  assert.equal(build(base('NP')).byId.cme.label, 'CE for the current cycle');
  assert.equal(build(base('PA')).byId.lifeSupport.label, 'BLS, ACLS or PALS');
});

test('the certification row for a PA or NP names its own certification and never asks for a specialty', async () => {
  const { mountComponent } = await import('../component-harness.mjs');
  const setupTasks = await import('../../src/utils/setupTasks.js');
  const professions = await import('../../src/constants/professions.js');
  const drawerText = async (deg) => {
    const d = base(deg, { settings: { ...base(deg).settings, specialties: [] } });
    const task = build(d).byId.boards;
    const c = await mountComponent('src/components/features/SetupPage.jsx', {
      exportName: 'PacketDrawer', app: { data: d, theme: {} }, props: { task, onOpenSection() {} },
      modules: { setupTasks, professions, publicRecord: { canFillFromPublicRecord: () => false } },
    });
    return { task, text: c.pageText() };
  };
  for (const [deg, label, verb] of [['PA', 'NCCPA certification', 'Add my NCCPA certification'], ['NP', 'National NP certification', 'Add my NP certification']]) {
    const { task, text } = await drawerText(deg);
    assert.equal(task.label, label);
    assert.equal(task.verb, verb);
    assert.match(text, new RegExp(verb));
    assert.doesNotMatch(text, /specialty/i, `${deg}: a PA or NP specialty sets no board rules`);
    assert.doesNotMatch(text, /board certification/i);
  }
  // A physician keeps the row as it was.
  const md = await drawerText('MD');
  assert.equal(md.task.verb, 'Add my board certification');
  assert.match(md.text, /Your specialty is still blank\. It sets which board rules apply to you/);
});
