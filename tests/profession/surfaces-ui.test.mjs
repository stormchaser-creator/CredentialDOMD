// The PA and NP screens through the component harness (DESIGN 4.2 to 4.5):
// record questions and agreement facts on a licence, the card details and
// their answers, the profession review card, and the CME page. Physician
// records render nothing new. Synthetic records only.
import '../helpers/app-rules.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';
import { complianceFor } from '../../src/utils/compliance.js';
import { QUESTION_FIELDS, forRenewalField } from '../../src/constants/recordQuestions.js';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const src = rel => new URL(`../../src/${rel}`, import.meta.url).href;
const lic = (type, state, over = {}) => ({ id: `${type}:${state}`, type, name: `${state} ${type}`, state, licenseNumber: 'X100', expirationDate: '2027-05-31', ...over });
const data = (degreeType, licenses = [], cme = [], over = {}) => ({
  settings: { name: 'Pat Example', degreeType, primaryState: 'TX', additionalStates: [], specialties: [], ...over },
  licenses, cme, education: [], documents: [], privileges: [],
});
const app = (d, edits) => ({ data: d, editItem: (section, item) => { edits.push([section, item]); return true; }, theme: {} });
const PHYSICIAN_WORD = /\bphysician\b(?! (?:assistant|associate))/i;

async function mount(file, d, edits, props, modules = {}) {
  return mountComponent(file, { app: app(d, edits), props, modules: {
    recordQuestions: await import(src('constants/recordQuestions.js')),
    professions: await import(src('constants/professions.js')),
    recordAnswers: await import(src('utils/recordAnswers.js')),
    professionReview: await import(src('utils/professionReview.js')),
    ...modules,
  } });
}

