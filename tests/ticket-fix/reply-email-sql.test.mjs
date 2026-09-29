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
// Synthetic ids, text and addresses only. Own port: node --test runs files in
// parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { agentReplyBody, labeledBody, EMAIL_QUEUED, EMAIL_OWN_TICKET, emailStatus } from '../../scripts/ticket-fix/reply.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { postReplySQL } from '../../scripts/ticket-fix/reply.mjs';
import { main as postReply } from '../../scripts/ticket-fix/post-reply.mjs';
import { tempRepo, privateDir, liveBuild, uuid, signForTest } from './helpers.mjs';

const PORT = '58321';
const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const HOOK_VAULT = read('supabase/migrations/20260925140000_hook_secret_vault.sql');
const VERIFICATIONS = read('supabase/migrations/20260928150000_support_reply_verifications.sql');
const HARDENING = read('supabase/migrations/20260928161000_support_reply_hardening.sql');
const EMAIL = read('supabase/migrations/20260929134100_support_reply_email.sql');
const EMAIL_ROLLBACK = read('docs/rollback/20260929134100_support_reply_email.rollback.sql');
const NOTIFIER = read('scripts/signup-notify.sh');
const SEND_URL = 'https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/send-ticket-reply';
const HOOK_SECRET = 'synthetic-hook-secret-for-reply-email-0123456789';

function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-email-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args, input) => spawnSync(path.join(bin, name), args, { env, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const must = r => { if (r.status !== 0) throw Error(r.stderr || r.stdout); return r; };
  must(exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']));
  must(exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']));
  const run = (query, { user = 'postgres', db = 'postgres' } = {}) =>
    exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', user, '-d', db], `set time zone 'UTC';\n${query}`);
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
const management = pg => async query => {
  if (query.startsWith('begin read only; ') && query.endsWith('; rollback;')) {
    const inner = query.slice('begin read only; '.length, -'; rollback;'.length);
    return JSON.parse(pg.sql(`begin read only; select coalesce(json_agg(row), '[]'::json) from (${inner}) row; rollback;`));
  }
  if (query.startsWith('DO $')) { const out = pg.sql(query); return out ? out.split('\n').map(id => ({ id })) : []; }
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

  await t.test('post-reply.mjs: a member ticket is queued for email and called once; an admin-owned ticket says never and is not', async () => {
    const repo = tempRepo({ 'src/export.js': 'export const label = "Export expired licences";\n' });
    const state = privateDir('ticket-fix-email-');
    const lines = [];
    try {
      const deps = { git: repo.git, stateDir: state.dir, fetchBuild: liveBuild(repo.first), log: line => lines.push(line), query };
      const replyFile = path.join(state.dir, 'reply.json');
      for (const [ticket, status, calledTimes] of [[T.post, EMAIL_QUEUED, 1], [T.ownerPost, EMAIL_OWN_TICKET, 0]]) {
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
    assert.equal(emailStatus(false), EMAIL_QUEUED);
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
