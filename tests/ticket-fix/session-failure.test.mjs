// A failed model session says why (2026-09-29): the reproduction stopped at
// its $3 budget and the log said only "exited 1", because runSession dropped
// the CLI's result event on a non-zero exit and the session's stderr went to
// the shell's run directory, which is deleted on exit. A stand-in CLI here
// stops the way the real one does (a result event with subtype
// error_max_budget_usd, its cost and turns, then exit 1) and prints
// credential-shaped text on stderr. Every value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSession, sessionFacts, failureReason, usageLimitHit } from '../../scripts/ticket-fix/worker.mjs';
import { redactSecrets, redactedLine, REDACTED } from '../../scripts/ticket-fix/redact.mjs';
import { EXIT, REPRO_SCHEMA } from '../../scripts/ticket-fix/run.mjs';
import { readRun } from '../../scripts/ticket-fix/merge.mjs';
import { project, runStub, CHECKLIST_RESULT, TICKET, RUN_ID } from './stage2-helpers.mjs';

const SESSION = '00000000-0000-4000-8000-00000000f00d';
// The runner's model credential in these tests: a synthetic value.
const CREDENTIAL = `synthetic-model-credential-${'q7'.repeat(12)}`;
const BEARER = 'abcDEF123456'.repeat(4);
const OAUTH_SHAPE = `sk-ant-oat01-${'Zx9'.repeat(30)}`;
const NAME = `${TICKET.slice(0, 8)}-${RUN_ID}`;

// The CLI's own words when the subscription's limit is reached (2026-09-29).
const LIMIT_TEXT = "You've hit your session limit · resets 2pm (America/Los_Angeles)";

// The stand-in CLI: the extractor succeeds; every other role reads its
// credential from the pipe, prints it and two token shapes on stderr, and
// stops at its budget. limit: every other role stops at once on the
// subscription's limit, as the real CLI did (exit 1, one turn, no cost).
function fakeCli({ limit = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fake-claude-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
const extract = args.includes('--input-format');
const fd = process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
let credential = '';
if (fd) { try { credential = fs.readFileSync(Number(fd), 'utf8').trim(); } catch { credential = ''; } }
try { fs.readFileSync(0); } catch { /* no input */ }
const out = event => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(SESSION)} });
if (extract) {
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1234, session_id: ${JSON.stringify(SESSION)}, structured_output: ${JSON.stringify(CHECKLIST_RESULT)} });
  process.exit(0);
}
if (${JSON.stringify(limit)}) {
  out({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, session_id: ${JSON.stringify(SESSION)}, result: ${JSON.stringify(LIMIT_TEXT)} });
  process.exit(1);
}
process.stderr.write('debug: role with schema keys ' + Object.keys(schema.properties || {}).join(',') + '\\n');
process.stderr.write('debug: credential ' + credential + '\\n');
process.stderr.write('debug: Authorization: Bearer ${BEARER}\\n');
process.stderr.write('debug: token shape ${OAUTH_SHAPE}\\n');
process.stderr.write('Error: Reached maximum budget ($3) in session ${SESSION}\\n');
out({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 57, total_cost_usd: 3.0096, session_id: ${JSON.stringify(SESSION)},
  errors: ['Reached maximum budget ($3)'], terminal_reason: 'budget_exhausted' });
