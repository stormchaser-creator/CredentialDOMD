// A disposable PostgreSQL carrying the real limited-launch billing chain
// (readiness through founding Practice), with the same explicit continuity
// stubs the other billing suites use, and the webhook's settlement driven as
// the webhook drives it. Not a test file itself.
//
// Synthetic identities, customers, invoices and sessions only; Unix socket
// only; no provider request, credential or production row.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin } from '../credential-portal/postgresFixture.mjs';

const run = promisify(execFile);
export const readMigration = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
export const readOptional = rel => { const url = new URL(`../../${rel}`, import.meta.url); return fs.existsSync(url) ? fs.readFileSync(url, 'utf8') : null; };
export const CHAIN = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
  '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
  '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
  '20260920230000_access_write_enforcement.sql',
  '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
  '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql',
  '20260923010000_lifetime_gift_reservations.sql', '20260928180000_checkout_offer_switch.sql',
  '20260928190000_founding_practice_included.sql'];
const DAY = 86400000;
export const text = value => `'${String(value).replaceAll("'", "''")}'`;
export const lit = value => `${text(JSON.stringify(value))}::jsonb`;

/** Start PostgreSQL on `port`, load the chain, open founding self-service checkout. */
export async function billingChain({ port, label, idPrefix }) {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
  await exec('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  await exec('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-k ${socket} -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700 -c fsync=off`, '-w', 'start']);
  const psql = input => new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', String(port), '-U', 'postgres', '-d', 'postgres'], { env });
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
    const mailbox = readMigration('20260918a_mailbox_account_events.sql');
    const start = mailbox.indexOf('create or replace function public.account_is_closed(p_profile uuid)');
    const ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;';
    await sql(mailbox.slice(start, mailbox.indexOf(ending, start) + ending.length));
    for (const name of CHAIN) await sql(readMigration(name));
    const promise = `promise-${label}@example.invalid`;
    const digest = crypto.createHash('sha256').update(JSON.stringify([promise])).digest('hex');
    await value(`seal_limited_free_beta_cohort('synthetic_${label.replaceAll('-', '_')}','${digest}',${lit([promise])},'Synthetic reviewed cohort')`);
    await value(`prepare_founding_program(true,'synthetic_${label.replaceAll('-', '_')}','${digest}',1)`);
    await sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'");
  } catch (error) { await close().catch(() => {}); throw error; }

  const pid = n => `${idPrefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const subject = n => `user_${label.replace(/[^A-Za-z]/g, '')}${n}`;
  const customer = n => `cus_${label.replace(/[^A-Za-z]/g, '')}${n}`;
  const enroll = async n => {
    await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(n)}','${subject(n)}','pending')`);
    await value(`bootstrap_limited_signup('${pid(n)}','${subject(n)}',true,${text(`${label}${n}@example.invalid`)})`);
    await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(n)}',true,'${customer(n)}')`);
  };
  const preview = (n, offer) => value(`create_limited_billing_preview('${pid(n)}','${subject(n)}',true,'${offer}')`);
  const claim = (n, v) => value(`claim_limited_billing_checkout('${pid(n)}','${subject(n)}',true,'${v.offer_id}','${v.id}','${v.consent_hash}')`);
  const pinSave = async (n, c, session) => {
    const r = await as('service_role', `select pin_limited_billing_price('${c.attempt_id}','${pid(n)}','${subject(n)}',true,'prod_Synthetic','price_Synthetic');select save_billing_checkout('${pid(n)}',true,'${c.attempt_id}','${c.token}','${session}')`);
    assert.equal(r.code, 0, r.stderr);
  };
  let events = 0;
  // The last paid invoice settled per member, for a later event about the
  // same invoice (customer.subscription.updated after a portal change).
  const lastPaid = new Map();
  /**
   * One verified Stripe event, settled as limited-stripe-webhook does.
   * `sameInvoice`: the event carries the member's last paid invoice again, as
   * Stripe's subscription.updated does while the period is unchanged.
   */
  const settle = async (n, c, { paid = true, status = 'active', subscription = `sub_${label.replace(/[^A-Za-z]/g, '')}${n}`, cancelAtPeriodEnd = false, sameInvoice = false } = {}) => {
    const event = `evt_${label.replace(/[^A-Za-z]/g, '')}${n}x${++events}`;
    const lease = await value(`claim_billing_reconcile('${pid(n)}',true,'${customer(n)}','${event}')`);
    const earlier = sameInvoice ? lastPaid.get(n) : null;
    if (sameInvoice && !earlier) throw Error(`member ${n} has no paid invoice to settle again`);
    const paidAt = earlier ? earlier.paidAt : Date.now() - DAY;
    const periodEnd = earlier ? earlier.periodEnd : new Date(paidAt + 365 * DAY).toISOString();
    const invoiceId = earlier ? earlier.invoiceId : `in_${label.replace(/[^A-Za-z]/g, '')}${n}x${events}`;
    const q = c.quote;
    const args = { p_profile_id: pid(n), p_livemode: true, p_customer_id: customer(n), p_subscription_id: subscription,
      p_offer_id: q.offer_id, p_status: status, p_period_end: periodEnd, p_event_id: event, p_event_created: 1000 + events,
      p_reconcile_token: lease.token, p_cancel_at_period_end: cancelAtPeriodEnd, p_billing_anchor: null };
    const proof = paid ? { profileId: pid(n), clerkSubject: subject(n), livemode: true, customerId: customer(n),
      subscriptionId: subscription, invoiceId, pricePhase: q.price_phase, annualCents: q.annual_cents,
      paidAt: new Date(paidAt).toISOString(), periodEnd, policyVersion: q.policy_version, initial: true } : null;
    const result = await value(`settle_limited_billing_subscription(${lit(args)},'${c.attempt_id}',${proof ? lit(proof) : 'null'})`);
    if (paid) lastPaid.set(n, { paidAt, periodEnd, invoiceId });
    return result;
  };
  /** Claim, open and pay for `offer`. */
  const buy = async (n, offer = 'core') => {
    const c = await claim(n, await preview(n, offer));
    assert.equal(c.state, 'claimed', JSON.stringify(c));
    await pinSave(n, c, `cs_${label.replace(/[^A-Za-z]/g, '')}${n}`);
    assert.equal(await settle(n, c), 'applied');
    return c;
  };
  const attempt = async n => JSON.parse(await sql(`select to_jsonb(a) from billing_checkout_attempts a where profile_id='${pid(n)}' and livemode`) || 'null');
  /** The member's own access snapshot, as the app reads it. */
  const snapshot = async n => {
    const r = await as('authenticated', 'select credentialdo_access_snapshot()', subject(n));
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const denied = async (who, call) => { const r = await as(who, call); return r.code !== 0 && /permission denied for function/.test(r.stderr); };
  return { sql, as, value, close, pid, subject, enroll, preview, claim, pinSave, settle, buy, attempt, snapshot, denied };
}
