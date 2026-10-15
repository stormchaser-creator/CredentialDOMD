import test from 'node:test';
import assert from 'node:assert/strict';
import { findDocumentDuplicate } from '../src/utils/documentDuplicate.js';

const url = (text, mime = 'application/pdf') => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
const file = { name: 'renamed.pdf', size: 4 };
const stored = { id: 'doc-one', name: 'original.pdf', size: 4, storagePath: 'synthetic/doc-one' };

test('in-memory bytes match independently of MIME headers and preserve name/size fast checks', async () => {
  const row = { ...stored, data: url('same', 'application/octet-stream') };
  assert.equal((await findDocumentDuplicate([row], file, url('same'))).duplicate, row);
  assert.equal((await findDocumentDuplicate([stored], { ...file, name: stored.name }, url('else'))).duplicate, stored);
});

test('different same-size remote bytes pass, and differently sized stored rows are never fetched', async () => {
  const calls = [];
  const result = await findDocumentDuplicate([{ ...stored, size: 5 }, stored], file, url('new!'), {
    downloadBlob: async (path, options) => { calls.push([path, options.detail]); return { blob: new Blob(['old!']) }; },
  });
  assert.deepEqual(result, { duplicate: null });
  assert.deepEqual(calls, [[stored.storagePath, true]]);
});

for (const kind of ['network', 'missing', 'no-path']) test(`an unavailable ${kind} candidate is not treated as a different document`, async () => {
  const row = kind === 'no-path' ? { ...stored, storagePath: undefined } : stored;
  const result = await findDocumentDuplicate([row], file, url('same'), {
    downloadBlob: async () => { if (kind === 'network') throw Error('synthetic network failure'); return { missing: true }; },
  });
  assert.equal(result.unavailable, row);
});

test('a later confirmed duplicate can still be found after an unavailable candidate', async () => {
  const match = { ...stored, id: 'doc-two', storagePath: 'synthetic/doc-two' };
  const result = await findDocumentDuplicate([stored, match], file, url('same'), {
    downloadBlob: async path => path === match.storagePath ? { blob: new Blob(['same']) } : { failed: true },
  });
  assert.equal(result.duplicate, match);
});

for (const phase of ['download', 'blob-read']) test(`a hung ${phase} times out and aborts without accepting an unchecked upload`, async () => {
  let signal;
  const result = await findDocumentDuplicate([stored], file, url('same'), { timeoutMs: 10,
    downloadBlob: async (_path, options) => {
      signal = options.signal;
      if (phase === 'download') return new Promise(() => {});
      return { blob: { arrayBuffer: () => new Promise(() => {}) } };
    },
  });
  assert.equal(result.unavailable, stored);
  assert.equal(signal.aborted, true);
});

test('ownership is checked before any file read and after delayed byte decoding', async () => {
  let calls = 0;
  assert.deepEqual(await findDocumentDuplicate([stored], file, url('same'), {
    isCurrent: () => false, downloadBlob: () => { calls++; },
  }), { cancelled: true });
  assert.equal(calls, 0);
  let current = true;
  const result = await findDocumentDuplicate([stored], file, url('same'), {
    isCurrent: () => current,
    downloadBlob: async () => ({ blob: { arrayBuffer: async () => { current = false; return new TextEncoder().encode('same').buffer; } } }),
  });
  assert.deepEqual(result, { cancelled: true });
});
