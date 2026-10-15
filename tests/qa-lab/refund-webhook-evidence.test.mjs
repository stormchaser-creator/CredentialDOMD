import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REFUND_FAULT_KIND, REFUND_FAULT_LINE, bindRefundDeliveries } from '../../qa-lab/lib/refund-webhook-evidence.mjs';
import { EDGE_NEGATIVES, edgeErrorObservations, edgeRequestClaim, aggregateEdgeObservations, reconcileEdgeClaims } from '../../qa-lab/lib/edge-health-claims.mjs';
import { observeRefundWebhookFault } from '../../qa-lab/e2e/support/refund-webhook-health.mjs';
import { localContainer } from '../../qa-lab/lib/config.mjs';
import { assessLabHealth } from '../../qa-lab/lib/health-evidence.mjs';
import { buildReview } from '../../qa-lab/report.mjs';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
const t = n => new Date(Date.UTC(2026,9,1,12)+n).toISOString();
const receipt = n => ({ container: localContainer('edge_runtime'), containerId: 'a'.repeat(64), hostStartedAt:t(n),hostFinishedAt:t(n),dockerAt:t(n).replace('Z','000000Z'),elapsedNs:'0',hostSamplingNs:'0' });
const expected = { refundId:'re_Synthetic',chargeId:'ch_Synthetic',customer:'cus_Synthetic' };
const stamp = {test:'intentional refund.failed',file:'pay-first-refund.spec.mjs',retry:0,repeatEachIndex:0,attemptStatus:'passed'};
const delivered = (i,type) => ({event:`evt_Synthetic${i}`,type,endpoint:'limited-stripe-webhook',status:200,response:'{"received":true}',at:t(1100+i*100),object:expected.refundId,customer:null,attempt:1,willRetry:false,final:true});
const outer = () => ({refund:{id:expected.refundId,charge:expected.chargeId,status:'failed',failure_reason:'expired_or_canceled_card'},charge:{id:expected.chargeId,customer:expected.customer,amount_refunded:0,refunded:false},deliveries:[delivered(1,'charge.refund.updated'),delivered(2,'refund.failed')]});
const journal = () => ({since:t(0),until:t(3000),startedAt:t(0),complete:true,incompleteAttempts:0,deliveries:outer().deliveries.map((d,i)=>({...d,auditId:`aaaaaaaa-0000-4000-8000-00000000000${i+1}`,sequence:i+1,attemptStartedAt:t(1100+i*150)}))});
const rows = () => edgeErrorObservations(`${t(1150).replace('Z','000001Z')} ${REFUND_FAULT_LINE}`);
function sample(){
 const audit=journal(); const request={id:'bbbbbbbb-0000-4000-8000-000000000001',kind:REFUND_FAULT_KIND,expected,startedAt:t(1000),finishedAt:t(2000),url:'http://127.0.0.1:55580/qa/stripe/refunds/re_Synthetic/fail',path:'/qa/stripe/refunds/re_Synthetic/fail',method:'POST',status:200,responseText:JSON.stringify(outer()),clock:{before:receipt(1000),after:receipt(2000)},...stamp};
 request.deliveryProof=bindRefundDeliveries(request,{...audit,since:request.startedAt,until:request.finishedAt});
 const raw=rows(),claim={...edgeRequestClaim(raw,request,{kind:'refund_failed_webhook',reason:'one injected accepted-refund failure'}),...stamp};
 const health={since:t(0),until:t(3000),edgeClock:{before:receipt(0),after:receipt(3000)},edgeErrorObservations:raw,edgeFunctionErrors:aggregateEdgeObservations(raw),clientErrors:[],clientErrorObservations:[],zombies:[],runawayPostgrestRetries:0};
 return {audit,request,raw,claim,health};
}
function check(s=sample()) { const r=reconcileEdgeClaims(s.health,s.requests||[s.request],s.claims||[s.claim],s.audit);return {...r,assessment:assessLabHealth({...s.health,claimProblems:r.problems},r.evidence)}; }
const clone = v=>structuredClone(v);
test('two exact journal-proven successful webhooks justify only the one deliberate state-transition log',()=>{
 const s=sample(),r=check(s);assert.equal(r.assessment.ready,true);assert.equal(r.matched.length,1);assert.equal(r.evidence[0].count,1);
 // The report recomputes from raw proof, not from a stored readiness flag.
 const result={runStatus:'passed',readiness:{ready:true},features:{'BILL-005':{status:'pass',evidence:[{status:'pass',checks:[]}]}},labHealth:s.health,billingDeliveryAudit:s.audit,healthEdgeRequests:[s.request],healthEdgeClaims:[s.claim]};
 assert.equal(buildReview([{id:'BILL-005',name:'Refund'}],result).readiness.ready,true);
 result.billingDeliveryAudit.deliveries[0].object='re_Other';assert.equal(buildReview([{id:'BILL-005',name:'Refund'}],result).readiness.ready,false);
});
test('report counts a two-log refund503 bundle as two verified occurrences',()=>{
 const s=sample(), spec=EDGE_NEGATIVES.refund_provider_retry;
 const raw=edgeErrorObservations(`${t(1150).replace('Z','000001Z')} ${spec.precedingLines[0]}\n${t(1150).replace('Z','000002Z')} ${spec.line}`);
 const request={...s.request,kind:undefined,url:'http://127.0.0.1:55521/functions/v1/limited-refund',path:'/functions/v1/limited-refund',status:503,responseText:'{"error":"refund_pending"}'};
 const claim={...edgeRequestClaim(raw,request,{kind:'refund_provider_retry',reason:'injected500'}),...stamp};
 const health={...s.health,edgeErrorObservations:raw,edgeFunctionErrors:aggregateEdgeObservations(raw)};
 const result={runStatus:'passed',readiness:{ready:true},features:{'BILL-005':{status:'pass',evidence:[{status:'pass',checks:[]}]}},labHealth:health,healthEdgeRequests:[request],healthEdgeClaims:[claim]};
 const review=buildReview([{id:'BILL-005',name:'Refund'}],result);assert.equal(review.readiness.ready,true);assert.equal(review.health.edgeClaims.matchedOccurrences,2);
});
test('missing, incomplete, stale, malformed, duplicate or changed journal receipts never justify the error',()=>{
 for(const change of [
  s=>{s.audit=undefined;},s=>{s.audit.complete=false;},s=>{s.audit.since=t(1);},s=>{s.audit.startedAt=t(1001);},s=>{s.audit.incompleteAttempts=1;},
  s=>{s.audit.deliveries.pop();},s=>{s.audit.deliveries.push(clone(s.audit.deliveries[0]));},
  s=>{s.audit.deliveries[0].auditId='cccccccc-0000-4000-8000-000000000001';},s=>{s.audit.deliveries[0].sequence=9;},
  s=>{s.audit.deliveries[0].status=503;},s=>{s.audit.deliveries[0].response='{"unexpected":true}';},
  s=>{s.audit.deliveries[0].object='re_Other';},s=>{s.audit.deliveries[0].customer='cus_Other';},
  s=>{s.audit.deliveries[0].attemptStartedAt=t(999);},s=>{s.audit.deliveries[1].attemptStartedAt=t(1150);},
  s=>{s.request.deliveryProof.reverse();},s=>{s.request.deliveryProof[0].sequence=999;},
 ]) {const s=sample();change(s);assert.equal(check(s).assessment.ready,false,change.toString());}
});
test('outer fault status/body, refund ownership, endpoint, clock and action window are exact',()=>{
 for(const change of [
  s=>{s.request.status=503;},s=>{s.request.url=s.request.url.replace('127.0.0.1','example.com');},s=>{s.request.method='GET';},
  s=>{s.request.expected={...expected,customer:'cus_Other'};},s=>{s.request.expected={...expected,refundId:'re_Other'};},
  s=>{s.request.expected={...expected,chargeId:'ch_Other'};},s=>{s.request.responseText='null';},
  s=>{s.request.responseText=s.request.responseText.replace('expired_or_canceled_card','unknown');},
  s=>{const b=JSON.parse(s.request.responseText);b.deliveries[0].response='{"received":false}';s.request.responseText=JSON.stringify(b);},
  s=>{s.request.responseText=s.request.responseText.replace('"status":200','"status":202');},
  s=>{s.request.clock.after.containerId='b'.repeat(64);},s=>{s.request.startedAt=t(1201);},s=>{s.request.finishedAt=t(1250);},
 ]){const s=sample();change(s);assert.equal(check(s).assessment.ready,false,change.toString());}
});
test('ambiguous log multiplicity, unrelated/refired failures, duplicate claims and reused audit identities remain red',()=>{
 const s=sample(),extra=edgeErrorObservations(`${t(1350).replace('Z','000001Z')} ${REFUND_FAULT_LINE}`);
 for(const at of [t(1350),t(2100)]){const x=sample();x.health.edgeErrorObservations.push(...edgeErrorObservations(`${at.replace('Z','000001Z')} ${REFUND_FAULT_LINE}`));x.health.edgeFunctionErrors=aggregateEdgeObservations(x.health.edgeErrorObservations);assert.equal(check(x).assessment.ready,false);}
 const duplicate=sample();duplicate.claims=[duplicate.claim,duplicate.claim];assert.equal(check(duplicate).assessment.ready,false);
 const reused=sample();const request2={...clone(reused.request),id:'bbbbbbbb-0000-4000-8000-000000000002'};reused.requests=[reused.request,request2];reused.claims=[reused.claim,{...reused.claim,requestId:request2.id}];assert.equal(check(reused).assessment.ready,false);
 const other=sample();other.audit.deliveries.push({...clone(other.audit.deliveries[1]),event:'evt_Unrelated',auditId:'aaaaaaaa-0000-4000-8000-000000000003',sequence:3});assert.equal(check(other).assessment.ready,false);
});
test('a different failed-refund attempt crossing either action boundary cannot supply the selected log',()=>{
 for(const type of ['charge.refund.updated','refund.failed','refund.updated']) for(const [start,end] of [[900,1150],[1900,2100],[900,2100]]){
  const s=sample();s.audit.deliveries.push({...clone(s.audit.deliveries[0]),type,event:'evt_Crossing',object:'re_Other',auditId:'aaaaaaaa-0000-4000-8000-000000000003',sequence:3,attemptStartedAt:t(start),at:t(end)});
  assert.equal(check(s).assessment.ready,false,`${start} to ${end}`);
 }
});
test('competing events in measured clock-sampling gaps are rejected without an invented time tolerance',()=>{
 for(const [start,end,logAt] of [[910,975,950],[2025,2090,2060]]){
  const s=sample();s.request.clock={before:{...receipt(925),hostStartedAt:t(900),hostFinishedAt:t(950),elapsedNs:'50000000'},after:{...receipt(2075),hostStartedAt:t(2050),hostFinishedAt:t(2100),elapsedNs:'50000000'}};
  s.health.edgeErrorObservations=edgeErrorObservations(`${t(logAt).replace('Z','000001Z')} ${REFUND_FAULT_LINE}`);s.health.edgeFunctionErrors=aggregateEdgeObservations(s.health.edgeErrorObservations);
  s.claim={...edgeRequestClaim(s.health.edgeErrorObservations,s.request,{kind:'refund_failed_webhook',reason:'measured clock gap control'}),...stamp};
  s.audit.deliveries.push({...clone(s.audit.deliveries[0]),type:'refund.updated',event:'evt_ClockGap',object:'re_Other',auditId:'aaaaaaaa-0000-4000-8000-000000000003',sequence:3,attemptStartedAt:t(start),at:t(end)});
  assert.equal(check(s).assessment.ready,false,`${start} to ${end}`);
 }
});
function deps(s,changes={}){const times=[s.request.startedAt,s.request.finishedAt],clocks=[s.request.clock.before,s.request.clock.after];return {now:()=>times.shift(),clock:()=>clocks.shift(),read:()=>s.raw,...changes};}
test('collector sends the fault once, then reads immutable journal; repeated Docker reads cannot replay the fault',async()=>{
 const s=sample(),calls=[],recorded=[];let tick=0,reads=0;
 const captured=await observeRefundWebhookFault('http://127.0.0.1:55580',expected,deps(s,{recordRequest:r=>recorded.push(r),monotonic:()=>tick,pause:async ms=>{tick+=ms;},read:()=>++reads===1?[]:s.raw,fetcher:async(url,options)=>{calls.push({url,options});return url.includes('/delivery-audit?')?{ok:true,json:async()=>({...s.audit,since:s.request.startedAt,until:s.request.finishedAt})}:{status:200,url,text:async()=>s.request.responseText};}}));
 assert.equal(calls.filter(c=>c.options.method==='POST').length,1);assert.equal(calls.length,2);assert.equal(reads,2);assert.equal(recorded.length,1);assert.deepEqual(captured.request.deliveryProof,s.request.deliveryProof);
 assert.deepEqual(JSON.parse(calls[0].options.body),{reason:'expired_or_canceled_card'});
});
test('collector retains unexpected HTTP/body/journal diagnostics and never grants a claim',async()=>{
 for(const mode of ['status','body','journal']){const s=sample(),recorded=[];let posts=0;await assert.rejects(observeRefundWebhookFault('http://127.0.0.1:55580',expected,deps(s,{recordRequest:r=>recorded.push(r),fetcher:async(url,options)=>{if(options.method==='POST')posts++;if(url.includes('/delivery-audit?'))return {ok:false};return {status:mode==='status'?503:200,url,text:async()=>{if(mode==='body')throw Error('body lost');return s.request.responseText;}};}})));assert.equal(posts,1);assert.equal(recorded.length,1);assert.ok(recorded[0].captureProblem);}
});

