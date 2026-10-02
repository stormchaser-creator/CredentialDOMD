// The profession model (DESIGN 1.2 to 1.7, 2.7): stored values, licence
// kinds, certification roles, NPPES taxonomy and credential reading, licence
// typing on import, vocabularies per profession. Synthetic records only; the
// NPPES fixture holds aggregate credential-string counts, no identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEGREES, DEGREE_LABELS, isKnownDegree, isPhysicianDegree, isAdvancedPractice, isStorableDegree, professionOf,
  practiceKindsFor, licenseKindOf, isPracticeLicense, isMultistateRn, certBodyOf, certificationRoleOf, isNationalCertification,
  professionFromTaxonomy, degreeFromNppes, nppesProfession, licenseTypeForNppesRow, nuccSpecialtyId, NUCC_NP_SPECIALTIES,
} from '../../src/constants/professions.js';
import { professionStatus } from '../../src/utils/professionStatus.js';
import { professionCopy } from '../../src/constants/professionCopy.js';
import * as types from '../../src/constants/credentialTypes.js';
import { CME_TOPICS, getCmeTopics } from '../../src/constants/cmeTopics.js';
import { mergeNpiLicenses, extractLicensesFromNPI, degreeFromCredential } from '../../src/utils/npiImport.js';
import { SECTION_TYPES } from '../../src/utils/intakeRecords.js';

test('four professions, blank and anything else unknown', () => {
  assert.deepEqual([...DEGREES], ['MD', 'DO', 'PA', 'NP']);
  assert.equal(DEGREE_LABELS.PA, 'Physician Assistant');
  assert.equal(DEGREE_LABELS.NP, 'Nurse Practitioner');
  for (const d of ['MD', 'DO', 'PA', 'NP']) assert.ok(isKnownDegree(d));
  for (const d of ['', null, undefined, 'MBBS', 'md', 'pa', 'PA-C', 'FNP']) {
    assert.equal(isKnownDegree(d), false, String(d));
    assert.equal(professionOf(d), null, String(d));
    assert.equal(professionStatus(d).unknown, true, String(d));
  }
  assert.equal(professionOf('MD'), 'physician');
  assert.equal(professionOf('DO'), 'physician');
  assert.equal(professionOf('PA'), 'pa');
  assert.equal(professionOf('NP'), 'np');
  assert.ok(isPhysicianDegree('DO') && !isPhysicianDegree('PA'));
  assert.ok(isAdvancedPractice('NP') && !isAdvancedPractice('MD') && !isAdvancedPractice(''));
  assert.ok(isStorableDegree('') && isStorableDegree('PA') && !isStorableDegree('MBBS'));
  assert.deepEqual(professionStatus('PA'), { profession: 'pa', unknown: false });
});

test('licence kinds by type, first match wins, with the traps pinned', () => {
  const table = [
    ['State Medical License', 'medical'], ['State Medical License (DO)', 'medical'], ['State Medical License (MD-equiv)', 'medical'],
    ['State Physician Assistant License', 'pa'], ['Oregon Physician Associate License', 'pa'], ["Michigan Physician's Assistant License", 'pa'],
    ['APRN License (NP)', 'aprn'], ['ARNP License', 'aprn'], ['CRNP Certification', 'aprn'], ['Nurse Practitioner Certificate', 'aprn'], ['APN Approval to Practice', 'aprn'],
    ['RN License', 'rn'], ['RN License (Multistate)', 'rn'], ['Registered Nurse License', 'rn'],
    ['Prescriptive Authority', 'rx'], ['Practice Agreement', 'agreement'],
    ['Board Certification (NCCPA)', 'cert'], ['Board Certification (ANCC)', 'cert'], ['Board Certification (AACN)', 'cert'],
    ['DEA Registration', 'dea'], ['State Controlled Substance', 'csr'],
    ['Board Certification (ABMS)', null], ['BLS Certification', null], ['PANCE', null], ['NCLEX-RN', null], ['Other', null], ['', null], [undefined, null],
    // Traps
    ['Physician Assistant', null], ['PRN License', null], ['BURN License', null],
  ];
  for (const [t, k] of table) assert.equal(licenseKindOf(t), k, String(t));
  assert.ok(isMultistateRn('RN License (Multistate)'));
  assert.ok(!isMultistateRn('RN License') && !isMultistateRn('APRN License (NP)'));
});

