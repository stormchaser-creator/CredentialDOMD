// Real storage readers, including legacy secret migration, against a local
// memory store. Purges run at async read boundaries; no shared database or
// browser session is involved. SOURCE_ROOT permits an original-source
// counterfactual without modifying the checkout under verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.PURGE_REVIEW_SOURCE_ROOT || testRoot;
const cache = join(testRoot, 'node_modules/.cache/credentialdomd-purge-read-review');
mkdirSync(cache, { recursive: true });
const abs = relative => JSON.stringify(pathToFileURL(resolve(sourceRoot, 'src/utils', relative)).href);
const source = readFileSync(resolve(sourceRoot, 'src/utils/storage.js'), 'utf8')
  .replace('import.meta.env.VITE_GEMINI_API_KEY || ""', '""')
  .replace('from "../constants/defaults"', `from ${abs('../constants/defaults.js')}`)
  .replace('from "./storageScope"', `from ${abs('./storageScope.js')}`)
  .replace('from "../lib/supabase"', `from ${abs('../lib/supabase.js')}`);
const file = join(cache, `storage-${process.pid}.mjs`);
writeFileSync(file, source);
const values = new Map();
let onRead = null;
globalThis.localStorage = {
  getItem(key) { const value = values.get(key) ?? null; onRead?.(key); return value; },
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  key: index => [...values.keys()][index] ?? null, get length() { return values.size; },
};
globalThis.window = {};
const storage = await import(pathToFileURL(file));
const scope = await import(pathToFileURL(resolve(sourceRoot, 'src/utils/storageScope.js')));
const dataDeletion = await import(pathToFileURL(resolve(sourceRoot, 'src/utils/dataDeletion.js')));
const blob = () => ({ settings: { name: 'Synthetic Physician', apiKey: 'synthetic-legacy-key' },
  licenses: [{ id: 'synthetic-license', number: 'SYNTHETIC-ONLY' }],
  identityVault: [{ id: 'synthetic-private', label: 'Synthetic device-only identity' }] });
async function seed(accountId) {
  onRead = null;
  scope.setActiveUserId(accountId); scope.adoptLocalFence(accountId);
  await scope.hydrateOfflineStores(accountId);
  const key = scope.scopedKey(scope.BASE_KEYS.data, accountId);
  values.set(key, JSON.stringify(blob()));
  return key;
}
function purgeWhenRead(key, purge) {
  let purging;
  onRead = observed => {
    if (observed !== key) return;
    onRead = null;
    queueMicrotask(() => { purging = purge(); });
  };
  return async () => { assert.ok(purging, 'the read crossed the deliberate purge boundary'); await purging; };
}

test('a raw offline read crossing sign-out returns no pre-purge bytes or successful receipt', async () => {
  const account = 'user_syntheticRawPurge', key = await seed(account), receipt = {};
  const finish = purgeWhenRead(key, () => scope.purgeForSignOut(account));
  const found = await scope.readOfflineFile(account, receipt);
  await finish();
  assert.equal(found, null);
  assert.equal(receipt.read, false);
  assert.equal(receipt.token, null);
  assert.equal(values.has(key), false);
});

test('sign-out during a legacy cache read never restores sanitized records or device keys', async () => {
  const account = 'user_syntheticSanitizePurge', key = await seed(account), receipt = {};
  const neighbour = scope.scopedKey(scope.BASE_KEYS.data, 'user_syntheticNeighbour');
  values.set(neighbour, 'synthetic neighbour untouched');
  const finish = purgeWhenRead(key, () => scope.purgeForSignOut(account));
  const found = await storage.readCachedData(account, receipt);
  await finish();
  assert.equal(found, null);
  assert.equal(receipt.read, false);
  assert.equal(receipt.token, null);
  assert.equal(values.has(key), false, 'the sanitizer must not recreate a purged cache');
  assert.equal(values.has(scope.scopedKey(scope.DEVICE_KEYS_BASE, account)), false);
  assert.equal(values.get(neighbour), 'synthetic neighbour untouched');
});

test('a purge after the inner read finished still fences the outer sanitizer and its returned data', async () => {
  const account = 'user_syntheticOuterPurge', key = await seed(account);
  let read = false, purging, scheduled = false;
  const receipt = { get read() { return read; }, set read(value) {
    read = value;
    if (value && !scheduled) { scheduled = true; queueMicrotask(() => { purging = scope.purgeForSignOut(account); }); }
  } };
  const found = await storage.readCachedData(account, receipt);
  assert.ok(purging, 'the inner reader succeeded before sign-out ran');
  await purging;
  assert.equal(found, null);
  assert.equal(receipt.read, false);
  assert.equal(receipt.token, null);
  assert.equal(values.has(key), false);
  assert.equal(values.has(scope.scopedKey(scope.DEVICE_KEYS_BASE, account)), false);
});

test('a server deletion during a cached read does not return or recreate the deleted copy', async () => {
  const account = 'user_syntheticServerPurge', key = await seed(account), receipt = {};
  const stamp = '2026-09-30T23:00:00.000Z';
  const finish = purgeWhenRead(key, () => dataDeletion.honorAccountDataDeletion(account, stamp));
  const found = await storage.readCachedData(account, receipt);
  await finish();
  assert.equal(found, null);
  assert.equal(receipt.read, false);
  assert.equal(values.has(key), false);
  assert.equal(dataDeletion.dataDeletionHonored(account, stamp), true);
});

test('an uninterrupted legacy read still migrates device keys and keeps the sanitized account copy', async () => {
  const account = 'user_syntheticNormalRead', key = await seed(account), receipt = {};
  const found = await storage.readCachedData(account, receipt);
  assert.equal(receipt.read, true);
  assert.equal(found.licenses[0].number, 'SYNTHETIC-ONLY');
  assert.equal(Object.hasOwn(found.settings, 'apiKey'), true, 'defaults still supply an empty public settings field');
  assert.equal(found.settings.apiKey, '');
  assert.equal(JSON.parse(values.get(key)).settings.apiKey, undefined);
  assert.equal(JSON.parse(values.get(scope.scopedKey(scope.DEVICE_KEYS_BASE, account))).apiKey, 'synthetic-legacy-key');
});

test('another account purge cancels a read without letting a cloud-only save replace the unread local file', async () => {
  const account = 'user_syntheticNeighbouringRead', key = await seed(account), receipt = {};
  const original = values.get(key);
  const finish = purgeWhenRead(key, () => scope.purgeForSignOut('user_syntheticOtherPurge'));
  assert.equal(await storage.readCachedData(account, receipt), null);
  await finish();
  assert.equal(receipt.read, false);
  assert.equal(scope.offlineCopyUnread(account), true);
  assert.equal(await storage.saveData({ settings: { name: 'Synthetic cloud-only' }, licenses: [] }, account), false);
  assert.equal(values.get(key), original, 'a canceled read is not an empty device copy');
  const retryReceipt = {};
  const retry = await storage.readCachedData(account, retryReceipt);
  assert.equal(retry.licenses[0].number, 'SYNTHETIC-ONLY');
  assert.equal(retry.identityVault[0].id, 'synthetic-private');
  assert.equal(scope.markOfflineCopyRead(account, retryReceipt), true);
  assert.equal(scope.offlineCopyUnread(account), false);
  assert.equal(await storage.saveData(retry, account), true);
});
