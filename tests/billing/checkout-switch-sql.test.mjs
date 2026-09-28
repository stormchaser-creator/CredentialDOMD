// A buyer can switch offer, or retry, when the previous Checkout never took
// payment (20260928180000_checkout_offer_switch.sql), proven on a real
// PostgreSQL with the actual billing, access, signup, deferred-beta, founding
// cap and lifetime-gift migrations underneath it.
//
// Before the fix: Credential opened in Stripe and cancelled, then Credential +
// Practice chosen, answered offer_conflict until Credential was chosen again;
// a first attempt whose Stripe call failed answered reconciliation_required
// after 23 hours, for good.
//
// Synthetic identities, customers and sessions only; no provider request,
// network listener, credential or production row. The provider-backed
// identity-continuity helpers are the same explicit stubs the Python billing
// suites use (tests/billing/postgres-*.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pgBin, pgSkip } from '../credential-portal/postgresFixture.mjs';

// Own port: node --test runs files in parallel and the other suites hold theirs.
const PORT = '58917';
const run = promisify(execFile);
const read = name => fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const MIGRATION = read('20260928180000_checkout_offer_switch.sql');
const ROLLBACK = fs.readFileSync(new URL('../../docs/rollback/20260928180000_checkout_offer_switch.rollback.sql', import.meta.url), 'utf8');
const CHAIN = ['20260918_founding_billing_readiness.sql', '20260919183000_access_policy_foundation.sql',
  '20260919213000_limited_launch_billing.sql', '20260919233000_limited_paid_purchase_history.sql',
  '20260920220000_self_service_signup.sql', '20260920221000_continuity_access_evidence.sql',
  '20260921010000_admin_lifetime_access.sql', '20260921015000_restrict_closed_account_probe.sql',
  '20260921020000_beta_deferred_billing.sql', '20260922010000_public_founding_capacity.sql',
  '20260923010000_lifetime_gift_reservations.sql'];
const WRAPPER = 'claim_limited_billing_checkout(uuid,text,boolean,text,uuid,text)';

const text = value => `'${String(value).replaceAll("'", "''")}'`;
const lit = value => `${text(JSON.stringify(value))}::jsonb`;
const pid = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = n => `user_Switch${n}`;

