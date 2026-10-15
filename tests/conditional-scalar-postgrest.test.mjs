import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';
import { startIsolatedPostgrest } from './helpers/isolated-postgrest.mjs';

const columns=JSON.parse(readFileSync(new URL('./helpers/record-scalar-catalog.json',import.meta.url))).columns;
const tables=[...new Set(columns.map(c=>c.table))];
const typedTables=new Set(['licenses','insurance','privileges','work_history']);
const A='user_syntheticA',profile='00000000-0000-4000-8000-000000000001';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const lit=s=>`'${String(s).replaceAll("'","''")}'`;
const ident=s=>`"${s.replaceAll('"','""')}"`;
const sqlValue=v=>v===null?'null':typeof v==='string'?lit(v):String(v);
const secret='synthetic-scalar-regression-signing-secret-only';
const field=s=>s.replace(/_([a-z])/g,(_s,c)=>c.toUpperCase());
const camel=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[field(k),v]));
const next=c=>typeof c.value==='boolean'?!c.value:typeof c.value==='number'?c.value+(c.type==='integer'?1:1.25):'historical';
// The exact nullable scalar types/defaults are independently checked against the
// saved catalog. Only disposable tables are created; no operational rows or SQL
// migrations are modified. Other transport columns retain their usual types.
const schema=`
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to authenticated;
${tables.map(table=>`
create table public.${ident(table)}(id uuid primary key,user_id uuid not null,notes text,
 ${typedTables.has(table)?'type text not null,':''}
 ${columns.filter(c=>c.table===table).map(c=>`${ident(c.column)} ${c.type} default ${c.default}`).join(',')},
 ${table==='duty_days'?"date date,contract_id uuid,invoice_id uuid,call_hospital text,call_role text,custom_fields jsonb default '{}'::jsonb,call_periods jsonb default '[]'::jsonb,":''}
 created_at timestamptz default now(),updated_at timestamptz default now());
grant select,insert,update,delete on public.${ident(table)} to authenticated;
alter table public.${ident(table)} enable row level security;
create policy owner on public.${ident(table)} to authenticated using(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid) with check(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'profile_id')::uuid);
`).join('')}`;

