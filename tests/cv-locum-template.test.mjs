// "Locum Tenens" ("Compact format for locum assignments") is a CV of its own
// (CV-002). buildCvContent only branched on "academic" and "clinical", so the
// locum tile gave the Clinical CV minus its insurance and references: for most
// records the very same preview, Copy text and PDF. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCvContent } from '../src/utils/cvContent.js';
import { cvPlainText } from '../src/utils/shareText.js';

const RECORD = {
  settings: { name: 'Dana Synthetic', degreeType: 'MD', npi: '0000000000', languages: 'Spanish', professionalSummary: 'Synthetic summary.' },
  workHistory: [{ id: 'w1', employer: 'Synthetic Regional Medical Center', position: 'Attending Neurosurgeon', city: 'Example', state: 'CO', startDate: '2020-07-15', current: 'Yes', description: 'Synthetic description of a busy spine and cranial practice.' }],
  education: [
    { id: 'e1', type: 'Residency', name: 'Neurosurgery Residency', institution: 'Synthetic University', startDate: '2013-07-01', graduationDate: '2020-06-30' },
    { id: 'e2', type: 'Leadership activity', name: 'Synthetic Student Council', institution: 'Synthetic School of Medicine', graduationDate: '2013-05-01' },
  ],
  licenses: [{ id: 'l1', type: 'State Medical License', state: 'CO', licenseNumber: 'QA-0001', expirationDate: '2027-04-30' }],
  privileges: [{ id: 'p1', facility: 'Synthetic General Hospital', appointmentDate: '2024-02-01', expirationDate: '2027-01-31', state: 'CO' }],
  publications: [{ id: 'pb1', citation: 'Synthetic D. A synthetic paper. Synthetic J. 2020;1:1-2.', year: 2020 }],
  memberships: [{ id: 'm1', organization: 'Synthetic Society', role: 'Member' }],
  cme: [{ id: 'c1', title: 'Synthetic Skull Base Course', category: 'Course', date: '2024-05-15', provider: 'Synthetic Society' }],
  insurance: [{ id: 'i1', name: 'Synthetic Mutual policy', type: 'Professional Liability', provider: 'Synthetic Mutual', policyNumber: 'QA-POL', expirationDate: '2027-01-01' }],
  peerReferences: [{ id: 'r1', name: 'Pat Example', degree: 'MD', specialty: 'Neurosurgery', email: 'pat@example.invalid', relationship: 'Colleague' }],
};
const titles = (content) => content.map(s => (s.type === 'header' ? 'header' : s.title));

test('the Locum Tenens CV leads with what lets the physician work and leaves the academic record out', () => {
  const locum = buildCvContent(RECORD, 'locum');
  assert.deepEqual(titles(locum), [
    'header', 'Professional Summary', 'License', 'Hospital Privileges', 'Continual Professional Development',
    'Professional Experience', 'Education', 'Languages', 'Professional Liability Insurance', 'Professional References',
  ]);
  const experience = locum.find(s => s.title === 'Professional Experience');
  assert.equal(experience.items.length, 1);
  assert.match(experience.items[0].primary, /^Synthetic Regional Medical Center \(/);
  assert.equal(experience.items[0].detail, '', 'no job descriptions on the compact CV');
  const text = cvPlainText(locum, '9/30/2026');
  assert.doesNotMatch(text, /Synthetic description|Synthetic Student Council|A synthetic paper|Member of the Synthetic Society/);
  assert.match(text, /Synthetic Skull Base Course May 2024/, 'a named course stays on the compact CV');
  assert.match(text, /Colorado: QA-0001/);
  assert.match(text, /Synthetic Mutual \| Policy #QA-POL/);
  assert.match(text, /Pat Example, MD/);
});

test('for a record with no insurance or references, Locum Tenens still differs from the Clinical CV', () => {
  const record = { ...RECORD, insurance: [], peerReferences: [] };
  const clinical = cvPlainText(buildCvContent(record, 'clinical'), '9/30/2026');
  const locum = cvPlainText(buildCvContent(record, 'locum'), '9/30/2026');
  assert.notEqual(locum, clinical);
  assert.ok(locum.length < clinical.length, 'the compact CV is shorter');
});

test('the Clinical and Academic CVs keep their shape', () => {
  assert.deepEqual(titles(buildCvContent(RECORD, 'clinical')), [
    'header', 'Professional Summary', 'Professional Experience', 'Education', 'Medical Student', 'Languages', 'License', 'Hospital Privileges',
    'Publications', 'Professional Organizations', 'Continual Professional Development', 'Professional Liability Insurance', 'Professional References',
  ]);
  assert.deepEqual(titles(buildCvContent(RECORD, 'academic')), [
    'header', 'Professional Summary', 'Professional Experience', 'Education', 'Medical Student', 'Languages', 'License', 'Hospital Privileges',
    'Publications', 'Professional Organizations', 'Continual Professional Development',
  ]);
  assert.equal(buildCvContent(RECORD, 'clinical').find(s => s.title === 'Professional Experience').items[0].detail, RECORD.workHistory[0].description);
});

// A named course (CME category "Course": a skills course, a robot
// certification) is what an agency screens for, and the Clinical CV already
// lists it; the compact CV had dropped it. The CME log itself stays on the
// Academic CV only.
test('the Locum Tenens CV keeps named courses, and never the CME log', () => {
  const record = {
    settings: { name: 'Dana Synthetic', degreeType: 'MD' },
    privileges: [{ id: 'p1', facility: 'Synthetic General Hospital', appointmentDate: '2024-02-01', state: 'CO' }],
    cme: [
      { id: 'c1', title: 'Synthetic Spine Robot Certification', category: 'Course', date: '2025-03-15', provider: 'Synthetic Devices' },
      { id: 'c2', title: 'Synthetic Grand Rounds Lecture', category: 'AMA PRA Category 1', hours: 1, date: '2025-04-01' },
    ],
  };
  const locum = buildCvContent(record, 'locum');
  assert.deepEqual(titles(locum), ['header', 'Hospital Privileges', 'Continual Professional Development']);
  const courses = locum.find(s => s.title === 'Continual Professional Development');
  assert.deepEqual(courses.items.map(i => i.primary), ['Synthetic Spine Robot Certification March 2025']);
  assert.equal(courses.items[0].secondary, 'Synthetic Devices');
  const text = cvPlainText(locum, '9/30/2026');
  assert.match(text, /Synthetic Spine Robot Certification March 2025/);
  assert.doesNotMatch(text, /Grand Rounds Lecture/, 'the CME log is not on the compact CV');
  assert.deepEqual(courses, buildCvContent(record, 'clinical').find(s => s.title === 'Continual Professional Development'), 'the same course lines as the Clinical CV');
});