test('a Maine PA licence shows the verified agreement text and asks; the answer is saved on the licence', async () => {
  const me = lic('State Physician Assistant License', 'ME');
  const edits = [];
  const c = await mount('src/components/shared/RecordQuestions.jsx', data('PA', [me], [], { primaryState: 'ME' }), edits, { item: me });
  const text = c.pageText();
  assert.match(text, /^Maine: /);
  assert.match(text, /4,000/);
  const select = c.nodes().find(n => n.type === 'select' && /practice agreement in Maine\?$/.test(n.props['aria-label']));
  select.props.onChange({ target: { value: 'No' } });
  assert.equal(edits.length, 1);
  assert.equal(edits[0][0], 'licenses');
  assert.equal(edits[0][1].customFields[QUESTION_FIELDS.agreement], 'No');
  assert.ok(c.nodes().filter(n => n.type === 'a').every(a => /^https:\/\//.test(a.props.href)), 'every citation links out');
});

test('a certification whose role is uncertain asks what it is; a physician record shows nothing', async () => {
  const ancc = { id: 'a1', type: 'Board Certification (ANCC)', name: 'Certificate', expirationDate: '2028-01-31' };
  const edits = [];
  const c = await mount('src/components/shared/RecordQuestions.jsx', data('NP', [ancc]), edits, { item: ancc });
  const select = c.nodes().find(n => n.type === 'select' && n.props['aria-label'] === 'What is this certification?');
  assert.deepEqual(select.props.value, '', 'never assumed: ANCC also certifies RN specialties');
  select.props.onChange({ target: { value: 'RN specialty' } });
  assert.equal(edits[0][1].customFields['Certification role'], 'RN specialty');
  const md = await mount('src/components/shared/RecordQuestions.jsx', data('MD', [lic('State Medical License', 'TX')]), [], { item: lic('State Medical License', 'TX') });
  assert.equal(md.render(), null);
});

test('card details: an Arizona APRN card asks about practice hours for this renewal and saves the answer', async () => {
  const aprn = lic('APRN License (NP)', 'AZ');
  const d = data('NP', [aprn, lic('RN License', 'AZ')], [], { primaryState: 'AZ' });
  const comp = complianceFor(d, 'AZ', 'aprn');
  assert.ok(comp.practiceHours, 'Arizona APRN carries a verified practice hours rule');
  const edits = [];
  const c = await mount('src/components/shared/AppCardDetails.jsx', d, edits, { comp, lic: aprn });
  const select = c.nodes().find(n => n.type === 'select' && /^Practice hours for the renewal due 2027-05-31$/.test(n.props['aria-label']));
  select.props.onChange({ target: { value: 'Yes' } });
  const saved = edits[0][1].customFields;
  assert.equal(saved[QUESTION_FIELDS.practiceHours], 'Yes');
  assert.equal(saved[forRenewalField(QUESTION_FIELDS.practiceHours)], '2027-05-31');
  const after = complianceFor({ ...d, licenses: [edits[0][1], d.licenses[1]] }, 'AZ', 'aprn');
  assert.equal(after.practiceHours.met, true, 'the engine reads the saved answer');
  assert.doesNotMatch(c.pageText(), /null|undefined|NaN/);
});

test('card details: a Kansas PA confirms which CE option it met for this renewal', async () => {
  const ks = lic('State Physician Assistant License', 'KS');
  const d = data('PA', [ks], [], { primaryState: 'KS' });
  const comp = complianceFor(d, 'KS', 'pa');
  assert.equal(comp.ceMode, 'options');
  const edits = [];
  const c = await mount('src/components/shared/AppCardDetails.jsx', d, edits, { comp, lic: ks });
  assert.match(c.pageText(), /The board accepts any one of these each renewal/);
  const box = c.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
  box.props.onChange({ target: { checked: true } });
  assert.equal(edits[0][1].customFields[QUESTION_FIELDS.ceOption], '2027-05-31');
  assert.equal(complianceFor({ ...d, licenses: [edits[0][1]] }, 'KS', 'pa').options.confirmed, true);
});

test('card details render nothing on a physician card', async () => {
  const d = data('MD', [lic('State Medical License', 'TX')]);
  const c = await mount('src/components/shared/AppCardDetails.jsx', d, [], { comp: complianceFor(d, 'TX'), lic: d.licenses[0] });
  assert.equal(c.render(), null);
});

test('profession review: a PA\'s medical licence is offered the PA licence type, or kept as it is', async () => {
  const med = lic('State Medical License', 'TX');
  const edits = [];
  const c = await mount('src/components/shared/ProfessionReviewCard.jsx', data('PA', [med]), edits, {});
  assert.match(c.pageText(), /Filed as a medical license/);
  const select = c.nodes().find(n => n.type === 'select');
  select.props.onChange({ target: { value: 'State Physician Assistant License' } });
  assert.equal(edits[0][1].type, 'State Physician Assistant License');
  c.nodes().find(n => n.type === 'button' && c.text(n) === 'Keep as is').props.onClick();
  assert.equal(edits[1][1].customFields['Profession review'], 'kept');
  const md = await mount('src/components/shared/ProfessionReviewCard.jsx', data('MD', [med]), [], {});
  assert.equal(md.render(), null);
});

// The CME form's field labels (Field is a stub here, so its label is a prop).
const labels = (c) => c.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'Field').map(n => n.props.label);

async function cmePage(d) {
  const appCtx = { data: d, addItem: () => true, editItem: () => true, deleteItem() {}, theme: {}, allTrackedStates: [d.settings.primaryState], navigate() {}, isDesktop: true, toggleFavorite() {} };
  return mountComponent('src/components/features/CMESection.jsx', { app: appCtx, props: { onShare() {} }, modules: {
    useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
    forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
    credentialTypes: await import(src('constants/credentialTypes.js')),
    cmeTopics: await import(src('constants/cmeTopics.js')),
    stateRequirements: await import(src('constants/stateRequirements.js')),
    boardRequirements: await import(src('constants/boardRequirements.js')),
    states: await import(src('constants/states.js')),
    professions: await import(src('constants/professions.js')),
    ruleResolver: await import(src('utils/ruleResolver.js')),
    compliance: await import(src('utils/compliance.js')),
    cmePresentation: await import(src('utils/cmePresentation.js')),
    boardCompliance: await import(src('utils/boardCompliance.js')),
    certCompliance: await import(src('utils/certCompliance.js')),
    useInputStyle: { useInputStyle: () => ({}) },
  } });
}

test('CME page: an NP sees an APRN and an RN card with their own titles, contact hours and no CME Passport', async () => {
  const d = data('NP', [lic('APRN License (NP)', 'TX'), lic('RN License', 'TX')], [{ id: 'c1', title: 'Course', category: 'Accredited Nursing CE', hours: '5', date: '2026-02-01', topics: [] }]);
  const c = await cmePage(d);
  const text = c.pageText();
  assert.match(text, /Texas APRN license/);
  assert.match(text, /Texas RN license/);
  assert.doesNotMatch(text, /null-year|undefined|NaN|MD or DO/);
  assert.doesNotMatch(text, PHYSICIAN_WORD);
  assert.match(text, /One PDF per renewal: your details and the license, /);
  assert.ok(!c.nodes().some(n => typeof n.type === 'function' && n.type.name === 'CmePassportPanel'), 'the CME Passport panel is hidden');
  const form = labels(c);
  assert.ok(form.includes('Contact Hours'));
  assert.ok(form.includes('Pharmacology Hours'));
  assert.ok(!form.includes('NCCPA Activity'));
});

test('CME page: a PA logs the NCCPA activity type; an MD page is as before', async () => {
  const pa = await cmePage(data('PA', [lic('State Physician Assistant License', 'TX')]));
  assert.match(pa.pageText(), /Texas physician assistant license/);
  assert.ok(labels(pa).includes('NCCPA Activity'));
  // Georgia and Ohio PA pharmacology mandates count part of an entry (review finding 8).
  assert.ok(labels(pa).includes('Pharmacology Hours'));
  const md = await cmePage(data('MD', [lic('State Medical License', 'TX')]));
  assert.ok(md.nodes().some(n => typeof n.type === 'function' && n.type.name === 'CmePassportPanel'), 'an MD keeps the CME Passport panel');
  assert.ok(labels(md).includes('Hours'));
  assert.ok(!labels(md).some(l => /NCCPA Activity|Pharmacology Hours|Contact Hours/.test(l)));
  assert.match(md.pageText(), /One PDF per renewal: physician and license details/);
});

test('Category 1 box: a Texas PA reads what counts and which Category 1 types are not yet verified there', async () => {
  const d = data('PA', [lic('State Physician Assistant License', 'TX')], [{ id: 'c', title: 'Course', category: 'AMA PRA Category 1', hours: '5', date: '2026-02-01', topics: [] }]);
  const comp = complianceFor(d, 'TX', 'pa');
  const c = await mountComponent('src/components/shared/Cat1Bucket.jsx', { app: { theme: {}, isDesktop: false }, props: { comp, entries: d.cme, degreeType: 'PA' }, modules: {
    creditEquivalence: await import(src('constants/creditEquivalence.js')),
    states: await import(src('constants/states.js')),
  } });
  const text = c.pageText();
  assert.match(text, /Counts here: AAPA Category 1 CME\./);
  assert.match(text, /Not yet verified for Texas: AMA PRA Category 1, AOA Category 1-A, AAFP Prescribed Credit, NCCPA PANRE-LA \(Category 1 Self-Assessment\)\./);
  const md = data('MD', [lic('State Medical License', 'CA')]);
  const mdc = await mountComponent('src/components/shared/Cat1Bucket.jsx', { app: { theme: {}, isDesktop: false }, props: { comp: complianceFor(md, 'CA'), entries: [], degreeType: 'MD' }, modules: {
    creditEquivalence: await import(src('constants/creditEquivalence.js')),
    states: await import(src('constants/states.js')),
  } });
  assert.doesNotMatch(mdc.pageText(), /Not yet verified/);
});
