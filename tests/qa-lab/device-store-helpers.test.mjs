// The QA lab's journeys read what the app keeps on the device. The offline
// copy of the file lives in IndexedDB now, and a landed write removes its
// localStorage copy: journeys that read localStorage alone failed for a copy
// that was fine (Answer Bank retention, the four-upload overflow check), or
// scanned nothing and passed (the SSN/date of birth privacy gate, Sign out).
// The helpers read both stores, as the app does; the specs use them.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryIndexedDB, QuotaLocalStorage } from '../helpers/memory-indexeddb.mjs';
import { readDeviceTextInPage, writeDeviceTextInPage, scanDeviceInPage, deviceStoreKeysInPage } from '../../qa-lab/e2e/support/device-store.mjs';

const U = 'user_syntheticQaDevice';
const KEY = `credentialdomd-data:${U}`;
const SSN = '000-00-0000';

function device() {
  globalThis.localStorage = new QuotaLocalStorage();
  globalThis.indexedDB = createMemoryIndexedDB();
  return globalThis.indexedDB;
}

test('the helpers read the offline copy from IndexedDB when localStorage has none, and localStorage first when it has one', async () => {
  device();
  assert.equal(await readDeviceTextInPage(KEY), null);
  await writeDeviceTextInPage([KEY, JSON.stringify({ answerBank: [{ id: 'answer-synthetic-qa' }] })]);
  assert.equal(localStorage.getItem(KEY), null, 'written where the app keeps it');
  assert.equal(localStorage.getItem(`credentialdomd-offline-home:${U}`), '1');
  assert.deepEqual(JSON.parse(await readDeviceTextInPage(KEY)).answerBank, [{ id: 'answer-synthetic-qa' }]);
  localStorage.setItem(KEY, JSON.stringify({ answerBank: [] }));
  assert.deepEqual(JSON.parse(await readDeviceTextInPage(KEY)).answerBank, [], 'a localStorage copy outranks it, as in the app');
});

test('the privacy scan and the Sign out check see what is in IndexedDB', async () => {
  device();
  localStorage.setItem('unrelated', 'nothing here');
  await writeDeviceTextInPage([KEY, JSON.stringify({ identityVault: [{ id: 'identity-synthetic-qa', ssn: SSN }] })]);
  assert.deepEqual(await scanDeviceInPage([SSN]), [`indexeddb:${KEY}`]);
  localStorage.setItem(`credentialdomd-private-vault:${U}`, `note ${SSN}`);
  assert.deepEqual((await scanDeviceInPage([SSN])).sort(), [`credentialdomd-private-vault:${U}`, `indexeddb:${KEY}`].sort());
  assert.deepEqual(await deviceStoreKeysInPage(U), [KEY]);
  assert.deepEqual(await deviceStoreKeysInPage('user_syntheticSomeoneElse'), []);
});

test('the four journeys read the device through the helpers, not localStorage alone', () => {
  const spec = (name) => readFileSync(new URL(`../../qa-lab/e2e/${name}`, import.meta.url), 'utf8');
  const sync = spec('sync-docs-intake-sync-data.spec.mjs');
  assert.doesNotMatch(sync, /localStorage\.getItem\(`credentialdomd-data:/);
  assert.match(sync, /readDeviceJSON\(page, `credentialdomd-data:\$\{uid\}`\)/);
  assert.match(sync, /offline copy was not updated/, 'the overflow gate matches the warning this build prints');
  const categories = spec('cred-categories.spec.mjs');
  assert.doesNotMatch(categories, /localStorage\.(get|set)Item\((key|`credentialdomd-data)/);
  assert.match(categories, /readDeviceJSON\(page, deviceKey\)/);
  assert.match(categories, /writeDeviceText\(page, deviceKey/);
  const special = spec('credentials-special.spec.mjs');
  assert.match(special, /scanDevice\(page, \[SSN, DOB\]\)/);
  assert.doesNotMatch(special, /Object\.entries\(localStorage\)/);
  const sync2 = spec('device-sync.spec.mjs');
  assert.match(sync2, /idb: await deviceStoreKeys\(page, id\)/);
  assert.match(sync2, /keysAfter\.idb\.length === 0/);
});
