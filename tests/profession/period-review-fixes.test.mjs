// Regression tests for the October 2026 period and alert review of the PA
// and NP engine: fixed due dates, fixed and member-start periods longer than
// the licence term, an unanswered Hawaii prescriber question, the ANCC
// development category, certification transcripts and legacy licence
// dedupe. Synthetic records only. Time is frozen at local noon on 2026-10-01.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { complianceFor } from '../../src/utils/compliance.js';
import { computeAppCompliance } from '../../src/utils/appCompliance.js';
import { certificationCards } from '../../src/utils/certCompliance.js';
import { cmeAssessmentLabel, totalHoursLabel } from '../../src/utils/cmePresentation.js';
import { markAlreadyOnFile } from '../../src/utils/publicRecord.js';
import { mergeNpiLicenses } from '../../src/utils/npiImport.js';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });
const notifications = await bundle('src/utils/notifications.js');
const transcripts = await bundle('src/utils/cmeTranscriptPdf.js');

const base = { privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [], documents: [], workLog: [], invoices: [] };
const data = (degreeType, licenses, cme = [], over = {}) => ({ ...base, settings: { name: 'Alex Example', degreeType, primaryState: 'TX', additionalStates: [], reminderLeadDays: 90, ...over }, licenses, cme });
const lic = (id, type, state, expirationDate, extra = {}) => ({ id, type, name: `${state} ${type}`, state, expirationDate, licenseNumber: `${id}-0001`, ...extra });
const cme = (category, hours, date, extra = {}) => ({ id: `${category}-${date}-${hours}`, title: 'Course', category, hours: String(hours), date, topics: [], ...extra });
const run = (st, deg, kind, opts = {}) => computeAppCompliance(opts.cme || [], st, deg, { kind, ...opts });
const issuesOf = (d) => (notifications.generateAlerts(d)?.cmeIssues || []).flatMap(i => i.issues);

// ── New York prescriber training on fixed July 1 due dates ──
test('New York: a pain management course taken for July 1, 2026 meets a renewal after that date (NP and PA)', () => {
  const answers = { 'Holds a DEA registration': 'Yes' };
  const course = [cme('Accredited Nursing CE', 3, '2026-01-15', { topics: ['Pain Management'] })];
  for (const exp of ['2026-12-15', '2027-03-31', '2026-11-30']) {
    const np = run('NY', 'NP', 'aprn', { licenseExpiration: exp, licenseAnswers: answers, hasDEA: true, cme: course });
    const t = np.topicResults.find(r => r.topic === 'Pain Management');
    assert.equal(t.met, true, `NP ${exp}`);
    assert.equal(t.earned, 3);
    assert.match(t.periodLabel, /counting the period due Jul 1, 2026, next due Jul 1, 2029/);
  }
  const paCourse = [cme('AAPA Category 1 CME', 3, '2026-01-15', { topics: ['Pain Management'] })];
  const pa = run('NY', 'PA', 'pa', { licenseExpiration: '2026-12-15', licenseAnswers: answers, hasDEA: true, cme: paCourse });
  assert.equal(pa.topicResults.find(r => r.topic === 'Pain Management').met, true, 'PA');
  // Not taken in the period that ended July 1, 2026: still a real shortfall.
  const late = run('NY', 'NP', 'aprn', { licenseExpiration: '2026-12-15', licenseAnswers: answers, hasDEA: true,
    cme: [cme('Accredited Nursing CE', 3, '2023-03-01', { topics: ['Pain Management'] })] });
  assert.equal(late.topicResults.find(r => r.topic === 'Pain Management').met, false);
  // A renewal before the next due date counts the period that ended on the last one.
  const before = run('NY', 'NP', 'aprn', { licenseExpiration: '2026-05-31', licenseAnswers: answers, hasDEA: true,
    cme: [cme('Accredited Nursing CE', 3, '2021-09-01', { topics: ['Pain Management'] })] });
  const b = before.topicResults.find(r => r.topic === 'Pain Management');
  assert.equal(b.met, true);
  assert.match(b.periodLabel, /due Jul 1, 2023, next due Jul 1, 2026/);
});

