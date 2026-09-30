// AUTH-008: a paused member (access_status 'revoked') with an identity
// continuity row was refused by claim_clerk_continuity ('account_unavailable'),
// so initialize-clerk-profile answered 409 and the app showed "identity could
// not be verified" with a reload that never helped, instead of Access paused.
// 20260930000000 lets binding ignore access_status (binding grants nothing)
// and keeps refusing a closed account.
//
// Disposable PostgreSQL, Unix socket only, synthetic identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { acquirePgSlot } from '../helpers/pg-slot.mjs';

const PG_ENV = { ...process.env, LC_ALL: 'C' };
const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const read = rel => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');
const CONTINUITY = await read('supabase/migrations/20260920120000_clerk_identity_continuity.sql');
const MIGRATION_PATH = 'supabase/migrations/20260930000000_continuity_binds_paused_accounts.sql';
const ROLLBACK_PATH = 'docs/rollback/20260930000000_continuity_binds_paused_accounts.rollback.sql';
const MIGRATION = existsSync(new URL(`../../${MIGRATION_PATH}`, import.meta.url)) ? await read(MIGRATION_PATH) : null;
const ROLLBACK = existsSync(new URL(`../../${ROLLBACK_PATH}`, import.meta.url)) ? await read(ROLLBACK_PATH) : null;

const LIVE = 'https://clerk.credentialdomd.com';
const DEV = 'https://synthetic.clerk.accounts.dev';
const BOUND = '11111111-1111-4111-8111-1111111111a1';
const PREPARED = '22222222-2222-4222-8222-2222222222a2';
const CLOSED = '33333333-3333-4333-8333-3333333333a3';

