import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canonicalState, canonicalizeSelectValue, canonicalScanFields } from '../src/utils/snapOption.js';
import { canonicalForDocType, scanShapeIssues } from '../src/utils/scanShape.js';
import {
  isPersonName, withoutPersonName, describeItem, plainLabel, buildEmailSubject, getItemLabel, PERSON_NAME_SECTIONS,
} from '../src/utils/helpers.js';
import { prepareRecord } from '../src/utils/recordWrite.js';
import { STATES } from '../src/constants/states.js';
import { getLicenseTypes, PRIVILEGE_TYPES, INSURANCE_TYPES } from '../src/constants/credentialTypes.js';

// Ticket 5bef10ac: three DEA registrations that did not look alike. A scan's
// free-text state and type reached the table, and a Display Name holding the
// physician's own name leaked into share subjects, notifications and pickers.
// Synthetic fixtures only.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PHYSICIAN = 'Eric E. Whitney, DO';
const SETTINGS = { name: PHYSICIAN, degreeType: 'DO' };
const DEA = [
  { id: 'dea-co', type: 'DEA Registration', state: 'CO', name: 'WHITNEY, ERIC', licenseNumber: 'FX0000001' },
  { id: 'dea-ca', type: 'DEA Registration', state: 'CA', name: 'Eric Edwin Whitney DO', licenseNumber: 'FX0000002' },
  { id: 'dea-nd', type: 'DEA Registration', state: 'ND', name: 'DEA ND', licenseNumber: 'FX0000003' },
];

test('a state is stored as its two-letter code however the document wrote it', () => {
  const cases = { 'North Dakota': 'ND', 'florida ': 'FL', nd: 'ND', 'N.D.': 'ND', ' CO ': 'CO', 'State of Colorado': 'CO', 'district of columbia': 'DC' };
  for (const [raw, code] of Object.entries(cases)) assert.equal(canonicalState(raw), code, raw);
  for (const raw of ['Fla.', 'Dakota', 'XX', '', '   ', null, undefined, 7]) assert.equal(canonicalState(raw), null, String(raw));
});

test('the shared select canonicaliser snaps states by name and types by spelling', () => {
  const state = { key: 'state', type: 'select', options: STATES };
  assert.equal(canonicalizeSelectValue(state, 'North Dakota'), 'ND');
  assert.equal(canonicalizeSelectValue(state, 'florida '), 'FL');
  assert.equal(canonicalizeSelectValue(state, 'Fla.'), 'Fla.', 'an unmatched value is left for the form to show');
  const type = { key: 'type', type: 'select', options: getLicenseTypes('MD') };
  assert.equal(canonicalizeSelectValue(type, 'dea registration'), 'DEA Registration');
  assert.equal(canonicalizeSelectValue({ key: 'x', type: 'text' }, 'North Dakota'), 'North Dakota', 'only selects are touched');
});

test('a scanned licence arrives on the review card with State and Type snapped', () => {
  const opts = getLicenseTypes('DO');
  assert.deepEqual(canonicalForDocType('license', { type: 'dea registration', state: 'North Dakota', licenseNumber: 'X' }, opts),
    { type: 'DEA Registration', state: 'ND', licenseNumber: 'X' });
  assert.equal(canonicalForDocType('license', { state: 'florida ' }, opts).state, 'FL');
  assert.equal(canonicalScanFields({ state: 'Fla.' }).state, 'Fla.', 'unmatched text is kept so the card can quote it');
  const cme = { title: 'Course', state: 'North Dakota' };
  assert.equal(canonicalForDocType('cme', cme, []), cme, 'other kinds are untouched');
});