test('New York: no "Pain Management: 0/3 hrs" alert for a member who met the July 1, 2026 due date', () => {
  const d = data('NP', [lic('a', 'APRN License (NP)', 'NY', '2026-12-15', { customFields: { 'Holds a DEA registration': 'Yes' } })],
    [cme('Accredited Nursing CE', 3, '2026-01-15', { topics: ['Pain Management'] })], { primaryState: 'NY' });
  assert.ok(!issuesOf(d).some(i => /Pain Management/.test(i)), issuesOf(d).join('; '));
});

// ── Fixed periods longer than the licence term ──
test('Mississippi PA: the two-year period is due at its own end, not at the off-year licence renewal', () => {
  const answers = { 'Holds controlled substance prescriptive authority': 'No' };
  const comp = run('MS', 'PA', 'pa', { licenseExpiration: '2026-12-15', licenseAnswers: answers, cme: [cme('AAPA Category 1 CME', 20, '2026-08-01')] });
  assert.equal(comp.windowLabel, 'Counting CME dated Jul 1, 2026 through Jun 30, 2028');
  assert.equal(comp.daysLeft, 638, 'days to June 30, 2028');
  const d = data('PA', [lic('a', 'State Physician Assistant License', 'MS', '2026-12-15', { customFields: answers })],
    [cme('AAPA Category 1 CME', 20, '2026-08-01')], { primaryState: 'MS' });
  assert.ok(!issuesOf(d).some(i => /total hrs|Cat 1/.test(i)), issuesOf(d).join('; '));
  // A period that ends on the renewal keeps the licence countdown.
  const al = run('AL', 'PA', 'pa', { licenseExpiration: '2026-12-31' });
  assert.equal(al.windowLabel, 'Counting CME dated Jan 1, 2025 through Dec 31, 2026');
  assert.equal(al.daysLeft, 91);
});

test('Alabama PA: an odd-year renewal counts the next period and waits for its end', () => {
  mock.timers.setTime(new Date(2027, 9, 1, 12, 0, 0).getTime());
  try {
    const comp = run('AL', 'PA', 'pa', { licenseExpiration: '2027-12-31', cme: [cme('AAPA Category 1 CME', 10, '2027-03-01')] });
    assert.equal(comp.windowLabel, 'Counting CME dated Jan 1, 2027 through Dec 31, 2028');
    assert.ok(comp.daysLeft > 400, `daysLeft ${comp.daysLeft}`);
    const d = data('PA', [lic('a', 'State Physician Assistant License', 'AL', '2027-12-31')], [cme('AAPA Category 1 CME', 10, '2027-03-01')], { primaryState: 'AL' });
    assert.ok(!issuesOf(d).some(i => /total hrs/.test(i)), issuesOf(d).join('; '));
  } finally { mock.timers.setTime(new Date(2026, 9, 1, 12, 0, 0).getTime()); }
});