test('practice licences per profession: physicians and blank keep the medical licence test', () => {
  assert.deepEqual([...practiceKindsFor('MD')], ['medical']);
  assert.deepEqual([...practiceKindsFor('')], ['medical']);
  assert.deepEqual([...practiceKindsFor('PA')], ['pa']);
  assert.deepEqual([...practiceKindsFor('NP')], ['aprn', 'rn']);
  const med = { type: 'State Medical License' }, pa = { type: 'State Physician Assistant License' }, rn = { type: 'RN License' };
  assert.ok(isPracticeLicense(med, 'MD') && isPracticeLicense(med, '') && !isPracticeLicense(med, 'PA'));
  assert.ok(isPracticeLicense(pa, 'PA') && !isPracticeLicense(pa, 'MD') && !isPracticeLicense(pa, ''));
  assert.ok(isPracticeLicense(rn, 'NP') && !isPracticeLicense(rn, 'PA'));
});

test('certifying body from the exact type only', () => {
  assert.equal(certBodyOf('Board Certification (NCCPA)'), 'NCCPA');
  assert.equal(certBodyOf(' Board Certification (PNCB) '), 'PNCB');
  assert.equal(certBodyOf('Board Certification (ABMS)'), null);
  assert.equal(certBodyOf('Board Certification'), null);
  assert.equal(certBodyOf('NCCPA'), null);
});

test('certification role: the answer, or a prefill only where it is certain', () => {
  const nccpa = { id: 'c1', type: 'Board Certification (NCCPA)', name: 'PA-C' };
  assert.equal(certificationRoleOf(nccpa, [nccpa]), 'PA-C', 'a single NCCPA record is the PA-C');
  const caq = { id: 'c2', type: 'Board Certification (NCCPA)', name: 'CAQ Emergency Medicine' };
  assert.equal(certificationRoleOf(nccpa, [nccpa, caq]), null, 'two NCCPA records: ask');
  assert.equal(certificationRoleOf({ ...caq, customFields: { 'Certification role': 'CAQ or other' } }, [nccpa, caq]), 'CAQ or other');
  assert.equal(certificationRoleOf({ type: 'Board Certification (AANPCB)', name: 'FNP-C' }), 'NP certification');
  assert.equal(certificationRoleOf({ type: 'Board Certification (PNCB)', name: 'CPNP-PC' }), 'NP certification');
  assert.equal(certificationRoleOf({ type: 'Board Certification (PNCB)', name: 'CPN' }), null);
  assert.equal(certificationRoleOf({ type: 'Board Certification (NCC)', name: 'WHNP-BC' }), 'NP certification');
  assert.equal(certificationRoleOf({ type: 'Board Certification (ANCC)', name: 'FNP-BC' }), null, 'ANCC also certifies RN specialties: ask');
  assert.equal(certificationRoleOf({ type: 'Board Certification (AACN)', name: 'CCRN' }), null);
  const rnSpecialty = { type: 'Board Certification (ANCC)', name: 'RN-BC', customFields: { 'Certification role': 'RN specialty' } };
  assert.equal(isNationalCertification(rnSpecialty), false);
  assert.equal(isNationalCertification({ ...rnSpecialty, customFields: { 'Certification role': 'NP certification' } }), true);
  assert.equal(certificationRoleOf({ type: 'Board Certification (ABMS)', name: 'ABIM' }), null);
});

test('NUCC specialty ids carry the display name, never a bare code', () => {
  assert.equal(nuccSpecialtyId('363LF0000X'), 'NUCC:363LF0000X:Family Nurse Practitioner');
  assert.equal(nuccSpecialtyId('363AS0400X'), 'NUCC:363AS0400X:Surgical Physician Assistant');
  assert.equal(nuccSpecialtyId('207T00000X'), null);
  assert.equal(NUCC_NP_SPECIALTIES.length, 17);
});

test('taxonomy prefixes: physicians, PA, NP, RN; never CNS, CRNA, midwife or AA', () => {
  const table = [['207T00000X', 'physician'], ['208100000X', 'physician'], ['363A00000X', 'pa'], ['363AM0700X', 'pa'], ['363L00000X', 'np'], ['363LF0000X', 'np'],
    ['163W00000X', 'rn'], ['364SP0808X', null], ['367500000X', null], ['367A00000X', null], ['367H00000X', null], ['390200000X', null], ['', null]];
  for (const [c, k] of table) assert.equal(professionFromTaxonomy(c), k, c);
});

const nppes = (credential, codes = [], primaryIndex = 0) => ({ credential, taxonomies: codes.map((code, i) => ({ code, isPrimary: i === primaryIndex })) });

