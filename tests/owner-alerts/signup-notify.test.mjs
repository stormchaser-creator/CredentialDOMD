// The owner notifier's SQL and message, against a real PostgreSQL with
// synthetic rows (shapes as production has them, 2026-09-29), and then the
// real zsh script end to end with the network call answered by that database.
//
// What it proves:
//   (c) a [TICKET REPLY] is a member's reply only: never a verified support
//       reply, one signed "CredentialDOMD Support", or an admin reply stored
//       with the member as author (57 alerts since 1 September, 17 real);
//   (b) money events: a checkout started, a paid purchase, a subscription
//       active with no recorded payment, a lifetime gift claimed and an
//       invitation sent, each reported once even when it settles late;
//   a table that does not exist yet (invite_to_join_sends before its
//   migration) is skipped instead of failing every notification;
//   (a) the ticket runner's queued alerts go out through this job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { raise, QUEUE_FILE, SENT_FILE } from '../../scripts/ticket-fix/alert.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PY = path.join(root, 'scripts/signup-notify.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const PORT = '58763'; // own port: node --test runs files in parallel
const exec = promisify(execFile);

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MEMBER = id(1), ADMIN = id(2), OTHER = id(3), BUYER = id(4), GIFTED = id(5), TRIAL = id(6);
const TICKET = id(101), ADMIN_TICKET = id(102);
const EARLIER = '2026-09-29T09:00:00Z'; // the last run, for the time-window rows

