// Choosing a profession (DESIGN 1.8): Settings and Setup offer MD, DO, PA and
// NP, a blank member's CME card offers all four, switching a chosen
// profession asks first, an NPPES lookup never overwrites a chosen PA or NP,
// and the licence form and record questions follow the profession's types.
// The real components through the component harness; synthetic records only.
import '../helpers/app-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountComponent } from '../component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../../src/constants/defaults.js';
import { DEGREES, DEGREE_LABELS, degreeAfterNppes } from '../../src/constants/professions.js';
import { licenseFields } from '../../src/utils/credentialForms.js';
import { isNonExpiring } from '../../src/utils/helpers.js';
import { dateUnknownApplies } from '../../src/utils/lifecycle.js';
import { recordQuestionsFor, answerForRenewal, renewalAnswerPatch, QUESTION_FIELDS } from '../../src/constants/recordQuestions.js';
import { normalizeCvSections } from '../../src/utils/cvImport.js';
import { bundle } from './bundle.mjs';

const { CV_PROMPT } = await bundle('src/utils/cvScan.js');

const src = rel => new URL(`../../src/${rel}`, import.meta.url).href;
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });
const settingsModules = async () => ({
  states: await import(src('constants/states.js')),
  contactFormat: await import(src('utils/contactFormat.js')),
  cmePassport: await import(src('utils/cmePassport.js')),
  stateRequirements: await import(src('constants/stateRequirements.js')),
  boardRequirements: await import(src('constants/boardRequirements.js')),
  membershipCopy: await import(src('content/membershipCopy.js')),
  reminderPreferences: await import(src('utils/reminderPreferences.js')),
  forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
  compliance: await import(src('utils/compliance.js')),
  professions: await import(src('constants/professions.js')),
  // The real loader: the PA and NP data is installed (helpers/app-rules.mjs), so a choice saves at once.
  appRules: await import(src('utils/appRules.js')),
  useInputStyle: { useInputStyle: () => ({}) },
  useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
  aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
  cptCoder: { CODER_MODELS: [] },
  deskKeys: { DESK_KEYS: [] },
});

async function settings(over = {}) {
  const saved = [];
  const app = {
    data: { ...DEFAULT_DATA, licenses: [], settings: { ...DEFAULT_SETTINGS, primaryState: 'TX', ...over } },
    updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); app.data = { ...app.data, settings: { ...app.data.settings, ...u } }; return true; },
    theme: T, allTrackedStates: [over.primaryState || 'TX'], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false,
  };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules: await settingsModules() });
  const buttons = () => c.nodes().filter(n => n.type === 'button');
  const button = re => buttons().find(b => re.test(c.text(b)));
  return { c, app, saved, buttons, button };
}

