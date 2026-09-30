// BILL-003: a member who bought, then cancelled, could never buy again.
//
// Nothing closed a paid checkout attempt: it stayed 'open' with its quote's
// subscription_id set. After the subscription settled canceled, the snapshot
// offered the standard offers again, but every claim found that old attempt:
// terms that differ answered offer_conflict with no 'prior' (the supersede
// candidate requires a quote with no subscription), which the checkout
// handler turns into checkout_offer_already_selected, every time.
//
// 20260930001000_checkout_closes_on_settlement.sql closes the attempt when
// its subscription settles with any status but 'incomplete' (a declined card
// still resumes its saved session), and, for attempts left open before it,
// the claim closes one whose subscription is canceled or incomplete_expired
// when no other subscription is live.
//
// Real PostgreSQL with the actual billing chain underneath, applied twice.
// Synthetic identities, customers, invoices and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot, withSlotWait } from '../credential-portal/postgresFixture.mjs';

// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58963';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const NAME = '20260930001000_checkout_closes_on_settlement';
const MIGRATION_URL = new URL(`../../supabase/migrations/${NAME}.sql`, import.meta.url);
const ROLLBACK_URL = new URL(`../../docs/rollback/${NAME}.rollback.sql`, import.meta.url);
const MIGRATION = fs.existsSync(MIGRATION_URL) ? fs.readFileSync(MIGRATION_URL, 'utf8') : null;
const ROLLBACK = fs.existsSync(ROLLBACK_URL) ? fs.readFileSync(ROLLBACK_URL, 'utf8') : null;
const CHAIN = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
  '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
  '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
  '20260920230000_access_write_enforcement.sql',
  '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
  '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql',
  '20260923010000_lifetime_gift_reservations.sql', '20260928180000_checkout_offer_switch.sql',
  '20260928190000_founding_practice_included.sql'];
const DAY = 86400000;

const text = value => `'${String(value).replaceAll("'", "''")}'`;
const lit = value => `${text(JSON.stringify(value))}::jsonb`;
const pid = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = n => `user_Rejoin${n}`;

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rejoin-after-cancel-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  const psql = input => new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', PORT, '-U', 'postgres', '-d', 'postgres'], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(input);
  });
  const sql = async statement => {
    const result = await psql(statement);
    if (result.code) throw new Error(result.stderr);
    return result.stdout;
  };
  const as = (who, statement, sub = 'user_Fixture') => psql(`begin;set local role ${who};set local request.jwt.claims=${text(JSON.stringify({ role: who, sub }))};${statement};commit;`);
  const value = async expression => {
    const result = await as('service_role', `select to_jsonb((${expression}))`);
    if (result.code) throw new Error(result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); slot.release(); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, as, value, close };
}

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${NAME}.sql is missing`);
  assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
  for (const [name, body] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(body, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
    assert.doesNotMatch(body, /[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name} names a real address`);
  }
});

