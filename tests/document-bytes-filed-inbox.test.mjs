// Review of release/goal2 (2026-10-02): filing or linking an emailed document
// rewrites its type from the inbox marker ("cme-certificate-inbox",
// "email-inbox") to its MIME type (inboxDocs leaveInbox). The file is the
// same, but a second device showing it compared the raw type when a load put
// the rows back (AppContext keepScreenFileBytes), dropped the bytes it held
// and downloaded the file again. Both now compare documentBytes storedFileOf,
// which reads the MIME type (the row's mimeType for an inbox document).
//
// Runs AppContext's own keepScreenFileBytes (cut from the source).
// Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { storedFileOf } from '../src/utils/documentBytes.js';

const source = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
const a = source.indexOf('  function keepScreenFileBytes(');
const b = source.indexOf('\n  }\n', a);
assert.ok(a > 0 && b > a, 'keepScreenFileBytes located');
const code = source.slice(a, b + 4);

const OWNER = 'user_syntheticFiled';
const FILE = 'data:application/pdf;base64,JVBERi0xLjQgc3ludGhldGlj';
const under = { stamp: null, fence: null };
function keep(onScreen, loaded) {
  const context = { storedFileOf, dataOwnerRef: { current: OWNER }, dataRef: { current: { documents: onScreen } },
    loadedDeletionRef: { current: under }, sameDeletionStamp: (x, y) => x === y };
  vm.runInNewContext(`${code}\nglobalThis.__keep = keepScreenFileBytes;`, context);
  return context.__keep(OWNER, { under }, under, loaded);
}
const inbox = { id: 'e1', name: 'synthetic-cert.pdf', type: 'cme-certificate-inbox', mimeType: 'application/pdf', size: 24, storagePath: `${OWNER}/e1` };

test('a file filed on another device keeps the bytes this device shows when the load brings the filed row', () => {
  const filed = { ...inbox, type: 'application/pdf', linkedTo: 'cme:c1' };
  const [got] = keep([{ ...inbox, data: FILE }], [filed]);
  assert.equal(got.data, FILE, 'not downloaded again: the same file');
  assert.equal(got.linkedTo, 'cme:c1');
});

test('must pass: a file given again on another device (another size or type) is not given the old bytes', () => {
  assert.equal(keep([{ ...inbox, data: FILE }], [{ ...inbox, size: 99 }])[0].data, undefined);
  assert.equal(keep([{ ...inbox, data: FILE }], [{ ...inbox, type: 'image/jpeg', mimeType: undefined }])[0].data, undefined);
});
