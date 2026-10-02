// What a PA or NP sees on the surfaces built on the engine (DESIGN 4, 5.3):
// record questions and agreement facts, card details, the setup agreement
// row, the multi-state matrix, transcripts, share text, the credential
// portal invitation, CME import mapping, scanned
// pharmacology hours, Find CME notes and Vera's category guidance. MD and DO
// output is pinned by md-do-golden.test.mjs; each test here also checks the
// physician side it touches. Synthetic records only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { questionValue, withAnswer, agreementShownFor, unverifiedLines } from '../../src/utils/recordAnswers.js';
import { recordQuestionsFor, QUESTION_FIELDS } from '../../src/constants/recordQuestions.js';
import { agreementFor } from '../../src/utils/ruleResolver.js';
import { buildSetup, TASK_DEFS } from '../../src/utils/setupTasks.js';
import { appMatrixRow, nlcInForce, agreementCell } from '../../src/utils/appMatrix.js';
import { complianceFor } from '../../src/utils/compliance.js';
import { credentialLetter, peerHeadsUp, bundleShareText, referencesShareTitle } from '../../src/utils/shareText.js';
import { documentInvitationText, inviterNoun, sectionHint, ADMIN_ACCESS_SECTIONS } from '../../supabase/functions/_shared/credentialPortalView.mjs';
import { mapCreditType, toCmeEntry, rowsFromTable } from '../../src/utils/cmeImport.js';
import { cmeEntryFromScan } from '../../src/utils/scanShape.js';
import { appProviderLine } from '../../src/utils/appCreditNotes.js';
import { bundle } from './bundle.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const settings = (degreeType, over = {}) => ({ name: 'Pat Example', degreeType, npi: '1234567893', primaryState: 'TX', additionalStates: [], specialties: [], ...over });
const data = (degreeType, licenses = [], cme = [], over = {}) => ({ settings: settings(degreeType, over), licenses, cme, education: [], documents: [], privileges: [] });
const lic = (type, state, over = {}) => ({ id: `${type}:${state}`, type, name: `${state} ${type}`, state, licenseNumber: 'X100', expirationDate: '2027-05-31', ...over });

// ── Record questions and agreement facts ───────────────────────────────────

