// National certification cards (DESIGN 3.6), against the shipped
// CERTIFICATION_RULES (every number from a verified national fact) and with
// injected rules where a rule is not verified yet. Synthetic records only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { certificationCards } from '../../src/utils/certCompliance.js';
import { CERTIFICATION_RULES } from '../../src/constants/certificationRules.js';
import { boardIdsFromLicenses, computeBoardCompliance, boardComplianceFor } from '../../src/utils/boardCompliance.js';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const cme = (category, hours, date, extra = {}) => ({ id: `${category}-${date}-${hours}`, category, hours: String(hours), date, topics: [], ...extra });
const data = (deg, licenses, entries = []) => ({ settings: { degreeType: deg }, licenses, cme: entries });
const nccpa = (extra = {}) => ({ id: 'c1', type: 'Board Certification (NCCPA)', name: 'PA-C', expirationDate: '2026-12-31', ...extra });

test('the shipped national rules carry the verified numbers', () => {
  assert.equal(CERTIFICATION_RULES.NCCPA.total, 100);
  assert.equal(CERTIFICATION_RULES.NCCPA.cat1Min, 50);
  assert.equal(CERTIFICATION_RULES.NCCPA.saMultiplier, 1.5);
  assert.equal(CERTIFICATION_RULES.AANPCB.total, 100);
  assert.equal(CERTIFICATION_RULES.AANPCB.pharmacology, 25);
  assert.equal(CERTIFICATION_RULES.AANPCB.accepted, null, 'AANPCB accepted CE is not verified: never counted as such');
  assert.equal(CERTIFICATION_RULES.ANCC.total, 75);
  assert.equal(CERTIFICATION_RULES.ANCC.formallyApprovedMin, 60);
  assert.equal(CERTIFICATION_RULES.NCC.ccaCredit, 5);
  assert.equal(CERTIFICATION_RULES.AACN.url, null);
  assert.equal(CERTIFICATION_RULES.AACN.status, 'unverified');
});

test('NCCPA window from the page example: expires 2020, counts May 1 2018 to Dec 31 2020', () => {
  const [card] = certificationCards(data('PA', [nccpa({ expirationDate: '2020-12-31' })]));
  assert.equal(card.windowStart.getFullYear(), 2018);
  assert.equal(card.windowStart.getMonth(), 4);
  assert.equal(card.windowStart.getDate(), 1);
  assert.equal(card.windowEnd.getFullYear(), 2020);
  assert.equal(card.windowEnd.getMonth(), 11);
  assert.equal(card.windowEnd.getDate(), 31);
});

test('NCCPA weighting: self-assessment x 1.5, PANRE-LA 2 counts 3, first 20 PI-CME doubled', () => {
  const entries = [
    cme('AAPA Category 1 CME', 20, '2025-06-01'),
    cme('AMA PRA Category 1', 10, '2025-07-01', { customFields: { 'NCCPA Activity': 'Self-Assessment' } }),
    cme('NCCPA PANRE-LA (Category 1 Self-Assessment)', 2, '2025-08-01'),
    cme('AAPA Category 1 CME', 15, '2025-09-01', { customFields: { 'NCCPA Activity': 'PI-CME' } }),
    cme('AAPA Category 1 CME', 10, '2025-10-01', { customFields: { 'NCCPA Activity': 'PI-CME' } }),
    cme('Category 2 CME', 8, '2025-11-01'),
    cme('AAPA Category 1 CME', 50, '2024-04-30'),
  ];
  const [card] = certificationCards(data('PA', [nccpa()], entries));
  // 20 + 15 + 3 + (15+15) + (10+5) + 8 = 91 NCCPA credits; raw 65; the April 2024 entry is outside the window.
  assert.equal(card.rawEarned, 65);
  assert.equal(card.earned, 91);
  assert.equal(card.cat1Earned, 83);
  assert.equal(card.met, false);
  assert.equal(card.status, 'needs-hours');
  assert.equal(card.unit, 'credits');
  assert.match(card.deadline, /December 31 of the expiration year/);
  const done = certificationCards(data('PA', [nccpa()], [...entries, cme('Category 2 CME', 9, '2026-01-02')]))[0];
  assert.equal(done.met, true);
});

test('NCCPA exam year and the new-certificant note', () => {
  const [card] = certificationCards(data('PA', [nccpa({ customFields: { 'PANRE or PANRE-LA due year': '2030' } })]));
  assert.equal(card.exam, 'Pass PANRE or PANRE-LA by Dec 31, 2030');
  assert.equal(certificationCards(data('PA', [nccpa()]))[0].exam, 'Add the year your exam is due');
  const fresh = certificationCards(data('PA', [nccpa({ issuedDate: '2025-08-15' })]))[0];
  assert.equal(fresh.windowStart.getFullYear(), 2025, 'the issue year is the literal rule');
  assert.ok(fresh.lines.some(l => /New certificants count CME from their issue date/.test(l)));
});

test('a CAQ record gets no NCCPA card; an unanswered second NCCPA record asks its role', () => {
  const caq = { id: 'c2', type: 'Board Certification (NCCPA)', name: 'CAQ EM', expirationDate: '2030-12-31', customFields: { 'Certification role': 'CAQ or other' } };
  const cards = certificationCards(data('PA', [nccpa(), caq]));
  assert.equal(cards.filter(c => !c.needsRole).length, 0, 'with two NCCPA records the PA-C is asked too');
  assert.equal(cards.filter(c => c.needsRole).length, 1);
  const answered = certificationCards(data('PA', [nccpa({ customFields: { 'Certification role': 'PA-C' } }), caq]));
  assert.deepEqual(answered.map(c => c.body), ['NCCPA']);
  assert.equal(answered[0].recordId, 'c1');
});

