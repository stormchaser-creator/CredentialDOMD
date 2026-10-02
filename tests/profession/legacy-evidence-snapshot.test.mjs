// Regression tests for the fourth review of the October 2026 PA and NP work:
// a legacy medical-typed licence answers to the nursing kind its own evidence
// shows (its import note, or the one registry nursing row on its number), and
// Vera's snapshot pairs the licence date with the licence countdown. Synthetic
// records only. Time is frozen at local noon on 2026-10-01.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { markAlreadyOnFile } from '../../src/utils/publicRecord.js';
import { mergeNpiLicenses, licenseKeysOnFile, nursingKindFromNote } from '../../src/utils/npiImport.js';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12, 0, 0) });

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = async (entry, stubs = {}) => {
  const out = await build({
    entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: new RegExp(`^${filter.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`), namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};

const ids = () => { let i = 0; return () => `id${++i}`; };
const note = (d) => `Imported from NPPES NPI Registry (${d})`;
const legacy = (id, licenseNumber, notes) => ({ id, type: 'State Medical License', name: 'TX Medical License', state: 'TX', licenseNumber, ...(notes ? { notes } : {}) });
const finding = (id, type, licenseNumber, state = 'TX') => ({ id, section: 'licenses', fields: { type, state, licenseNumber } });
const npRow = { state: 'TX', licenseNumber: 'AP100001', taxonomyCode: '363LF0000X', description: 'Nurse Practitioner, Family' };
const rnRow = { state: 'TX', licenseNumber: '700001', taxonomyCode: '163W00000X', description: 'Registered Nurse' };

test('import note names the nursing kind; any other described row is neither', () => {
  assert.equal(nursingKindFromNote(note('Nurse Practitioner, Family')), 'aprn');
  assert.equal(nursingKindFromNote(note('Registered Nurse')), 'rn');
  // Every APRN role is the APRN licence: CRNA, CNS and CNM share the APRN number.
  assert.equal(nursingKindFromNote(note('Certified Registered Nurse Anesthetist')), 'aprn');
  assert.equal(nursingKindFromNote(note('Nurse Anesthetist, Certified Registered')), 'aprn');
  assert.equal(nursingKindFromNote(note('Clinical Nurse Specialist, Acute Care')), 'aprn');
  assert.equal(nursingKindFromNote(note('Advanced Practice Midwife')), 'aprn');
  assert.equal(nursingKindFromNote(note('Certified Nurse Midwife')), 'aprn');
  assert.equal(nursingKindFromNote(note('Physician Assistant, Medical')), 'none');
  assert.equal(nursingKindFromNote('Imported from NPPES NPI Registry'), '');
  assert.equal(nursingKindFromNote('typed by hand'), '');
  assert.equal(nursingKindFromNote(undefined), '');
});

test('legacy RN and APRN records on their own numbers: neither registry row is offered again', () => {
  const legRn = legacy('l1', '700001', note('Registered Nurse'));
  const legNp = legacy('l2', 'AP100001', note('Nurse Practitioner, Family'));
  assert.deepEqual(mergeNpiLicenses([legRn, legNp], [npRow, rnRow], { degreeType: 'NP', makeId: ids() }), []);
  const review = markAlreadyOnFile([finding('a', 'APRN License (NP)', 'AP100001'), finding('b', 'RN License', '700001')], { licenses: [legRn, legNp] });
  assert.deepEqual(review.map(f => f.alreadyOnFile), [true, true]);
});

test('legacy records with no note: the single registry nursing row on each number decides', () => {
  const legRn = legacy('l1', '700001');
  const legNp = legacy('l2', 'AP100001');
  assert.deepEqual(mergeNpiLicenses([legRn, legNp], [npRow, rnRow], { degreeType: 'NP', makeId: ids() }), []);
  const review = markAlreadyOnFile([finding('a', 'APRN License (NP)', 'AP100001'), finding('b', 'RN License', '700001')], { licenses: [legRn, legNp] });
  assert.deepEqual(review.map(f => f.alreadyOnFile), [true, true]);
  // Only the RN record on file: the APRN licence on its own number is still new.
  assert.deepEqual(mergeNpiLicenses([legRn], [npRow, rnRow], { degreeType: 'NP', makeId: ids() }).map(a => [a.type, a.licenseNumber]), [['APRN License (NP)', 'AP100001']]);
  assert.deepEqual(markAlreadyOnFile([finding('a', 'APRN License (NP)', 'AP100001'), finding('b', 'RN License', '700001')], { licenses: [legRn] }).map(f => f.alreadyOnFile), [false, true]);
});

test('a legacy record noted with a primary CNS taxonomy is the APRN licence: the NP row on its number is not offered again', () => {
  const rows = [
    { state: 'TX', licenseNumber: 'AP1', taxonomyCode: '364SA2100X', description: 'Clinical Nurse Specialist, Acute Care' },
    { state: 'TX', licenseNumber: 'AP1', taxonomyCode: '363LA2100X', description: 'Nurse Practitioner, Acute Care' },
  ];
  const leg = legacy('l1', 'AP1', note('Clinical Nurse Specialist, Acute Care'));
  assert.deepEqual(mergeNpiLicenses([leg], rows, { degreeType: 'NP', makeId: ids() }), []);
  assert.deepEqual(markAlreadyOnFile([finding('a', 'APRN License (NP)', 'AP1')], { licenses: [leg] }).map(f => f.alreadyOnFile), [true]);
  // A CRNA note on a different number hides nothing on the NP's own number.
  const crna = legacy('l2', 'AP9', note('Nurse Anesthetist, Certified Registered'));
  assert.deepEqual(mergeNpiLicenses([crna], [rows[1]], { degreeType: 'NP', makeId: ids() }).map(a => a.licenseNumber), ['AP1']);
});

test('one number shared by RN and APRN: the note decides, and only an ambiguous record falls back to APRN first', () => {
  const shared = [
    { state: 'CA', licenseNumber: '900001', taxonomyCode: '363LF0000X', description: 'Nurse Practitioner, Family' },
    { state: 'CA', licenseNumber: '900001', taxonomyCode: '163W00000X', description: 'Registered Nurse' },
  ];
  const ca = (notes) => ({ id: 'c', type: 'State Medical License', state: 'CA', licenseNumber: '900001', ...(notes ? { notes } : {}) });
  // The record says it is the RN licence: the APRN row is the new one.
  assert.deepEqual(mergeNpiLicenses([ca(note('Registered Nurse'))], shared, { degreeType: 'NP', makeId: ids() }).map(a => a.type), ['APRN License (NP)']);
  // No evidence on a shared number: APRN first, as before.
  assert.deepEqual(mergeNpiLicenses([ca()], shared, { degreeType: 'NP', makeId: ids() }).map(a => a.type), ['RN License']);
  // A noted RN record and an unnoted one on the same number are both licences.
  assert.deepEqual(mergeNpiLicenses([ca(note('Registered Nurse')), { ...ca(), id: 'c2' }], shared, { degreeType: 'NP', makeId: ids() }), []);
  // A record whose note names a PA licence never hides a nursing row on its number.
  const keys = licenseKeysOnFile([ca(note('Physician Assistant, Medical'))], [{ state: 'CA', licenseNumber: '900001', kind: 'aprn' }]);
  assert.deepEqual([...keys], ['CA|900001|']);
});

test("Vera's snapshot: an off-year PA card sends the licence countdown with the licence date and the CME period end on its own", async () => {
  const stub = 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};';
  const { buildSnapshot } = await bundle('src/utils/assistant.js', { 'aiClient$': stub, 'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;' });
  const base = { privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [], documents: [], workLog: [], invoices: [] };
  const d = (state, licenses) => ({ ...base, settings: { name: 'Alex Example', degreeType: 'PA', primaryState: state, additionalStates: [], reminderLeadDays: 90 }, licenses, cme: [] });
  const ms = d('MS', [{ id: 'a', type: 'State Physician Assistant License', name: 'MS PA License', state: 'MS', expirationDate: '2026-12-15', licenseNumber: 'a-0001', customFields: { 'Holds controlled substance prescriptive authority': 'No' } }]);
  const entry = buildSnapshot(ms, ['MS']).cmeSummary.byState['MS:pa'];
  assert.equal(entry.renewal, '2026-12-15');
  assert.equal(entry.daysLeft, 75, 'daysLeft counts to the renewal date it sits beside');
  assert.equal(entry.cmePeriodEnds, '2028-06-30');
  assert.equal(entry.cmePeriodDaysLeft, 638);
  assert.equal(entry.hoursAndTopicsDueBy, 'cmePeriodEnds');
  assert.deepEqual(entry.dueAtRenewal, []);
  // An open MATE item moves only the countdown: the hours stay due at the
  // period end, and the MATE item is the one thing named for the renewal.
  const msDea = { ...ms, licenses: [...ms.licenses, { id: 'dea', type: 'DEA Registration', name: 'DEA', state: 'MS', expirationDate: '2027-06-30', licenseNumber: 'XX0000001' }] };
  const deaEntry = buildSnapshot(msDea, ['MS']).cmeSummary.byState['MS:pa'];
  assert.equal(deaEntry.renewal, '2026-12-15');
  assert.equal(deaEntry.daysLeft, 75);
  assert.equal(deaEntry.cmePeriodEnds, '2028-06-30');
  assert.equal(deaEntry.hoursAndTopicsDueBy, 'cmePeriodEnds', 'an open MATE item never moves the hours to the renewal');
  assert.equal(deaEntry.dueAtRenewal.length, 1);
  assert.match(deaEntry.dueAtRenewal[0], /MATE Act 8 hours/);
  // A card whose period ends with the licence carries no second countdown.
  const al = d('AL', [{ id: 'b', type: 'State Physician Assistant License', name: 'AL PA License', state: 'AL', expirationDate: '2026-12-31', licenseNumber: 'b-0001' }]);
  const alEntry = buildSnapshot(al, ['AL']).cmeSummary.byState['AL:pa'];
  assert.equal(alEntry.renewal, '2026-12-31');
  assert.equal(alEntry.daysLeft, 91);
  assert.ok(!('cmePeriodEnds' in alEntry));
});
