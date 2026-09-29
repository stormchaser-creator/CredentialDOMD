// Migration 20260929134100 on a disposable PostgreSQL, on top of the
// production chain it assumes (20260925140000 hook secret in the vault,
// 20260928150000 verifications, 20260928161000 hardening): a VERIFIED support
// reply on a member's ticket calls send-ticket-reply exactly once, through the
// real notify_ticket_reply; nothing else new does. The two real writers (the
// agent's replySQL and post-reply.mjs) drive it. pg_net is a stand-in that
// records each call instead of sending it.
//
// Also: scripts/signup-notify.sh's "TICKET REPLY" predicate, run against the
// same rows, no longer reports a support reply as the member writing.
//
// Second test, migration 20260929150000 (review 2026-09-29): a reply whose one
// call fails is called again by retry_ticket_reply_emails until
// send-ticket-reply's emailed_at claim is set, so it is sent exactly once; a
// reply stored before the migration is never retried; and reconcile.mjs, the
// hourly runner's step, alerts the owner once about a reply still not emailed
// an hour after it was stored. pg_cron is a stand-in too.
//
// Synthetic ids, text and addresses only. Own ports: node --test runs files in
// parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { agentReplyBody, labeledBody, EMAIL_ATTEMPTED, EMAIL_OWN_TICKET, emailStatus } from '../../scripts/ticket-fix/reply.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { postReplySQL } from '../../scripts/ticket-fix/reply.mjs';
import { main as postReply } from '../../scripts/ticket-fix/post-reply.mjs';
import { reconcile, unsentReplies } from '../../scripts/ticket-fix/reconcile.mjs';
import { tempRepo, privateDir, liveBuild, uuid, signForTest } from './helpers.mjs';

const PORT = '58321';
const RETRY_PORT = '58322';
const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const HOOK_VAULT = read('supabase/migrations/20260925140000_hook_secret_vault.sql');
const VERIFICATIONS = read('supabase/migrations/20260928150000_support_reply_verifications.sql');
const HARDENING = read('supabase/migrations/20260928161000_support_reply_hardening.sql');
const EMAIL = read('supabase/migrations/20260929134100_support_reply_email.sql');
const EMAIL_ROLLBACK = read('docs/rollback/20260929134100_support_reply_email.rollback.sql');
const RETRY = read('supabase/migrations/20260929150000_support_reply_email_retry.sql');
const RETRY_ROLLBACK = read('docs/rollback/20260929150000_support_reply_email_retry.rollback.sql');
const NOTIFIER = read('scripts/signup-notify.sh');
const SEND_URL = 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply';
const HOOK_SECRET = 'synthetic-hook-secret-for-reply-email-0123456789';

