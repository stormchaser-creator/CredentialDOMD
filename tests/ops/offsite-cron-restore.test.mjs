// Restoring an archive must not activate its delivery jobs before URLs/secrets are reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pgSkip, withSlotWait } from '../credential-portal/postgresFixture.mjs';
import { startPostgres } from './pg.mjs';
import { applyCron, psqlExecutor } from '../../scripts/offsite-restore.mjs';

test('restored cron definitions remain inactive, including originally inactive jobs', {skip:pgSkip(),timeout:withSlotWait(180000)}, async t=>{
 const pg=await startPostgres(58475,'offsite-cron-restore');t.after(()=>pg.close());
 // PostgreSQL implementations of the pg_cron schedule/alter contract. No timer or network.
 await pg.sql(`create schema cron;
 create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean not null default true);
 create function cron.schedule(n text,s text,c text) returns bigint language sql as $$
 insert into cron.job(jobname,schedule,command) values(n,s,c) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid$$;
 create function cron.alter_job(job_id bigint,active boolean) returns void language sql as $$update cron.job set active=$2 where jobid=$1$$;`);
 const dir=fs.mkdtempSync(path.join(pg.root,'archive-'));fs.mkdirSync(path.join(dir,'data'));
 const jobs=[{jobname:'synthetic-reminder',schedule:'* * * * *',command:'select 1',active:true},{jobname:'synthetic-held',schedule:'0 13 * * *',command:'select 2',active:false}];
 fs.writeFileSync(path.join(dir,'data/cron.job.ndjson'),jobs.map(j=>JSON.stringify(j)).join('\n')+'\n');
 process.env.PSQL=path.join(pg.bin,'psql');const sql=psqlExecutor(`postgresql:///postgres?host=${encodeURIComponent(pg.socket)}&port=${pg.port}&user=postgres`),summary={failures:[],notes:[]};
 await applyCron(sql,dir,summary);assert.deepEqual(summary.failures,[]);
 const rows=await pg.rows('select jobname,schedule,command,active from cron.job order by jobname');
 assert.equal(rows.filter(j=>j.active).length,0,'restoration may not activate delivery before target review');
 assert.deepEqual(rows,jobs.map(j=>({...j,active:false})).sort((a,b)=>a.jobname.localeCompare(b.jobname)),'every definition is retained, with activation held');
 await applyCron(sql,dir,summary);assert.deepEqual(summary.failures,[]);
 assert.equal(await pg.sql('select count(*) from cron.job'),'2','repeating restore does not duplicate schedules');
});