// ── A member-start period steps forward ──
test('North Carolina and Tennessee: a CME Cycle Start set once in 2022 counts the period holding the renewal', () => {
  for (const [st, deg, kind, cat] of [['NC', 'PA', 'pa', 'AAPA Category 1 CME'], ['TN', 'PA', 'pa', 'AAPA Category 1 CME'], ['NC', 'NP', 'aprn', 'Accredited Nursing CE']]) {
    const comp = run(st, deg, kind, { licenseExpiration: '2027-08-15', cycleStart: '2022-08-15', cme: [cme(cat, 20, '2026-09-01')] });
    assert.equal(comp.windowLabel.replace(/^Counting (CME|CE) dated /, ''), 'Aug 15, 2026 through Aug 14, 2028', `${st} ${kind}`);
    assert.equal(comp.totalEarned, 20, `${st} ${kind}`);
    assert.equal(comp.periodDaysLeft, 683, `${st} ${kind}: the hours are due at the period end, Aug 14, 2028`);
    // The NC APRN renewal requires current national certification, none on
    // file here, so the card still counts down to the licence date.
    assert.equal(comp.daysLeft, kind === 'aprn' ? 318 : 683, `${st} ${kind}`);
  }
  // A renewal the day after a period ends is judged on the period that ended.
  const ended = run('NC', 'PA', 'pa', { licenseExpiration: '2026-08-15', cycleStart: '2022-08-15', cme: [cme('AAPA Category 1 CME', 20, '2025-03-01')] });
  assert.equal(ended.windowLabel, 'Counting CME dated Aug 15, 2024 through Aug 14, 2026');
  assert.equal(ended.totalEarned, 20);
  // A start inside the current period is used as entered.
  const current = run('NC', 'PA', 'pa', { licenseExpiration: '2027-03-31', cycleStart: '2026-06-15' });
  assert.equal(current.windowLabel, 'Counting CME dated Jun 15, 2026 through Jun 14, 2028');
});

