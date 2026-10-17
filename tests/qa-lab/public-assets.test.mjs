import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../../qa-lab/lib/paths.mjs';
import { prepareQaPublicAssets } from '../../qa-lab/lib/public-assets.mjs';

test('fresh QA checkout prepares the pinned renderer, worker and fonts before serving PDF previews', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'credentialdomd-qa-pdf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'node_modules'));
  copyFileSync(path.join(REPO_ROOT, 'scripts/build-credential-portal.mjs'), path.join(root, 'scripts/build-credential-portal.mjs'));
  copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  assert.throws(() => prepareQaPublicAssets({ root, quiet: true }), /QA PDF assets could not be prepared/);
  symlinkSync(path.join(REPO_ROOT, 'node_modules/pdfjs-dist'), path.join(root, 'node_modules/pdfjs-dist'), 'dir');
  const output = path.join(root, 'public/credential-access/vendor');
  assert.equal(existsSync(path.join(output, 'pdf.min.mjs')), false);
  prepareQaPublicAssets({ root, quiet: true });
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json')));
  assert.equal(manifest.version, JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'))).dependencies['pdfjs-dist']);
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const bytes = readFileSync(path.join(output, name));
    assert.deepEqual(bytes, readFileSync(path.join(REPO_ROOT, 'node_modules/pdfjs-dist/build', name)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[name]);
  }
  assert.ok(Object.keys(manifest.files).some(name => name.startsWith('standard_fonts/')));
  writeFileSync(path.join(output, 'stale-renderer.mjs'), 'obsolete');
  prepareQaPublicAssets({ root, quiet: true });
  assert.equal(existsSync(path.join(output, 'stale-renderer.mjs')), false);
});
