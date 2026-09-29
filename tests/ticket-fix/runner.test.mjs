// Phase 0 of the ticket-fix gates on the hourly runner: parked tickets skipped
// by the queue, owner alerts and a status file, a lock that records its
// owner, the bounded repair loop, and one reply path for sessions too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync, accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueSQL, parkedTargets, collectQueue, saveReview, loadContext, contextMac, logSafe } from '../../scripts/ticket-agent-context.mjs';
import { main as alert, lockState, HOLD_FILE } from '../../scripts/ticket-fix/alert.mjs';
import { reconcile, reconcileSQL } from '../../scripts/ticket-fix/reconcile.mjs';
import { ReplyRuleError } from '../../scripts/ticket-fix/claims.mjs';
import { uuid, privateDir } from './helpers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = rel => readFileSync(path.join(root, rel), 'utf8');
const T = uuid(501), U = uuid(502), OWNER = uuid(9000);

function stateWithCounts(counts) {
  const state = privateDir('ticket-runner-');
  mkdirSync(path.join(state.dir, 'failed'), { mode: 0o700 });
  for (const [ticket, count] of Object.entries(counts)) writeFileSync(path.join(state.dir, 'failed', `${ticket}.count`), `${count}\n`, { mode: 0o600 });
  return state;
}

test('parked tickets are left out of the queue query instead of holding its two slots', async () => {
  const state = stateWithCounts({ [T]: 3, [U]: 2, 'not-a-ticket': 9 });
  try {
    assert.deepEqual(await parkedTargets(state.dir), [T]);
    const sql = queueSQL(true, [T]);
    assert.match(sql, new RegExp(`AND t.id NOT IN \\('${T}'::uuid\\)\\s+ORDER BY t.created_at,t.id LIMIT 2`));
    assert.doesNotMatch(queueSQL(true, []), /NOT IN/);
    assert.throws(() => queueSQL(true, ["x'; drop table y; --"]), /Invalid support ID/);
    let seen;
    const queue = await collectQueue(async q => { seen = q; return [{ id: U, from_admin: true }]; }, state.dir);
    assert.ok(seen.includes(`NOT IN ('${T}'::uuid)`));
    assert.deepEqual(queue, { items: [{ id: U, mode: 'reply' }], attention: [], parked: [T] });
  } finally { state.cleanup(); }
});

test('a parked ticket with due internal work is not continued either', async () => {
  const state = stateWithCounts({ [T]: 3 });
  try {
    const ticket = { id: T, user_id: OWNER, subject: 'Synthetic', body: 'Synthetic', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-19T00:00:00Z',
      status: 'open', archived_at: null, from_admin: true, agent_approved_at: null };
    const context = await loadContext(async q => (q.includes('AS context_owner_id') ? [{ context_ticket_id: T, context_owner_id: OWNER, messages: [] }] : [ticket]), T);
    const result = { reply: 'Synthetic progress note.', summary: 'Synthetic.', needs_owner_review: false, assessment: {
      acceptance_criteria: [{ requirement: 'Synthetic', state: 'open', evidence_ids: [T] }], answered_questions: [], prior_fixes: [], questions: [], completed_follow_up: [],
      follow_up: [{ work: 'Synthetic work', owner: 'support_worker', next_action: 'Synthetic next step.' }],
      verification: { kind: 'not_run', reproduction: 'Not run.', checks: 'Not run.', release: 'Not deployed.' } } };
    await saveReview(state.dir, context, result, null, { now: Date.parse('2026-09-19T00:00:00Z') });
    const queue = await collectQueue(async () => [], state.dir, { now: Date.parse('2026-09-20T00:00:00Z') });
    assert.deepEqual(queue.items, []);
  } finally { state.cleanup(); }
});

