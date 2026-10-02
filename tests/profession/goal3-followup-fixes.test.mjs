// Release goal3 follow-up fixes (PA and NP). Synthetic members and records
// only. Each test names the defect it pins.
import '../helpers/app-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSetup } from '../../src/utils/setupTasks.js';
import { licenseTypeTab, licenseFields } from '../../src/utils/credentialForms.js';
import { ALL_LICENSE_TYPES, LICENSE_TYPES_MD, LICENSE_TYPES_DO, LICENSE_TYPES_PA, LICENSE_TYPES_NP } from '../../src/constants/credentialTypes.js';

const NOW = new Date('2026-10-01T17:00:00Z');
const member = (degreeType, education) => ({
  settings: { name: 'Pat Example', degreeType, primaryState: 'TX', email: 'pat@example.test', notifyEmail: true, reminderLeadDays: 90 },
  licenses: [], cme: [], documents: [], education,
});
const educationStatus = (degreeType, education) => buildSetup(member(degreeType, education), { now: NOW }).byId.education.status;
const isDone = (s) => s === 'done' || s === 'documented';
const bs = (over) => ({ id: 'e1', type: 'Bachelor of Science (BS)', ...over });

// ── A pre-PA undergraduate record is not the PA program ─────────────────────

test('PA program task: a pre-PA undergraduate major leaves the task asking for the program', () => {
  for (const fieldOfStudy of ['Pre-Physician Assistant Studies', 'Pre-PA studies', 'Pre PA Studies', 'pre-physician\'s assistant', 'PrePA studies']) {
    assert.equal(educationStatus('PA', [bs({ fieldOfStudy })]), 'pending', fieldOfStudy);
  }
  assert.equal(educationStatus('PA', [bs({ name: 'Pre-PA studies', institution: 'Example State University' })]), 'pending', 'display name');
  assert.equal(educationStatus('PA', [{ id: 'e1', type: 'Pre-Physician Assistant (BS)' }]), 'pending', 'typed type');
  assert.equal(educationStatus('PA', [bs({ fieldOfStudy: 'Biology' })]), 'pending', 'control');
});

test('PA program task: a BS or MS whose field names the PA program still counts, and so does a later program beside a pre-PA major', () => {
  for (const fieldOfStudy of ['Physician Assistant Studies', 'Physician Assistant', 'PA program', "Physician's Assistant"]) {
    assert.ok(isDone(educationStatus('PA', [bs({ fieldOfStudy })])), fieldOfStudy);
  }
  assert.ok(isDone(educationStatus('PA', [{ id: 'e1', type: 'Master of Science (MS)', institution: 'Example PA program' }])), 'institution');
  assert.ok(isDone(educationStatus('PA', [bs({ fieldOfStudy: 'Pre-PA studies' }), { id: 'e2', type: 'Master of Physician Assistant Studies (MPAS)' }])), 'program on file');
  assert.ok(isDone(educationStatus('PA', [bs({ fieldOfStudy: 'Physician Assistant (after pre-PA track)' })])), 'program named outside the prefix');
});

// ── The Licenses page's first tab ───────────────────────────────────────────

const OTHER_TAB_TYPES = ['DEA Registration', 'Board Certification', 'BLS'];

test('Licenses tab: a member with no profession gets "State Licenses", holding every profession\'s practice licence', () => {
  const tab = licenseTypeTab('');
  assert.equal(tab.key, 'medical');
  assert.equal(tab.label, 'State Licenses');
  for (const type of ['RN License', 'RN License (Multistate)', 'APRN License (NP)', 'State Physician Assistant License', 'State Medical License', 'Training License']) {
    assert.ok(tab.match({ type }), type);
  }
  for (const type of OTHER_TAB_TYPES) assert.equal(tab.match({ type }), false, type);
  for (const blank of [undefined, null]) assert.equal(licenseTypeTab(blank).label, 'State Licenses');
  // Every practice licence the blank member's form offers lands in the tab.
  const offered = licenseFields({ degreeType: '' }).find((f) => f.key === 'type').options;
  assert.deepEqual(offered, ALL_LICENSE_TYPES);
  for (const type of [...LICENSE_TYPES_PA, ...LICENSE_TYPES_NP]) {
    if (/licen[sc]e/i.test(type) && !/dea|controlled substance|practice agreement|prescriptive/i.test(type)) assert.ok(tab.match({ type }), type);
  }
});

test('Licenses tab: MD and DO keep "Medical Licenses" with the exact physician test; PA and NP keep "State Licenses"', () => {
  const physicianTest = (type) => /medical license|physician|osteopathic|training license/i.test(type || '');
  for (const deg of ['MD', 'DO']) {
    const tab = licenseTypeTab(deg);
    assert.equal(tab.label, 'Medical Licenses', deg);
    for (const type of [...ALL_LICENSE_TYPES, ...LICENSE_TYPES_MD, ...LICENSE_TYPES_DO, '', 'Something else']) {
      assert.equal(tab.match({ type }), physicianTest(type), `${deg} ${type}`);
    }
  }
  assert.ok(licenseTypeTab('PA').match({ type: 'State Physician Assistant License' }));
  assert.ok(licenseTypeTab('NP').match({ type: 'RN License' }));
  assert.equal(licenseTypeTab('NP').label, 'State Licenses');
});

test('App renders the Licenses page with licenseTypeTab, not an inline physician branch', () => {
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /filterTabs=\{\[\n(?:\s*\/\/.*\n)*\s*licenseTypeTab\(data\.settings\.degreeType\),/);
  assert.doesNotMatch(app, /label: "Medical Licenses"/);
});
