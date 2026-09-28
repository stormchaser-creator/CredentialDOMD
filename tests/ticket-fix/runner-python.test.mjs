// The two end-to-end checks of the hourly runner, which npm test never ran
// before (pipeline map, 2026-09-28): the real zsh runner against a local
// PostgreSQL with a model stand-in, and the exact context and publication SQL.
// Both now carry the verified-reply migration, the repair loop, parked-ticket
// skipping, owner alerts and the stale-lock check.
//
// The full shell path needs zsh and macOS temp paths; it skips elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const run = script => spawnSync(python, [script], { cwd: root, encoding: 'utf8', timeout: 480000,
  env: { ...process.env, PG_BIN: pgBin(), LC_ALL: 'C' } });
// Both need pgcrypto for the verification migration; a server without it skips.
function pgcryptoMissing() {
  const local = path.join(pgBin(), 'pg_config');
  const r = spawnSync(existsSync(local) ? local : 'pg_config', ['--sharedir'], { encoding: 'utf8' });
  if (r.status !== 0) return false; // cannot tell; run and let a real failure show
  return !existsSync(path.join(r.stdout.trim(), 'extension', 'pgcrypto.control'));
}
const skipBase = () => pgSkip() || (python ? false : 'python3 not found') || (pgcryptoMissing() ? 'pgcrypto is not installed with this PostgreSQL' : false);

test('publication SQL on PostgreSQL: verified replies, refused operator inserts, status kept', { skip: skipBase(), timeout: 240000 }, () => {
  const result = run('scripts/ticket-agent-context.postgres.py');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\d+ synthetic PostgreSQL checks passed/);
  assert.match(result.stdout, /ok an operator insert without a verification is refused by the database/);
});

const shellSkip = () => skipBase() || (process.platform !== 'darwin' || !existsSync('/bin/zsh') ? 'the full runner path needs macOS and zsh' : false);
test('the real runner shell end to end: repair loop, parked skip, alerts, stale lock, verification, host-code hold, timeouts, reconcile', { skip: shellSkip(), timeout: 480000 }, () => {
  const result = run('scripts/ticket-agent-hostpath.test.py');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\d+ synthetic full-host checks passed/);
  for (const name of ['a refused reply is repaired by resuming the session', 'a parked ticket is skipped by the queue, not blocking it',
    'parking alerts the owner once, by id prefix only', 'a lock older than 4 h alerts the owner', 'a reply to a resolved ticket keeps it resolved',
    'every stored reply carries a used verification the database checked',
    // Review fixes, 2026-09-28.
    'tamper: a run that changes the reply checks records nothing', 'tamper_uncommitted: the owner is alerted and every later run is held',
    'edits already present before the run do not hold it', 'a model killed by the alarm counts toward the breaker',
    'the third timeout parks the ticket and alerts the owner', 'reconcile reports it to the owner by id prefix',
    'reconcile finds every stored reply in a ledger and alerts nobody', 'the log names the broken rules, never the refused reply text',
    'the verification records the run and that its prose is unbound']) assert.ok(result.stdout.includes(`ok ${name}`), name);
});
