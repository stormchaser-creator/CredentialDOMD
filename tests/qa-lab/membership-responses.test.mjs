import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { verifiedMembershipSubject, membershipBodySummary, observeMembershipResponses, finishMembershipResponses, allowingMembershipResponse, safeMembershipEvidence } from '../../qa-lab/e2e/support/membership-responses.mjs';
import { createClerkMock } from '../../qa-lab/mocks/clerk.mjs';
import ResultsReporter from '../../qa-lab/e2e/support/results-reporter.mjs';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key'};
const issuer='https://clerk.qa.credentialdomd.test',account='user_qaOriginal',now=Date.parse('2026-10-01T04:00:00Z');
const runtime={issuer,urls:{apiOrigin:'http://127.0.0.1:55585',api:'http://127.0.0.1:55521',appOrigin:'http://127.0.0.1:55590'}};
const snapshot=()=>({schemaVersion:1,policyVersion:PUBLIC_BILLING_POLICY.version,evaluatedAt:new Date(now).toISOString(),accessStatus:'active',enforcementEnabled:true,billingEnabled:true,capabilities:Object.fromEntries(['credential','practice'].map(k=>[k,{read:true,write:true,export:true}]))});
const token=(claims={},header={},key=privateKey)=>{
 const a=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid,...header})).toString('base64url');
 const b=Buffer.from(JSON.stringify({iss:issuer,sub:account,aud:'authenticated',role:'authenticated',iat:now/1000,nbf:now/1000-10,exp:now/1000+300,...claims})).toString('base64url');
 return `Bearer ${a}.${b}.${sign('RSA-SHA256',Buffer.from(`${a}.${b}`),key).toString('base64url')}`;
};
const request=(options={})=>({url:()=>options.url||`${runtime.urls.apiOrigin}/functions/v1/billing-entitlements`,method:()=>options.method||'POST',headers:()=>({}),headerValue:options.headerValue|| (async name=>{assert.equal(name,'authorization');return options.authorization||token();})});
const response=(req,options={})=>({request:()=>req,status:()=>options.status??200,finished:options.finished||(()=>Promise.resolve(null)),text:options.text||(()=>Promise.resolve(JSON.stringify(options.body??snapshot())))});
function setup(options={}) { const page=new EventEmitter(),report={};const observer=observeMembershipResponses(page,report,runtime,{jwk,now:()=>now,timeoutMs:30,...options});return{page,report,observer}; }

test('identity binding requires valid local signature, issuer, authenticated template and unexpired claims',()=>{
 assert.equal(verifiedMembershipSubject(token(),{jwk,issuer,now}),account);
 const other=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
 const bad=[token({}, {},other),token({iss:'https://other.test'}),token({role:'service_role'}),token({aud:'other'}),token({exp:now/1000}),token({nbf:now/1000+100}),token({iat:now/1000+100}),token({sub:'real-person-sensitive-text'}),token({}, {alg:'HS256'}),token({}, {kid:'other'}),'Bearer not.jwt.valid'];
 for(const value of bad) assert.equal(verifiedMembershipSubject(value,{jwk,issuer,now}),null);
});

test('the real local Clerk mint produces the exact verified Supabase template, while its session token is not a template proof',()=>{
 const state={clerk:{users:{[account]:{instance:'live',data:{id:account,email_addresses:[{id:'email',email_address:'synthetic@qa.credentialdomd.test'}],primary_email_address_id:'email'}}},sessions:{}}};
 const store={state,update:fn=>fn(state),save(){}};
 const secrets={signingKey:{...privateKey.export({format:'jwk'}),kid:jwk.kid,alg:'RS256'},clerk:{secretKey:'synthetic-live',legacySecretKey:'synthetic-legacy'}};
 const clerk=createClerkMock({store,secrets,log(){}}),session=clerk.createSession(account);
 const minted=clerk.mintToken(session.id,'supabase');
 assert.equal(verifiedMembershipSubject(`Bearer ${minted.jwt}`,{jwk,issuer}),account);
 assert.equal(minted.claims.aud,'authenticated');assert.equal(minted.claims.role,'authenticated');
 assert.equal(minted.claims.iss,issuer);assert.ok(minted.claims.nbf<=Date.now()/1000);
 assert.equal(verifiedMembershipSubject(`Bearer ${clerk.mintToken(session.id).jwt}`,{jwk,issuer}),null);
});

