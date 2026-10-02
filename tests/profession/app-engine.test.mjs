// The PA and NP CE engine with injected synthetic rules (DESIGN 3.3). The
// rule data here is invented for the test and never ships: the shipped rule
// data is tested in app-rules-provenance.test.mjs.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, complianceFor, complianceListFor, standingScore, trackedStates, alertingStates, findStateLicense } from '../../src/utils/compliance.js';
import { computeAppCompliance, pharmacologyHoursOf } from '../../src/utils/appCompliance.js';
import { cmeAssessmentLabel, totalHoursLabel, appCardTitle, cmeReviewSummary, cmeReviewKeys } from '../../src/utils/cmePresentation.js';
import { STATE_REQS } from '../../src/constants/stateRequirements.js';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const ruleSet = (over = {}) => ({
  profession: 'pa', kind: 'pa', state: 'ZT', board: 'Synthetic PA Board', boardUrl: 'https://board.example.test/pa', licenseTitle: null,
  status: 'verified', ceMode: 'hours', windowRule: 'license', cycle: 2, total: 40, unit: 'hours',
  cat1min: 20, cat1note: 'formal Category I', cat1Accepted: ['AAPA Category 1 CME'], cat1Unverified: ['AMA PRA Category 1'],
  totalAccepted: null, totalUnverified: null, certificationInLieu: null, certificationRequired: null, practiceHours: null,
  satisfiesRn: false, nlc: null, topics: [], notes: [], source: '22 Synthetic Code 1', sourceUrl: 'https://board.example.test/rule',
  verified: '2026-10', unverified: [], practice: null, prescribing: null, facts: {}, ...over,
});
const rules = (pa = {}, np = {}) => ({ pa: { ZT: ruleSet(pa) }, np: { ZT: { rn: ruleSet({ profession: 'np', kind: 'rn', unit: 'contact hours', ...np.rn }), aprn: ruleSet({ profession: 'np', kind: 'aprn', unit: 'contact hours', ...np.aprn }) } } });
const cme = (category, hours, date, topics = [], customFields) => ({ id: `${category}-${date}-${hours}`, category, hours: String(hours), date, topics, ...(customFields ? { customFields } : {}) });
const EXP = '2027-06-30';
const run = (entries, r, opts = {}) => computeAppCompliance(entries, 'ZT', opts.deg || 'PA', { rules: r, licenseExpiration: EXP, ...opts });

test('hours mode: totals, category minimum by data, unverified credit kept apart', () => {
  const r = rules();
  const comp = run([cme('AAPA Category 1 CME', 22, '2026-01-10'), cme('Category 2 CME', 15, '2026-02-01'), cme('AMA PRA Category 1', 5, '2026-03-01')], r);
  assert.equal(comp.totalRequired, 40);
  assert.equal(comp.totalEarned, 42);
  assert.equal(comp.cat1Earned, 22);
  assert.equal(comp.cat1UnverifiedEarned, 5);
  assert.equal(comp.assessmentStatus, 'met');
  assert.equal(comp.fullyCompliant, true);
  assert.equal(comp.profession, 'pa');
  assert.equal(comp.degreeUnknown, false);
  const short = run([cme('AMA PRA Category 1', 40, '2026-01-10')], r);
  assert.equal(short.cat1Met, false, 'AMA PRA is not yet verified for the minimum, so it never counts toward it');
  assert.equal(short.assessmentStatus, 'needs-hours');
});

