// The PA program task and the PA licence test read typed and CV-imported
// punctuation, and the "Physician Associate" title. Synthetic records only.
import '../helpers/app-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSetup } from '../../src/utils/setupTasks.js';
import { licenseKindOf } from '../../src/constants/professions.js';

const NOW = new Date('2026-10-01T17:00:00Z');
const member = (degreeType, education) => ({
  settings: { name: 'Pat Example', degreeType, primaryState: 'TX', email: 'pat@example.test', notifyEmail: true, reminderLeadDays: 90 },
  licenses: [], cme: [], documents: [], education,
});
const educationStatus = (degreeType, education) => buildSetup(member(degreeType, education), { now: NOW }).byId.education.status;
const isDone = (s) => s === 'done' || s === 'documented';
const bs = (over) => ({ id: 'e1', type: 'Bachelor of Science (BS)', ...over });
const ms = (over) => ({ id: 'e1', type: 'Master of Science (MS)', ...over });

test('PA program task: a curly apostrophe from iPhone smart punctuation still names the program', () => {
  for (const fieldOfStudy of ['Physician’s Assistant', 'Physician‘s Assistant', 'Physicianʼs Assistant', "Physician's Assistant"]) {
    assert.ok(isDone(educationStatus('PA', [bs({ fieldOfStudy })])), JSON.stringify(fieldOfStudy));
  }
  assert.ok(isDone(educationStatus('PA', [{ id: 'e1', type: 'Other', name: 'Physician’s Assistant Program' }])), 'display name');
});

test('PA program task: a pre-PA major written with an en dash, a non breaking hyphen or a curly apostrophe stays a pre-PA major', () => {
  for (const fieldOfStudy of [
    'Pre–PA studies', 'Pre‑PA Studies', 'Pre‐PA studies', 'Pre—PA studies', 'Pre−PA studies',
    'Pre–Physician Assistant Studies', 'pre-physician’s assistant', 'Pre–Physician Associate Studies',
  ]) {
    assert.equal(educationStatus('PA', [bs({ fieldOfStudy })]), 'pending', JSON.stringify(fieldOfStudy));
  }
  assert.equal(educationStatus('PA', [{ id: 'e1', type: 'Other', institution: 'Example State University', name: 'Pre–PA studies' }]), 'pending', 'display name');
});

test('PA program task: "Physician Associate" names the PA program; a pre physician associate major does not', () => {
  assert.ok(isDone(educationStatus('PA', [ms({ fieldOfStudy: 'Physician Associate Studies' })])), 'field of study');
  assert.ok(isDone(educationStatus('PA', [{ id: 'e1', type: 'Other', institution: 'Synthetic University Physician Associate Program' }])), 'institution');
  assert.ok(isDone(educationStatus('PA', [{ id: 'e1', type: 'Master of Physician Associate Studies' }])), 'typed type');
  assert.ok(isDone(educationStatus('PA', [ms({ fieldOfStudy: 'Physician Assistant Studies' })])), 'control: assistant');
  assert.equal(educationStatus('PA', [bs({ fieldOfStudy: 'Pre-Physician Associate Studies' })]), 'pending', 'pre physician associate');
  assert.equal(educationStatus('PA', [bs({ fieldOfStudy: 'Pre Physician Associate' })]), 'pending', 'pre physician associate, space');
  assert.equal(educationStatus('PA', [bs({ fieldOfStudy: 'Biology' })]), 'pending', 'control: unrelated');
});

test('PA licence kind: a curly apostrophe in a typed PA licence type still reads as a PA licence', () => {
  for (const t of ['Physician’s Assistant License', 'Physician‘s Associate Licence', "Physician's Assistant License", 'Physician Associate License', 'State Physician Assistant License']) {
    assert.equal(licenseKindOf(t), 'pa', JSON.stringify(t));
  }
  assert.equal(licenseKindOf('State Medical License'), 'medical');
});

test('Setup licences drawer: a PA practice licence is read by licenseKindOf, so the curly apostrophe fold applies there too', () => {
  const src = readFileSync(new URL('../../src/components/features/SetupPage.jsx', import.meta.url), 'utf8');
  assert.match(src, /deg === "PA" \? licenseKindOf\(type\) === "pa"/);
  assert.doesNotMatch(src, /physician\('\?s\)\? \(assistant\|associate\) licen\[sc\]e/);
});