test('security-header omission does not lose account binding; timed-out or failed private reads remain explicit',async()=>{
 const good=setup(),req=request();assert.deepEqual(req.headers(),{});good.page.emit('request',req);good.page.emit('response',response(req));await good.observer.stop();
 assert.equal(good.report.membershipResponses[0].accountId,account);
 let resolveHeader;
 const slow=setup({timeoutMs:5}),pending=request({headerValue:()=>new Promise(resolve=>{resolveHeader=resolve;})});
 slow.page.emit('request',pending);slow.page.emit('response',response(pending));await slow.observer.stop();
 assert.equal(slow.report.membershipResponses[0].accountBinding,'header_read_timeout');assert.equal(allowingMembershipResponse(slow.report.membershipResponses[0],account),false);
 resolveHeader(token());await new Promise(r=>setTimeout(r,1));assert.equal(slow.report.membershipResponses[0].accountId,null);
 const bad=setup(),failed=request({headerValue:async()=>{throw Error('private header content');}});bad.page.emit('request',failed);bad.page.emit('response',response(failed));await bad.observer.stop();
 assert.equal(safeMembershipEvidence(bad.report.membershipResponses[0]).accountBinding,'header_read_failed');
 assert.ok(!JSON.stringify(bad.report).includes('private header content'));
});

test('summary rejects malformed and contradictory answers and omits arbitrary text and private fields',()=>{
 const raw={...snapshot(),email:'synthetic-private@example.test',secret:'DO-NOT-RETAIN',nested:{raw:'DO-NOT-RETAIN'}};
 assert.equal(membershipBodySummary(200,raw).bodyState,'well_formed_snapshot_summary');
 assert.ok(!JSON.stringify(membershipBodySummary(200,raw)).includes('DO-NOT-RETAIN'));
 for(const value of [null,[],{}, {...snapshot(),policyVersion:'counterfeit'}, {...snapshot(),accessStatus:'pending'}, {...snapshot(),capabilities:{credential:{read:true,write:'yes',export:true}}}]) assert.equal(membershipBodySummary(200,value).snapshot,null);
 assert.equal(membershipBodySummary(503,{error:'raw secret error'}).errorCode,null);
 assert.equal(membershipBodySummary(503,{error:'access_policy_unavailable',raw:'DO-NOT-RETAIN'}).errorCode,'access_policy_unavailable');
});

test('fixed body shapes distinguish handler, code-bearing gateway, HTML and other failures without arbitrary values',async()=>{
 const controls=[
  {body:{error:'access_policy_unavailable'},shape:'json_error_field',code:'access_policy_unavailable'},
  {body:{code:'private-gateway-code',message:'private-body'},shape:'json_code_field',code:null},
  {body:{error:'private-error',code:'private-code'},shape:'json_error_and_code_fields',code:null},
  {body:{message:'private-body'},shape:'json_object',code:null},
  {body:['private-body'],shape:'json_array',code:null},
  {body:'private-body',shape:'json_scalar',code:null},
  {text:async()=>'<html><body>private-body</body></html>',shape:'html',code:null},
  {text:async()=>'upstream private-body',shape:'non_json',code:null},
 ];
 for(const item of controls){
  const s=setup(),req=request();s.page.emit('request',req);s.page.emit('response',response(req,{status:503,...item}));await s.observer.stop();
  const retained=safeMembershipEvidence(s.report.membershipResponses[0]);
  assert.equal(retained.bodyShape,item.shape);assert.equal(retained.errorCode,item.code);
  assert.equal(allowingMembershipResponse(retained,account),false);
  assert.ok(!JSON.stringify(retained).includes('private-'));
 }
 const s=setup(),req=request();s.page.emit('request',req);s.page.emit('response',response(req));await s.observer.stop();
 assert.equal(safeMembershipEvidence({...s.report.membershipResponses[0],bodyShape:'private-forged-value'}).bodyShape,'unread');
});

