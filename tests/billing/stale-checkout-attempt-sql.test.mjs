// A first Checkout attempt whose session was never saved (Stripe or the
// function failed between the claim and save_billing_checkout) stays
// 'creating'. limited-checkout gives a session 2 hours from its quote
// (CHECKOUT_LIFETIME_MS, funnel 2026-10-14) and refuses one that would have
// under 30 minutes left (checkout_needs_reconciliation). The claim handed
// that old attempt back as 'claimed' until it was 23 hours old, so a buyer
// who came back 90 minutes to 23 hours later could not pay at all.
//
// 20261014120000_stale_checkout_attempt.sql answers reconciliation_required,
// naming the attempt, once its quote is 80 minutes old and no worker holds
// it: limited-checkout then expires any session Stripe made for it, retires
// it and claims again in one transaction (supersede_limited_checkout), so a
// founding buyer keeps their place.
//
// Real PostgreSQL with the billing chain. Synthetic identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, lit, readMigration } from './billingChainFixture.mjs';

const NAME = '20261014120000_stale_checkout_attempt';
const MIGRATION_URL = new URL(`../../supabase/migrations/${NAME}.sql`, import.meta.url);
const ROLLBACK_URL = new URL(`../../docs/rollback/${NAME}.rollback.sql`, import.meta.url);
const MIGRATION = fs.existsSync(MIGRATION_URL) ? fs.readFileSync(MIGRATION_URL, 'utf8') : null;
const ROLLBACK = fs.existsSync(ROLLBACK_URL) ? fs.readFileSync(ROLLBACK_URL, 'utf8') : null;

test('the migration has no top-level transaction and a rollback', () => {
  assert.ok(MIGRATION, 'migration present');
  assert.ok(ROLLBACK, 'rollback present');
  assert.doesNotMatch(MIGRATION, /^\s*(begin|commit|rollback)\s*;/im);
  assert.doesNotMatch(ROLLBACK, /^\s*(begin|commit|rollback)\s*;/im);
});

test('a stale creating attempt can be retired and claimed again', { skip: pgSkip(), timeout: withSlotWait(240000) }, async () => {
  const db = await billingChain({ port: 58411, label: 'stale-attempt', idPrefix: '79000000' });
  const { sql, value, pid, subject } = db;
  try {
    await sql(readMigration('20260930001000_checkout_closes_on_settlement.sql'));
    if (MIGRATION) { await sql(MIGRATION); await sql(MIGRATION); }
    const age = async (n, attempt, minutes) => sql(`
      update billing_checkout_attempts set created_at=now()-interval '${minutes} minutes',lease_until=now()-interval '1 second' where profile_id='${pid(n)}' and attempt_id='${attempt}';
      update limited_billing_quotes set created_at=now()-interval '${minutes} minutes' where attempt_id='${attempt}'`);
    const slots = n => value(`(select count(*) from limited_founding_slots where livemode and profile_id='${pid(n)}')`);

    // Founding buyer 1: the first try never saved its session.
    await db.enroll(1);
    const first = await db.claim(1, await db.preview(1, 'core'));
    assert.equal(first.state, 'claimed', JSON.stringify(first));
    assert.ok(first.quote.public_founding_slot);

    // 30 minutes on, the same attempt is still handed back (its session would have 90 minutes).
    await age(1, first.attempt_id, 30);
    const soon = await db.claim(1, await db.preview(1, 'core'));
    assert.equal(soon.state, 'claimed');
    assert.equal(soon.attempt_id, first.attempt_id);

    // 100 minutes on, a session made now would have under 30 minutes: the
    // attempt is named for retirement instead.
    await age(1, first.attempt_id, 100);
    const v = await db.preview(1, 'core');
    const stale = await db.claim(1, v);
    assert.equal(stale.state, 'reconciliation_required', JSON.stringify(stale));
    assert.equal(stale.prior?.attempt_id, first.attempt_id);
    assert.equal(stale.prior?.state, 'creating');
    assert.equal(await slots(1), 1, 'the place is still held');

    // limited-checkout's supersede (Stripe found no session for it): retired and claimed again together.
    const proof = { attempt_id: first.attempt_id, customer_id: 'cus_staleattempt1', status: 'expired', subscription_id: null, session_ids: [] };
    const again = await value(`supersede_limited_checkout('${pid(1)}','${subject(1)}',true,'${first.attempt_id}',${lit(proof)},'core','${v.id}','${v.consent_hash}')`);
    assert.equal(again.state, 'claimed', JSON.stringify(again));
    assert.notEqual(again.attempt_id, first.attempt_id);
    assert.equal(again.quote.price_phase, 'founding');
    assert.ok(again.quote.public_founding_slot, 'the buyer keeps a founding place');
    assert.equal(await slots(1), 1);

    // A worker still inside its lease is never retired, however old the attempt.
    await sql(`update billing_checkout_attempts set created_at=now()-interval '100 minutes',lease_until=now()+interval '30 seconds' where profile_id='${pid(1)}';
      update limited_billing_quotes set created_at=now()-interval '100 minutes' where attempt_id='${again.attempt_id}'`);
    assert.equal((await db.claim(1, await db.preview(1, 'core'))).state, 'busy');

    // A saved, open attempt is resumed as before, whatever its age.
    await age(1, again.attempt_id, 5);
    const resumed = await db.claim(1, await db.preview(1, 'core'));
    assert.equal(resumed.state, 'claimed');
    await db.pinSave(1, resumed, 'cs_StaleAttempt1');
    await age(1, resumed.attempt_id, 100);
    const open = await db.claim(1, await db.preview(1, 'core'));
    assert.equal(open.state, 'existing');
    assert.equal(open.session_id, 'cs_StaleAttempt1');

    // A paid member's settlement is untouched.
    assert.equal(await db.settle(1, resumed), 'applied');

    if (ROLLBACK) {
      await sql(ROLLBACK); await sql(ROLLBACK);
      assert.equal(await value(`to_regprocedure('public.claim_limited_billing_checkout_before_stale(uuid,text,boolean,text,uuid,text)') is null`), true);
      assert.equal(await value(`to_regprocedure('public.claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text)') is not null`), true);
    }
  } finally { await db.close(); }
});
