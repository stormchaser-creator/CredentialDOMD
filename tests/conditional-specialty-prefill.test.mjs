import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompliance, complianceFor } from '../src/utils/compliance.js';
import { specialtyPrefill, classifySpecialty, topicApplicability, conditionDescription, CA_GERIATRIC_FIELD, OHIO_PAIN_CLINIC_FIELD, NOT_SURE } from '../src/utils/conditionalCme.js';
import { getStateEntry } from '../src/constants/stateRequirements.js';

const geri = getStateEntry('CA', 'MD').topics.find(t => t.topic === 'Geriatric Medicine');
const ohio = getStateEntry('OH', 'MD').topics.find(t => t.condition);
const NS_DO = ['AOA-SUB:AOBS:Neurological Surgery'];
const NS_MD = ['ABMS:ABNS'];

test('specialties are read by board, including co-sponsored subspecialties', () => {
  assert.equal(classifySpecialty('ABMS:ABNS').kind, 'other');
  assert.equal(classifySpecialty('ABMS:ABIM').kind, 'imfm');
  assert.equal(classifySpecialty('AOA:AOBFP').kind, 'imfm');
  assert.equal(classifySpecialty('ABMS:NS').kind, 'unknown');
  assert.equal(classifySpecialty('AOA-SUB:AOBS:Neurological Surgery').kind, 'other');
  assert.equal(classifySpecialty('ABMS-SUB:ABA:Hospice & Palliative Medicine').kind === 'other', false, 'co-sponsored by ABIM or ABFM, or unknown');
  assert.equal(classifySpecialty('ABPS:Hospital Medicine').kind, 'imfm');
  assert.equal(classifySpecialty('UCNS:Neurocritical Care').kind, 'neutral');
});

test('only a settling specialty set prefills No, and only for the California geriatric rule', () => {
  assert.deepEqual(specialtyPrefill(geri.condition, NS_MD)?.specialties, ['Neurological Surgery']);
  assert.equal(specialtyPrefill(geri.condition, NS_DO).answer, 'No');
  assert.equal(specialtyPrefill(geri.condition, [...NS_MD, 'ABMS:ABIM']), null, 'any internal medicine board leaves it open');
  assert.equal(specialtyPrefill(geri.condition, ['ABMS:ABFM']), null);
  assert.equal(specialtyPrefill(geri.condition, [...NS_MD, 'ABMS:NS']), null, 'an unrecognized id settles nothing');
  assert.equal(specialtyPrefill(geri.condition, ['UCNS:Neurocritical Care']), null, 'a secondary cert alone settles nothing');
  assert.equal(specialtyPrefill(geri.condition, []), null);
  assert.equal(specialtyPrefill(ohio.condition, NS_MD), null, 'pain clinic work is not a specialty fact');
});

test('a stored answer always wins over the prefill', () => {
  assert.equal(topicApplicability(geri, {}, NS_MD), 'not-applicable');
  assert.equal(topicApplicability(geri, { [CA_GERIATRIC_FIELD]: 'Yes' }, NS_MD), 'applies');
  assert.equal(topicApplicability(geri, { [CA_GERIATRIC_FIELD]: NOT_SURE }, NS_MD), 'unknown');
  assert.equal(topicApplicability(geri, { [CA_GERIATRIC_FIELD]: '' }, NS_MD), 'not-applicable');
  assert.equal(topicApplicability(geri, {}, ['ABMS:ABIM']), 'unknown');
  assert.equal(topicApplicability(ohio, {}, NS_MD), 'unknown');
  assert.equal(OHIO_PAIN_CLINIC_FIELD, ohio.condition.field);
});

test('engine: prefilled row is not applicable, says where it came from, and clears applicabilityUnknown', () => {
  const opts = { licenseExpiration: '2027-09-30', topicApplicability: {} };
  const plain = computeCompliance([], 'CA', 'MD', opts);
  const pre = computeCompliance([], 'CA', 'MD', { ...opts, specialties: NS_MD });
  const rowPlain = plain.conditionalTopics.find(t => t.topic === 'Geriatric Medicine');
  const rowPre = pre.conditionalTopics.find(t => t.topic === 'Geriatric Medicine');
  assert.equal(rowPlain.applicability, 'unknown');
  assert.equal('applicabilitySource' in rowPlain, false, 'unused feature leaves the row unchanged');
  assert.equal(plain.applicabilityUnknown, true);
  assert.equal(rowPre.applicability, 'not-applicable');
  assert.equal(rowPre.applicabilitySource, 'specialty');
  assert.deepEqual(rowPre.applicabilityPrefill.specialties, ['Neurological Surgery']);
  assert.equal(pre.applicabilityUnknown, false);
  assert.ok(!pre.topicResults.some(t => t.topic === 'Geriatric Medicine'));
  assert.ok(!/does not infer it from your specialty/.test(conditionDescription(rowPre)));
  assert.equal(conditionDescription(rowPlain), rowPlain.condition.description);
  const explicitNo = computeCompliance([], 'CA', 'MD', { ...opts, topicApplicability: { [CA_GERIATRIC_FIELD]: 'No' }, specialties: NS_MD });
  assert.equal('applicabilitySource' in explicitNo.conditionalTopics.find(t => t.topic === 'Geriatric Medicine'), false, 'an explicit No is the physician\'s own');
});

test('complianceFor reads specialties from settings and the license answer', () => {
  const lic = { id: 'l', type: 'State Medical License (DO)', state: 'CA', expirationDate: '2027-09-30' };
  const data = { cme: [], settings: { degreeType: 'DO', specialties: NS_DO }, licenses: [lic] };
  assert.equal(complianceFor(data, 'CA').conditionalTopics.find(t => t.topic === 'Geriatric Medicine').applicability, 'not-applicable');
  const yes = { ...data, licenses: [{ ...lic, customFields: { [CA_GERIATRIC_FIELD]: 'Yes' } }] };
  assert.ok(complianceFor(yes, 'CA').topicResults.some(t => t.topic === 'Geriatric Medicine'));
});