process.exit(1);
`, { mode: 0o755 });
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const env = () => {
  const e = { ...process.env, ANTHROPIC_API_KEY: CREDENTIAL };
  delete e.CLAUDE_CODE_OAUTH_TOKEN;
  return e;
};
const leaks = text => [CREDENTIAL, BEARER, OAUTH_SHAPE, OAUTH_SHAPE.slice(0, 30)].filter(v => text.includes(v));

test('redaction: the credential, token shapes and values after a key name go; ids, paths, counts and the error text stay', () => {
  const text = [
    `using ${CREDENTIAL} for plainsecretvalue`,
    `Authorization: Bearer ${BEARER}`,
    `key ${OAUTH_SHAPE} and sbp_${'a1'.repeat(20)} and ghp_${'B2'.repeat(18)}`,
    `jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.${'s1'.repeat(16)}`,
    'x-hook-secret: 3f9a0c7e11d24b6f8a90c3e5d7f1a2b4c6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5',
    'SUPABASE_ACCESS_TOKEN=abcdefgh and password=hunter2x',
    `opaque ${'Q9w8E7r6'.repeat(4)} end`,
    '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
    `ticket ${TICKET} run ${NAME} in /Users/synthetic/Library/Application Support/CredentialDOMD/ticket-work/runs/${NAME}/sessions`,
    'input_tokens: 5831072, max_tokens=64000, Reached maximum budget ($3)',
  ].join('\n');
  const out = redactSecrets(text, [CREDENTIAL, 'plainsecretvalue']);
  for (const gone of [CREDENTIAL, 'plainsecretvalue', BEARER, OAUTH_SHAPE.slice(0, 20), 'sbp_a1a1', 'ghp_B2B2', 'eyJhbGciOiJIUzI1NiJ9', '3f9a0c7e11d24b6f', 'abcdefgh', 'hunter2x', 'Q9w8E7r6', 'MIIEv']) {
    assert.ok(!out.includes(gone), `${gone} left in:\n${out}`);
  }
  for (const kept of [TICKET, NAME, '/Users/synthetic/Library/Application Support/CredentialDOMD/ticket-work/runs/', 'input_tokens: 5831072', 'max_tokens=64000', 'Reached maximum budget ($3)', 'Authorization:']) {
    assert.ok(out.includes(kept), `${kept} lost in:\n${out}`);
  }
  assert.ok(out.includes(REDACTED));
  assert.equal(redactedLine(`a\u0000b\tc ${CREDENTIAL}\n${'x'.repeat(400)}`, [CREDENTIAL]).length, 300);
  assert.ok(redactedLine(`a\u0000b\tc ${CREDENTIAL}`, [CREDENTIAL]).startsWith(`a b c ${REDACTED}`));
});

test('the session facts and reason name the result subtype, cost, turns and the last error line', () => {
  const output = { type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 57, total_cost_usd: 3.0096, errors: ['Reached maximum budget ($3)'] };
  const facts = sessionFacts({ output, stderrText: 'first\nError: last line\n\n', secrets: [] });
  assert.deepEqual({ ...facts }, { subtype: 'error_max_budget_usd', cost_usd: 3.0096, turns: 57, error: 'Reached maximum budget ($3)', stderr_last_line: 'Error: last line', stderr_file: null });
  assert.equal(failureReason('exited 1', facts), 'exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3)');
  // No result event (a crash before the first turn): the last stderr line.
  const crash = sessionFacts({ output: null, stderrText: `Error: EPERM spawn /usr/bin/security ${CREDENTIAL}\n`, secrets: [CREDENTIAL] });
  assert.equal(crash.error, `Error: EPERM spawn /usr/bin/security ${REDACTED}`);
  assert.equal(failureReason('exited 1', crash), `exited 1: Error: EPERM spawn /usr/bin/security ${REDACTED}`);
  // A success result's text is the model's answer, never an error line.
  assert.equal(sessionFacts({ output: { subtype: 'success', is_error: false, result: 'model text', num_turns: 3, total_cost_usd: 0.5 } }).error, null);
  assert.equal(failureReason('timed out after 900 s', {}), 'timed out after 900 s');
});

test('runSession reads the result event of a session that exits non-zero and keeps its stderr redacted and owner-only', async () => {
  const cli = fakeCli();
  try {
    const stderrFile = path.join(cli.dir, 'runs', 'r', 'sessions', '02-repro.stderr.log');
    const r = await runSession({ claude: cli.file, role: 'repro', cwd: cli.dir, input: 'Synthetic input', schema: REPRO_SCHEMA, settings: { permissions: {} },
      sessionDir: path.join(cli.dir, 'session'), timeoutMs: 30000, baseEnv: env(), stderrFile });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3)');
    assert.equal(r.usage_limit, undefined, 'a budget stop is a real failure');
    assert.equal(r.session.subtype, 'error_max_budget_usd');
    assert.equal(r.session.cost_usd, 3.0096);
    assert.equal(r.session.turns, 57);
    assert.equal(r.session.terminal_reason, 'budget_exhausted');
    assert.equal(r.session.stderr_last_line, `Error: Reached maximum budget ($3) in session ${SESSION}`);
    assert.equal(r.session.stderr_file, stderrFile);
    assert.equal(statSync(stderrFile).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(stderrFile)).mode & 0o777, 0o700);
    const kept = readFileSync(stderrFile, 'utf8');
    assert.match(kept, /debug: role with schema keys kind,reason,tests/);
    assert.match(kept, /debug: credential \[redacted\]/, 'the credential the CLI was handed on its pipe');
    assert.deepEqual(leaks(kept), []);
    assert.deepEqual(leaks(JSON.stringify(r.session)), []);
    assert.ok(kept.includes(SESSION), 'session ids survive');
  } finally { cli.cleanup(); }
});

test('run.mjs: a reproduction that stops at its budget is recorded with its subtype, cost and error, its stderr outlives the run directory, and nothing holds the credential', async () => {
  const p = project();
  const cli = fakeCli();
  let r;
  try {
    r = await runStub(p, {}, { extra: { launchSession: undefined, claude: cli.file, env: env() } });
    assert.equal(r.code, EXIT.model, r.logs.join('\n'));
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'model_failed');
    assert.equal(run.repro.status, 'failed');
    assert.equal(run.repro.reason, 'exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3)');
    assert.deepEqual(run.repro.session, { subtype: 'error_max_budget_usd', cost_usd: 3.0096, turns: 57, error: 'Reached maximum budget ($3)', stderr: 'sessions/02-repro.stderr.log' });
    assert.equal(run.session.stderr, 'sessions/03-worker.stderr.log', 'the worker failed the same way');
    assert.deepEqual(run.sessions.map(s => [s.n, s.role, s.ok, s.subtype, s.cost_usd, s.turns, s.stderr]), [
      [1, 'extract', true, 'success', 0.1234, 1, null],
      [2, 'repro', false, 'error_max_budget_usd', 3.0096, 57, 'sessions/02-repro.stderr.log'],
      [3, 'worker', false, 'error_max_budget_usd', 3.0096, 57, 'sessions/03-worker.stderr.log'],
    ]);
    assert.equal(run.sessions[1].error, 'Reached maximum budget ($3)');
    assert.equal(run.cost_usd, 6.1426);
    // The log: one line per session, and the reproduction's reason.
    const log = r.logs.join('\n');
    assert.ok(r.logs.includes('SESSION — 00000000: extract 1 turn(s), $0.1234'), log);
    assert.ok(r.logs.includes(`SESSION — 00000000: repro FAILED exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3); stderr kept in ticket-work/runs/${NAME}/sessions/02-repro.stderr.log`), log);
    assert.ok(r.logs.includes('REPRO — 00000000: session exited 1 (error_max_budget_usd, 57 turns, $3.0096): Reached maximum budget ($3); no reproduction recorded'), log);
    // The shell deletes its run directory on exit; the stderr is not in it.
    const sessions = path.join(p.work, 'runs', NAME, 'sessions');
    assert.ok(!readdirSync(r.runDir).some(f => f.endsWith('stderr.log')));
    r.cleanup();
    assert.equal(existsSync(r.runDir), false);
    assert.deepEqual(readdirSync(sessions).sort(), ['02-repro.stderr.log', '03-worker.stderr.log']);
    assert.equal(statSync(sessions).mode & 0o777, 0o700);
    for (const f of readdirSync(sessions)) {
      assert.equal(statSync(path.join(sessions, f)).mode & 0o777, 0o600, f);
      const text = readFileSync(path.join(sessions, f), 'utf8');
      assert.match(text, /Error: Reached maximum budget/);
      assert.match(text, /debug: credential \[redacted\]/, 'the CLI printed its credential; the host kept none of it');
      assert.deepEqual(leaks(text), [], f);
    }
    assert.deepEqual(leaks(log), []);
    assert.deepEqual(leaks(readFileSync(path.join(p.work, 'runs', NAME, 'run.json'), 'utf8')), []);
  } finally { r?.cleanup(); cli.cleanup(); p.cleanup(); }
});

// The subscription's limit (2026-09-29): three runs whose every session exited
// 1 with it parked two tickets. It is read from a failed session's CLI text
// only, and only in its "hit/reached" forms.
test('usage limit: the CLI\'s limit text in a failed session\'s result, errors or stderr; never a budget stop, a near-limit warning or a model\'s answer', () => {
  const failed = result => ({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, result });
  assert.equal(usageLimitHit({ code: 1, output: failed(LIMIT_TEXT) }), true);
  for (const text of ["You've hit your limit · resets 3pm", "You've reached your usage limit.", 'Claude AI usage limit reached|1790700000', '5-hour limit reached ∙ resets 2pm', 'Weekly limit reached · resets Mon 9am']) {
    assert.equal(usageLimitHit({ code: 1, output: failed(text) }), true, text);
  }
  assert.equal(usageLimitHit({ code: 1, output: { is_error: true, errors: [LIMIT_TEXT] } }), true, 'in the errors list');
  assert.equal(usageLimitHit({ code: 1, output: null, stderrText: `debug: start\n${LIMIT_TEXT}\n` }), true, 'the last stderr line, with no result event');
  assert.equal(usageLimitHit({ code: 1, output: { subtype: 'success', is_error: false, result: LIMIT_TEXT } }), true, 'a non-zero exit\'s result is the CLI\'s');
  // Real failures, and text that is not the CLI saying the limit was hit.
  assert.equal(usageLimitHit({ code: 1, output: { subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($3)'] } }), false);
  assert.equal(usageLimitHit({ code: 1, output: failed('API Error: 500 Internal server error') }), false);
  assert.equal(usageLimitHit({ code: 1, output: failed('Context limit reached: the conversation is too long') }), false);
  assert.equal(usageLimitHit({ code: 1, output: null, stderrText: "Warning: you are approaching your usage limit\nError: spawn EPERM\n" }), false);
  assert.equal(usageLimitHit({ code: 0, output: { subtype: 'success', is_error: false, result: `The member wrote: ${LIMIT_TEXT}` } }), false, 'a model\'s answer is never read');
  assert.equal(usageLimitHit(), false);
});

test('runSession marks a session the limit stopped; run.mjs pauses the run (exit 8) with no later session, and records why', async () => {
  const p = project();
  const cli = fakeCli({ limit: true });
  let r;
  try {
    const one = await runSession({ claude: cli.file, role: 'repro', cwd: cli.dir, input: 'Synthetic input', schema: REPRO_SCHEMA, settings: { permissions: {} },
      sessionDir: path.join(cli.dir, 'session'), timeoutMs: 30000, baseEnv: env() });
    assert.equal(one.ok, false);
    assert.equal(one.usage_limit, true);
    assert.equal(one.reason, `exited 1 (success, 1 turn, $0.0000): ${LIMIT_TEXT}`);
    r = await runStub(p, {}, { extra: { launchSession: undefined, claude: cli.file, env: env() } });
    assert.equal(r.code, EXIT.usageLimit, r.logs.join('\n'));
    const run = await readRun(p.work, NAME);
    assert.equal(run.status, 'paused');
    assert.deepEqual(run.sessions.map(s => [s.n, s.role, s.ok, s.subtype, s.cost_usd, s.turns]), [[1, 'extract', true, 'success', 0.1234, 1], [2, 'repro', false, 'success', 0, 1]],
      'the worker never started');
    assert.equal(run.sessions[1].error, LIMIT_TEXT);
    assert.ok(r.logs.includes(`PAUSED — 00000000 run ${NAME}: the repro session hit the subscription's usage limit (exited 1 (success, 1 turn, $0.0000): ${LIMIT_TEXT}); nothing counted`), r.logs.join('\n'));
    assert.deepEqual(leaks(r.logs.join('\n')), []);
  } finally { r?.cleanup(); cli.cleanup(); p.cleanup(); }
});