// Production shapes, trimmed to the columns the notifier reads.
const BASE = `
create table profiles(id uuid primary key, auth_user_id text, name text, email text, created_at timestamptz default now());
create table app_admins(profile_id uuid primary key);
create function public.is_admin(p uuid) returns boolean language sql stable as $$ select exists(select 1 from app_admins where profile_id = p) $$;
create table early_access_leads(id uuid primary key default gen_random_uuid(), email text, name text, source text, waitlist boolean, created_at timestamptz default now());
create table founding_signups(id uuid primary key default gen_random_uuid(), name text, email text, created_at timestamptz default now());
create table waitlist_attempts(id uuid primary key default gen_random_uuid(), name text, email text, stage text, created_at timestamptz default now());
create table support_tickets(id uuid primary key, user_id uuid, subject text, created_at timestamptz default now());
create table support_messages(id uuid primary key, ticket_id uuid, author_id uuid, body text not null, is_admin_reply boolean default false,
  created_at timestamptz default now(), attachment_path text, client_request_id uuid, verification_id uuid, emailed_at timestamptz);
create table client_errors(id uuid primary key default gen_random_uuid(), auth_user_id text, kind text, message text, created_at timestamptz default now());
create table beta_access(id uuid primary key default gen_random_uuid(), email text, name text, status text, invite_sent_at timestamptz, activated_at timestamptz);
`;
const OPTIONAL = `
create table feedback(id uuid primary key default gen_random_uuid(), user_id uuid, rating smallint, message text, context_page text, created_at timestamptz default now());
create table billing_checkout_attempts(profile_id uuid, livemode boolean, attempt_id uuid unique, offer_id text, state text, created_at timestamptz default now(), primary key(profile_id, livemode));
create table limited_billing_quotes(attempt_id uuid primary key, profile_id uuid, livemode boolean, offer_id text, price_phase text, annual_cents integer, created_at timestamptz default now());
create table limited_paid_purchase_history(subscription_id text, livemode boolean, profile_id uuid, quote_id uuid, first_verified_invoice_id text,
  first_verified_paid_at timestamptz, offer_id text, price_phase text, annual_cents integer, primary key(subscription_id, livemode));
create table access_purchase_receipts(invoice_id text, livemode boolean, profile_id uuid, subscription_id text, price_phase text, annual_cents integer, paid_at timestamptz);
create table billing_subscriptions(profile_id uuid, livemode boolean, subscription_id text, offer_id text, status text, membership_active boolean, updated_at timestamptz default now());
create table lifetime_gift_reservations(id uuid primary key, email text, livemode boolean, claimed_profile_id uuid, claimed_at timestamptz, revoked_at timestamptz);
create table invite_to_join_sends(id uuid primary key, invited_by uuid, email text not null, name text, status text not null, explicit_resend boolean not null default false,
  offer_phase text not null, offer_annual_cents integer not null, provider_id text, created_at timestamptz default now(), sent_at timestamptz, updated_at timestamptz default now());
`;
const CORE_ROWS = `
insert into profiles(id, name, email) values
  ('${MEMBER}', 'Synthetic Member', 'member@example.test'), ('${ADMIN}', 'Synthetic Owner', 'owner@example.test'),
  ('${OTHER}', 'Synthetic Other', 'other@example.test'), ('${BUYER}', 'Synthetic Buyer', 'buyer@example.test'),
  ('${GIFTED}', 'Synthetic Gifted', 'gifted@example.test'), ('${TRIAL}', 'Synthetic Trial', 'trial@example.test');
update profiles set created_at = '${EARLIER}'::timestamptz - interval '1 day';
insert into app_admins values ('${ADMIN}');
insert into support_tickets(id, user_id, subject, created_at) values
  ('${TICKET}', '${MEMBER}', 'Synthetic export question', '${EARLIER}'::timestamptz - interval '1 day'),
  ('${ADMIN_TICKET}', '${ADMIN}', 'Owner test ticket', now());
insert into support_messages(id, ticket_id, author_id, body, is_admin_reply, verification_id, created_at) values
  ('${id(201)}', '${TICKET}', '${MEMBER}', 'The export still shows the old date.', false, null, now()),
  ('${id(202)}', '${TICKET}', '${MEMBER}', 'CredentialDOMD Support here. Checked and fixed.', true, '${id(900)}', now()),
  ('${id(203)}', '${TICKET}', '${MEMBER}', 'CredentialDOMD Support: an older signed reply.', false, null, now()),
  ('${id(204)}', '${TICKET}', '${MEMBER}', 'A verified reply that is not signed.', false, '${id(901)}', now()),
  ('${id(205)}', '${TICKET}', '${MEMBER}', 'A legacy support reply stored with the member as author.', true, null, now()),
  ('${id(206)}', '${TICKET}', '${ADMIN}', 'The owner answering.', true, null, now()),
  ('${id(207)}', '${TICKET}', '${MEMBER}', 'An old member reply, before the last run.', false, null, '${EARLIER}'::timestamptz - interval '1 hour');
insert into beta_access(email, name, status, invite_sent_at) values ('beta@example.test', 'Synthetic Beta', 'invited', now());
`;
const MONEY_ROWS = `
insert into feedback(user_id, rating, message, context_page) values ('${MEMBER}', 4, 'Synthetic feedback about the CME page.', '/app/cme'), ('${ADMIN}', 5, 'Owner testing.', null);
-- Checkout: a quote per attempt (limited checkout), and one older attempt with no quote.
insert into billing_checkout_attempts(profile_id, livemode, attempt_id, offer_id, state) values
  ('${BUYER}', true, '${id(301)}', 'core', 'complete'), ('${OTHER}', false, '${id(302)}', 'core_locum', 'open');
insert into limited_billing_quotes(attempt_id, profile_id, livemode, offer_id, price_phase, annual_cents) values ('${id(301)}', '${BUYER}', true, 'core', 'founding', 9900);
-- Paid: settled now, stamped with a payment time before the last run.
insert into limited_paid_purchase_history(subscription_id, livemode, profile_id, first_verified_paid_at, offer_id, price_phase, annual_cents)
  values ('sub_synthetic1', true, '${BUYER}', '${EARLIER}'::timestamptz - interval '2 hours', 'core', 'founding', 9900);
insert into access_purchase_receipts(invoice_id, livemode, profile_id, subscription_id, price_phase, annual_cents, paid_at)
  values ('in_synthetic1', true, '${BUYER}', 'sub_synthetic1', 'founding', 9900, '${EARLIER}'::timestamptz - interval '2 hours');
insert into billing_subscriptions(profile_id, livemode, subscription_id, offer_id, status, membership_active) values
  ('${BUYER}', true, 'sub_synthetic1', 'core', 'active', true),
  ('${TRIAL}', true, 'sub_synthetic2', 'core', 'active', true),
  ('${OTHER}', true, 'sub_synthetic3', 'core', 'trialing', true);
insert into lifetime_gift_reservations(id, email, livemode, claimed_profile_id, claimed_at) values
  ('${id(401)}', 'gifted@example.test', true, '${GIFTED}', now()), ('${id(402)}', 'unclaimed@example.test', true, null, null);
insert into invite_to_join_sends(id, email, name, status, explicit_resend, offer_phase, offer_annual_cents, provider_id, sent_at) values
  ('${id(501)}', 'colleague@example.test', 'Synthetic Colleague', 'sent', false, 'founding', 9900, 'prov_1', now()),
  ('${id(502)}', 'bounced@example.test', null, 'failed', false, 'founding', 9900, null, null),
  ('${id(503)}', 'maybe@example.test', null, 'sending', false, 'founding', 9900, null, null);
insert into invite_to_join_sends(id, email, status, offer_phase, offer_annual_cents, created_at, updated_at) values
  ('${id(504)}', 'stuck@example.test', 'sending', 'earlybird', 14900, now() - interval '20 minutes', now() - interval '20 minutes');
`;