test('AANPCB: hours shown, never claimed met while accepted CE is not verified; exam route by letters', () => {
  const rec = { id: 'n1', type: 'Board Certification (AANPCB)', name: 'FNP-C', expirationDate: '2028-06-30', customFields: { '1,000 practice hours in this certification period': 'Yes', '1,000 practice hours in this certification period (for renewal)': '2028-06-30' } };
  const entries = [cme('Accredited Nursing CE', 80, '2025-01-01', { customFields: { 'Pharmacology Hours': 25 } }), cme('Joint Accreditation CE', 20, '2026-01-01'), cme('AMA PRA Category 1', 10, '2026-02-01')];
  const [card] = certificationCards(data('NP', [rec], entries));
  assert.equal(card.earned, 100);
  assert.equal(card.pharmacology.earned, 25);
  assert.equal(card.met, false);
  assert.equal(card.status, 'needs-confirmation');
  assert.ok(card.lines.some(l => /10 hours of AMA PRA or AAPA Category 1 may count; not yet verified for AANPCB/.test(l)));
  const exam = certificationCards(data('NP', [{ ...rec, customFields: { 'Renewal route': 'Exam' } }]))[0];
  assert.equal(exam.route, 'Exam');
  const npc = certificationCards(data('NP', [{ ...rec, name: 'NP-C', customFields: { 'Renewal route': 'Exam' } }]))[0];
  assert.equal(npc.route, 'CE and practice hours', 'ANP and GNP renew by CE only');
  // With the accepted list verified (an addition), the same record is met.
  const verified = { ...CERTIFICATION_RULES, AANPCB: { ...CERTIFICATION_RULES.AANPCB, accepted: ['Accredited Nursing CE', 'Joint Accreditation CE'] } };
  assert.equal(certificationCards(data('NP', [rec], entries), { rules: verified })[0].met, true);
});

test('ANCC 75 / 25 / 60, AAPA toward the 75 only, and the 2027 notice', () => {
  const rec = { id: 'a1', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2027-03-31', customFields: { 'Certification role': 'NP certification',
    'Professional development category completed': 'Yes', 'Professional development category completed (for renewal)': '2027-03-31' } };
  const entries = [cme('Accredited Nursing CE', 55, '2024-01-01', { customFields: { 'Pharmacology Hours': 25 } }), cme('AAPA Category 1 CME', 20, '2025-01-01')];
  const [card] = certificationCards(data('NP', [rec], entries));
  assert.equal(card.earned, 75);
  assert.equal(card.formallyApproved.earned, 55);
  assert.equal(card.met, false, '55 formally approved is under 60');
  assert.ok(card.lines.some(l => /February 1, 2027/.test(l)));
  const ok = certificationCards(data('NP', [rec], [...entries, cme('AMA PRA Category 1', 5, '2025-02-01')]))[0];
  assert.equal(ok.met, true);
  const role = certificationCards(data('NP', [{ ...rec, customFields: {} }]));
  assert.equal(role[0].needsRole, true, 'ANCC also certifies RN specialties: ask');
});

test('PNCB never claims compliance; NCC needs the CCA date and plan, credits the CCA once, never ACLS or BLS', () => {
  const pncb = certificationCards(data('NP', [{ id: 'p', type: 'Board Certification (PNCB)', name: 'CPNP-PC', expirationDate: '2027-02-28' }]))[0];
  assert.equal(pncb.status, 'needs-confirmation');
  assert.equal(pncb.required, null);
  const ncc = { id: 'w', type: 'Board Certification (NCC)', name: 'WHNP-BC', expirationDate: '2028-05-31' };
  assert.equal(certificationCards(data('NP', [ncc]))[0].status, 'needs-confirmation');
  const answered = { ...ncc, customFields: { 'CCA completed on': '2025-06-01', 'Education plan total hours': '30' } };
  const entries = [cme('Accredited Nursing CE', 20, '2025-07-01'), cme('Accredited Nursing CE', 8, '2025-08-01', { title: 'ACLS renewal' }), cme('Accredited Nursing CE', 4, '2025-05-01')];
  const card = certificationCards(data('NP', [answered], entries))[0];
  assert.equal(card.earned, 25, '20 after the CCA plus the CCA\'s 5; ACLS and pre-CCA hours never count');
  assert.equal(card.required, 30);
  assert.equal(card.met, false);
});

test('AACN: no numbers, no link; physicians get no certification cards', () => {
  const [card] = certificationCards(data('NP', [{ id: 'x', type: 'Board Certification (AACN)', name: 'ACNPC-AG', expirationDate: '2028-01-31', customFields: { 'Certification role': 'NP certification' } }]));
  assert.equal(card.url, null);
  assert.equal(card.required, null);
  assert.match(card.assessment, /AACN renewal rules not yet verified/);
  assert.deepEqual(certificationCards(data('MD', [nccpa()])), []);
  assert.deepEqual(certificationCards(data('', [nccpa()])), []);
});

test('physician boards never read NCCPA or NP records, NUCC specialties, or a PA or NP member', () => {
  const recs = [{ type: 'Board Certification (NCCPA)', name: 'PA-C, CAQ Emergency Medicine' }, { type: 'Board Certification (ANCC)', name: 'Family' }];
  assert.deepEqual(boardIdsFromLicenses(recs), []);
  assert.deepEqual(computeBoardCompliance({ settings: { specialties: ['NUCC:363LF0000X:Family Nurse Practitioner'] }, cme: [] }), []);
  assert.deepEqual(boardComplianceFor({ settings: { degreeType: 'PA', specialties: ['ABMS:EM'] }, licenses: [], cme: [] }), []);
});