// ── Hawaii APRN: hours only for prescribers ──
test('Hawaii APRN: an unanswered prescriptive authority question sets no hour target and raises no alert', () => {
  const role = { 'Certification role': 'NP certification' };
  const aanpcb = { id: 'c', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2028-06-30', customFields: role };
  const d = data('NP', [lic('a', 'APRN License (NP)', 'HI', '2026-12-15'), aanpcb], [], { primaryState: 'HI' });
  const comp = complianceFor(d, 'HI', 'aprn');
  assert.equal(comp.totalRequired, null);
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
  assert.equal(comp.exemption.unanswered, true);
  assert.equal(totalHoursLabel(comp), 'Answer the question on this license');
  assert.match(cmeAssessmentLabel(comp), /^Answer the question on this license/);
  assert.ok(!issuesOf(d).some(i => /total hrs/.test(i)), issuesOf(d).join('; '));
  // Answered No: met, and the label says why, not "may be satisfied by AANPCB".
  const no = data('NP', [lic('a', 'APRN License (NP)', 'HI', '2026-12-15', { customFields: { 'Holds prescriptive authority': 'No' } }), aanpcb], [], { primaryState: 'HI' });
  const noComp = complianceFor(no, 'HI', 'aprn');
  assert.equal(noComp.assessmentStatus, 'met');
  assert.equal(cmeAssessmentLabel(noComp), 'No hours due this renewal (exempt)');
  // Answered Yes: the 30 hours are a real target.
  const yes = complianceFor(data('NP', [lic('a', 'APRN License (NP)', 'HI', '2026-12-15', { customFields: { 'Holds prescriptive authority': 'Yes' } }), aanpcb], [], { primaryState: 'HI' }), 'HI', 'aprn');
  assert.equal(yes.totalRequired, 30);
  assert.equal(yes.exemption.unanswered, false);
  // A per-renewal exception (Michigan RN, whole two years) still keeps the hours until answered.
  const mi = run('MI', 'NP', 'rn', { licenseExpiration: '2027-03-31' });
  assert.equal(mi.totalRequired, 25);
});

// ── ANCC professional development category ──
test('ANCC: a card short only on the professional development category names it in the alert', () => {
  const rec = { id: 'a', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2026-12-15',
    customFields: { 'Certification role': 'NP certification', 'Professional development category completed': 'No', 'Professional development category completed (for renewal)': '2026-12-15' } };
  const d = data('NP', [rec], [cme('Accredited Nursing CE', 80, '2025-06-01', { customFields: { 'Pharmacology Hours': '30' } })]);
  const [card] = certificationCards(d);
  assert.equal(card.status, 'needs-hours');
  assert.match(card.assessment, /needs one of the professional development categories$/);
  const issues = issuesOf(d);
  assert.ok(issues.some(i => /professional development/.test(i)), issues.join('; '));
  // Not answered: the card asks.
  const open = certificationCards(data('NP', [{ ...rec, customFields: { 'Certification role': 'NP certification' } }], d.cme))[0];
  assert.match(open.assessment, /answer the professional development category question$/);
  // Answered Yes: only the figures.
  const done = certificationCards(data('NP', [{ ...rec, customFields: { ...rec.customFields, 'Professional development category completed': 'Yes' } }], d.cme))[0];
  assert.equal(done.status, 'met');
  assert.doesNotMatch(done.assessment, /professional development/);
});

// ── Certification transcript rows ──
test('certification transcript marks rows the certifier card does not count', () => {
  const rec = { id: 'c', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2027-06-30', customFields: { 'Certification role': 'NP certification' } };
  const d = data('NP', [rec], [cme('Accredited Nursing CE', 20, '2026-01-10'), cme('Other', 10, '2026-02-10'), cme('AMA PRA Category 1', 5, '2026-03-10')]);
  const option = transcripts.boardTranscriptOptions(d).find(o => o.source === 'CERT');
  assert.equal(option.earned, 20);
  const model = transcripts.boardTranscriptModel(d, option);
  const counted = Object.fromEntries(model.rows.map(r => [r.entry.category, r.counted]));
  assert.deepEqual(counted, { 'Accredited Nursing CE': true, Other: false, 'AMA PRA Category 1': false });
  assert.equal(model.countRule, 'AANPCB contact hours');
  // NCCPA counts every category: nothing is marked.
  const pa = data('PA', [{ id: 'n', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2027-12-31' }], [cme('AAPA Category 1 CME', 10, '2026-03-01'), cme('Category 2 CME', 5, '2026-04-01')]);
  const nccpa = transcripts.boardTranscriptOptions(pa).find(o => o.source === 'CERT');
  assert.ok(transcripts.boardTranscriptModel(pa, nccpa).rows.every(r => r.counted === true));
  // The card itself stays plain data.
  assert.ok(!Object.keys(certificationCards(d)[0]).includes('counts'));
});

// ── Legacy medical-typed licence and the nursing keys ──
test('a legacy "State Medical License" on file still matches the APRN finding for its state and number', () => {
  const legacy = { id: 'l', type: 'State Medical License', name: 'TX Medical License', state: 'TX', licenseNumber: '123' };
  const finding = { id: 'f', section: 'licenses', fields: { type: 'APRN License (NP)', state: 'TX', licenseNumber: '123' } };
  const [f] = markAlreadyOnFile([finding], { licenses: [legacy] });
  assert.equal(f.alreadyOnFile, true);
  // A typed RN licence with that number holds the RN key; the legacy one answers for the APRN.
  const rnTyped = { id: 'r', type: 'RN License', state: 'TX', licenseNumber: '123' };
  const rnFinding = { id: 'g', section: 'licenses', fields: { type: 'RN License', state: 'TX', licenseNumber: '123' } };
  const both = markAlreadyOnFile([finding, rnFinding], { licenses: [legacy, rnTyped] });
  assert.deepEqual(both.map(x => x.alreadyOnFile), [true, true]);
  // A typed APRN licence alone never hides the RN finding.
  const [rnOnly] = markAlreadyOnFile([rnFinding], { licenses: [{ id: 'a', type: 'APRN License (NP)', state: 'TX', licenseNumber: '123' }] });
  assert.equal(rnOnly.alreadyOnFile, false);
  // The NPI re-import: no second copy for an NP or PA account.
  const ids = () => { let i = 0; return () => `id${++i}`; };
  const row = { state: 'TX', licenseNumber: '123', taxonomyCode: '363LF0000X', description: 'Nurse Practitioner, Family' };
  assert.deepEqual(mergeNpiLicenses([legacy], [row], { degreeType: 'NP', makeId: ids() }), []);
  assert.equal(mergeNpiLicenses([{ ...legacy, type: 'APRN License (NP)' }], [{ ...row, taxonomyCode: '163W00000X' }], { degreeType: 'NP', makeId: ids() }).length, 1, 'the RN row is still new');
});
