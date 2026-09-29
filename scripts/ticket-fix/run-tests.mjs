#!/usr/bin/env node
// Run tests on the host and record, per test, whether it passed at HEAD. The
// gates file is the only thing a reply's {"test": ...} evidence is checked
// against: the writer's own account of a test run is never evidence.
//
//   node scripts/ticket-fix/run-tests.mjs --out <gates.json> -- <test file> [...]
//
// The file records HEAD and whether the tree was clean (no modified tracked
// file, no untracked file under src/ or tests/); a claim is confirmed only
// from a clean run at the HEAD the reply is checked at, and only when the
// live build contains that HEAD. The file is the dry run's cache:
// post-reply.mjs runs the cited tests again itself (runTestsNow) when it
// posts, so a hand-written gates file confirms nothing.
// Exits with the test run's own exit code.
import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRunner, writePrivate } from './reply.mjs';
import { safeRepoPath } from './claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRODUCER = 'scripts/ticket-fix/run-tests.mjs';

export async function runTests({ repo: given, files, out, env = process.env, quiet = false }) {
  const repo = realpathSync(given);
  const relative = file => { try { return path.relative(repo, realpathSync(file)); } catch { return path.relative(repo, file); } };
  if (!files.length) throw Error('Name at least one test file after --');
  for (const file of files) if (!safeRepoPath(file) || !/\.test\.m?js$/.test(file)) throw Error(`Not a repository test file: ${file}`);
  const git = gitRunner(repo);
  const head = git.head();
  const dirty = git.dirty();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ticket-gates-'));
  try {
    const events = path.join(scratch, 'events.jsonl');
    const command = [process.execPath, '--experimental-vm-modules', '--test', '--test-concurrency=1',
      `--test-reporter=${path.join(HERE, 'gates-reporter.mjs')}`, `--test-reporter-destination=${events}`,
      ...(quiet ? [] : ['--test-reporter=spec', '--test-reporter-destination=stdout']), ...files];
    // A parent node --test marks its children with NODE_TEST_CONTEXT; a run
    // that inherits it reports to that parent instead of running normally.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
    const run = spawnSync(command[0], command.slice(1), { cwd: repo, env: childEnv, stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'], timeout: 30 * 60 * 1000 });
    let lines = [];
    try { lines = (await fs.readFile(events, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const tests = lines.filter(t => t.kind !== 'suite').map(t => ({
      id: `${t.file ? relative(t.file) : '(unknown)'}::${t.name}`, status: t.status }));
    const gates = { version: 1, producer: PRODUCER, head, dirty, ran_at: new Date().toISOString(),
      files, exit_code: run.status ?? 1, tests };
    await writePrivate(out, `${JSON.stringify(gates, null, 2)}\n`);
    return gates;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// A fresh host run into a private scratch file, for post-reply.mjs.
export async function runTestsNow({ repo, files, env = process.env }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'ticket-post-gates-'));
  try { return await runTests({ repo, files, out: path.join(scratch, 'gates.json'), env, quiet: true }); } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function main(argv = process.argv.slice(2)) {
  const split = argv.indexOf('--');
  const options = split < 0 ? argv : argv.slice(0, split);
  const files = split < 0 ? [] : argv.slice(split + 1);
  if (options.length !== 2 || options[0] !== '--out') throw Error('Usage: run-tests.mjs --out <gates.json> -- <test file> [...]');
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  if (!repo) throw Error('Run inside the repository');
  const out = path.resolve(options[1]);
  const gates = await runTests({ repo, files, out });
  const count = status => gates.tests.filter(t => t.status === status).length;
  console.log(`gates: ${count('pass')} passed, ${count('fail')} failed, ${count('skip') + count('todo')} skipped at ${gates.head.slice(0, 12)}${gates.dirty ? ' (uncommitted or untracked changes: no claim can cite this run)' : ''}; wrote ${out}`);
  return gates.exit_code;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
