// QA ADMIN-001: PostgREST re-runs any request whose transaction fails with
// SQLSTATE 40001, so a function that raises 40001 for a refusal that can
// never pass (a stale expected state) loops forever inside PostgREST,
// holding its row locks, and the caller never gets an answer. Production
// runs PostgREST 14.5; an isolated 14.14 re-ran such an RPC about 16,000
// times in 20 seconds and kept going after the caller left.
//
// This reads every migration in apply order, keeps each function's last
// definition (the one production runs), and refuses a raise with a class 40
// (transaction rollback) SQLSTATE in any of them. It failed on release/qa1:
// admin_change_profile_access and admin_change_invite both raised 40001.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

/** { 'schema.name': { file, body } } for the last definition of each function. */
function latestFunctionBodies() {
  const latest = {};
  const header = /create\s+(?:or\s+replace\s+)?function\s+("?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const match of text.matchAll(header)) {
      const rest = text.slice(match.index + match[0].length);
      const open = rest.match(/\$([A-Za-z_]*)\$/);
      if (!open) continue;
      const start = open.index + open[0].length;
      const end = rest.indexOf(open[0], start);
      if (end < 0) continue;
      const schema = (match[1] || 'public.').replaceAll('"', '').slice(0, -1).toLowerCase();
      latest[`${schema}.${match[2].toLowerCase()}`] = { file, body: rest.slice(start, end) };
    }
  }
  return latest;
}

const RETRYABLE = /errcode\s*=\s*'(?:40[0-9A-Z]{3}|serialization_failure|deadlock_detected|transaction_rollback|transaction_integrity_constraint_violation|statement_completion_unknown)'|raise\s+(?:exception\s+)?(?:sqlstate\s+'40|serialization_failure|deadlock_detected)/i;

test('no function, as last defined, raises a retryable (class 40) SQLSTATE', () => {
  const latest = latestFunctionBodies();
  assert.ok(Object.keys(latest).length > 100, 'the migration reader found the functions');
  const offenders = Object.entries(latest)
    .filter(([, { body }]) => RETRYABLE.test(body))
    .map(([name, { file, body }]) => `${name} (${file}): ${body.match(RETRYABLE)[0]}`);
  assert.deepEqual(offenders, []);
});

test('the admin stale-state refusals are PT409 with their messages unchanged', () => {
  const latest = latestFunctionBodies();
  assert.equal(latest['public.admin_change_profile_access'].file, '20260930030000_admin_refusals_not_retryable.sql');
  assert.match(latest['public.admin_change_profile_access'].body, /raise exception 'Account changed\. Refresh and review it again' using errcode='PT409';/);
  assert.equal(latest['public.admin_change_invite'].file, '20260930030000_admin_refusals_not_retryable.sql');
  assert.match(latest['public.admin_change_invite'].body, /raise exception 'Invitation changed\. Refresh and review it again' using errcode='PT409';/);
});

test('the reader sees a 40001 raise when there is one', () => {
  assert.ok(RETRYABLE.test("raise exception 'x' using errcode='40001';"));
  assert.ok(RETRYABLE.test("raise exception 'x' using errcode = '40P01';"));
  assert.ok(RETRYABLE.test('raise serialization_failure;'));
  assert.ok(!RETRYABLE.test("raise exception 'x' using errcode='PT409';"));
  assert.ok(!RETRYABLE.test("raise exception 'x' using errcode='22023';"));
});