test('the review card refuses an unmatched licence state or type instead of saving free text', () => {
  const opts = getLicenseTypes('MD');
  const issues = (docType, edited, o = opts) => scanShapeIssues(docType, edited, o);
  assert.deepEqual(issues('license', { type: 'DEA Registration', state: 'ND' }), { typeIssue: null, stateIssue: null });
  assert.match(issues('license', { type: 'DEA Registration', state: 'Fla.' }).stateIssue, /reads "Fla\." as the state/);
  assert.match(issues('license', { type: 'DEA Registration', state: '' }).stateIssue, /Select the issuing state/);
  assert.match(issues('license', { type: 'Driver License', state: 'CA' }).typeIssue, /reads "Driver License" as the type/);
  assert.match(issues('license', { type: '', state: 'CA' }).typeIssue, /Select the type/);
  assert.equal(issues('license', { type: 'Certification' }).stateIssue, null, 'a certification needs no state');
  // A privilege or policy type the list lacks is kept; its state is not.
  assert.equal(issues('privilege', { type: 'Hospital Privileges', state: 'CO' }, PRIVILEGE_TYPES).typeIssue, null);
  assert.match(issues('privilege', { type: 'Hospital Privileges', state: 'Colo' }, PRIVILEGE_TYPES).stateIssue, /reads "Colo"/);
  assert.equal(issues('insurance', { type: 'Professional Liability' }, INSURANCE_TYPES).typeIssue, null);
  assert.match(issues('insurance', { type: ' ' }, INSURANCE_TYPES).typeIssue, /Select the type/, 'type is NOT NULL: a blank one would reject the row');
  assert.deepEqual(issues('cme', { title: 'x' }, []), { typeIssue: null, stateIssue: null });
});

test("the physician's own name is recognised in every form a scan writes it", () => {
  for (const name of ['WHITNEY, ERIC', 'Eric Whitney', 'Eric Edwin Whitney DO', 'whitney eric e']) {
    assert.ok(isPersonName(name, PHYSICIAN), name);
  }
  for (const name of ['DEA ND', 'CA Medical License', 'Skull Base Fellowship', '']) {
    assert.ok(!isPersonName(name, PHYSICIAN), name);
  }
  assert.ok(!isPersonName('Eric Whitney', ''), 'no profile name, nothing to compare');
});

test('a person-name Display Name is dropped at save, and the canonical title applies', () => {
  const saved = prepareRecord('licenses', DEA[0], PHYSICIAN);
  assert.equal(saved.name, null);
  assert.equal(saved.licenseNumber, 'FX0000001', 'nothing else changes');
  assert.equal(describeItem(saved, PHYSICIAN, 'licenses'), 'DEA Registration \u{2014} CO');
  assert.equal(prepareRecord('licenses', DEA[2], PHYSICIAN), DEA[2], 'a real display name is kept, untouched');
  const ref = { id: 'r', name: 'Eric Whitney', degree: 'MD' };
  assert.equal(prepareRecord('peerReferences', ref, PHYSICIAN), ref, 'on a reference the person IS the record');
  assert.equal(withoutPersonName('cme', { name: 'Eric Whitney' }, PHYSICIAN).name, 'Eric Whitney');
  assert.ok(PERSON_NAME_SECTIONS.includes('licenses') && !PERSON_NAME_SECTIONS.includes('peerReferences'));
});

test('share subjects for the three DEA registrations all read by type and state', () => {
  const subjects = DEA.map(d => buildEmailSubject(d, 'licenses', SETTINGS));
  assert.deepEqual(subjects, [
    `Credential Verification: DEA Registration, CO - ${PHYSICIAN}`,
    `Credential Verification: DEA Registration, CA - ${PHYSICIAN}`,
    `Credential Verification: DEA Registration, ND - ${PHYSICIAN}`,
  ]);
  for (const s of subjects) assert.doesNotMatch(s, /\u{2014}/u, 'no em dash in outgoing text');
  assert.equal(buildEmailSubject({ name: 'Jane Roe' }, 'peerReferences', SETTINGS), 'Professional reference: Jane Roe');
});

test('alert and notification labels use the canonical label, never the physician name', () => {
  assert.equal(getItemLabel({ ...DEA[0], _sec: 'licenses' }, PHYSICIAN), 'DEA Registration, CO');
  assert.equal(getItemLabel(DEA[1], PHYSICIAN, 'licenses'), 'DEA Registration, CA');
  assert.equal(getItemLabel({ title: 'Opioid course', _sec: 'cme' }, PHYSICIAN), 'Opioid course');
  assert.equal(getItemLabel({ type: 'Surgical Privileges', facility: 'Mercy', _sec: 'privileges' }, PHYSICIAN), 'Surgical Privileges, Mercy');
  assert.equal(getItemLabel(null), 'Credential');
  assert.equal(plainLabel(DEA[2], PHYSICIAN, 'licenses'), 'DEA Registration, ND');
});