test('Other and Non-accredited CE count only where a rule says they do', () => {
  const r = rules({ cat1min: null, cat1Accepted: [] }, { aprn: { cat1min: null, cat1Accepted: [], total: 20 } });
  const comp = run([cme('Other', 40, '2026-01-10')], r);
  assert.equal(comp.totalEarned, 0);
  assert.equal(comp.totalUnverifiedEarned, 40);
  assert.equal(comp.totalMet, false);
  const np = run([cme('Non-accredited CE', 20, '2026-01-10'), cme('Accredited Nursing CE', 5, '2026-02-10')], r, { deg: 'NP', kind: 'aprn' });
  assert.equal(np.totalEarned, 5);
  assert.equal(np.totalUnverifiedEarned, 20);
  const accepted = run([cme('Accredited Nursing CE', 20, '2026-01-10'), cme('AAPA Category 1 CME', 9, '2026-01-12')], rules({}, { aprn: { total: 20, cat1min: null, totalAccepted: ['Accredited Nursing CE'], totalUnverified: ['AAPA Category 1 CME'] } }), { deg: 'NP', kind: 'aprn' });
  assert.equal(accepted.totalEarned, 20);
  assert.equal(accepted.totalUnverifiedEarned, 9);
});

test('unverified mode: no hour target, needs confirmation, board link, no physician fallback', () => {
  const r = rules({ status: 'unverified', ceMode: 'unverified', windowRule: 'unverified', cycle: null, total: null, cat1min: null, unverified: [{ item: 'CE rules', boardUrl: 'https://board.example.test/pa' }] });
  const comp = run([cme('AAPA Category 1 CME', 80, '2026-01-10')], r);
  assert.equal(comp.totalRequired, null);
  assert.equal(comp.rulesVerified, false);
  assert.equal(comp.windowKnown, false);
  assert.equal(comp.totalEarned, 0, 'no invented window, so nothing is counted against a number');
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
  assert.equal(comp.fullyCompliant, false);
  assert.equal(comp.boardUrl, 'https://board.example.test/pa');
  assert.equal(totalHoursLabel(comp), 'Not yet verified');
  assert.match(cmeAssessmentLabel(comp), /rules not yet verified/);
  assert.doesNotMatch(JSON.stringify(comp), /null hrs|NaN|undefined/);
});

test('a member-set cycle start opens a window when the cycle is not verified', () => {
  const r = rules({ ceMode: 'certification', windowRule: 'unverified', cycle: null, total: null, cat1min: null, certificationRequired: { value: true, cite: 'x', url: 'https://board.example.test/c' } });
  const comp = run([cme('AAPA Category 1 CME', 10, '2026-01-10')], r, { cycleStart: '2025-07-01' });
  assert.equal(comp.windowKnown, true);
  assert.equal(comp.windowSource, 'custom');
  assert.equal(comp.totalEarned, 10);
});

test('certification in lieu covers only what it names; topics are still evaluated', () => {
  const topics = [
    { topic: 'Human Trafficking', hours: 0, status: 'verified', note: 'HHSC course', condition: { field: 'Provides direct patient care', question: 'q', description: 'd' } },
    { topic: 'Nutrition', hours: 1, status: 'verified', note: 'nutrition', expiringOnOrAfter: '2027-05-30' },
    { topic: 'Forensic Evidence Collection', hours: 2, status: 'verified', note: 'ER', expiringOnOrAfter: '2027-02-28', condition: { field: 'Treats patients in an emergency room', question: 'q', description: 'd' } },
  ];
  const r = rules({ topics, certificationInLieu: { bodies: ['NCCPA'], bodiesVerified: true, covers: ['total', 'categoryMin'], notForTopics: ['Human Trafficking'], cite: 'x', url: 'https://board.example.test/l' } });
  const certs = [{ body: 'NCCPA', expirationDate: '2027-12-31', alertable: true, recordId: 'c1' }];
  const answers = { 'Provides direct patient care': 'Yes', 'Treats patients in an emergency room': 'Yes' };
  const comp = run([], r, { certifications: certs, licenseAnswers: answers });
  assert.equal(comp.totalMet, true);
  assert.equal(comp.cat1Met, true);
  assert.deepEqual(comp.satisfiedVia, { body: 'NCCPA', recordId: 'c1', expirationDate: '2027-12-31' });
  assert.deepEqual(comp.topicResults.filter(t => !t.met).map(t => t.topic), ['Human Trafficking', 'Nutrition', 'Forensic Evidence Collection']);
  assert.equal(comp.assessmentStatus, 'needs-hours');
  const done = run([cme('Category 2 CME', 1, '2026-02-01', ['Human Trafficking']), cme('Category 2 CME', 1, '2026-02-02', ['Nutrition']), cme('AAPA Category 1 CME', 2, '2026-02-03', ['Forensic Evidence Collection'])], r, { certifications: certs, licenseAnswers: answers });
  assert.equal(done.assessmentStatus, 'met');
  assert.match(cmeAssessmentLabel(done), /^Met through NCCPA certification$/);
  // An expired certification satisfies nothing.
  const expired = run([], r, { certifications: [{ ...certs[0], expirationDate: '2026-09-30' }], licenseAnswers: answers });
  assert.equal(expired.totalMet, false);
});

