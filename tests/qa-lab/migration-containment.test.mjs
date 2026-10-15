import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localMigrationRequest, labMigrationText } from '../../qa-lab/lib/release-plan.mjs';
test('local migration batch preserves the complete reviewed SQL before precommit containment',()=>{const original='create table public.synthetic_test(id int);';const sql=localMigrationRequest(original);assert.ok(sql.startsWith(original+'\n'));assert.ok(sql.indexOf('active := false')>sql.indexOf(original));assert.match(sql,/to_regclass\('cron.job'\)/);assert.match(sql,/to_regclass\('public.owner_notify_settings'\)/);assert.match(sql,/set enabled = false where singleton/);assert.doesNotMatch(sql,/\bcommit\s*;/i);});
test('the original owner migration stays unchanged while its local batch cannot commit enabled dispatch',()=>{const original=readFileSync(new URL('../../supabase/migrations/20261014110000_owner_notify_email.sql',import.meta.url),'utf8');assert.match(original,/enabled boolean not null default true/);const moved=labMigrationText(original,'20261014110000_owner_notify_email','http://127.0.0.1:55721');const sql=localMigrationRequest(moved.sql);assert.ok(sql.indexOf('cron.alter_job')>sql.lastIndexOf('$cron$;'));assert.ok(sql.lastIndexOf('set enabled = false')>sql.indexOf('default true'));assert.ok(sql.includes('http://127.0.0.1:55721/functions/v1/owner-notify'));});
test('the migration runner uses one contained atomic simple-query request per file',()=>{const runner=readFileSync(new URL('../../qa-lab/release-migrations.mjs',import.meta.url),'utf8');const db=readFileSync(new URL('../../qa-lab/lib/local-db.mjs',import.meta.url),'utf8');assert.match(runner,/runSqlRequest\(localMigrationRequest\(f.sql\),/);assert.match(db, /function runSqlRequest[\s\S]*?spawnSync\(psqlPath\(\), \[.*?'-c', sql, connectionUrl\(user\)\]/);});

import { postgresFixture, pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
test('PostgreSQL commits local jobs and owner dispatch disabled and rolls back a failed batch', {skip: pgSkip(), timeout: withSlotWait(60000)}, async()=>{
 const db=await postgresFixture({port:58779});
 try {
  await db.sql(`create schema cron; create table cron.job(jobid bigint primary key, active boolean); create function cron.alter_job(jobid bigint, active boolean) returns void language sql as $$ update cron.job set active=$2 where cron.job.jobid=$1 $$; create table public.owner_notify_settings(singleton boolean primary key, enabled boolean);`, 'postgres');
  await db.sql(localMigrationRequest('insert into cron.job values(1,true); insert into public.owner_notify_settings values(true,true);'), 'postgres');
  assert.equal(await db.sql('select active from cron.job where jobid=1','postgres'),'f');
  assert.equal(await db.sql('select enabled from public.owner_notify_settings where singleton','postgres'),'f');
  await assert.rejects(db.sql(localMigrationRequest('insert into cron.job values(2,true); update public.owner_notify_settings set enabled=true;')+ 'select 1/0;' , 'postgres'), /division by zero/);
  assert.equal(await db.sql('select count(*) from cron.job where jobid=2','postgres'),'0');
  assert.equal(await db.sql('select enabled from public.owner_notify_settings where singleton','postgres'),'f');
 } finally {await db.close();}
});
