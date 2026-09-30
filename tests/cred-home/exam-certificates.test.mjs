// USMLE, COMLEX and an ECFMG Certificate never expire: they save without a
// date, are never chased for one and never become a "resolve" task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseFields } from '../../src/utils/credentialForms.js';
import { isNonExpiring } from '../../src/utils/helpers.js';
import { dateUnknownApplies, needsResolution, normalizeLifecycle } from '../../src/utils/lifecycle.js';
import { isInherentlyNonExpiringLicense } from '../../src/constants/credentialTypes.js';

const EXAMS = ['USMLE', 'COMLEX', 'ECFMG Certificate'];
const expires = licenseFields({ degreeType: 'DO' }).find(f => f.key === 'expirationDate');

test('each exam or certificate type saves without an expiration date', () => {
  for (const type of EXAMS) {
    assert.equal(isInherentlyNonExpiringLicense(type), true, type);
    assert.equal(expires.required({ type }), false, type);
  }
  assert.equal(expires.required({ type: 'State Medical License (DO)' }), true, 'a licence still needs one');
});

test('it is not listed as missing a date and never becomes a resolve task', () => {
  for (const type of EXAMS) {
    const rec = { id: type, type };
    assert.equal(isNonExpiring(rec, 'licenses'), true, type);
    assert.equal(dateUnknownApplies('licenses', rec), false, type);
    assert.equal(needsResolution({ ...rec, dateUnknown: true }, 'licenses'), false, `${type} with a leftover "not yet known"`);
  }
});

test('the save path treats them like a course certification', () => {
  const out = normalizeLifecycle('licenses', { id: 'u', type: 'USMLE', dateUnknown: true, noExpiration: true });
  assert.equal(out.dateUnknown, false, '"not yet known" does not apply');
  assert.equal(out.noExpiration, true);
});
