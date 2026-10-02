// Regression tests for the October 2026 PA and NP review findings (code
// findings). Synthetic records only: no real member's name, NPI or state of
// practice. Time is frozen at local noon on 2026-10-01.
import '../helpers/app-rules.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { complianceFor, complianceListFor, cardsForStates, mainCardFor, standingScore } from '../../src/utils/compliance.js';
import { computeAppCompliance } from '../../src/utils/appCompliance.js';
import { certificationCards, certificationRingComps } from '../../src/utils/certCompliance.js';
import { cmeAssessmentLabel, totalHoursLabel, cmeReviewKeys } from '../../src/utils/cmePresentation.js';
import { unverifiedLines } from '../../src/utils/recordAnswers.js';
import { licenseFields } from '../../src/utils/credentialForms.js';
import { normalizeLifecycle, dateUnknownApplies, needsResolution } from '../../src/utils/lifecycle.js';
import { renewalView } from '../../src/utils/renewalRoute.js';
import { renewalLineFor } from '../../supabase/functions/_shared/reminderRenewalLine.mjs';
import { retypedRecord } from '../../src/utils/professionReview.js';
import { markAlreadyOnFile } from '../../src/utils/publicRecord.js';
import { getStateReq } from '../../src/constants/stateRequirements.js';
import { SYSTEM_PROMPT } from '../../src/utils/scannerCore.js';
import { buildSetup } from '../../src/utils/setupTasks.js';
import * as client from '../../src/utils/requestPacket.js';
import * as server from '../../supabase/functions/_shared/requestPacket.ts';
import appBoardLinks from '../../supabase/functions/send-reminders/appBoardLinks.json' with { type: 'json' };
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });
const notifications = await bundle('src/utils/notifications.js');
const assistant = await bundle('src/utils/assistant.js');
const transcripts = await bundle('src/utils/cmeTranscriptPdf.js');
const helpers = await bundle('src/utils/helpers.js');

const base = { privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [], documents: [], workLog: [], invoices: [] };
const data = (degreeType, licenses, cme = [], over = {}) => ({ ...base, settings: { name: 'Alex Example', degreeType, primaryState: 'TX', additionalStates: [], reminderLeadDays: 90, ...over }, licenses, cme });
const lic = (id, type, state, expirationDate, extra = {}) => ({ id, type, name: `${state} ${type}`, state, expirationDate, licenseNumber: `${id}-0001`, ...extra });
const cme = (category, hours, date, extra = {}) => ({ id: `${category}-${date}-${hours}`, title: 'Course', category, hours: String(hours), date, topics: [], ...extra });

// ── NCCPA window (findings 3 and the duplicate "career of CME") ──
test('NCCPA: an original certification date in Issued never stretches the window past this cycle', () => {
  const rec = { id: 'n', type: 'Board Certification (NCCPA)', name: 'PA-C', issuedDate: '2014-08-01', expirationDate: '2026-12-31' };
  const entries = [cme('AAPA Category 1 CME', 60, '2016-03-01'), cme('AAPA Category 1 CME', 30, '2025-03-01'), cme('Category 2 CME', 40, '2025-06-01')];
  const [card] = certificationCards(data('PA', [rec], entries));
  assert.equal(card.windowLabel, 'CME dated May 1, 2024 through Dec 31, 2026');
  assert.equal(card.earned, 70, 'the 2016 credits are outside this cycle');
  assert.equal(card.status, 'needs-hours');
  assert.ok(!card.lines.some(l => /New certificants/.test(l)), 'a 12-year certificant is not a new certificant');
  const career = { ...rec, issuedDate: '2014-06-01', expirationDate: '2027-12-31' };
  const yearly = Array.from({ length: 12 }, (_, i) => cme('AAPA Category 1 CME', 10, `${2014 + i}-07-01`));
  const [c2] = certificationCards(data('PA', [career], yearly));
  assert.equal(c2.windowLabel, 'CME dated May 1, 2025 through Dec 31, 2027');
  assert.equal(c2.earned, 10);
  assert.equal(c2.met, false);
});