test('the pickers spell out exactly the four professions the model knows', () => {
  const settingsSrc = readFileSync(new URL('../../src/components/pages/SettingsSection.jsx', import.meta.url), 'utf8');
  const listed = [...settingsSrc.matchAll(/^\s*\["(MD|DO|PA|NP)", "([^"]+)"\],$/gm)].map(m => [m[1], m[2]]);
  assert.deepEqual(listed, DEGREES.map(d => [d, DEGREE_LABELS[d]]));
  const setupSrc = readFileSync(new URL('../../src/components/features/SetupPage.jsx', import.meta.url), 'utf8');
  assert.match(setupSrc, /\[\["MD", "MD"\], \["DO", "DO"\], \["PA", "PA"\], \["NP", "NP"\]\]/);
  assert.doesNotMatch(settingsSrc + setupSrc, /\["MD", "DO"\]\.map/);
});

test('Settings: a blank member picks PA in one tap, from the profile or the CME card', async () => {
  const s = await settings({ degreeType: '' });
  const text = s.c.pageText();
  assert.match(text, /Pick your profession so state rules, license types and certification lists match it\./);
  for (const d of DEGREES) assert.ok(s.buttons().some(b => s.c.text(b).startsWith(d) && s.c.text(b).includes(DEGREE_LABELS[d])), d);
  assert.match(text, /Which profession\?/);
  for (const label of ['I am an MD', 'I am a DO', 'I am a PA', 'I am an NP']) assert.ok(s.button(new RegExp(`^${label}$`)), label);
  assert.doesNotMatch(text, /Which degree do you hold\?|Several states run separate MD and DO boards/);
  s.button(/^I am a PA$/).props.onClick();
  assert.deepEqual(s.saved, [{ degreeType: 'PA' }]);
});

test('Settings: switching a chosen profession asks first and keeps the records', async () => {
  const s = await settings({ degreeType: 'MD' });
  s.button(/^NPNurse Practitioner$/).props.onClick();
  assert.deepEqual(s.saved, [], 'nothing changes on the first tap');
  s.c.render();
  assert.match(s.c.pageText(), /Switching to Nurse Practitioner \(NP\) changes which state rules, license types and CE categories apply\. Your records stay as they are\./);
  s.button(/^Keep MD$/).props.onClick();
  s.c.render();
  assert.deepEqual(s.saved, []);
  assert.doesNotMatch(s.c.pageText(), /Switching to/);
  s.button(/^PAPhysician Assistant$/).props.onClick();
  s.c.render();
  s.button(/^Switch to PA$/).props.onClick();
  assert.deepEqual(s.saved, [{ degreeType: 'PA' }]);
});

test('Settings: MD to DO stays one tap, and the confirm sheet names CME for a PA (review finding 2)', async () => {
  const md = await settings({ degreeType: 'MD' });
  md.button(/^DODoctor of Osteopathic Medicine$/).props.onClick();
  assert.deepEqual(md.saved, [{ degreeType: 'DO' }], 'within the physician profession: no confirm step');
  md.c.render();
  assert.doesNotMatch(md.c.pageText(), /Switching to/);
  const np = await settings({ degreeType: 'NP' });
  np.button(/^PAPhysician Assistant$/).props.onClick();
  np.c.render();
  assert.match(np.c.pageText(), /Switching to Physician Assistant \(PA\) changes which state rules, license types and CME categories apply\./);
});

test('Settings, blank profession: Licensed States marks the physician figure provisional and asks for the profession, never "MD or DO"', async () => {
  const tx = (await settings({ degreeType: '', primaryState: 'TX' })).c.pageText();
  assert.match(tx, /Physician rule, provisional: 48 hrs \/ 2-yr cycle\. Choose your profession above to see your own rules\./);
  for (const st of ['FL', 'CA']) {
    const text = (await settings({ degreeType: '', primaryState: st })).c.pageText();
    assert.match(text, /Choose your profession above to see this state's rules\./, st);
    assert.doesNotMatch(text, /Separate MD and DO boards|Set your degree above/, st);
  }
  // A physician's row is unchanged.
  const md = (await settings({ degreeType: 'MD', primaryState: 'TX' })).c.pageText();
  assert.match(md, /TX(Primary)?48 hrs \/ 2-yr cycle/);
  assert.doesNotMatch(md, /provisional/);
});

test('Settings: an NP reads contact hours in the rule summary (review finding 21)', async () => {
  const np = await settings({ degreeType: 'NP', primaryState: 'FL' });
  assert.match(np.c.pageText(), /\d+ contact hours \/ 2-yr cycle/);
  assert.doesNotMatch(np.c.pageText(), /\d+ hrs \/ 2-yr cycle/);
});

test('Settings for a PA and an NP: no physician board list, a NUCC specialty instead, and no "Physician Profile"', async () => {
  // The picker is a child component (no hooks): render it with its props.
  const picker = (h) => {
    const el = h.c.nodes().find(n => typeof n.type === 'function' && n.type.name === 'NuccSpecialtyPicker');
    assert.ok(el, 'NUCC picker present');
    const tree = el.type(el.props);
    const buttons = h.c.nodes(tree).filter(n => n.type === 'button');
    return { el, buttons, find: re => buttons.find(b => re.test(h.c.text(b))) };
  };
  const pa = await settings({ degreeType: 'PA' });
  assert.doesNotMatch(pa.c.pageText(), /Physician Profile|Board Specialties/);
  assert.equal(pa.c.nodes().some(n => typeof n.type === 'function' && n.type.name === 'SpecialtyPicker'), false, 'no ABMS/AOA board list');
  const paPick = picker(pa);
  assert.deepEqual(paPick.buttons.map(b => pa.c.text(b)), ['Medical Physician Assistant', 'Surgical Physician Assistant']);
  paPick.find(/^Surgical Physician Assistant$/).props.onClick();
  assert.deepEqual(pa.saved, [{ specialties: ['NUCC:363AS0400X:Surgical Physician Assistant'] }]);
  const np = await settings({ degreeType: 'NP' });
  assert.ok(np.c.nodes().some(n => n.props?.label === 'Population focus'), 'NP field is Population focus');
  assert.ok(pa.c.nodes().some(n => n.props?.label === 'Specialty'));
  assert.ok(pa.c.nodes().some(n => n.props?.label === 'Profession'));
  assert.match(np.c.pageText(), /CE Requirements \(NP\)/);
  assert.ok(picker(np).find(/^Family Nurse Practitioner$/));
  // The Licensed States tile and the CE Requirements card read the PA and NP
  // rule sets: board link and "not yet verified", never Texas physician rules.
  const reqText = (h) => {
    const el = h.c.nodes().find(n => typeof n.type === 'function' && n.type.name === 'AppRequirements');
    assert.ok(el, 'the PA and NP requirements card renders');
    return h.c.text(el.type(el.props));
  };
  for (const h of [pa, np]) {
    const text = h.c.pageText() + reqText(h);
    assert.doesNotMatch(text, /48 hours|48 hrs|all physicians|null|NaN|undefined|State medical board rule|No general CME hour requirement|Separate MD and DO boards/);
  }
  // Texas PA: the verified 40 hours every 2 years (22 TAC 183.16), never the
  // Texas physician 48.
  assert.match(pa.c.pageText(), /40 hours \/ 2-yr cycle/, 'the rule set\'s own unit (review finding 21)');
  assert.match(reqText(pa), /Texas physician assistant license/);
  assert.match(reqText(np), /Texas APRN license.*Texas RN license/);
  // A rule set with nothing verified still says so, with the board link.
  for (const h of [await settings({ degreeType: 'PA', primaryState: 'MT' }), await settings({ degreeType: 'NP', primaryState: 'NY' })]) {
    const text = h.c.pageText() + reqText(h);
    assert.match(text, /Rules not yet verified\. The board link has them\./);
    assert.doesNotMatch(text, /null|NaN|undefined|State medical board rule|No general CME hour requirement/);
  }
  const md = await settings({ degreeType: 'MD' });
  assert.match(md.c.pageText(), /Physician Profile/);
  assert.ok(md.c.nodes().some(n => n.props?.label === 'Board Specialties'));
  assert.ok(md.c.nodes().some(n => n.props?.label === 'Degree'), 'an MD keeps the Degree label');
  assert.match(md.c.pageText(), /CME Requirements \(MD\)/);
});

test('Setup About you offers four chips; tapping NP saves it', async () => {
  const saved = [];
  const app = { data: { settings: { name: 'Nora Example', degreeType: '', primaryState: '' } }, user: { fullName: '' }, theme: {},
    updateSettings: u => { saved.push(u); return true; } };
  const c = await mountComponent('src/components/features/SetupPage.jsx', { app, exportName: 'IdentityDrawer', modules: {
    reminderPreferences: await import(src('utils/reminderPreferences.js')), contactFormat: await import(src('utils/contactFormat.js')),
    useInputStyle: { useInputStyle: () => ({}) }, states: await import(src('constants/states.js')), appRules: await import(src('utils/appRules.js')),
  } });
  const chips = c.nodes().filter(n => n.type === 'button' && /^(MD|DO|PA|NP)$/.test(c.text(n)));
  assert.deepEqual(chips.map(b => c.text(b)), ['MD', 'DO', 'PA', 'NP']);
  chips[3].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ degreeType: 'NP' }]);
  assert.match(c.pageText(), /Profession/);
});

