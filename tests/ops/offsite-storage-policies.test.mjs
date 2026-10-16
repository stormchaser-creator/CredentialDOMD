// Synthetic storage platform tables only; no provider, Keychain or real backup data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from './pg.mjs';
import { exportCatalog, exportDdl, exportData } from '../../scripts/offsite-backup.mjs';
import { applySchema, applyData, psqlExecutor } from '../../scripts/offsite-restore.mjs';

const PLATFORM = `create schema storage;
 create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated;
 grant select,insert,update,delete on storage.objects to authenticated;`;
const ROWS = `insert into storage.objects(bucket_id,name) values
 ('documents','user_synthetic_a/file.pdf'),('documents','user_synthetic_b/file.pdf');`;
const SOURCE = `create table public.profiles(id uuid primary key, auth_user_id text);
 create function public.owns_test_object(n text) returns boolean language sql stable
 as $$select split_part(n,'/',1)=current_setting('request.jwt.claim.sub',true)$$;
 create policy document_read on storage.objects for select to authenticated using(public.owns_test_object(name));
 create policy document_add on storage.objects for insert to authenticated with check(public.owns_test_object(name));
 create policy document_edit on storage.objects for update to authenticated using(public.owns_test_object(name)) with check(public.owns_test_object(name));
 create policy document_delete on storage.objects for delete to authenticated using(public.owns_test_object(name));
 create policy document_bucket on storage.objects as restrictive for all to authenticated using(bucket_id='documents') with check(bucket_id='documents');`;
const asA = sql => `set role authenticated; set "request.jwt.claim.sub"='user_synthetic_a'; ${sql}`;
const policyRows = (pg,db) => pg.rows("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by tablename,policyname",{db});

test('offsite restore preserves Storage access for the owner and refuses other-user writes', {skip:pgSkip(),timeout:withSlotWait(180000)}, async t=>{
 const pg=await startPostgres(58474,'offsite-storage-policies');t.after(()=>pg.close());
 await pg.sql('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;');
 for(const db of ['src','dst']){await pg.sql(`create database ${db}`);await pg.sql(PLATFORM,{db});}
 await pg.sql(SOURCE+ROWS,{db:'src'});
 assert.equal(await pg.sql(asA('select count(*) from storage.objects'),{db:'src'}),'1','source positive control: owner can read one file');
 const query=async sql=>JSON.parse(await pg.sql(`select coalesce(json_agg(x),'[]'::json) from (${sql.trim().replace(/;$/,'')}) x`,{db:'src'}));
 const catalog=await exportCatalog(query),ddl=await exportDdl(query,catalog);
 const dir=fs.mkdtempSync(path.join(pg.root,'archive-'));fs.mkdirSync(path.join(dir,'data'));
 const data=await exportData(query,catalog,path.join(dir,'data'));
 process.env.PSQL=path.join(pg.bin,'psql');
 const sql=psqlExecutor(`postgresql:///dst?host=${encodeURIComponent(pg.socket)}&port=${pg.port}&user=postgres`),summary={failures:[],notes:[]};
 await applySchema(sql,{...ddl,foreign_keys:ddl.foreignKeys},summary,catalog);
 await applyData(sql,dir,{tables:data.tables},{...ddl,foreign_keys:ddl.foreignKeys},catalog,null,summary);
 assert.deepEqual(summary.failures,[]);
 // Storage API rebuilds these metadata rows; the schema restore must supply access policies.
 await pg.sql(ROWS,{db:'dst'});
 assert.equal(await pg.sql(asA('select count(*) from storage.objects'),{db:'dst'}),'1','restored owner must retain file access; a row-complete archive is insufficient');
 assert.deepEqual(await policyRows(pg,'dst'),await policyRows(pg,'src'),'roles, restrictive/permissive rules and both ownership predicates survive');
 assert.equal(await pg.sql(asA("select count(*) from storage.objects where name like 'user_synthetic_b/%'"),{db:'dst'}),'0');
 await pg.sql(asA("insert into storage.objects(bucket_id,name) values('documents','user_synthetic_a/new.pdf')"),{db:'dst'});
 assert.equal((await pg.tryRun(asA("insert into storage.objects(bucket_id,name) values('documents','user_synthetic_b/forged.pdf')"),{db:'dst'})).ok,false);
 assert.equal((await pg.tryRun(asA("insert into storage.objects(bucket_id,name) values('private-other','user_synthetic_a/forged.pdf')"),{db:'dst'})).ok,false,'restrictive bucket rule survives');
 assert.equal((await pg.tryRun(asA("update storage.objects set name='user_synthetic_b/stolen.pdf' where name='user_synthetic_a/new.pdf'"),{db:'dst'})).ok,false,'WITH CHECK prevents changing ownership');
 assert.equal(await pg.sql(asA("delete from storage.objects where name='user_synthetic_b/file.pdf' returning name"),{db:'dst'}),'');
 assert.equal(await pg.sql(asA("update storage.objects set name='user_synthetic_a/edited.pdf' where name='user_synthetic_a/new.pdf' returning name"),{db:'dst'}),'user_synthetic_a/edited.pdf');
 assert.equal(await pg.sql(asA("delete from storage.objects where name='user_synthetic_a/edited.pdf' returning name"),{db:'dst'}),'user_synthetic_a/edited.pdf');
});
