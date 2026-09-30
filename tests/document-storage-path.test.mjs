// A document uploaded this session knows where its file went (SHARE-003).
//
// insertItem uploaded the file and wrote storage_path on the row, but the
// document on the device never learned it, so until the next reload the
// email sheet labelled every file uploaded this session "still uploading
// to your account" after the upload had finished. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, TARGET } from './supabase-fixture.mjs';
import { withStoragePath } from '../src/utils/docStoragePath.js';

const doc = { id: 'doc-1', name: 'license.pdf', type: 'application/pdf', size: 3, data: 'data:application/pdf;base64,YWJj', linkedTo: '' };

test('insertItem answers with the storage path once the file and its row are both saved', async () => {
  const f = fixture();
  assert.equal(await f.api.insertItem('profileA', 'documents', doc), `${TARGET}/doc-1`);
});

test('a failed row insert (queued) or a failed upload answers null', async () => {
  const f = fixture();
  f.onRequest = async (op) => (op.table === 'documents' ? { error: { message: 'synthetic failure' } } : { error: null });
  assert.equal(await f.api.insertItem('profileA', 'documents', doc), null);
  const g = fixture();
  g.onRequest = async (op) => (op.method === 'upload' ? { error: { message: 'synthetic failure' } } : { error: null });
  assert.equal(await g.api.insertItem('profileA', 'documents', doc), null);
});

test('withStoragePath sets the path on the one document, and only while it is there without one', () => {
  const docs = [doc, { ...doc, id: 'doc-2' }];
  const next = withStoragePath(docs, 'doc-1', `${TARGET}/doc-1`);
  assert.equal(next[0].storagePath, `${TARGET}/doc-1`);
  assert.equal(next[1], docs[1], 'the others are untouched');
  assert.equal(next[0].updatedAt, undefined, 'no edit stamp: a path is not an edit');
  assert.equal(withStoragePath(docs, 'gone', 'x'), docs, 'a document deleted meanwhile (the patient-record screen) is not brought back');
  const has = [{ ...doc, storagePath: 'user_other/doc-1' }];
  assert.equal(withStoragePath(has, 'doc-1', `${TARGET}/doc-1`), has, 'a path already known is kept');
});

test('AppContext records the path from insertItem through updateSection, never editItem', async () => {
  const src = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
  const i = src.indexOf('const addItem = useCallback');
  const block = src.slice(i, src.indexOf('}, [updateSection]);', i));
  assert.match(block, /withStoragePath\(/);
  assert.match(block, /updateSection\("documents"/);
  assert.doesNotMatch(block, /editItem\(/);
});
