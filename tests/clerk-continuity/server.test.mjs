import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { buildContinuityPlan, canonicalMembers } from '../../scripts/clerk-continuity-plan.mjs';
import { prepareDocuments } from '../../supabase/functions/build-backup/lib.ts';
import { storagePrefixes } from '../../supabase/functions/delete-account/lib.ts';

const source=await readFile(new URL('../../supabase/functions/_shared/clerkContinuity.ts',import.meta.url),'utf8');
const module={exports:{}};
let clockNow=Date.now();
class ClockDate extends Date { constructor(...args){super(...(args.length?args:[clockNow]));} static now(){return clockNow;} }
vm.runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,AbortSignal,Date:ClockDate,fetch(){throw new Error('network forbidden');}});
const api=module.exports;
const issuer='https://clerk.credentialdomd.com', dev='https://synthetic.clerk.accounts.dev';
const user=(id='user_Prod',email='one@example.test')=>({id,created_at:1700000000000,updated_at:1789820000000,primary_email_address_id:'id-primary',email_addresses:[{id:'id-primary',email_address:email,verification:{status:'verified'}}]});
const identity={subject:'user_Prod',email:'one@example.test',updatedMs:1789820000000,createdMs:1700000000000,checkedAt:new Date(clockNow).toISOString()};
const receipt={schemaVersion:1,state:'bound',subject:'user_Prod',issuer,profileId:'11111111-1111-4111-8111-111111111111',continuity:{id:'99999999-9999-4999-8999-999999999999',state:'bound',sourceSubject:'user_Dev',sourceIssuer:dev}};
function fixture(candidate={state:'prepared',sourceSubject:'user_Dev',sourceIssuer:dev}){
 const calls=[],requests=[];
 return {calls,requests,db:{rpc:async(name,args)=>{calls.push({name,args});return{data:name==='clerk_continuity_candidate'?candidate:receipt,error:null};}},
  options:{sourceSecret:'sk_test_synthetic',sourceIssuer:dev,transport:async(url,options)=>{requests.push({url,options});return Response.json(user('user_Dev'));}}};
}

test('verified primary identity never falls back to another verified address or editable profile fields',()=>{
 const u=user(); u.email_addresses.push({id:'other',email_address:'other@example.test',verification:{status:'verified'}});
 assert.equal(api.verifiedPrimaryIdentity(u).email,'one@example.test');
 u.email_addresses[0].verification.status='unverified';
 assert.equal(api.verifiedPrimaryIdentity(u),null);
 u.primary_email_address_id='absent'; assert.equal(api.verifiedPrimaryIdentity(u),null);
});
for(const field of ['banned','locked','deleted']) test(`provider ${field} identity is rejected`,()=>assert.equal(api.verifiedPrimaryIdentity({...user(),[field]:true}),null));
test('duplicate primary IDs and invalid provider clocks are rejected',()=>{
 const u=user();u.email_addresses.push({...u.email_addresses[0]});assert.equal(api.verifiedPrimaryIdentity(u),null);
 for(const u of [{...user(),created_at:0},{...user(),updated_at:1},{...user(),created_at:undefined}])assert.equal(api.verifiedPrimaryIdentity(u),null);
});
test('read-only provider request is pinned to the exact subject and rejects wrong-instance keys',async()=>{
 let calls=0;
 const transport=async(url,options)=>{calls++;assert.equal(url,'https://api.clerk.com/v1/users/user_Prod');assert.equal(options.redirect,'error');assert.ok(options.signal);return Response.json(user());};
 await assert.rejects(api.readProductionIdentity('user_Prod','sk_test_wrong',transport),/unavailable/);
 assert.equal(calls,0);assert.equal((await api.readProductionIdentity('user_Prod','sk_live_synthetic',transport)).subject,'user_Prod');
 await assert.rejects(api.readProductionIdentity('user_Prod','sk_live_synthetic',async()=>Response.json(user('user_Other'))),/verified_primary_required/);
});
test('first binding rereads exact development identity before atomic initialization',async()=>{
 const f=fixture();assert.equal((await api.initializeProductionProfile(f.db,identity,issuer,f.options)).profileId,receipt.profileId);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'https://api.clerk.com/v1/users/user_Dev');
 assert.deepEqual(f.calls.map(c=>c.name),['clerk_continuity_candidate','initialize_clerk_profile']);
 const proof=f.calls[1].args.p_source_proof;
 assert.equal(proof.subject,'user_Dev');assert.equal(proof.email,identity.email);assert.equal(proof.createdMs,1700000000000);assert.equal(proof.issuer,dev);
 assert.ok(Date.now()-Date.parse(proof.checkedAt)<5000);
});
test('changed development primary cannot authorize an old staged mailbox',async()=>{
 const f=fixture();f.options.transport=async()=>Response.json(user('user_Dev','changed@example.test'));
 await assert.rejects(api.initializeProductionProfile(f.db,identity,issuer,f.options),/source_identity_unavailable/);
 assert.equal(f.calls.length,1);
});
test('wrong source issuer or production issuer stops before source request or binding',async()=>{
 const f=fixture();f.options.sourceIssuer='https://wrong.example';
 await assert.rejects(api.initializeProductionProfile(f.db,identity,issuer,f.options),/source_identity_unavailable/);
 assert.equal(f.requests.length,0);assert.equal(f.calls.length,1);
 await assert.rejects(api.initializeProductionProfile(f.db,identity,'https://wrong.example',f.options),/production_identity_unavailable/);
 assert.equal(f.calls.length,1);
});
test('bound account resumes without depending on the retired development provider',async()=>{
 const f=fixture({state:'bound',sourceSubject:'user_Dev',sourceIssuer:dev});
 await api.initializeProductionProfile(f.db,identity,issuer,{});
 assert.equal(f.requests.length,0);assert.equal(f.calls[1].args.p_source_proof,null);
});
test('delayed candidate lookup cannot relabel an old production identity as freshly verified',async()=>{
 const original=clockNow, calls=[];
 const db={rpc:async(name)=>{calls.push(name);clockNow+=360000;return{data:null,error:null};}};
 try {await assert.rejects(api.initializeProductionProfile(db,identity,issuer,{}),/production_identity_unavailable/);assert.deepEqual(calls,['clerk_continuity_candidate']);}
 finally {clockNow=original;}
});
test('database conflict and unknown results never look like an initialized profile',async()=>{
 for(const state of ['identity_conflict','account_unavailable','disabled','unexpected']){
  const f=fixture(null);f.db.rpc=async name=>({data:name==='clerk_continuity_candidate'?null:{state},error:null});
  await assert.rejects(api.initializeProductionProfile(f.db,identity,issuer,{}));
 }
});
test('storage subjects accept only protected bounded provider subjects',async()=>{
 for(const data of [null,[],['user_A','user_B','user_C'],['user_A','user_A'],['../other']]){
  await assert.rejects(api.storageSubjects({rpc:async()=>({data,error:null})},receipt.profileId),/storage_identity_unavailable/);
 }
 const data=['user_Dev','user_Prod'];assert.equal((await api.storageSubjects({rpc:async()=>({data,error:null})},receipt.profileId)).length,2);
});
test('actual backup preparation retains legacy-owned files and skips another physician or traversal',()=>{
 const rows=[{id:'old',name:'old.pdf',storage_path:'user_Dev/old'},{id:'new',name:'new.pdf',storage_path:'user_Prod/new'},
  {id:'other',name:'other.pdf',storage_path:'user_Other/file'},{id:'escape',name:'escape.pdf',storage_path:'user_Dev/../user_Other/file'}];
 const out=prepareDocuments(rows,'user_Prod',new Map(),undefined,['user_Prod','user_Dev']);
 assert.equal(out.items.length,2);assert.equal(out.skipped.length,2);
 assert.equal(prepareDocuments(rows,'user_Prod',new Map()).items.length,1);
});
test('actual deletion prefix plan covers both owned subjects without broad or forged prefixes',()=>{
 const out=storagePrefixes(receipt.profileId,'user_Prod',[],['user_Prod','user_Dev','../user_Other']);
 const keys=out.map(x=>`${x.bucket}/${x.prefix}`);
 assert.ok(keys.includes('documents/user_Dev/'));assert.ok(keys.includes('backups/user_Dev/'));
 assert.equal(keys.filter(x=>x==='documents/user_Prod/').length,1);
 assert.equal(keys.some(x=>x.includes('user_Other')),false);
});

