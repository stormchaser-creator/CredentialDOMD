import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { hostCommandDiagnostics, sanitizeHostOutput } from '../../qa-lab/e2e/support/host-diagnostics.mjs';
const source = fs.readFileSync(process.env.NOTIFIER_WRAPPER_SOURCE || new URL('../../qa-lab/e2e/ops-app.spec.mjs', import.meta.url), 'utf8');
const code = transformSync(source, {loader:'js',format:'cjs'}).code;
const require = createRequire(import.meta.url);
const email = 'diagnostic-only@qa.credentialdomd.test';
const fixtureRows = [{key:'paid:synthetic-input-never-attach',kind:'PAID',email,name:'Synthetic Physician',extra:'synthetic-private-input'}];
async function exercise(result,{failAttachment=false,failStateRead=false}={}) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'qa-notifier-diagnostics-'));
 const registered=[],calls=[],checks=[],attachments=[];const secret='synthetic-process-secret';let formats=0;
 const success=stdout=>({status:0,signal:null,ms:1,error:null,stdout,stderr:''});
 const hostRun=(command,args,options)=>{
  calls.push({command,args,options});const subcommand=args[1];
  if(subcommand==='probe')return success('select probe');
  if(subcommand==='present')return success('synthetic-present');
  if(subcommand==='query')return success('select activity');
  if(subcommand==='format'){formats+=1;return success(formats===1?`PAID ${email}\nQA notifier ticket ntfdiagnostic\nCLIENT ERROR QA notifier client error ntfdiagnostic`:result.status===0?'':`PAID ${email}`);}
  assert.equal(subcommand,'remember');assert.equal(options.timeoutMs,60000,'retain the original timeout');assert.deepEqual(JSON.parse(options.input),fixtureRows);
  const seen=args[args.indexOf('--seen')+1];fs.writeFileSync(result.status===0?seen:`${seen}.1234.tmp`,'synthetic-private-state',{mode:0o600});return result;
 };
 try{
  vm.runInNewContext(code,{module:{exports:{}},exports:{},Buffer,process:{env:{TOKEN:secret}},require(name){
   if(name==='node:fs')return {...fs,...(failStateRead?{readFileSync(){throw Error(`state unreadable ${secret}`);}}:{})};
   if(name.startsWith('node:'))return require(name);
   if(name==='./support/fixtures.mjs')return {test:Object.assign((title,options,fn)=>registered.push({title,fn}),{setTimeout(){}})};
   if(name==='./support/host-diagnostics.mjs')return {hostCommandDiagnostics,sanitizeHostOutput};
   if(name==='../lib/paths.mjs')return {GENERATED_DIR:base};
   if(name==='./support/ops-helpers.mjs')return {REPO_ROOT:'/synthetic',hostRun};
   if(name==='../lib/local-db.mjs')return {localExec:()=>JSON.stringify(fixtureRows)};
   if(name==='./support/lab.mjs')return {stamp:()=> 'ntfdiagnostic',letters:()=> 'Test',newMember:async()=>({user:{email,id:'synthetic-user'},profile:{id:'synthetic-profile'}})};
   if(name==='@supabase/supabase-js')return {createClient:()=>{throw Error('No network allowed');}};
   throw Error(`Unexpected import ${name}`);
  }});
  const journey=registered.find(x=>x.title.startsWith('owner notifier:'));assert.ok(journey);
  await journey.fn({page:{},qa:{feature:async(_id,name,fn)=>{if(name.startsWith('the activity query'))await fn();},check:(name,ok)=>checks.push({name,ok,attachmentsAtCheck:attachments.length}),blocked(){}}},
   {attach:async(name,value)=>{if(failAttachment)throw Error('attachment unavailable');attachments.push({name,contentType:value.contentType,value:JSON.parse(value.body)});}});
  return {calls,checks,attachments};
 }finally{fs.rmSync(base,{recursive:true,force:true});}
}
for(const [label,outcome] of [
 ['timeout with empty stderr',{status:null,signal:'SIGTERM',error:'spawnSync python3 ETIMEDOUT',ms:60001,stdout:'',stderr:''}],
 ['nonzero exit',{status:3,signal:null,error:null,ms:8,stdout:'synthetic-private-output',stderr:'refused synthetic-process-secret'}],
 ['successful remember',{status:0,signal:null,error:null,ms:9,stdout:'',stderr:''}],
])test(`actual notifier journey retains ${label} before its original verdict`,async()=>{
 const r=await exercise(outcome);assert.equal(r.attachments.length,1);
 const {name,contentType,value}=r.attachments[0];assert.equal(name,'owner-notifier-remember-diagnostics.json');assert.equal(contentType,'application/json');
 assert.equal(value.exitCode,outcome.status);assert.equal(value.signal,outcome.signal);assert.equal(value.durationMs,outcome.ms);if(outcome.error)assert.equal(value.error,outcome.error);
 assert.equal(value.stdout,'');assert.equal(value.stdoutBytes,Buffer.byteLength(outcome.stdout));assert.equal(value.input.rows,1);assert.equal(value.input.keyedRows,1);assert.match(value.input.sha256,/^[a-f0-9]{64}$/);
 assert.equal(value.stateFiles.length,1);assert.equal(value.stateFiles[0].bytes,Buffer.byteLength('synthetic-private-state'));assert.match(value.stateFiles[0].sha256,/^[a-f0-9]{64}$/);
 const text=JSON.stringify(r.attachments);for(const forbidden of ['synthetic-private-input','synthetic-private-state','synthetic-private-output','synthetic-process-secret','paid:synthetic-input-never-attach',email])assert.ok(!text.includes(forbidden),forbidden);
 const remember=r.checks.find(x=>x.name==='remember records the money events');assert.equal(remember.ok,outcome.status===0);assert.equal(remember.attachmentsAtCheck,1);
 assert.equal(r.checks.find(x=>x.name==='the next run does not report the payment again').ok,outcome.status===0);assert.equal(r.calls.filter(x=>x.args[1]==='remember').length,1,'never retry the write');
});
test('failed state inspection keeps process evidence and fails its own check',async()=>{
 const r=await exercise({status:0,signal:null,error:null,ms:9,stdout:'',stderr:''},{failStateRead:true});assert.equal(r.attachments.length,1);assert.equal(r.attachments[0].value.exitCode,0);assert.match(r.attachments[0].value.stateFilesError,/state unreadable/);assert.ok(!JSON.stringify(r.attachments).includes('synthetic-process-secret'));assert.equal(r.checks.find(x=>x.name==='remember state diagnostics were readable').ok,false);
});
test('attachment failure cannot proceed to a green remember check',async()=>{
 await assert.rejects(exercise({status:0,signal:null,error:null,ms:9,stdout:'',stderr:''},{failAttachment:true}),/attachment unavailable/);
});
