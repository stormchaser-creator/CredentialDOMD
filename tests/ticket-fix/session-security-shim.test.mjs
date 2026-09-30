import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionLaunch, removeSessionTemps } from '../../scripts/ticket-fix/worker.mjs';

// The CLI runs `security` at start. Inside the sandbox /usr/bin/security is
// denied, and the CLI crashed with EPERM before it read the credential it was
// handed on a pipe: every run from 2026-09-29 16:17Z ended "extraction session
// exited 1". The live containment test hid this by adding its own shim, so
// this checks the production launch path adds one without the caller's help.
// It lives outside the session directory and the worktree, which the session
// can write (review of 2026-09-30: the host wrote it through a link a session
// had left at shims/).
test('every model session gets a security shim first on PATH that answers "not found"', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-shim-'));
  try {
    const how = await sessionLaunch({ claude: '/usr/bin/true', args: [], cwd: dir, sessionDir: dir, baseEnv: { PATH: '/usr/bin:/bin', HOME: os.homedir(), ANTHROPIC_API_KEY: 'test-key' } });
    const first = how.env.PATH.split(':')[0];
    assert.equal(path.basename(first), 'shims');
    assert.ok(!realpathSync(first).startsWith(`${realpathSync(dir)}/`), `${first} is outside the session directory and the worktree`);
    const shim = path.join(first, 'security');
    accessSync(shim, constants.X_OK);
    assert.match(readFileSync(shim, 'utf8'), /exit 44/);
    const r = spawnSync('security', ['find-generic-password', '-s', 'anything', '-w'], { env: { PATH: how.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, 44, 'the shim, not the real keychain tool, answers');
    assert.equal(r.stdout, '');
  } finally { removeSessionTemps(); rmSync(dir, { recursive: true, force: true }); }
});
