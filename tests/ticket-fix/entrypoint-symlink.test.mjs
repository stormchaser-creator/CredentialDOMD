import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../../scripts/ticket-fix/is-main.mjs';

// ticket-agent.sh runs every host step from a copy of the scripts in a temp
// folder, and on macOS that folder is reached through a symlink (/tmp,
// $TMPDIR). From 2026-09-29 05:17Z every run logged "malformed ticket queue":
// each script compared import.meta.url (the real path) with argv[1] (the
// symlinked one), decided it was not the main module, and exited 0 having
// done nothing. These tests run the scripts the way the runner does.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_SCRIPTS = [
  'scripts/ticket-agent-context.mjs', 'scripts/ticket-agent-isolated.mjs',
  ...readdirSync(path.join(ROOT, 'scripts/ticket-fix')).filter(f => f.endsWith('.mjs')).map(f => `scripts/ticket-fix/${f}`),
];

function symlinkedCopy() {
  const real = mkdtempSync(path.join(os.tmpdir(), 'ticket-host-real-'));
  mkdirSync(path.join(real, 'scripts'));
  for (const f of ['ticket-agent-context.mjs', 'ticket-agent-isolated.mjs', 'ticket-agent-prompt.md', 'notify-owner.sh']) {
    cpSync(path.join(ROOT, 'scripts', f), path.join(real, 'scripts', f));
  }
  cpSync(path.join(ROOT, 'scripts/ticket-fix'), path.join(real, 'scripts/ticket-fix'), { recursive: true });
  const link = `${real}-link`;
  symlinkSync(real, link);
  return { link, cleanup() { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); } };
}

test('isMain sees through a symlinked folder', () => {
  const { link, cleanup } = symlinkedCopy();
  try {
    const script = path.join(link, 'scripts/ticket-fix/is-main.mjs');
    assert.equal(isMain(pathToFileURL(script).href, script), true);
    assert.equal(isMain(pathToFileURL(script).href, path.join(link, 'scripts/ticket-fix/alert.mjs')), false);
    assert.equal(isMain(pathToFileURL(script).href, undefined), false);
  } finally { cleanup(); }
});

test('no runner script compares argv[1] to import.meta.url as plain strings', () => {
  for (const file of RUNNER_SCRIPTS) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /path\.resolve\(process\.argv\[1\]\)/, `${file} still uses the string comparison`);
    if (/if \(isMain\(import\.meta\.url\)\)/.test(source)) {
      assert.match(source, /import \{ isMain \} from '\.\.?\/(ticket-fix\/)?is-main\.mjs';/, `${file} calls isMain without importing it`);
    }
  }
});

test('the queue step run from a symlinked host copy actually runs (and fails loudly without a credential)', () => {
  const { link, cleanup } = symlinkedCopy();
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    const r = spawnSync(process.execPath, [path.join(link, 'scripts/ticket-agent-context.mjs'), '--queue', path.join(link, 'queue.json'), path.join(link, 'state')],
      { cwd: '/', encoding: 'utf8', env });
    assert.equal(r.status, 1, `expected the script's own refusal, got status ${r.status}: ${r.stderr}${r.stdout}`);
    assert.match(r.stderr, /credential is required/);
  } finally { cleanup(); }
});
