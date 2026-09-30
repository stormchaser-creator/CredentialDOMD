// Finding (safe read): specialPaths reads a source file to look for a NUL byte.
// It must open the file without following a link and without blocking, so a
// regular file swapped for a FIFO cannot block open() forever (the runner's
// SIGALRM backstop cannot end an open() the kernel restarts under SA_RESTART,
// so a blocked read would hold the lock and skip every later hourly run). This
// drives that read through a child so a regression (a plain, blocking open)
// fails as a timeout instead of hanging the whole suite. All tampering is
// benign: a named pipe where a source file was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.join(HERE, '..', '..', 'scripts', 'ticket-fix', 'worktree.mjs');

test('reading a source file that is a FIFO returns at once and flags it special, never blocking', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-fifo-'));
  try {
    const fifo = path.join(dir, 'a.js');
    const made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, 'mkfifo is available for the test');
    // The child opens the FIFO through the same helper specialPaths uses. With
    // O_NONBLOCK it returns immediately (fstat sees a FIFO, not a regular file,
    // so it is flagged special); a plain open would block for a writer that
    // never comes, and the 6 s timeout would kill the child (signal set).
    const code = "import { lstatSync } from 'node:fs';\n" +
      `import { hasNul } from ${JSON.stringify(WORKTREE)};\n` +
      `const special = hasNul(${JSON.stringify(fifo)}, lstatSync(${JSON.stringify(fifo)}));\n` +
      "process.stdout.write(special ? 'special' : 'plain');\n";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 6000 });
    assert.equal(r.signal, null, 'reading the FIFO blocked until the timeout had to kill the reader');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'special', 'a FIFO where a source file was is flagged special');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
