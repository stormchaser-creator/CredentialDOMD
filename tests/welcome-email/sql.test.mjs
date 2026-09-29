// The welcome email after a paid purchase (20260929130000_welcome_email.sql),
// proven on a real PostgreSQL with the actual billing, access, signup,
// deferred-beta, founding cap, lifetime-gift, checkout-switch and founding
// Practice migrations underneath it, then the migration applied twice.
//
// Owner decision, 2026-09-29: after someone pays, send our own short welcome
// email; the owner approves the exact wording in the app before it goes live;
// once per purchase; never for gifts or free betas. Purchases here are
// settled through the real settle_limited_billing_subscription, as the
// webhook does, and the claim is made with the fingerprint of the real
// content module.
//
// Synthetic identities, customers, invoices and sessions only; no provider
// request, network listener, credential or production row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';
import { welcomeEmailFingerprint, WELCOME_EMAIL_VERSION } from '../../src/utils/welcomeEmail.js';
import { createWelcomeEmailSender, welcomeIdempotencyKey } from '../../supabase/functions/_shared/welcomeEmailSender.mjs';

// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58961';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATION = read('20260929130000_welcome_email.sql');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260929130000_welcome_email.rollback.sql', import.meta.url), 'utf8');
const CHAIN = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
  '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
  '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
  '20260920230000_access_write_enforcement.sql',
  '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
  '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql',
  '20260923010000_lifetime_gift_reservations.sql', '20260928180000_checkout_offer_switch.sql',
  '20260928190000_founding_practice_included.sql'];
const FUNCTIONS = ['welcome_email_claim(text,boolean,text)', 'welcome_email_finish(text,boolean,integer,text,text,text)',
  'admin_welcome_email_status()', 'admin_set_welcome_email(boolean,text,text)'];

const DAY = 86400000;
const text = value => `'${String(value).replaceAll("'", "''")}'`;
const lit = value => `${text(JSON.stringify(value))}::jsonb`;
const pid = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = n => `user_Welcome${n}`;
const ADMIN = { id: '70000000-0000-4000-8000-00000000a001', sub: 'user_WelcomeOwner' };
const MEMBER = { id: '70000000-0000-4000-8000-00000000a002', sub: 'user_WelcomeMember' };

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-email-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
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
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, as, value, close };
}

