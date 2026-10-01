// Migration 20261001014500 on a disposable PostgreSQL (QA SUPPORT-003 /
// ADMIN-005): a member may not post a reply to the owner's message labelled
// as the owner's (is_admin_reply = true), and a pending or paused profile may
// not post one at all. The app's own two writes still pass. Before it,
// 20260826_admin_messages.sql's policy accepted the forged row.
//
// Synthetic ids and text only. Own port: node --test runs files in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from '../ops/pg.mjs';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ORIGINAL = read('supabase/migrations/20260826_admin_messages.sql');
const MIGRATION = read('supabase/migrations/20261001014500_admin_message_reply_attribution.sql');
const ROLLBACK = read('docs/rollback/20261001014500_admin_message_reply_attribution.rollback.sql');

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const MEMBER = '00000000-0000-4000-8000-0000000000b2';
const PENDING = '00000000-0000-4000-8000-0000000000b3';
const BROADCAST = '00000000-0000-4000-8000-0000000000c1';

// The pieces production has that 20260826 leans on: profiles with
// access_status, app_admins behind is_admin(), current_profile_id() from the
// token (a session setting here), and 20260915c's current_profile_active().
const SCHEMA = `
  create role anon nologin; create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  create table public.profiles (id uuid primary key, access_status text not null default 'pending', email text, name text);
  insert into public.profiles values ('${OWNER}', 'active'), ('${MEMBER}', 'active'), ('${PENDING}', 'pending');
  create table public.app_admins (profile_id uuid primary key);
  insert into public.app_admins values ('${OWNER}');
  create function public.current_profile_id() returns uuid language sql stable as $$ select nullif(current_setting('test.profile', true), '')::uuid $$;
  create function public.is_admin(p uuid) returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from app_admins where profile_id = p) $$;
  create function public.current_profile_active() returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select p.access_status = 'active' from profiles p where p.id = current_profile_id()), false) $$;
  grant execute on all functions in schema public to anon, authenticated;
  grant select on public.profiles to authenticated;
`;

const as = (profile, statement) => `set test.profile = '${profile}'; set role authenticated; ${statement}`;
const reply = (user, author, isAdmin) =>
  `insert into public.admin_message_replies (message_id, user_id, author_id, body, is_admin_reply) values ('${BROADCAST}', '${user}', '${author}', 'Synthetic reply.', ${isAdmin});`;

test('on PostgreSQL: only the owner may sign a reply as the owner, and only admitted members may reply', { skip: pgSkip(), timeout: withSlotWait(60000) }, async (t) => {
  const pg = await startPostgres(58491, 'admin-reply-attribution');
  t.after(() => pg.close());
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit)\s*;/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit)\s*;/im);
  await pg.sql(SCHEMA);
  await pg.sql(ORIGINAL);
  await pg.sql(`insert into public.admin_messages (id, sender_id, recipient_id, body) values ('${BROADCAST}', '${OWNER}', null, 'Synthetic note to everyone.');`);

  // What origin/main allows: the member's forged "owner" reply is accepted.
  const before = await pg.tryRun(as(MEMBER, reply(MEMBER, MEMBER, true)));
  assert.ok(before.ok, 'the 20260826 policy accepts a member reply labelled as the owner\'s');
  await pg.sql('delete from public.admin_message_replies;');

  await pg.sql(MIGRATION);
  await pg.sql(MIGRATION); // rerunnable

  const forged = await pg.tryRun(as(MEMBER, reply(MEMBER, MEMBER, true)));
  assert.ok(!forged.ok && /row-level security/.test(forged.err), `a member's reply signed as the owner is refused: ${forged.err || forged.out}`);
  const pending = await pg.tryRun(as(PENDING, reply(PENDING, PENDING, false)));
  assert.ok(!pending.ok && /row-level security/.test(pending.err), 'a pending profile may not reply');

  // The app's own writes: the member's reply (AdminMessageCard.jsx) and the owner's (AdminDashboard.jsx).
  assert.ok((await pg.tryRun(as(MEMBER, reply(MEMBER, MEMBER, false)))).ok, 'the member\'s own reply still saves');
  assert.ok((await pg.tryRun(as(MEMBER, `insert into public.admin_message_replies (message_id, user_id, author_id, body) values ('${BROADCAST}', '${MEMBER}', '${MEMBER}', 'Synthetic reply without the flag.');`))).ok, 'a reply that omits the flag takes the false default');
  assert.ok((await pg.tryRun(as(OWNER, reply(MEMBER, OWNER, true)))).ok, 'the owner\'s answer in the member\'s thread still saves');
  const forgedAuthor = await pg.tryRun(as(MEMBER, reply(MEMBER, OWNER, false)));
  assert.ok(!forgedAuthor.ok, 'a member still cannot write as another author');
  assert.deepEqual(await pg.rows('select author_id, is_admin_reply from public.admin_message_replies order by created_at, is_admin_reply'),
    [{ author_id: MEMBER, is_admin_reply: false }, { author_id: MEMBER, is_admin_reply: false }, { author_id: OWNER, is_admin_reply: true }]);

  // The rollback restores 20260826's policy (and with it the hole).
  await pg.sql(ROLLBACK);
  await pg.sql(ROLLBACK);
  assert.ok((await pg.tryRun(as(MEMBER, reply(MEMBER, MEMBER, true)))).ok, 'after the rollback the old policy is back');
});