test('NPPES credential strings from the sample read as PA or NP only when unambiguous', () => {
  const pa = ['PA-C', 'PA', 'PAC', 'RPA-C', 'PA C', 'PA - C', 'PA- C', 'MPAS, PA-C', 'MS, PA-C', 'PHYSICIAN ASSISTANT', 'RPAC', 'R-PAC', 'PHYSICIANS ASSISTANT', 'P.A.-C.'];
  const np = ['FNP', 'NP', 'CRNP', 'ARNP', 'FNP-C', 'CNP', 'FNP-BC', 'NP-C', 'NURSE PRACTITIONER', 'APRN-CNP', 'PNP', 'CPNP', 'APRN, FNP-C', 'AGACNP-BC',
    'PMHNP', 'WHNP', 'CPNP-PC', 'MSN, APRN, FNP-C', 'DNP, FNP-BC', 'RN, FNP', 'NNP', 'AGACNP'];
  const none = ['', 'APRN', 'APN', 'DNP', 'MSN', 'RN', 'LSA', 'CSA', 'PA-S', 'STUDENT', 'SA-C', 'CSFA', 'RSA', 'CNM', 'PA-C, FNP'];
  for (const c of pa) assert.equal(degreeFromNppes(nppes(c)), 'PA', c);
  for (const c of np) assert.equal(degreeFromNppes(nppes(c)), 'NP', c);
  for (const c of none) assert.equal(degreeFromNppes(nppes(c)), '', c);
});

test('the sample fixture is aggregate counts only, and every listed PA and NP string is classified as the table says', () => {
  const sample = JSON.parse(readFileSync(new URL('./fixtures/nppes-credential-counts.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(sample), ['Physician Assistant', 'Nurse Practitioner']);
  for (const group of Object.values(sample)) for (const [s, n] of group.cred) assert.ok(typeof s === 'string' && Number.isInteger(n));
  // Without a taxonomy no string in the PA sample reads as NP and none in the NP sample as PA.
  for (const [c] of sample['Physician Assistant'].cred) assert.notEqual(degreeFromNppes(nppes(c)), 'NP', c);
  for (const [c] of sample['Nurse Practitioner'].cred) assert.notEqual(degreeFromNppes(nppes(c)), 'PA', c);
});

test('NPPES taxonomy precedence, mixed taxonomies, and MD or DO credentials first', () => {
  assert.equal(degreeFromNppes(nppes('', ['363A00000X'])), 'PA');
  assert.equal(degreeFromNppes(nppes('', ['363LF0000X', '163W00000X'])), 'NP', 'RN rows never decide');
  assert.equal(degreeFromNppes(nppes('', ['163W00000X'])), '', 'an RN alone is not an NP');
  assert.equal(degreeFromNppes(nppes('', ['390200000X', '363AS0400X'])), 'PA', 'every taxonomy: exactly PA');
  assert.equal(degreeFromNppes(nppes('', ['390200000X', '363AS0400X', '363LF0000X'])), '', 'PA and NP: ask');
  assert.equal(degreeFromNppes(nppes('', ['207T00000X'])), '', 'a physician taxonomy alone: MD or DO unknown');
  assert.equal(degreeFromNppes(nppes('PA-C', ['207T00000X'])), '', 'physician primary, PA credential: no answer');
  assert.equal(degreeFromNppes(nppes('NP', ['367A00000X'])), 'NP', 'credential decides when no taxonomy does');
  assert.equal(degreeFromNppes(nppes('DNP', ['364SP0808X'])), '', 'a CNS with a DNP is not an NP');
  // Physicians unchanged.
  assert.equal(degreeFromNppes(nppes('MD', ['207T00000X'])), 'MD');
  assert.equal(degreeFromNppes(nppes('D.O.', [])), 'DO');
  assert.equal(degreeFromNppes(nppes('MD, PA')), 'MD', 'no taxonomy: physician result as before');
  assert.equal(degreeFromNppes(nppes('MD, PA', ['207Q00000X'])), 'MD', 'physician taxonomy: as before');
  assert.equal(degreeFromNppes(nppes('OD', [])), '');
  assert.equal(degreeFromNppes(nppes('DMD', [])), '');
});

test('conflict guard: an MD or DO credential on a PA or NP record is blank and reported', () => {
  for (const [c, codes] of [['MD', ['363A00000X']], ['DO', ['363LF0000X']], ['MD, PA', ['363AM0700X']], ['MD, PA', ['390200000X']]]) {
    const r = nppesProfession(nppes(c, codes));
    assert.equal(r.degree, '', `${c} ${codes}`);
    assert.equal(r.source, 'conflict');
    assert.deepEqual(r.conflict, { credential: c, taxonomy: codes[0] });
  }
  assert.equal(degreeFromCredential('MD'), 'MD', 'the physician credential reader is unchanged');
});

const row = (state, licenseNumber, taxonomyCode, description = '') => ({ state, licenseNumber, taxonomyCode, description });

test('imported licence rows are typed by taxonomy for PA, NP and blank; MD and DO unchanged', () => {
  for (const d of ['MD', 'DO']) {
    assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '363A00000X'), d), { type: d === 'DO' ? 'State Medical License (DO)' : 'State Medical License', name: 'TX Medical License' });
  }
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '363A00000X'), 'PA'), { type: 'State Physician Assistant License', name: 'TX Physician Assistant License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '363LF0000X'), 'NP'), { type: 'APRN License (NP)', name: 'TX APRN License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '163W00000X'), 'NP'), { type: 'RN License', name: 'TX RN License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '207T00000X'), 'PA'), { type: 'State Medical License', name: 'TX Medical License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '367A00000X', 'Advanced Practice Midwife'), 'NP'), { type: 'Other', name: 'TX license (Advanced Practice Midwife)' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', ''), 'NP'), { type: 'Other', name: 'TX license (type not known)' });
  // Blank: medical as before, except clear PA, APRN and RN rows.
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '207T00000X'), ''), { type: 'State Medical License', name: 'TX Medical License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', ''), ''), { type: 'State Medical License', name: 'TX Medical License' });
  assert.deepEqual(licenseTypeForNppesRow(row('TX', '1', '363A00000X'), ''), { type: 'State Physician Assistant License', name: 'TX Physician Assistant License' });
});