test('observer preserves completed account-bound503 then200 without converting the error into health clearance',async()=>{
 const {page,report,observer}=setup();
 const first=request();page.emit('request',first);page.emit('response',response(first,{status:503,body:{error:'access_policy_unavailable',token:'DO-NOT-RETAIN'}}));await observer.flush();
 const next=request();page.emit('request',next);page.emit('response',response(next));await finishMembershipResponses(report);
 assert.deepEqual(report.membershipResponses.map(r=>r.status),[503,200]);
 assert.equal(report.membershipResponses[0].errorCode,'access_policy_unavailable');
 assert.equal(allowingMembershipResponse(report.membershipResponses[0],account),false);
 assert.equal(allowingMembershipResponse(report.membershipResponses[1],account),true);
 assert.equal(allowingMembershipResponse(report.membershipResponses[1],'user_qaAnother'),false);
 assert.ok(report.membershipResponses.every(r=>r.accountId===account&&r.completedAt));
 assert.ok(!JSON.stringify(report).includes('DO-NOT-RETAIN'));assert.ok(!JSON.stringify(report).includes('Bearer'));
 assert.equal(page.listenerCount('response'),0);assert.equal(page.listenerCount('request'),0);
});

test('a causal baseline refuses an earlier request that finishes after the signal, while a later completed answer qualifies',async()=>{
 let clock=now;
 const s=setup({now:()=>clock}),earlier=request();
 s.page.emit('request',earlier);
 const baselineSince=now+100;
 clock=baselineSince+1;s.page.emit('response',response(earlier));await s.observer.flush();
 const lateCompletion=s.report.membershipResponses[0];
 // This is the original completion-only predicate from the failed saved browser trace.
 assert.equal(Date.parse(lateCompletion.completedAt)>=baselineSince && allowingMembershipResponse(lateCompletion,account),true);
 assert.equal(allowingMembershipResponse(lateCompletion,account,baselineSince),false);
 const later=request();s.page.emit('request',later);clock+=1;s.page.emit('response',response(later));await s.observer.stop();
 const fresh=s.report.membershipResponses[1];
 assert.equal(allowingMembershipResponse(fresh,account,baselineSince),true);
 assert.equal(allowingMembershipResponse(fresh,'user_qaAnother',baselineSince),false);
 for(const invalid of [null,NaN,Infinity,'not-a-time']) assert.equal(allowingMembershipResponse(fresh,account,invalid),false);
});

test('a forged or different account token never proves the expected account recovered',async()=>{
 const {page,report,observer}=setup();
 const otherKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
 for(const authorization of [token({sub:'user_qaAnother'}),token({},{},otherKey)]) {const req=request({authorization});page.emit('request',req);page.emit('response',response(req));}
 await observer.stop();
 assert.equal(report.membershipResponses[0].accountId,'user_qaAnother');
 assert.equal(report.membershipResponses[1].accountId,null);
 assert.ok(report.membershipResponses.every(r=>!allowingMembershipResponse(r,account)));
});

test('teardown awaits delayed completion; malformed, failed, oversized and unreadable responses remain diagnostic failures',async()=>{
 const {page,report}=setup({timeoutMs:200});let finish;
 const delayed=request();page.emit('request',delayed);page.emit('response',response(delayed,{finished:()=>new Promise(resolve=>{finish=resolve;})}));
 let stopped=false;const stop=finishMembershipResponses(report).then(()=>{stopped=true;});await new Promise(r=>setTimeout(r,5));assert.equal(stopped,false);finish(null);await stop;
 assert.equal(report.membershipResponses[0].completion,'finished');
 for(const options of [{body:{}},{text:async()=>'{invalid secret'},{text:async()=>'x'.repeat(65537)},{finished:async()=>Error('sensitive error')},{text:async()=>{throw Error('private response');}}]) {
  const s=setup();const req=request();s.page.emit('request',req);s.page.emit('response',response(req,options));await s.observer.stop();
  assert.equal(allowingMembershipResponse(s.report.membershipResponses[0],account),false);
  assert.ok(!JSON.stringify(s.report).includes('sensitive error'));assert.ok(!JSON.stringify(s.report).includes('private response'));
 }
});

test('timeout cannot be changed into success by a late body and request failures/pending requests stay visible',async()=>{
 const s=setup({timeoutMs:5});let release;
 const req=request();s.page.emit('request',req);s.page.emit('response',response(req,{text:()=>new Promise(resolve=>{release=resolve;})}));
 await s.observer.stop();assert.equal(s.report.membershipResponses[0].completion,'capture_timeout');
 release(JSON.stringify(snapshot()));await new Promise(r=>setTimeout(r,1));assert.equal(s.report.membershipResponses[0].completion,'capture_timeout');
 const f=setup();const failed=request(),pending=request();f.page.emit('request',failed);f.page.emit('requestfailed',failed);f.page.emit('request',pending);await f.observer.stop();
 assert.deepEqual(f.report.membershipResponses.map(r=>r.completion),['request_failed','unfinished_at_teardown']);
});