test('expiringOnOrAfter: applies only to a licence expiring on or after the date; unanchored is unknown', () => {
  const r = rules({ topics: [{ topic: 'Nutrition', hours: 1, status: 'verified', note: 'n', expiringOnOrAfter: '2027-05-30' }] });
  assert.equal(run([], r, { licenseExpiration: '2027-05-29' }).datedTopics[0].applicability, 'not-applicable');
  assert.equal(run([], r, { licenseExpiration: '2027-05-30' }).datedTopics[0].applicability, 'applies');
  const unanchored = computeAppCompliance([], 'ZT', 'PA', { rules: r });
  assert.equal(unanchored.datedTopics[0].applicability, 'unknown');
  assert.equal(unanchored.assessmentStatus, 'needs-confirmation');
  // The question card reads topic.condition; a dated topic with no question
  // never reaches it (it crashed on topic.condition.field).
  assert.equal(unanchored.conditionalTopics.length, 0);
});

test('expiringBefore: a mandate that ends stops applying to licences expiring on or after the end date', () => {
  const r = rules({ topics: [{ topic: 'Opioid Prescribing', hours: 3, status: 'verified', note: 'n', expiringBefore: '2029-01-01' }] });
  assert.equal(run([], r, { licenseExpiration: '2027-10-01' }).datedTopics[0].applicability, 'applies');
  assert.equal(run([], r, { licenseExpiration: '2029-10-01' }).datedTopics[0].applicability, 'not-applicable');
  assert.equal(computeAppCompliance([], 'ZT', 'PA', { rules: r }).datedTopics[0].applicability, 'unknown');
});

test('bodies not verified: the certification may satisfy the hours, never marked met', () => {
  const r = rules({}, { aprn: { total: 20, cat1min: null, cat1Accepted: [], certificationInLieu: { bodies: ['AANPCB'], bodiesVerified: false, covers: ['total'], notForTopics: [] } } });
  const comp = run([], r, { deg: 'NP', kind: 'aprn', certifications: [{ body: 'AANPCB', expirationDate: '2028-01-31', alertable: true, recordId: 'n' }] });
  assert.equal(comp.totalMet, false);
  assert.equal(comp.satisfiedVia.confirm, true);
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
  assert.match(cmeAssessmentLabel(comp), /May be satisfied by your AANPCB certification; not yet verified/);
});

