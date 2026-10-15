#!/usr/bin/env node
// One repeatable local regression run. No deploy, provider send, or production mutation.
import { spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GENERATED_DIR, REPO_ROOT, isMain } from './lib/paths.mjs';
import { captureSource, appEvidenceProblem } from './lib/source-evidence.mjs';
import { readRuntime } from './lab.mjs';
import { writeReview } from './report.mjs';
import { SUITES } from '../scripts/run-pg-suites.mjs';

export function verificationSteps(results) {
  return [
    { name: 'prepare', args: ['scripts/build-credential-portal.mjs'] },
    // Bound database fixtures to avoid exhausting macOS shared-memory slots.
    { name: 'unit-integration', args: ['--experimental-vm-modules', '--test', '--test-reporter=tap', '--test-concurrency=6', 'tests/**/*.test.mjs', 'scripts/*.test.mjs'] },
    { name: 'postgres', args: ['scripts/run-pg-suites.mjs'] },
    { name: 'smoke', args: ['qa-lab/smoke.mjs'] },
    { name: 'browser', args: ['qa-lab/e2e/run.mjs'], env: { QA_E2E_RESULTS: results, QA_E2E_NO_RESTART: '1' } },
  ];
}

export function requirePostgres(env = process.env, check = file => accessSync(file, constants.X_OK)) {
  const directories = new Set([env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin', env.ADMIN_TEST_PG_BIN || env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin']);
  for (const directory of directories) for (const name of ['initdb', 'pg_ctl', 'postgres', 'psql', 'createdb']) {
    try { check(path.join(directory, name)); }
    catch { throw new Error(`Required PostgreSQL binary is unavailable: ${path.join(directory, name)}. Verification refuses a skipped database suite.`); }
  }
}

export function stepEvidence(name, log) {
  if (name === 'postgres') {
    const match = /^(\d+) of (\d+) PostgreSQL suites passed$/m.exec(log);
    return { executed: !!match && +match[1] === SUITES.length && +match[2] === SUITES.length,
      suitesPassed: match ? +match[1] : 0, suitesRequired: SUITES.length };
  }
  if (name === 'unit-integration') {
    const count = label => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(log)?.[1] ?? NaN);
    const tests = count('tests'), failed = count('fail'), skipped = count('skipped');
    return { executed: tests > 0 && failed === 0 && Number.isFinite(skipped), tests, failed, skipped };
  }
  return { executed: true };
}

export function verificationReady(steps, review, before, after) {
  return steps.length === 5 && steps.every(s => s.exitCode === 0 && s.evidence?.executed === true)
    && review?.readiness?.ready === true && before.fingerprint === after.fingerprint;
}

function runStep(step, directory) {
  return new Promise(resolve => {
    const logFile = path.join(directory, `${step.name}.log`), log = createWriteStream(logFile);
    const startedAt = new Date().toISOString();
    console.log(`qa-verify: ${step.name} started; log ${logFile}`);
    const child = spawn(process.execPath, step.args, { cwd: REPO_ROOT, env: { ...process.env, ...step.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let error = null;
    child.once('error', e => { error = e.message; });
    child.once('close', code => {
      log.end(() => {
        const evidence = stepEvidence(step.name, readFileSync(logFile, 'utf8'));
        const exitCode = (code ?? 1) || (evidence.executed ? 0 : 1);
        console.log(`qa-verify: ${step.name} ${exitCode === 0 ? 'passed' : 'failed'}`);
        resolve({ name: step.name, startedAt, finishedAt: new Date().toISOString(), exitCode, evidence, logFile, ...(error ? { error } : {}) });
      });
    });
  });
}

export function createVerificationDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('Verification output directory is not empty; use a new directory so old results cannot be reported as this run.');
}

export async function verify({ outDir = path.join(GENERATED_DIR, 'verification', new Date().toISOString().replace(/[:.]/g, '-')) } = {}) {
  requirePostgres();
  const source = captureSource(), runtime = readRuntime();
  const problem = appEvidenceProblem(runtime, source);
  if (problem) throw new Error(problem);
  const health = await fetch(`${runtime.urls.mock}/qa/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error('The selected local QA lab is not healthy.');
  const directory = path.resolve(outDir);
  createVerificationDirectory(directory);
  const results = path.join(directory, 'browser-results.json'), steps = [];
  for (const step of verificationSteps(results)) steps.push(await runStep(step, directory));
  const { review, html } = writeReview({ resultsFile: results, outDir: path.join(directory, 'review') });
  const sourceAtEnd = captureSource();
  const ready = verificationReady(steps, review, source, sourceAtEnd);
  const summary = { scope: 'local-lab', ready, source, sourceAtEnd, steps, checklist: review.summary, reviewFile: html,
    limitations: 'Local provider mocks only. Open/partial/blocked checklist items and changed source prevent a ready result.' };
  writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`qa-verify: ${ready ? 'local verification passed' : 'verification incomplete — inspect failed steps and open checklist items'}; ${html}`);
  return summary;
}

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
    const result = await verify({ outDir: values.out });
    process.exitCode = result.ready ? 0 : 1;
  } catch (e) { console.error(`qa-verify: ${e.message}`); process.exitCode = 1; }
}