test('a practice licence in a state whose agreement depends on the clinician asks; the answer is written to the record', () => {
  const me = lic('State Physician Assistant License', 'ME');
  const agreement = agreementShownFor(me, 'PA');
  assert.equal(agreement.conditional, true, 'Maine PA agreements end above verified hours');
  assert.match(agreement.text, /4,000/);
  assert.ok(agreement.cites.every(c => /^https:\/\//.test(c.url)));
  const qs = recordQuestionsFor(me, { degreeType: 'PA', licenses: [me], stateAgreement: agreement });
  const q = qs.find(x => x.field === QUESTION_FIELDS.agreement);
  assert.match(q.question, /in Maine\?$/);
  assert.equal(questionValue(me, q), '');
  const answered = withAnswer(me, q, 'No');
  assert.equal(answered.customFields[QUESTION_FIELDS.agreement], 'No');
  assert.equal(questionValue(answered, q), 'No');
  assert.equal(withAnswer(answered, q, '').customFields[QUESTION_FIELDS.agreement], undefined, 'a blank answer clears it');
});

test('agreement facts: PA and APRN licences and agreement records only; never an RN licence, a physician or a blank member', () => {
  assert.equal(agreementShownFor(lic('State Physician Assistant License', 'TX'), 'PA').conditional, false, 'Texas PA supervision is not conditional');
  assert.ok(agreementShownFor(lic('Practice Agreement', 'TX'), 'NP'), 'an NP agreement record shows the APRN facts');
  assert.equal(agreementShownFor(lic('RN License', 'TX'), 'NP'), null);
  assert.equal(agreementShownFor(lic('State Medical License', 'TX'), 'MD'), null);
  assert.equal(agreementFor('TX', 'MD', 'medical'), null);
  assert.equal(agreementFor('TX', '', 'pa'), null);
  assert.equal(agreementShownFor({ type: 'Practice Agreement' }, 'PA'), null, 'no state, no facts');
});

test('a per-renewal answer is asked again at the next renewal', () => {
  const rec = { id: 'a', type: 'Board Certification (ANCC)', name: 'FNP-BC', expirationDate: '2027-01-31', customFields: { 'Certification role': 'NP certification' } };
  const q = recordQuestionsFor(rec, { degreeType: 'NP', licenses: [rec] }).find(x => x.perRenewal);
  const answered = withAnswer(rec, q, 'Yes');
  assert.equal(questionValue(answered, q), 'Yes');
  assert.equal(questionValue({ ...answered, expirationDate: '2032-01-31' }, q), '', 'renewed: asked again');
});

test('a card lists each not yet verified item once, and none that does not apply', () => {
  const lines = unverifiedLines({
    unverifiedItems: [{ item: 'A' }, { item: 'B' }],
    unverifiedTopics: [{ topic: 'X', unverifiedItem: 'A', applicability: 'unknown' }, { topic: 'Y', applicability: 'not-applicable' }, { topic: 'Z', applicability: 'applies' }],
  });
  assert.deepEqual(lines, ['A', 'B', 'Z requirement']);
});

// ── Setup: practice agreement row ──────────────────────────────────────────

test('setup asks a PA or NP about a practice agreement only where the primary state has a verified fact; No closes it', () => {
  const ids = (d) => buildSetup(d).tasks.map(t => t.id);
  assert.ok(!ids(data('MD', [lic('State Medical License', 'TX')])).includes('agreement'), 'a physician never sees the row');
  assert.ok(!ids(data('', [])).includes('agreement'), 'nor a blank member');
  const tx = buildSetup(data('PA', [lic('State Physician Assistant License', 'TX')]));
  assert.equal(tx.byId.agreement.status, 'pending');
  assert.match(tx.byId.agreement.why, /^Texas: /);
  assert.doesNotMatch(tx.byId.agreement.why, /depends on you/, 'Texas: not conditional');
  const withRecord = buildSetup(data('PA', [lic('State Physician Assistant License', 'TX'), lic('Practice Agreement', 'TX')]));
  assert.equal(withRecord.byId.agreement.status, 'done');

  const maine = (answer) => data('PA', [lic('State Physician Assistant License', 'ME', answer ? { customFields: { [QUESTION_FIELDS.agreement]: answer } } : {})], [], { primaryState: 'ME' });
  assert.match(buildSetup(maine()).byId.agreement.why, /depends on you/);
  assert.equal(buildSetup(maine()).byId.agreement.status, 'pending');
  assert.equal(buildSetup(maine('No')).byId.agreement.status, 'done', 'a Maine PA past 4,000 hours is never told to file one');
  assert.equal(buildSetup(maine('Yes')).byId.agreement.status, 'pending', 'Yes asks for the record');
  assert.ok(TASK_DEFS.find(d => d.id === 'agreement').appliesWhen);
});

// ── Multi-state matrix ─────────────────────────────────────────────────────

test('matrix: an NP multistate RN covers another state only on verified, in-force compact facts for both', () => {
  const rn = lic('RN License (Multistate)', 'TX');
  const np = (st) => appMatrixRow(data('NP', [rn, lic('APRN License (NP)', st)]), st);
  assert.equal(np('FL').rn.via, 'multistate');
  assert.equal(np('FL').rn.home, 'TX');
  assert.equal(np('MA').rn, null, 'Massachusetts: the compact is not in effect');
  assert.equal(np('TX').rn.via, 'own');
  assert.equal(nlcInForce('RI', '2026-12-31'), true);
  assert.equal(nlcInForce('RI', '2027-01-01'), false, 'Rhode Island leaves the compact on its verified date');
  const single = appMatrixRow(data('NP', [lic('RN License', 'TX'), lic('APRN License (NP)', 'FL')]), 'FL');
  assert.equal(single.rn, null, 'a single-state RN licence never covers another state');
});

test('matrix: a conditional agreement is asked or answered, never "required" from the state alone', () => {
  assert.equal(agreementCell('ME', 'PA', 'pa', lic('State Physician Assistant License', 'ME')).status, 'ask');
  assert.equal(agreementCell('ME', 'PA', 'pa', lic('State Physician Assistant License', 'ME', { customFields: { [QUESTION_FIELDS.agreement]: 'No' } })).status, 'no');
  assert.equal(agreementCell('ME', 'PA', 'pa', lic('State Physician Assistant License', 'ME', { customFields: { [QUESTION_FIELDS.agreement]: 'Yes' } })).status, 'yes');
  assert.equal(agreementCell('TX', 'PA', 'pa', null).status, 'required');
  const row = appMatrixRow(data('PA', [lic('State Physician Assistant License', 'TX'), lic('DEA Registration', 'TX')]), 'TX');
  assert.equal(row.practice.type, 'State Physician Assistant License');
  assert.equal(row.dea.type, 'DEA Registration');
  assert.equal(row.comp.profession, 'pa');
  assert.equal(complianceFor(data('PA', [lic('State Physician Assistant License', 'TX')]), 'TX', 'pa').profession, 'pa');
});

// ── Transcripts ────────────────────────────────────────────────────────────

test('transcript: a PA or NP card prints its own licence, role and rows; never "null", a medical license or "Physician"', async () => {
  const t = await bundle('src/utils/cmeTranscriptPdf.js');
  const cme = [{ id: 'c1', title: 'Course', category: 'AAPA Category 1 CME', hours: '10', date: '2026-03-01', topics: [] }];
  const pa = t.stateTranscriptModel(data('PA', [lic('State Physician Assistant License', 'TX')], cme), 'TX', { kind: 'pa' });
  assert.equal(pa.subtitle, 'Texas physician assistant license renewal');
  assert.equal(pa.fileName, 'CME Transcript, Texas PA, Pat Example PA.pdf');
  const rows = t.stateRequirementRows(pa);
  const text = rows.map(r => [r.name, r.rule, r.required, r.earned, r.status || ''].join(' | ')).join('\n');
  assert.doesNotMatch(text, /null|undefined|NaN|State medical board rule/);
  assert.ok(rows.some(r => r.status === 'Not yet verified'), 'the opioid frequency is listed as not yet verified');
  assert.equal(t.memberRoleLabel('PA'), 'Physician Assistant');
  assert.equal(t.memberRoleLabel('NP'), 'Nurse Practitioner');
  assert.equal(t.memberRoleLabel(''), 'Clinician');
  assert.equal(t.memberRoleLabel('MD'), 'Physician');
  assert.match(t.certificateIndexNote({ ...pa, certs: [{ ref: 'C1', doc: { name: 'x' }, mode: 'convert' }] }), /available from the physician assistant on request/);
  assert.match(t.certificateIndexNote({ physician: { degree: 'DO' }, certs: [{ ref: 'C1', doc: { name: 'x' }, mode: 'convert' }] }), /available from the physician on request/);
  const np = t.stateTranscriptModel(data('NP', [lic('RN License', 'TX'), lic('APRN License (NP)', 'TX')], [{ ...cme[0], category: 'Accredited Nursing CE' }]), 'TX', { kind: 'rn' });
  assert.equal(np.error, undefined, np.error);
  {
    assert.equal(np.title, 'CE Transcript');
    assert.equal(np.subtitle, 'Texas RN license renewal');
    assert.equal(np.fileName, 'CE Transcript, Texas RN, Pat Example NP.pdf');
  }
  assert.match(t.stateTranscriptModel(data('PA'), '').error, /your physician assistant license/);
  assert.match(t.stateTranscriptModel(data('MD'), '').error, /a state medical license/);
});

// ── Share text and the credential portal ───────────────────────────────────

test('share text: no-name fallbacks name the chosen profession or none; a PA greets a reference by name', () => {
  assert.match(credentialLetter({ type: 'X' }, 'licenses', settings('PA', { name: '' })), /for the physician assistant below/);
  assert.match(credentialLetter({ type: 'X' }, 'licenses', settings('', { name: '' })), /for the clinician below/);
  assert.match(credentialLetter({ type: 'X' }, 'licenses', settings('MD', { name: '' })), /for the physician below/);
  // With no name the packet title names nobody (release goal2); the body
  // names the chosen profession, or none.
  for (const [deg, noun] of [['NP', 'nurse practitioner'], ['PA', 'physician assistant'], ['', 'clinician'], ['DO', 'physician']]) {
    const b = bundleShareText(settings(deg, { name: '' }), [{ name: 'a' }]);
    assert.equal(b.title, 'Credential packet (1 document)', deg);
    assert.match(b.blurb, new RegExp(`credential packet for the ${noun} \\(NPI`), deg);
  }
  assert.match(referencesShareTitle(settings('PA', { name: '' }), 2), /^Peer references: Clinician /);
  // With no name there is no heads-up to send (release goal2: the screen asks for the name).
  assert.equal(peerHeadsUp(settings('PA', { name: '' }), { name: 'Jordan Smith, MD' }), null);
  const pa = peerHeadsUp(settings('PA'), { name: 'Jordan Smith, MD' });
  assert.match(pa.emailBody, /^Dear Jordan Smith,/);
  assert.doesNotMatch(pa.emailBody + pa.textBody, /Dr\./);
  assert.match(peerHeadsUp(settings('NP'), { name: 'Jordan Smith' }).emailBody, /^Dear Jordan Smith,/);
  assert.match(peerHeadsUp(settings('MD'), { name: 'Jordan Smith, MD' }).emailBody, /^Dear Dr\. Smith,/, 'MD unchanged');
  assert.match(peerHeadsUp(settings(''), { name: 'Jordan Smith' }).emailBody, /^Dear Dr\. Smith,/, 'blank unchanged (Appendix C 5)');
});

test('credential portal: the invitation names the chosen profession; MD and DO read as before', () => {
  assert.match(documentInvitationText({ degreeType: 'MD', link: 'L' }), /^A physician has invited you/);
  assert.match(documentInvitationText({ degreeType: 'DO', link: 'L' }), /^A physician has invited you/);
  assert.match(documentInvitationText({ degreeType: 'PA', link: 'L' }), /^A physician assistant has invited you/);
  assert.match(documentInvitationText({ degreeType: 'NP', link: 'L' }), /^A nurse practitioner has invited you/);
  assert.equal(inviterNoun(''), 'clinician');
  assert.match(documentInvitationText({ degreeType: 'PA', link: 'https://x/credential-access/#invite=t' }), /Open https:\/\/x\/credential-access\/#invite=t\n/);
  const licences = ADMIN_ACCESS_SECTIONS.find(s => s.key === 'licenses');
  assert.equal(sectionHint(licences, 'MD'), licences.hint);
  // No profession chosen: the form offers every profession's types and the
  // server shares them all, so the hint names PA, APRN and RN licences,
  // prescriptive authority and practice agreements as well as medical ones.
  for (const blank of ['', null, undefined]) {
    assert.match(sectionHint(licences, blank), /^Medical, PA, APRN and RN licenses, prescriptive authority, practice agreements, DEA and state controlled substance, /);
    assert.match(sectionHint(licences, blank), /Driver's licenses and ID cards never appear\.$/);
  }
  const cme = ADMIN_ACCESS_SECTIONS.find(s => s.key === 'cme');
  for (const d of ['', 'MD', 'PA', 'NP']) assert.equal(sectionHint(cme, d), cme.hint);
  assert.doesNotMatch(sectionHint(licences, 'PA'), /Medical licenses|boards/);
  assert.doesNotMatch(sectionHint(licences, 'NP'), /Medical licenses|boards/);
  // Each names the records the server now shares for that profession.
  assert.match(sectionHint(licences, 'PA'), /^PA licenses, prescriptive authority, practice agreements, /);
  assert.match(sectionHint(licences, 'NP'), /^APRN and RN licenses, prescriptive authority, practice agreements, /);
  assert.equal(sectionHint(licences, 'DO'), licences.hint);
});

// ── CME import and scanned certificates ────────────────────────────────────

test('import: a PA\'s credit types name the sponsor; an unnamed Category 1 is assumed AAPA and held', () => {
  assert.deepEqual(mapCreditType('AAPA Category 1', 'PA'), { category: 'AAPA Category 1 CME', assumed: false });
  assert.deepEqual(mapCreditType('AMA PRA Category 1 Credit', 'PA'), { category: 'AMA PRA Category 1', assumed: false });
  assert.deepEqual(mapCreditType('Category 1', 'PA'), { category: 'AAPA Category 1 CME', assumed: true });
  assert.deepEqual(mapCreditType('Category 2', 'PA'), { category: 'Category 2 CME', assumed: false });
  assert.deepEqual(mapCreditType('3.0 contact hours (ANCC)', 'PA'), { category: 'Category 2 CME', assumed: false });
  assert.deepEqual(mapCreditType('PANRE-LA', 'PA'), { category: 'NCCPA PANRE-LA (Category 1 Self-Assessment)', assumed: false });
  assert.deepEqual(mapCreditType('AAPA Category 1 Self-Assessment', 'PA'), { category: 'AAPA Category 1 CME', assumed: false, activity: 'Self-Assessment' });
  assert.deepEqual(mapCreditType('Contact hours', 'NP'), { category: 'Accredited Nursing CE', assumed: false });
  assert.deepEqual(mapCreditType('CE', 'NP'), { category: 'Accredited Nursing CE', assumed: true });
  assert.deepEqual(mapCreditType('AMA PRA Category 1', 'NP'), { category: 'AMA PRA Category 1', assumed: false });
  assert.deepEqual(mapCreditType('Joint Accreditation', 'NP'), { category: 'Joint Accreditation CE', assumed: false });
  assert.deepEqual(mapCreditType('Category 1', 'MD'), { category: 'AMA PRA Category 1', assumed: false }, 'MD unchanged');
  const [row] = rowsFromTable([['Date', 'Title', 'Hours', 'Credit Type'], ['2026-03-01', 'Course', '2', 'AAPA Category 1 Self-Assessment']], { date: 0, title: 1, hours: 2, category: 3 }, { deg: 'PA' });
  assert.deepEqual(toCmeEntry(row).customFields, { 'NCCPA Activity': 'Self-Assessment' });
  const [mdRow] = rowsFromTable([['Date', 'Title', 'Hours', 'Credit Type'], ['2026-03-01', 'Course', '2', 'AMA PRA Category 1']], { date: 0, title: 1, hours: 2, category: 3 }, { deg: 'MD' });
  assert.equal('customFields' in toCmeEntry(mdRow), false, 'a physician entry carries no custom field');
});

test('a scanned NP certificate\'s pharmacology hours become a custom field, never a column', () => {
  assert.deepEqual(cmeEntryFromScan({ title: 'T', hours: 3, pharmacologyHours: '1.5' }), { title: 'T', hours: 3, customFields: { 'Pharmacology Hours': '1.5' } });
  assert.deepEqual(cmeEntryFromScan({ title: 'T', pharmacologyHours: 'n/a' }), { title: 'T' });
  const plain = { title: 'T', hours: 3 };
  assert.equal(cmeEntryFromScan(plain), plain);
});

// ── Find CME and Vera ──────────────────────────────────────────────────────

test('Find CME: a provider\'s accreditation is read through the certifier\'s verified rule', () => {
  assert.equal(appProviderLine(['AMA PRA Category 1'], 'PA'), 'NCCPA accepts AMA PRA Category 1 as Category 1.');
  assert.equal(appProviderLine(['AMA PRA Category 1'], 'NP'), 'ANCC accepts AMA PRA Category 1 as formally approved. AANPCB acceptance not yet verified.');
  assert.equal(appProviderLine(['ABIM MOC'], 'PA'), '');
  assert.equal(appProviderLine(['AMA PRA Category 1'], 'MD'), '');
  assert.equal(appProviderLine(['AMA PRA Category 1'], 'PA', { NCCPA: { cat1Accepted: [] } }), '', 'never claimed without the rule');
});

test('Vera: a PA or NP is given their own category guidance; the physician prompt is unchanged', async () => {
  const a = await bundle('src/utils/assistant.js');
  const md = a.systemStaticFor('MD');
  assert.match(md, /Keep AMA PRA and AOA categories distinct/);
  // Blank keeps the physician category guidance; only the surgeon line and
  // the profession rule differ (DESIGN 7.2 expected differences).
  assert.match(a.systemStaticFor(''), /Keep AMA PRA and AOA categories distinct/);
  assert.equal(a.systemStaticFor('DO'), md);
  const pa = a.systemStaticFor('PA');
  assert.doesNotMatch(pa, /Keep AMA PRA and AOA categories distinct/);
  assert.match(pa, /certificationRules\.NCCPA\.cat1Accepted/);
  const np = a.systemStaticFor('NP');
  assert.match(np, /contact hours, with pharmacology hours/);
  assert.doesNotMatch(np, /AOA categories distinct/);
});