test('the notification message lists each DEA by type and state', async () => {
  const require = createRequire(import.meta.url);
  const out = await build({ entryPoints: [`${root}src/utils/notifications.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  const past = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const soon = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const alerts = { expired: [{ ...DEA[0], _sec: 'licenses', expirationDate: past(3) }], soon: [{ ...DEA[1], _sec: 'licenses', expirationDate: soon(20) }], cmeIssues: [], effectiveFreqDays: 7 };
  const msg = mod.exports.buildNotificationMessage({ settings: SETTINGS }, alerts);
  assert.match(msg.body, /DEA Registration, CO/);
  assert.match(msg.body, /DEA Registration, CA/);
  assert.doesNotMatch(msg.body, /WHITNEY, ERIC|Eric Edwin Whitney DO/);
});

test('every add and edit passes through prepareRecord, and the pickers use canonical labels', () => {
  const ctx = read('src/context/AppContext.jsx');
  const add = ctx.slice(ctx.indexOf('const addItem = useCallback('), ctx.indexOf('const editItem = useCallback('));
  const edit = ctx.slice(ctx.indexOf('const editItem = useCallback('), ctx.indexOf('const toggleFavorite = useCallback('));
  assert.match(add, /prepareRecord\(key, raw,/);
  assert.match(edit, /prepareRecord\(key, raw,/);
  assert.doesNotMatch(read('src/components/features/DocumentsSection.jsx'), /License: \$\{l\.name \|\| l\.type\}/);
  assert.doesNotMatch(read('src/components/features/CrudSection.jsx'), /function canonicalizeSelectValue/, 'one canonicaliser, shared');
});

// ── The real review card, rendered with a synthetic account ──────────────
const require = createRequire(import.meta.url);
const bundled = await build({
  stdin: { contents: 'export {default as ScanReviewCard} from "./src/components/features/ScanReviewCard.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-account', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context' ? 'export const useApp = () => globalThis.__scanCardFixture;' : 'export {}' }));
  } }],
});
const cardModule = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, cardModule, cardModule.exports);
const { ScanReviewCard } = cardModule.exports;
const renderCard = (extracted, documentType = 'license') => {
  globalThis.__scanCardFixture = {
    theme: { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', input: '#fff', inputBorder: '#ccc', accent: '#2a7', success: '#2a7', warning: '#a60', danger: '#c00', shadow1: 'none' },
    data: { settings: { degreeType: 'MD', name: PHYSICIAN }, locumContracts: [], customCategories: [], customRecords: [] },
    allTrackedStates: [],
  };
  return renderToStaticMarkup(React.createElement(ScanReviewCard, {
    result: { documentType, confidence: 'high', extracted }, fileName: 'scan.jpg', onSave() {}, onDiscard() {},
  }));
};

test('the review card shows "North Dakota" as ND and lets it save', () => {
  const html = renderCard({ type: 'DEA Registration', state: 'North Dakota', licenseNumber: 'FX0000003', expirationDate: '2027-01-31' });
  assert.match(html, /<option value="ND" selected="">ND<\/option>/);
  assert.doesNotMatch(html, /disabled=""/, 'Save is enabled');
});

test('the review card blocks an unmatched state and names what the scan read', () => {
  const html = renderCard({ type: 'DEA Registration', state: 'Fla.', licenseNumber: 'FX1', expirationDate: '2027-01-31' });
  assert.match(html, /disabled=""/);
  assert.match(html, /reads &quot;Fla\.&quot; as the state/);
});

test('the review card blocks an off-list licence type such as a driver licence', () => {
  const html = renderCard({ type: 'Driver License', state: 'CA', expirationDate: '2029-04-01' });
  assert.match(html, /disabled=""/);
  assert.match(html, /reads &quot;Driver License&quot; as the type/);
});

test('a privilege type the list lacks is shown as read, not blanked', () => {
  const html = renderCard({ type: 'Hospital Privileges', state: 'Colorado', facility: 'Mercy', expirationDate: '2027-01-31' }, 'privilege');
  assert.match(html, /Hospital Privileges \(from document\)/);
  assert.match(html, /<option value="CO" selected="">CO<\/option>/);
  assert.doesNotMatch(html, /disabled=""/);
});
