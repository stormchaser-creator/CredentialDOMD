// A run starts from main; a push that touched only the runner, tests or docs
// never redeploys anything, so main's head is not in the live build although
// the live app is the same. The claims check treats such a base as live
// (16ba1758, 2026-11-07: every claim failed "not live yet"); anything else
// keeps "not live yet" until its own deploy. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sameAppAsLive } from '../../scripts/ticket-fix/stage3.mjs';
import { gitRunner } from '../../scripts/ticket-fix/reply.mjs';

const LIVE = 'a'.repeat(40), BASE = 'b'.repeat(40);
const fakeGit = ({ ancestor = true, changed = [] } = {}) => ({
  isAncestor: (a, b) => (a === LIVE && b === BASE ? ancestor : false),
  diffNames: (a, b) => (a === LIVE && b === BASE ? changed : null),
});

test('a base that changed only the runner, tests or docs is the live app', () => {
  assert.equal(sameAppAsLive(fakeGit({ changed: ['scripts/ticket-agent-context.mjs', 'scripts/ticket-fix/stage3.mjs', 'scripts/ops-supervisor.sh',
    'scripts/profile-lock.test.mjs', 'tests/ticket-fix/reply-hold.test.mjs', 'docs/x.md', 'README.md'] }), BASE, LIVE), true);
});
test('anything that ships, here or elsewhere, keeps "not live yet"', () => {
  for (const file of ['src/utils/billing.js', 'public/index.html', 'supabase/functions/stripe-webhook/index.ts', 'supabase/migrations/20261107_x.sql',
    'supabase/functions/_shared/intakeFiling.mjs', 'cloudflare/worker.js', 'package.json', '.github/workflows/deploy-gh-pages.yml', 'scripts/package-site.mjs', 'landing/x.html']) {
    assert.equal(sameAppAsLive(fakeGit({ changed: ['scripts/ticket-agent-context.mjs', file] }), BASE, LIVE), false, file);
  }
});
test('not after the live build, or nothing known: not the live app', () => {
  assert.equal(sameAppAsLive(fakeGit({ ancestor: false }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit({ changed: null }), BASE, LIVE), false);
  assert.equal(sameAppAsLive(fakeGit(), BASE, null), false);
});
test('a real repository: a file moved out of src/ counts its deleted side', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-base-'));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'user.name', 'Synthetic');
    mkdirSync(path.join(dir, 'src')); writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n'.repeat(20));
    git('add', '-A'); git('commit', '-qm', 'live');
    const live = git('rev-parse', 'HEAD').stdout.trim();
    mkdirSync(path.join(dir, 'docs')); git('mv', 'src/a.js', 'docs/a.js'); git('commit', '-qm', 'move');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    const runner = gitRunner(dir);
    assert.deepEqual(runner.diffNames(live, base).sort(), ['docs/a.js', 'src/a.js']);
    assert.equal(sameAppAsLive(runner, base, live), false);
    writeFileSync(path.join(dir, 'docs', 'b.md'), 'synthetic\n'); git('add', '-A'); git('commit', '-qm', 'docs');
    const later = git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(sameAppAsLive(runner, later, base), true, 'docs only after the move');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