test('an NP keeps an RN and an APRN row that share a number as two records; MD dedupe unchanged', () => {
  const ids = () => { let i = 0; return () => `id${++i}`; };
  const found = [row('CA', '777', '163W00000X', 'Registered Nurse'), row('CA', '777', '363LF0000X', 'Nurse Practitioner, Family'), row('NV', '9', '363LF0000X')];
  const np = mergeNpiLicenses([], found, { degreeType: 'NP', makeId: ids() });
  assert.deepEqual(np.map(l => [l.state, l.type]), [['CA', 'APRN License (NP)'], ['NV', 'APRN License (NP)'], ['CA', 'RN License']]);
  const md = mergeNpiLicenses([], found, { degreeType: 'MD', makeId: ids() });
  assert.deepEqual(md.map(l => [l.state, l.type]), [['CA', 'State Medical License'], ['NV', 'State Medical License']]);
  // Already on file: a hand-typed RN licence blocks only the RN row.
  const again = mergeNpiLicenses([{ state: 'CA', licenseNumber: '777', type: 'RN License' }], found, { degreeType: 'NP', makeId: ids() });
  assert.deepEqual(again.map(l => [l.state, l.type]), [['CA', 'APRN License (NP)'], ['NV', 'APRN License (NP)']]);
  // A PA licence imported earlier as a medical licence (while blank) is not duplicated.
  const pa = mergeNpiLicenses([{ state: 'TX', licenseNumber: 'PA1', type: 'State Medical License' }], [row('TX', 'PA1', '363A00000X')], { degreeType: 'PA', makeId: ids() });
  assert.deepEqual(pa, []);
  // A lone APRN row never invents an RN licence.
  assert.deepEqual(mergeNpiLicenses([], [row('TX', '5', '363L00000X')], { degreeType: 'NP', makeId: ids() }).map(l => l.type), ['APRN License (NP)']);
});

test('registry extraction keeps an RN row and an NP row with one number apart', () => {
  const result = { allTaxonomies: [
    { code: '363LF0000X', description: 'Nurse Practitioner, Family', license: '777', state: 'CA', isPrimary: true },
    { code: '163W00000X', description: 'Registered Nurse', license: '777', state: 'CA', isPrimary: false },
    { code: '207T00000X', description: 'Neurological Surgery', license: 'A1', state: 'CA', isPrimary: false },
    { code: '207X00000X', description: 'Orthopaedic Surgery', license: 'A1', state: 'CA', isPrimary: false },
  ] };
  assert.deepEqual(extractLicensesFromNPI(result).map(l => [l.licenseNumber, l.taxonomyCode]), [['777', '363LF0000X'], ['777', '163W00000X'], ['A1', '207T00000X']]);
});