function startPostgres(port = PORT) {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-email-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args, input) => spawnSync(path.join(bin, name), args, { env, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const must = r => { if (r.status !== 0) throw Error(r.stderr || r.stdout); return r; };
  must(exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']));
  must(exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${port} -c listen_addresses='' -c fsync=off`, '-w', 'start']));
  const run = (query, { user = 'postgres', db = 'postgres' } = {}) =>
    exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-U', user, '-d', db], `set time zone 'UTC';\n${query}`);
  const sql = (query, opts) => must(run(query, opts)).stdout.trim();
  const tryRun = (query, opts) => { const r = run(query, opts); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
  const close = () => { exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// Supabase reduced to what the chain touches: the API roles behind
// authenticator, default privileges that hand every new public table and
// function to all three, Vault, pgcrypto, pg_net recording its calls, and the
// support tables with the production bump trigger.
const ROLES = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
  create role supabase_admin login superuser;
`;
const PLATFORM = `
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema extensions; create extension pgcrypto with schema extensions;
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text not null default '',
    secret text not null, key_id uuid, nonce bytea, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create unique index secrets_name_idx on vault.secrets (name) where name is not null;
  create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
  revoke all on schema vault from public; grant usage on schema vault to service_role;
  grant select on vault.secrets, vault.decrypted_secrets to service_role;
  select vault.create_secret('${HOOK_SECRET}', 'welcome_hook_secret');

  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
    headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;

  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table public.profiles (id uuid primary key, email text, auth_user_id text, access_status text not null default 'active',
    backup_monthly boolean, data_deletion_date timestamptz, deleted_at timestamptz, created_at timestamptz not null default now());
  create function public.current_profile_id() returns uuid language sql stable security definer set search_path = public
    as $$ select id from profiles where auth_user_id = (auth.jwt()->>'sub') limit 1 $$;
  create table public.app_admins (profile_id uuid primary key references public.profiles(id));
  create function public.is_admin(user_id uuid) returns boolean language sql stable security definer set search_path = public
    as $$ select exists (select 1 from app_admins a where a.profile_id = user_id) $$;
  create table public.support_tickets (id uuid primary key, user_id uuid not null references public.profiles(id) on delete cascade,
    subject text not null, body text not null, category text not null default 'other', status text default 'open',
    created_at timestamptz default now(), updated_at timestamptz default now(), archived_at timestamptz,
    agent_last_reply_at timestamptz, agent_approved_at timestamptz, context_payload jsonb default '{}');
  create table public.support_messages (id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_tickets(id) on delete cascade,
    author_id uuid not null references public.profiles(id) on delete cascade, body text not null,
    is_admin_reply boolean default false, created_at timestamptz default now(), attachment_path text, attachment_paths text[], client_request_id uuid);
  create table public.early_access_leads (id uuid primary key default gen_random_uuid(), email text, note text, created_at timestamptz default now());
  create function public.bump_ticket_updated_at() returns trigger language plpgsql set search_path = public as $$
    begin update support_tickets set updated_at = now() where id = new.ticket_id; return new; end $$;
  create trigger trg_bump_ticket_updated_at after insert on public.support_messages for each row execute function public.bump_ticket_updated_at();
  create trigger trg_notify_ticket_reply after insert on public.support_messages for each row execute function public.notify_ticket_reply();
`;
// notify_ticket_reply must exist before its trigger; the real body comes from
// 20260925140000 right after.
const PLACEHOLDER_NOTIFY = `create function public.notify_ticket_reply() returns trigger language plpgsql as $$ begin return new; end $$;`;

const ADMIN = uuid(0xad01), MEMBER = uuid(0xbe01), MEMBER2 = uuid(0xbe02);
// One ticket per scenario: the agent answers a ticket once until the member writes again.
const T = {
  agent: uuid(0xc101), post: uuid(0xc102), ownerAgent: uuid(0xc103), ownerPost: uuid(0xc104), inApp: uuid(0xc105),
  bypass: uuid(0xc106), rollback: uuid(0xc107), reapply: uuid(0xc108), adminOwn: uuid(0xc109),
};
const SEED = `
  insert into public.profiles (id, email, auth_user_id) values
    ('${ADMIN}', 'owner@example.test', 'sub-admin'), ('${MEMBER}', 'member@example.test', 'sub-member'), ('${MEMBER2}', 'member2@example.test', 'sub-member2');
  insert into public.app_admins values ('${ADMIN}');
  insert into public.support_tickets (id, user_id, subject, body, status, updated_at, agent_approved_at) values
    ('${T.agent}', '${MEMBER}', 'Synthetic export question', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', '2026-09-29T00:00:00Z'),
    ('${T.post}', '${MEMBER}', 'Synthetic invoice question', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null),
    ('${T.ownerAgent}', '${ADMIN}', 'Synthetic owner note', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null),
    ('${T.ownerPost}', '${ADMIN}', 'Synthetic owner follow-up', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null),
    ('${T.inApp}', '${MEMBER2}', 'Synthetic reminder question', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null),
    ('${T.bypass}', '${MEMBER}', 'Synthetic bypass fixture', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null),
    ('${T.rollback}', '${MEMBER}', 'Synthetic rollback fixture', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', '2026-09-29T00:00:00Z'),
    ('${T.reapply}', '${MEMBER}', 'Synthetic reapply fixture', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', '2026-09-29T00:00:00Z'),
    ('${T.adminOwn}', '${ADMIN}', 'Synthetic admin own thread', 'Synthetic body', 'open', '2026-09-29T12:00:00Z', null);
`;
const text = s => `convert_from(decode('${Buffer.from(s).toString('hex')}','hex'),'UTF8')`;
const asApp = (role, sub, statement) => `set role ${role}; set request.jwt.claims to '${JSON.stringify({ sub })}'; ${statement}`;
const management = (pg, opts) => async query => {
  if (query.startsWith('begin read only; ') && query.endsWith('; rollback;')) {
    const inner = query.slice('begin read only; '.length, -'; rollback;'.length);
    return JSON.parse(pg.sql(`begin read only; select coalesce(json_agg(row), '[]'::json) from (${inner}) row; rollback;`, opts));
  }
  if (query.startsWith('DO $')) { const out = pg.sql(query, opts); return out ? out.split('\n').map(id => ({ id })) : []; }
  throw Error('Unexpected SQL shape');
};

test('a verified support reply on a member ticket is handed to send-ticket-reply once; nothing else new is', { skip: pgSkip(), timeout: 240000 }, async t => {
  const pg = startPostgres();
  t.after(() => pg.close());
  pg.sql(ROLES);
  const platform = pg.tryRun(`${PLACEHOLDER_NOTIFY}\n${PLATFORM}`);
  if (!platform.ok && /pgcrypto/.test(platform.err)) { t.skip('pgcrypto is not installed with this PostgreSQL'); return; }
  assert.ok(platform.ok, platform.err);
  pg.sql(SEED);
  const query = management(pg);
  const calls = () => JSON.parse(pg.sql(`select coalesce(json_agg(json_build_object('url', url, 'id', body->'record'->>'id', 'secret', headers->>'x-hook-secret') order by id), '[]') from net.calls`));
  const callsFor = id => calls().filter(c => c.id === id);
  const helper = id => pg.sql(`select public.verified_support_reply_to_member('${id}')`);
  const version = ticket => pg.sql(`select updated_at from public.support_tickets where id = '${ticket}'`);
  let key;
  const writerReplies = []; // stored by replySQL or post-reply.mjs on a member's ticket
  const memberMessages = [];
  const agentReply = async (ticket, owner, replyText, { fromAdmin = false } = {}) => {
    const v = signForTest({ ticketId: ticket, body: agentReplyBody(replyText), report: { path: 'agent' }, secret: key });
    const approval = fromAdmin ? { from_admin: true, approved_at: null } : { from_admin: false, approved_at: pg.sql(`select agent_approved_at from public.support_tickets where id = '${ticket}'`) };
    const rows = await query(replySQL({ id: ticket, owner_id: owner, updated_at: version(ticket), approval }, replyText, { verification: v }));
    assert.equal(rows.length, 1, 'the agent stored its reply');
    if (!fromAdmin) writerReplies.push(rows[0].id);
    return rows[0].id;
  };

  await t.test('the migration stops without the verification and emailed_at migrations, then applies twice', () => {
    pg.sql('create database bare');
    pg.sql(`${PLACEHOLDER_NOTIFY}\n${PLATFORM}`, { db: 'bare' });
    const none = pg.tryRun(EMAIL, { db: 'bare' });
    assert.equal(none.ok, false);
    assert.match(none.err, /apply 20260928150000_support_reply_verifications\.sql first/);
    pg.sql(VERIFICATIONS, { db: 'bare' });
    const half = pg.tryRun(EMAIL, { db: 'bare' });
    assert.equal(half.ok, false);
    assert.match(half.err, /apply 20260928161000_support_reply_hardening\.sql first/);

    for (const [label, file] of [['hook secret vault', HOOK_VAULT], ['verifications', VERIFICATIONS], ['hardening', HARDENING]]) {
      const r = pg.tryRun(file);
      assert.ok(r.ok, `${label}: ${r.err}`);
    }
    key = pg.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'support_reply_hmac_key'`);
    for (const pass of ['first', 'second']) { const r = pg.tryRun(EMAIL); assert.ok(r.ok, `${pass}: ${r.err}`); }
    assert.equal(pg.sql(`select count(*) from pg_trigger where tgrelid = 'public.support_messages'::regclass and tgname = 'trg_notify_ticket_reply'`), '1');
    // AFTER INSERT only: the emailed_at claim (an UPDATE) can never send.
    assert.equal(pg.sql(`select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_notify_ticket_reply'`),
      'CREATE TRIGGER trg_notify_ticket_reply AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION notify_ticket_reply()');
    assert.deepEqual(calls(), []);
  });

  await t.test('only service_role (and the owner) may ask whether a message is a verified reply to a member', () => {
    const fn = 'public.verified_support_reply_to_member(uuid)';
    assert.equal(pg.sql(`select has_function_privilege('anon', '${fn}', 'EXECUTE')`), 'f');
    assert.equal(pg.sql(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE')`), 'f');
    assert.equal(pg.sql(`select has_function_privilege('service_role', '${fn}', 'EXECUTE')`), 't');
    assert.equal(pg.sql(`select prosecdef from pg_proc where oid = '${fn}'::regprocedure`), 't');
    const browser = pg.tryRun(asApp('authenticated', 'sub-member', `select public.verified_support_reply_to_member('${uuid(1)}')`), { user: 'authenticator' });
    assert.equal(browser.ok, false);
    assert.match(browser.err, /permission denied/);
    assert.equal(pg.sql(`set role service_role; select public.verified_support_reply_to_member('${uuid(1)}')`, { user: 'authenticator' }), 'f', 'an unknown message is false, not an error');
    const acl = pg.sql(`select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = 'public.notify_ticket_reply()'::regprocedure`);
    assert.doesNotMatch(acl, /(^|,)(anon|authenticated)=/);
  });

  await t.test("the agent's verified reply on a member's ticket calls send-ticket-reply once, with the vault secret", async () => {
    const id = await agentReply(T.agent, MEMBER, 'Synthetic agent answer about the export.');
    assert.equal(helper(id), 't');
    assert.deepEqual(callsFor(id), [{ url: SEND_URL, id, secret: HOOK_SECRET }]);
    assert.equal(pg.sql(`select author_id || '|' || is_admin_reply || '|' || (verification_id is not null) from public.support_messages where id = '${id}'`), `${MEMBER}|true|true`,
      'still stored with the ticket owner as author');
    // send-ticket-reply claims the row: an UPDATE, which never calls again.
    pg.sql(`set role service_role; update public.support_messages set emailed_at = now() where id = '${id}' and emailed_at is null`, { user: 'authenticator' });
    assert.equal(callsFor(id).length, 1, 'the claim does not send a second time');
  });

  await t.test('post-reply.mjs: a member ticket is handed to send-ticket-reply once; an admin-owned ticket says never and is not', async () => {
    const repo = tempRepo({ 'src/export.js': 'export const label = "Export expired licences";\n' });
    const state = privateDir('ticket-fix-email-');
    const lines = [];
    try {
      const deps = { git: repo.git, stateDir: state.dir, fetchBuild: liveBuild(repo.first), log: line => lines.push(line), query };
      const replyFile = path.join(state.dir, 'reply.json');
      for (const [ticket, status, calledTimes] of [[T.post, EMAIL_ATTEMPTED, 1], [T.ownerPost, EMAIL_OWN_TICKET, 0]]) {
        fs.writeFileSync(replyFile, JSON.stringify({ ticket_id: ticket, ticket_version: version(ticket), opening: 'answer', closing: 'none', claims: [],
          not_done: [`A synthetic answer for ${ticket.slice(-4)}.`] }));
        assert.equal(await postReply(['--ticket', ticket, '--reply', replyFile], deps), 0, lines.join('\n'));
        const posted = JSON.parse(lines.at(-1));
        assert.equal(posted.emailed, false, 'post-reply itself sends nothing');
        assert.equal(posted.email, status);
        assert.equal(callsFor(posted.message_id).length, calledTimes, ticket);
        assert.equal(helper(posted.message_id), calledTimes ? 't' : 'f');
        if (ticket === T.post) writerReplies.push(posted.message_id);
      }
    } finally { repo.cleanup(); state.cleanup(); }
    assert.equal(emailStatus(false), EMAIL_ATTEMPTED);
    assert.equal(emailStatus(true), EMAIL_OWN_TICKET);
    assert.throws(() => emailStatus(undefined), /unknown/);
  });

  await t.test("the agent's reply on an admin's own ticket is never sent", async () => {
    const id = await agentReply(T.ownerAgent, ADMIN, 'Synthetic note on the owner ticket.', { fromAdmin: true });
    assert.equal(helper(id), 'f');
    assert.deepEqual(callsFor(id), []);
  });

  await t.test("a member's own messages are never sent; an admin's reply in the app still is, and never on their own ticket", () => {
    const member = pg.sql(asApp('authenticated', 'sub-member2', `insert into public.support_messages (ticket_id, author_id, body) values ('${T.inApp}', '${MEMBER2}', 'A synthetic follow-up') returning id`), { user: 'authenticator' });
    const viaService = pg.sql(`set role service_role; insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${T.inApp}', '${MEMBER2}', 'A synthetic reply via reply-ticket', false) returning id`, { user: 'authenticator' });
    const admin = pg.sql(asApp('authenticated', 'sub-admin', `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${T.inApp}', '${ADMIN}', 'A synthetic answer typed in Admin', true) returning id`), { user: 'authenticator' });
    const own = pg.sql(asApp('authenticated', 'sub-admin', `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${T.adminOwn}', '${ADMIN}', 'A synthetic note to self', true) returning id`), { user: 'authenticator' });
    memberMessages.push(member, viaService);
    assert.deepEqual(callsFor(member), []);
    assert.deepEqual(callsFor(viaService), []);
    assert.deepEqual(callsFor(own), []);
    assert.deepEqual(callsFor(admin), [{ url: SEND_URL, id: admin, secret: HOOK_SECRET }], 'the admin rule is unchanged');
    for (const id of [member, viaService, admin, own]) assert.equal(helper(id), 'f', 'none of these is a verified reply to a member');
  });

  await t.test('with the reply gate bypassed, a row that does not match its verification is still never sent', () => {
    // An operator who disables trg_require_verified_support_reply can store
    // any row. notify_ticket_reply re-checks the verification itself, so each
    // broken row below sends nothing; the last, intact row is the control.
    const bodyText = labeledBody('Synthetic reply stored around the gate.');
    const cases = [
      ['a forged signature', { secret: 'a-guessed-key-that-is-not-the-vault-one-0000' }],
      ['a body that is not the verified one', { storedBody: labeledBody('Different text than was verified.') }],
      ['a verification consumed by another message', { usedBy: uuid(0xf00d) }],
      ['a verification never consumed', { unused: true }],
      ['no support flag', { flag: false }],
      ['an author other than the ticket owner', { author: MEMBER2 }],
      ['the intact control', {}],
    ];
    const results = [];
    for (const [label, c] of cases) {
      const message = uuid(0xe000 + results.length);
      const v = signForTest({ ticketId: T.bypass, body: bodyText, report: { path: 'test' }, secret: c.secret ?? key });
      pg.sql(`begin;
        alter table public.support_messages disable trigger trg_require_verified_support_reply;
        insert into public.support_reply_verifications (id, ticket_id, body_sha256, hmac, report, used_at, used_by_message_id)
          values ('${v.id}', '${T.bypass}', '${v.body_sha256}', '${v.hmac}', '{}'::jsonb, ${c.unused ? 'null' : 'now()'}, ${c.unused ? 'null' : `'${c.usedBy ?? message}'`});
        insert into public.support_messages (id, ticket_id, author_id, body, is_admin_reply, verification_id)
          values ('${message}', '${T.bypass}', '${c.author ?? MEMBER}', ${text(c.storedBody ?? bodyText)}, ${c.flag ?? true}, '${v.id}');
        alter table public.support_messages enable trigger trg_require_verified_support_reply;
        commit;`);
      results.push([label, callsFor(message).length, helper(message)]);
    }
    assert.deepEqual(results, cases.map(([label], i) => [label, i === cases.length - 1 ? 1 : 0, i === cases.length - 1 ? 't' : 'f']));
    assert.equal(pg.sql(`select tgenabled from pg_trigger where tgname = 'trg_require_verified_support_reply'`), 'O');
  });

  await t.test('a missing hook secret saves the verified reply and sends nothing', async () => {
    const saved = pg.sql(`select id from vault.secrets where name = 'welcome_hook_secret'`);
    pg.sql(`update vault.secrets set name = 'welcome_hook_secret_parked' where id = '${saved}'`);
    try {
      const before = calls().length;
      pg.sql(`update public.support_tickets set agent_last_reply_at = null where id = '${T.agent}'`);
      const id = await agentReply(T.agent, MEMBER, 'Synthetic second answer while the hook secret is missing.');
      assert.equal(calls().length, before);
      assert.equal(pg.sql(`select count(*) from public.support_messages where id = '${id}'`), '1');
    } finally { pg.sql(`update vault.secrets set name = 'welcome_hook_secret' where id = '${saved}'`); }
  });

  await t.test("scripts/signup-notify.sh's TICKET REPLY no longer reports a support reply as the member writing", () => {
    const where = NOTIFIER.match(/union all select 'TICKET REPLY'.*?\n {2}(where .*?)(?=\nunion all)/s);
    assert.ok(where, 'the notifier reply predicate was found');
    const predicate = where[1].replace('$SINCE', '2026-01-01T00:00:00Z');
    const reported = new Set(pg.sql(`select m.id from public.support_messages m
      join public.support_tickets t on t.id = m.ticket_id left join public.profiles p on p.id = m.author_id ${predicate}`).split('\n'));
    assert.equal(memberMessages.length, 2);
    for (const id of memberMessages) assert.ok(reported.has(id), 'a member writing is still reported');
    assert.ok(writerReplies.length >= 3, 'the fixture has member-authored support replies to leave out');
    assert.deepEqual(writerReplies.filter(id => reported.has(id)), [], 'no agent or post-reply reply is reported as the member writing');
    // What 20260929134100 found: the old predicate reported every one of them.
    const before = predicate.replace(/\n\s*and not coalesce\(m\.is_admin_reply, false\)/, '');
    assert.notEqual(before, predicate);
    const old = new Set(pg.sql(`select m.id from public.support_messages m
      join public.support_tickets t on t.id = m.ticket_id left join public.profiles p on p.id = m.author_id ${before}`).split('\n'));
    assert.deepEqual(writerReplies.filter(id => !old.has(id)), []);
  });

  await t.test('the rollback stops sending verified replies and keeps the admin rule; reapplying sends again', async () => {
    pg.sql(EMAIL_ROLLBACK);
    pg.sql(EMAIL_ROLLBACK);
    assert.equal(pg.sql(`select to_regprocedure('public.verified_support_reply_to_member(uuid)') is null`), 't');
    const off = await agentReply(T.rollback, MEMBER, 'Synthetic answer after the rollback.');
    assert.deepEqual(callsFor(off), []);
    const admin = pg.sql(asApp('authenticated', 'sub-admin', `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${T.rollback}', '${ADMIN}', 'Synthetic admin answer after the rollback', true) returning id`), { user: 'authenticator' });
    assert.equal(callsFor(admin).length, 1);
    pg.sql(EMAIL);
    const on = await agentReply(T.reapply, MEMBER, 'Synthetic answer after reapplying.');
    assert.equal(callsFor(on).length, 1);
    assert.equal(callsFor(off).length, 0, 'nothing stored while rolled back is sent afterwards');
  });
});

test('postReplySQL and replySQL store the shape the email rule reads: owner as author, support flag, verification', () => {
  const secret = 'synthetic-hmac-key-0123456789abcdef0123456789abcdef';
  const body = labeledBody('Synthetic.');
  const sql = postReplySQL({ ticket: { id: T.post, user_id: MEMBER, updated_at: null }, body, verification: signForTest({ ticketId: T.post, body, secret }) });
  assert.match(sql, /INSERT INTO support_messages \(id, ticket_id, author_id, body, is_admin_reply, created_at, verification_id\)\s+VALUES \('[0-9a-f-]{36}'::uuid, target\.id, target\.user_id, .*, true, now\(\), '[0-9a-f-]{36}'::uuid\)/);
  const agent = replySQL({ id: T.agent, owner_id: MEMBER, updated_at: '2026-09-29T12:00:00Z', approval: { from_admin: false, approved_at: '2026-09-29T00:00:00Z' } }, 'Synthetic.',
    { verification: signForTest({ ticketId: T.agent, body: agentReplyBody('Synthetic.'), secret }) });
  assert.match(agent, /VALUES \('[0-9a-f-]{36}'::uuid, target\.id, target\.user_id, .*, true, now\(\), '[0-9a-f-]{36}'::uuid\)/);
});

// pg_cron reduced to what 20260929150000 and its rollback call.
const FAKE_CRON = `
  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql
    as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
  create function cron.unschedule(job_name text) returns boolean language sql
    as $$ with gone as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from gone) $$;
`;
// One member ticket per reply (the agent answers a ticket once), and one the admin owns.
const R = {
  before: uuid(0xd101), agent: uuid(0xd102), admin: uuid(0xd103), secret: uuid(0xd104), spent: uuid(0xd105), old: uuid(0xd106),
  broken: uuid(0xd107), gone: uuid(0xd108), late: uuid(0xd109), recent: uuid(0xd10a), after: uuid(0xd10b), adminOwn: uuid(0xd1ff),
};
const RETRY_SEED = `
  insert into public.profiles (id, email, auth_user_id) values
    ('${ADMIN}', 'owner@example.test', 'sub-admin'), ('${MEMBER}', 'member@example.test', 'sub-member');
  insert into public.app_admins values ('${ADMIN}');
  insert into public.support_tickets (id, user_id, subject, body, status, updated_at, agent_approved_at)
  select id::uuid, case when id::uuid = '${R.adminOwn}' then '${ADMIN}'::uuid else '${MEMBER}'::uuid end, 'Synthetic retry fixture', 'Synthetic body', 'open',
         '2026-09-29T12:00:00Z', case when id::uuid = '${R.adminOwn}' then null else '2026-09-29T00:00:00Z'::timestamptz end
    from unnest(array['${Object.values(R).join("','")}']) id;
`;

test('a reply whose email fails is sent by the retry, exactly once; one still not emailed an hour later alerts the owner', { skip: pgSkip(), timeout: 240000 }, async t => {
  const pg = startPostgres(RETRY_PORT);
  t.after(() => pg.close());
  pg.sql(ROLES);
  const platform = pg.tryRun(`${PLACEHOLDER_NOTIFY}\n${PLATFORM}\n${FAKE_CRON}`);
  if (!platform.ok && /pgcrypto/.test(platform.err)) { t.skip('pgcrypto is not installed with this PostgreSQL'); return; }
  assert.ok(platform.ok, platform.err);
  pg.sql(RETRY_SEED);
  for (const [label, file] of [['hook secret vault', HOOK_VAULT], ['verifications', VERIFICATIONS], ['hardening', HARDENING], ['reply email', EMAIL]]) {
    const r = pg.tryRun(file);
    assert.ok(r.ok, `${label}: ${r.err}`);
  }
  const key = pg.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'support_reply_hmac_key'`);
  const query = management(pg);
  const calls = () => JSON.parse(pg.sql(`select coalesce(json_agg(json_build_object('url', url, 'id', body->'record'->>'id', 'secret', headers->>'x-hook-secret',
    'onlyId', (select count(*) from jsonb_object_keys(body->'record')) = 1) order by id), '[]') from net.calls`));
  const callsFor = id => calls().filter(c => c.id === id);
  const reply = async (ticket, replyText) => {
    const v = signForTest({ ticketId: ticket, body: agentReplyBody(replyText), report: { path: 'agent' }, secret: key });
    const [row] = await query(replySQL({ id: ticket, owner_id: MEMBER, updated_at: pg.sql(`select updated_at from public.support_tickets where id = '${ticket}'`),
      approval: { from_admin: false, approved_at: pg.sql(`select agent_approved_at from public.support_tickets where id = '${ticket}'`) } }, replyText, { verification: v }));
    assert.ok(row?.id, 'the agent stored its reply');
    return row.id;
  };
  const retry = () => Number(pg.sql('select public.retry_ticket_reply_emails()'));
  const record = id => pg.sql(`select coalesce((select attempts || '|' || (last_attempt_at is not null) from public.ticket_reply_emails where message_id = '${id}'), 'none')`);
  // Moves a recorded reply (and its last call) back in time.
  const age = (id, minutes, attempts) => pg.sql(`update public.ticket_reply_emails set queued_at = now() - interval '${minutes} minutes',
    last_attempt_at = case when last_attempt_at is null then null else now() - interval '${minutes} minutes' end${attempts === undefined ? '' : `, attempts = ${attempts}`}
    where message_id = '${id}'`);
  // send-ticket-reply's claim, which alone decides whether a call sends: true when this call would send.
  const deliver = id => pg.sql(`set role service_role; update public.support_messages set emailed_at = now() where id = '${id}' and emailed_at is null returning id`, { user: 'authenticator' }) === id;
  const hideSecret = () => pg.sql(`update vault.secrets set name = 'welcome_hook_secret_parked' where name = 'welcome_hook_secret'`);
  const showSecret = () => pg.sql(`update vault.secrets set name = 'welcome_hook_secret' where name = 'welcome_hook_secret_parked'`);
  const notifyBefore = pg.sql(`select pg_get_functiondef('public.notify_ticket_reply()'::regprocedure)`);
  const ids = {};

  await t.test('stops without 20260929134100; applies twice with one cron job; a reply stored before it is never retried', async () => {
    pg.sql('create database bare');
    pg.sql(`${PLACEHOLDER_NOTIFY}\n${PLATFORM}`, { db: 'bare' });
    pg.sql(VERIFICATIONS, { db: 'bare' });
    pg.sql(HARDENING, { db: 'bare' });
    const none = pg.tryRun(RETRY, { db: 'bare' });
    assert.equal(none.ok, false);
    assert.match(none.err, /apply 20260929134100_support_reply_email\.sql first/);
    assert.deepEqual(await unsentReplies(management(pg, { db: 'bare' })), [], 'reconcile skips the check until the migration exists');

    ids.before = await reply(R.before, 'Synthetic answer stored before the retry existed.');
    assert.equal(callsFor(ids.before).length, 1);
    for (const pass of ['first', 'second']) { const r = pg.tryRun(RETRY); assert.ok(r.ok, `${pass}: ${r.err}`); }
    assert.equal(pg.sql(`select string_agg(jobname || '|' || schedule || '|' || command, ',') from cron.job`),
      'retry-ticket-reply-emails|*/10 * * * *|select public.retry_ticket_reply_emails()');
    assert.equal(retry(), 0);
    assert.equal(record(ids.before), 'none', 'nothing stored before the migration is recorded: that is the cutover');
    assert.equal(callsFor(ids.before).length, 1);
  });

  await t.test("a verified reply to a member whose first call fails is called again after 10 minutes and sent once", async () => {
    const id = ids.agent = await reply(R.agent, 'Synthetic answer whose first email fails.');
    assert.deepEqual(callsFor(id), [{ url: SEND_URL, id, secret: HOOK_SECRET, onlyId: false }], 'the trigger calls once, with the row');
    assert.equal(record(id), '1|true', 'and records the call');
    // That call failed: send-ticket-reply never set emailed_at.
    assert.equal(retry(), 0, 'not called again at once');
    age(id, 9);
    assert.equal(retry(), 0, 'nor after nine minutes');
    age(id, 11);
    assert.equal(retry(), 1);
    assert.deepEqual(callsFor(id)[1], { url: SEND_URL, id, secret: HOOK_SECRET, onlyId: true }, 'the retry names the message by id, with the vault secret');
    assert.equal(record(id), '2|true');
    assert.equal(deliver(id), true, 'the second call sends');
    age(id, 120);
    assert.equal(retry(), 0, 'an emailed reply is never called again');
    assert.equal(callsFor(id).length, 2);
    assert.equal(callsFor(id).filter(() => deliver(id)).length, 0, 'every call delivered again sends nothing more: one email in all');
  });

  await t.test("an admin's reply in the app is retried the same way; his own ticket and a member's message are never recorded", () => {
    const admin = pg.sql(asApp('authenticated', 'sub-admin', `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${R.admin}', '${ADMIN}', 'Synthetic admin answer', true) returning id`), { user: 'authenticator' });
    const own = pg.sql(asApp('authenticated', 'sub-admin', `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply) values ('${R.adminOwn}', '${ADMIN}', 'Synthetic note to self', true) returning id`), { user: 'authenticator' });
    const member = pg.sql(asApp('authenticated', 'sub-member', `insert into public.support_messages (ticket_id, author_id, body) values ('${R.admin}', '${MEMBER}', 'A synthetic follow-up') returning id`), { user: 'authenticator' });
    assert.deepEqual([record(admin), record(own), record(member)], ['1|true', 'none', 'none']);
    age(admin, 11);
    assert.equal(retry(), 1);
    assert.equal(callsFor(admin).length, 2);
    assert.equal(callsFor(own).length + callsFor(member).length, 0);
    assert.equal(deliver(admin), true);
  });

  await t.test('a reply stored while the hook secret is missing is recorded, and sent once the secret is back', async () => {
    hideSecret();
    let id;
    try {
      id = await reply(R.secret, 'Synthetic answer stored while the hook secret is missing.');
      assert.equal(callsFor(id).length, 0);
      assert.equal(record(id), '0|false', 'recorded with no call');
      age(id, 11);
      const failed = pg.tryRun('select public.retry_ticket_reply_emails()');
      assert.equal(failed.ok, false, 'the cron run fails visibly');
      assert.match(failed.err, /vault secret welcome_hook_secret is missing/);
      assert.equal(record(id), '0|false', 'and records nothing');
    } finally { showSecret(); }
    assert.equal(retry(), 1);
    assert.equal(record(id), '1|true');
    assert.equal(deliver(id), true);
  });

  await t.test('each wait is 10 minutes times the tries so far; the retry stops after 12 tries or 7 days', async () => {
    const spent = ids.spent = await reply(R.spent, 'Synthetic answer that never gets out.');
    const old = ids.old = await reply(R.old, 'Synthetic answer from last week.');
    age(spent, 29, 3);
    assert.equal(retry(), 0, 'three tries wait 30 minutes');
    age(spent, 31, 3);
    assert.equal(retry(), 1);
    assert.equal(record(spent), '4|true');
    age(spent, 24 * 60, 12);
    assert.equal(retry(), 0, 'twelve tries is the last');
    age(old, 7 * 24 * 60 + 5);
    assert.equal(retry(), 0, 'recorded more than 7 days ago');
    assert.equal(callsFor(old).length, 1);
  });

  await t.test('a reply that no longer matches its verification is not retried', async () => {
    const id = ids.broken = await reply(R.broken, 'Synthetic answer whose verification is changed afterwards.');
    pg.sql(`update public.support_reply_verifications set hmac = repeat('0', 64) where used_by_message_id = '${id}'`);
    assert.equal(pg.sql(`select public.verified_support_reply_to_member('${id}')`), 'f');
    age(id, 120);
    assert.equal(retry(), 0);
    assert.equal(callsFor(id).length, 1);
  });

  await t.test('only the owner runs the retry; no API role writes the record; deleting the ticket deletes it', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(pg.sql(`select has_function_privilege('${role}', 'public.retry_ticket_reply_emails()', 'EXECUTE')`), 'f', role);
    }
    for (const role of ['anon', 'authenticated']) {
      assert.equal(pg.sql(`select has_table_privilege('${role}', 'public.ticket_reply_emails', 'SELECT,INSERT,UPDATE,DELETE')`), 'f', role);
    }
    assert.equal(pg.sql(`select has_table_privilege('service_role', 'public.ticket_reply_emails', 'SELECT')
      and not has_table_privilege('service_role', 'public.ticket_reply_emails', 'INSERT,UPDATE,DELETE')`), 't');
    assert.equal(pg.sql(`select relrowsecurity from pg_class where oid = 'public.ticket_reply_emails'::regclass`), 't');
    const browser = pg.tryRun(asApp('authenticated', 'sub-member', 'select public.retry_ticket_reply_emails()'), { user: 'authenticator' });
    assert.equal(browser.ok, false);
    assert.match(browser.err, /permission denied/);
    const id = await reply(R.gone, 'Synthetic answer on a ticket that is then deleted.');
    assert.equal(record(id), '1|true');
    pg.sql(`delete from public.support_tickets where id = '${R.gone}'`);
    assert.equal(record(id), 'none', 'delete-account removes it with the ticket');
  });

  await t.test('reconcile.mjs alerts the owner once about each reply still not emailed an hour after it was stored', async () => {
    const late = await reply(R.late, 'Synthetic answer still not emailed after an hour.');
    const recent = await reply(R.recent, 'Synthetic answer still inside its first hour.');
    age(late, 61, 5);
    age(recent, 50, 3);
    const state = privateDir('reply-email-reconcile-');
    const ledger = privateDir('reply-email-ledger-');
    const sent = [];
    try {
      const run = () => reconcile({ query, state: state.dir, ledgers: [ledger.dir], send: async message => { sent.push(message); return true; } });
      const unsent = () => sent.filter(m => m.includes('has still not been emailed'));
      const first = await run();
      assert.equal(first.unemailed, 3, 'late, and the two the retry gave up on (12 tries; older than 7 days)');
      const named = unsent().map(m => m.match(/\(message ([0-9a-f]{8})\)/)[1]).sort();
      assert.deepEqual(named, [late, ids.spent, ids.old].map(id => id.slice(0, 8)).sort());
      assert.ok(unsent().includes(`CredentialDOMD support: a reply on ticket ${R.late.slice(0, 8)} (message ${late.slice(0, 8)}) has still not been emailed to the ticket owner 61 minutes after it was stored, after 5 tries. It is in the app thread. Check send-ticket-reply's logs and the owner's email address.`), unsent().join('\n'));
      for (const quiet of [recent, ids.broken, ids.agent, ids.before]) assert.ok(!unsent().some(m => m.includes(quiet.slice(0, 8))), `nothing about ${quiet.slice(0, 8)}`);
      assert.ok(!sent.join('').includes(String.fromCodePoint(0x2014)), 'no em dash');
      assert.match(fs.readFileSync(path.join(state.dir, 'alerts.log'), 'utf8'), new RegExp(`ALERT reply_not_emailed message=${late.slice(0, 8)} ticket=${R.late.slice(0, 8)} attempts=5`));
      const before = unsent().length;
      assert.equal((await run()).unemailed, 3);
      assert.equal(unsent().length, before, 'each reply is reported once');
      assert.equal(deliver(late), true);
      assert.equal((await run()).unemailed, 2, 'an emailed reply is no longer counted');
    } finally { state.cleanup(); ledger.cleanup(); }
  });

  await t.test('the rollback restores the one-call trigger and removes the job, the function and the table; 20260929134100 rolls back only after it', async () => {
    const early = pg.tryRun(EMAIL_ROLLBACK);
    assert.equal(early.ok, false);
    assert.match(early.err, /roll back 20260929150000_support_reply_email_retry first/);
    assert.equal(pg.sql(`select to_regprocedure('public.verified_support_reply_to_member(uuid)') is not null`), 't', 'the refused rollback changed nothing');
    pg.sql(RETRY_ROLLBACK);
    pg.sql(RETRY_ROLLBACK);
    assert.equal(pg.sql(`select pg_get_functiondef('public.notify_ticket_reply()'::regprocedure)`), notifyBefore, 'the trigger function is 20260929134100\'s again');
    assert.equal(pg.sql('select count(*) from cron.job'), '0');
    assert.equal(pg.sql(`select to_regclass('public.ticket_reply_emails') is null and to_regprocedure('public.retry_ticket_reply_emails()') is null`), 't');
    const id = await reply(R.after, 'Synthetic answer after the rollback.');
    assert.equal(callsFor(id).length, 1, '20260929134100 still calls once');
    const back = pg.tryRun(EMAIL_ROLLBACK);
    assert.ok(back.ok, back.err);
    for (const file of [EMAIL, RETRY]) { const r = pg.tryRun(file); assert.ok(r.ok, r.err); }
    assert.equal(pg.sql('select count(*) from cron.job'), '1');
  });
});
