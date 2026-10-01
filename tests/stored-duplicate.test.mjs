// A renamed copy of a stored document is a duplicate even before the stored
// file's bytes are back on this device (QA DOCS-001, 2026-10-01: after a
// reload the copy was picked while the stored file was still downloading and
// was saved as a second document).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findStoredDuplicate } from '../src/utils/storedDuplicate.js';

const bytes = (text) => new Blob([new TextEncoder().encode(text)]);
const file = (text, name = 'copy.pdf') => Object.assign(bytes(text), { name });
const stored = (id, text, extra = {}) => ({ id, name: `${id}.pdf`, size: new TextEncoder().encode(text).length, storagePath: `user_x/${id}`, ...extra });

test('a renamed copy matches a stored document whose bytes are not on the device', async () => {
  const docs = [stored('a', 'PDF-1 synthetic A'), stored('b', 'PDF-1 synthetic B')];
  const files = { 'user_x/a': bytes('PDF-1 synthetic A'), 'user_x/b': bytes('PDF-1 synthetic B') };
  const asked = [];
  const dup = await findStoredDuplicate(docs, file('PDF-1 synthetic B'), { download: async (p) => { asked.push(p); return files[p]; } });
  assert.equal(dup?.id, 'b');
  assert.deepEqual(asked, ['user_x/a', 'user_x/b'], 'both same-size candidates are compared, in order');
});

test('only stored documents of the same size, without bytes in memory, are fetched', async () => {
  const docs = [
    stored('other-size', 'a longer synthetic file body'),
    stored('in-memory', 'PDF-1 synthetic C', { data: 'data:application/pdf;base64,AAAA' }),
    stored('missing', 'PDF-1 synthetic C', { fileMissing: true }),
    { id: 'device-only', name: 'd.pdf', size: 17, data: null },
  ];
  const asked = [];
  const dup = await findStoredDuplicate(docs, file('PDF-1 synthetic C'), { download: async (p) => { asked.push(p); return null; } });
  assert.equal(dup, null);
  assert.deepEqual(asked, []);
});

test('the same size with different bytes is not a duplicate', async () => {
  const docs = [stored('a', 'PDF-1 synthetic A')];
  const dup = await findStoredDuplicate(docs, file('PDF-1 synthetic Z'), { download: async () => bytes('PDF-1 synthetic A') });
  assert.equal(dup, null);
});

test('a download that fails or throws leaves the pick to go ahead', async () => {
  const docs = [stored('a', 'PDF-1 synthetic A'), stored('b', 'PDF-1 synthetic A')];
  let n = 0;
  const dup = await findStoredDuplicate(docs, file('PDF-1 synthetic A'), { download: async () => { n += 1; if (n === 1) throw new Error('offline'); return null; } });
  assert.equal(dup, null);
  assert.equal(n, 2);
});

test('a size read from size_bytes (sizeBytes) counts as the size', async () => {
  const docs = [{ id: 'a', name: 'a.pdf', sizeBytes: 17, storagePath: 'user_x/a' }];
  const dup = await findStoredDuplicate(docs, file('PDF-1 synthetic A'), { download: async () => bytes('PDF-1 synthetic A') });
  assert.equal(dup?.id, 'a');
});

test('Documents uploads ask for a stored duplicate before anything is read or stored', () => {
  const src = readFileSync(new URL('../src/components/features/DocumentsSection.jsx', import.meta.url), 'utf8');
  const handle = src.slice(src.indexOf('const handleFiles = useCallback('));
  const check = handle.indexOf('findStoredDuplicate(data.documents, file, { download: downloadDocumentBlob })');
  assert.ok(check > 0, 'handleFiles uses findStoredDuplicate with the Storage download');
  assert.ok(check < handle.indexOf('if (dup) {'), 'before the duplicate refusal');
  assert.ok(check < handle.indexOf('readScan('), 'before the file is sent to be read');
});