test('additional topics raise the total only when they apply; pharmacology from the entry field, clamped', () => {
  const topics = [
    { topic: 'Pharmacology', hours: 5, status: 'verified', note: 'p', measure: 'pharmacology', additional: true, condition: { field: 'Holds prescriptive authority', question: 'q', description: 'd' } },
    { topic: 'Controlled Substances', hours: 3, status: 'verified', note: 'cs', additional: true, condition: { field: 'Prescribes controlled substances', question: 'q', description: 'd' } },
  ];
  const r = rules({}, { aprn: { total: 20, cat1min: null, cat1Accepted: [], topics } });
  const yes = { 'Holds prescriptive authority': 'Yes', 'Prescribes controlled substances': 'Yes' };
  const entries = [
    cme('Accredited Nursing CE', 20, '2026-01-10', [], { 'Pharmacology Hours': 4 }),
    cme('Accredited Nursing CE', 2, '2026-01-11', ['Pharmacology']),
    cme('Accredited Nursing CE', 3, '2026-01-12', ['Controlled Substances'], { 'Pharmacology Hours': '9' }),
  ];
  const comp = run(entries, r, { deg: 'NP', kind: 'aprn', licenseAnswers: yes });
  assert.equal(comp.totalRequired, 28, '20 + 5 + 3, as the Texas fact states');
  assert.equal(comp.pharmacology.earned, 9, '4 stated + 2 tagged + 3 (9 clamped to the entry\'s 3)');
  assert.equal(comp.topicResults.find(t => t.topic === 'Pharmacology').earned, 9);
  const no = run(entries, r, { deg: 'NP', kind: 'aprn', licenseAnswers: { 'Holds prescriptive authority': 'No', 'Prescribes controlled substances': 'No' } });
  assert.equal(no.totalRequired, 20);
  assert.equal(pharmacologyHoursOf(cme('x', 2, '2026-01-01', [], { 'Pharmacology Hours': 0 })), 0, 'a stated 0 is 0');
  assert.equal(pharmacologyHoursOf(cme('x', 2, '2026-01-01', ['Pharmacology'], { 'Pharmacology Hours': -1 })), 0);
});

test('an unverified topic blocks "met" only when it applies or its applicability is unknown', () => {
  const t = (cond) => ({ topic: 'Opioid Prescribing', hours: null, status: 'unverified', note: 'o', unverifiedItem: 'How often', ...(cond ? { condition: { field: 'Opioid authority', question: 'q', description: 'd' } } : {}) });
  const met = [cme('AAPA Category 1 CME', 40, '2026-01-10')];
  assert.equal(run(met, rules({ topics: [t(true)] }), { licenseAnswers: { 'Opioid authority': 'No' } }).assessmentStatus, 'met');
  assert.equal(run(met, rules({ topics: [t(true)] }), { licenseAnswers: { 'Opioid authority': 'Yes' } }).assessmentStatus, 'needs-confirmation');
  assert.equal(run(met, rules({ topics: [t(true)] })).assessmentStatus, 'needs-confirmation');
  const comp = run(met, rules({ topics: [t(false)] }));
  assert.equal(comp.assessmentStatus, 'needs-confirmation');
  assert.equal(comp.topicResults.length, 0, 'never counted');
  assert.equal(comp.unverifiedTopics[0].unverifiedItem, 'How often');
});

test('certification mode and credential checks; shortBy names the certification, not hours', () => {
  const r = rules({ ceMode: 'certification', total: null, cat1min: null, certificationRequired: { value: true, cite: 'x', url: 'https://board.example.test/c' } });
  const none = run([], r);
  assert.equal(none.noGeneralReq, true);
  assert.equal(none.assessmentStatus, 'needs-hours');
  assert.equal(none.shortBy, 'certification');
  assert.equal(cmeAssessmentLabel(none), 'Needs current NCCPA certification');
  assert.equal(totalHoursLabel(none), 'National certification');
  const ok = run([], r, { certifications: [{ body: 'NCCPA', expirationDate: '2027-12-31', alertable: true }] });
  assert.equal(ok.assessmentStatus, 'met');
});

test('practice hours are a yes/no per renewal, asked again at the next one', () => {
  const r = rules({}, { aprn: { total: 20, cat1min: null, cat1Accepted: [], practiceHours: { hours: 400, years: 2, cite: 'x', url: 'https://board.example.test/p' } } });
  const enough = [cme('Accredited Nursing CE', 20, '2026-01-10')];
  const ask = run(enough, r, { deg: 'NP', kind: 'aprn' });
  assert.equal(ask.assessmentStatus, 'needs-confirmation');
  assert.match(ask.credentialChecks[0].label, /400 practice hours in the 2 years/);
  const ans = (v, forExp) => ({ 'Practice hours this renewal': v, 'Practice hours this renewal (for renewal)': forExp });
  assert.equal(run(enough, r, { deg: 'NP', kind: 'aprn', licenseAnswers: ans('Yes', EXP) }).assessmentStatus, 'met');
  const noAns = run(enough, r, { deg: 'NP', kind: 'aprn', licenseAnswers: ans('No', EXP) });
  assert.equal(noAns.shortBy, 'practiceHours');
  assert.equal(cmeAssessmentLabel(noAns), 'Needs practice hours');
  assert.equal(run(enough, r, { deg: 'NP', kind: 'aprn', licenseAnswers: ans('Yes', '2025-06-30') }).assessmentStatus, 'needs-confirmation', 'an answer for the last renewal is not this one');
});

