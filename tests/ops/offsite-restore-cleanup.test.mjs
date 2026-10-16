// Default restores must remove plaintext even when decrypting or loading metadata fails.
// Synthetic files and an injected extractor only; never reads Keychain or backup data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadArchive } from '../../scripts/offsite-restore.mjs';

const metadata = {
  'manifest.json': { format: 1, tables: {} },
  'schema/ddl.json': { statements: [], counts: {}, sections: [] },
  'schema/tables.json': {},
  'objects-index.json': { objects: {} },
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function dependencies(root, failure) {
  return {
    tmpRoot: root,
    getPassphrase: async () => {
      if (failure === 'passphrase') throw new Error('synthetic passphrase read failure');
      return 'synthetic-only';
    },
    extract: async (_archive, dir, passphrase) => {
      assert.equal(passphrase, 'synthetic-only');
      await fs.writeFile(path.join(dir, 'synthetic-private.txt'), 'Synthetic plaintext only');
      if (failure === 'decrypt') throw new Error('synthetic truncated archive');
      await fs.mkdir(path.join(dir, 'schema'));
      for (const [name, value] of Object.entries(metadata)) {
        if (name === failure) continue;
        await fs.writeFile(path.join(dir, name), JSON.stringify(value));
      }
    },
  };
}
for (const failure of ['passphrase', 'decrypt', ...Object.keys(metadata)]) {
  test(`failed restore removes plaintext when ${failure} fails`, async t => {
    const root = await fixture(t);
    await assert.rejects(loadArchive('synthetic.tar.enc', false, dependencies(root, failure)));
    assert.deepEqual(await fs.readdir(root), [], 'no incomplete plaintext directory remains');
  });
}
test('a successful load returns its private directory for the main restore lifecycle', async t => {
  const root = await fixture(t);
  const loaded = await loadArchive('synthetic.tar.enc', false, dependencies(root));
  assert.equal((await fs.stat(loaded.tmp)).mode & 0o777, 0o700);
  assert.deepEqual(loaded.manifest, metadata['manifest.json']);
  assert.deepEqual(loaded.ddl, metadata['schema/ddl.json']);
  assert.equal(await fs.readFile(path.join(loaded.tmp, 'synthetic-private.txt'), 'utf8'), 'Synthetic plaintext only');
  await fs.rm(loaded.tmp, { recursive: true });
  assert.deepEqual(await fs.readdir(root), []);
});
test('an explicit keep-temp request retains an incomplete directory for operator review', async t => {
  const root = await fixture(t);
  await assert.rejects(loadArchive('synthetic.tar.enc', true, dependencies(root, 'manifest.json')));
  const entries = await fs.readdir(root);
  assert.equal(entries.length, 1);
  assert.equal(await fs.readFile(path.join(root, entries[0], 'synthetic-private.txt'), 'utf8'), 'Synthetic plaintext only');
});