test('the migration and its rollback exist and follow the deploy rules', () => {
  assert.ok(MIGRATION, `${MIGRATION_PATH} is missing`);
  assert.ok(ROLLBACK, `${ROLLBACK_PATH} is missing`);
  for (const [name, text] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.doesNotMatch(text, /^\s*(begin|commit)\s*;/im, `${name} has a top-level begin/commit`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.(invalid|test))[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${name} names a real address`);
  }
  const claim = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.claim_clerk_continuity'));
  assert.doesNotMatch(claim.slice(0, claim.indexOf('end $$;')), /access_status/,
    'binding no longer reads access_status');
});

test('a paused continuity member binds and stays paused; a closed one is still refused', {
  skip: existsSync(join(bin, 'initdb')) ? false : `PostgreSQL not found at ${bin}; set PG_BIN`,
}, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'credentialdomd-paused-continuity-'));
  const data = join(temp, 'data');
  const args = ['-h', temp, '-p', '55493', '-U', userInfo().username, '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const query = sql => execFileSync(`${bin}/psql`, [...args, '-c', sql], { encoding: 'utf8', env: PG_ENV }).trim();
  const result = expression => JSON.parse(query(`select ${expression}`));
  let started = false;
  let slot = null;
  try {
    slot = await acquirePgSlot(data);
    execFileSync(`${bin}/initdb`, ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe', env: PG_ENV });
    execFileSync(`${bin}/pg_ctl`, ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${temp} -p 55493 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe', env: PG_ENV });
    started = true;
    query(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
      grant usage on schema auth,storage to authenticated,service_role;
      create table profiles(id uuid primary key, auth_user_id text unique not null, email text,
        access_status text not null default 'pending', is_founding_member boolean default false,
        founding_number integer, created_at timestamptz default now(), deleted_at timestamptz);
      create table account_tombstones(profile_id uuid primary key);
      create function account_is_closed(uuid) returns boolean language sql stable security definer set search_path=public as $$
        select exists(select 1 from account_tombstones where profile_id=$1) or exists(select 1 from profiles where id=$1 and deleted_at is not null)$$;
      create table documents(id uuid primary key,user_id uuid references profiles(id),storage_path text);
      create table access_grants(profile_id uuid,clerk_subject text,kind text,starts_at timestamptz,ends_at timestamptz);
      create table subscriptions(id uuid primary key default gen_random_uuid(),auth_user_id text);
      alter table subscriptions enable row level security;
      grant select on subscriptions to authenticated;
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text unique);
      alter table storage.objects enable row level security;
      grant select,insert,update,delete on storage.objects to authenticated;
      grant select,insert,update on profiles to authenticated,service_role;
      insert into profiles(id,auth_user_id,email,access_status) values
        ('${BOUND}','user_DevPausedBound','editable@example.test','active'),
        ('${PREPARED}','user_DevPausedPrepared','editable2@example.test','revoked'),
        ('${CLOSED}','user_DevPausedClosed','editable3@example.test','revoked');
      create table synthetic_manifest(value jsonb);
      insert into synthetic_manifest values('[
        ["${BOUND}","user_DevPausedBound","bound@example.test",1789820000000,1767225600000,true],
        ["${PREPARED}","user_DevPausedPrepared","prepared@example.test",1789820000000,1767225600000,true],
        ["${CLOSED}","user_DevPausedClosed","closed@example.test",1789820000000,1767225600000,true]
      ]');
      create function synthetic_hash() returns text language sql as $$select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m,jsonb_array_elements(m.value)e$$;
      create function source_proof(sub text,mail text) returns jsonb language sql as $$select jsonb_build_object('subject',sub,'email',mail,'issuer','${DEV}','createdMs',1767225600000,'updatedMs',1789820000000,'checkedAt',clock_timestamp())$$;
    `);
    query(CONTINUITY);
    query(`select stage_clerk_continuity('99999999-9999-4999-8999-9999999999a9','${DEV}','${LIVE}','2026-09-19',synthetic_hash(),(select value from synthetic_manifest))`);
    query(`select set_clerk_continuity_enabled('99999999-9999-4999-8999-9999999999a9',synthetic_hash(),true)`);
    const initialize = (subject, email, proof = 'null') => `initialize_clerk_profile('${subject}','${email}','${LIVE}',1789920000000,clock_timestamp(),${proof})`;
    const status = id => query(`select access_status from profiles where id='${id}'`);

    // Bound while active, then paused by an administrator.
    assert.equal(result(initialize('user_ProdPausedBound', 'bound@example.test', "source_proof('user_DevPausedBound','bound@example.test')")).state, 'bound');
    query(`update profiles set access_status='revoked' where id='${BOUND}'`);
    query(`insert into account_tombstones values('${CLOSED}')`);

    await t.test('the defect: before the migration a paused member cannot initialize', () => {
      assert.equal(result(initialize('user_ProdPausedBound', 'bound@example.test')).state, 'account_unavailable');
    });

    await t.test('applies twice with the grants closed', () => {
      assert.ok(MIGRATION, `${MIGRATION_PATH} is missing`);
      query(MIGRATION); query(MIGRATION);
      for (const role of ['anon', 'authenticated']) {
        assert.equal(query(`select has_function_privilege('${role}','claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)','execute')`), 'f');
      }
      assert.equal(query(`select has_function_privilege('service_role','claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)','execute')`), 't');
    });

    await t.test('bound, then paused: initialize answers bound on the same profile, still paused', () => {
      const out = result(initialize('user_ProdPausedBound', 'bound@example.test'));
      assert.equal(out.state, 'bound');
      assert.equal(out.profileId, BOUND);
      assert.equal(status(BOUND), 'revoked', 'binding grants nothing');
    });

    await t.test('prepared and paused, with a good development proof: binds and stays paused', () => {
      const out = result(initialize('user_ProdPausedPrepared', 'prepared@example.test', "source_proof('user_DevPausedPrepared','prepared@example.test')"));
      assert.equal(out.state, 'bound');
      assert.equal(out.profileId, PREPARED);
      assert.equal(query(`select auth_user_id from profiles where id='${PREPARED}'`), 'user_ProdPausedPrepared');
      assert.equal(status(PREPARED), 'revoked');
      // The proof is still mandatory for a prepared account.
      assert.equal(result(initialize('user_ProdPausedOther', 'prepared@example.test')).state, 'identity_conflict');
    });

    await t.test('a closed account is still refused and never rebound', () => {
      assert.equal(result(initialize('user_ProdPausedClosed', 'closed@example.test', "source_proof('user_DevPausedClosed','closed@example.test')")).state, 'account_unavailable');
      assert.equal(query(`select auth_user_id from profiles where id='${CLOSED}'`), 'user_DevPausedClosed');
    });

    await t.test('rollback restores the refusal byte for byte, runs twice, and forward again', () => {
      assert.ok(ROLLBACK, `${ROLLBACK_PATH} is missing`);
      query(ROLLBACK); query(ROLLBACK);
      const body = query(`select prosrc from pg_proc where oid='public.claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)'::regprocedure`);
      const original = CONTINUITY.match(/create or replace function public\.claim_clerk_continuity\([\s\S]*?as \$\$\n([\s\S]*?)\$\$;/)[1];
      assert.equal(body.trim(), original.trim());
      assert.equal(result(initialize('user_ProdPausedBound', 'bound@example.test')).state, 'account_unavailable');
      assert.equal(query(`select has_function_privilege('authenticated','claim_clerk_continuity(text,text,text,bigint,timestamptz,jsonb)','execute')`), 'f');
      query(MIGRATION);
      assert.equal(result(initialize('user_ProdPausedBound', 'bound@example.test')).state, 'bound');
    });
  } finally {
    if (started) execFileSync(`${bin}/pg_ctl`, ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'pipe', env: PG_ENV });
    slot?.release();
  }
});