test('none and options modes', () => {
  const none = run([], rules({ ceMode: 'none', total: 0, cat1min: null, topics: [{ topic: 'Implicit Bias', hours: 3, status: 'verified', note: 'ib' }] }));
  assert.equal(none.noGeneralReq, true);
  assert.equal(none.totalRequired, 0);
  assert.equal(none.assessmentStatus, 'needs-hours');
  const opt = rules({ ceMode: 'options', total: null, cat1min: null, options: [{ text: '50 hours a year', cite: 'x', url: 'https://board.example.test/o' }] });
  assert.equal(run([], opt).assessmentStatus, 'needs-confirmation');
  assert.equal(run([], opt, { licenseAnswers: { 'CE option confirmed for': EXP } }).assessmentStatus, 'met');
  assert.equal(totalHoursLabel(run([], opt)), 'Board CE options');
});

test('calendar-year window and the MATE school exemption', () => {
  const r = rules({ windowRule: 'calendarYears', cycle: 2 });
  const comp = run([cme('AAPA Category 1 CME', 40, '2026-01-01'), cme('AAPA Category 1 CME', 9, '2025-12-31')], r, { licenseExpiration: '2027-01-15' });
  assert.equal(comp.totalEarned, 40, '2026 and 2027 count; 2025 does not');
  const mate = run([], rules(), { hasDEA: true });
  assert.equal(mate.mate.met, false);
  const school = run([], rules(), { hasDEA: true, deaAnswers: { 'MATE: PA or NP program within 5 years with 8+ hours SUD training': 'Yes' } });
  assert.deepEqual(school.mate, { required: 8, earned: 0, met: true, via: 'school' });
  assert.equal(run([], rules(), { hasDEA: true, mateApplies: false }).mate, null);
});

test('physicians never reach the app engine; PA and NP never get a physician rule set', () => {
  const md = computeCompliance([], 'TX', 'MD', {});
  assert.equal(md.profession, undefined);
  assert.equal(md.totalRequired, STATE_REQS.TX.total);
  for (const deg of ['PA', 'NP']) {
    const comp = computeCompliance([], 'TX', deg, {});
    assert.equal(comp.profession, deg === 'PA' ? 'pa' : 'np');
    assert.notEqual(comp.totalRequired, STATE_REQS.TX.total);
    assert.doesNotMatch(comp.source, /Tex\. Admin\. Code tit\. 22, § 161/);
  }
});

const lic = (id, type, state, expirationDate, extra = {}) => ({ id, type, state, licenseNumber: id, expirationDate, ...extra });

