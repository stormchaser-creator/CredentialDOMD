// PA and NP copy on the screens built around the cards (DESIGN 4.2, 4.3,
// 4.8, 5.3): the sidebar tagline, the multi-state matrix, and the Home and
// Credentials wiring in App.jsx. MD and DO keep every string they had.
// Synthetic records only.
import '../helpers/app-rules.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountComponent } from '../component-harness.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const lic = (type, state, over = {}) => ({ id: `${type}:${state}`, type, name: `${state} ${type}`, state, licenseNumber: 'X100', expirationDate: '2027-05-31', ...over });

async function tagline(degreeType) {
  const m = await mountComponent('src/components/shared/SideNav.jsx', {
    app: { theme: {}, toggleTheme() {}, isDesktop: true, isDark: false, data: { settings: { name: 'Pat Example', degreeType } } },
    props: { items: [], active: 'home', onChange() {} },
  });
  return m.pageText();
}

test('the sidebar names the member\'s own credentials (D-5); MD, DO and blank keep "Physician Credentials"', async () => {
  assert.match(await tagline('PA'), /PA Credentials/);
  assert.match(await tagline('NP'), /NP Credentials/);
  for (const d of ['MD', 'DO', '']) assert.match(await tagline(d), /Physician Credentials/);
  assert.doesNotMatch(await tagline('PA'), /Physician Credentials/);
});

const matrixModules = async () => ({
  compliance: await import('../../src/utils/compliance.js'),
  stateRequirements: await import('../../src/constants/stateRequirements.js'),
  states: await import('../../src/constants/states.js'),
  lifecycle: await import('../../src/utils/lifecycle.js'),
  appMatrix: await import('../../src/utils/appMatrix.js'),
  professions: await import('../../src/constants/professions.js'),
});
const matrix = async (settings, licenses) => mountComponent('src/components/features/locum/MultiStateMatrix.jsx', {
  app: { data: { settings, licenses, cme: [], privileges: [] }, theme: {} }, modules: await matrixModules(),
});
// AppRow is a component in the same file: render it by calling it, the way
// React would, and read its Cell props.
const appRows = (m) => m.nodes().filter(n => typeof n.type === 'function' && n.type.name === 'AppRow');
const cellsOf = (row) => {
  const out = [];
  const visit = (n) => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; if (typeof n.type === 'function' && n.type.name === 'Cell') out.push(n.props); visit(n.props?.children); };
  visit(row.type(row.props));
  return out;
};

test('matrix: a PA row has the PA licence, CME, DEA, CSR and agreement columns; never "Medical License" or "MD or DO?"', async () => {
  const m = await matrix({ degreeType: 'PA', primaryState: 'TX' }, [lic('State Physician Assistant License', 'TX'), lic('DEA Registration', 'TX')]);
  const [row] = appRows(m);
  assert.ok(row, 'the PA row is the PA layout');
  const cells = cellsOf(row);
  const labels = cells.map(c => c.label);
  assert.deepEqual(labels.slice(0, 2), ['PA License', 'CME (40 hr req)']);
  assert.ok(labels.includes('DEA') && labels.includes('State Controlled Substance') && labels.includes('Practice agreement'));
  assert.equal(cells.find(c => c.label === 'Practice agreement').props?.status ?? cells.find(c => c.label === 'Practice agreement').status, 'Required in this state');
  const text = JSON.stringify(cells);
  assert.doesNotMatch(text, /Medical License|MD or DO|null|undefined|NaN|—/);
  assert.doesNotMatch(m.pageText(), /MD or DO/);
});

