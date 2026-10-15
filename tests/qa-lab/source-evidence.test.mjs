import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appEvidenceProblem, captureSource } from '../../qa-lab/lib/source-evidence.mjs';

test('source evidence detects uncommitted/new/deleted app inputs without exposing contents; backend changes keep app fingerprint', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-source-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init']); git(['config', 'user.email', 'qa@example.test']); git(['config', 'user.name', 'QA']);
  mkdirSync(path.join(root, 'src')); writeFileSync(path.join(root, 'src/a.js'), 'original');
  writeFileSync(path.join(root, '.gitignore'), 'ignored\n'); git(['add', '.']); git(['commit', '-m', 'fixture']);
  const base = captureSource(root); assert.equal(base.dirty, false);
  writeFileSync(path.join(root, 'ignored'), 'ignored secret'); assert.deepEqual(captureSource(root), base);
  writeFileSync(path.join(root, 'src/a.js'), 'changed secret'); const changed = captureSource(root);
  assert.notEqual(changed.appFingerprint, base.appFingerprint); assert.equal(changed.dirty, true);
  assert.ok(!JSON.stringify(changed).includes('secret'));
  writeFileSync(path.join(root, 'backend.sql'), 'backend'); const backend = captureSource(root);
  assert.notEqual(backend.fingerprint, changed.fingerprint); assert.equal(backend.appFingerprint, changed.appFingerprint);
  writeFileSync(path.join(root, 'src/new.js'), 'new'); const added = captureSource(root);
  assert.notEqual(added.appFingerprint, backend.appFingerprint);
  rmSync(path.join(root, 'src/a.js')); assert.notEqual(captureSource(root).appFingerprint, added.appFingerprint);
  for (const name of ['supabase/functions/_shared/imported.js', 'scripts/build-input.mjs']) {
    const before = captureSource(root);
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'shared build input');
    assert.notEqual(captureSource(root).appFingerprint, before.appFingerprint, name);
  }

});

test('stale, unrecorded and dev builds cannot be reported as verified preview source', () => {
  const source = { appFingerprint: 'a' };
  assert.match(appEvidenceProblem({ mode: 'dev' }, source), /production-mode/);
  assert.match(appEvidenceProblem({ mode: 'preview' }, source), /no captured/);
  assert.match(appEvidenceProblem({ mode: 'preview', buildSource: { appFingerprint: 'b' } }, source), /changed/);
  assert.equal(appEvidenceProblem({ mode: 'preview', buildSource: source }, source), null);
});