test('lookalike external endpoint and query do not enter the evidence; wrong method never counts as recovery',async()=>{
 const {page,report,observer}=setup();
 for(const opts of [{url:'https://external.test/functions/v1/billing-entitlements'},{url:`${runtime.urls.apiOrigin}/functions/v1/billing-entitlements?token=private`},{url:`${runtime.urls.apiOrigin}/functions/v1/billing-entitlements-forged`}]) {const req=request(opts);page.emit('request',req);page.emit('response',response(req));}
 const req=request({method:'GET'});page.emit('request',req);page.emit('response',response(req));await observer.stop();
 assert.equal(report.membershipResponses.length,1);assert.equal(allowingMembershipResponse(report.membershipResponses[0],account),false);
});

test('a response whose request was missed keeps that gap explicit, and normal preflight is not a malformed snapshot',async()=>{
 const s=setup(),missed=request(),preflight=request({method:'OPTIONS'});
 s.page.emit('response',response(missed));s.page.emit('request',preflight);s.page.emit('response',response(preflight,{body:{}}));await s.observer.stop();
 const [late,options]=s.report.membershipResponses;
 assert.equal(late.requestObserved,false);assert.equal(late.startedAt,null);assert.equal(allowingMembershipResponse(late,account),false);
 assert.equal(safeMembershipEvidence(late).startedAt,null);
 assert.equal(options.bodyState,'not_applicable');assert.equal(options.snapshot,null);
});

test('successful and earlier failed attempts serialize diagnostics with reporter identity and no arbitrary payload',async t=>{
 const s=setup();
 const dir=mkdtempSync(path.join(os.tmpdir(),'qa-membership-evidence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const old=process.env.QA_FEATURES;t.after(()=>{if(old===undefined)delete process.env.QA_FEATURES;else process.env.QA_FEATURES=old;});
 process.env.QA_FEATURES=path.join(dir,'checklist.json');writeFileSync(process.env.QA_FEATURES,JSON.stringify([{id:'AUTH-009',name:'Membership'}]));
 const file=path.join(dir,'results.json'),reporter=new ResultsReporter({outputFile:file});
 for(const retry of [0,1]) {
  const req=request();s.page.emit('request',req);s.page.emit('response',response(req,{body:{...snapshot(),billingEnabled:Boolean(retry),raw:'DO-NOT-RETAIN'}}));await s.observer.flush();
  // Pass the observer's actual typed snapshot unchanged through annotation JSON and the reporter.
  const observation={...s.report.membershipResponses.at(-1),secret:'DO-NOT-RETAIN',test:'forged',retry:99};
  const annotation={type:'qa-membership-response',description:JSON.stringify(observation)};
  const tc={titlePath:()=>['','membership.spec.mjs','automatic retry'],tags:['@AUTH-009'],annotations:[annotation],location:{file:path.join(process.cwd(),'qa-lab/e2e/membership.spec.mjs')}};
  reporter.onTestEnd(tc,{status:retry?'passed':'failed',duration:1,retry,annotations:[annotation],attachments:[]});
 }
 await s.observer.stop();
 reporter.onEnd({status:'passed'});const out=JSON.parse(readFileSync(file,'utf8'));
 assert.equal(out.membershipResponses.length,2);assert.deepEqual(out.membershipResponses.map(r=>r.retry),[0,1]);assert.deepEqual(out.membershipResponses.map(r=>r.attemptStatus),['failed','passed']);
 assert.ok(out.membershipResponses.every(r=>r.test==='membership.spec.mjs > automatic retry'));
 assert.deepEqual(out.membershipResponses.map(r=>r.snapshot),[false,true].map(billingEnabled=>({...snapshot(),billingEnabled})));
 assert.ok(out.membershipResponses.every(r=>allowingMembershipResponse(r,account)));
 assert.deepEqual(out.membershipResponses.map(safeMembershipEvidence),out.membershipResponses.map(r=>safeMembershipEvidence(safeMembershipEvidence(r))));
 assert.ok(!JSON.stringify(out).includes('DO-NOT-RETAIN'));assert.deepEqual(out.healthClientClaims,[]);
 assert.equal(safeMembershipEvidence({secret:'DO-NOT-RETAIN'}).completion,'malformed_evidence');
});
