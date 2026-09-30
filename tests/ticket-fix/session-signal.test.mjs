// A session in flight when the runner is signalled (review of 2026-09-29).
// ticket-agent.sh runs `run.mjs work` under a 3-hour alarm and launchd may
// stop the job; the stop handler killed every process group and exited, while
// the session's stderr was still in memory (it is written when the session
// ends) and the run record had no entry for it, so a hung session, the case
// that most needs a reason, left none. Here the real runner command runs a
// stand-in CLI that prints to stderr and then hangs; the test sends SIGALRM.
// Every value is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxAvailable } from '../../scripts/ticket-fix/sandbox.mjs';
import { project, context, CHECKLIST_RESULT, TICKET, RUN_ID, COMMITTER } from './stage2-helpers.mjs';

const RUN = fileURLToPath(new URL('../../scripts/ticket-fix/run.mjs', import.meta.url));
const NAME = `${TICKET.slice(0, 8)}-${RUN_ID}`;
const SESSION = '00000000-0000-4000-8000-00000000beef';
const CREDENTIAL = `synthetic-model-credential-${'k4'.repeat(12)}`;
// Waits for check(), and stops early when stop() says it never will.
const until = async (check, ms, what, stop = () => false) => {
  for (const end = Date.now() + ms; Date.now() < end && !stop(); await new Promise(done => setTimeout(done, 100))) if (check()) return;
  throw Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
};
const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

// The stand-in CLI: the extractor answers; the reproduction prints its
// credential and a line on stderr, says it started (in its own session
// directory, which the sandbox lets it write) and never finishes. It lives
// in its own folder: a session may not read the run directory.
function hangingCli() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fake-claude-')));
  const file = path.join(dir, 'claude');
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const fd = process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
let credential = '';
if (fd) { try { credential = fs.readFileSync(Number(fd), 'utf8').trim(); } catch { credential = ''; } }
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* no input */ }
const out = event => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(SESSION)} });
if (args.includes('--input-format')) {
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1234, session_id: ${JSON.stringify(SESSION)}, structured_output: ${JSON.stringify(CHECKLIST_RESULT)} });
  process.exit(0);
}
process.stderr.write('debug: reading the synthetic ticket\\ndebug: credential ' + credential + '\\n', () => {
  const history = /The case history file, \x60([^\x60]+)\x60/.exec(input)?.[1] ?? null;
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '..', 'started'), JSON.stringify({ pid: process.pid, history, there: history ? fs.existsSync(history) : false, slots: process.env.PG_TEST_SLOT_DIR ?? null }));
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('SIGALRM during a session: its stderr is kept (redacted, owner-only), and the run record has the session and the stop', {
  skip: process.platform === 'darwin' && sandboxAvailable() ? false : 'the runner command runs every session under sandbox-exec, which is not available here', timeout: 180000,
}, async () => {
  const p = project();
  const runDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'credentialdomd-ticket-context.')));
  chmodSync(runDir, 0o700);
  const cli = hangingCli();
  let child, ended = false;
  const logs = [];
  try {
    const contextFile = path.join(runDir, `${TICKET}-context.json`);
    writeFileSync(contextFile, JSON.stringify(context()), { mode: 0o600 });
    const env = { ...process.env, ANTHROPIC_API_KEY: CREDENTIAL };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    child = spawn(process.execPath, [RUN, 'work', '--ticket', TICKET, '--context', contextFile, '--output', path.join(runDir, `${TICKET}-output.json`),
      '--run-file', path.join(runDir, `${TICKET}-run.json`), '--run-id', RUN_ID, '--run-dir', runDir, '--repo', p.repo, '--work', p.work, '--state', p.state,
      '--claude', cli.file, '--committer', COMMITTER, '--auto-merge', 'off'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logs.push(String(d)));
    child.stderr.on('data', d => logs.push(String(d)));
    const exited = new Promise(resolve => child.on('exit', (code, signal) => { ended = true; resolve({ code, signal }); }));
    const started = path.join(runDir, `${TICKET}-sessions`, 'repro', 'started');
    await until(() => existsSync(started), 120000, () => `the reproduction session to start\n${logs.join('')}`, () => ended);
    const { pid, history, there, slots } = JSON.parse(readFileSync(started, 'utf8'));
    assert.ok(history && there, 'the session could see its case history file');
    assert.ok(slots && existsSync(slots), 'the session has the run\'s PostgreSQL test slot directory');
    // Its stderr has left the stand-in; give the runner a moment to read it.
    await new Promise(done => setTimeout(done, 500));
    child.kill('SIGALRM');
    const { code } = await exited;
    assert.equal(code, 142, logs.join(''));
    await until(() => gone(pid), 10000, 'the session process group to be killed');
    const run = JSON.parse(readFileSync(path.join(p.work, 'runs', NAME, 'run.json'), 'utf8'));
    assert.equal(run.status, 'killed');
    assert.equal(run.reason, 'the runner was stopped by SIGALRM');
    assert.equal(run.stopped.signal, 'SIGALRM');
    assert.deepEqual(run.sessions.map(s => [s.n, s.role, s.ok, s.cost_usd]), [[1, 'extract', true, 0.1234], [2, 'repro', false, null]]);
    assert.equal(run.sessions[1].reason, 'killed by SIGALRM');
    assert.equal(run.sessions[1].stderr, 'sessions/02-repro.stderr.log');
    assert.equal(run.cost_usd, 0.1234);
    const kept = path.join(p.work, 'runs', NAME, 'sessions', '02-repro.stderr.log');
    assert.equal(statSync(kept).mode & 0o777, 0o600);
    const text = readFileSync(kept, 'utf8');
    assert.match(text, /debug: reading the synthetic ticket/);
    assert.match(text, /debug: credential \[redacted\]/);
    assert.match(text, /\[the runner was stopped by SIGALRM while this session was running\]\n$/);
    assert.ok(!text.includes(CREDENTIAL));
    assert.ok(!readFileSync(path.join(p.work, 'runs', NAME, 'run.json'), 'utf8').includes(CREDENTIAL));
    assert.equal(existsSync(history), false, 'the case history file and its folder go with the stopped run');
    assert.equal(existsSync(path.dirname(path.dirname(history))), false);
    // So does the run's slot directory: the stop hooks run instead of the
    // run's own cleanup, which removed it only when the run ended.
    assert.equal(existsSync(slots), false, 'the run\'s PostgreSQL test slot directory goes with the stopped run');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(runDir, { recursive: true, force: true });
    cli.cleanup();
    p.cleanup();
  }
});