function planInput(){return{sourceIssuer:dev,targetIssuer:issuer,expectedInstanceId:'ins_synthetic',runId:'99999999-9999-4999-8999-999999999999',
 snapshot:{instance_id:'ins_synthetic',read_at:'2026-09-20T00:00:00Z',records:[{subject:'user_Dev',created_at_ms:1700000000000,updated_at_ms:1789820000000,primary_email:'one@example.test',primary_verified:true},{subject:'user_NoProfile',created_at_ms:1700000000000,updated_at_ms:1789820000000,primary_email:'two@example.test',primary_verified:true}]},
 profiles:[{id:receipt.profileId,auth_user_id:'user_Dev',email:'editable-wrong@example.test'}],lifetimeEligibleSubjects:['user_Dev','user_NoProfile']};}
test('offline manifest joins exact source subjects and includes preexisting accounts without profiles',()=>{
 const out=buildContinuityPlan(planInput());assert.equal(out.enabled,false);assert.equal(out.counts.existingProfiles,1);assert.equal(out.counts.lifetimeEligible,2);
 assert.equal(out.members[0][2],'one@example.test');assert.equal(out.members[1][0],null);assert.equal(out.members[1][5],true);
 assert.equal(out.manifestSHA256.length,64);assert.equal(canonicalMembers(out.members),canonicalMembers([...out.members].reverse()));
});
test('explicit reviewed cohort excludes synthetic accounts without discarding their identity continuity',()=>{
 const input=planInput();input.lifetimeEligibleSubjects=['user_Dev'];const out=buildContinuityPlan(input);
 assert.equal(out.members.length,2);assert.equal(out.members[1][5],false);assert.equal(out.counts.lifetimeEligible,1);
});
test('manifest rejects ambiguity, missing evidence, wrong instance and incomplete coverage',()=>{
 const variants=[input=>input.snapshot.records.push({...input.snapshot.records[0],subject:'user_Duplicate'}),input=>delete input.snapshot.records[0].updated_at_ms,input=>input.expectedInstanceId='wrong',input=>input.snapshot.records.pop(),input=>input.profiles.push({...input.profiles[0],id:'22222222-2222-4222-8222-222222222222'})];
 for(const mutate of variants){const input=planInput();mutate(input);assert.throws(()=>buildContinuityPlan(input));}
});
test('post-cutoff registration cannot be included in grandfathered lifetime manifest',()=>{
 const input=planInput();input.snapshot.records[0].created_at_ms=1789910000000;input.snapshot.records[0].updated_at_ms=1789920000000;
 assert.throws(()=>buildContinuityPlan(input),/cutoff/);
});