async function startPostgres() {
  const bin = pgBin();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner notify ')));
  const socket = fs.mkdtempSync(path.join(os.tmpdir(), 'pgs-')); // short: a socket path has a length limit
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const run = (name, args) => exec(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  await run('initdb', ['-D', path.join(base, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await run('pg_ctl', ['-D', path.join(base, 'data'), '-l', path.join(base, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  const psqlArgs = db => ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', db];
  const sql = async (query, db = 'postgres') => (await run('psql', [...psqlArgs(db), '-c', query])).stdout.trim();
  const rows = async (query, db = 'postgres') => JSON.parse(await sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`, db));
  const close = async () => {
    await run('pg_ctl', ['-D', path.join(base, 'data'), '-m', 'fast', '-w', 'stop']);
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socket, { recursive: true, force: true });
  };
  return { base, bin, socket, psql: path.join(bin, 'psql'), psqlArgs, sql, rows, close };
}

const py = (args, input) => {
  const r = spawnSync(python, [PY, ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) throw Error(`signup-notify.py ${args[0]} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
};
const present = async pg => py(['present'], JSON.stringify(await pg.rows(py(['probe'])))).trim();
const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19) + 'Z';
const activity = async (pg, since = EARLIER, now = iso(60)) => pg.rows(py(['query', '--since', since, '--now', now, '--present', await present(pg)]));
const lines = (rows, kind) => rows.filter(r => r.kind === kind);

const skip = () => pgSkip() || (python ? false : 'python3 not found');
test('signup notifier SQL on PostgreSQL: member replies only, money events, missing tables skipped', { skip: skip(), timeout: 300000 }, async t => {
  const pg = await startPostgres();
  t.after(() => pg.close());
  await pg.sql(BASE + OPTIONAL + CORE_ROWS + MONEY_ROWS);

  await t.test('the probe names every optional table that exists', async () => {
    assert.equal(await present(pg), 'feedback,limited_billing_quotes,billing_checkout_attempts,limited_paid_purchase_history,access_purchase_receipts,billing_subscriptions,lifetime_gift_reservations,invite_to_join_sends');
  });

  await t.test('(c) a TICKET REPLY is a member reply only', async () => {
    const replies = lines(await activity(pg), 'TICKET REPLY');
    assert.deepEqual(replies.map(r => r.extra), ['Synthetic export question: The export still shows the old date.'],
      'not the verified reply, not the signed ones, not the admin-marked one, not the owner, not an old one');
    assert.equal(replies[0].email, 'member@example.test');
    // Each filter on its own: take one away and its row comes back.
    const bare = py(['query', '--since', EARLIER, '--now', iso(60), '--present', '']);
    for (const [filter, row] of [
      ["and (to_jsonb(m)->>'verification_id') is null", 'A verified reply that is not signed.'],
      ["and coalesce(m.body, '') not ilike 'CredentialDOMD Support%'", 'CredentialDOMD Support: an older signed reply.'],
      ["and coalesce((to_jsonb(m)->>'is_admin_reply')::boolean, false) = false", 'A legacy support reply stored with the member as author.'],
    ]) {
      assert.ok(bare.includes(filter), filter);
      const without = lines(await pg.rows(bare.replace(filter, '')), 'TICKET REPLY').map(r => r.extra.split(': ').slice(1).join(': '));
      assert.ok(without.includes(row), `without "${filter}" the reply "${row}" is reported`);
    }
  });

  await t.test('tickets and feedback from the owner stay quiet; a member\'s are reported', async () => {
    const rows = await activity(pg);
    assert.deepEqual(lines(rows, 'TICKET'), [], 'the owner\'s own ticket');
    assert.deepEqual(lines(rows, 'FEEDBACK').map(r => [r.email, r.extra]), [['member@example.test', '4/5 (/app/cme) Synthetic feedback about the CME page.']]);
  });

  await t.test('(b) money events, keyed, with test mode marked', async () => {
    const rows = await activity(pg);
    assert.deepEqual(lines(rows, 'CHECKOUT STARTED').map(r => [r.email, r.extra, r.key]).sort(), [
      ['buyer@example.test', 'Core, founding, $99/yr', `checkout:${id(301)}`],
      ['other@example.test', 'Core + Locum (test mode)', `checkout:${id(302)}`],
    ], 'the attempt with a quote is reported once, from the quote');
    // Paid before the last run, settled after it: still reported (keyed, not timed).
    assert.deepEqual(lines(rows, 'PAID').map(r => [r.email, r.extra, r.key]), [
      ['buyer@example.test', 'Core, founding, $99/yr', 'paid:sub_synthetic1:true'],
      ['buyer@example.test', 'Core, founding, $99/yr', 'paid:sub_synthetic1:true'],
    ], 'both purchase tables, one key');
    assert.deepEqual(lines(rows, 'SUBSCRIPTION ACTIVE').map(r => [r.email, r.extra]), [['trial@example.test', 'Core, no verified payment recorded']],
      'the paid subscription is PAID, the trialing one is not active');
    assert.deepEqual(lines(rows, 'LIFETIME GIFT CLAIMED').map(r => [r.email, r.extra, r.key]), [['gifted@example.test', '', `gift:${id(401)}`]]);
    assert.deepEqual(lines(rows, 'INVITE SENT').map(r => [r.email, r.extra]).sort(), [
      ['beta@example.test', 'beta invitation'],
      ['colleague@example.test', 'founding, $99/yr offer'],
    ]);
    assert.deepEqual(lines(rows, 'INVITE FAILED').map(r => [r.email, r.extra]), [['bounced@example.test', 'founding, $99/yr offer, the email provider refused it']]);
    assert.deepEqual(lines(rows, 'INVITE UNCONFIRMED').map(r => [r.email, r.extra, r.key]), [['stuck@example.test', 'earlybird, $149/yr offer, no confirmation it went out', `invite:${id(504)}:unknown`]],
      'a send still in flight is not reported yet; one stuck for 20 minutes is');
  });

  await t.test('the message: money first in the header, one line each, a key reported once, no em dash', async () => {
    const rows = await activity(pg);
    const seen = path.join(pg.base, 'seen keys.json');
    const msg = py(['format', '--seen', seen], JSON.stringify(rows)).trim();
    const [header, ...body] = msg.split('\n');
    assert.equal(header, 'CredentialDOMD money: 1 paid, 2 checkouts started, 1 subscription active without a recorded payment, 1 lifetime gift claimed, 2 invitations sent, 1 invitation unconfirmed, 1 invitation failed, plus 2 other');
    assert.equal(body.filter(l => l.startsWith('• [PAID] ')).length, 1, 'one key, one line');
    assert.ok(body.includes('• [PAID] Synthetic Buyer (buyer@example.test): Core, founding, $99/yr'), body.join('\n'));
    assert.ok(body.includes('• [TICKET REPLY] Synthetic Member (member@example.test): Synthetic export question: The export still shows the old date.'), body.join('\n'));
    assert.ok(body.includes('• [INVITE SENT] Synthetic Colleague (colleague@example.test): founding, $99/yr offer'), body.join('\n'));
    assert.ok(body.includes('• [LIFETIME GIFT CLAIMED] Synthetic Gifted (gifted@example.test)'), body.join('\n'));
    assert.doesNotMatch(msg, /\u2014/);
    py(['remember', '--seen', seen], JSON.stringify(rows));
    assert.equal(fs.statSync(seen).mode & 0o777, 0o600);
    // The next run: keyed rows are not repeated; the time-window ones have moved on.
    const next = await activity(pg, iso(1), iso(61));
    assert.ok(next.length > 0, 'the money rows are still inside the lookback');
    assert.equal(py(['format', '--seen', seen], JSON.stringify(next)), '', 'and nothing is sent twice');
    // A late invitation outcome is a new key; a stuck send later marked
    // 'unknown' by the invite function is the same key and stays quiet.
    await pg.sql(`update invite_to_join_sends set status = 'unknown', updated_at = now() where id in ('${id(503)}', '${id(504)}')`);
    const later = await activity(pg, iso(1), iso(61));
    assert.equal(py(['format', '--seen', seen], JSON.stringify(later)).trim(),
      'CredentialDOMD: 1 invitation unconfirmed\n• [INVITE UNCONFIRMED] maybe@example.test: founding, $99/yr offer, no confirmation it went out');
  });

  await t.test('timed rows tile (since, now]: a row at a run\'s start is reported once, a failed attempt 3 minutes later, never skipped', async () => {
    // Before this change: no upper bound (a row written in the second a run
    // started went out twice), and an attempt made in the 3 minutes before a
    // run was skipped by it as too recent and by the next one as too old.
    await pg.sql(`insert into support_messages(id, ticket_id, author_id, body, created_at)
      values ('${id(209)}', '${TICKET}', '${MEMBER}', 'Written as a run started.', '2026-09-28T10:00:00.400Z');
      insert into waitlist_attempts(name, email, stage, created_at) values ('Synthetic Attempt', 'attempt@example.test', 'verify', '2026-09-28T09:58:00Z')`);
    const window = async (since, now) => pg.rows(py(['query', '--since', since, '--now', now, '--present', '']));
    const runs = [await window('2026-09-28T09:50:00Z', '2026-09-28T10:00:00Z'), await window('2026-09-28T10:00:00Z', '2026-09-28T10:10:00Z'),
      await window('2026-09-28T10:10:00Z', '2026-09-28T10:20:00Z')];
    assert.deepEqual(runs.map(r => lines(r, 'TICKET REPLY').length), [0, 1, 0], 'the boundary reply, once');
    assert.deepEqual(runs.map(r => lines(r, 'FAILED ATTEMPT').map(a => a.email)), [[], ['attempt@example.test'], []], 'the attempt, once, after 3 minutes');
  });

  await t.test('a database without the optional tables still gets its signups, tickets and replies', async () => {
    await pg.sql('create database bare');
    await pg.sql(BASE + CORE_ROWS, 'bare');
    const probe = await pg.rows(py(['probe']), 'bare');
    assert.equal(py(['present'], JSON.stringify(probe)).trim(), '');
    const rows = await pg.rows(py(['query', '--since', EARLIER, '--now', iso(60), '--present', '']), 'bare');
    assert.deepEqual(lines(rows, 'TICKET REPLY').map(r => r.email), ['member@example.test']);
    // Naming a table that is not there is exactly what the probe prevents.
    await assert.rejects(pg.rows(py(['query', '--since', EARLIER, '--now', iso(60), '--present', 'invite_to_join_sends']), 'bare'), /invite_to_join_sends/);
  });

  await t.test('the query refuses a malformed last-run time and an unknown table name', () => {
    for (const bad of ["2026-09-29T09:00:00Z' or true --", '', 'yesterday']) {
      const r = spawnSync(python, [PY, 'query', '--since', bad, '--present', ''], { encoding: 'utf8' });
      assert.equal(r.status, 1, bad); assert.match(r.stderr, /--since must be a UTC time/);
    }
    const r = spawnSync(python, [PY, 'query', '--since', EARLIER, '--present', 'profiles; drop table x'], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /unknown optional table/);
  });

  // ─── The real zsh script, end to end ─────────────────────────────────────
  const shellSkip = fs.existsSync('/bin/zsh') ? false : 'the job runs under /bin/zsh, which is not installed here';
  await t.test('signup-notify.sh: drains the runner\'s queue, reports activity and money once, and keeps both on a failed send', { skip: shellSkip }, async () => {
    // A copy of the job as launchd runs it, in folders with spaces, with
    // stand-ins for the keychain, the network and Messages.
    const job = path.join(pg.base, 'job copy', 'scripts');
    const home = path.join(pg.base, 'home dir');
    const bin = path.join(pg.base, 'shim bin');
    for (const d of [job, home, bin]) fs.mkdirSync(d, { recursive: true });
    for (const f of ['signup-notify.sh', 'signup-notify.py']) fs.copyFileSync(path.join(root, 'scripts', f), path.join(job, f));
    const sentLog = path.join(pg.base, 'imessages.jsonl');
    const failFlag = path.join(pg.base, 'messages refuses');
    fs.writeFileSync(path.join(job, 'notify-owner.sh'), `#!/bin/sh\n[ -e "${failFlag}" ] && exit 1\nprintf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' >> "${sentLog}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho synthetic-management-token\n', { mode: 0o755 });
    const curlLog = path.join(pg.base, 'curl.log');
    fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env python3
import json, subprocess, sys
args = sys.argv[1:]
assert 'https://api.supabase.com/v1/projects/hkpnnsjcwprrwobmpqyy/database/query' in args
assert 'Authorization: Bearer synthetic-management-token' in args
query = json.loads(args[args.index('--data') + 1])['query']
open(${JSON.stringify(curlLog)}, 'a').write(query.split('\\n')[0][:60] + '\\n')
r = subprocess.run([${JSON.stringify(pg.psql)}, ${pg.psqlArgs('postgres').map(a => JSON.stringify(a)).join(', ')}, '-c',
    "select coalesce(json_agg(t), '[]'::json) from (" + query + ") t"], capture_output=True, text=True)
if r.returncode:
    sys.stderr.write(r.stderr); sys.exit(22)
sys.stdout.write(r.stdout.strip())
`, { mode: 0o755 });
    const pythonDir = path.dirname(spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim());
    const env = { HOME: home, PATH: [bin, pythonDir, '/usr/bin', '/bin'].join(':'), LC_ALL: 'C' };
    const runJob = () => spawnSync('/bin/zsh', [path.join(job, 'signup-notify.sh')], { encoding: 'utf8', env, timeout: 120000 });
    const sent = () => (fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const log = () => fs.readFileSync(path.join(home, '.credentialdomd-signup-notify.log'), 'utf8');

    // The runner's state directory where launchd's job looks for it.
    const alertState = path.join(home, 'Library', 'Application Support', 'CredentialDOMD', 'ticket-context');
    fs.mkdirSync(alertState, { recursive: true, mode: 0o700 });
    fs.chmodSync(alertState, 0o700);
    const quiet = console.log; console.log = () => {};
    try {
      await raise(alertState, 'change_refused', 'ticket=a1b2c3d4 run=a1b2c3d4-0123456789abcdef', 'CredentialDOMD ticket agent: the change for ticket a1b2c3d4 was not merged.');
      await raise(alertState, 'parked', 'ticket=a1b2c3d4 rejected_runs=3', 'CredentialDOMD ticket agent: ticket a1b2c3d4 is parked after 3 rejected runs.');
    } finally { console.log = quiet; }
    fs.writeFileSync(path.join(home, '.credentialdomd-signup-notify'), `${EARLIER}\n`);
    await pg.sql(`update invite_to_join_sends set status = 'sending' where id = '${id(503)}'`);
    // Every fixture row is older than the first run's start (whole seconds).
    await new Promise(resolve => setTimeout(resolve, 1100));

    const first = runJob();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const [alerts, activityMsg] = sent();
    assert.equal(sent().length, 2, JSON.stringify(sent()));
    assert.match(alerts, /^CredentialDOMD ticket agent: 2 alerts\n• .+: the change for ticket a1b2c3d4 was not merged\.\n• .+: ticket a1b2c3d4 is parked after 3 rejected runs\.$/);
    assert.equal(fs.readFileSync(path.join(alertState, SENT_FILE), 'utf8').split('\n').filter(Boolean).length, 2);
    assert.match(activityMsg, /^CredentialDOMD money: 1 paid, 2 checkouts started, /);
    assert.equal(activityMsg.split('\n').filter(l => l.startsWith('• [TICKET REPLY]')).length, 1, activityMsg);
    assert.doesNotMatch(activityMsg, /CredentialDOMD Support|verified reply|legacy support reply/);
    assert.doesNotMatch(alerts + activityMsg, /\u2014/);
    assert.match(log(), /owner alerts: sent 2 \(change_refused [0-9a-f]{8}, parked [0-9a-f]{8}\)/);
    assert.ok(fs.readFileSync(curlLog, 'utf8').startsWith('select to_regclass('), 'the probe runs first');
    const since = fs.readFileSync(path.join(home, '.credentialdomd-signup-notify'), 'utf8').trim();
    assert.notEqual(since, EARLIER, 'the window moved on');

    // Nothing new: nothing sent, and nothing sent twice.
    const second = runJob();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(sent().length, 2);
    const afterSecond = fs.readFileSync(path.join(home, '.credentialdomd-signup-notify'), 'utf8').trim();

    // Messages refuses: the new alert and the new member reply both wait.
    await new Promise(resolve => setTimeout(resolve, 1100));
    console.log = () => {};
    try { await raise(alertState, 'stale_lock', 'age_hours=5', 'CredentialDOMD ticket agent: the run lock has been held 5 h.'); } finally { console.log = quiet; }
    await pg.sql(`insert into support_messages(id, ticket_id, author_id, body) values ('${id(208)}', '${TICKET}', '${MEMBER}', 'One more member reply.')`);
    // A run reports up to its own start, in whole seconds: begin after the reply.
    await new Promise(resolve => setTimeout(resolve, 1100));
    fs.writeFileSync(failFlag, '');
    const refused = runJob();
    assert.equal(refused.status, 1);
    assert.equal(sent().length, 2);
    assert.match(log(), /owner alerts: not drained this run; they stay queued/);
    assert.equal(fs.readFileSync(path.join(home, '.credentialdomd-signup-notify'), 'utf8').trim(), afterSecond, 'the window did not move');
    fs.rmSync(failFlag);
    const recovered = runJob();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(sent().length, 4);
    assert.match(sent()[2], /^CredentialDOMD ticket agent: the run lock has been held 5 h\. \(raised /);
    assert.equal(sent()[3], 'CredentialDOMD activity\n• [TICKET REPLY] Synthetic Member (member@example.test): Synthetic export question: One more member reply.');
    assert.equal(fs.readFileSync(path.join(alertState, QUEUE_FILE), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.equal(fs.readFileSync(path.join(alertState, SENT_FILE), 'utf8').split('\n').filter(Boolean).length, 3);
  });
});