test('parking writes a private alert line and status, and sends ids only', async () => {
  const state = stateWithCounts({ [T]: 3 });
  const sent = [];
  try {
    await alert(['park', '--state', state.dir, '--ticket', T, '--count', '3'], { send: async m => { sent.push(m); return true; }, now: Date.parse('2026-09-28T12:00:00Z') });
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`ticket ${T.slice(0, 8)} is parked after 3 rejected runs`));
    assert.ok(!sent[0].includes(T), 'the id prefix, not the full id');
    assert.ok(!sent[0].includes('\u2014'));
    const log = readFileSync(path.join(state.dir, 'alerts.log'), 'utf8');
    assert.equal(log, `2026-09-28T12:00:00.000Z ALERT parked ticket=${T.slice(0, 8)} rejected_runs=3\n`);
    assert.equal(statSync(path.join(state.dir, 'alerts.log')).mode & 0o777, 0o600);
    const status = JSON.parse(readFileSync(path.join(state.dir, 'status.json'), 'utf8'));
    assert.deepEqual(status.parked.map(p => [p.ticket, p.rejected_runs]), [[T, 3]]);
    assert.equal(status.alerts[0].kind, 'parked');
    assert.equal(statSync(path.join(state.dir, 'status.json')).mode & 0o777, 0o600);
    await alert(['status', '--state', state.dir, '--rc', '1'], { now: Date.parse('2026-09-28T12:30:00Z') });
    assert.deepEqual(JSON.parse(readFileSync(path.join(state.dir, 'status.json'), 'utf8')).last_run, { rc: 1, finished_at: '2026-09-28T12:30:00.000Z' });
    await assert.rejects(alert(['park', '--state', state.dir, '--ticket', 'nope', '--count', '3']), /park needs/);
    await assert.rejects(alert(['park', '--state', 'relative/dir', '--ticket', T, '--count', '3']), /absolute/);
  } finally { state.cleanup(); }
});

test('a lock older than 4 h alerts once per lock, whether it has an owner record or was taken by hand', async () => {
  const state = privateDir('ticket-lock-');
  const sent = [];
  const send = async m => { sent.push(m); return true; };
  const now = Date.parse('2026-09-28T12:00:00Z');
  try {
    const lock = path.join(state.dir, 'runner.lock');
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'owner'), `pid=${process.pid}\nstarted=${Math.floor(now / 1000) - 3600}\n`);
    await alert(['lock', '--state', state.dir, '--lock', lock], { send, now });
    assert.equal(sent.length, 0, 'an hour-old lock is normal');
    const fresh = await lockState(lock, now);
    assert.equal(fresh.pid_alive, true);
    assert.equal(fresh.age_hours, 1);
    writeFileSync(path.join(lock, 'owner'), `pid=999999\nstarted=${Math.floor(now / 1000) - 5 * 3600}\n`);
    await alert(['lock', '--state', state.dir, '--lock', lock], { send, now });
    await alert(['lock', '--state', state.dir, '--lock', lock], { send, now: now + 1800000 });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /held 5 h \(pid 999999, not running\)/);
    const status = JSON.parse(readFileSync(path.join(state.dir, 'status.json'), 'utf8'));
    assert.equal(status.lock.stale, true);
    assert.equal(status.lock.source, 'owner');
    // A lock taken by hand (a HELD-BY note, no owner record) is aged by its directory time.
    const hand = path.join(state.dir, 'hand.lock');
    mkdirSync(hand);
    writeFileSync(path.join(hand, 'HELD-BY.txt'), 'synthetic session\n');
    const old = (now - 6 * 3600000) / 1000;
    utimesSync(hand, old, old);
    await alert(['lock', '--state', state.dir, '--lock', hand], { send, now });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /held 6 h \(no owner record, taken by hand\)/);
    assert.equal(await lockState(path.join(state.dir, 'missing.lock'), now), null);
  } finally { state.cleanup(); }
});