test('actual PostgREST: all known scalar defaults acknowledge inserts and protect typed conditional edits',{
  skip:process.env.QA_JSON_POSTGREST!=='1'?'Set QA_JSON_POSTGREST=1 for the disposable local Docker fixture.':false,timeout:240000,
},async t=>{
  const pg=await startIsolatedPostgrest(schema,secret);t.after(pg.cleanup);
  const header=Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const payload=Buffer.from(JSON.stringify({role:'authenticated',sub:A,profile_id:profile,exp:Math.floor(Date.now()/1000)+600})).toString('base64url');
  const jwt=`${header}.${payload}.${createHmac('sha256',secret).update(`${header}.${payload}`).digest('base64url')}`;
  const read=(table,recordId)=>camel(JSON.parse(pg.sql(`select row_to_json(t) from public.${ident(table)} t where id=${lit(recordId)}`)));
  function setup(){
    const requests=[];let beforePatch=null;
    const f=fixture({supabaseJs:{createClient:(_url,key,options)=>createClient(pg.url,key,{...options,accessToken:async()=>{await options.accessToken?.();return jwt;},global:{fetch:async(input,init)=>{
      const url=new URL(input);url.pathname=url.pathname.replace(/^\/rest\/v1/,'');
      if(init.method==='PATCH'&&beforePatch){const fn=beforePatch;beforePatch=null;fn();}
      const response=await fetch(url,init);requests.push({method:init.method,url,value:init.body?JSON.parse(init.body):null,status:response.status,body:await response.clone().json()});return response;
    }}})}});
    return {f,requests,intervene:fn=>{beforePatch=fn;}};
  }
  await t.test('every returning insert is acknowledged before hydration and its immediate offline edit replays with the exact typed base',async()=>{
    for(const [n,c] of columns.entries()){
      const {f,requests}=setup(),item={id:id(100+n),notes:'Initial'};
      await f.api.insertItem(profile,c.collection,item);const saved=read(c.table,item.id);
      assert.equal(saved[field(c.column)],c.value,`${c.table}.${c.column}`);
      assert.equal(f.api.recordContent(c.collection,item),f.api.recordContent(c.collection,saved));
      const copies=await f.acknowledgements.acknowledgedRecordCopies({[c.collection]:[item]},{accountId:A,fence:null});
      assert.equal(isAcknowledgedRecordCopy(copies,c.collection,item.id),true,'accepted copy is known clean before hydration');
      await f.api.updateItem(null,c.collection,{...item,[field(c.column)]:next(c)},item,A);
      assert.ok(f.queue()[0].expectedBase);await f.api.replayPendingOps(profile,A);
      assert.equal(read(c.table,item.id)[field(c.column)],next(c));assert.equal(f.queue().length,0);assert.equal(f.recovery.readRecovery(A).length,0);
      assert.equal(requests.findLast(r=>r.method==='PATCH').url.searchParams.get(c.column),`eq.${c.value}`);
    }
  });
  await t.test('each first scalar edit matches its database default and does not patch other omitted fields',async()=>{
    for(const [n,c] of columns.entries()){
      const {f,requests}=setup(),item={id:id(200+n),notes:'Initial'};
      await f.api.insertItem(profile,c.collection,item);
      await f.api.updateItem(profile,c.collection,{...item,[field(c.column)]:next(c)},item,A);
      assert.equal(read(c.table,item.id)[field(c.column)],next(c));assert.equal(read(c.table,item.id).notes,'Initial');
      const wire=requests.findLast(r=>r.method==='PATCH');assert.equal(wire.status,200);assert.equal(wire.url.searchParams.get(c.column),`eq.${c.value}`);
      assert.deepEqual(Object.keys(wire.value).sort(),[c.column,'updated_at'].sort());assert.equal(f.recovery.readRecovery(A).length,0);
    }
  });
  await t.test('same-version competing NULL blocks every default-based edit atomically and preserves both copies',async()=>{
    for(const [n,c] of columns.entries()){
      const {f,requests,intervene}=setup(),item={id:id(300+n),notes:'Initial'};
      await f.api.insertItem(profile,c.collection,item);const version=read(c.table,item.id).updatedAt;
      intervene(()=>pg.sql(`update public.${ident(c.table)} set ${ident(c.column)}=null where id=${lit(item.id)}`));
      await f.api.updateItem(profile,c.collection,{...item,[field(c.column)]:next(c)},item,A);
      assert.equal(read(c.table,item.id)[field(c.column)],null);assert.equal(read(c.table,item.id).updatedAt,version);assert.deepEqual(requests.findLast(r=>r.method==='PATCH').body,[]);
      assert.ok(f.recovery.readRecovery(A).some(copy=>copy.local[field(c.column)]===next(c)&&copy.cloud[field(c.column)]===null));
    }
  });
  await t.test('explicit NULL predecessors use IS NULL and cannot overwrite a concurrent stored default',async()=>{
    for(const [n,c] of columns.entries()){
      const {f,requests,intervene}=setup(),item={id:id(400+n),notes:'Initial',[field(c.column)]:null};
      await f.api.insertItem(profile,c.collection,item);const saved=read(c.table,item.id);assert.equal(saved[field(c.column)],null);
      intervene(()=>pg.sql(`update public.${ident(c.table)} set ${ident(c.column)}=${sqlValue(c.value)} where id=${lit(item.id)}`));
      await f.api.updateItem(profile,c.collection,{...item,[field(c.column)]:next(c)},item,A);
      assert.equal(read(c.table,item.id)[field(c.column)],c.value);assert.equal(read(c.table,item.id).updatedAt,saved.updatedAt);
      assert.equal(requests.findLast(r=>r.method==='PATCH').url.searchParams.get(c.column),'is.null');
      assert.ok(f.recovery.readRecovery(A).some(copy=>copy.local[field(c.column)]===next(c)&&copy.cloud[field(c.column)]===c.value));
    }
  });
  await t.test('genuine nondefault numeric and text races also refuse stale edits without relying on updated_at',async()=>{
    for(const [n,c] of columns.filter(c=>typeof c.value!=='boolean').entries()){
      const {f,requests,intervene}=setup(),item={id:id(500+n),notes:'Initial'},remote=typeof c.value==='number'?c.value+2:'archived';
      await f.api.insertItem(profile,c.collection,item);const saved=read(c.table,item.id);
      intervene(()=>pg.sql(`update public.${ident(c.table)} set ${ident(c.column)}=${sqlValue(remote)} where id=${lit(item.id)}`));
      await f.api.updateItem(profile,c.collection,{...item,[field(c.column)]:next(c)},item,A);
      assert.equal(read(c.table,item.id)[field(c.column)],remote);assert.equal(read(c.table,item.id).updatedAt,saved.updatedAt);assert.deepEqual(requests.findLast(r=>r.method==='PATCH').body,[]);
      assert.ok(f.recovery.readRecovery(A).some(copy=>copy.local[field(c.column)]===next(c)&&copy.cloud[field(c.column)]===remote));
    }
  });
  await t.test('queued edits keep real cloud changes for recovery and cannot modify another owner on any affected collection',async()=>{
    for(const [n,table] of tables.entries()){
      const c=columns.find(c=>c.table===table),{f}=setup(),item={id:id(600+n),notes:'Initial'};
      await f.api.insertItem(profile,c.collection,item);
      await f.api.updateItem(null,c.collection,{...item,notes:'Offline desired'},item,A);assert.ok(f.queue()[0].expectedBase);
      pg.sql(`update public.${ident(table)} set ${ident(c.column)}=${sqlValue(next(c))} where id=${lit(item.id)}`);
      await f.api.replayPendingOps(profile,A);
      assert.equal(read(table,item.id).notes,'Initial');assert.equal(read(table,item.id)[field(c.column)],next(c));
      assert.ok(f.recovery.readRecovery(A).some(copy=>copy.local.notes==='Offline desired'&&copy.cloud[field(c.column)]===next(c)));
      const foreign=id(700+n);pg.sql(`insert into public.${ident(table)}(id,user_id,notes${typedTables.has(table)?',type':''}) values (${lit(foreign)},${lit(id(2))},'Foreign'${typedTables.has(table)?",'Other'":''})`);
      await f.api.updateItem(profile,c.collection,{id:foreign,[field(c.column)]:next(c)},{id:foreign},A);
      assert.equal(read(table,foreign)[field(c.column)],c.value);assert.equal(read(table,foreign).notes,'Foreign');
    }
  });
  await t.test('actual duty invoice association is acknowledged, but a competing scholarly true or NULL stays recoverable',async()=>{
    for(const [n,remote] of [undefined,true,null].entries()){
      const {f}=setup(),item={id:id(800+n),date:'2026-09-26',contractId:id(850),workedDay:true,callPeriods:[],callHospital:null,callRole:null,notes:'Synthetic clinic day',placementOk:false,amount:2000};
      await f.api.insertItem(profile,'dutyDays',item);const desired={...item,invoiceId:id(900+n)};
      if(remote===undefined){
        await f.api.updateItem(profile,'dutyDays',desired,item,A);assert.equal(read('duty_days',item.id).invoiceId,desired.invoiceId);
        const copies=await f.acknowledgements.acknowledgedRecordCopies({dutyDays:[desired]},{accountId:A,fence:null});
        assert.equal(isAcknowledgedRecordCopy(copies,'dutyDays',item.id),true);assert.equal(f.recovery.readRecovery(A).length,0);
      }else{
        await f.api.updateItem(null,'dutyDays',desired,item,A);assert.ok(f.queue()[0].expectedBase);
        pg.sql(`update public.duty_days set scholarly=${sqlValue(remote)} where id=${lit(item.id)}`);
        await f.api.replayPendingOps(profile,A);assert.equal(read('duty_days',item.id).invoiceId,null);assert.equal(read('duty_days',item.id).scholarly,remote);
        assert.ok(f.recovery.readRecovery(A).some(copy=>copy.local.invoiceId===desired.invoiceId&&copy.cloud.scholarly===remote));
      }
    }
  });
});