test('matrix: an NP row shows the APRN licence and a multistate RN from another compact state', async () => {
  const m = await matrix({ degreeType: 'NP', primaryState: 'FL' }, [lic('APRN License (NP)', 'FL'), lic('RN License (Multistate)', 'TX')]);
  const fl = appRows(m).find(r => r.props.row.state === 'FL');
  const cells = cellsOf(fl);
  assert.equal(cells[0].label, 'APRN License');
  const rn = cells.find(c => c.label === 'RN License');
  assert.equal(rn.status, 'Multistate RN from Texas; Florida is a compact state');
  assert.match(cells.find(c => c.label.startsWith('CE')).label, /^CE/);
});

test('matrix: an MD row is the physician layout, unchanged', async () => {
  const m = await matrix({ degreeType: 'MD', primaryState: 'TX' }, [lic('State Medical License', 'TX')]);
  assert.equal(appRows(m).length, 0);
  assert.ok(m.nodes().some(n => typeof n.type === 'function' && n.type.name === 'Cell' && n.props.label === 'Medical License'));
});

test('App: licences carry their record questions, cards their details, and Home names the PA or NP licence', () => {
  const app = read('src/App.jsx');
  assert.match(app, /renderExtra=\{item => <><RenewalInfo item=\{item\} \/><RecordQuestions item=\{item\} \/><\/>\}/);
  assert.match(app, /<ConditionalCmeTopics comp=\{comp\} \/>\n\s+<AppCardDetails comp=\{comp\} lic=\{lic\} \/>/);
  assert.match(app, /"profession \(MD, DO, PA or NP, which decides the rules that apply\)"/);
  assert.match(app, /!isAdvancedPractice\(s\.degreeType\) && !\(s\.specialties \|\| \[\]\)\.length/, 'a PA or NP is never asked for a board specialty');
  assert.match(read('src/utils/credentialForms.js'), /label: "State Licenses"/);
  assert.match(app, /licenseTypeTab\(data\.settings\.degreeType\)/);
  const getStarted = read('src/components/features/GetStartedCard.jsx');
  assert.match(getStarted, /Add your physician assistant license to begin tracking credentials/);
  assert.match(getStarted, /Add your APRN and RN licenses to begin tracking credentials/);
  assert.match(app, /<GetStartedCard\n\s+degreeType=\{data\.settings\.degreeType\}/);
  assert.match(app, /"National Certification" : "Board Certification"/);
  assert.match(app, /options: getEducationTypes\(data\.settings\.degreeType\)/);
  assert.match(app, /licenseWarnings\.push\(<ProfessionReviewCard/);
  assert.match(app, /certificationCards\(data\)\.filter\(c => c\.needsRole\)/);
});

test('Settings: the email rows point at "Profile" for a PA or NP; the CME import holds an unnamed PA Category 1', () => {
  const settings = read('src/components/pages/SettingsSection.jsx');
  assert.match(settings, /profileHeading=\{appProfession \? "Profile" : "Physician Profile"\}/);
  assert.doesNotMatch(settings, /"[^"\n]*in Physician Profile above[^"\n]*"/, 'no fixed "Physician Profile" string left in the email rows');
  const imp = read('src/components/features/CMEImport.jsx');
  assert.match(imp, /disabled=\{!included\.length \|\| heldForSponsor > 0\}/);
  assert.match(imp, /if \(heldForSponsor > 0\) return;/);
});

test('no em dash or en dash in the new PA and NP screens and helpers (DESIGN 7.5)', () => {
  for (const rel of ['src/components/shared/AppCardDetails.jsx', 'src/components/shared/RecordQuestions.jsx', 'src/components/shared/ProfessionReviewCard.jsx',
    'src/utils/appMatrix.js', 'src/utils/recordAnswers.js', 'src/utils/appCreditNotes.js']) {
    const text = read(rel);
    assert.doesNotMatch(text, /[–—]|\\u201[34]/, rel);
  }
  const matrixSrc = read('src/components/features/locum/MultiStateMatrix.jsx');
  assert.doesNotMatch(matrixSrc.slice(matrixSrc.indexOf('const AGREEMENT_STATUS')), /[–—]|\\u201[34]/, 'the PA and NP row');
});
