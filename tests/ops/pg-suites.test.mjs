// QA OPS-012: the PostgreSQL suites written in Python (tests/*/postgres-*.py)
// were cited as coverage but run by nothing: `npm test` runs node tests only.
// They now run from CI through scripts/run-pg-suites.mjs (test.yml, after
// npm test). This keeps that list whole and the suites portable to the CI
// runner; it does not run them (npm run test:pg-suites does).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SUITES, MANUAL, allSuites, supersededCoverage } from '../../scripts/run-pg-suites.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('every PostgreSQL suite is either run by the runner or listed as manual, with the reason', () => {
  const all = allSuites();
  assert.ok(all.length >= 13);
  assert.deepEqual(all.filter((s) => !SUITES.includes(s) && !(s in MANUAL)), [], 'add a new postgres-*.py to SUITES in scripts/run-pg-suites.mjs');
  assert.deepEqual(SUITES.filter((s) => !all.includes(s)), [], 'a listed suite no longer exists');
  for (const why of Object.values(MANUAL)) assert.match(why, /private/);
});

test('every suite runs on the CI runner: PG_BIN is honoured and no macOS-only temp path is used', () => {
  for (const suite of allSuites()) {
    const text = read(suite);
    assert.match(text, /os\.environ\.get\('PG_BIN'\)/, `${suite} honours PG_BIN`);
    assert.doesNotMatch(text, /\/private\/tmp/, `${suite} uses a temp path Linux has`);
  }
});

test('CI runs them after the node tests, and npm has the script', () => {
  assert.equal(JSON.parse(read('package.json')).scripts['test:pg-suites'], 'node scripts/run-pg-suites.mjs');
  const workflow = read('.github/workflows/test.yml');
  assert.ok(workflow.indexOf('npm run test:pg-suites') > workflow.indexOf('npm test'), 'after npm test, so no two disposable servers compete');
});

test('a suite that tests a function a later, unapplied migration redefines is reported as superseded', () => {
  const migrations = { '001_a.sql': 'create or replace function public.alpha() returns int language sql as $$ select 1 $$;', '002_b.sql': 'create or replace function public.beta() returns int language sql as $$ select 1 $$;', '003_c.sql': 'create or replace function public.alpha() returns int language sql as $$ select 2 $$;' };
  const names = Object.keys(migrations);
  assert.deepEqual(supersededCoverage("apply('001_a.sql'); apply('002_b.sql')", names, (n) => migrations[n]), [{ fn: 'public.alpha', pinned: '001_a.sql', later: ['003_c.sql'] }]);
  assert.deepEqual(supersededCoverage("apply('001_a.sql'); apply('003_c.sql')", names, (n) => migrations[n]), []);
});
