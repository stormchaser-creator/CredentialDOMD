// The two end-to-end checks of the hourly runner, which npm test never ran
// before (pipeline map, 2026-09-28): the real zsh runner against a local
// PostgreSQL with a model stand-in, and the exact context and publication SQL.
// Both now carry the verified-reply migration, the repair loop, parked-ticket
// skipping, owner alerts and the stale-lock check; the shell path also runs
// stage 2 (worktree, reproduction, contained sessions, gates, held merges).
//
// The full shell path needs zsh and macOS temp paths; it skips elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { sandboxAvailable } from '../../scripts/ticket-fix/sandbox.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
// Each script takes a PostgreSQL test slot (tests/helpers/pg_slot.py) and may
// wait for it behind other runs: that wait comes on top of every timeout.
const run = script => spawnSync(python, [script], { cwd: root, encoding: 'utf8', timeout: withSlotWait(480000),
  env: { ...process.env, PG_BIN: pgBin(), LC_ALL: 'C' } });
// Both need pgcrypto for the verification migration; a server without it skips.
function pgcryptoMissing() {
  const local = path.join(pgBin(), 'pg_config');
  const r = spawnSync(existsSync(local) ? local : 'pg_config', ['--sharedir'], { encoding: 'utf8' });
  if (r.status !== 0) return false; // cannot tell; run and let a real failure show
  return !existsSync(path.join(r.stdout.trim(), 'extension', 'pgcrypto.control'));
}
const skipBase = () => pgSkip() || (python ? false : 'python3 not found') || (pgcryptoMissing() ? 'pgcrypto is not installed with this PostgreSQL' : false);

test('publication SQL on PostgreSQL: verified replies, refused operator inserts, status kept', { skip: skipBase(), timeout: withSlotWait(240000) }, () => {
  const result = run('scripts/ticket-agent-context.postgres.py');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\d+ synthetic PostgreSQL checks passed/);
  assert.match(result.stdout, /ok an operator insert without a verification is refused by the database/);
});

// The runner puts every session and gate in the macOS sandbox, which cannot
// nest: inside the gates' own sandbox this path skips (both at base and head).
const shellSkip = () => skipBase() || (process.platform !== 'darwin' || !existsSync('/bin/zsh') ? 'the full runner path needs macOS and zsh'
  : !sandboxAvailable() ? 'the full runner path needs sandbox-exec, which cannot run inside another sandbox' : false);
test('the real runner shell end to end: repair loop, parked skip, alerts, stale lock, verification, host-code hold, timeouts, reconcile, worktrees, refused changes, checklist and attachments', { skip: shellSkip(), timeout: withSlotWait(480000) }, () => {
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
    // The subscription's limit pauses a run and counts nothing, 2026-09-29.
    'a usage limit pauses the run (exit 8) and counts nothing: no rejection, no park, no alert yet', 'the pause ends the run: the other ticket starts no session',
    'a paused run leaves no worktree and no branch', 'another limited run still counts nothing', 'a real session failure of the same shape still counts and parks',
    // A pause is not silent, and gives a continuation its attempt back (review of 2026-09-29).
    'the status file shows the pause and its limit sentence, not a clean run', 'a pause that has lasted 6 h alerts the owner once, with the limit sentence and ids only',
    'the same pause alerts only once', 'three limited continuation runs give back every attempt: still pending, due and unspent',
    'a pause with no limited run for 72 h is over: the next limit starts a new one and alerts nobody',
    'the next run past the limit does the continuation, spends one attempt and ends the pause',
    // Only the runner's own replies leave the personal-data gate's ticket_text rule (review of 2026-09-29).
    "the runner's stored reply is marked as its own from its ledger on the next load",
    'reconcile finds every stored reply in a ledger and alerts nobody', 'the log names the broken rules, never the refused reply text',
    'the verification records the run and that its claims are bound',
    // Stage 2: branch-only work, runner-owned gates, held merges.
    'each ticket gets a checklist, then a reproduction session, before its worker', 'every session ran in a worktree under the work directory, never the owner checkout',
    'the owner checkout and origin main are untouched', 'a run with no change leaves no worktree and no branch',
    'a change with no reproduction is refused by the gates, but the reply is still recorded', 'the refused change counts toward the breaker and alerts the owner',
    'the gate failure went back to the worker once, as rule names', 'nothing reached origin main; the branch is kept for inspection',
    // Stage 2 review: sessions in the sandbox, credential on a pipe; an escape refused.
    'every session ran inside the sandbox, with its credential on a pipe', 'tamper: the sandbox refused the write to the owner checkout and its git',
    // Stage 3: the checklist, the host-rendered reply, attachments delivered and proven read.
    'the checklist extractor has no tools', 'the stored reply is rendered by the host with one footer line per checklist item', 'the frozen checklist is private host state',
    'the case record keeps the host decision per item', 'attachment: downloaded by the host before any session, logged by ticket id and storage path only',
    'attachment: the storage key never reaches the log', 'attachment: the extractor saw the screenshot inline', 'attachment: an answer with no Read of it was refused and the worker resumed',
    "attachment: the session sandbox let this ticket's sessions read it", 'attachment: the confirmer judged the observation', 'attachment: the verification records it as reviewed',
    'attachment: the downloaded files are gone after the run']) assert.ok(result.stdout.includes(`ok ${name}`), name);
});
