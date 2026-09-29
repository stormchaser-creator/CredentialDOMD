import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionLaunch } from '../../scripts/ticket-fix/worker.mjs';

// The CLI runs `security` at start. Inside the sandbox /usr/bin/security is
// denied, and the CLI crashed with EPERM before it read the credential it was
// handed on a pipe: every run from 2026-09-29 16:17Z ended "extraction session
// exited 1". The live containment test hid this by adding its own shim, so
// this checks the production launch path adds one without the caller's help.
test('every model session gets a security shim first on PATH that answers "not found"', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-shim-'));
  try {
    const how = await sessionLaunch({ claude: '/usr/bin/true', args: [], cwd: dir, sessionDir: dir, baseEnv: { PATH: '/usr/bin:/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'test-key' } });
    const first = how.env.PATH.split(':')[0];
    assert.equal(first, path.join(dir, 'shims'));
    const shim = path.join(first, 'security');
    accessSync(shim, constants.X_OK);
    assert.match(readFileSync(shim, 'utf8'), /exit 44/);
    const r = spawnSync('security', ['find-generic-password', '-s', 'anything', '-w'], { env: { PATH: how.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, 44, 'the shim, not the real keychain tool, answers');
    assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