const node = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/ticket-agent-context.mjs'), ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
test('--validate returns 2 with the reason for a repairable result, and --session names the session', () => {
  const state = privateDir('ticket-validate-');
  try {
    const context = { version: 1, target_id: T, run_mode: 'reply', owner_id: OWNER, history_complete: true, tickets: [{ id: T, messages: [] }], prior_reviews: [], attachments: [] };
    const result = reply => ({ type: 'result', is_error: false, session_id: uuid(77), structured_output: { reply, summary: 'Synthetic.', needs_owner_review: false, assessment: {
      acceptance_criteria: [{ requirement: 'Synthetic', state: 'open', evidence_ids: [T] }], answered_questions: [], prior_fixes: [], questions: [], completed_follow_up: [],
      follow_up: [{ work: 'Synthetic work', owner: 'support_worker', next_action: 'Synthetic next step.' }],
      verification: { kind: 'not_run', reproduction: 'Not run.', checks: 'Not run.', release: 'Not deployed.' } } } });
    const file = (name, value) => { const f = path.join(state.dir, name); writeFileSync(f, JSON.stringify(value)); return f; };
    const ctx = file('context.json', context);
    const bad = node(['--validate', ctx, file('bad.json', result('Fixed in build c237149. Eric says it works on your iPhone.'))]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stdout, /commit_or_build_id/);
    assert.match(bad.stdout, /owner_name/);
    assert.match(bad.stdout, /device_not_tested/);
    assert.match(bad.stdout, /works on your iPhone/, 'the model gets the sentence it has to fix');
    // Review: the runner's REPAIR line carried these excerpts into the shared log.
    assert.equal(bad.stderr.trim(), 'commit_or_build_id, owner_name, unverified_claim, device_not_tested', 'the log gets rule names only');
    const good = node(['--validate', ctx, file('good.json', result('Your report is recorded; the investigation continues.'))]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const failed = node(['--validate', ctx, file('failed.json', { type: 'result', is_error: true })]);
    assert.equal(failed.status, 1, 'a failed model run is not repairable');
    assert.equal(node(['--session', path.join(state.dir, 'bad.json')]).stdout.trim(), uuid(77));
    assert.equal(node(['--session', file('nosession.json', { session_id: '--resume; rm -rf /' })]).status, 1);
    const placeholder = node(['--validate', ctx, file('fix.json', result('The change is in {{FIX_COMMIT}}.'))], { TICKET_PRE_HEAD: 'not-a-sha' });
    assert.equal(placeholder.status, 2);
    assert.match(placeholder.stdout, /no pre-run revision/);
  } finally { state.cleanup(); }
});

test('the runner shell: lock owner, park alert, status on every exit; the model is started only by run.mjs, never with skipped permissions (stage 2)', () => {
  const sh = read('scripts/ticket-agent.sh');
  assert.match(sh, /printf 'pid=%s\\nstarted=%s\\n' "\$\$" "\$\(date \+%s\)" > "\$LOCK\/owner"/);
  assert.match(sh, /trap '[^']*\/bin\/rm -f "\$LOCK\/owner"; rmdir "\$LOCK"[^']*' EXIT/);
  assert.match(sh, /trap 'EXIT_RC=\$\?; node "\$ALERT" status --state "\$CASE_STATE" --rc "\$EXIT_RC"/);
  assert.match(sh, /SKIP[^\n]*\n\s+node "\$ALERT" lock --state "\$CASE_STATE" --lock "\$LOCK" --notify "\$NOTIFY"/);
  assert.match(sh, /if \[ \$\(\(FAILS \+ 1\)\) -eq 3 \]; then\n\s+node "\$ALERT" park --state "\$CASE_STATE" --ticket "\$TICKET_ID" --count 3 --notify "\$NOTIFY"/);
  assert.match(sh, /RUN_STARTED=\$\(date -u '\+%Y-%m-%dT%H:%M:%SZ'\)/);
  // The shell no longer starts a model: run.mjs does, contained (worker.mjs).
  assert.doesNotMatch(sh, /"\$CLAUDE" -p/);
  for (const file of ['scripts/ticket-agent.sh', 'scripts/ticket-fix/run.mjs', 'scripts/ticket-fix/worker.mjs', 'scripts/ticket-fix/review.mjs', 'scripts/ticket-fix/merge.mjs']) {
    assert.doesNotMatch(read(file), /dangerously-skip-permissions|bypassPermissions"?\s*[,)]/, file);
  }
  assert.match(sh, /\/usr\/bin\/perl -e 'alarm 10800; exec @ARGV' -- node "\$HOST\/ticket-fix\/run.mjs" work --ticket "\$TICKET_ID" --context "\$CONTEXT" --output "\$OUTPUT" --run-file "\$RUN_FILE"/);
  assert.match(sh, /--claude "\$CLAUDE" --committer "\$RUN_COMMITTER" --notify "\$NOTIFY" --worker-seconds "\$WORKER_SECONDS"/);
  assert.match(sh, /--work "\$WORK_STATE" --state "\$CASE_STATE" --fix-state "\$FIX_STATE"/);
  assert.match(sh, /WORK_STATE="\$HOME\/Library\/Application Support\/CredentialDOMD\/ticket-work"/);
  assert.equal((sh.match(/WORKER_SECONDS=1500/g) || []).length, 1);
  // Exit codes: every failure counts toward the breaker; runner code holds.
  assert.match(sh, /if host_code_changed \|\| \[ "\$WORK_RC" -eq 4 \]; then hold_run runner_code; RC=1; break; fi/);
  // Exit 6: git state outside the worktree changed (stage 2 review, finding 12).
  assert.match(sh, /if \[ "\$WORK_RC" -eq 6 \]; then hold_run host_state; RC=1; break; fi/);
  assert.match(sh, /node "\$ALERT" hold --state "\$CASE_STATE" --ticket "\$TICKET_ID" --why "\$1"/);
  // AUTO_MERGE is read once, before any model runs, and passed (finding 2).
  const flag = sh.indexOf('AUTO_MERGE=$(node "$HOST/ticket-fix/run.mjs" auto-merge --work "$WORK_STATE"');
  assert.ok(flag > 0 && flag < sh.indexOf('ticket-fix/run.mjs" work'), 'the flag is read before the first model session');
  assert.equal((sh.match(/AUTO_MERGE=\$\(/g) || []).length, 1, 'read once');
  assert.match(sh, /case "\$AUTO_MERGE" in on\|off\) ;; \*\) AUTO_MERGE=off ;; esac/);
  assert.match(sh, /node "\$ALERT" auto-merge --state "\$CASE_STATE" --value "\$AUTO_MERGE" --notify "\$NOTIFY"/);
  assert.match(sh, /--auto-merge "\$AUTO_MERGE" >> "\$LOG" 2>&1\n\s+WORK_RC=\$\?/);
  // The record step knows the code outcome (finding 5) and finish the repository (finding 2).
  assert.match(sh, /TICKET_CODE_OUTCOME="\$CODE"[^\n]*node "\$HOST\/ticket-agent-context.mjs" \\\n\s+--record-and-reply/);
  assert.match(sh, /run.mjs" finish --run-file "\$RUN_FILE" --work "\$WORK_STATE" --repo "\$REPO"/);
  assert.match(sh, /2\) reject "review not recorded"; RC=1; break ;;/);
  assert.match(sh, /3\) reject "model run failed or timed out"; RC=1; break ;;/);
  assert.match(sh, /5\) reject "changed files outside its scope"; RC=1; break ;;/);
  assert.match(sh, /\*\) reject "host step failed \(exit \$WORK_RC\)"; RC=1; break ;;/);
  // A refused change is recorded (the reply claims nothing) but counts.
  assert.match(sh, /if \[ "\$CODE" = refused \]; then[\s\S]*?echo \$\(\(FAILS \+ 1\)\) > "\$FAIL_COUNT"/);
  // Held changes: continuations wait; one code change per scheduled run.
  assert.match(sh, /if \[ "\$RUN_MODE" = continuation \] && HELD_RUN=\$\(node "\$HOST\/ticket-fix\/run.mjs" held-for --work "\$WORK_STATE" --ticket "\$TICKET_ID"/);
  assert.match(sh, /case "\$CODE" in none\) ;; \*\) break ;; esac/);
  assert.match(sh, /node "\$HOST\/ticket-fix\/run.mjs" finish --run-file "\$RUN_FILE" --work "\$WORK_STATE"/);
  // No token reaches run.mjs or the log.
  assert.doesNotMatch(sh, /echo[^\n]*\$TOKEN/);
  const work = sh.slice(sh.indexOf('ticket-fix/run.mjs" work'), sh.indexOf('WORK_RC=$?'));
  assert.doesNotMatch(work, /TOKEN/);
  assert.doesNotMatch(sh, /export\s+(?:TOKEN|TICKET_DATABASE_TOKEN)=/);
});

