// One step, pay first sign-up (20261120190000_pay_first_signup.sql) on real
// PostgreSQL with the limited-launch billing chain: a founding place is held
// before an account exists, counted under the same lock as every claim, and
// adopted after payment through the unchanged claim and settlement.
//
// Synthetic identities, customers, sessions and invoices only. No provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, lit, readMigration, text } from '../billing/billingChainFixture.mjs';

const NAME = '20261120190000_pay_first_signup';
const MIGRATION = fs.readFileSync(new URL(`../../supabase/migrations/${NAME}.sql`, import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL(`../../docs/rollback/${NAME}.rollback.sql`, import.meta.url), 'utf8');
const digest = () => crypto.randomBytes(32).toString('hex');
const ip = n => crypto.createHash('sha256').update(`ip${n}`).digest('hex').slice(0, 32);

// owner_notify_rows and the admin check live outside the billing chain; the
// parts the migration touches are stubbed with the reviewed shape.
const STUBS = `
create table if not exists early_access_leads(name text, email text, source text, created_at timestamptz);
create or replace function public.owner_notify_rows(p_since timestamptz)
returns table (kind text, name text, email text, extra text, created_at timestamptz, key text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
#variable_conflict use_column
begin
  return query
  select r.kind::text, r.name::text, r.email::text, r.extra::text, r.created_at::timestamptz, coalesce(r.key, 'row')::text
  from (
    select 'waitlist' as kind, coalesce(name,'') as name, coalesce(email,'') as email, '' as extra, created_at, null::text as key from early_access_leads where created_at > p_since
  ) as r(kind, name, email, extra, created_at, key)
  order by r.created_at;
end $fn$;
create or replace function public.owner_notify_email_kinds() returns text[] language sql immutable as $$ select array['waitlist'] $$;
create or replace function public.admin_operations_can_read() returns boolean language sql stable as $$ select false $$;
`;

test('the migration has no top-level transaction', () => {
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit|rollback)\s*;/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit|rollback)\s*;/im);
  // Paid-only public numbers belong to PR #19 / #25: this build defines none.
  assert.doesNotMatch(MIGRATION, /founder_spots_left|founding_spots_left|paid_founder_count|founderSpotsLeft/);
});

