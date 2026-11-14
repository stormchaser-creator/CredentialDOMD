// Owner decision, 2026-11-13: two Credential prices. The first 100 paid
// members are founders at $99/year with Practice included; after them
// Credential is $149/year with one 30-day Practice trial and Credential +
// Practice is $245/year. The $199 "standard" Credential tier is removed.
//
// 20261113120000_remove_standard_credential_tier.sql, proven on a real
// PostgreSQL with the billing chain underneath it: before it a returning
// buyer is offered Credential at $199; after it nothing is offered, quoted,
// claimed or published at $199, and the rollback puts every body back.
//
// Synthetic identities, customers, invoices and sessions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { billingChain, lit, readMigration } from './billingChainFixture.mjs';

const NAME = '20261113120000_remove_standard_credential_tier';
const MIGRATION = fs.readFileSync(new URL(`../../supabase/migrations/${NAME}.sql`, import.meta.url), 'utf8');
const ROLLBACK = fs.readFileSync(new URL(`../../docs/rollback/${NAME}.rollback.sql`, import.meta.url), 'utf8');
// What production has above the fixture's chain that touches these routines.
const LATER = ['20260929131500_invite_to_join_sends.sql', '20260930001000_checkout_closes_on_settlement.sql', '20260930002000_access_snapshot_billing_status.sql',
  '20260930032000_access_snapshot_renewal.sql', '20260930070000_limited_refunds.sql', '20261001081000_billing_cancel_at.sql',
  '20261001090000_settle_paused_membership.sql', '20261014100000_checkout_recovery.sql', '20261014120000_stale_checkout_attempt.sql'];
const EDITED = ['public_membership_offer()', 'limited_billing_eligibility_before_practice(uuid,text,boolean)', 'limited_billing_eligibility(uuid,text,boolean)',
  'create_limited_billing_preview_before_practice(uuid,text,boolean,text)', 'claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)',
  'credentialdo_access_snapshot_before_billing_status()', 'bootstrap_limited_signup_before_founding(uuid,text,boolean,text)',
  'prepare_limited_billing_invitations(text,boolean,jsonb)', 'reserve_invite_to_join(uuid,text,text,boolean,text,text,integer)'];
const TRIAL = ' Includes one 30-day Practice feature trial beginning with your first verified payment. Practice does not auto-charge or upgrade; after expiry, your saved Practice records remain readable and exportable.';

test('the migration has no top-level transaction, a rollback, and changes no stored row', () => {
  for (const script of [MIGRATION, ROLLBACK]) {
    assert.doesNotMatch(script, /^\s*(begin|commit|rollback)\s*;/im);
    assert.doesNotMatch(script, /^\s*(update|delete\s+from|insert\s+into|truncate)\b/im, 'no data statement: the owner changes settings, not the migration');
  }
});

