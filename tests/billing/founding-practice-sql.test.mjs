// Founding members keep Practice while they are members
// (20260928190000_founding_practice_included.sql), proven on a real
// PostgreSQL with the actual billing, access, write-enforcement, signup,
// deferred-beta, founding cap, lifetime-gift and checkout-switch migrations
// underneath it, then the migration applied twice.
//
// Owner decision, 2026-09-28: "$99 founding members get Practice free while a
// member." Before it, a $99 founding Credential purchase started one 30-day
// Practice trial and Practice then went read-only. Early-bird and standard
// keep that trial; the $245 bundle, lifetime and the no-card beta are
// unchanged; the bundle is not offered to any buyer (public signup, reviewed
// invitation or no-card beta holder) while their own offer is founding.
//
// Synthetic identities, customers, invoices and sessions only; no provider
// request, network listener, credential or production row. The
// provider-backed identity-continuity helpers are the same explicit stubs the
// other billing suites use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip, acquirePgSlot } from '../credential-portal/postgresFixture.mjs';

// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58951';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATION = read('20260928190000_founding_practice_included.sql');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260928190000_founding_practice_included.rollback.sql', import.meta.url), 'utf8');
const CHAIN = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
  '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
  '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
  '20260920230000_access_write_enforcement.sql',
  '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
  '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql',
  '20260923010000_lifetime_gift_reservations.sql', '20260928180000_checkout_offer_switch.sql'];
// Every routine the migration edits or wraps, by the name callers use.
const TOUCHED = ['record_credential_purchase_trial(jsonb)', 'credentialdo_profile_scope_write_allowed(uuid,text,text)',
  'credentialdo_access_snapshot()', 'limited_billing_eligibility(uuid,text,boolean)', 'create_limited_billing_preview(uuid,text,boolean,text)',
  'claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)', 'limited_deferred_checkout_resume(uuid,text,boolean,text)',
  'claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text)', 'public_membership_offer()'];
const PRIVATE = ['limited_billing_eligibility_before_practice(uuid,text,boolean)', 'create_limited_billing_preview_before_practice(uuid,text,boolean,text)',
  'claim_limited_billing_checkout_before_practice(uuid,text,boolean,text,uuid,text)', 'credentialdo_founding_practice(uuid,text,boolean)'];

const V2 = '2026-09-21-explicit-annual-opt-in-v2';
const V3 = '2026-09-28-explicit-annual-opt-in-v3';
const TRIAL = ' Includes one 30-day Practice feature trial beginning with your first verified payment. Practice does not auto-charge or upgrade; after expiry, your saved Practice records remain readable and exportable.';
const INCLUDED = ' Includes Practice for as long as this membership remains active.';
const immediate = dollars => `Credential: USD ${dollars} due now, then USD ${dollars} each year while this subscription remains active. Cancel before a scheduled charge to avoid it.`;
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const DAY = 86400000;

const text = value => `'${String(value).replaceAll("'", "''")}'`;
const lit = value => `${text(JSON.stringify(value))}::jsonb`;
const pid = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = n => `user_Practice${n}`;

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'founding-practice-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  const slot = await acquirePgSlot(path.join(root, 'data'));
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${PORT} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  // A script on stdin, as the Python suites send it: each call is one session.
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

