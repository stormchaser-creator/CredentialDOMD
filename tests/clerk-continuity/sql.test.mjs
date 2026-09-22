import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
// On macOS the postmaster aborts with "postmaster became multithreaded
// during startup" unless a valid locale is set, so every pg spawn below
// inherits this rather than the ambient environment.
const PG_ENV = { ...process.env, LC_ALL: 'C' };
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalMembers } from '../../scripts/clerk-continuity-plan.mjs';

// Disposable PostgreSQL, synthetic identities, Unix socket only; no live DB URL.
const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = await readFile(new URL('../../supabase/migrations/20260920120000_clerk_identity_continuity.sql', import.meta.url), 'utf8');
const temp = await mkdtemp(join(tmpdir(), 'credentialdomd-continuity-sql-'));
const data = join(temp, 'data');
const args = ['-h', temp, '-p', '55479', '-U', userInfo().username, '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
const query = sql => execFileSync(`${bin}/psql`, [...args, '-c', sql], { encoding: 'utf8', env: PG_ENV }).trim();
const run = promisify(execFile);
let started = false;

test('continuity SQL binding, recovery journal, privileges, RLS and concurrent claims', {
  // A machine without PostgreSQL cannot run this, and a hard failure there
  // would block a deploy for a missing tool rather than a broken change.
  // Set PG_BIN to point at the binaries.
  skip: existsSync(join(bin, 'initdb')) ? false : `PostgreSQL not found at ${bin}; set PG_BIN`,
}, async t => {
  try {
    execFileSync(`${bin}/initdb`, ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe', env: PG_ENV });
    execFileSync(`${bin}/pg_ctl`, ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${temp} -p 55479 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe', env: PG_ENV });
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
      create policy subscriptions_owner_select on subscriptions for select to authenticated using(auth_user_id=auth.jwt()->>'sub');
      insert into subscriptions(auth_user_id) values('user_DevA'),('user_DevB');
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text unique);
      alter table storage.objects enable row level security;
      grant select,insert,update,delete on storage.objects to authenticated;
      create policy documents_owner on storage.objects for all to authenticated using(bucket_id='documents' and split_part(name,'/',1)=auth.jwt()->>'sub') with check(bucket_id='documents' and split_part(name,'/',1)=auth.jwt()->>'sub');
      grant select,insert,update on profiles to authenticated,service_role;
      insert into profiles(id,auth_user_id,email,access_status,is_founding_member,founding_number,created_at) values
        ('11111111-1111-4111-8111-111111111111','user_DevA','editable-wrong@example.test','active',true,4,'2026-01-01'),
        ('22222222-2222-4222-8222-222222222222','user_DevB','a@example.test','pending',false,null,'2026-02-01'),
        ('33333333-3333-4333-8333-333333333333','user_Competing','competing@example.test','pending',false,null,'2026-02-01');
      insert into documents values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','user_DevA/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      insert into documents values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111',null);
      insert into storage.objects(bucket_id,name) values('documents','user_DevA/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('documents','user_DevB/bbb');
      insert into storage.objects(bucket_id,name) values('documents','user_DevA/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      insert into access_grants values('11111111-1111-4111-8111-111111111111','user_DevA','lifetime','2026-01-01',null);
      create table synthetic_manifest(value jsonb);
      insert into synthetic_manifest values('[
        ["11111111-1111-4111-8111-111111111111","user_DevA","a@example.test",1789820000000,1767225600000,true],
        ["22222222-2222-4222-8222-222222222222","user_DevB","b@example.test",1789820000000,1767225600000,true],
        [null,"user_DevNoProfile","new@example.test",1789820000000,1767225600000,true],
        [null,"user_DevLater","later@example.test",1789920000000,1789910000000,false],
        [null,"user_DevRace","race@example.test",1789820000000,1767225600000,true]
      ]');
      create function synthetic_hash() returns text language sql as $$select encode(sha256(convert_to('['||string_agg(e.value::text,',' order by (e.value->>1) collate "C")||']','UTF8')),'hex') from synthetic_manifest m,jsonb_array_elements(m.value)e$$;
      create function source_proof(sub text,mail text,created bigint default 1767225600000,updated bigint default 1789820000000) returns jsonb language sql as $$select jsonb_build_object('subject',sub,'email',mail,'issuer','https://synthetic.clerk.accounts.dev','createdMs',created,'updatedMs',updated,'checkedAt',clock_timestamp())$$;
    `);
    query(migration);
    const initialize = (subject,email,proof='null') => `initialize_clerk_profile('${subject}','${email}','https://clerk.credentialdomd.com',1789920000000,clock_timestamp(),${proof})`;
    const result = expression => JSON.parse(query(`select ${expression}`));
    await t.test('migration is idempotent and privileges deny raw client or service journal writes', () => {
      query(migration);
      for (const role of ['anon','authenticated']) assert.equal(query(`select has_function_privilege('${role}','initialize_clerk_profile(text,text,text,bigint,timestamptz,jsonb)','execute')`),'f');
      assert.equal(query(`select has_table_privilege('service_role','clerk_continuity_accounts','update')`),'f');
      assert.equal(result(initialize('user_ProdA','a@example.test')).state,'disabled');
    });
    await t.test('reviewed staging is idempotent and rejects changed evidence', () => {
      const expected=createHash('sha256').update(canonicalMembers(JSON.parse(query('select value from synthetic_manifest')))).digest('hex');
      assert.equal(query('select synthetic_hash()'),expected);
      const stage=`stage_clerk_continuity('99999999-9999-4999-8999-999999999999','https://synthetic.clerk.accounts.dev','https://clerk.credentialdomd.com','2026-09-19',synthetic_hash(),(select value from synthetic_manifest))`;
      assert.equal(result(stage).state,'staged'); assert.equal(result(stage).state,'existing');
      assert.throws(()=>query(`select stage_clerk_continuity('99999999-9999-4999-8999-999999999999','https://synthetic.clerk.accounts.dev','https://clerk.credentialdomd.com','2026-09-19',repeat('0',64),(select value from synthetic_manifest))`),/hash mismatch/);
      assert.equal(query('select count(*) from clerk_continuity_events'),'5');
      query(`select set_clerk_continuity_enabled('99999999-9999-4999-8999-999999999999',synthetic_hash(),true)`);
    });
    await t.test('fresh dev proof is mandatory and stale/different source assertions cannot bind',()=>{
      assert.equal(result(initialize('user_ProdA','a@example.test')).state,'source_identity_unavailable');
      for(const proof of ["source_proof('user_DevB','a@example.test')", "source_proof('user_DevA','changed@example.test')", "source_proof('user_DevA','a@example.test')||jsonb_build_object('checkedAt',clock_timestamp()-interval '1 hour')", "source_proof('user_DevA','a@example.test',1767225600001)"]){
        assert.equal(result(initialize('user_ProdA','a@example.test',proof)).state,'source_identity_unavailable');
      }
      assert.equal(query(`select auth_user_id from profiles where id='11111111-1111-4111-8111-111111111111'`),'user_DevA');
    });
    await t.test('destination conflict leaves the existing source profile and evidence intact',()=>{
      assert.equal(result(initialize('user_Competing','a@example.test',"source_proof('user_DevA','a@example.test')")).state,'identity_conflict');
      assert.equal(query(`select count(*) from clerk_continuity_events where kind='bound'`),'0');
    });
    await t.test('atomic binding preserves UUID, grants, founding status, rows and paths',()=>{
      const out=result(initialize('user_ProdA','a@example.test',"source_proof('user_DevA','a@example.test')"));
      assert.equal(out.profileId,'11111111-1111-4111-8111-111111111111'); assert.equal(out.state,'bound');
      assert.equal(query(`select access_status||':'||is_founding_member::text||':'||founding_number from profiles where id='${out.profileId}'`),'active:true:4');
      assert.equal(query('select clerk_subject from access_grants'),'user_DevA');
      assert.equal(query("select storage_path from documents where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"),'user_DevA/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      assert.equal(query("select storage_path from documents where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'"),'user_DevA/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      assert.equal(query("select details->>'recoveredDocumentPaths' from clerk_continuity_events where kind='bound'"),'1');
      assert.equal(query(`select continuity_owns_subject('${out.profileId}','user_ProdA','user_DevA')`),'t');
      assert.equal(query(`select continuity_owns_subject('${out.profileId}','user_Competing','user_DevA')`),'f');
      assert.equal(result(initialize('user_ProdA','changed-now-verified@example.test')).profileId,out.profileId);
      assert.equal(query(`select count(*) from clerk_continuity_events where kind='bound'`),'1');
    });
    await t.test('retired development and direct production inserts cannot create duplicate profiles',()=>{
      assert.throws(()=>query(`insert into profiles(id,auth_user_id) values(gen_random_uuid(),'user_DevA')`),/retired identity/);
      assert.throws(()=>query(`set role authenticated; select set_config('request.jwt.claims','{"sub":"user_Attempt","iss":"https://clerk.credentialdomd.com"}',false); insert into profiles(id,auth_user_id) values(gen_random_uuid(),'user_Attempt')`),/protected initialization/);
    });
    const scoped=(sub,iss,sql)=>query(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${sub}","iss":"${iss}"}',false); ${sql}`).split('\n').at(-1);
    await t.test('storage RLS gives old path to bound production owner and denies retired dev, wrong owner/issuer',()=>{
      assert.equal(scoped('user_ProdA','https://clerk.credentialdomd.com',`select count(*) from storage.objects where name like 'user_DevA/%'`),'2');
      assert.equal(scoped('user_DevA','https://synthetic.clerk.accounts.dev',`select count(*) from storage.objects where name like 'user_DevA/%'`),'0');
      assert.equal(scoped('user_Competing','https://clerk.credentialdomd.com',`select count(*) from storage.objects where name like 'user_DevA/%'`),'0');
      assert.equal(scoped('user_ProdA','https://wrong.example',`select count(*) from storage.objects where name like 'user_DevA/%'`),'0');
      assert.throws(()=>scoped('user_DevA','https://synthetic.clerk.accounts.dev',`insert into storage.objects(bucket_id,name) values('documents','user_DevA/new')`),/row-level security/);
      assert.equal(scoped('user_ProdA','https://clerk.credentialdomd.com',`select owns_continuity_document('user_DevA/../user_DevB/bbb')`),'f');
    });
    await t.test('historical subscription evidence stays immutable while bound development reads retire',()=>{
      assert.equal(scoped('user_DevA','https://synthetic.clerk.accounts.dev','select count(*) from subscriptions'),'0');
      assert.equal(scoped('user_DevB','https://synthetic.clerk.accounts.dev','select count(*) from subscriptions'),'1');
      assert.equal(scoped('user_Competing','https://clerk.credentialdomd.com','select count(*) from subscriptions'),'0');
      assert.equal(query("select count(*) from subscriptions where auth_user_id='user_DevA'"),'1');
    });
    await t.test('missing legacy profile allocates once and retains pre-cutoff promise evidence',()=>{
      const out=result(initialize('user_ProdNoProfile','new@example.test',"source_proof('user_DevNoProfile','new@example.test')"));
      assert.equal(out.state,'bound'); assert.equal(out.continuity.sourceSubject,'user_DevNoProfile');
      assert.equal(result(initialize('user_ProdNoProfile','new@example.test')).profileId,out.profileId);
      assert.equal(result(`continuity_lifetime_source('${out.profileId}','user_ProdNoProfile')`).sourceSubject,'user_DevNoProfile');
      assert.equal(query(`select access_status from profiles where id='${out.profileId}'`),'pending');
      const late=result(initialize('user_ProdLater','later@example.test',"source_proof('user_DevLater','later@example.test',1789910000000,1789920000000)"));
      assert.equal(query(`select continuity_lifetime_source('${late.profileId}','user_ProdLater') is null`),'t');
    });
    await t.test('true new signup creates ordinary pending profile, never editable-email inheritance',()=>{
      const out=result(initialize('user_Future','editable-wrong@example.test'));
      assert.equal(out.state,'current'); assert.equal(out.continuity,null);
      assert.notEqual(out.profileId,'11111111-1111-4111-8111-111111111111');
      assert.equal(query(`select access_status||':'||is_founding_member::text from profiles where id='${out.profileId}'`),'pending:false');
    });
    await t.test('closed legacy account cannot be rebound and cannot restore lifetime evidence',()=>{
      query(`insert into account_tombstones values('22222222-2222-4222-8222-222222222222')`);
      assert.equal(result(initialize('user_ProdB','b@example.test',"source_proof('user_DevB','b@example.test')")).state,'account_unavailable');
      assert.equal(query(`select auth_user_id from profiles where id='22222222-2222-4222-8222-222222222222'`),'user_DevB');
    });
    await t.test('two simultaneous targets cannot claim the same legacy identity',async()=>{
      const outputs=await Promise.all(['user_RaceOne','user_RaceTwo'].map(subject=>run(`${bin}/psql`,[...args,'-c',`select ${initialize(subject,'race@example.test',"source_proof('user_DevRace','race@example.test')")}`])));
      const states=outputs.map(o=>JSON.parse(o.stdout.trim()).state).sort();
      assert.deepEqual(states,['bound','identity_conflict']);
      assert.equal(query(`select count(*) from profiles where auth_user_id in ('user_RaceOne','user_RaceTwo')`),'1');
    });
    await t.test('proof expiry during a real lock wait rolls back a new profile',async()=>{
      const holding=run(`${bin}/psql`,[...args,'-c',"begin; select pg_advisory_xact_lock(8220,1); select pg_sleep(1); commit;"]);
      for(let i=0;i<100;i++) {
        if(query("select exists(select 1 from pg_locks where locktype='advisory' and classid=8220 and objid=1 and granted)")==='t') break;
        await new Promise(resolve=>setTimeout(resolve,5));
        if(i===99) assert.fail('synthetic lock was not acquired');
      }
      const waiting=run(`${bin}/psql`,[...args,'-c',"select initialize_clerk_profile('user_ExpiredWait','expired@example.test','https://clerk.credentialdomd.com',1789920000000,clock_timestamp()-interval '5 minutes'+interval '300 milliseconds')"]);
      await assert.rejects(waiting,/provider identity proof expired/);
      await holding;
      assert.equal(query("select count(*) from profiles where auth_user_id='user_ExpiredWait'"),'0');
    });
    await writeFile(join(temp,'result.txt'),'Synthetic continuity SQL suite passed; no live connection.\n');
  } finally {
    if(started) execFileSync(`${bin}/pg_ctl`,['-D',data,'-m','fast','-w','stop'],{stdio:'pipe',env:PG_ENV});
  }
});