test('after the migration no Credential is offered at $199: public offer, returning buyer, invitations', { skip: pgSkip(), timeout: withSlotWait(300000) }, async t => {
  const db = await billingChain({ port: 58421, label: 'no-standard', idPrefix: '7b000000' });
  const { sql, value, pid, subject } = db;
  try {
    // The invitation ledger's read policy names the caller's profile and admin check; nothing here reads through them.
    await sql(`create function public.current_profile_id() returns uuid language sql stable as $$select null::uuid$$;
      create function public.is_admin(uuid) returns boolean language sql stable as $$select exists(select 1 from public.app_admins where profile_id=$1)$$`);
    for (const name of LATER) await sql(readMigration(name));
    const definition = name => sql(`select pg_get_functiondef('public.${name}'::regprocedure)`);
    const acl = name => sql(`select proacl::text from pg_proc where oid='public.${name}'::regprocedure`);
    const before = {};
    for (const name of EDITED) before[name] = { body: await definition(name), acl: await acl(name) };
    const offer = () => value('public_membership_offer()');
    const eligibility = n => value(`limited_billing_eligibility('${pid(n)}','${subject(n)}',true)`);
    const buyThenCancel = async n => {
      await db.enroll(n);
      const c = await db.buy(n, 'core');
      assert.equal(c.quote.price_phase, 'founding');
      assert.equal(await db.settle(n, c, { paid: false, status: 'canceled' }), 'applied');
    };

    await t.test('before: a returning buyer is offered standard Credential at $199', async () => {
      await buyThenCancel(1);
      assert.equal((await db.snapshot(1)).pricePhase, 'standard');
      const v = await db.preview(1, 'core');
      assert.deepEqual([v.price_phase, v.annual_cents], ['standard', 19900]);
      await sql("update access_policy_settings set limited_self_service_price_phase='standard'");
      assert.deepEqual([(await offer()).phase, (await offer()).annualCents], ['standard', 19900]);
    });

    await t.test('it refuses to run while a setting still names the removed phase, and changes nothing', async () => {
      await assert.rejects(sql(MIGRATION), /still names the removed standard phase/);
      for (const name of EDITED) assert.equal(await definition(name), before[name].body, name);
      assert.equal(await sql('select limited_self_service_price_phase from access_policy_settings'), 'standard');
      await sql("update access_policy_settings set limited_self_service_price_phase='founding'");
    });

    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice; grants are unchanged; only the listed routines changed', async () => {
      for (const name of EDITED) {
        assert.notEqual(await definition(name), before[name].body, `${name} was edited`);
        assert.equal(await acl(name), before[name].acl, `${name} grants`);
      }
      // No routine quotes 19900 except the receipt check kept for history.
      const still = await sql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~ '19900'`);
      assert.equal(still, 'record_credential_purchase_trial');
      // 'standard' survives only as the package's stored label and in the two normalising lines.
      const named = await sql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~ 'then ''standard'''`);
      assert.equal(named, 'claim_limited_billing_checkout_before_founding,create_limited_billing_preview_before_practice');
      for (const name of ['claim_limited_billing_checkout_before_founding(uuid,text,boolean,text,uuid,text)', 'create_limited_billing_preview_before_practice(uuid,text,boolean,text)']) {
        assert.match(await definition(name), /when p_offer_id='core_locum' then 'standard' when public\.has_limited_paid_purchase\(p_profile_id,p_livemode\) then 'earlybird'/, name);
      }
    });

    await t.test('the settings can no longer be set to standard', async () => {
      await assert.rejects(sql("update access_policy_settings set limited_self_service_price_phase='standard'"), /limited_self_service_price_phase_check/);
      await assert.rejects(sql("update access_policy_settings set price_phase='standard'"), /access_policy_settings_price_phase_check/);
    });

    await t.test('the public offer answers $99 while founder places remain, then $149; never another amount', async () => {
      assert.deepEqual(await offer(), { schemaVersion: 1, phase: 'founding', annualCents: 9900, checkoutEnabled: true, availability: 'available', bundleAvailable: false });
      await sql("update access_policy_settings set limited_self_service_price_phase='earlybird'");
      assert.deepEqual(await offer(), { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: true, availability: 'available', bundleAvailable: true });
      await sql("update access_policy_settings set limited_checkout_enabled=false");
      assert.deepEqual(await offer(), { schemaVersion: 1, phase: 'earlybird', annualCents: 14900, checkoutEnabled: false, availability: 'paused', bundleAvailable: true });
      await sql("update access_policy_settings set limited_checkout_enabled=true,limited_self_service_price_phase='founding'");
    });

    await t.test('a returning buyer is offered Credential at $149 with the trial, or the package at $245', async () => {
      assert.equal((await eligibility(1)).price_phase, 'earlybird');
      assert.equal((await eligibility(1)).bundle_available, true);
      const s = await db.snapshot(1);
      assert.deepEqual([s.checkoutEligible, s.pricePhase, s.bundleAvailable], [true, 'earlybird', true]);
      const v = await db.preview(1, 'core');
      assert.deepEqual([v.price_phase, v.annual_cents], ['earlybird', 14900]);
      assert.equal(v.consent_text, `Credential: USD 149 due now, then USD 149 each year while this subscription remains active. Cancel before a scheduled charge to avoid it.${TRIAL}`);
      const c = await db.claim(1, v);
      assert.equal(c.state, 'claimed', JSON.stringify(c));
      assert.deepEqual([c.quote.price_phase, c.quote.annual_cents, c.quote.public_founding_slot], ['earlybird', 14900, null]);
      await db.pinSave(1, c, 'cs_NoStandard1b');
      assert.equal(await db.settle(1, c, { subscription: 'sub_NoStandard1b' }), 'applied');
      const paid = await db.snapshot(1);
      assert.equal(paid.purchasedOfferId, 'core');
      assert.equal(paid.practiceIncluded, false, 'a $149 membership is not a founding one');
      // The package for another returning buyer: its stored label is still 'standard', its price $245.
      await buyThenCancel(2);
      const b = await db.claim(2, await db.preview(2, 'core_locum'));
      assert.equal(b.state, 'claimed', JSON.stringify(b));
      assert.deepEqual([b.quote.offer_id, b.quote.price_phase, b.quote.annual_cents], ['core_locum', 'standard', 24500]);
    });

    await t.test('a preview made at $199 before the migration can no longer be claimed', async () => {
      await buyThenCancel(3);
      const stale = JSON.parse(await sql(`insert into limited_billing_previews(profile_id,clerk_subject,livemode,invitation_id,offer_id,price_phase,annual_cents,policy_version,consent_version,consent_text,consent_hash,expires_at)
        select '${pid(3)}','${subject(3)}',true,id,'core','standard',19900,'2026-09-19-credential-practice-v1','2026-09-21-explicit-annual-opt-in-v2','x',encode(sha256(convert_to('x','UTF8')),'hex'),now()+interval '20 minutes'
        from limited_billing_invitations where profile_id='${pid(3)}' returning to_jsonb(limited_billing_previews)`));
      assert.equal((await db.claim(3, stale)).state, 'quote_expired');
    });

    await t.test('after the founders: a new member pays $149 and gets one 30-day Practice trial', async () => {
      await sql("update access_policy_settings set limited_self_service_price_phase='earlybird'");
      await db.enroll(4);
      assert.equal((await eligibility(4)).price_phase, 'earlybird');
      const c = await db.buy(4, 'core');
      assert.deepEqual([c.quote.price_phase, c.quote.annual_cents], ['earlybird', 14900]);
      await db.enroll(5);
      const b = await db.buy(5, 'core_locum');
      assert.deepEqual([b.quote.price_phase, b.quote.annual_cents], ['standard', 24500]);
      assert.equal((await db.snapshot(5)).practiceIncluded, true);
      await sql("update access_policy_settings set limited_self_service_price_phase='founding'");
    });

    await t.test('an invitation prepared at standard is offered $149; a new one cannot name standard', async () => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(6)}','${subject(6)}','pending')`);
      await sql(`insert into limited_billing_invitations(batch_id,email,token_hash,livemode,price_phase,expires_at,review_reason)
        values('reviewed_old','old-standard@example.invalid',repeat('a',64),true,'standard',now()+interval '20 days','Synthetic invitation prepared before the removal')`);
      const signup = await value(`bootstrap_limited_signup('${pid(6)}','${subject(6)}',true,'old-standard@example.invalid')`);
      assert.equal(signup.price_phase, 'earlybird', JSON.stringify(signup));
      assert.equal((await eligibility(6)).price_phase, 'earlybird');
      const row = phase => lit([{ email: `new-${phase}@example.invalid`, tokenHash: 'b'.repeat(64), reviewReason: 'Synthetic review', pricePhase: phase, expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() }]);
      await assert.rejects(value(`prepare_limited_billing_invitations('reviewed_new',true,${row('standard')})`), /invalid reviewed invitation/);
      assert.equal(await value(`prepare_limited_billing_invitations('reviewed_new',true,${row('earlybird')})`), 1);
      assert.match(await definition('reserve_invite_to_join(uuid,text,text,boolean,text,text,integer)'), /not in \(\('founding', 9900\), \('earlybird', 14900\)\) then/);
    });

    await t.test('history is untouched: a purchase stored at $199 is still a valid row', async () => {
      assert.equal(await sql(`select count(*) from pg_constraint where conname in ('limited_billing_quotes_check','limited_paid_purchase_history_check','limited_refund_requests_check') and pg_get_constraintdef(oid) ~ '19900'`), '3');
    });

    await t.test('the rollback puts every routine and both settings checks back, twice', async () => {
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      for (const name of EDITED) {
        assert.equal(await definition(name), before[name].body, name);
        assert.equal(await acl(name), before[name].acl, `${name} grants`);
      }
      await sql("update access_policy_settings set limited_self_service_price_phase='standard'");
      assert.equal((await offer()).annualCents, 19900);
      await sql("update access_policy_settings set limited_self_service_price_phase='founding'");
      // And forward again from the rolled-back state.
      await sql(MIGRATION);
      assert.equal((await db.preview(3, 'core')).annual_cents, 14900);
    });

    await t.test('the founder countdown migration applies on top, in either order, and the offer still names two prices only', async () => {
      const spots = readMigration('20261113130000_public_founder_spots.sql');
      await sql(spots);
      await sql(MIGRATION);
      const founding = await offer();
      assert.deepEqual([founding.phase, founding.annualCents, founding.founderSpotsLeft], ['founding', 9900, 97], 'three founding places were paid in this run');
      await sql("update access_policy_settings set limited_self_service_price_phase='earlybird'");
      assert.deepEqual([(await offer()).annualCents, (await offer()).founderSpotsLeft], [14900, 0]);
      await sql("update access_policy_settings set limited_self_service_price_phase='founding'");
    });
  } finally { await db.close(); }
});