test('the welcome email: off until the owner approves the exact content, then once per paid purchase', { skip: pgSkip(), timeout: 240000 }, async t => {
  const db = await startPostgres();
  const { sql, as, value } = db;
  try {
    await sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;grant usage on schema auth to authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text,tax_prep jsonb,verified_email text);
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
      alter table locum_contracts enable row level security;
      -- The production definition (pg_get_functiondef, 2026-09-29).
      create function public.current_profile_id() returns uuid language sql stable security definer set search_path=public as $$select id from profiles where auth_user_id=(auth.jwt()->>'sub') limit 1$$;
      -- Supabase's public-schema default privileges, which the migration must undo.
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
    const mailbox = read('20260918a_mailbox_account_events.sql');
    const start = mailbox.indexOf('create or replace function public.account_is_closed(p_profile uuid)');
    const ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;';
    await sql(mailbox.slice(start, mailbox.indexOf(ending, start) + ending.length));
    // The administrator check every admin control uses, from its real migration.
    const operations = read('20260924020000_admin_operations.sql');
    const actor = operations.match(/create or replace function public\.admin_operations_actor\(\)[\s\S]*?\n\$\$;\nrevoke all on function public\.admin_operations_actor\(\)[^\n]*\n/);
    assert.ok(actor, 'admin_operations_actor moved; read it from its migration again');
    await sql(actor[0]);
    for (const name of CHAIN) await sql(read(name));
    await sql(`insert into profiles(id,auth_user_id,access_status,name) values('${ADMIN.id}','${ADMIN.sub}','active','Synthetic Owner'),('${MEMBER.id}','${MEMBER.sub}','active','Synthetic Member');
      insert into app_admins values('${ADMIN.id}')`);
    const promise = 'promise-welcome@example.invalid';
    const digest = crypto.createHash('sha256').update(JSON.stringify([promise])).digest('hex');
    await value(`seal_limited_free_beta_cohort('synthetic_welcome','${digest}',${lit([promise])},'Synthetic reviewed welcome cohort')`);
    await value(`prepare_founding_program(true,'synthetic_welcome','${digest}',1)`);
    await sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'");

    await sql(MIGRATION);
    const definitions = async () => sql(`select string_agg(pg_get_functiondef(oid),'' order by oid) from pg_proc where proname in ('welcome_email_claim','welcome_email_finish','admin_welcome_email_status','admin_set_welcome_email')`);
    const once = await definitions();
    await sql(MIGRATION);

    const fingerprint = await welcomeEmailFingerprint();
    const other = 'f'.repeat(64);
    const phase = name => sql(`update access_policy_settings set limited_self_service_price_phase='${name}'`);
    const enroll = async (n, { name = `Member${n} Synthetic`, verified = `welcome${n}@example.invalid`, email = `welcome${n}@example.invalid` } = {}) => {
      await sql(`insert into profiles(id,auth_user_id,access_status,name,verified_email) values('${pid(n)}','${subject(n)}','pending',${text(name)},${verified ? text(verified) : 'null'})`);
      await value(`bootstrap_limited_signup('${pid(n)}','${subject(n)}',true,${text(email)})`);
      await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(n)}',true,'cus_Welcome${n}')`);
    };
    let events = 0;
    const settle = async (n, c, { paid = true, status = 'active', paidAt = Date.now(), invoice = `in_Welcome${n}`, initial = true } = {}) => {
      const event = `evt_Welcome${n}x${++events}`;
      const lease = await value(`claim_billing_reconcile('${pid(n)}',true,'cus_Welcome${n}','${event}')`);
      const periodEnd = new Date(paidAt + 365 * DAY).toISOString();
      const q = c.quote;
      const args = { p_profile_id: pid(n), p_livemode: true, p_customer_id: `cus_Welcome${n}`, p_subscription_id: `sub_Welcome${n}`,
        p_offer_id: q.offer_id, p_status: status, p_period_end: periodEnd, p_event_id: event, p_event_created: 1000 + events,
        p_reconcile_token: lease.token, p_cancel_at_period_end: false, p_billing_anchor: null };
      const proof = paid ? { profileId: pid(n), clerkSubject: subject(n), livemode: true, customerId: `cus_Welcome${n}`,
        subscriptionId: `sub_Welcome${n}`, invoiceId: invoice, pricePhase: q.price_phase, annualCents: q.annual_cents,
        paidAt: new Date(paidAt).toISOString(), periodEnd, policyVersion: q.policy_version, initial } : null;
      return value(`settle_limited_billing_subscription(${lit(args)},'${c.attempt_id}',${proof ? lit(proof) : 'null'})`);
    };
    const buy = async (n, offer, options) => {
      const v = await value(`create_limited_billing_preview('${pid(n)}','${subject(n)}',true,'${offer}')`);
      const c = await value(`claim_limited_billing_checkout('${pid(n)}','${subject(n)}',true,'${v.offer_id}','${v.id}','${v.consent_hash}')`);
      assert.equal(c.state, 'claimed', JSON.stringify(c));
      const saved = await as('service_role', `select pin_limited_billing_price('${c.attempt_id}','${pid(n)}','${subject(n)}',true,'prod_Welcome','price_Welcome');select save_billing_checkout('${pid(n)}',true,'${c.attempt_id}','${c.token}','cs_Welcome${n}')`);
      assert.equal(saved.code, 0, saved.stderr);
      assert.equal(await settle(n, c, options), 'applied');
      return c;
    };
    const claim = (n, fp = fingerprint) => value(`welcome_email_claim('sub_Welcome${n}',true,'${fp}')`);
    const finish = (n, attempt, status, provider = null, code = null) =>
      value(`welcome_email_finish('sub_Welcome${n}',true,${attempt},'${status}',${provider ? text(provider) : 'null'},${code ? text(code) : 'null'})`);
    const ledger = n => sql(`select coalesce((select status||':'||attempts||':'||variant from welcome_email_sends where subscription_id='sub_Welcome${n}'),'none')`);
    const sends = () => sql('select count(*) from welcome_email_sends').then(Number);
    const approve = (on, fp = fingerprint, who = ADMIN.sub) => as('authenticated', `select admin_set_welcome_email(${on},${fp ? `'${fp}'` : 'null'},'${WELCOME_EMAIL_VERSION}')`, who);
    const status = async () => { const r = await as('authenticated', 'select admin_welcome_email_status()', ADMIN.sub); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };

    await t.test('applies twice; off by default; only the service role claims and only administrators approve', async () => {
      assert.equal(await definitions(), once, 'stable on a second apply');
      assert.deepEqual(JSON.parse(await sql("select to_jsonb(s)-'updated_at' from welcome_email_settings s")),
        { enabled: false, singleton: true, approved_at: null, approved_by: null, approved_version: null, approved_fingerprint: null });
      assert.equal(await sql('select count(*) from welcome_email_settings'), '1');
      const denied = async (who, call, sub) => { const r = await as(who, call, sub); return r.code !== 0 && /permission denied/.test(r.stderr); };
      for (const who of ['anon', 'authenticated']) {
        assert.ok(await denied(who, `select welcome_email_claim('sub_X',true,'${fingerprint}')`, ADMIN.sub), `${who} cannot claim`);
        assert.ok(await denied(who, "select welcome_email_finish('sub_X',true,1,'sent','re_1',null)", ADMIN.sub), `${who} cannot finish`);
        for (const [table, write] of [['welcome_email_settings', 'update welcome_email_settings set enabled=true'],
          ['welcome_email_sends', "delete from welcome_email_sends"], ['welcome_email_approvals', "insert into welcome_email_approvals(actor_profile_id,action) values(gen_random_uuid(),'turn_off')"]]) {
          assert.ok(await denied(who, `select * from ${table}`, ADMIN.sub), `${who} cannot read ${table}`);
          assert.ok(await denied(who, write, ADMIN.sub), `${who} cannot write ${table}`);
        }
      }
      for (const who of ['anon', 'service_role']) {
        assert.ok(await denied(who, `select admin_set_welcome_email(true,'${fingerprint}','${WELCOME_EMAIL_VERSION}')`), `${who} cannot approve`);
        assert.ok(await denied(who, 'select admin_welcome_email_status()'), `${who} cannot read the admin status`);
      }
      const member = await approve(true, fingerprint, MEMBER.sub);
      assert.notEqual(member.code, 0);
      assert.match(member.stderr, /Administrator access required/, 'a signed-in member who is not an administrator is refused');
      const memberStatus = await as('authenticated', 'select admin_welcome_email_status()', MEMBER.sub);
      assert.match(memberStatus.stderr, /Administrator access required/);
      assert.equal(await sql('select enabled from welcome_email_settings'), 'f');
      assert.equal(await sql('select count(*) from welcome_email_approvals'), '0');
      for (const fn of FUNCTIONS) {
        const acl = await sql(`select proacl::text from pg_proc where oid='public.${fn}'::regprocedure`);
        assert.ok(!/(^|[{,])(anon|=)/.test(acl), `${fn} is not executable by PUBLIC or anon: ${acl}`);
        assert.equal(/authenticated=/.test(acl), fn.startsWith('admin_'), `${fn}: ${acl}`);
        assert.equal(/service_role=/.test(acl), !fn.startsWith('admin_'), `${fn}: ${acl}`);
      }
    });

    await t.test('never when disabled: a paid purchase settles and nothing is claimed or recorded', async () => {
      await enroll(1);
      await buy(1, 'core');
      assert.equal(await sql(`select count(*) from limited_paid_purchase_history where subscription_id='sub_Welcome1'`), '1');
      assert.deepEqual(await claim(1), { state: 'disabled' });
      assert.equal(await sends(), 0);
    });

    await t.test('an administrator approves the exact content; approving again records nothing new', async () => {
      const bad = await approve(true, 'not-a-fingerprint');
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /exact email content to approve is required/);
      const missing = await as('authenticated', 'select admin_set_welcome_email(true,null,null)', ADMIN.sub);
      assert.match(missing.stderr, /exact email content to approve is required/);
      const r = await approve(true);
      assert.equal(r.code, 0, r.stderr);
      const s = JSON.parse(r.stdout);
      assert.equal(s.enabled, true);
      assert.equal(s.approvedFingerprint, fingerprint);
      assert.equal(s.approvedVersion, WELCOME_EMAIL_VERSION);
      assert.equal(s.approvedBy, 'Synthetic Owner');
      const at = s.approvedAt;
      assert.equal((await approve(true)).code, 0);
      const again = await status();
      assert.equal(again.approvedAt, at, 'a repeated approval does not move the approval time');
      assert.equal(again.history.length, 1);
      assert.deepEqual(again.history.map(h => [h.action, h.fingerprint, h.version, h.by]), [['approve', fingerprint, WELCOME_EMAIL_VERSION, 'Synthetic Owner']]);
    });

    await t.test('a purchase paid before the approval never gets one', async () => {
      assert.deepEqual(await claim(1), { state: 'before_approval' });
      assert.equal(await sends(), 0);
    });

    await t.test('content that is not the approved content sends nothing', async () => {
      await enroll(2, { name: 'Dr. Jordan Rivera, MD' });
      await buy(2, 'core');
      assert.deepEqual(await claim(2, other), { state: 'not_approved' });
      assert.equal(await sends(), 0);
    });

    await t.test('sends once on settlement when enabled: claimed once, in flight, sent, then never again', async () => {
      const first = await claim(2);
      assert.deepEqual(first, { state: 'claimed', attempt: 1, variant: 'founding', profile_id: pid(2), clerk_subject: subject(2),
        name: 'Dr. Jordan Rivera, MD', verified_email: 'welcome2@example.invalid' });
      assert.equal(await ledger(2), 'sending:1:founding', 'recorded before anything is mailed');
      assert.deepEqual(await claim(2), { state: 'in_progress' }, 'a second webhook event meanwhile does not send');
      assert.equal(await finish(2, 1, 'sent', 're_synthetic_2'), 'recorded');
      assert.equal(await ledger(2), 'sent:1:founding');
      assert.equal(await sql(`select sent_at is not null and provider_id='re_synthetic_2' from welcome_email_sends where subscription_id='sub_Welcome2'`), 't');
      assert.deepEqual(await claim(2), { state: 'already_sent' });
      assert.equal(await finish(2, 1, 'failed', null, 'provider_500'), 'stale', 'a late outcome cannot overwrite a send');
      assert.equal(await ledger(2), 'sent:1:founding');
      // A renewal a year on carries a verified payment too: still the one welcome.
      const c2 = { quote: await value(`(select to_jsonb(q) from limited_billing_quotes q where profile_id='${pid(2)}')`) };
      c2.attempt_id = c2.quote.attempt_id;
      assert.equal(await settle(2, c2, { invoice: 'in_Welcome2Renewal', initial: false }), 'applied');
      assert.deepEqual(await claim(2), { state: 'already_sent' });
      const bad = await as('service_role', "select welcome_email_finish('sub_Welcome2',true,1,'sent',null,null)");
      assert.match(bad.stderr, /invalid welcome email outcome/, 'a send needs its provider id');
    });

    await t.test('the real sender, against this database, mails once with the purchase idempotency key', async () => {
      await enroll(3, { name: 'jordan', verified: null });
      await buy(3, 'core');
      const deliveries = [];
      const sender = createWelcomeEmailSender({
        store: {
          claimWelcome: (s, l, f) => value(`welcome_email_claim(${text(s)},${l},${text(f)})`),
          finishWelcome: (s, l, a, st, p, c) => value(`welcome_email_finish(${text(s)},${l},${a},${text(st)},${p ? text(p) : 'null'},${c ? text(c) : 'null'})`),
        },
        // No verified_email on this profile: the provider's verified primary.
        recipient: async claimed => claimed.verified_email || 'primary3@example.invalid',
        deliver: async message => { deliveries.push(message); return { status: 'sent', providerId: 're_synthetic_3' }; },
      });
      assert.deepEqual(await sender({ subscriptionId: 'sub_Welcome3', livemode: true }), { state: 'sent' });
      assert.deepEqual(await sender({ subscriptionId: 'sub_Welcome3', livemode: true }), { state: 'already_sent' });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].to, 'primary3@example.invalid');
      assert.equal(deliveries[0].idempotencyKey, welcomeIdempotencyKey('sub_Welcome3', true));
      assert.match(deliveries[0].text, /^Hi Jordan,\n\nWelcome to CredentialDOMD\. Thank you for becoming a founding member\./);
      assert.equal(await ledger(3), 'sent:1:founding');
    });

    await t.test('content per offer: founding, the early bird and standard trial, the bundle, and Credential without a trial', async () => {
      await phase('earlybird');
      try {
        await enroll(4); await buy(4, 'core');
        await enroll(5); await buy(5, 'core_locum');
        // A member whose account already used its one Practice trial.
        await enroll(6);
        await sql(`insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at,ends_at) values('${pid(6)}','${subject(6)}',true,'practice','trial','in_EarlierPurchase',now()-interval '400 days',now()-interval '400 days'+interval '720 hours')`);
        await buy(6, 'core');
      } finally { await phase('founding'); }
      await phase('standard');
      try { await enroll(7); await buy(7, 'core'); } finally { await phase('founding'); }
      assert.deepEqual([(await claim(4)).variant, (await claim(5)).variant, (await claim(6)).variant, (await claim(7)).variant], ['trial', 'bundle', 'credential', 'trial']);
      assert.equal(await sql("select string_agg(subscription_id||'='||variant, ',' order by subscription_id) from welcome_email_sends where subscription_id in ('sub_Welcome4','sub_Welcome5','sub_Welcome6','sub_Welcome7')"),
        'sub_Welcome4=trial,sub_Welcome5=bundle,sub_Welcome6=credential,sub_Welcome7=trial');
      assert.equal(await sql("select string_agg(offer_id||':'||price_phase, ',' order by subscription_id) from limited_paid_purchase_history where subscription_id in ('sub_Welcome4','sub_Welcome5','sub_Welcome6','sub_Welcome7')"),
        'core:earlybird,core_locum:standard,core:earlybird,core:standard');
    });

    await t.test('a failed or lost attempt retries within limits, never past the provider key', async () => {
      assert.equal(await finish(4, 1, 'failed', null, 'recipient_unavailable'), 'recorded');
      assert.deepEqual(await claim(4), { state: 'claimed', attempt: 2, variant: 'trial', profile_id: pid(4), clerk_subject: subject(4), name: 'Member4 Synthetic', verified_email: 'welcome4@example.invalid' });
      assert.equal(await finish(4, 1, 'sent', 're_late'), 'stale', 'an outcome for an older attempt is ignored');
      assert.equal(await finish(4, 2, 'unknown', null, 'provider_500'), 'recorded');
      for (const attempt of [3, 4, 5]) {
        assert.equal((await claim(4)).attempt, attempt);
        assert.equal(await finish(4, attempt, 'failed', null, 'provider_422'), 'recorded');
      }
      assert.deepEqual(await claim(4), { state: 'gave_up' });
      // A claim whose outcome was never recorded (the function died): in
      // flight for ten minutes, then retried under the same provider key.
      await sql("update welcome_email_sends set updated_at=clock_timestamp()-interval '11 minutes' where subscription_id='sub_Welcome5'");
      assert.equal((await claim(5)).attempt, 2);
      await sql("update welcome_email_sends set status='failed',error_code='provider_500',created_at=clock_timestamp()-interval '24 hours' where subscription_id='sub_Welcome5'");
      assert.deepEqual(await claim(5), { state: 'gave_up' }, 'past 23 hours the provider key may have expired');
    });

    await t.test('never for gifts or free betas, never late, and never for an account or subscription that is not active', async () => {
      // A gift or a no-card beta has no verified paid purchase at all, so
      // there is nothing to claim: the ledger is keyed by a paid purchase.
      await sql(`insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) values('${MEMBER.id}','${MEMBER.sub}',true,'credential','lifetime','synthetic_gift',now())`);
      await enroll(20, { email: promise });
      assert.equal(await sql(`select count(*) from limited_beta_grants where profile_id='${pid(20)}' and revoked_at is null and ends_at>now()`), '1', 'a reviewed no-card beta holder');
      assert.equal(await sql(`select count(*) from limited_paid_purchase_history where profile_id in ('${pid(20)}','${MEMBER.id}')`), '0');
      assert.deepEqual(await claim(20), { state: 'no_purchase' });
      assert.deepEqual(await claim(99), { state: 'no_purchase' });
      // Belt and braces for a paying account that also holds either.
      for (const n of [8, 9, 10, 11, 12]) { await enroll(n); await buy(n, 'core'); }
      await sql(`insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) values('${pid(8)}','${subject(8)}',true,'credential','lifetime','synthetic_gift',now())`);
      assert.deepEqual(await claim(8), { state: 'gift' });
      await sql(`insert into limited_beta_grants(profile_id,clerk_subject,livemode,invitation_id,starts_at,ends_at)
        select profile_id,clerk_subject,true,invitation_id,now()-interval '1 day',now()-interval '1 day'+interval '720 hours' from limited_billing_quotes where profile_id='${pid(9)}'`);
      assert.deepEqual(await claim(9), { state: 'free_beta' });
      await sql(`update billing_subscriptions set status='canceled',membership_active=false where profile_id='${pid(10)}'`);
      assert.deepEqual(await claim(10), { state: 'not_active' }, 'refunded or canceled at once');
      await sql(`update profiles set access_status='revoked' where id='${pid(11)}'`);
      assert.deepEqual(await claim(11), { state: 'account_unavailable' });
      // Paid more than 72 hours ago, though after the approval.
      await sql("update welcome_email_settings set approved_at=clock_timestamp()-interval '10 days'");
      await sql(`update limited_paid_purchase_history set first_verified_paid_at=clock_timestamp()-interval '73 hours' where profile_id='${pid(12)}'`);
      assert.deepEqual(await claim(12), { state: 'too_late' });
      assert.equal(await sql(`select count(*) from welcome_email_sends where profile_id in ('${pid(8)}','${pid(9)}','${pid(10)}','${pid(11)}','${pid(12)}','${pid(20)}','${MEMBER.id}')`), '0');
      const bad = await as('service_role', `select welcome_email_claim('not a subscription',true,'${fingerprint}')`);
      assert.match(bad.stderr, /invalid welcome email claim/);
    });

    await t.test('turning it off stops the next claim; turning it on again is a new approval', async () => {
      await enroll(13); await buy(13, 'core');
      const off = await approve(false, null);
      assert.equal(off.code, 0, off.stderr);
      assert.equal(JSON.parse(off.stdout).enabled, false);
      assert.deepEqual(await claim(13), { state: 'disabled' });
      assert.equal(await ledger(13), 'none');
      assert.equal((await approve(false, null)).code, 0);
      const s = await status();
      assert.deepEqual(s.history.map(h => h.action), ['turn_off', 'approve'], 'turning off twice records once');
      assert.equal(s.approvedFingerprint, fingerprint, 'the last approval stays on record');
      assert.equal((await approve(true)).code, 0);
      assert.deepEqual(await claim(13), { state: 'before_approval' }, 'paid while it was off');
      const on = await status();
      assert.deepEqual(on.history.map(h => h.action), ['approve', 'turn_off', 'approve']);
      assert.equal(on.sent, 2);
      assert.ok(on.notSent >= 4);
    });

    await t.test('rollback removes the switch and the functions, keeps the record, and re-applying starts off', async () => {
      const kept = await sql('select count(*) from welcome_email_sends');
      await sql(`begin;${ROLLBACK};commit;`);
      await sql(ROLLBACK);
      for (const fn of FUNCTIONS) assert.equal(await sql(`select to_regprocedure('public.${fn}') is null`), 't', fn);
      assert.equal(await sql("select to_regclass('public.welcome_email_settings') is null"), 't');
      assert.equal(await sql('select count(*) from welcome_email_sends'), kept);
      await sql(MIGRATION);
      assert.equal(await sql('select enabled from welcome_email_settings'), 'f');
      assert.deepEqual(await claim(13), { state: 'disabled' });
    });
  } finally { await db.close(); }
});