const reg = (credential, codes) => ({ credential, taxonomies: codes.map((code, i) => ({ code, isPrimary: i === 0 })) });

test('an NPPES lookup fills a blank profession and never replaces a chosen PA or NP', () => {
  assert.deepEqual(degreeAfterNppes('', reg('PA-C', ['363A00000X'])), { degree: 'PA', finding: null });
  assert.deepEqual(degreeAfterNppes('', reg('FNP-BC', ['363LF0000X']), { site: 'setup' }), { degree: 'NP', finding: null });
  assert.deepEqual(degreeAfterNppes('PA', reg('MD', ['207T00000X'])), { degree: null, finding: { kind: 'differs', registry: 'MD', chosen: 'PA' } });
  assert.deepEqual(degreeAfterNppes('NP', reg('PA-C', ['363A00000X'])), { degree: null, finding: { kind: 'differs', registry: 'PA', chosen: 'NP' } });
  assert.equal(degreeAfterNppes('MD', reg('PA-C', ['363A00000X'])).degree, null, 'a PA answer never replaces a chosen MD either');
  // Physicians as before: Settings replaces a blank, MD or DO; Setup fills a blank only.
  assert.equal(degreeAfterNppes('MD', reg('DO', ['207T00000X'])).degree, 'DO');
  assert.equal(degreeAfterNppes('MD', reg('DO', ['207T00000X']), { site: 'setup' }).degree, null);
  assert.equal(degreeAfterNppes('', reg('MD', [])).degree, 'MD');
  // A conflicting record is a finding, never a degree.
  const c = degreeAfterNppes('', reg('MD', ['363A00000X']));
  assert.equal(c.degree, null);
  assert.equal(c.finding.kind, 'conflict');
});