// ── NCCPA shortfall in alerts and the ring (finding 4) ──
test('NCCPA: a credit shortfall inside the lead window raises an alert and lowers the ring', () => {
  const d = data('PA', [
    lic('p1', 'State Physician Assistant License', 'PA', '2027-12-31'),
    { id: 'n1', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2026-12-31' },
  ], [cme('AAPA Category 1 CME', 30, '2025-06-01')], { primaryState: 'PA', reminderLeadDays: 120 });
  const alerts = notifications.generateAlerts(d);
  const cert = alerts.cmeIssues.find(i => i.kind === 'cert');
  assert.ok(cert, 'the NCCPA shortfall is an issue');
  assert.match(cert.issues[0], /NCCPA credits: 30\/100, Category 1: 30\/50/);
  assert.match(notifications.buildNotificationMessage(d, alerts).body, /NCCPA certification \(PA-C\)/);
  const ring = standingScore({ stateComps: certificationRingComps(d), leadDays: 120 });
  assert.equal(ring.percent, 0);
  assert.equal(ring.needsAction[0].item.kind, 'cert');
  // Met: no alert, ring good.
  const met = data('PA', d.licenses, [cme('AAPA Category 1 CME', 100, '2025-06-01')], { primaryState: 'PA', reminderLeadDays: 120 });
  assert.equal((notifications.generateAlerts(met)?.cmeIssues || []).filter(i => i.kind === 'cert').length, 0);
  assert.equal(standingScore({ stateComps: certificationRingComps(met), leadDays: 120 }).percent, 100);
});

// ── Practice agreements that do not expire (finding 5) ──
test('a practice agreement or prescriptive authority record can be marked as not expiring', () => {
  const fields = licenseFields({ degreeType: 'PA' });
  const exp = fields.find(f => f.key === 'expirationDate');
  const box = fields.find(f => f.key === 'noExpiration');
  const agreement = { type: 'Practice Agreement', state: 'OH' };
  assert.equal(box.show(agreement), true);
  assert.equal(box.checkboxLabel(agreement), 'This agreement does not expire');
  assert.equal(exp.required(agreement), true, 'a date is asked until the member says it does not expire');
  assert.equal(exp.required({ ...agreement, noExpiration: true }), false);
  assert.equal(exp.required({ type: 'Prescriptive Authority', state: 'OH', noExpiration: true }), false);
  assert.equal(normalizeLifecycle('licenses', { ...agreement, noExpiration: true }).noExpiration, true);
  assert.equal(helpers.isNonExpiring({ ...agreement, noExpiration: true }, 'licenses'), true);
  assert.equal(dateUnknownApplies('licenses', { ...agreement, noExpiration: true }), false);
  assert.equal(needsResolution({ ...agreement, noExpiration: true, dateUnknown: true }, 'licenses'), false);
  // A state licence still never takes the flag.
  assert.equal(normalizeLifecycle('licenses', { type: 'State Physician Assistant License', noExpiration: true }).noExpiration, false);
});

// ── Osteopathic board alternative (finding 6) ──
test('PA renewal box and email keep the osteopathic board the rule data names', () => {
  for (const st of ['PA', 'NV', 'ME', 'WV']) {
    const v = renewalView({ id: 'x', type: 'State Physician Assistant License', state: st, expirationDate: '2027-06-30' }, 'PA');
    assert.match(v.board, /osteopathic/i, st);
    const line = renewalLineFor({ isLicense: true, state: st, type: 'State Physician Assistant License' }, 'PA', { appBoardLinks });
    assert.match(line, /Osteopathic/i, st);
  }
  const tx = renewalView({ id: 'x', type: 'State Physician Assistant License', state: 'TX', expirationDate: '2027-06-30' }, 'PA');
  assert.doesNotMatch(tx.board, /\(/);
});

// ── NCCPA on the CME page, transcript and Vera (finding 7) ──
test('NCCPA progress reaches the transcript options and Vera\'s snapshot, with the activity type', () => {
  const d = data('PA', [lic('t1', 'State Physician Assistant License', 'TX', '2027-12-31'), { id: 'n1', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2027-12-31' }],
    [cme('AAPA Category 1 CME', 10, '2026-03-01', { customFields: { 'NCCPA Activity': 'Self-Assessment' } })]);
  const options = transcripts.boardTranscriptOptions(d);
  const nccpa = options.find(o => o.source === 'CERT');
  assert.ok(nccpa, 'an NCCPA transcript is offered');
  assert.equal(nccpa.earned, 15);
  const model = transcripts.boardTranscriptModel(d, nccpa);
  assert.equal(model.error, undefined);
  assert.equal(model.requirements[0].required, '100');
  const snap = assistant.buildSnapshot(d, ['TX']);
  assert.equal(snap.certifications[0].body, 'NCCPA');
  assert.equal(snap.certifications[0].earned, 15);
  assert.equal(snap.cme[0].nccpaActivity, 'Self-Assessment');
});

// ── PA pharmacology hours from the scanner (finding 8) ──
test('the scanner asks for pharmacology hours on a PA certificate too', () => {
  assert.match(SYSTEM_PROMPT('PA'), /M in pharmacologyHours/);
});

// ── Retyping an imported medical licence renames it (finding 9) ──
test('retyping an imported "TX Medical License" names it after its new type; a chosen name stays', () => {
  const rec = { id: 'l', type: 'State Medical License', name: 'TX Medical License', state: 'TX' };
  assert.deepEqual(retypedRecord('licenses', rec, 'State Physician Assistant License'), { ...rec, type: 'State Physician Assistant License', name: 'TX Physician Assistant License' });
  assert.equal(retypedRecord('licenses', rec, 'RN License (Multistate)').name, 'TX RN License (Multistate)');
  assert.equal(retypedRecord('licenses', { ...rec, name: 'My Texas license' }, 'APRN License (NP)').name, 'My Texas license');
  assert.equal(retypedRecord('cme', { id: 'c', category: 'AMA PRA Category 1' }, 'AAPA Category 1 CME').category, 'AAPA Category 1 CME');
});

// ── Dual certification from one certifier (finding 10) ──
test('two NP certifications from one certifier get two cards; a renewed certificate is one', () => {
  const role = { 'Certification role': 'NP certification' };
  const recs = [
    { id: 'a', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2027-03-31', customFields: role },
    { id: 'b', type: 'Board Certification (ANCC)', name: 'PMHNP-BC', expirationDate: '2030-08-31', customFields: role },
    { id: 'c', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2026-12-31' },
    { id: 'd', type: 'Board Certification (AANPCB)', name: 'A-GNP-C', expirationDate: '2029-12-31' },
    { id: 'e', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2021-12-31' },
  ];
  const cards = certificationCards(data('NP', recs));
  assert.deepEqual(cards.map(c => c.recordId).sort(), ['a', 'b', 'c', 'd']);
});

// ── A certification whose role is not answered (finding 11) ──
test('an ANCC record with no role answer is on file: "answer the question", never "not on file"', () => {
  const d = data('NP', [
    lic('r', 'RN License (Multistate)', 'AZ', '2027-06-30'),
    lic('a', 'APRN License (NP)', 'AZ', '2026-11-30'),
    { id: 'c', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2028-03-31' },
  ], [], { primaryState: 'AZ' });
  const comp = complianceFor(d, 'AZ', 'aprn');
  const check = comp.credentialChecks.find(c => c.id === 'certification');
  assert.equal(check.met, null);
  assert.equal(check.pendingRole, true);
  assert.match(cmeAssessmentLabel(comp), /Answer what your certification record is/);
  const issues = (notifications.generateAlerts(d)?.cmeIssues || []).flatMap(i => i.issues);
  assert.ok(!issues.some(i => /not on file/.test(i)), issues.join('; '));
  const boards = buildSetup(d, {}).all?.find?.(t => t.id === 'boards') || [...(buildSetup(d, {}).open || []), ...(buildSetup(d, {}).done || [])].find(t => t.id === 'boards');
  assert.ok(boards, 'the boards row');
  assert.match(boards.detail, /On file\. Answer what this certification is/);
  assert.equal(boards.cardLine, 'Certification on file. Answer what it is on the record.');
});

// ── Cards read with their own licence kind (finding 13) ──
test('an RN-only state is read with the RN rules on Find CME, the desk audit and Settings', () => {
  const d = data('NP', [lic('r', 'RN License (Multistate)', 'WA', '2027-06-30'), lic('a', 'APRN License (NP)', 'ID', '2027-06-30')], [], { primaryState: 'ID' });
  const cards = cardsForStates(d, ['ID', 'WA']);
  assert.deepEqual(cards.map(c => c.key), ['ID:aprn', 'WA:rn']);
  assert.equal(mainCardFor(d, 'WA').kind, 'rn');
  assert.equal(mainCardFor(d, 'WA').comp.kind, 'rn');
});

// ── APRN hours satisfying the RN hours (finding 14) ──
test('Texas: the verified "APRN CE satisfies the RN hours" fact credits the RN card', () => {
  const d = data('NP', [lic('a', 'APRN License (NP)', 'TX', '2027-06-30'), lic('r', 'RN License (Multistate)', 'TX', '2028-06-30')],
    [cme('Accredited Nursing CE', 20, '2026-03-01')]);
  const rn = complianceFor(d, 'TX', 'rn');
  assert.deepEqual(rn.satisfiedVia, { kind: 'aprn' });
  assert.equal(rn.totalMet, true);
  // Directly: an APRN card that met its hours, passed in by compliance.js.
  const direct = computeAppCompliance([], 'TX', 'NP', { kind: 'rn', aprnComp: { totalMet: true, rulesVerified: true } });
  assert.deepEqual(direct.satisfiedVia, { kind: 'aprn' });
});

// ── State-Specific Required toward ANCC (finding 15) ──
test('ANCC: a state-mandated course logged as State-Specific Required counts toward the 75', () => {
  const rec = { id: 'a', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2027-03-31', customFields: { 'Certification role': 'NP certification' } };
  const [card] = certificationCards(data('NP', [rec], [cme('State-Specific Required', 2, '2025-01-01')]));
  assert.equal(card.earned, 2);
  assert.equal(card.formallyApproved.earned, 0, 'it says nothing about its accreditor');
});

// ── An unknown counting window (finding 16) ──
test('a PA state whose counting window is unverified raises no "0/25" alert and draws no bar', () => {
  // Rhode Island PA: the regulation counts July to June, the statute October to September.
  const d = data('PA', [lic('a', 'State Physician Assistant License', 'RI', '2026-12-01')], [cme('AAPA Category 1 CME', 60, '2026-03-01')], { primaryState: 'RI' });
  const comp = complianceFor(d, 'RI', 'pa');
  assert.equal(comp.windowKnown, false);
  assert.equal(comp.totalRequired, null, 'no hour target without a window');
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
  assert.ok(!comp.topicResults.some(t => t.period !== 'lifetime' && t.met === false), 'no recurring topic checked against an empty pool');
  assert.equal(totalHoursLabel(comp), 'Counting period not yet verified');
  const issues = (notifications.generateAlerts(d)?.cmeIssues || []).flatMap(i => i.issues);
  assert.ok(!issues.some(i => /total hrs|Cat 1/.test(i)), issues.join('; '));
  assert.ok(!issues.some(i => /0\/0 hrs/.test(i)), 'a one-time course reads "completion not recorded"');
  // With a CME Cycle Start the same hours count.
  const set = data('PA', [lic('a', 'State Physician Assistant License', 'RI', '2026-12-01', { cmeCycleStart: '2025-12-01' })], d.cme, { primaryState: 'RI' });
  const counted = complianceFor(set, 'RI', 'pa');
  assert.equal(counted.totalEarned, 60);
  assert.equal(counted.totalRequired, 25);
});

// ── "TX PA license" (finding 17) ──
test('requests: "Copy of your TX PA license" keeps Texas; "NM PA-C license" is the New Mexico licence', () => {
  for (const m of [client, server]) {
    assert.equal(m.classifyAsk('Copy of your TX PA license', { degreeType: 'PA' }).state, 'TX');
    assert.equal(m.classifyAsk('PA license (TX)', { degreeType: 'PA' }).state, 'TX');
    assert.equal(m.classifyAsk('TX PA license', { degreeType: 'PA' }).state, 'TX');
    assert.equal(m.classifyAsk('PA license', { degreeType: 'PA' }).state, null, 'still no state when none is named');
    const pac = m.classifyAsk('current NM PA-C license', { degreeType: 'PA' });
    assert.equal(pac.kind, 'state_license');
    assert.equal(pac.state, 'NM');
    assert.equal(m.classifyAsk('NCCPA PA-C certificate', { degreeType: 'PA' }).kind, 'board_cert');
  }
});

// ── Public-record dedupe of an NP's RN and APRN (finding 18) ──
test('public record: an APRN on file does not hide the RN licence sharing its number', () => {
  const findings = [
    { section: 'licenses', fields: { type: 'APRN License (NP)', state: 'CA', licenseNumber: '777' } },
    { section: 'licenses', fields: { type: 'RN License', state: 'CA', licenseNumber: '777' } },
  ];
  const marked = markAlreadyOnFile(findings, { licenses: [{ type: 'APRN License (NP)', state: 'CA', licenseNumber: '777' }] });
  assert.deepEqual(marked.map(f => [f.fields.type, !!f.alreadyOnFile]), [['APRN License (NP)', true], ['RN License', false]]);
  const rnOnFile = markAlreadyOnFile(findings, { licenses: [{ type: 'RN License', state: 'CA', licenseNumber: '777' }] });
  assert.deepEqual(rnOnFile.map(f => !!f.alreadyOnFile), [false, true], 'and the reverse');
});

// ── Ring rows and review links carry the card's kind (finding 19) ──
test('ring rows name the card and carry its kind; review keys are per card', () => {
  const d = data('NP', [lic('a', 'APRN License (NP)', 'TX', '2026-11-30'), lic('r', 'RN License', 'TX', '2026-11-30')]);
  const list = complianceListFor(d);
  const ring = standingScore({ stateComps: list, leadDays: 90 });
  const rn = ring.needsAction.find(n => n.item.kind === 'rn');
  assert.equal(rn.item.title, 'Texas RN license');
  assert.equal(rn.item.ceNoun, 'CE');
  const keys = cmeReviewKeys(list);
  assert.ok([...keys.records, ...keys.confirmation].every(k => /^TX:(aprn|rn)$/.test(k)));
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /reviewCmeState\(item\.state, item\.kind\)/);
  const summary = readFileSync(new URL('../../src/components/shared/CmeReviewSummary.jsx', import.meta.url), 'utf8');
  assert.match(summary, /onReviewState\(st, kind/);
});

// ── "of null required" and "12 / " (finding 20) ──
test('an unverified total never prints "null": the desk subtotal and the math modal check it', () => {
  const desk = readFileSync(new URL('../../src/components/features/CMESection.jsx', import.meta.url), 'utf8');
  assert.match(desk, /comp\.totalRequired == null \? "requirement not yet verified"/);
  assert.match(desk, /if \(comp\.windowKnown === false\) return null;/);
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{!comp\.noGeneralReq && comp\.totalRequired != null && \(/);
  const mt = complianceFor(data('PA', [lic('m', 'State Physician Assistant License', 'MT', '2027-06-30')], [], { primaryState: 'MT' }), 'MT', 'pa');
  assert.equal(mt.totalRequired, null);
  assert.equal(totalHoursLabel(mt), 'Not yet verified');
});

// ── The rule unit in Settings (finding 21) ──
test('getStateReq carries the PA and NP rule unit', () => {
  assert.equal(getStateReq('FL', 'NP', 'aprn').unit, 'contact hours');
  assert.equal(getStateReq('TX', 'PA', 'pa').unit, 'hours');
});

// ── First-send invoices (finding 22) ──
// Every send site spreads invoiceSenderFields; the function-scoped checks
// live in tests/billing/invoice-profession-sender.test.mjs.
test('first-send invoices from the Work Log and Duty Log use the profession\'s services phrase', () => {
  for (const f of ['WorkLog.jsx', 'DutyLog.jsx']) {
    const s = readFileSync(new URL(`../../src/components/features/locum/${f}`, import.meta.url), 'utf8');
    assert.match(s, /\.\.\.invoiceSenderFields\(s\)/, f);
  }
});

// ── Unknown-window topics are listed, not dropped ──
test('recurring topics waiting on a window are listed for the member', () => {
  const comp = complianceFor(data('PA', [lic('a', 'State Physician Assistant License', 'RI', '2026-12-01')], [], { primaryState: 'RI' }), 'RI', 'pa');
  const lines = unverifiedLines(comp);
  for (const t of comp.windowPendingTopics) assert.ok(lines.some(l => l.startsWith(`${t.topic}: counted once the counting period is known`)));
});
