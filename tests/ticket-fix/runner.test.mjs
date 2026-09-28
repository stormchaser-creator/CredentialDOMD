// Phase 0 of the ticket-fix gates on the hourly runner: parked tickets skipped
// by the queue, owner alerts and a status file, a lock that records its
// owner, the bounded repair loop, and one reply path for sessions too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueSQL, parkedTargets, collectQueue, saveReview, loadContext } from '../../scripts/ticket-agent-context.mjs';
import { main as alert, lockState } from '../../scripts/ticket-fix/alert.mjs';
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

test('the runner shell: lock owner, bounded repair loop, park alert, status on every exit, autonomy unchanged', () => {
  const sh = read('scripts/ticket-agent.sh');
  assert.match(sh, /printf 'pid=%s\\nstarted=%s\\n' "\$\$" "\$\(date \+%s\)" > "\$LOCK\/owner"/);
  assert.match(sh, /trap '[^']*\/bin\/rm -f "\$LOCK\/owner"; rmdir "\$LOCK"[^']*' EXIT/);
  assert.match(sh, /trap 'EXIT_RC=\$\?; node "\$ALERT" status --state "\$CASE_STATE" --rc "\$EXIT_RC"/);
  assert.match(sh, /SKIP[^\n]*\n\s+node "\$ALERT" lock --state "\$CASE_STATE" --lock "\$LOCK" --notify "\$NOTIFY"/);
  assert.match(sh, /if \[ "\$VALID_RC" -ne 2 \] \|\| \[ "\$REPAIRS" -ge 2 \]; then break; fi/);
  assert.match(sh, /"\$CLAUDE" -p --resume "\$SESSION" --model claude-sonnet-5 --dangerously-skip-permissions \\\n\s+--output-format json --json-schema "\$SCHEMA"/);
  assert.match(sh, /if \[ \$\(\(FAILS \+ 1\)\) -eq 3 \]; then\n\s+node "\$ALERT" park --state "\$CASE_STATE" --ticket "\$TICKET_ID" --count 3 --notify "\$NOTIFY"/);
  assert.match(sh, /TICKET_PRE_HEAD="\$PRE_HEAD" TICKET_RUN_STARTED="\$RUN_STARTED" TICKET_DATABASE_TOKEN="\$TOKEN" node "\$REPO\/scripts\/ticket-agent-context.mjs" \\\n\s+--record-and-reply/);
  assert.match(sh, /RUN_STARTED=\$\(date -u '\+%Y-%m-%dT%H:%M:%SZ'\)/);
  assert.match(sh, /NOTIFY="\$REPO\/scripts\/notify-owner.sh"/);
  // Stage 1 leaves the model, its flags and the push-to-main workflow alone.
  assert.equal((sh.match(/"\$CLAUDE" -p/g) || []).length, 2);
  assert.equal((sh.match(/alarm 1500/g) || []).length, 1);
  assert.doesNotMatch(sh, /echo[^\n]*\$TOKEN/);
});

test('the prompt tells the model the rules the host now enforces', () => {
  const prompt = read('scripts/ticket-agent-prompt.md');
  assert.doesNotMatch(prompt, /Cite the fix commit/);
  assert.match(prompt, /\{\{FIX_COMMIT\}\}/);
  assert.match(prompt, /\{\{BUILD\}\}/);
  assert.match(prompt, /must say it was not tested there/);
  assert.match(prompt, /Never write "HIPAA" or "compliant"/);
  assert.match(prompt, /resumes\s+this session with the exact reason, at most twice/);
  assert.match(prompt, /never reopens a resolved or archived\s+ticket/);
  assert.doesNotMatch(prompt, /current open-status reply behavior/);
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
  }
  for (const cli of ['post-reply', 'verify-claims', 'run-tests', 'record-query', 'alert']) {
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