const field = (deg, type, key) => licenseFields({ degreeType: deg }).find(f => f.key === key);
const on = (f, rec) => typeof f.show === 'function' ? !!f.show(rec) : true;
const req = (f, rec) => typeof f.required === 'function' ? !!f.required(rec) : !!f.required;

test('licence form: certifications always expire, state instruments need a state, CE windows on PA and NP licences', () => {
  for (const t of ['Board Certification (NCCPA)', 'Board Certification (AANPCB)', 'Board Certification (ANCC)']) {
    const rec = { type: t, noExpiration: true };
    assert.equal(on(field('NP', t, 'noExpiration'), rec), false, t);
    assert.equal(req(field('NP', t, 'expirationDate'), rec), true, `${t} needs its date even with a stored flag`);
    assert.equal(isNonExpiring({ type: t, noExpiration: true }, 'licenses'), false);
    assert.equal(dateUnknownApplies('licenses', { type: t, noExpiration: true }), true);
    assert.equal(on(field('NP', t, 'cmeCycleStart'), rec), true);
  }
  // A physician's lifetime diplomate keeps the checkbox.
  const abms = { type: 'Board Certification (ABMS)', noExpiration: true };
  assert.equal(on(field('MD', abms.type, 'noExpiration'), abms), true);
  assert.equal(req(field('MD', abms.type, 'expirationDate'), abms), false);
  assert.equal(isNonExpiring(abms, 'licenses'), true);
  for (const t of ['Prescriptive Authority', 'Practice Agreement']) assert.equal(req(field('PA', t, 'state'), { type: t }), true, t);
  for (const t of ['State Physician Assistant License', 'APRN License (NP)', 'RN License (Multistate)']) assert.equal(on(field('NP', t, 'cmeCycleStart'), { type: t }), true, t);
  assert.equal(on(field('MD', 'BLS Certification', 'cmeCycleStart'), { type: 'BLS Certification' }), false);
  const ph = (deg) => field(deg, '', 'name').placeholder({ type: 'x' });
  assert.equal(ph('PA'), 'e.g. CA Physician Assistant License');
  assert.equal(ph('NP'), 'e.g. CA APRN License');
  assert.equal(ph('MD'), 'e.g. CA Medical License');
  assert.deepEqual(field('PA', '', 'type').options.slice(0, 1), ['State Physician Assistant License']);
});

