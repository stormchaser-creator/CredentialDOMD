// Public-record review for a PA and an NP (DESIGN 1.6, 1.7, 6.1): the edge
// function reads NPPES with the app's own profession rules. MD and DO
// fixtures are pinned by scripts/public-record.test.mjs. Synthetic records;
// the NPI is the CMS documentation example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeNppes, normalizeCmsClinician } from '../../supabase/functions/public-record/normalize.ts';

const CTX = { npi: '1234567893', fetchedAt: '2026-10-01T00:00:00.000Z' };
const nppes = (credential, taxonomies) => ({ results: [{ number: '1234567893', basic: { first_name: 'PAT', last_name: 'EXAMPLE', credential }, addresses: [], taxonomies }] });
const tax = (code, desc, license, state, primary = false) => ({ code, desc, license, state, primary });

test('a PA record: profession offered as a finding, licences typed as PA licences', () => {
  const out = normalizeNppes(nppes('PA-C', [tax('363A00000X', 'Physician Assistant', 'PA1001', 'TX', true), tax('363AS0400X', 'Physician Assistant, Surgical', 'PA2002', 'NM')]), CTX);
  const degree = out.find(f => f.id === 'nppes:profile:degree');
  assert.equal(degree.label, 'Profession: Physician Assistant');
  assert.deepEqual(degree.fields, { degreeType: 'PA' });
  assert.equal(out.find(f => f.kind === 'profileName').label, 'Pat Example, PA');
  const lic = out.filter(f => f.kind === 'stateLicense');
  assert.deepEqual(lic.map(f => [f.label, f.fields.type, f.fields.name]), [
    ['TX physician assistant license PA1001', 'State Physician Assistant License', 'TX Physician Assistant License'],
    ['NM physician assistant license PA2002', 'State Physician Assistant License', 'NM Physician Assistant License'],
  ]);
  assert.ok(lic.every(f => !/medical/i.test(JSON.stringify(f))));
});

test('an NP record: the RN and APRN rows that share a number are two licences', () => {
  const out = normalizeNppes(nppes('', [tax('363LF0000X', 'Nurse Practitioner, Family', '777', 'CA', true), tax('163W00000X', 'Registered Nurse', '777', 'CA')]), CTX);
  assert.deepEqual(out.find(f => f.id === 'nppes:profile:degree').fields, { degreeType: 'NP' });
  assert.deepEqual(out.filter(f => f.kind === 'stateLicense').map(f => [f.fields.type, f.label]), [
    ['APRN License (NP)', 'CA APRN license 777'],
    ['RN License', 'CA RN license 777'],
  ]);
});

test('an MD credential on a PA taxonomy is a conflict: no degree is offered', () => {
  const out = normalizeNppes(nppes('MD', [tax('363A00000X', 'Physician Assistant', 'PA1', 'TX', true)]), CTX);
  assert.equal(out.find(f => f.id === 'nppes:profile:degree'), undefined);
  const conflict = out.find(f => f.kind === 'profileDegreeConflict');
  assert.ok(conflict);
  assert.deepEqual(conflict.fields, {});
  assert.match(conflict.detail, /Choose your profession in Profile & settings/);
  assert.doesNotMatch(conflict.detail, /[–—]/);
});

test('Medicare lists a PA or NP school as a program, never a medical school or a medical diploma', () => {
  for (const [cred, program] of [['PA', 'PA program'], ['NP', 'Nursing program']]) {
    const out = normalizeCmsClinician({ results: [{ cred, med_sch: 'SYNTHETIC UNIVERSITY', grd_yr: '2015' }] }, CTX);
    const school = out.find(f => f.kind === 'medicalSchool');
    assert.equal(school.fields.name, `${program}, Synthetic University`);
    assert.equal(school.fields.type, undefined);
    assert.ok(school.needs.includes('type'));
    assert.doesNotMatch(JSON.stringify(school), /Medical Diploma|Doctor of Medicine/);
    const other = normalizeCmsClinician({ results: [{ cred, med_sch: 'OTHER', grd_yr: '2015' }] }, CTX).find(f => f.kind === 'medicalSchool');
    assert.equal(other.label, `${program}, class of 2015`);
  }
});

test('the edge function imports the shared profession module the sync script keeps current', () => {
  const s = readFileSync(new URL('../../supabase/functions/public-record/normalize.ts', import.meta.url), 'utf8');
  assert.match(s, /from "\.\.\/_shared\/app\/constants\/professions\.js"/);
  const shared = readFileSync(new URL('../../supabase/functions/_shared/app/constants/professions.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../../src/constants/professions.js', import.meta.url), 'utf8');
  assert.ok(shared.endsWith(source), 'the copy is the source verbatim under its banner');
});