test('pay-first holds, adoption and settlement on the real billing chain', { skip: pgSkip(), timeout: withSlotWait(300000) }, async t => {
  const db = await billingChain({ port: 58537, label: 'pay-first', idPrefix: '79100000' });
  const { sql, value, pid, subject } = db;
  t.after(() => db.close());
  await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
  await sql(readMigration('20261014120000_stale_checkout_attempt.sql'));
  await sql(STUBS);
  await sql(MIGRATION); await sql(MIGRATION);

  const customer = n => `cus_payfirst${n}`;
  const hold = (n, live = true) => value(`hold_pay_first_founding(${live},'${digest()}','price_Synthetic','${ip(n)}')`);
  const row = async id => JSON.parse(await sql(`select to_jsonb(s) from pay_first_signups s where signup_id='${id}'`));
  // Private to the database (service role has no grant): read as its owner.
  const publicState = () => sql(`select founding_public_state(true)`);
  // As owner-notify's claim reads them (owner-only routine).
  const ownerRows = async kind => JSON.parse(await sql(`select coalesce(jsonb_agg(r),'[]') from owner_notify_rows(now()-interval '1 day') r where r.kind=${text(kind)}`));
  const slots = () => value(`(select count(*) from limited_founding_slots where livemode)`);
  const reset = () => sql(`delete from pay_first_signups`);
  // A paid Checkout up to adoption: saved, leased, marked paid.
  const paid = async (n, { email = `buyer${n}@example.invalid`, cus = customer(n) } = {}) => {
    const h = await hold(n);
    assert.equal(h.state, 'held', JSON.stringify(h));
    const session = `cs_payfirst${n}x${crypto.randomBytes(3).toString('hex')}`;
    assert.equal(await value(`save_pay_first_session('${h.signup_id}','${session}')`), true);
    const lease = await value(`claim_pay_first_provision('${h.signup_id}','${session}','webhook','evt_payfirst${n}')`);
    assert.equal(lease.state, 'claimed', JSON.stringify(lease));
    const marked = await value(`mark_pay_first_paid('${h.signup_id}','${lease.token}','sub_payfirst${n}','${cus}',${text(email)})`);
    assert.equal(marked.state, 'paid');
    return { id: h.signup_id, session, token: lease.token, email, cus };
  };
  const newProfile = n => sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(n)}','${subject(n)}','pending')`);
  const adopt = (h, n, prior = null, proof = null) => value(`adopt_pay_first_signup('${h.id}','${h.token}','${pid(n)}','${subject(n)}','${h.cus}',${text(h.email)},'prod_Synthetic',${prior ? `'${prior}'` : 'null'},${proof ? lit(proof) : 'null'})`);
  const quote = async attempt => JSON.parse(await sql(`select to_jsonb(q) from limited_billing_quotes q where attempt_id='${attempt}'`));
  const settle = async (n, attempt) => {
    const event = `evt_payfirstsettle${n}`;
    const lease = await value(`claim_billing_reconcile('${pid(n)}',true,'${customer(n)}','${event}')`);
    const q = await quote(attempt);
    const periodEnd = new Date(Date.now() + 364 * 86400000).toISOString();
    const args = { p_profile_id: pid(n), p_livemode: true, p_customer_id: customer(n), p_subscription_id: `sub_payfirst${n}`, p_offer_id: 'core',
      p_status: 'active', p_period_end: periodEnd, p_event_id: event, p_event_created: 2000 + n, p_reconcile_token: lease.token,
      p_cancel_at_period_end: false, p_billing_anchor: null };
    const proof = { profileId: pid(n), clerkSubject: subject(n), livemode: true, customerId: customer(n), subscriptionId: `sub_payfirst${n}`,
      invoiceId: `in_payfirst${n}`, pricePhase: q.price_phase, annualCents: q.annual_cents, paidAt: new Date(Date.now() - 60000).toISOString(),
      periodEnd, policyVersion: q.policy_version, initial: true };
    return value(`settle_limited_billing_subscription(${lit(args)},'${attempt}',${lit(proof)})`);
  };

  await t.test('the flag is off by default: no hold', async () => {
    assert.equal((await hold(1)).state, 'disabled');
    await sql(`update access_policy_settings set pay_first_signup_enabled=true`);
  });

  await t.test('the consent is the in-app builder\'s, byte for byte', async () => {
    await db.enroll(90);
    const v = await db.preview(90, 'core');
    const c = await value('pay_first_founding_consent()');
    assert.equal(c.text, v.consent_text);
    assert.equal(c.hash, v.consent_hash);
    assert.equal(c.version, v.consent_version);
  });

  await t.test('holds count as occupied places and the cap is never exceeded under concurrency', async () => {
    await reset();
    const before = await slots();
    // Fill to 97 occupied: the promise and enrolled rows plus paid holds.
    const fill = 97 - before;
    await sql(`insert into pay_first_signups(livemode,state,nonce_digest,consent_version,consent_hash,consent_text,price_id,price_phase,expires_at,paid_at,created_at)
      select true,'paid',md5(g::text)||md5(g::text),'v',repeat('a',64),'t','price_Synthetic','founding',now(),now(),now()-interval '2 hours' from generate_series(1,${fill}) g`);
    assert.equal(await publicState(), 'available');
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(n => hold(100 + n)));
    assert.equal(results.filter(r => r.state === 'held').length, 3, JSON.stringify(results));
    assert.equal(results.filter(r => r.state === 'founding_full').length, 3);
    assert.equal(await publicState(), 'reserved', 'the public offer reads temporarily full');
    // A login-first claim sees the holds too.
    await db.enroll(91);
    const c = await db.claim(91, await db.preview(91, 'core'));
    assert.equal(c.state, 'founding_capacity_pending', JSON.stringify(c));
  });

  await t.test('an expired unpaid hold stops counting 15 minutes after its Checkout ends', async () => {
    await sql(`update pay_first_signups set expires_at=now()-interval '16 minutes' where state='creating'`);
    assert.equal(await publicState(), 'available');
    await reset();
  });

  await t.test('rate limits: 5 an hour from one address, 25 unpaid at once', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await hold(7)).state, 'held');
    assert.equal((await hold(7)).state, 'rate_limited');
    await sql(`update pay_first_signups set created_at=now()-interval '2 hours'`);
    for (let i = 0; i < 20; i++) assert.equal((await hold(200 + i)).state, 'held');
    assert.equal((await hold(300)).state, 'busy');
    await reset();
  });

  await t.test('only a proven expired, unpaid, subscription-less Checkout releases its hold', async () => {
    const h = await hold(8);
    await value(`save_pay_first_session('${h.signup_id}','cs_release8')`);
    const proof = { session_id: 'cs_release8', status: 'expired', payment_status: 'unpaid', subscription_id: null };
    assert.equal(await value(`release_pay_first_hold('cs_release8',${lit({ ...proof, payment_status: 'paid' })})`), false);
    assert.equal(await value(`release_pay_first_hold('cs_release8',${lit({ ...proof, subscription_id: 'sub_x' })})`), false);
    assert.equal(await value(`release_pay_first_hold('cs_release8',${lit(proof)})`), true);
    assert.equal((await row(h.signup_id)).state, 'expired');
    const p = await paid(9);
    const s = (await row(p.id)).session_id;
    assert.equal(await value(`release_pay_first_hold('${s}',${lit({ ...proof, session_id: s })})`), false, 'a paid hold is never released');
    await reset();
  });

  await t.test('a new buyer: adopted, claimed, settled paid, one place', async () => {
    const before = await slots();
    const h = await paid(10);
    // The lease: a second worker is busy, the session must match.
    assert.equal((await value(`claim_pay_first_provision('${h.id}','${h.session}','return')`)).state, 'busy');
    assert.equal((await value(`claim_pay_first_provision('${h.id}','cs_other','return')`)).state, 'mismatch');
    await newProfile(10);
    const a = await adopt(h, 10);
    assert.equal(a.state, 'adopted', JSON.stringify(a));
    assert.equal(await slots(), before + 1);
    assert.equal(await publicState(), 'available');
    // Adopting again is a no-op.
    assert.equal((await adopt(h, 10)).existing, true);
    const q = await quote(a.attempt_id);
    assert.equal(q.price_phase, 'founding');
    assert.equal(q.price_id, 'price_Synthetic');
    assert.ok(q.public_founding_slot);
    assert.equal((await db.attempt(10)).session_id, h.session);
    // Not provisioned before settlement.
    await assert.rejects(value(`finish_pay_first_provision('${h.id}','${h.token}','provisioned',null,true)`), /not settled/);
    assert.equal(await settle(10, a.attempt_id), 'applied');
    assert.equal(await value(`(select state from limited_founding_slots where attempt_id='${a.attempt_id}')`), 'paid');
    assert.equal(await value(`finish_pay_first_provision('${h.id}','${h.token}','provisioned',null,true)`), true);
    const done = await row(h.id);
    assert.equal(done.state, 'provisioned');
    assert.equal((await value(`claim_pay_first_provision('${h.id}','${h.session}','webhook')`)).state, 'done');
    assert.equal((await db.snapshot(10)).accessStatus, 'active');
    // Instant sign-in only within 15 minutes of the first token.
    assert.equal(await value(`pay_first_token_gate('${h.id}')`), true);
    assert.equal(await value(`pay_first_token_gate('${h.id}')`), true);
    await sql(`update pay_first_signups set token_issued_at=now()-interval '16 minutes' where signup_id='${h.id}'`);
    assert.equal(await value(`pay_first_token_gate('${h.id}')`), false);
    // docs@ waits for the first email-code sign-in on an account made from a typed email.
    assert.equal(await value(`pay_first_email_unproven('${pid(10)}')`), true);
    assert.equal(await value(`prove_pay_first_email('${pid(10)}','${subject(10)}')`), true);
    assert.equal(await value(`pay_first_email_unproven('${pid(10)}')`), false);
    assert.equal(await value(`pay_first_email_unproven('${pid(90)}')`), false, 'other accounts are unaffected');
  });

  await t.test('an existing paid member who pays again is a duplicate, not adopted', async () => {
    await db.enroll(11);
    await db.buy(11);
    const before = await slots();
    const h = await paid(11);
    const a = await adopt(h, 11);
    assert.equal(a.state, 'duplicate_member');
    assert.equal((await row(h.id)).state, 'duplicate_member');
    assert.equal(await slots(), before);
    assert.equal((await value(`claim_pay_first_provision('${h.id}','${h.session}','webhook')`)).state, 'duplicate_member');
  });

  await t.test('an unpaid lead with an open login-first Checkout: retired and adopted together', async () => {
    await db.enroll(12);
    const c = await db.claim(12, await db.preview(12, 'core'));
    await db.pinSave(12, c, 'cs_loginfirst12');
    // Checkout made a new customer; the lead's login-first one never paid.
    const h = await paid(12, { cus: 'cus_checkoutmade12' });
    const first = await adopt(h, 12);
    assert.equal(first.state, 'prior_attempt', JSON.stringify(first));
    assert.equal(first.prior.attempt_id, c.attempt_id);
    assert.equal(first.prior.customer_id, customer(12), 'the old customer, whose sessions the service expires');
    // A proof that does not cover the saved session retires nothing.
    const bad = { attempt_id: c.attempt_id, customer_id: customer(12), status: 'expired', subscription_id: null, session_ids: [] };
    assert.deepEqual(await adopt(h, 12, c.attempt_id, bad), { state: 'needs_owner', reason: 'prior_checkout_open' });
    const again = await value(`claim_pay_first_provision('${h.id}','${h.session}','admin')`);
    const proof = { ...bad, session_ids: ['cs_loginfirst12'] };
    const a = await adopt({ ...h, token: again.token }, 12, c.attempt_id, proof);
    assert.equal(a.state, 'adopted', JSON.stringify(a));
    assert.notEqual(a.attempt_id, c.attempt_id);
    assert.equal(await value(`(select count(*) from limited_founding_slots where profile_id='${pid(12)}')`), 1, 'one place, moved to the paid attempt');
    assert.equal(await value(`(select stripe_customer_id from billing_accounts where profile_id='${pid(12)}')`), 'cus_checkoutmade12');
  });

  await t.test('a profile bound to a different Stripe customer needs the owner', async () => {
    // A former member (cancelled) whose account keeps its own Stripe customer.
    await db.enroll(13);
    const c = await db.buy(13);
    assert.equal(await db.settle(13, c, { paid: false, status: 'canceled' }), 'applied');
    const h = await paid(13, { cus: 'cus_checkoutmade13' });
    const a = await adopt(h, 13);
    assert.deepEqual(a, { state: 'needs_owner', reason: 'customer_conflict' });
    const owner = await ownerRows('SIGN-UP NEEDS YOU');
    assert.match(owner.find(r => r.email === h.email).extra, /^paid, account not finished \(customer_conflict\)$/);
    // The duplicate member above is there too, for a refund by hand.
    assert.match(owner.find(r => r.email === 'buyer11@example.invalid').extra, /already a member: refund by hand/);
  });

  await t.test('a deleted account needs the owner', async () => {
    const h = await paid(14);
    await sql(`insert into profiles(id,auth_user_id,access_status,deleted_at) values('${pid(14)}','${subject(14)}','pending',now())`);
    assert.deepEqual(await adopt(h, 14), { state: 'needs_owner', reason: 'account_unavailable' });
  });

  await t.test('a payment after its hold expired with no place left needs the owner', async () => {
    const h = await paid(15);
    // Its hold had expired and every place filled meanwhile.
    await sql(`insert into pay_first_signups(livemode,state,nonce_digest,consent_version,consent_hash,consent_text,price_id,price_phase,expires_at,paid_at)
      select true,'paid',md5(g::text)||md5(g::text),'v',repeat('a',64),'t','price_Synthetic','founding',now(),now() from generate_series(1,100) g`);
    await newProfile(15);
    assert.deepEqual(await adopt(h, 15), { state: 'needs_owner', reason: 'founding_full' });
    // Only the owner's button retries it.
    assert.equal((await value(`claim_pay_first_provision('${h.id}','${h.session}','sweep')`)).state, 'needs_owner');
    assert.equal((await value(`claim_pay_first_provision('${h.id}','${h.session}','admin')`)).state, 'claimed');
    await sql(`delete from pay_first_signups where consent_version='v'`);
  });

  await t.test('owner rows: paid with no login after 10 minutes', async () => {
    const h = await paid(16);
    await sql(`update pay_first_signups set paid_at=now()-interval '11 minutes' where signup_id='${h.id}'`);
    const rows = await ownerRows('PAID, NO LOGIN YET');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, h.email);
    assert.match(rows[0].extra, /^1[01] min, state paid$/);
    assert.ok(JSON.parse(await sql('select to_jsonb(owner_notify_email_kinds())')).includes('PAID, NO LOGIN YET'));
  });

  await t.test('the sweep lists paid and expired-unpaid holds, and expires unsaved ones', async () => {
    await reset();
    const unsaved = await hold(17);
    await sql(`update pay_first_signups set expires_at=now()-interval '20 minutes' where signup_id='${unsaved.signup_id}'`);
    const p = await paid(18);
    await sql(`update pay_first_signups set updated_at=now()-interval '6 minutes',provision_until=null where signup_id='${p.id}'`);
    const batch = await value(`pay_first_sweep_batch(true,10)`);
    assert.deepEqual(batch.map(b => b.signup_id), [p.id]);
    assert.equal((await row(unsaved.signup_id)).state, 'expired');
  });

  await t.test('disputes are recorded once and alert the owner', async () => {
    assert.equal(await value(`record_billing_dispute('dp_1',true,'ch_1',9900,'fraudulent','${customer(10)}')`), true);
    assert.equal(await value(`record_billing_dispute('dp_1',true,'ch_1',9900,'fraudulent','${customer(10)}')`), true);
    const rows = await ownerRows('DISPUTE OPENED');
    assert.equal(rows.length, 1);
  });

  await t.test('roles: nothing for anon or members', async () => {
    assert.equal(await db.denied('anon', `select hold_pay_first_founding(true,'${digest()}','price_X',null)`), true);
    assert.equal(await db.denied('authenticated', `select adopt_pay_first_signup(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'user_x','cus_x','a@b.co','prod_x')`), true);
  });

  await t.test('the rollback refuses while a paid sign-up waits, then restores', async () => {
    await assert.rejects(sql(ROLLBACK), /still waiting/);
    await sql(`delete from pay_first_signups where state in ('paid','provisioning','needs_owner','creating','open')`);
    await sql(ROLLBACK); await sql(ROLLBACK);
    assert.equal(await value(`to_regclass('public.pay_first_signups') is null`), true);
    assert.equal(await value(`to_regprocedure('public.hold_pay_first_founding(boolean,text,text,text)') is null`), true);
    assert.equal(await publicState(), 'available');
    const body = await value(`pg_get_functiondef('public.owner_notify_rows(timestamptz)'::regprocedure)`);
    assert.doesNotMatch(body, /pay_first/);
    // And it applies again cleanly afterwards.
    await sql(MIGRATION);
  });
});
