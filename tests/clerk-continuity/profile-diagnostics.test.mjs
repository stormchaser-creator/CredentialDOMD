import test from 'node:test';
import assert from 'node:assert/strict';
import { profileInitializationError, profileSupportReference } from '../../src/utils/profileIssueDiagnostics.js';

test('untrusted strings and invalid statuses cannot become a support reference', () => {
  for (const status of ['401-private', 403.5, 0, 600, NaN, Infinity]) {
    const error = profileInitializationError('private@example.test', { code: 'raw provider details', httpStatus: status });
    assert.equal(profileSupportReference(error), 'ID-UNKNOWN-UNKNOWN');
    assert.equal(JSON.stringify(error).includes('private'), false);
  }
  assert.equal(profileSupportReference({ profileStage: 'profile', profileCauseCode: '42501', httpStatus: 403 }), 'ID-PROFILE-42501-H403');
  assert.equal(profileSupportReference({ code: 'continuity_retirement_unavailable' }), 'ID-PURGE-RETIREMENT_UNAVAILABLE');
});

test('browser exception names are reduced to fixed codes without exposing their messages', () => {
  const error = profileInitializationError('recovery', new DOMException('private browser storage value', 'SecurityError'));
  assert.equal(profileSupportReference(error), 'ID-RECOVER-BROWSER_SECURITY');
  assert.equal(JSON.stringify(error).includes('private'), false);
  assert.equal(profileSupportReference(profileInitializationError('binding', new TypeError('private value'))), 'ID-BIND-BROWSER_TYPE');
});