test('record questions: every certification says what it is; renewal answers expire with the renewal', () => {
  const ancc = { type: 'Board Certification (ANCC)', name: 'FNP-BC' };
  assert.deepEqual(recordQuestionsFor(ancc, { degreeType: 'NP' }).map(q => q.field), ['Certification role']);
  const role = { ...ancc, customFields: { 'Certification role': 'NP certification' } };
  assert.deepEqual(recordQuestionsFor(role, { degreeType: 'NP' }).map(q => q.field), ['Certification role', QUESTION_FIELDS.anccDevelopment]);
  const route = (name) => recordQuestionsFor({ type: 'Board Certification (AANPCB)', name }, { degreeType: 'NP' }).find(q => q.field === 'Renewal route').choices;
  assert.deepEqual(route('FNP-C'), ['CE and practice hours', 'Exam']);
  assert.deepEqual(route('A-GNP-C'), ['CE and practice hours', 'Exam']);
  assert.deepEqual(route('NP-C'), ['CE and practice hours'], 'ANP and GNP renew by CE only');
  assert.ok(recordQuestionsFor({ type: 'Board Certification (NCCPA)', name: 'PA-C' }, { degreeType: 'PA' }).some(q => q.field === QUESTION_FIELDS.panreYear));
  const lic = { type: 'State Physician Assistant License', state: 'ME' };
  assert.deepEqual(recordQuestionsFor(lic, { degreeType: 'PA' }), [], 'no agreement question without verified state data');
  assert.match(recordQuestionsFor(lic, { degreeType: 'PA', stateAgreement: { conditional: true, stateName: 'Maine' } })[0].question, /agreement in Maine\?$/);
  assert.equal(recordQuestionsFor({ type: 'DEA Registration' }, { degreeType: 'MD' }).length, 0, 'physicians: no new questions');
  assert.equal(recordQuestionsFor({ type: 'DEA Registration' }, { degreeType: 'NP' })[0].field, QUESTION_FIELDS.mateSchool);
  const rec = { customFields: renewalAnswerPatch({}, QUESTION_FIELDS.practiceHours, 'Yes', '2027-05-31') };
  assert.equal(answerForRenewal(rec, QUESTION_FIELDS.practiceHours, '2027-05-31'), 'Yes');
  assert.equal(answerForRenewal(rec, QUESTION_FIELDS.practiceHours, '2029-05-31'), null, 'asked again next renewal');
});

test('CV import: a CV stating PA or NP is offered as that profession with its education types', () => {
  // A member with no profession is asked it before her CV is read
  // (CvImportReview), so the reader always has her own profession's lists.
  const pa = normalizeCvSections({ settings: { degreeType: 'pa' }, education: [{ type: 'Master of Physician Assistant Studies (MPAS)', institution: 'Synthetic University' }] }, { deg: 'PA' });
  assert.equal(pa.settings.degreeType, 'PA');
  assert.equal(pa.education[0].type, 'Master of Physician Assistant Studies (MPAS)');
  assert.equal(normalizeCvSections({ settings: { degreeType: 'MBBS' } }).settings.degreeType, undefined);
  assert.match(CV_PROMPT('NP'), /"degreeType": "MD"\|"DO"\|"PA"\|"NP"/);
  assert.match(CV_PROMPT('NP'), /Master of Science in Nursing \(MSN\)/);
  assert.match(CV_PROMPT('MD'), /"degreeType": "MD"\|"DO", "npi"/, 'physicians keep the prompt they had');
});


test('email intake passes a PA or NP profession to the scanner', () => {
  const s = readFileSync(new URL('../../supabase/functions/email-inbound/index.ts', import.meta.url), 'utf8');
  assert.match(s, /\["DO", "MD", "PA", "NP"\]\.includes\(String\(p\.degree_type/);
});

test('reference DDL accepts the four professions and assumes none', () => {
  for (const f of ['supabase-schema.sql', 'supabase-rebuild.sql']) {
    const s = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(s, /degree_type TEXT CHECK \(degree_type IS NULL OR degree_type IN \('', 'MD', 'DO', 'PA', 'NP'\)\),/, f);
    assert.doesNotMatch(s, /degree_type TEXT DEFAULT 'DO'/, f);
  }
});
