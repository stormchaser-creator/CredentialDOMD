// A stored document is read from its bytes on the device, or from Storage when
// they are not there yet (QA CV-001, 2026-10-01: Setup's CV reader said "That
// PDF could not be read" for the CV already in Files, picked before its bytes
// were fetched back after a reload).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storedDataUrl } from '../src/utils/storedBytes.js';

const URL_A = 'data:application/pdf;base64,JVBERi0xLjQKc3ludGhldGlj';

test('bytes on the device are used without a download', async () => {
  let asked = 0;
  assert.deepEqual(await storedDataUrl({ data: URL_A, storagePath: 'user_x/a' }, { download: async () => { asked++; return null; } }), { dataUrl: URL_A });
  assert.equal(asked, 0);
});

test('a stored document without bytes on the device is fetched from Storage', async () => {
  const calls = [];
  const got = await storedDataUrl({ id: 'a', storagePath: 'user_x/a' }, { download: async (p, o) => { calls.push([p, o]); return { dataUrl: URL_A }; } });
  assert.deepEqual(got, { dataUrl: URL_A });
  assert.deepEqual(calls, [['user_x/a', { detail: true }]]);
});

test('a missing file, a failed fetch, a throw, or no stored copy are told apart from a read', async () => {
  assert.deepEqual(await storedDataUrl({ storagePath: 'p' }, { download: async () => ({ missing: true }) }), { missing: true });
  assert.deepEqual(await storedDataUrl({ storagePath: 'p' }, { download: async () => ({ failed: true }) }), { failed: true });
  assert.deepEqual(await storedDataUrl({ storagePath: 'p' }, { download: async () => { throw new Error('offline'); } }), { failed: true });
  assert.deepEqual(await storedDataUrl({ id: 'device-only' }, { download: async () => ({ dataUrl: URL_A }) }), { failed: true });
});

test('Setup\'s CV reader reads a file already in Files through storedDataUrl', () => {
  const src = readFileSync(new URL('../src/components/features/CvImportReview.jsx', import.meta.url), 'utf8');
  assert.match(src, /storedDataUrl\(d, \{ download: downloadDocumentFile \}\)/);
  assert.match(src, /onClick=\{\(\) => readStored\(d\)\}/);
  assert.doesNotMatch(src, /read\(\{ dataUrl: d\.data/, 'the stored file is never read from d.data alone');
});
