// The public founder countdown (owner request, 2026-11-13): the public offer
// says how many of the 100 founder places are left.
// 20261113130000_public_founder_spots.sql on a real PostgreSQL with the
// billing chain: the number is 100 minus the PAID founding places and
// nothing else. A held promise, an open Checkout and an unpaid subscription
// do not move it; a verified first payment does; a cancellation does not put
// the place back (a paid founding place is never replenished); the package
// does not use one; at 100 paid it is 0 and the offer is the $149 phase.
// Only the aggregate is readable, and only through the public offer.
//
// Synthetic identities, customers, invoices and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, readMigration } from './billingChainFixture.mjs';

const NAME = '20261113130000_public_founder_spots';
const MIGRATION = fs.readFileSync(new URL(`../../supabase/migrations/${NAME}.sql`, import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL(`../../docs/rollback/${NAME}.rollback.sql`, import.meta.url), 'utf8');

test('the migration has no top-level transaction, a rollback, and changes no stored row', () => {
  for (const script of [MIGRATION, ROLLBACK]) {
    assert.doesNotMatch(script, /^\s*(begin|commit|rollback)\s*;/im);
    assert.doesNotMatch(script, /^\s*(update|delete\s+from|insert\s+into|truncate)\b/im);
  }
});

test('founderSpotsLeft is 100 minus paid founding places, and only that aggregate is public', { skip: pgSkip(), timeout: withSlotWait(300000) }, async t => {
  const db = await billingChain({ port: 58431, label: 'founder-spots', idPrefix: '7c000000' });
  const { sql, value, pid } = db;
  try {
    const offer = () => value('public_membership_offer()');
    const definition = () => sql(`select pg_get_functiondef('public.public_membership_offer()'::regprocedure)`);
    const before = await definition();
    assert.equal((await offer()).founderSpotsLeft, undefined, 'before the migration no count is published');
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('nobody but the public offer can read the count, and the offer carries no other new field', async () => {
      for (const who of ['anon', 'authenticated', 'service_role']) assert.ok(await db.denied(who, 'select founding_spots_left(true)'), who);
      assert.deepEqual(Object.keys(await offer()).sort(), ['annualCents', 'availability', 'bundleAvailable', 'checkoutEnabled', 'founderSpotsLeft', 'phase', 'schemaVersion']);
      assert.equal(typeof (await offer()).founderSpotsLeft, 'number');
    });

    await t.test('a held promise, a new account and an open Checkout do not count; a verified payment does', async () => {
      // The fixture holds one reviewed promise (unpaid).
      assert.equal(await sql("select count(*) from limited_founding_slots where livemode and state='promised'"), '1');
      assert.equal((await offer()).founderSpotsLeft, 100);
      await db.enroll(1);
      assert.equal((await offer()).founderSpotsLeft, 100, 'signing up reserves nothing');
      const c = await db.claim(1, await db.preview(1, 'core'));
      assert.equal(await sql(`select state from limited_founding_slots where livemode and profile_id='${pid(1)}'`), 'reserved');
      assert.equal((await offer()).founderSpotsLeft, 100, 'an open Checkout is not a paid place');
      await db.pinSave(1, c, 'cs_FounderSpots1');
      assert.equal(await db.settle(1, c, { paid: false, status: 'incomplete' }), 'applied');
      assert.equal((await offer()).founderSpotsLeft, 100, 'an unpaid subscription is not a paid place');
      assert.equal(await db.settle(1, c), 'applied');
      assert.equal(await sql(`select state from limited_founding_slots where livemode and profile_id='${pid(1)}'`), 'paid');
      assert.equal((await offer()).founderSpotsLeft, 99);
    });

    await t.test('a cancellation does not put the place back: a paid founding place is never replenished', async () => {
      await db.enroll(2);
      const c = await db.buy(2, 'core');
      assert.equal((await offer()).founderSpotsLeft, 98);
      assert.equal(await db.settle(2, c, { paid: false, status: 'canceled' }), 'applied');
      assert.equal((await offer()).founderSpotsLeft, 98);
    });

    await t.test('the count agrees with checkout: at 100 paid it is 0, the offer is $149 and the package is sold', async () => {
      // 98 more synthetic paid places, written as settlement writes them.
      await sql(`insert into profiles(id,auth_user_id,access_status) select ('7c0000ff-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'user_FounderFill'||n,'active' from generate_series(1,98) n`);
      const quote = await sql(`select attempt_id from limited_billing_quotes where profile_id='${pid(2)}' limit 1`);
      await sql(`alter table limited_founding_slots drop constraint limited_founding_slots_livemode_attempt_id_key;
        delete from limited_founding_slots where livemode and state='promised';
        insert into limited_founding_slots(livemode,slot,state,profile_id,clerk_subject,attempt_id,subscription_id,first_paid_at,first_invoice_id)
        select true,s.n,'paid',('7c0000ff-0000-4000-8000-'||lpad((row_number() over (order by s.n))::text,12,'0'))::uuid,'user_FounderFill'||row_number() over (order by s.n),'${quote}','sub_Fill'||s.n,now(),'in_Fill'||s.n
        from (select n from generate_series(1,100) n where not exists(select 1 from limited_founding_slots f where f.livemode and f.slot=n) order by n limit 97) s`);
      assert.equal(await sql("select count(*) from limited_founding_slots where livemode and state='paid'"), '99');
      assert.deepEqual([(await offer()).phase, (await offer()).founderSpotsLeft], ['founding', 1]);
      await sql(`insert into limited_founding_slots(livemode,slot,state,profile_id,clerk_subject,attempt_id,subscription_id,first_paid_at,first_invoice_id)
        select true,n,'paid','7c0000ff-0000-4000-8000-000000000098','user_FounderFill98','${quote}','sub_FillLast',now(),'in_FillLast'
        from generate_series(1,100) n where not exists(select 1 from limited_founding_slots f where f.livemode and f.slot=n) limit 1`);
      const soldOut = await offer();
      assert.deepEqual([soldOut.phase, soldOut.annualCents, soldOut.bundleAvailable, soldOut.founderSpotsLeft], ['earlybird', 14900, true, 0]);
    });

    await t.test('with the founding program switched off no number is published at all', async () => {
      await sql('update access_policy_settings set public_founding_enabled=false');
      const off = await offer();
      assert.equal(off.founderSpotsLeft, null);
      assert.equal(off.availability, 'paused');
      await sql('update access_policy_settings set public_founding_enabled=true');
    });

    await t.test('the rollback restores the reviewed body and removes the count, twice; forward again works', async () => {
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal((await offer()).founderSpotsLeft, undefined);
      assert.equal(await value(`to_regprocedure('public.founding_spots_left(boolean)') is null`), true);
      assert.equal(await definition(), before, 'the reviewed body, byte for byte');
      await sql(MIGRATION);
      assert.equal((await offer()).founderSpotsLeft, 0);
    });
  } finally { await db.close(); }
});