test('vocabularies per profession; MD, DO and blank keep their lists', () => {
  assert.equal(types.getLicenseTypes('MD'), types.LICENSE_TYPES_MD);
  assert.equal(types.getLicenseTypes(''), types.LICENSE_TYPES_MD);
  assert.equal(types.getLicenseTypes('DO'), types.LICENSE_TYPES_DO);
  assert.equal(types.getLicenseTypes('PA'), types.LICENSE_TYPES_PA);
  assert.equal(types.getLicenseTypes('NP'), types.LICENSE_TYPES_NP);
  assert.equal(types.getCMECategories('PA'), types.CME_CATEGORIES_PA);
  assert.equal(types.getCMECategories('NP'), types.CME_CATEGORIES_NP);
  assert.equal(types.getCMECategories('MBBS'), types.CME_CATEGORIES_MD);
  assert.equal(types.getEducationTypes('PA'), types.EDUCATION_TYPES_PA);
  assert.equal(types.getEducationTypes('NP'), types.EDUCATION_TYPES_NP);
  assert.equal(types.getEducationTypes('DO'), types.EDUCATION_TYPES);
  assert.equal(types.getReferenceRelationships('MD'), types.REFERENCE_RELATIONSHIPS);
  assert.ok(types.getReferenceRelationships('NP').includes('Supervising/Collaborating Physician'));
  assert.ok(!types.REFERENCE_RELATIONSHIPS.includes('Supervising/Collaborating Physician'));
  assert.equal(types.getReferenceRelationships('PA').at(-1), 'Other');
  // Every PA and NP licence type has the kind its card needs.
  for (const t of types.LICENSE_TYPES_PA) if (/^(State Physician|Board Certification|Prescriptive|Practice)/.test(t)) assert.ok(licenseKindOf(t), t);
  for (const t of types.LICENSE_TYPES_NP) if (/^(APRN|RN|Board Certification|Prescriptive|Practice)/.test(t)) assert.ok(licenseKindOf(t), t);
  // Exams are passed once; certifications expire.
  assert.ok(types.isInherentlyNonExpiringLicense('PANCE') && types.isInherentlyNonExpiringLicense('NCLEX-RN'));
  assert.ok(!types.isInherentlyNonExpiringLicense('Board Certification (NCCPA)'));
  assert.ok(!types.NON_EXPIRING_LICENSE_TYPES.includes('PANCE'), 'the physician list is unchanged');
  // No self-assessment or PI-CME category: they are an entry attribute.
  assert.ok(!types.CME_CATEGORIES_PA.some(c => /self-assessment\b(?!\))|pi-cme/i.test(c.replace('(Category 1 Self-Assessment)', ''))));
  assert.deepEqual([...types.NCCPA_ACTIVITIES], ['Self-Assessment', 'PI-CME']);
});

test('topics: MD, DO and blank keep CME_TOPICS; PA and NP add the rule-data topics before General', () => {
  assert.equal(getCmeTopics('MD'), CME_TOPICS);
  assert.equal(getCmeTopics(''), CME_TOPICS);
  const np = getCmeTopics('NP');
  assert.ok(np.includes('Nutrition') && np.includes('Pharmacology'));
  assert.equal(np.at(-1), 'General / No Specific Topic');
});

test('email intake accepts every profession\'s vocabulary', () => {
  for (const t of [...types.LICENSE_TYPES_MD, ...types.LICENSE_TYPES_DO, ...types.LICENSE_TYPES_PA, ...types.LICENSE_TYPES_NP]) assert.ok(SECTION_TYPES.licenses.includes(t), t);
  for (const c of [...types.CME_CATEGORIES_PA, ...types.CME_CATEGORIES_NP]) assert.ok(SECTION_TYPES.cme.includes(c), c);
  assert.equal(new Set(SECTION_TYPES.licenses).size, SECTION_TYPES.licenses.length);
});

test('profession copy: MD and DO keep physician words; blank is physician in the app and neutral outside it', () => {
  for (const d of ['MD', 'DO']) {
    const c = professionCopy(d, { audience: 'third-party' });
    assert.equal(c.servicesPhrase, 'physician services');
    assert.equal(c.honorific, 'Dr.');
  }
  assert.equal(professionCopy('').profileHeading, 'Physician Profile');
  assert.equal(professionCopy('', { audience: 'third-party' }).servicesPhrase, 'clinical services');
  assert.equal(professionCopy('', { audience: 'third-party' }).honorific, '');
  assert.equal(professionCopy('PA').servicesPhrase, 'physician assistant services');
  assert.equal(professionCopy('NP').ceNoun, 'CE');
  assert.equal(professionCopy('NP').unit, 'contact hours');
  for (const d of ['PA', 'NP']) {
    const c = professionCopy(d);
    assert.equal(c.honorific, '');
    assert.equal(c.fallbackName, 'Clinician');
    assert.doesNotMatch(Object.values(c).join(' '), /[–—]/);
  }
});
