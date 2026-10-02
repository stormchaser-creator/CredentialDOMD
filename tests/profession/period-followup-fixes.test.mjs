// Regression tests for the follow-up review of the October 2026 period fixes:
// a CME Cycle Start on a fixed period, renewal checks on an off-year card,
// the legacy licence answering to one nursing key, and the state card naming
// the date its countdown counts to. Synthetic records only. Time is frozen at
// local noon on 2026-10-01.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { complianceFor, standingScore, complianceListFor } from '../../src/utils/compliance.js';
import { computeAppCompliance } from '../../src/utils/appCompliance.js';
import { anchoredRenewalLine } from '../../src/utils/cmePresentation.js';
import { markAlreadyOnFile } from '../../src/utils/publicRecord.js';
import { mergeNpiLicenses } from '../../src/utils/npiImport.js';
import { stateCmeCards } from '../../src/utils/memberViewer.js';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });
const notifications = await bundle('src/utils/notifications.js');

const base = { privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [], documents: [], workLog: [], invoices: [] };
const data = (degreeType, licenses, cme = [], over = {}) => ({ ...base, settings: { name: 'Alex Example', degreeType, primaryState: 'TX', additionalStates: [], reminderLeadDays: 90, ...over }, licenses, cme });
const lic = (id, type, state, expirationDate, extra = {}) => ({ id, type, name: `${state} ${type}`, state, expirationDate, licenseNumber: `${id}-0001`, ...extra });
const cme = (category, hours, date, extra = {}) => ({ id: `${category}-${date}-${hours}`, title: 'Course', category, hours: String(hours), date, topics: [], ...extra });
const run = (st, deg, kind, opts = {}) => computeAppCompliance(opts.cme || [], st, deg, { kind, ...opts });
const alertsOf = (d) => notifications.generateAlerts(d)?.cmeIssues || [];
const issuesOf = (d) => alertsOf(d).flatMap(i => i.issues);
const ringFor = (d) => standingScore({ stateComps: complianceListFor(d), leadDays: 90 });

// ── Finding 1: a CME Cycle Start on a fixed period ──
const msAnswers = { 'Holds controlled substance prescriptive authority': 'No' };
test('Mississippi PA: entering the cycle\'s first day, as the rule note asks, keeps the whole period and raises no off-year alert', () => {
  const comp = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', cycleStart: '2026-07-01', licenseAnswers: msAnswers, cme: [cme('AAPA Category 1 CME', 20, '2026-08-01')] });
  assert.equal(comp.windowLabel, 'Counting CME dated Jul 1, 2026 through Jun 30, 2028');
  assert.equal(comp.daysLeft, 638);
  // CME after the licence date that belongs to the period still counts.
  const later = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', cycleStart: '2026-07-01', licenseAnswers: msAnswers, cme: [cme('AAPA Category 1 CME', 20, '2027-05-01')] });
  assert.equal(later.totalEarned, 20);
  const d = data('PA', [lic('a', 'State Physician Assistant License', 'MS', '2026-12-15', { cmeCycleStart: '2026-07-01', customFields: msAnswers })],
    [cme('AAPA Category 1 CME', 20, '2026-08-01')], { primaryState: 'MS' });
  assert.deepEqual(issuesOf(d), []);
  assert.equal(ringFor(d).needsAction.filter(n => n.item._sec === 'cme').length, 0, 'the ring counts the card as good');
  // A start inside the period (licensed mid-period) moves only the start.
  const mid = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', cycleStart: '2026-09-01', licenseAnswers: msAnswers });
  assert.equal(mid.windowLabel, 'Counting CME dated Sep 1, 2026 through Jun 30, 2028');
  assert.equal(mid.windowSource, 'custom');
  // An earlier period's start never counts the old period.
  const old = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', cycleStart: '2024-07-01', licenseAnswers: msAnswers, cme: [cme('AAPA Category 1 CME', 20, '2025-01-10')] });
  assert.equal(old.windowLabel, 'Counting CME dated Jul 1, 2026 through Jun 30, 2028');
  assert.equal(old.totalEarned, 0);
  assert.equal(old.cycleStartIgnored, false);
});

test('Alabama PA: a CME Cycle Start of January 1, 2025 counts through December 31, 2026', () => {
  mock.timers.setTime(new Date(2025, 9, 1, 12, 0, 0).getTime());
  try {
    const comp = run('AL', 'PA', 'pa', { licenseExpiration: '2025-12-31', cycleStart: '2025-01-01' });
    assert.equal(comp.windowLabel, 'Counting CME dated Jan 1, 2025 through Dec 31, 2026');
    assert.equal(comp.countdownTo, 'period');
    assert.ok(comp.daysLeft > 400, `daysLeft ${comp.daysLeft}`);
  } finally { mock.timers.setTime(new Date(2026, 9, 1, 12, 0, 0).getTime()); }
});

