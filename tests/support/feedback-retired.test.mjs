// QA OPS-013: submit-feedback had no caller, ran with verify_jwt off and let
// any signup (a pending profile) write unlimited feedback rows that reached
// the owner's phone; feedback_user_insert let the same profile insert
// straight through PostgREST. The function is retired to a 410 stub and the
// policy is dropped (20261001014600). Synthetic ids and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from '../ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const FUNCTION = read('supabase/functions/submit-feedback/index.ts');
const MIGRATION = 'supabase/migrations/20261001014600_feedback_insert_retired.sql';
const ROLLBACK = 'docs/rollback/20261001014600_feedback_insert_retired.rollback.sql';

const PENDING = '00000000-0000-4000-8000-0000000000d1';
const ADMIN = '00000000-0000-4000-8000-0000000000d2';

test('submit-feedback answers 410 to every POST and touches neither auth nor the database', async () => {
  const code = FUNCTION.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /clerkProfile|\.from\(|createClient|\binsert\b/, 'no profile lookup, no table');
  let handler;
  const touched = [];
  const context = {
    Request, Response, Headers, URL, console,
    serve: fn => { handler = fn; },
    clerkProfile: async () => { touched.push('clerkProfile'); return { profileId: PENDING, db: { from: t => { touched.push(t); return {}; } } }; },
  };
  new vm.Script(transformSync(FUNCTION.replace(/^import [\s\S]*?;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code).runInNewContext(context);
  const res = await handler(new Request('https://synthetic.invalid/submit-feedback', { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: JSON.stringify({ rating: 5, message: 'Synthetic feedback.', context_payload: { big: 'x'.repeat(1000) } }) }));
  assert.equal(res.status, 410);
  assert.match((await res.json()).error, /no longer/);
  assert.equal((await handler(new Request('https://synthetic.invalid/submit-feedback', { method: 'OPTIONS' }))).status, 200);
  assert.deepEqual(touched, []);
});

test('on PostgreSQL: a profile can no longer insert feedback directly; admins still read and resolve old rows', { skip: pgSkip(), timeout: withSlotWait(60000) }, async (t) => {
  const migration = read(MIGRATION), rollback = read(ROLLBACK);
  assert.doesNotMatch(migration, /^\s*(begin|commit)\s*;/im);
  assert.doesNotMatch(rollback, /^\s*(begin|commit)\s*;/im);
  const pg = await startPostgres(58492, 'feedback-retired');
  t.after(() => pg.close());
  // feedback and its three policies as production has them (pg_policies, read live).
  await pg.sql(`
    create role anon nologin; create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    create table public.app_admins (profile_id uuid primary key); insert into public.app_admins values ('${ADMIN}');
    create function public.current_profile_id() returns uuid language sql stable as $$ select nullif(current_setting('test.profile', true), '')::uuid $$;
    create function public.is_admin(p uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from app_admins where profile_id = p) $$;
    grant execute on all functions in schema public to anon, authenticated;
    create table public.feedback (id uuid primary key default gen_random_uuid(), user_id uuid, rating int, message text not null,
      context_page text, context_payload jsonb default '{}', resolved_at timestamptz, created_at timestamptz default now());
    alter table public.feedback enable row level security;
    grant select, insert, update on public.feedback to anon, authenticated;
    create policy feedback_user_select on public.feedback for select using ((user_id = current_profile_id()) or is_admin(current_profile_id()));
    create policy feedback_user_insert on public.feedback for insert with check (user_id = current_profile_id());
    create policy feedback_admin_update on public.feedback for update using (is_admin(current_profile_id())) with check (is_admin(current_profile_id()));
    insert into public.feedback (user_id, message) values ('${PENDING}', 'Synthetic older feedback.');
  `);
  const as = (profile, statement) => `set test.profile = '${profile}'; set role authenticated; ${statement}`;
  const insert = as(PENDING, `insert into public.feedback (user_id, message) values ('${PENDING}', 'Synthetic spam.');`);

  assert.ok((await pg.tryRun(insert)).ok, 'before: a pending profile inserts feedback directly');
  await pg.sql(`delete from public.feedback where message = 'Synthetic spam.';`);

  await pg.sql(migration);
  await pg.sql(migration); // rerunnable
  const refused = await pg.tryRun(insert);
  assert.ok(!refused.ok && /row-level security/.test(refused.err), refused.err || refused.out);
  assert.equal(await pg.sql(as(ADMIN, 'select count(*) from public.feedback;')), '1', 'the admin still reads the old row');
  assert.ok((await pg.tryRun(as(ADMIN, 'update public.feedback set resolved_at = now();'))).ok, 'and can still resolve it');

  await pg.sql(rollback);
  await pg.sql(rollback);
  assert.ok((await pg.tryRun(insert)).ok, 'the rollback restores the old policy');
});