test('a member who cancels can buy again on the first try; a declined card still resumes', { skip: pgSkip(), timeout: withSlotWait(240000) }, async t => {
  const db = await startPostgres();
  const { sql, as, value } = db;
  try {
    await sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;grant usage on schema auth to authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text,tax_prep jsonb);
      grant select on profiles to authenticated,service_role;
      create table fixture_continuity(profile_id uuid,current_subject text,evidence_subject text);
      create function continuity_owns_subject(pid uuid,current_subject text,evidence_subject text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from profiles p where p.id=pid and p.auth_user_id=current_subject) and (current_subject=evidence_subject or exists(select 1 from fixture_continuity f where f.profile_id=pid and f.current_subject=$2 and f.evidence_subject=$3))$$;
      create function continuity_lifetime_source(uuid,text) returns jsonb language sql stable as $$select null::jsonb$$;
      create table clerk_continuity_accounts(verified_primary_email text primary key,lifetime_eligible boolean not null);
      create table account_tombstones(profile_id uuid primary key);
      create table app_admins(profile_id uuid primary key);
      create table subscriptions(id bigserial primary key,auth_user_id text,subscription_id text,status text);
      create table documents(id uuid primary key,user_id uuid not null references profiles(id),name text,storage_path text,linked_to text);
      create table peer_references(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id));
      create table document_requests(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id));
      create schema storage;create table storage.objects(bucket_id text,name text);
      create table locum_contracts(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id),facility text);
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
    const mailbox = read('20260918a_mailbox_account_events.sql');
    const start = mailbox.indexOf('create or replace function public.account_is_closed(p_profile uuid)');
    const ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;';
    await sql(mailbox.slice(start, mailbox.indexOf(ending, start) + ending.length));
    for (const name of CHAIN) await sql(read(name));

    const promise = 'promise-rejoin@example.invalid';
    const digest = crypto.createHash('sha256').update(JSON.stringify([promise])).digest('hex');
    await value(`seal_limited_free_beta_cohort('synthetic_rejoin','${digest}',${lit([promise])},'Synthetic reviewed rejoin cohort')`);
    await value(`prepare_founding_program(true,'synthetic_rejoin','${digest}',1)`);
    await sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'");

    const enroll = async n => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(n)}','${subject(n)}','pending')`);
      await value(`bootstrap_limited_signup('${pid(n)}','${subject(n)}',true,${text(`rejoin${n}@example.invalid`)})`);
      await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(n)}',true,'cus_Rejoin${n}')`);
    };
    const preview = (n, offer) => value(`create_limited_billing_preview('${pid(n)}','${subject(n)}',true,'${offer}')`);
    const claim = (n, v) => value(`claim_limited_billing_checkout('${pid(n)}','${subject(n)}',true,'${v.offer_id}','${v.id}','${v.consent_hash}')`);
    const pinSave = async (n, c, session) => {
      const r = await as('service_role', `select pin_limited_billing_price('${c.attempt_id}','${pid(n)}','${subject(n)}',true,'prod_Rejoin','price_Rejoin');select save_billing_checkout('${pid(n)}',true,'${c.attempt_id}','${c.token}','${session}')`);
      assert.equal(r.code, 0, r.stderr);
    };
    let events = 0;
    const settle = async (n, c, { paid = true, status = 'active', subscription = `sub_Rejoin${n}` } = {}) => {
      const event = `evt_Rejoin${n}x${++events}`;
      const lease = await value(`claim_billing_reconcile('${pid(n)}',true,'cus_Rejoin${n}','${event}')`);
      const paidAt = Date.now() - DAY;
      const periodEnd = new Date(paidAt + 365 * DAY).toISOString();
      const q = c.quote;
      const args = { p_profile_id: pid(n), p_livemode: true, p_customer_id: `cus_Rejoin${n}`, p_subscription_id: subscription,
        p_offer_id: q.offer_id, p_status: status, p_period_end: periodEnd, p_event_id: event, p_event_created: 1000 + events,
        p_reconcile_token: lease.token, p_cancel_at_period_end: false, p_billing_anchor: null };
      const proof = paid ? { profileId: pid(n), clerkSubject: subject(n), livemode: true, customerId: `cus_Rejoin${n}`,
        subscriptionId: subscription, invoiceId: `in_Rejoin${n}x${events}`, pricePhase: q.price_phase, annualCents: q.annual_cents,
        paidAt: new Date(paidAt).toISOString(), periodEnd, policyVersion: q.policy_version, initial: true } : null;
      return value(`settle_limited_billing_subscription(${lit(args)},'${c.attempt_id}',${proof ? lit(proof) : 'null'})`);
    };
    const attempt = async n => JSON.parse(await sql(`select to_jsonb(a) from billing_checkout_attempts a where profile_id='${pid(n)}' and livemode`) || 'null');
    const snapshot = async n => {
      const r = await as('authenticated', 'select credentialdo_access_snapshot()', subject(n));
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    // Buy founding Credential, pay, then cancel: the member the ticket describes.
    const buyThenCancel = async n => {
      await enroll(n);
      const c = await claim(n, await preview(n, 'core'));
      assert.equal(c.state, 'claimed', JSON.stringify(c));
      assert.equal(c.quote.price_phase, 'founding');
      await pinSave(n, c, `cs_Rejoin${n}`);
      assert.equal(await settle(n, c), 'applied');
      assert.equal(await settle(n, c, { paid: false, status: 'canceled' }), 'applied');
      return c;
    };

    await t.test('the defect, before the migration: a cancelled founding member is refused every time', async () => {
      await buyThenCancel(1);
      const s = await snapshot(1);
      assert.equal(s.checkoutEligible, true, 'the app offers the standard offers again');
      assert.equal(s.pricePhase, 'standard');
      for (const offer of ['core', 'core_locum']) {
        const refused = await claim(1, await preview(1, offer));
        assert.equal(refused.state, 'offer_conflict', offer);
        assert.equal(refused.prior, undefined, `${offer}: nothing the handler could retire`);
      }
      assert.equal((await attempt(1)).state, 'open', 'the paid attempt was never closed');
    });

    assert.ok(MIGRATION, `${NAME}.sql is missing`);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice; only the service settles or claims', async () => {
      const denied = async (who, call) => { const r = await as(who, call); return r.code !== 0 && /permission denied for function/.test(r.stderr); };
      for (const who of ['anon', 'authenticated']) {
        assert.ok(await denied(who, `select settle_limited_billing_subscription('{}',gen_random_uuid(),null)`), who);
        assert.ok(await denied(who, `select claim_limited_billing_checkout('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`), who);
      }
      for (const who of ['anon', 'authenticated', 'service_role']) {
        assert.ok(await denied(who, `select settle_limited_billing_subscription_before_rejoin('{}',gen_random_uuid(),null)`), who);
        assert.ok(await denied(who, `select claim_limited_billing_checkout_before_rejoin('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`), who);
      }
    });

    await t.test('an attempt left open before the migration: the next claim closes it and claims at the current terms', async () => {
      const core = await claim(1, await preview(1, 'core'));
      assert.equal(core.state, 'claimed', JSON.stringify(core));
      assert.equal(core.quote.price_phase, 'standard');
      assert.equal(core.quote.annual_cents, 19900);
      assert.equal(core.quote.public_founding_slot, null, 'a paid founding place is not replenished');
    });

    await t.test('settling a paid subscription closes its attempt; cancel, then Credential claims first try', async () => {
      const c = await buyThenCancel(2);
      assert.equal((await attempt(2)).attempt_id, c.attempt_id);
      assert.equal((await attempt(2)).state, 'complete');
      const again = await claim(2, await preview(2, 'core'));
      assert.equal(again.state, 'claimed', JSON.stringify(again));
      assert.equal(again.quote.annual_cents, 19900);
    });

    await t.test('cancel, then Credential + Practice claims first try at $245', async () => {
      await buyThenCancel(3);
      const bundle = await claim(3, await preview(3, 'core_locum'));
      assert.equal(bundle.state, 'claimed', JSON.stringify(bundle));
      assert.equal(bundle.quote.offer_id, 'core_locum');
      assert.equal(bundle.quote.annual_cents, 24500);
    });

    await t.test('an incomplete subscription (declined card) keeps its attempt open to resume', async () => {
      await enroll(4);
      const c = await claim(4, await preview(4, 'core'));
      await pinSave(4, c, 'cs_Rejoin4');
      assert.equal(await settle(4, c, { paid: false, status: 'incomplete' }), 'applied');
      assert.equal((await attempt(4)).state, 'open');
      // Paid after all: now it closes.
      assert.equal(await settle(4, c), 'applied');
      assert.equal((await attempt(4)).state, 'complete');
    });

    await t.test('the claim never closes an attempt whose subscription is still live', async () => {
      await enroll(5);
      const c = await claim(5, await preview(5, 'core'));
      await pinSave(5, c, 'cs_Rejoin5');
      assert.equal(await settle(5, c), 'applied');
      // As if left open before the migration, subscription still active.
      await sql(`update billing_checkout_attempts set state='open' where profile_id='${pid(5)}'`);
      const refused = await claim(5, await preview(5, 'core_locum'));
      assert.notEqual(refused.state, 'claimed');
      assert.equal((await attempt(5)).state, 'open');
      assert.equal((await attempt(5)).attempt_id, c.attempt_id);
    });

    await t.test('rollback restores the previous routines, runs twice, and forward again', async () => {
      assert.ok(ROLLBACK, `${NAME}.rollback.sql is missing`);
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await sql("select to_regprocedure('public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb)') is null"), 't');
      assert.equal(await sql("select to_regprocedure('public.claim_limited_billing_checkout_before_rejoin(uuid,text,boolean,text,uuid,text)') is null"), 't');
      assert.equal(await sql("select has_function_privilege('service_role','public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text)','execute')"), 't');
      assert.equal(await sql("select has_function_privilege('authenticated','public.settle_limited_billing_subscription(jsonb,uuid,jsonb)','execute')"), 'f');
      await sql(MIGRATION);
      assert.equal(await sql("select to_regprocedure('public.settle_limited_billing_subscription_before_rejoin(jsonb,uuid,jsonb)') is not null"), 't');
    });
  } finally {
    await db.close();
  }
});