test('cards: one PA licence card per state; an NP gets APRN and RN cards anchored on their own licences', () => {
  const pa = { settings: { degreeType: 'PA', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [lic('p1', 'State Physician Assistant License', 'TX', '2027-05-31'), lic('p2', 'State Physician Assistant License', 'NM', '2028-01-31'), lic('m1', 'State Medical License', 'CO', '2027-01-31')] };
  assert.deepEqual(complianceListFor(pa).map(c => c.key), ['TX:pa', 'NM:pa']);
  assert.equal(complianceListFor(pa)[0].lic.id, 'p1');
  assert.deepEqual(trackedStates('TX', [], pa.licenses, 'PA'), ['TX', 'NM']);
  assert.deepEqual(trackedStates('TX', [], pa.licenses, 'MD'), ['TX', 'CO'], 'physicians: the medical licence as before');
  const np = { settings: { degreeType: 'NP', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [
    lic('a1', 'APRN License (NP)', 'TX', '2027-03-31'), lic('r1', 'RN License', 'TX', '2027-09-30'), lic('r2', 'RN License (Multistate)', 'FL', '2028-02-28')] };
  const cards = complianceListFor(np);
  assert.deepEqual(cards.map(c => c.key), ['TX:aprn', 'TX:rn', 'FL:rn']);
  assert.equal(cards[0].comp.windowEnd.getMonth(), 2, 'APRN card anchored on the APRN licence');
  assert.equal(cards[1].comp.windowEnd.getMonth(), 8, 'RN card anchored on the RN licence');
  assert.equal(cards[2].comp.kind, 'rn');
  assert.equal(findStateLicense(np.licenses, 'TX', 'rn').id, 'r1');
  // No RN licence anywhere: an unanchored RN card for the primary state asks for it.
  const noRn = { ...np, licenses: [np.licenses[0]] };
  const c2 = complianceListFor(noRn);
  assert.deepEqual(c2.map(c => c.key), ['TX:aprn', 'TX:rn']);
  assert.equal(c2[1].comp.windowAnchored, false);
  assert.equal(appCardTitle(c2[1].comp), 'Texas RN license');
  assert.equal(appCardTitle(cards[0].comp), 'Texas APRN license');
  assert.equal(appCardTitle(complianceListFor(pa)[0].comp), 'Texas physician assistant license');
});

test('MATE shows on the primary practice card only; physician keys and ring ids are unchanged', () => {
  const np = { settings: { degreeType: 'NP', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [
    lic('a1', 'APRN License (NP)', 'TX', '2026-11-30'), lic('r1', 'RN License', 'TX', '2026-12-15'), lic('d1', 'DEA Registration', 'TX', '2027-01-01')] };
  const cards = complianceListFor(np);
  assert.ok(cards.find(c => c.kind === 'aprn').comp.mate);
  assert.equal(cards.find(c => c.kind === 'rn').comp.mate, null);
  const s = standingScore({ stateComps: cards, leadDays: 90 });
  assert.deepEqual(s.needsAction.map(n => n.item.id).sort(), ['cme:TX:aprn', 'cme:TX:rn']);
  const md = { settings: { degreeType: 'MD', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [lic('m1', 'State Medical License', 'TX', '2026-11-30')] };
  const mdCards = complianceListFor(md);
  assert.deepEqual(mdCards.map(c => [c.key, c.kind]), [['TX', 'medical']]);
  assert.deepEqual(standingScore({ stateComps: mdCards, leadDays: 90 }).needsAction.map(n => n.item), [{ id: 'cme:TX', _sec: 'cme', _cat: 'CME', state: 'TX', needsConfirmation: false }]);
  assert.deepEqual(alertingStates('TX', [], np.licenses, 'NP'), ['TX']);
});

test('review summary: a PA or NP card with unverified rules asks for confirmation, by state, once', () => {
  const np = { settings: { degreeType: 'NP', primaryState: 'TX', additionalStates: [] }, cme: [], licenses: [lic('a1', 'APRN License (NP)', 'TX', '2027-03-31'), lic('r1', 'RN License', 'TX', '2027-09-30')] };
  // Texas APRN and RN hours are verified and 0 of 20 are logged: that gap is
  // listed under records (never hidden behind the open questions), and the
  // state is still listed once under confirmation for what remains unknown.
  assert.deepEqual(cmeReviewSummary(complianceListFor(np)), { records: ['TX'], confirmation: ['TX'] });
  assert.deepEqual(cmeReviewKeys(complianceListFor(np)).confirmation, ['TX:aprn', 'TX:rn'], 'each card by its own key');
});

test('complianceFor(data, state, kind) for an NP reads the kind asked for', () => {
  const np = { settings: { degreeType: 'NP', primaryState: 'TX' }, cme: [], licenses: [lic('r1', 'RN License', 'TX', '2027-09-30')] };
  assert.equal(complianceFor(np, 'TX', 'rn').kind, 'rn');
  assert.equal(complianceFor(np, 'TX').kind, 'aprn', 'the APRN card by default');
});