test('the runner judges a run with host code copied before the model ran, and holds on any change to it (review)', () => {
  const sh = read('scripts/ticket-agent.sh');
  const firstModel = sh.indexOf('ticket-fix/run.mjs" work');
  const copy = sh.indexOf('/usr/bin/git -C "$REPO" archive "$HOST_HEAD"');
  assert.ok(copy > 0 && copy < firstModel, 'the copy is taken before any model runs');
  for (const file of ['scripts/ticket-agent-context.mjs', 'scripts/ticket-agent-isolated.mjs', 'scripts/ticket-agent-prompt.md', 'scripts/ticket-fix', 'scripts/notify-owner.sh']) {
    assert.ok(sh.slice(copy, copy + 400).includes(file), file);
  }
  // No host step runs from the checkout the model could reach.
  assert.doesNotMatch(sh, /node "\$REPO\//);
  assert.doesNotMatch(sh, /cat "\$REPO\/scripts/);
  for (const step of ['--load', '--record-and-reply']) assert.match(sh, new RegExp(`node "\\$HOST/ticket-agent-context.mjs"[^\\n]*(?:\\\\\\n[^\\n]*)?${step}`), step);
  assert.match(sh, /ALERT="\$HOST\/ticket-fix\/alert.mjs"/);
  assert.match(sh, /NOTIFY="\$HOST\/notify-owner.sh"/);
  assert.match(sh, /PROTECTED=\(scripts\/ticket-fix 'scripts\/ticket-agent\*' scripts\/notify-owner.sh 'supabase\/migrations\/\*support_reply\*' supabase\/functions\/send-ticket-reply\)/);
  assert.match(sh, /if \[ -e "\$HOLD" \]; then[^\n]*\n[^\n]*HOLD[^\n]*\n\s+exit 0/);
  // The reply is recorded against the run's worktree (or the owner checkout
  // when nothing changed), at the run's base, with its release record.
  assert.match(sh, /TICKET_RUN_KEY="\$RUN_KEY" TICKET_REPO="\$RECORD_REPO" TICKET_PRE_HEAD="\$BASE"[^\n]*\\\n[^\n]*TICKET_RELEASE_FILE="\$RELEASE_FILE"[^\n]*\\\n\s+--record-and-reply/);
  // run.mjs's own list of the runner's code matches the shell's.
  const worktree = read('scripts/ticket-fix/worktree.mjs');
  for (const p of ['scripts\\/ticket-fix\\/', 'scripts\\/ticket-agent', 'scripts\\/notify-owner\\.sh', 'supabase\\/migrations\\/[^/]*support_reply', 'supabase\\/functions\\/send-ticket-reply\\/']) assert.ok(worktree.includes(p), p);
});

test('the runner: per-run key and committer, timeouts count, rule names only in the log (review)', () => {
  const sh = read('scripts/ticket-agent.sh');
  assert.match(sh, /RUN_KEY=\$\(\/usr\/bin\/openssl rand -hex 32\)/);
  assert.doesNotMatch(sh, /export[^\n]*RUN_KEY/, 'never exported');
  assert.equal((sh.match(/TICKET_RUN_KEY="\$RUN_KEY"/g) || []).length, 2, 'only --load and --record-and-reply get it');
  assert.match(sh, /TICKET_RUN_KEY="\$RUN_KEY" TICKET_DATABASE_TOKEN="\$TOKEN" node "\$HOST\/ticket-agent-context.mjs" \\\n\s+--load/);
  assert.match(sh, /RUN_COMMITTER="ticket-agent\+\$RUN_ID@credentialdomd.invalid"/);
  assert.match(sh, /reject\(\) \{[\s\S]*?echo \$\(\(FAILS \+ 1\)\) > "\$FAIL_COUNT"[\s\S]*?node "\$ALERT" park/);
  assert.match(read('scripts/ticket-fix/run.mjs'), /log\(`REPAIR \u2014 \$\{ticket\} attempt \$\{repairs \+ 1\}: \$\{rules\}`\)/);
  assert.match(sh, /node "\$HOST\/ticket-fix\/reconcile.mjs" --state "\$CASE_STATE" \\\n\s+--ledger "\$CASE_STATE\/replies" --ledger "\$FIX_STATE\/replies" --runs "\$CASE_STATE\/runs.log"/);
  assert.match(sh, /RUN \$RUN_ID[^\n]*\n(?:#[^\n]*\n)*printf '%s %s\\n' "\$RUN_ID" [^\n]*>> "\$CASE_STATE\/runs.log"/);
});

test('--load and --record-and-reply run only inside the runner: a hand-made context is refused before any database call', async () => {
  const state = privateDir('ticket-record-');
  try {
    const context = JSON.stringify({ version: 1, target_id: T, run_mode: 'reply', owner_id: OWNER, history_complete: true, tickets: [{ id: T, messages: [] }], prior_reviews: [], attachments: [] });
    const ctx = path.join(state.dir, 'ctx.json'); writeFileSync(ctx, context);
    const out = path.join(state.dir, 'out.json'); writeFileSync(out, JSON.stringify({ structured_output: { reply: 'Your export is fixed.' } }));
    const refused = [
      node(['--record-and-reply', ctx, out, state.dir]),
      node(['--load', T, ctx, state.dir, 'reply']),
      node(['--record-and-reply', ctx, out, state.dir], { TICKET_RUN_KEY: 'a'.repeat(64) }),
    ];
    for (const r of refused.slice(0, 2)) { assert.equal(r.status, 1); assert.match(r.stderr, /runs only inside scripts\/ticket-agent.sh/); }
    assert.equal(refused[2].status, 1);
    assert.match(refused[2].stderr, /was not loaded by this runner run/);
    // A session that signs its own context with its own key is a deliberate
    // bypass; reconcile.mjs reports the reply it stores (no runner ledger).
    const key = randomBytes(32).toString('hex');
    writeFileSync(`${ctx}.mac`, contextMac(randomBytes(32).toString('hex'), context));
    assert.match(node(['--record-and-reply', ctx, out, state.dir], { TICKET_RUN_KEY: key }).stderr, /was not loaded by this runner run/, 'signed with another key');
    writeFileSync(`${ctx}.mac`, contextMac(key, context));
    assert.match(node(['--record-and-reply', ctx, out, state.dir], { TICKET_RUN_KEY: key }).stderr, /Structured reply required; nothing was recorded/, 'past the key check, and a free-text reply is refused');
    assert.equal(logSafe(new ReplyRuleError([{ rule: 'device_not_tested', excerpt: 'Works on your iPhone.' }])), 'Reply breaks fixed reply rules: device_not_tested');
  } finally { state.cleanup(); }
});

test('the AUTO_MERGE flag: its first reading of off is quiet, every change alerts the owner (stage 2 review, finding 2)', async () => {
  const state = privateDir('ticket-auto-merge-');
  const sent = [];
  const send = async m => { sent.push(m); return true; };
  try {
    await alert(['auto-merge', '--state', state.dir, '--value', 'off'], { send });
    assert.equal(sent.length, 0);
    await alert(['auto-merge', '--state', state.dir, '--value', 'off'], { send });
    await alert(['auto-merge', '--state', state.dir, '--value', 'on'], { send });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /unattended merges are now ON/);
    assert.match(sent[0], /If you did not change ticket-work\/AUTO_MERGE, look now/);
    assert.ok(!sent[0].includes('\u2014'));
    await alert(['auto-merge', '--state', state.dir, '--value', 'on'], { send });
    await alert(['auto-merge', '--state', state.dir, '--value', 'off'], { send });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /now OFF/);
    await assert.rejects(alert(['auto-merge', '--state', state.dir, '--value', 'maybe'], { send }), /on\|off/);
    await alert(['hold', '--state', state.dir, '--ticket', T, '--why', 'host_state'], { send });
    assert.match(sent.at(-1), /changed git state outside its worktree/);
    await assert.rejects(alert(['hold', '--state', state.dir, '--ticket', T, '--why', 'other'], { send }), /runner_code or host_state/);
  } finally { state.cleanup(); }
});

test('a held run alerts the owner once by id prefix, and the status file says it is held', async () => {
  const state = privateDir('ticket-hold-');
  const sent = [];
  try {
    await alert(['hold', '--state', state.dir, '--ticket', T], { send: async m => { sent.push(m); return true; }, now: Date.parse('2026-09-28T12:00:00Z') });
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`ticket ${T.slice(0, 8)} changed the runner's own code`));
    assert.match(sent[0], new RegExp(HOLD_FILE));
    assert.ok(!sent[0].includes('\u2014'));
    assert.equal(JSON.parse(readFileSync(path.join(state.dir, 'status.json'), 'utf8')).hold, false);
    writeFileSync(path.join(state.dir, HOLD_FILE), 'trusted=x\n', { mode: 0o600 });
    await alert(['status', '--state', state.dir, '--rc', '0'], { now: Date.parse('2026-09-28T12:05:00Z') });
    assert.equal(JSON.parse(readFileSync(path.join(state.dir, 'status.json'), 'utf8')).hold, true);
  } finally { state.cleanup(); }
});

test('reconcile: a stored reply no checked path recorded, or one text sent to several tickets, alerts the owner once', async () => {
  const state = privateDir('ticket-reconcile-');
  const ledgerA = path.join(state.dir, 'agent'), ledgerB = path.join(state.dir, 'post');
  const sent = [];
  const send = async m => { sent.push(m); return true; };
  const sha = n => String(n).repeat(64).slice(0, 64);
  const rows = [
    { id: uuid(11), ticket_id: uuid(1), body_sha256: sha(1), path: 'agent', run_id: '0123456789abcdef' },
    { id: uuid(12), ticket_id: uuid(2), body_sha256: sha(2), path: 'post-reply' },
    { id: uuid(13), ticket_id: uuid(3), body_sha256: sha(3), path: 'post-reply' },
    { id: uuid(14), ticket_id: uuid(4), body_sha256: sha(3), path: 'post-reply' },
    { id: uuid(15), ticket_id: uuid(5), body_sha256: sha(3), path: 'post-reply' },
    { id: uuid(16), ticket_id: uuid(6), body_sha256: sha(1), path: 'agent', run_id: '0123456789abcdef' },
    // Review: --load and --record-and-reply driven by hand with a key of the
    // session's own. The runner ledger is written, but no logged run made it.
    { id: uuid(17), ticket_id: uuid(7), body_sha256: sha(4), path: 'agent', run_id: 'fedcba9876543210' },
  ];
  const ledger = (dir, row, changes = {}) => {
    mkdirSync(path.join(dir, row.ticket_id), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, row.ticket_id, `${row.id}.json`), JSON.stringify({ verification_id: row.id, body_sha256: row.body_sha256, ...changes }), { mode: 0o600 });
  };
  try {
    ledger(ledgerA, rows[0]); ledger(ledgerB, rows[1]); ledger(ledgerB, rows[2]); ledger(ledgerB, rows[3], { body_sha256: sha(9) }); ledger(ledgerB, rows[4]); ledger(ledgerA, rows[5]); ledger(ledgerA, rows[6]);
    const runsLog = path.join(state.dir, 'runs.log');
    writeFileSync(runsLog, '0123456789abcdef 2026-09-28T11:00:00Z\nnot-a-run-id\n', { mode: 0o600 });
    let seen;
    const query = async sql => { seen = sql; return rows; };
    const result = await reconcile({ query, state: state.dir, ledgers: [ledgerA, ledgerB], runsLog, send, now: Date.parse('2026-09-28T12:00:00Z') });
    assert.equal(seen, reconcileSQL());
    assert.match(seen, /^begin read only; SELECT v.id, v.ticket_id, v.body_sha256, v.report->>'path' AS path, v.report->>'run_id' AS run_id/);
    assert.deepEqual(result, { checked: 7, unledgered: 1, unlogged: 1, shared: 1, alerts: 3 }, 'two tickets sharing a short text is not a batch; three is');
    assert.equal(sent.length, 3);
    assert.match(sent[0], new RegExp(`verification ${uuid(14).slice(0, 8)}, ticket ${uuid(4).slice(0, 8)}\\) has no record`), 'a ledger entry for another text does not count');
    assert.match(sent[1], new RegExp(`ticket ${uuid(7).slice(0, 8)}\\) says it came from the hourly runner, but no logged run made it`));
    assert.match(sent[2], /stored on 3 tickets/);
    for (const message of sent) assert.ok(!message.includes('\u2014'));
    await reconcile({ query, state: state.dir, ledgers: [ledgerA, ledgerB], runsLog, send });
    assert.equal(sent.length, 3, 'each finding alerts once');
    await assert.rejects(reconcile({ query: async () => [{ id: 'x' }], state: state.dir, ledgers: [ledgerA], send }), /Unusable verification rows/);
    await assert.rejects(reconcile({ query, state: state.dir, ledgers: ['relative'], send }), /absolute/);
  } finally { state.cleanup(); }
});

