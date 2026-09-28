// Migration 20260928150000 on a disposable PostgreSQL, driven the way
// production is: operator SQL as session user postgres (the management API),
// edge functions as service_role and the app as authenticated, both behind
// authenticator (PostgREST). Then the two real writers (the agent's replySQL
// and post-reply.mjs) end to end against it.
//
// Synthetic ids and text only. Own port: node --test runs files in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { buildVerification, readVerificationKey, agentReplyBody, labeledBody, sha256Hex } from '../../scripts/ticket-fix/reply.mjs';
import { replySQL } from '../../scripts/ticket-agent-isolated.mjs';
import { main as postReply } from '../../scripts/ticket-fix/post-reply.mjs';
import { main as verifyClaims } from '../../scripts/ticket-fix/verify-claims.mjs';
import { tempRepo, privateDir, noBuild, uuid } from './helpers.mjs';

const PORT = '58311';
const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const MIGRATION = read('supabase/migrations/20260928150000_support_reply_verifications.sql');
const ROLLBACK = read('docs/rollback/20260928150000_support_reply_verifications.rollback.sql');

function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-verification-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args, input) => spawnSync(path.join(bin, name), args, { env, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const must = r => { if (r.status !== 0) throw Error(r.stderr || r.stdout); return r; };
  must(exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']));
  must(exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']));
  // Statements go on stdin, so every result is printed, as through the management API.
  const run = (query, { user = 'postgres', db = 'postgres' } = {}) =>
    exec('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', user, '-d', db], `set time zone 'UTC';\n${query}`);
  const sql = (query, opts) => must(run(query, opts)).stdout.trim();
  const tryRun = (query, opts) => { const r = run(query, opts); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr }; };
  const close = () => { exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, tryRun, close };
}

// Supabase's shape, reduced to what the trigger and the writers touch: the
// three API roles behind authenticator, default privileges that hand every
// new public table to all three, Vault, pgcrypto in extensions, and the
// support tables with their production triggers (notify recorded, not sent).
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

  create table public.profiles (id uuid primary key, email text);
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
  create function public.bump_ticket_updated_at() returns trigger language plpgsql as $$
    begin update support_tickets set updated_at = now() where id = new.ticket_id; return new; end $$;
  create trigger trg_bump_ticket_updated_at after insert on public.support_messages for each row execute function public.bump_ticket_updated_at();
  create table public.sent_emails (message_id uuid);
  create function public.notify_ticket_reply() returns trigger language plpgsql security definer set search_path = public as $$
    declare owner_id uuid;
    begin
      if not public.is_admin(new.author_id) then return new; end if;
      select user_id into owner_id from public.support_tickets where id = new.ticket_id;
      if owner_id is null or owner_id = new.author_id then return new; end if;
      insert into public.sent_emails values (new.id); return new;
    end $$;
  create trigger trg_notify_ticket_reply after insert on public.support_messages for each row execute function public.notify_ticket_reply();
`;
const ADMIN = uuid(0xad01), MEMBER = uuid(0xbe01);
const MEMBER_TICKET = uuid(0xc001), RESOLVED_TICKET = uuid(0xc002), SPARE_TICKET = uuid(0xc003);
const SEED = `
  insert into public.profiles values ('${ADMIN}', 'owner@example.test'), ('${MEMBER}', 'member@example.test');
  insert into public.app_admins values ('${ADMIN}');
  insert into public.support_tickets (id, user_id, subject, body, status, updated_at) values
    ('${MEMBER_TICKET}', '${MEMBER}', 'Synthetic export question', 'Synthetic body', 'open', '2026-09-28T12:00:00Z'),
    ('${RESOLVED_TICKET}', '${MEMBER}', 'Synthetic resolved report', 'Synthetic body', 'resolved', '2026-09-28T12:00:00Z'),
    ('${SPARE_TICKET}', '${ADMIN}', 'Synthetic owner note', 'Synthetic body', 'open', '2026-09-28T12:00:00Z');
`;
const text = s => `convert_from(decode('${Buffer.from(s).toString('hex')}','hex'),'UTF8')`;
const insertMessage = ({ ticket = MEMBER_TICKET, author = MEMBER, body = 'Synthetic reply', admin = true, verification = null }) =>
  `insert into public.support_messages (ticket_id, author_id, body, is_admin_reply, verification_id)
   values ('${ticket}', '${author}', ${text(body)}, ${admin}, ${verification ? `'${verification}'` : 'null'}) returning id`;
const insertVerification = v => `insert into public.support_reply_verifications (id, ticket_id, body_sha256, hmac, report)
  values ('${v.id}', '${v.ticket_id}', '${v.body_sha256}', '${v.hmac}', ${text(JSON.stringify(v.report))}::jsonb)`;
// The management API as the writers see it: read-only wrappers return rows,
// a DO block returns the id its closing SELECT prints.
const management = pg => async query => {
  if (query.startsWith('begin read only; ') && query.endsWith('; rollback;')) {
    const inner = query.slice('begin read only; '.length, -'; rollback;'.length);
    return JSON.parse(pg.sql(`begin read only; select coalesce(json_agg(row), '[]'::json) from (${inner}) row; rollback;`));
  }
  if (query.startsWith('DO $')) { const out = pg.sql(query); return out ? out.split('\n').map(id => ({ id })) : []; }
  throw Error('Unexpected SQL shape');
};

test('support reply verification: the database refuses unverified operator replies and nothing else', { skip: pgSkip(), timeout: 180000 }, async t => {
  const pg = startPostgres();
  t.after(() => pg.close());
  pg.sql(ROLES);
  const platform = pg.tryRun(PLATFORM);
  if (!platform.ok && /pgcrypto/.test(platform.err)) { t.skip('pgcrypto is not installed with this PostgreSQL'); return; }
  assert.ok(platform.ok, platform.err);
  pg.sql(SEED);
  const query = management(pg);
  let key;

  await t.test('applies twice; creates the vault key once and never prints it', () => {
    const first = pg.tryRun(MIGRATION);
    assert.ok(first.ok, first.err);
    key = pg.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'support_reply_hmac_key'`);
    assert.match(key, /^[0-9a-f]{64}$/);
    const second = pg.tryRun(MIGRATION);
    assert.ok(second.ok, second.err);
    assert.equal(pg.sql(`select count(*) || '|' || min(decrypted_secret) from vault.decrypted_secrets where name = 'support_reply_hmac_key'`), `1|${key}`);
    for (const output of [first.out, first.err, second.out, second.err]) assert.ok(!output.includes(key), 'the key is never printed');
    pg.sql('create database keyed');
    pg.sql(PLATFORM, { db: 'keyed' });
    pg.sql(`select vault.create_secret('an-existing-synthetic-key-0123456789abcdef', 'support_reply_hmac_key')`, { db: 'keyed' });
    pg.sql(MIGRATION, { db: 'keyed' });
    assert.equal(pg.sql(`select decrypted_secret from vault.decrypted_secrets where name = 'support_reply_hmac_key'`, { db: 'keyed' }), 'an-existing-synthetic-key-0123456789abcdef');
  });

  await t.test('the verification table has RLS on and no grants to the API roles', () => {
    assert.equal(pg.sql(`select relrowsecurity from pg_class where oid = 'public.support_reply_verifications'::regclass`), 't');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal(pg.sql(`select has_table_privilege('${role}', 'public.support_reply_verifications', '${privilege}')`), 'f', `${role} ${privilege}`);
      }
    }
    const acl = pg.sql(`select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = 'public.require_verified_support_reply()'::regprocedure`);
    assert.doesNotMatch(acl, /(^|,)=X/);
    assert.doesNotMatch(acl, /(^|,)(anon|authenticated)=/);
    const denied = pg.tryRun('set role service_role; select count(*) from public.support_reply_verifications', { user: 'authenticator' });
    assert.equal(denied.ok, false);
  });

  await t.test('operator SQL cannot insert a support reply without a verification, whatever role it sets', () => {
    for (const [label, statement, opts] of [
      ['admin-flagged reply', insertMessage({}), {}],
      ['admin author, flag off (still emailed)', insertMessage({ author: ADMIN, admin: false }), {}],
      ['after SET ROLE service_role', `set role service_role; ${insertMessage({})}`, {}],
      ['after SET ROLE authenticated', `set role authenticated; ${insertMessage({})}`, {}],
      ['supabase_admin session', insertMessage({}), { user: 'supabase_admin' }],
    ]) {
      const refused = pg.tryRun(statement, opts);
      assert.equal(refused.ok, false, label);
      assert.match(refused.err, /support replies written with operator SQL need a verified reply/, label);
      assert.match(refused.err, /post-reply\.mjs/, label);
    }
    assert.equal(pg.sql('select count(*) from public.support_messages'), '0');
    assert.equal(pg.sql('select count(*) from public.sent_emails'), '0', 'nothing was emailed');
    assert.match(pg.sql(insertMessage({ admin: false, body: 'A member message' })), /^[0-9a-f-]{36}$/, 'a customer message is not a support reply');
  });

  await t.test('edge functions (service_role) and the in-app admin reply (authenticated) are unaffected', () => {
    assert.match(pg.sql(`set role service_role; ${insertMessage({ author: ADMIN, body: 'Edge function reply' })}`, { user: 'authenticator' }), /^[0-9a-f-]{36}$/);
    assert.match(pg.sql(`set role authenticated; ${insertMessage({ author: ADMIN, body: 'In-app reply' })}`, { user: 'authenticator' }), /^[0-9a-f-]{36}$/);
    assert.equal(pg.sql('select count(*) from public.sent_emails'), '2', 'notify_ticket_reply still fires for them');
  });

  await t.test('a valid verification is accepted once, and the SQL HMAC matches the Node one', () => {
    const body = labeledBody('Synthetic verified reply.');
    const v = buildVerification({ ticketId: MEMBER_TICKET, body, report: { path: 'test' }, secret: key });
    assert.equal(pg.sql(`select encode(extensions.hmac(convert_to('${v.id}:${v.ticket_id}:${v.body_sha256}', 'UTF8'), convert_to('${key}', 'UTF8'), 'sha256'), 'hex')`), v.hmac);
    assert.equal(pg.sql(`select encode(sha256(convert_to(${text(body)}, 'UTF8')), 'hex')`), sha256Hex(body));
    pg.sql(insertVerification(v));
    const id = pg.sql(insertMessage({ body, verification: v.id }));
    assert.equal(pg.sql(`select used_by_message_id || '|' || (used_at is not null) from public.support_reply_verifications where id = '${v.id}'`), `${id}|true`);
    const reused = pg.tryRun(insertMessage({ body, verification: v.id }));
    assert.equal(reused.ok, false);
    assert.match(reused.err, /already used/);
    const reusedByService = pg.tryRun(`set role service_role; ${insertMessage({ body, verification: v.id })}`, { user: 'authenticator' });
    assert.equal(reusedByService.ok, false, 'a verification id means the same thing from any role');
  });

  await t.test('a tampered body, another ticket, a forged signature or an unknown id are refused', () => {
    const body = labeledBody('The reply that was checked.');
    const v = buildVerification({ ticketId: MEMBER_TICKET, body, report: {}, secret: key });
    pg.sql(insertVerification(v));
    const cases = [
      ['tampered body', insertMessage({ body: labeledBody('A different reply.'), verification: v.id }), /does not match verification/],
      ['another ticket', insertMessage({ ticket: SPARE_TICKET, body, verification: v.id }), /belongs to another ticket/],
      ['unknown id', insertMessage({ body, verification: uuid(0xdead) }), /does not exist/],
    ];
    const forged = { ...buildVerification({ ticketId: MEMBER_TICKET, body, report: {}, secret: 'a-guessed-key-that-is-not-the-vault-one-0000' }) };
    pg.sql(insertVerification(forged));
    cases.push(['forged signature', insertMessage({ body, verification: forged.id }), /invalid signature/]);
    for (const [label, statement, error] of cases) {
      const refused = pg.tryRun(statement);
      assert.equal(refused.ok, false, label);
      assert.match(refused.err, error, label);
    }
    assert.equal(pg.sql(`select used_at is null from public.support_reply_verifications where id = '${v.id}'`), 't', 'a refused insert consumes nothing');
    assert.match(pg.sql(insertMessage({ body, verification: v.id })), /^[0-9a-f-]{36}$/, 'the honest insert still works');
  });

  await t.test('operator SQL cannot rewrite a support reply afterwards; other edits are unaffected', () => {
    const reply = pg.sql(`select id from public.support_messages where verification_id is not null limit 1`);
    for (const change of [`body = 'Rewritten'`, 'is_admin_reply = false', `ticket_id = '${SPARE_TICKET}'`, 'verification_id = null']) {
      const refused = pg.tryRun(`update public.support_messages set ${change} where id = '${reply}'`);
      assert.equal(refused.ok, false, change);
      assert.match(refused.err, /cannot be rewritten with operator SQL/, change);
    }
    const customer = pg.sql(`select id from public.support_messages where body = 'A member message'`);
    pg.sql(`update public.support_messages set body = 'A corrected member message' where id = '${customer}'`);
    pg.sql(`update public.support_messages set attachment_path = null where id = '${reply}'`);
    pg.sql(`set role service_role; update public.support_messages set body = body where id = '${reply}'`, { user: 'authenticator' });
  });

  await t.test("the agent's replySQL stores a verified reply and keeps a resolved ticket resolved", async () => {
    const replyText = 'Synthetic agent reply \u2014 checked against source.';
    const v = buildVerification({ ticketId: RESOLVED_TICKET, body: agentReplyBody(replyText), report: { path: 'agent' }, secret: await readVerificationKey(query) });
    const ticket = { id: RESOLVED_TICKET, owner_id: MEMBER, updated_at: pg.sql(`select updated_at from public.support_tickets where id = '${RESOLVED_TICKET}'`),
      approval: { from_admin: false, approved_at: '2026-09-27T00:00:00Z' } };
    pg.sql(`update public.support_tickets set agent_approved_at = '2026-09-27T00:00:00Z' where id = '${RESOLVED_TICKET}'`);
    ticket.updated_at = pg.sql(`select updated_at from public.support_tickets where id = '${RESOLVED_TICKET}'`);
    const rows = await query(replySQL(ticket, replyText, { verification: v }));
    assert.equal(rows.length, 1);
    assert.equal(pg.sql(`select status || '|' || (agent_last_reply_at is not null) from public.support_tickets where id = '${RESOLVED_TICKET}'`), 'resolved|true');
    assert.equal(pg.sql(`select body from public.support_messages where id = '${rows[0].id}'`), 'CredentialDOMD Support · Automated\n\nSynthetic agent reply, checked against source.');
    assert.equal(pg.sql(`select verification_id from public.support_messages where id = '${rows[0].id}'`), v.id);
    assert.deepEqual(await query(replySQL(ticket, replyText, { verification: buildVerification({ ticketId: RESOLVED_TICKET, body: agentReplyBody(replyText), report: {}, secret: key }) })), [], 'a stale version is withheld');
  });

  await t.test('post-reply.mjs end to end: one ticket, verified claims, status kept, a rerun refused', async () => {
    const repo = tempRepo({ 'src/export.js': 'export const options = {\n  includeExpired: true,\n};\n' });
    const state = privateDir('ticket-fix-post-');
    const lines = [];
    const log = line => lines.push(line);
    try {
      const replyFile = path.join(state.dir, 'reply.json');
      fs.writeFileSync(replyFile, JSON.stringify({ ticket_id: MEMBER_TICKET, opening: 'update', closing: 'reply_here',
        claims: [{ id: 'AC-1', text: 'Expired licences are now included in the export.', evidence: { file: 'src/export.js', line: 2, text: 'includeExpired: true' } },
          { id: 'AC-2', text: 'The PDF uses the new layout.', evidence: { file: 'src/export.js', line: 2, text: 'pdfLayout: 2' } }] }));
      const deps = { git: repo.git, stateDir: state.dir, fetchBuild: noBuild, log };
      const offline = async () => { throw Error('a dry run must not reach the database'); };
      assert.equal(await verifyClaims(['--ticket', MEMBER_TICKET, '--reply', replyFile], { ...deps, query: offline }), 3);
      assert.equal(await postReply(['--ticket', MEMBER_TICKET, '--reply', replyFile, '--dry-run'], { ...deps, query: offline }), 3);
      assert.equal(await postReply(['--ticket', MEMBER_TICKET, '--ticket', RESOLVED_TICKET, '--reply', replyFile], { ...deps, query }), 2, 'two tickets refused');
      assert.equal(await postReply(['--ticket', RESOLVED_TICKET, '--reply', replyFile], { ...deps, query }), 2, 'file names another ticket');
      const before = pg.sql('select count(*) from public.support_messages');
      assert.equal(await postReply(['--ticket', MEMBER_TICKET, '--reply', replyFile], { ...deps, query }), 0, lines.join('\n'));
      const posted = JSON.parse(lines.at(-1));
      assert.equal(pg.sql('select count(*) from public.support_messages'), String(Number(before) + 1));
      const stored = JSON.parse(pg.sql(`select row_to_json(m) from (select body, author_id, is_admin_reply, verification_id from public.support_messages where id = '${posted.message_id}') m`));
      assert.equal(stored.verification_id, posted.verification_id);
      assert.equal(stored.author_id, MEMBER);
      assert.equal(stored.is_admin_reply, true);
      assert.match(stored.body, /^CredentialDOMD Support · Automated\n\nHere is where your request stands\.\n\nWhat we confirmed:\n- Expired licences are now included in the export\.\n\nNot done yet:\n- The PDF uses the new layout\./);
      const report = JSON.parse(pg.sql(`select report from public.support_reply_verifications where id = '${posted.verification_id}'`));
      assert.deepEqual(report.claims.map(c => c.verified), [true, false]);
      assert.equal(report.head, repo.first);
      assert.ok(!JSON.stringify(report).includes(key), 'the key is not in the report');
      assert.equal(pg.sql(`select status from public.support_tickets where id = '${MEMBER_TICKET}'`), 'open');
      const ledger = path.join(state.dir, 'replies', MEMBER_TICKET, `${posted.verification_id}.json`);
      assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
      assert.ok(!fs.readFileSync(ledger, 'utf8').includes(key));
      assert.equal(await postReply(['--ticket', MEMBER_TICKET, '--reply', replyFile], { ...deps, query }), 2, 'the same reply twice is refused');
      assert.match(lines.at(-1), /already stored/);
      // A new customer message between reading the ticket and writing: withheld.
      fs.writeFileSync(replyFile, JSON.stringify({ ticket_id: MEMBER_TICKET, opening: 'answer', closing: 'none', not_done: ['A second synthetic answer.'] }));
      const racing = async sql => {
        if (sql.includes('vault.decrypted_secrets')) pg.sql(`set role service_role; ${insertMessage({ admin: false, body: 'Racing input' })}`, { user: 'authenticator' });
        return query(sql);
      };
      assert.equal(await postReply(['--ticket', MEMBER_TICKET, '--reply', replyFile], { ...deps, query: racing }), 4);
      assert.equal(pg.sql(`select count(*) from public.support_messages where body like '%A second synthetic answer.%'`), '0');
      assert.equal(pg.sql(`select count(*) from public.support_reply_verifications v where not exists (select 1 from public.support_messages m where m.verification_id = v.id) and v.report->>'path' = 'post-reply'`), '0', 'a withheld reply leaves no verification behind');
    } finally { repo.cleanup(); state.cleanup(); }
  });

  await t.test('deleting a ticket removes its verified replies and verifications together', () => {
    pg.sql(`delete from public.support_tickets where id = '${RESOLVED_TICKET}'`);
    assert.equal(pg.sql(`select count(*) from public.support_reply_verifications where ticket_id = '${RESOLVED_TICKET}'`), '0');
  });

  await t.test('the rollback turns enforcement off and the migration turns it back on', () => {
    pg.sql(ROLLBACK);
    assert.match(pg.sql(insertMessage({ body: 'Unverified after rollback' })), /^[0-9a-f-]{36}$/);
    pg.sql(MIGRATION);
    assert.equal(pg.tryRun(insertMessage({ body: 'Unverified after reapply' })).ok, false);
  });
});