// ── Finding 2: renewal checks keep the licence date on an off-year card ──
test('North Carolina APRN off-year: a missing national certification alerts at the annual renewal and counts on the ring', () => {
  const noDea = { 'Holds a DEA registration': 'No', 'Prescribes controlled substances': 'No' };
  const d = data('NP', [lic('a', 'APRN License (NP)', 'NC', '2026-11-10', { cmeCycleStart: '2025-11-10', customFields: noDea })], [], { primaryState: 'NC' });
  const comp = complianceFor(d, 'NC', 'aprn');
  assert.equal(comp.countdownTo, 'license');
  assert.equal(comp.daysLeft, 40);
  assert.equal(comp.periodDaysLeft, 404);
  const alerts = alertsOf(d).filter(a => a.state === 'NC');
  assert.equal(alerts.length, 1, JSON.stringify(alertsOf(d)));
  assert.deepEqual(alerts[0].issues, ['Current national NP certification: not on file'], 'the off-year hours are not listed');
  assert.equal(alerts[0].renewal, '2026-11-10');
  assert.equal(alerts[0].daysLeft, 40);
  assert.ok(ringFor(d).needsAction.some(n => n.item.id === 'cme:NC:aprn'), 'the ring counts it');
  // With the certification on file, the off-year card waits for its period end.
  const cert = { id: 'c', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2029-06-30', customFields: { 'Certification role': 'NP certification' } };
  const ok = data('NP', [d.licenses[0], cert], [], { primaryState: 'NC' });
  const okComp = complianceFor(ok, 'NC', 'aprn');
  assert.equal(okComp.countdownTo, 'period');
  assert.equal(okComp.daysLeft, 404);
  assert.deepEqual(alertsOf(ok).filter(a => a.state === 'NC'), []);
});

test('an unmet MATE on an off-year card keeps the licence countdown', () => {
  const comp = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', licenseAnswers: msAnswers, hasDEA: true });
  assert.equal(comp.mate.met, false);
  assert.equal(comp.countdownTo, 'license');
  assert.equal(comp.daysLeft, 75);
  const done = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', licenseAnswers: msAnswers, hasDEA: true,
    cme: [cme('AAPA Category 1 CME', 8, '2024-02-01', { topics: ['Opioid Prescribing'] })] });
  assert.equal(done.mate.met, true);
  assert.equal(done.countdownTo, 'period');
  assert.equal(done.daysLeft, 638);
});

// ── Finding 3: a legacy licence is one nursing licence, not both ──
test('a legacy medical-typed licence hides only the APRN row sharing its number; the RN row is still offered', () => {
  const legacy = { id: 'l', type: 'State Medical License', name: 'CA Medical License', state: 'CA', licenseNumber: '900001' };
  const rows = [
    { state: 'CA', licenseNumber: '900001', taxonomyCode: '363LF0000X', description: 'Nurse Practitioner, Family' },
    { state: 'CA', licenseNumber: '900001', taxonomyCode: '163W00000X', description: 'Registered Nurse' },
  ];
  let i = 0;
  const added = mergeNpiLicenses([legacy], rows, { degreeType: 'NP', makeId: () => `id${++i}` });
  assert.deepEqual(added.map(a => a.type), ['RN License']);
  const aprnF = { id: 'f', section: 'licenses', fields: { type: 'APRN License (NP)', state: 'CA', licenseNumber: '900001' } };
  const rnF = { id: 'g', section: 'licenses', fields: { type: 'RN License', state: 'CA', licenseNumber: '900001' } };
  assert.deepEqual(markAlreadyOnFile([aprnF, rnF], { licenses: [legacy] }).map(f => f.alreadyOnFile), [true, false]);
  // With a typed APRN licence on that number, the legacy record is the RN one.
  const typedAprn = { id: 'a', type: 'APRN License (NP)', state: 'CA', licenseNumber: '900001' };
  assert.deepEqual(markAlreadyOnFile([aprnF, rnF], { licenses: [legacy, typedAprn] }).map(f => f.alreadyOnFile), [true, true]);
  assert.deepEqual(mergeNpiLicenses([legacy, typedAprn], rows, { degreeType: 'NP', makeId: () => 'x' }), []);
  // Two legacy records on one number are both licences.
  assert.deepEqual(mergeNpiLicenses([legacy, { ...legacy, id: 'l2' }], rows, { degreeType: 'NP', makeId: () => 'x' }), []);
});

// ── Finding 4: the card names the date its countdown counts to ──
test('state card: a countdown to the CME period end names that date beside the licence renewal', () => {
  const d = data('PA', [lic('a', 'State Physician Assistant License', 'MS', '2026-12-15', { customFields: msAnswers })], [], { primaryState: 'MS' });
  const comp = complianceFor(d, 'MS', 'pa');
  assert.equal(comp.countdownTo, 'period');
  assert.equal(anchoredRenewalLine(comp, '2026-12-15'), 'CME period ends Jun 30, 2028 · License renews Dec 15, 2026');
  const [card] = stateCmeCards({ member: { name: '', degreeType: 'PA', primaryState: 'MS', additionalStates: [], reminderLeadDays: 90 }, sections: { licenses: d.licenses, cme: [] } });
  assert.match(card.renews, /^CME period ends Jun 30, 2028 · License renews Dec 15, 2026$/);
  assert.equal(card.daysLeft, 638);
  // A countdown to the licence date says only the licence date.
  const al = run('AL', 'PA', 'pa', { licenseExpiration: '2026-12-31' });
  assert.equal(anchoredRenewalLine(al, '2026-12-31'), 'License renews Dec 31, 2026');
  const nc = complianceFor(data('NP', [lic('a', 'APRN License (NP)', 'NC', '2026-11-10', { cmeCycleStart: '2025-11-10' })], [], { primaryState: 'NC' }), 'NC', 'aprn');
  assert.equal(anchoredRenewalLine(nc, '2026-11-10'), 'License renews Nov 10, 2026');
  // A physician card is unchanged.
  assert.equal(anchoredRenewalLine({ daysLeft: 10 }, '2026-11-10'), 'License renews Nov 10, 2026');
});