test('the migrations state the rollout order that keeps the live runner working, and do not overclaim the HMAC (review)', () => {
  const first = read('supabase/migrations/20260928150000_support_reply_verifications.sql');
  const second = read('supabase/migrations/20260928160000_support_reply_hardening.sql');
  assert.doesNotMatch(first, /apply this BEFORE merging/i);
  assert.match(first, /Order: merge the runner change FIRST/);
  assert.doesNotMatch(first, /Bypassing it takes ALTER TABLE/);
  assert.match(first, /can read\n-- vault.decrypted_secrets/);
  assert.match(second, /Deploy reply-ticket \(admin replies written as the caller\) and\n--\s+send-ticket-reply \(stored row, once\) first/);
  assert.match(second, /What this does NOT do/);
});

test('the prompt tells the model the rules the host now enforces', () => {
  const prompt = read('scripts/ticket-agent-prompt.md');
  // Stage 2: branch only; the host commits, gates, reviews and holds merges.
  assert.match(prompt, /Do NOT commit, push, deploy or poll `version.json`/);
  assert.match(prompt, /You never push, never deploy, never poll `version.json` or the CDN/);
  assert.match(prompt, /The only\s+commands allowed are `npm test`, `node --test tests\/<file>` and `npm run build:site`/);
  assert.match(prompt, /Those files are frozen/);
  assert.doesNotMatch(prompt, /push to main/i);
  assert.doesNotMatch(prompt, /Wait for the CDN/);
  for (const text of ['scripts/ticket-agent-prompt.md', 'scripts/ticket-fix/repro-prompt.md', 'scripts/ticket-fix/review-prompt.md', 'scripts/ticket-fix/extract-prompt.md', 'scripts/ticket-fix/confirm-prompt.md']) {
    assert.ok(!read(text).includes('\u2014'), `${text}: no em dashes`);
  }
  assert.match(prompt, /Never edit, create or delete anything under `scripts\/ticket-fix\/`/);
  assert.doesNotMatch(prompt, /Cite the fix commit/);
  // Stage 3: no ids at all; structured claims with evidence; the footer and
  // every item's state are the host's; attachments are read, and proven read.
  assert.doesNotMatch(prompt, /\{\{FIX_COMMIT\}\}|\{\{BUILD\}\}/);
  assert.match(prompt, /No commit, build or ticket ids/);
  assert.match(prompt, /Each claim is `\{ac_id, text, evidence\}`/);
  assert.match(prompt, /"Where each part stands:", one line per checklist item, written by the host/);
  assert.match(prompt, /The host decides the state the customer sees/);
  assert.match(prompt, /Give exactly one entry per frozen item/);
  assert.match(prompt, /The host watches your Read calls/);
  assert.match(prompt, /Never ask the customer to send it again/);
  assert.match(prompt, /must say it was not tested there/);
  assert.match(prompt, /Never write "HIPAA" or "compliant"/);
  assert.match(prompt, /resumes\s+this session with the exact reason, at most twice/);
  assert.match(prompt, /never reopens a resolved or archived\s+ticket/);
  assert.doesNotMatch(prompt, /current open-status reply behavior/);
  assert.doesNotMatch(prompt, /The reply reports no results/, 'the free-text reply rules are gone');
});

