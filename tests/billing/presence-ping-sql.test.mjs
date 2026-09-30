// AUTH-001: touch_last_seen() never stamped a pending or read-only account.
// It is SECURITY DEFINER, but the profiles preferences guard
// (20260920230000) still sees role 'authenticated', last_seen_at is not a
// preference, and the account may not write Credential: 42501, swallowed by
// the client, so Admin > Users showed "last seen: never" for exactly the
// signups the owner follows up. 20260930003000 lets only this function's own
// update through.
//
// Real PostgreSQL with the actual access chain underneath (billingChainFixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pgSkip } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readOptional } from './billingChainFixture.mjs';

const NAME = '20260930003000_touch_last_seen_any_account';
const MIGRATION = readOptional(`supabase/migrations/${NAME}.sql`);
const ROLLBACK = readOptional(`docs/rollback/${NAME}.rollback.sql`);
// The production body (20260816_beta_access.sql), with its 20260913 grants.
const BEFORE = readOptional('supabase/migrations/20260816_beta_access.sql')
  .match(/create or replace function public\.touch_last_seen\(\)[\s\S]*?\$\$;/)[0];

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
  }
});

test('every signed-in account is stamped; a direct write is still refused', { skip: pgSkip(), timeout: 240000 }, async t => {
  const db = await billingChain({ port: 58979, label: 'presence-ping', idPrefix: '72000000' });
  const { sql, as, enroll, buy, pid, subject } = db;
  try {
    await sql(`alter table profiles add column last_seen_at timestamptz;
      grant update on profiles to authenticated;
      create function public.current_profile_id() returns uuid language sql stable security definer set search_path=public as $$select id from profiles where auth_user_id=auth.jwt()->>'sub'$$;
      ${BEFORE}
      revoke execute on function public.touch_last_seen() from public, anon;
      grant execute on function public.touch_last_seen() to authenticated, service_role;`);
    await enroll(1);                       // pending: signed up, nothing bought
    await enroll(2); await buy(2, 'core'); // a paid member
    await enroll(3); await buy(3, 'core');
    await sql(`update billing_subscriptions set status='past_due',membership_active=false where profile_id='${pid(3)}'`); // read-only now
    const ping = n => as('authenticated', 'select touch_last_seen()', subject(n));
    const seen = n => sql(`select last_seen_at is not null from profiles where id='${pid(n)}'`).then(v => v === 't');

    await t.test('the defect, before the migration: pending and read-only accounts are refused', async () => {
      const pending = await ping(1);
      assert.notEqual(pending.code, 0);
      assert.match(pending.stderr, /membership read only/);
      assert.equal(await seen(1), false);
      assert.equal((await ping(3)).code === 0 && await seen(3), false);
      assert.equal((await ping(2)).code, 0);
      assert.equal(await seen(2), true, 'a paid member was always stamped');
    });

    assert.ok(MIGRATION, `${NAME}.sql is missing`);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('pending, paid and read-only accounts are all stamped', async () => {
      for (const n of [1, 2, 3]) {
        const r = await ping(n);
        assert.equal(r.code, 0, `${n}: ${r.stderr}`);
        assert.equal(await seen(n), true, `account ${n}`);
      }
    });

    await t.test('the flag does not outlive the ping; a direct write is still refused', async () => {
      const r = await as('authenticated', `select touch_last_seen(); update profiles set name='Changed' where id='${pid(1)}'`, subject(1));
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /membership read only/);
      const direct = await as('authenticated', `update profiles set last_seen_at='2000-01-01' where id='${pid(1)}'`, subject(1));
      assert.notEqual(direct.code, 0, 'last_seen_at is not a column a pending client may set');
    });

    await t.test('grants: authenticated and service role, never anon', async () => {
      assert.equal(await sql("select has_function_privilege('anon','public.touch_last_seen()','execute')"), 'f');
      assert.equal(await sql("select has_function_privilege('authenticated','public.touch_last_seen()','execute')"), 't');
    });

    await t.test('rollback restores the refusal, runs twice, and forward again', async () => {
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK); await sql(ROLLBACK);
      assert.notEqual((await ping(1)).code, 0);
      assert.equal(await sql("select has_function_privilege('anon','public.touch_last_seen()','execute')"), 'f');
      await sql(MIGRATION);
      assert.equal((await ping(1)).code, 0);
    });
  } finally {
    await db.close();
  }
});