async function startPostgres() {
  const bin = pgBin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-switch-'));
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG'))), LC_ALL: 'C' };
  const exec = (name, args) => run(path.join(bin, name), args, { env, maxBuffer: 8 * 1024 * 1024 });
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
  const as = (who, statement) => psql(`begin;set local role ${who};set local request.jwt.claims=${text(JSON.stringify({ role: who, sub: 'user_Fixture' }))};${statement};commit;`);
  const value = async expression => {
    const result = await as('service_role', `select to_jsonb((${expression}))`);
    if (result.code) throw new Error(result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const close = async () => { await exec('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'fast', '-w', 'stop']); fs.rmSync(root, { recursive: true, force: true }); };
  return { sql, as, value, close };
}

test('an unpaid Checkout can be retired so the buyer switches offer or retries, never two live sessions', { skip: pgSkip(), timeout: 180000 }, async t => {
  const db = await startPostgres();
  const { sql, as, value } = db;
  try {
    await sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;grant usage on schema auth to authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table profiles(id uuid primary key,auth_user_id text unique,access_status text,founding_number integer,created_at timestamptz default now(),deleted_at timestamptz,name text,email text);
      grant select on profiles to authenticated,service_role;
      create table fixture_continuity(profile_id uuid,current_subject text,evidence_subject text);
      create function continuity_owns_subject(pid uuid,current_subject text,evidence_subject text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from profiles p where p.id=pid and p.auth_user_id=current_subject) and (current_subject=evidence_subject or exists(select 1 from fixture_continuity f where f.profile_id=pid and f.current_subject=$2 and f.evidence_subject=$3))$$;
      create function continuity_lifetime_source(uuid,text) returns jsonb language sql stable as $$select null::jsonb$$;
      create table clerk_continuity_accounts(verified_primary_email text primary key,lifetime_eligible boolean not null);
      create table account_tombstones(profile_id uuid primary key);
      create table app_admins(profile_id uuid primary key);
      create table subscriptions(id bigserial primary key,auth_user_id text,subscription_id text,status text);
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
    const mailbox = read('20260918a_mailbox_account_events.sql');
    const start = mailbox.indexOf('create or replace function public.account_is_closed(p_profile uuid)');
    const ending = 'grant execute on function public.account_is_closed(uuid) to postgres, service_role;';
    await sql(mailbox.slice(start, mailbox.indexOf(ending, start) + ending.length));
    for (const name of CHAIN) await sql(read(name));

    const definition = name => sql(`select pg_get_functiondef('${name}'::regprocedure)`);
    const acl = name => sql(`select proacl::text from pg_proc where oid='${name}'::regprocedure`);
    const originalWrapper = await definition(WRAPPER);
    const originalAcl = await acl(WRAPPER);
    const gates = 'select (select count(*) from billing_checkout_attempts)::text||(select count(*) from limited_billing_quotes)::text||(enforcement_enabled or limited_checkout_enabled or limited_invitation_enabled or limited_self_service_enabled or public_founding_enabled)::text from access_policy_settings';
    const gatesBefore = await sql(gates);
    await sql(MIGRATION);
    await sql(MIGRATION);

    await t.test('applies twice, changes no gate or row, keeps the reviewed claim body byte for byte', async () => {
      assert.equal(await sql(gates), gatesBefore);
      assert.equal((await definition('claim_limited_billing_checkout_before_switch(uuid,text,boolean,text,uuid,text)'))
        .replace('claim_limited_billing_checkout_before_switch(', 'claim_limited_billing_checkout('), originalWrapper);
      assert.equal(await acl(WRAPPER), originalAcl);
    });

    await t.test('only the service can claim or retire; nobody calls the private bodies', async () => {
      const denied = async (who, call) => { const r = await as(who, call); return r.code !== 0 && /permission denied for function/.test(r.stderr); };
      const privateCalls = [
        `select claim_limited_billing_checkout_before_switch('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`,
        `select limited_checkout_supersede_candidate('${pid(1)}','${subject(1)}',true)`,
      ];
      for (const who of ['anon', 'authenticated', 'service_role']) for (const call of privateCalls) assert.ok(await denied(who, call), `${who}: ${call}`);
      for (const who of ['anon', 'authenticated']) {
        assert.ok(await denied(who, `select supersede_limited_checkout('${pid(1)}','${subject(1)}',true,gen_random_uuid(),'{}')`));
        assert.ok(await denied(who, `select claim_limited_billing_checkout('${pid(1)}','${subject(1)}',true,'core',gen_random_uuid(),'x')`));
      }
      assert.equal(await value(`supersede_limited_checkout('${pid(1)}','${subject(1)}',true,gen_random_uuid(),'{}')`), false);
    });

    // One reviewed promise (a historical no-card beta holder), then public
    // founding checkout exactly as launched.
    const promise = 'promise-switch@example.invalid';
    const manifest = JSON.stringify([promise]);
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    await value(`seal_limited_free_beta_cohort('synthetic_switch','${digest}',${lit([promise])},'Synthetic reviewed switch cohort')`);
    assert.deepEqual(await value(`prepare_founding_program(true,'synthetic_switch','${digest}',1)`), { state: 'prepared', promised: 1, capacity: 100 });
    await sql("update access_policy_settings set limited_self_service_enabled=true,limited_checkout_enabled=true,enforcement_enabled=true,public_founding_enabled=true,limited_self_service_price_phase='founding'");

    const enroll = async (n, email = `switch${n}@example.invalid`) => {
      await sql(`insert into profiles(id,auth_user_id,access_status) values('${pid(n)}','${subject(n)}','pending')`);
      const result = await value(`bootstrap_limited_signup('${pid(n)}','${subject(n)}',true,${text(email)})`);
      await as('service_role', `insert into billing_accounts(profile_id,livemode,stripe_customer_id) values('${pid(n)}',true,'cus_Switch${n}')`);
      return result;
    };
    const preview = (n, offer) => value(`create_limited_billing_preview('${pid(n)}','${subject(n)}',true,'${offer}')`);
    const claim = (n, v) => value(`claim_limited_billing_checkout('${pid(n)}','${subject(n)}',true,'${v.offer_id}','${v.id}','${v.consent_hash}')`);
    const pinSave = async (n, c, session) => {
      const r = await as('service_role', `select pin_limited_billing_price('${c.attempt_id}','${pid(n)}','${subject(n)}',true,'prod_Switch','price_Switch');select save_billing_checkout('${pid(n)}',true,'${c.attempt_id}','${c.token}','${session}')`);
      assert.equal(r.code, 0, r.stderr);
    };
    const proof = (n, attemptId, sessions, patch = {}) => ({ attempt_id: attemptId, customer_id: `cus_Switch${n}`, status: 'expired', subscription_id: null, session_ids: sessions, ...patch });
    const supersede = (n, attemptId, p) => value(`supersede_limited_checkout('${pid(n)}','${subject(n)}',true,'${attemptId}',${lit(p)})`);
    const attempt = async n => JSON.parse(await sql(`select to_jsonb(a) from billing_checkout_attempts a where profile_id='${pid(n)}' and livemode`) || 'null');
    const slots = where => sql(`select count(*) from limited_founding_slots where livemode and ${where}`).then(Number);

    await t.test('switching after a cancelled Checkout: the saved session is proven expired, the place returns, the other offer claims', async () => {
      await enroll(1);
      const core = await preview(1, 'core');
      const first = await claim(1, core);
      assert.equal(first.state, 'claimed');
      assert.equal(first.quote.annual_cents, 9900);
      assert.ok(first.quote.public_founding_slot);
      await pinSave(1, first, 'cs_Switch1First');
      const occupied = await slots('true');
      const quoteBefore = await sql(`select to_jsonb(q) from limited_billing_quotes q where attempt_id='${first.attempt_id}'`);

      const bundle = await preview(1, 'core_locum');
      const refused = await claim(1, bundle);
      assert.equal(refused.state, 'offer_conflict');
      assert.deepEqual({ ...refused.prior, created_at: undefined }, { attempt_id: first.attempt_id, state: 'open', session_id: 'cs_Switch1First', offer_id: 'core', created_at: undefined });
      assert.equal((await attempt(1)).state, 'open', 'a refused claim changes nothing');

      for (const bad of [proof(1, first.attempt_id, []), proof(1, first.attempt_id, ['cs_Switch1Other']),
        proof(1, first.attempt_id, ['cs_Switch1First'], { customer_id: 'cus_Other' }), proof(1, first.attempt_id, ['cs_Switch1First'], { status: 'open' }),
        proof(1, first.attempt_id, ['cs_Switch1First'], { subscription_id: 'sub_Switch1' }), proof(1, crypto.randomUUID(), ['cs_Switch1First']),
        proof(1, first.attempt_id, ['not-a-session'])]) {
        assert.equal(await supersede(1, first.attempt_id, bad), false, JSON.stringify(bad));
      }
      assert.equal(await supersede(2, first.attempt_id, proof(1, first.attempt_id, ['cs_Switch1First'])), false, 'another profile cannot retire it');
      assert.equal((await attempt(1)).state, 'open');
      assert.equal(await slots('true'), occupied);

      assert.equal(await supersede(1, first.attempt_id, proof(1, first.attempt_id, ['cs_Switch1First'])), true);
      assert.equal((await attempt(1)).state, 'expired');
      assert.equal(await slots('true'), occupied - 1, 'the unpaid public place is free again');
      assert.equal(await supersede(1, first.attempt_id, proof(1, first.attempt_id, ['cs_Switch1First'])), true, 'retiring twice is not an error');
      assert.equal(await sql(`select to_jsonb(q) from limited_billing_quotes q where attempt_id='${first.attempt_id}'`), quoteBefore, 'the accepted quote is never rewritten');

      const second = await claim(1, bundle);
      assert.equal(second.state, 'claimed');
      assert.notEqual(second.attempt_id, first.attempt_id);
      assert.equal(second.quote.offer_id, 'core_locum');
      assert.equal(second.quote.annual_cents, 24500);
      assert.equal(second.quote.public_founding_slot, null);

      // And back again: the bundle session was opened and cancelled too.
      await pinSave(1, second, 'cs_Switch1Second');
      const back = await claim(1, await preview(1, 'core'));
      assert.equal(back.state, 'offer_conflict');
      assert.equal(back.prior.attempt_id, second.attempt_id);
      assert.equal(await supersede(1, second.attempt_id, proof(1, second.attempt_id, ['cs_Switch1Second'])), true);
      const third = await claim(1, await preview(1, 'core'));
      assert.equal(third.state, 'claimed');
      assert.equal(third.quote.annual_cents, 9900);
      assert.ok(third.quote.public_founding_slot, 'the $99 place is reserved again for the new attempt');
    });

    await t.test('a creating attempt is never retired inside its lease; after 23 hours it no longer locks the buyer out', async () => {
      await enroll(2);
      const first = await claim(2, await preview(2, 'core_locum'));
      assert.equal(first.state, 'claimed');
      const live = await claim(2, await preview(2, 'core'));
      assert.equal(live.state, 'offer_conflict');
      assert.equal(live.prior, undefined, 'a worker inside its lease may still be creating the session');
      assert.equal(await supersede(2, first.attempt_id, proof(2, first.attempt_id, [])), false);

      // The Stripe call failed: the lease ran out and a day went by.
      await sql(`update billing_checkout_attempts set lease_until=clock_timestamp()-interval '1 second',created_at=now()-interval '23 hours 30 minutes' where profile_id='${pid(2)}'`);
      const stuck = await claim(2, await preview(2, 'core_locum'));
      assert.equal(stuck.state, 'reconciliation_required');
      assert.equal(stuck.prior.attempt_id, first.attempt_id);
      assert.equal(stuck.prior.state, 'creating');
      assert.equal(stuck.prior.session_id, null);
      assert.equal(await supersede(2, first.attempt_id, proof(2, first.attempt_id, ['cs_Switch2Orphan'])), true);
      const retried = await claim(2, await preview(2, 'core_locum'));
      assert.equal(retried.state, 'claimed');
      assert.notEqual(retried.attempt_id, first.attempt_id);
    });

    await t.test('a refused same-offer claim keeps no lease it took in passing', async () => {
      await enroll(3);
      const first = await claim(3, await preview(3, 'core'));
      assert.equal(first.quote.price_phase, 'founding');
      await sql(`update billing_checkout_attempts set lease_until=clock_timestamp()-interval '1 second' where profile_id='${pid(3)}'`);
      const before = await attempt(3);
      await sql("update access_policy_settings set limited_self_service_price_phase='earlybird'");
      try {
        const changed = await preview(3, 'core');
        assert.equal(changed.annual_cents, 14900);
        const refused = await claim(3, changed);
        assert.equal(refused.state, 'offer_conflict');
        const after = await attempt(3);
        assert.equal(after.lease_token, before.lease_token);
        assert.equal(after.lease_until, before.lease_until);
        assert.equal(refused.prior.attempt_id, first.attempt_id);
        assert.equal(await supersede(3, first.attempt_id, proof(3, first.attempt_id, [])), true);
        const fresh = await claim(3, changed);
        assert.equal(fresh.state, 'claimed');
        assert.equal(fresh.quote.annual_cents, 14900);
        assert.equal(await slots(`profile_id='${pid(3)}'`), 0, 'the retired founding reservation was returned');
      } finally {
        await sql("update access_policy_settings set limited_self_service_price_phase='founding'");
      }
    });

    await t.test('a subscription, a committed place or a paid quote is never retired', async () => {
      await enroll(4);
      const first = await claim(4, await preview(4, 'core'));
      await pinSave(4, first, 'cs_Switch4');
      await sql(`update limited_founding_slots set state='committed',subscription_id='sub_Switch4' where attempt_id='${first.attempt_id}'`);
      const committed = await claim(4, await preview(4, 'core_locum'));
      assert.equal(committed.state, 'offer_conflict');
      assert.equal(committed.prior, undefined);
      assert.equal(await supersede(4, first.attempt_id, proof(4, first.attempt_id, ['cs_Switch4'])), false);
      await sql(`update limited_founding_slots set state='reserved',subscription_id=null where attempt_id='${first.attempt_id}'`);

      for (const status of ['incomplete', 'active', 'past_due']) {
        await sql(`insert into billing_subscriptions(profile_id,livemode,subscription_id,offer_id,status,membership_active,period_end,last_event_id,last_event_created)
          values('${pid(4)}',true,'sub_Switch4','core','${status}',false,now()+interval '1 day','evt_Switch4',1)`);
        const blocked = await claim(4, await preview(4, 'core_locum'));
        assert.ok(['offer_conflict', 'reconciliation_required'].includes(blocked.state), blocked.state);
        assert.equal(blocked.prior, undefined, status);
        assert.equal(await supersede(4, first.attempt_id, proof(4, first.attempt_id, ['cs_Switch4'])), false, status);
        await sql(`delete from billing_subscriptions where profile_id='${pid(4)}'`);
      }
      assert.equal((await attempt(4)).state, 'open');
    });

    await t.test('racing retirements and claims leave exactly one new attempt; a late retirement cannot touch it', async () => {
      await enroll(5);
      const first = await claim(5, await preview(5, 'core'));
      await pinSave(5, first, 'cs_Switch5');
      const bundle = await preview(5, 'core_locum');
      const retired = await Promise.all(Array.from({ length: 8 }, () => supersede(5, first.attempt_id, proof(5, first.attempt_id, ['cs_Switch5']))));
      assert.deepEqual(retired, Array(8).fill(true));
      const claims = await Promise.all(Array.from({ length: 8 }, () => claim(5, bundle)));
      const won = claims.filter(c => c.state === 'claimed');
      assert.equal(won.length, 1, JSON.stringify(claims.map(c => c.state)));
      assert.ok(claims.every(c => ['claimed', 'busy'].includes(c.state)));
      assert.equal(Number(await sql(`select count(*) from limited_billing_quotes where profile_id='${pid(5)}'`)), 2);
      assert.equal(await supersede(5, first.attempt_id, proof(5, first.attempt_id, ['cs_Switch5'])), false, 'the old attempt is gone');
      assert.equal(await supersede(5, won[0].attempt_id, proof(5, won[0].attempt_id, [])), false, 'the new one is inside its lease');
      const now = await attempt(5);
      assert.equal(now.attempt_id, won[0].attempt_id);
      assert.equal(now.state, 'creating');
    });

    await t.test('a no-card beta holder can switch the deferred offer; the promised place goes back to them', async () => {
      const enrolled = await enroll(6, promise);
      assert.equal(enrolled.kind, 'grandfathered_beta');
      const core = await preview(6, 'core');
      assert.ok(core.billing_start_at);
      const first = await claim(6, core);
      assert.equal(first.state, 'claimed');
      await pinSave(6, first, 'cs_Switch6');
      assert.ok(await value(`limited_deferred_checkout_resume('${pid(6)}','${subject(6)}',true,null)`));
      const bundle = await preview(6, 'core_locum');
      assert.ok(bundle.billing_start_at, 'the other offer is also deferred to the original beta end');
      const refused = await claim(6, bundle);
      assert.equal(refused.state, 'offer_conflict');
      assert.equal(await supersede(6, first.attempt_id, proof(6, first.attempt_id, ['cs_Switch6'])), true);
      assert.equal(await sql(`select state||':'||coalesce(attempt_id::text,'none') from limited_founding_slots where livemode and promise_email=${text(promise)}`), 'promised:none');
      assert.equal(await value(`limited_deferred_checkout_resume('${pid(6)}','${subject(6)}',true,null)`), null, 'nothing is left to resume');
      const second = await claim(6, bundle);
      assert.equal(second.state, 'claimed');
      assert.equal(second.quote.billing_start_at, core.billing_start_at);
    });

    await t.test('the rollback restores the reviewed wrapper and grant; retired attempts stay valid', async () => {
      await sql(ROLLBACK);
      await sql(ROLLBACK);
      assert.equal(await definition(WRAPPER), originalWrapper);
      assert.equal(await acl(WRAPPER), originalAcl);
      for (const gone of ['claim_limited_billing_checkout_before_switch', 'supersede_limited_checkout', 'limited_checkout_supersede_candidate']) {
        assert.equal(await sql(`select count(*) from pg_proc where proname='${gone}'`), '0', gone);
      }
      await enroll(7);
      const first = await claim(7, await preview(7, 'core_locum'));
      assert.equal(first.state, 'claimed');
      await pinSave(7, first, 'cs_Switch7');
      const refused = await claim(7, await preview(7, 'core'));
      assert.equal(refused.state, 'offer_conflict');
      assert.equal(refused.prior, undefined, 'the old behavior, which the old handler expects');
      await sql(MIGRATION);
      assert.equal((await claim(7, await preview(7, 'core'))).prior.attempt_id, first.attempt_id, 're-applying after a rollback works');
    });
  } finally {
    await db.close();
  }
});