test('the owner notifier is shared, passes the message as an argument, and signup-notify uses it', () => {
  const notify = read('scripts/notify-owner.sh');
  accessSync(path.join(root, 'scripts/notify-owner.sh'), constants.X_OK);
  assert.match(notify, /send \(item 1 of argv\)/);
  assert.match(notify, /end run' "\$MSG"$/m);
  assert.doesNotMatch(notify, /\$MSG[^"]*'/, 'the message is never spliced into AppleScript source');
  const signup = read('scripts/signup-notify.sh');
  assert.match(signup, /"\$\{0:A:h\}\/notify-owner.sh" "\$MSG" \|\| exit 1/);
  assert.doesNotMatch(signup, /osascript/);
});

test('sessions are told to post support replies only through post-reply.mjs', () => {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const text = read(file);
    assert.match(text, /node scripts\/ticket-fix\/post-reply\.mjs --ticket <uuid> --reply <file\.json>/, file);
    assert.match(text, /one ticket per call/i, file);
    for (const ban of ['Never read the vault secret `support_reply_hmac_key`', 'never write `support_reply_verifications` directly',
      'never write `support_messages` with a service-role key', 'never call `send-ticket-reply` directly', '`--record-and-reply` by hand']) assert.ok(text.includes(ban), `${file}: ${ban}`);
    assert.match(text, /not emailed to members/, file);
    assert.match(text, /node scripts\/ticket-fix\/merge\.mjs <run-id>/, file);
    assert.match(text, /never create `ticket-work\/AUTO_MERGE` unless the owner says so/, file);
  }
  for (const cli of ['post-reply', 'verify-claims', 'run-tests', 'record-query', 'alert', 'reconcile', 'merge', 'run']) {
    assert.ok(existsSync(path.join(root, `scripts/ticket-fix/${cli}.mjs`)), cli);
    accessSync(path.join(root, `scripts/ticket-fix/${cli}.mjs`), constants.X_OK);
  }
});

test('CI runs the whole suite on every push and pull request and deploys nothing', () => {
  // Comments are prose; measure only the workflow itself.
  const workflow = read('.github/workflows/test.yml').split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(workflow, /^on:\n\s+push:\n(?:\s+.*\n)*?\s+pull_request:/m);
  assert.doesNotMatch(workflow, /paths:/, 'no path filter: runner and script changes are tested too');
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /PG_BIN="\$\(pg_config --bindir/);
  assert.doesNotMatch(workflow, /gh-pages|git push|contents: write|secrets\./, 'tests only: no deploy, no secrets');
});