test('founding Credential includes Practice while the membership is active; early-bird and standard keep the trial', { skip: pgSkip(), timeout: 240000 }, async t => {
  const db = await startPostgres();
  const { sql, as, value } = db;
  try {
    await sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;grant usage on schema auth to authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text,tax_prep jsonb);
      grant select on profiles to authenticated,service_role;
      grant update(tax_prep) on profiles to authenticated;
      create table fixture_continuity(profile_id uuid,current_subject text,evidence_subject text);
      create function continuity_owns_subject(pid uuid,current_subject text,evidence_subject text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from profiles p where p.id=pid and p.auth_user_id=current_subject) and (current_subject=evidence_subject or exists(select 1 from fixture_continuity f where f.profile_id=pid and f.current_subject=$2 and f.evidence_subject=$3))$$;
      create function continuity_lifetime_source(uuid,text) returns jsonb language sql stable as $$select null::jsonb$$;
      create table clerk_continuity_accounts(verified_primary_email text primary key,lifetime_eligible boolean not null);
      create table account_tombstones(profile_id uuid primary key);
      create table app_admins(profile_id uuid primary key);
      create table subscriptions(id bigserial primary key,auth_user_id text,subscription_id text,status text);
      -- The tables the write rules guard, trimmed to the columns those rules read.
      create table documents(id uuid primary key,user_id uuid not null references profiles(id),name text,storage_path text,linked_to text);
      create table peer_references(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id));
      create table document_requests(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id));
      create schema storage;create table storage.objects(bucket_id text,name text);
      -- A Practice collection with its owner policy, as production has; the
      -- access migrations add their restrictive write policies to it.
      create table locum_contracts(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id),facility text);
      alter table locum_contracts enable row level security;
      create policy owner_rows on locum_contracts for all to authenticated
        using(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'))
        with check(user_id=(select id from profiles where auth_user_id=auth.jwt()->>'sub'));
      grant select,insert on locum_contracts to authenticated;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
    const mailbox = read('20260918a_mailbox_account_events.sql');
    const start = mailbox.indexOf('create or replace function public.account_is_closed(p_profile uuid)');
    const ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;';
    await sql(mailbox.slice(start, mailbox.indexOf(ending, start) + ending.length));
    for (const name of CHAIN) await sql(read(name));

    const definition = name => sql(`select pg_get_functiondef('${name}'::regprocedure)`);
    const acl = name => sql(`select proacl::text from pg_proc where oid='${name}'::regprocedure`);
    const exists = name => sql(`select to_regprocedure('public.${name}') is not null`).then(r => r === 't');
    const before = {};
    for (const name of TOUCHED) before[name] = { body: await definition(name), acl: await acl(name) };

    // One reviewed promise (a historical no-card beta holder), then public
    // founding checkout exactly as launched.
    const promise = 'promise-practice@example.invalid';
    const manifest = JSON.stringify([promise]);
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    await value(`seal_limited_free_beta_cohort('synthetic_practice','${digest}',${lit([promise])},'Synthetic reviewed practice cohort')`);
    assert.deepEqual(await value(`prepare_founding_program(true,'synthetic_practice','${digest}',1)`), { state: 'prepared', promised: 1, capacity: 100 });
    await sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'");

    const gates = 'select to_jsonb(s) from access_policy_settings s';
    const gatesBefore = await sql(gates);
    await sql(MIGRATION);
    const once = {};
    for (const name of TOUCHED) once[name] = await definition(name);
    await sql(MIGRATION);

    const phase = name => sql(`update access_policy_settings set limited_self_service_price_phase='${name}'`);
    const enroll = async (n, email = `practice${n}@example.invalid`) => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(n)}','${subject(n)}','pending')`);
      const result = await value(`bootstrap_limited_signup('${pid(n)}','${subject(n)}',true,${text(email)})`);
      await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(n)}',true,'cus_Practice${n}')`);
      return result;
    };
    const preview = (n, offer) => value(`create_limited_billing_preview('${pid(n)}','${subject(n)}',true,'${offer}')`);
    // What the reviewed body alone makes: a preview from before this migration.
    const oldPreview = async (n, offer) => JSON.parse(await sql(`select create_limited_billing_preview_before_practice('${pid(n)}','${subject(n)}',true,'${offer}')`));
    const claim = (n, v) => value(`claim_limited_billing_checkout('${pid(n)}','${subject(n)}',true,'${v.offer_id}','${v.id}','${v.consent_hash}')`);
    const pinSave = async (n, c, session = `cs_Practice${n}`) => {
      const r = await as('service_role', `select pin_limited_billing_price('${c.attempt_id}','${pid(n)}','${subject(n)}',true,'prod_Practice','price_Practice');select save_billing_checkout('${pid(n)}',true,'${c.attempt_id}','${c.token}','${session}')`);
      assert.equal(r.code, 0, r.stderr);
    };
    // One verified Stripe event, settled as the webhook does. paidDaysAgo
    // backdates the first payment so a 30-day trial can be seen expired.
    // A later event for the same subscription carries the same first invoice.
    let events = 0;
    const firstPaid = new Map();
    const settle = async (n, c, { paid = true, status = 'active', cancel = false, paidDaysAgo = 0 } = {}) => {
      const event = `evt_Practice${n}x${++events}`;
      const lease = await value(`claim_billing_reconcile('${pid(n)}',true,'cus_Practice${n}','${event}')`);
      if (!firstPaid.has(n)) firstPaid.set(n, Date.now() - paidDaysAgo * DAY);
      const paidAt = firstPaid.get(n);
      const periodEnd = new Date(paidAt + 365 * DAY).toISOString();
      const q = c.quote;
      const args = { p_profile_id: pid(n), p_livemode: true, p_customer_id: `cus_Practice${n}`, p_subscription_id: `sub_Practice${n}`,
        p_offer_id: q.offer_id, p_status: status, p_period_end: periodEnd, p_event_id: event, p_event_created: 1000 + events,
        p_reconcile_token: lease.token, p_cancel_at_period_end: cancel, p_billing_anchor: null };
      const proof = paid ? { profileId: pid(n), clerkSubject: subject(n), livemode: true, customerId: `cus_Practice${n}`,
        subscriptionId: `sub_Practice${n}`, invoiceId: `in_Practice${n}`, pricePhase: q.price_phase, annualCents: q.annual_cents,
        paidAt: new Date(paidAt).toISOString(), periodEnd, policyVersion: q.policy_version, initial: true } : null;
      return value(`settle_limited_billing_subscription(${lit(args)},'${c.attempt_id}',${proof ? lit(proof) : 'null'})`);
    };
    const buy = async (n, offer, options) => {
      const v = await preview(n, offer);
      const c = await claim(n, v);
      assert.equal(c.state, 'claimed', JSON.stringify(c));
      await pinSave(n, c);
      assert.equal(await settle(n, c, options), 'applied');
      return { v, c };
    };
    const snapshot = async n => {
      const r = await as('authenticated', 'select credentialdo_access_snapshot()', subject(n));
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    // The database write rule documents, storage, intake and tax_prep use.
    const writeRule = n => value(`credentialdo_service_write_snapshot('${pid(n)}','${subject(n)}')`);
    // Real authenticated writes: a Practice row, and the Practice tax_prep field.
    const practiceWrites = async n => {
      const row = await as('authenticated', `insert into locum_contracts(user_id,facility) values('${pid(n)}','Synthetic Hospital')`, subject(n));
      const tax = await as('authenticated', `update profiles set tax_prep=jsonb_build_object('n',${events}) where id='${pid(n)}'`, subject(n));
      return { row: row.code === 0, tax: tax.code === 0, errors: row.stderr + tax.stderr };
    };
    const trials = n => sql(`select count(*) from access_grants where profile_id='${pid(n)}' and kind='trial'`).then(Number);

    await t.test('applies twice, changes no gate, and only the service calls the new routines', async () => {
      assert.equal(await sql(gates), gatesBefore);
      for (const name of TOUCHED) assert.equal(await definition(name), once[name], `${name} is stable on a second apply`);
      for (const name of TOUCHED) assert.equal(await acl(name), before[name].acl, `${name} keeps its grant`);
      const denied = async (who, call) => { const r = await as(who, call); return r.code !== 0 && /permission denied for function/.test(r.stderr); };
      const calls = {
        eligibility: `select limited_billing_eligibility('${pid(1)}','${subject(1)}',true)`,
        preview: `select create_limited_billing_preview('${pid(1)}','${subject(1)}',true,'core')`,
        claim: `select claim_limited_billing_checkout('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`,
      };
      for (const who of ['anon', 'authenticated']) for (const call of Object.values(calls)) assert.ok(await denied(who, call), `${who}: ${call}`);
      for (const who of ['anon', 'authenticated', 'service_role']) {
        assert.ok(await denied(who, `select credentialdo_founding_practice('${pid(1)}','sub_X',true)`), who);
        assert.ok(await denied(who, `select limited_billing_eligibility_before_practice('${pid(1)}','${subject(1)}',true)`), who);
        assert.ok(await denied(who, `select create_limited_billing_preview_before_practice('${pid(1)}','${subject(1)}',true,'core')`), who);
        assert.ok(await denied(who, `select claim_limited_billing_checkout_before_practice('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`), who);
      }
    });

    await t.test('founding consent: the trial sentences become "Includes Practice for as long as this membership remains active." under v3', async () => {
      await enroll(1);
      const old = await oldPreview(1, 'core');
      assert.equal(old.consent_version, V2);
      assert.equal(old.consent_text, immediate(99) + TRIAL, 'before');
      const v = await preview(1, 'core');
      assert.equal(v.price_phase, 'founding');
      assert.equal(v.annual_cents, 9900);
      assert.equal(v.consent_version, V3);
      assert.equal(v.consent_text, immediate(99) + INCLUDED, 'after');
      assert.equal(v.consent_hash, sha256(v.consent_text), 'the hash is still sha256 of the text');
      assert.equal(await sql(`select consent_text||'|'||consent_hash||'|'||consent_version from limited_billing_previews where id='${v.id}'`),
        `${v.consent_text}|${v.consent_hash}|${V3}`, 'what is stored is what was shown');
      assert.equal((await claim(1, old)).state, 'quote_expired', 'a founding consent that still promises a trial is refused');
    });

    await t.test('a founding member keeps Practice write beyond 30 days; no trial clock is recorded', async () => {
      const { c } = await buy(1, 'core', { paidDaysAgo: 40 });
      assert.equal(c.quote.price_phase, 'founding');
      const s = await snapshot(1);
      assert.equal(s.purchasedOfferId, 'core');
      assert.equal(s.practiceIncluded, true);
      assert.deepEqual(s.practiceTrial, { state: 'none', startsAt: null, endsAt: null, autoCharges: false });
      assert.deepEqual(s.capabilities, { credential: { read: true, write: true, export: true }, practice: { read: true, write: true, export: true } });
      assert.deepEqual(await writeRule(1), { enforcementEnabled: true, credential: true, practice: true });
      const writes = await practiceWrites(1);
      assert.ok(writes.row && writes.tax, writes.errors);
      assert.equal(await trials(1), 0);
      assert.equal(await sql(`select price_phase||':'||annual_cents from access_purchase_receipts where profile_id='${pid(1)}'`), 'founding:9900', 'the receipt is still recorded');
      assert.equal(await sql(`select state from limited_founding_slots where livemode and profile_id='${pid(1)}'`), 'paid');
      // A second founding member, who stays: see the sell-out below.
      await enroll(14);
      await buy(14, 'core', { paidDaysAgo: 31 });
      assert.deepEqual(await writeRule(14), { enforcementEnabled: true, credential: true, practice: true });
    });

    await t.test('early-bird and standard Credential keep the one 30-day trial, text and version unchanged', async () => {
      await phase('earlybird');
      try {
        for (const n of [2, 3]) await enroll(n);
        const old = await oldPreview(2, 'core');
        const v = await preview(2, 'core');
        assert.equal(v.consent_version, V2);
        assert.equal(v.consent_text, immediate(149) + TRIAL);
        assert.deepEqual([v.consent_text, v.consent_hash, v.consent_version], [old.consent_text, old.consent_hash, old.consent_version], 'byte for byte the reviewed text');
        await buy(2, 'core', { paidDaysAgo: 40 });
        await buy(3, 'core');
      } finally { await phase('founding'); }
      const expired = await snapshot(2);
      assert.equal(expired.purchasedOfferId, 'core');
      assert.equal(expired.practiceIncluded, false);
      assert.equal(expired.practiceTrial.state, 'expired');
      assert.equal(Date.parse(expired.practiceTrial.endsAt) - Date.parse(expired.practiceTrial.startsAt), 30 * DAY);
      assert.equal(expired.capabilities.credential.write, true);
      assert.equal(expired.capabilities.practice.write, false);
      assert.deepEqual(await writeRule(2), { enforcementEnabled: true, credential: true, practice: false });
      const refused = await practiceWrites(2);
      assert.ok(!refused.row && !refused.tax, 'Practice is read-only after the trial');
      const active = await snapshot(3);
      assert.equal(active.practiceTrial.state, 'active');
      assert.equal(active.practiceIncluded, false);
      assert.equal(active.capabilities.practice.write, true, 'inside the trial');
      assert.equal(await trials(3), 1);

      await phase('standard');
      try {
        await enroll(4);
        const v = await preview(4, 'core');
        assert.equal(v.consent_version, V2);
        assert.equal(v.consent_text, immediate(199) + TRIAL);
        await buy(4, 'core');
      } finally { await phase('founding'); }
      const standard = await snapshot(4);
      assert.equal(standard.practiceTrial.state, 'active');
      assert.equal(standard.practiceIncluded, false);
    });

    await t.test('cancel, refund or an unpaid renewal ends Credential and Practice together', async () => {
      // Cancel at period end: both stay until the paid year ends.
      const c1 = { quote: await value(`(select to_jsonb(q) from limited_billing_quotes q where profile_id='${pid(1)}')`), attempt_id: null };
      c1.attempt_id = c1.quote.attempt_id;
      assert.equal(await settle(1, c1, { cancel: true, paidDaysAgo: 40 }), 'applied');
      assert.deepEqual((await snapshot(1)).capabilities.practice, { read: true, write: true, export: true }, 'canceling, still inside the paid year');
      assert.equal((await snapshot(1)).practiceIncluded, true);
      assert.equal(await settle(1, c1, { status: 'canceled', paid: false, paidDaysAgo: 40 }), 'applied');
      const ended = await snapshot(1);
      assert.equal(ended.purchasedOfferId, null);
      assert.equal(ended.practiceIncluded, false);
      assert.deepEqual([ended.capabilities.credential.write, ended.capabilities.practice.write], [false, false]);
      assert.deepEqual([ended.capabilities.credential.read, ended.capabilities.practice.export], [true, true], 'records stay readable and exportable');
      assert.deepEqual(await writeRule(1), { enforcementEnabled: true, credential: false, practice: false });
      assert.ok(!(await practiceWrites(1)).row);

      // A refund cancels the subscription at once.
      await enroll(5);
      const { c: c5 } = await buy(5, 'core');
      assert.equal((await snapshot(5)).capabilities.practice.write, true);
      assert.equal(await settle(5, c5, { status: 'canceled', paid: false }), 'applied');
      assert.deepEqual(await writeRule(5), { enforcementEnabled: true, credential: false, practice: false });

      // A renewal that is not paid.
      await enroll(6);
      const { c: c6 } = await buy(6, 'core');
      assert.equal(await settle(6, c6, { status: 'past_due', paid: false }), 'applied');
      const unpaid = await snapshot(6);
      assert.deepEqual([unpaid.capabilities.credential.write, unpaid.capabilities.practice.write, unpaid.practiceIncluded], [false, false, false]);

      // And the period end itself, as for Credential.
      await enroll(13);
      await buy(13, 'core');
      await sql(`update billing_subscriptions set period_end=now()-interval '1 second' where profile_id='${pid(13)}'`);
      assert.deepEqual(await writeRule(13), { enforcementEnabled: true, credential: false, practice: false });
    });

    await t.test('the bundle is not offered to a new self-service buyer while their offer is founding', async () => {
      await enroll(10);
      const e = await value(`limited_billing_eligibility('${pid(10)}','${subject(10)}',true)`);
      assert.equal(e.price_phase, 'founding');
      assert.equal(e.bundle_available, false);
      assert.equal((await snapshot(10)).bundleAvailable, false);
      const refused = await as('service_role', `select create_limited_billing_preview('${pid(10)}','${subject(10)}',true,'core_locum')`);
      assert.match(refused.stderr, /bundle unavailable during founding/);
      // A bundle preview made before this migration cannot be claimed either.
      const oldBundle = await oldPreview(10, 'core_locum');
      assert.deepEqual(await claim(10, oldBundle), { state: 'bundle_unavailable' });
      assert.equal(await sql(`select count(*) from billing_checkout_attempts where profile_id='${pid(10)}'`), '0', 'nothing was leased');
      // Nor by switching from an unpaid $99 Checkout: the switch is undone.
      const first = await claim(10, await preview(10, 'core'));
      assert.equal(first.state, 'claimed');
      await pinSave(10, first);
      const proof = { attempt_id: first.attempt_id, customer_id: 'cus_Practice10', status: 'expired', subscription_id: null, session_ids: ['cs_Practice10'] };
      assert.deepEqual(await value(`supersede_limited_checkout('${pid(10)}','${subject(10)}',true,'${first.attempt_id}',${lit(proof)},'core_locum','${oldBundle.id}','${oldBundle.consent_hash}')`), { state: 'bundle_unavailable' });
      assert.equal(await sql(`select state||':'||attempt_id from billing_checkout_attempts where profile_id='${pid(10)}'`), `open:${first.attempt_id}`, 'the $99 attempt stands');
      assert.equal(await sql(`select state from limited_founding_slots where livemode and profile_id='${pid(10)}'`), 'reserved', 'and keeps its place');
      assert.equal((await value('public_membership_offer()')).bundleAvailable, false);

      // Founding ended by the owner: the bundle is offered again.
      await phase('earlybird');
      try {
        const after = await value(`limited_billing_eligibility('${pid(10)}','${subject(10)}',true)`);
        assert.deepEqual([after.price_phase, after.bundle_available], ['earlybird', true]);
        assert.equal((await snapshot(10)).bundleAvailable, true);
        assert.equal((await preview(10, 'core_locum')).annual_cents, 24500);
        assert.deepEqual(await value('public_membership_offer()'), { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: true, availability: 'available', bundleAvailable: true });
      } finally { await phase('founding'); }
    });

    await t.test('a reviewed invitation at founding is not offered the bundle either; at a later phase Credential + Practice is unchanged', async () => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(7)}','${subject(7)}','pending');
        insert into limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,profile_id,clerk_subject,claimed_at,review_reason,origin)
          values('synthetic_reviewed','reviewed7@example.invalid','${sha256('reviewed7')}',true,'founding',now()+interval '10 days','${pid(7)}','${subject(7)}',now(),'Synthetic reviewed invitation','reviewed_invitation')`);
      await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(7)}',true,'cus_Practice7')`);
      // $99 founding Credential already includes Practice with a rate locked for
      // life; $245 would cost $146 more a year for the same access.
      const e = await value(`limited_billing_eligibility('${pid(7)}','${subject(7)}',true)`);
      assert.deepEqual([e.price_phase, e.bundle_available], ['founding', false]);
      const refused = await as('service_role', `select create_limited_billing_preview('${pid(7)}','${subject(7)}',true,'core_locum')`);
      assert.match(refused.stderr, /bundle unavailable during founding/);
      const old = await oldPreview(7, 'core_locum');
      assert.deepEqual(await claim(7, old), { state: 'bundle_unavailable' });
      assert.equal((await preview(7, 'core')).consent_version, V3, 'the $99 offer, with Practice included');
      // An invitation reviewed at the standard phase: the bundle is offered, unchanged.
      await sql(`update limited_billing_invitations set price_phase='standard' where profile_id='${pid(7)}'`);
      const later = await value(`limited_billing_eligibility('${pid(7)}','${subject(7)}',true)`);
      assert.deepEqual([later.price_phase, later.bundle_available], ['standard', true]);
      const { v } = await buy(7, 'core_locum', { paidDaysAgo: 40 });
      assert.deepEqual([v.consent_text, v.consent_version], [old.consent_text, old.consent_version], 'bundle consent unchanged');
      assert.equal(v.consent_text, 'Credential + Practice: USD 245 due now, then USD 245 each year while this subscription remains active. Cancel before a scheduled charge to avoid it.');
      const s = await snapshot(7);
      assert.deepEqual([s.purchasedOfferId, s.practiceIncluded, s.practiceTrial.state, s.capabilities.practice.write], ['core_locum', true, 'none', true]);
      assert.deepEqual(await writeRule(7), { enforcementEnabled: true, credential: true, practice: true });
    });

    await t.test('lifetime and the no-card beta are unchanged; a beta holder opting in at $99 gets the v3 consent, is not offered the bundle, and can resume it', async () => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(8)}','${subject(8)}','active');
        insert into access_grants(profile_id,clerk_subject,livemode,scope,kind,source_key,starts_at) select '${pid(8)}','${subject(8)}',true,s,'lifetime','synthetic_gift',now()-interval '1 day' from unnest(array['credential','practice']) s`);
      const lifetime = await snapshot(8);
      assert.deepEqual(lifetime.lifetime, { credential: true, practice: true });
      assert.deepEqual([lifetime.purchasedOfferId, lifetime.practiceIncluded, lifetime.capabilities.credential.write, lifetime.capabilities.practice.write], [null, false, true, true]);
      assert.deepEqual(await writeRule(8), { enforcementEnabled: true, credential: true, practice: true });

      const enrolled = await enroll(9, promise);
      assert.equal(enrolled.kind, 'grandfathered_beta');
      const beta = await snapshot(9);
      assert.equal(beta.freeBeta.state, 'active');
      assert.deepEqual([beta.purchasedOfferId, beta.practiceIncluded, beta.bundleAvailable, beta.capabilities.practice.write], [null, false, false, true],
        'a beta holder opting in at founding is offered $99 with Practice included, not the $245 bundle');
      const old = await oldPreview(9, 'core');
      const v = await preview(9, 'core');
      assert.ok(v.billing_start_at, 'deferred to the original beta end');
      assert.equal(v.consent_version, V3);
      assert.ok(old.consent_text.endsWith(TRIAL));
      assert.equal(v.consent_text, old.consent_text.slice(0, -TRIAL.length) + INCLUDED, 'only the Practice sentences change');
      assert.match(v.consent_text, /^Credential: A card is required to opt in\. USD 0 due before /);
      assert.equal(v.consent_hash, sha256(v.consent_text));
      const bundle = await as('service_role', `select create_limited_billing_preview('${pid(9)}','${subject(9)}',true,'core_locum')`);
      assert.match(bundle.stderr, /bundle unavailable during founding/, 'no deferred $245 bundle beside a $99 that includes Practice');
      assert.deepEqual(await claim(9, await oldPreview(9, 'core_locum')), { state: 'bundle_unavailable' });
      assert.equal((await claim(9, old)).state, 'quote_expired');
      const c = await claim(9, v);
      assert.equal(c.state, 'claimed');
      await pinSave(9, c);
      assert.ok(await value(`limited_deferred_checkout_resume('${pid(9)}','${subject(9)}',true,null)`), 'the v3 Checkout resumes');
      const resumed = await preview(9, 'core');
      assert.deepEqual([resumed.consent_text, resumed.consent_hash, resumed.consent_version], [v.consent_text, v.consent_hash, V3], 'a resumed Checkout keeps its accepted terms');
      assert.equal((await claim(9, resumed)).state, 'existing');
    });

    await t.test('sold out: the public offer and a new buyer see early-bird with the bundle', async () => {
      assert.deepEqual(await value('public_membership_offer()'), { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false });
      await sql(`delete from limited_founding_slots where livemode and state='promised';
        update limited_founding_slots set state='paid',first_paid_at=coalesce(first_paid_at,now()),first_invoice_id=coalesce(first_invoice_id,'in_Filled'||slot) where livemode and state in ('reserved','committed');
        do $$ declare n integer; p uuid; inv uuid; a uuid; begin
          for n in select s from generate_series(1,100) s where not exists(select 1 from limited_founding_slots where livemode and slot=s) loop
            p:=gen_random_uuid(); a:=gen_random_uuid();
            insert into profiles(id,auth_user_id,access_status) values(p,'user_Filler'||n,'active');
            insert into limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,profile_id,clerk_subject,claimed_at,review_reason,origin)
              values('synthetic_filler','filler'||n||'@example.invalid',encode(sha256(convert_to('filler'||n,'UTF8')),'hex'),true,'founding',now()+interval '1 day',p,'user_Filler'||n,now(),'Synthetic filler','self_service') returning id into inv;
            insert into limited_billing_quotes(attempt_id,profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version)
              values(a,p,'user_Filler'||n,true,inv,'core','founding',9900,'2026-09-19-credential-practice-v1');
            insert into limited_founding_slots(livemode,slot,state,profile_id,clerk_subject,attempt_id,first_paid_at,first_invoice_id) values(true,n,'paid',p,'user_Filler'||n,a,now(),'in_Filler'||n);
          end loop;
        end $$;`);
      assert.deepEqual(await value('public_membership_offer()'), { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: true, availability: 'available', bundleAvailable: true });
      await enroll(11);
      const e = await value(`limited_billing_eligibility('${pid(11)}','${subject(11)}',true)`);
      assert.deepEqual([e.price_phase, e.bundle_available], ['earlybird', true]);
      assert.equal((await preview(11, 'core_locum')).annual_cents, 24500);
      const core = await preview(11, 'core');
      assert.deepEqual([core.annual_cents, core.consent_version, core.consent_text], [14900, V2, immediate(149) + TRIAL]);
      // A buyer whose $99 Checkout never completed is offered the bundle now,
      // and a founding member who paid before the sell-out keeps Practice.
      assert.equal((await snapshot(10)).bundleAvailable, true);
      const kept = await snapshot(14);
      assert.deepEqual([kept.purchasedOfferId, kept.practiceIncluded, kept.capabilities.practice.write], ['core', true, true]);
    });

    await t.test('the rollback also refuses while a v3 founding buyer has not paid yet: in Checkout, completing, or scheduled after the beta', async () => {
      // Each case runs in one transaction that is always rolled back. The base
      // removes what the first guard looked at (paid first payments), expires
      // every Checkout and ends every subscription; each case then restores
      // one unpaid purchase made under "Includes Practice for as long as this
      // membership remains active.", which Stripe could still collect $99 for.
      const base = "delete from limited_paid_purchase_history;update billing_checkout_attempts set state='expired';update billing_subscriptions set status='canceled',membership_active=false;";
      const guard = setup => sql(`begin;${base}${setup};${ROLLBACK};rollback;`).then(() => 'rolled back', error => error.message);
      const REFUSED = /a founding buyer agreed that Practice is included/;
      const attempt = (n, state) => `update billing_checkout_attempts set state='${state}' where profile_id='${pid(n)}'`;
      // Member 10: an immediate $99 founding Checkout, never paid.
      assert.equal(await sql(`select q.price_phase||':'||v.consent_version from limited_billing_quotes q join limited_billing_previews v on v.id=q.consent_preview_id join billing_checkout_attempts a on a.attempt_id=q.attempt_id where q.profile_id='${pid(10)}'`), `founding:${V3}`);
      assert.match(await guard(attempt(10, 'open')), REFUSED, 'an open Checkout, payable for up to 24 hours');
      assert.match(await guard(attempt(10, 'creating')), REFUSED, 'a Checkout being created');
      assert.match(await guard(attempt(10, 'complete')), REFUSED, 'a completed Checkout whose subscription is not recorded yet');
      // Member 9: a beta holder's deferred $99 opt-in. Checkout completes and
      // the subscription is scheduled (trialing) until the original beta end.
      const scheduled = status => `${attempt(9, 'complete')};
        select settle_limited_billing_subscription(jsonb_build_object('p_profile_id',q.profile_id,'p_livemode',true,'p_customer_id','cus_Practice9',
          'p_subscription_id','sub_Practice9','p_offer_id','core','p_status','${status}','p_period_end',q.billing_start_at,'p_event_id','evt_Scheduled9',
          'p_event_created',9000,'p_reconcile_token',claim_billing_reconcile(q.profile_id,true,'cus_Practice9','evt_Scheduled9')->>'token',
          'p_cancel_at_period_end',false,'p_billing_anchor',extract(epoch from q.billing_start_at)::bigint),q.attempt_id,null)
        from limited_billing_quotes q where q.profile_id='${pid(9)}' and q.billing_start_at is not null`;
      assert.match(await guard(scheduled('trialing')), REFUSED, 'a scheduled first charge at the original beta end');
      assert.match(await guard(`${scheduled('trialing')};update billing_subscriptions set status='incomplete' where profile_id='${pid(9)}'`), REFUSED, 'a first charge still being collected');
      // Must pass: every v3 purchase has ended, so nothing can still be charged.
      assert.equal(await guard(`${scheduled('trialing')};update billing_subscriptions set status='canceled' where profile_id='${pid(9)}'`), 'rolled back', 'a canceled scheduled purchase');
      assert.equal(await guard(`${scheduled('trialing')};update billing_subscriptions set status='incomplete_expired' where profile_id='${pid(9)}'`), 'rolled back');
      assert.equal(await guard('select 1'), 'rolled back', 'expired Checkouts and ended subscriptions');
      assert.equal(await exists('credentialdo_founding_practice(uuid,text,boolean)'), true, 'each case was rolled back');
    });

    await t.test('the rollback refuses while a founding member holds Practice, then restores every reviewed body and grant', async () => {
      const refused = await sql(`begin;${ROLLBACK};commit;`).then(() => null, error => error.message);
      assert.match(refused, /a founding buyer agreed that Practice is included/);
      assert.equal(await exists('credentialdo_founding_practice(uuid,text,boolean)'), true, 'nothing was rolled back');
      const confirmed = `begin;set local credentialdomd.rollback_founding_practice='confirmed';${ROLLBACK};commit;`;
      await sql(confirmed);
      await sql(confirmed);
      for (const name of TOUCHED) {
        assert.equal(await definition(name), before[name].body, `${name} is the reviewed body again`);
        assert.equal(await acl(name), before[name].acl, `${name} has its grant again`);
      }
      for (const name of PRIVATE) assert.equal(await exists(name), false, `${name} is gone`);
      // Re-applying after a rollback works.
      await sql(MIGRATION);
      for (const name of TOUCHED) assert.equal(await definition(name), once[name]);
    });
  } finally {
    await db.close();
  }
});