// Exercise real handler source against the existing billing fixture. The
// unchanged disposable PostgreSQL suite separately proves the SQL duplicate branch.
const fixtureSource=readFileSync(new URL('../billing/limited-refund.test.mjs',import.meta.url),'utf8');
const declarations=fixtureSource.slice(fixtureSource.indexOf('const config ='),fixtureSource.indexOf("\ntest('"));
const {fixture,refundReq}=new Function('assert','LIMITED_LAUNCH','limitedOffer','createLimitedLaunchHandlers',`${declarations}\nreturn {fixture,refundReq};`)(assert,LIMITED_LAUNCH,limitedOffer,createLimitedLaunchHandlers);
test('real handler: first failed event logs once; second event and exact replay200 add no error or ticket',async()=>{
 const f=fixture();assert.equal((await f.handlers().refund(refundReq())).status,200);const refund=f.refunds[0];refund.status='failed';refund.failure_reason='expired_or_canceled_card';
 for(const [i,type] of ['charge.refund.updated','refund.failed','refund.failed'].entries()){
  f.deps.verifyEvent=async()=>({id:`evt_Fault${i===2?1:i}`,type,livemode:false,data:{object:{id:refund.id}}});
  const response=await f.handlers().webhook(new Request('https://fixture.invalid/webhook',{method:'POST',headers:{'stripe-signature':'synthetic'},body:'{}'}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{received:true});assert.equal(f.ledger[0].state,'needs_support');assert.equal(f.tickets.length,1);assert.equal(f.logs.length,1);
 }
 assert.equal(`[Error] ${JSON.stringify(f.logs[0])}`,REFUND_FAULT_LINE);
});
