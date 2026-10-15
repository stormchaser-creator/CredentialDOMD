// The actual inbound handler with the existing in-memory I/O fixture. No live
// receiving, database or provider calls; fault hooks exercise the ledger edge.
import {test,before,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {loadFunction,resetWorld,deliver,harness,RESEND} from './email-inbound-harness.mjs';
const providerFetch=globalThis.fetch;
const message={id:'claim-synthetic',messageId:'<claim-synthetic@mx.example>',from:'sender@clinic.example',to:'support@credentialdomd.com',subject:'Synthetic claim regression',text:'Synthetic message'};
const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
let baseFrom;
const rows=()=>harness.db.rows('inbound_emails');
const seed=(status,over={})=>rows().push({id:'synthetic-ledger',message_id:message.messageId,email_id:message.id,from_addr:message.from,to_addr:message.to,route:'forward',status,created_at:ago(20),updated_at:ago(20),...over});
before(async()=>{await loadFunction();baseFrom=harness.db.from;});
beforeEach(()=>{resetWorld();harness.db.from=baseFrom;globalThis.fetch=providerFetch;});
afterEach(()=>{harness.db.from=baseFrom;globalThis.fetch=providerFetch;});
function intercept(hook){harness.db.from=table=>{const q=baseFrom(table),run=q.run.bind(q);q.run=()=>hook(q,run);return q;};}
for(const status of ['done','unregistered','rate_limited'])test(`${status} is an established terminal duplicate and creates no repeated effects`,async()=>{
 seed(status);const result=await deliver(message);assert.equal(result.status,200);assert.equal(result.body.duplicate,true);assert.equal(harness.sent.length,0);assert.equal(rows()[0].status,status);
});
test('a failed duplicate lookup is retryable instead of silently acknowledged',async()=>{
 seed('failed');intercept((q,run)=>q.table==='inbound_emails'&&q.op==='select'&&!q.opts.head?{data:null,error:{message:'Synthetic lookup transport failure'}}:run());
 const result=await deliver(message);assert.equal(result.status,500);assert.equal(result.body.duplicate,undefined);assert.equal(rows()[0].status,'failed');assert.equal(harness.sent.length,0);
});
test('a failed reclaim write is retryable and does not acknowledge the unfinished message',async()=>{
 seed('failed');intercept((q,run)=>q.table==='inbound_emails'&&q.op==='update'?{data:null,error:{message:'Synthetic reclaim transport failure'}}:run());
 const result=await deliver(message);assert.equal(result.status,500);assert.equal(result.body.duplicate,undefined);assert.equal(harness.sent.length,0);
});
test('a processing attempt is retryable until its updated lease expires, not terminally acknowledged',async()=>{
 seed('processing',{created_at:ago(1),updated_at:ago(1)});const result=await deliver(message);assert.equal(result.status,503);assert.equal(result.body.duplicate,undefined);assert.equal(harness.sent.length,0);assert.equal(rows()[0].status,'processing');
});
test('an INSERT that committed but lost its response stays retryable and later recovers exactly once',async()=>{
 let lost=true;intercept((q,run)=>{const result=run();if(q.table==='inbound_emails'&&q.op==='insert'&&!result.error&&lost){lost=false;Object.assign(rows()[0],{status:'processing',updated_at:rows()[0].created_at});return{data:null,error:{message:'An invalid response was received from the upstream server',code:''},status:502};}return result;});
 const first=await deliver(message);assert.equal(first.status,500);assert.equal(rows().length,1);assert.equal(harness.sent.length,0);
 const retry=await deliver(message);assert.equal(retry.status,503);assert.equal(retry.body.duplicate,undefined);assert.equal(harness.sent.length,0);
 rows()[0].updated_at=ago(11);const resumed=await deliver(message);assert.equal(resumed.status,200);assert.equal(rows()[0].status,'done');assert.equal(harness.sent.length,1);
 const duplicate=await deliver(message);assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);assert.equal(harness.sent.length,1);
});
test('recently reclaimed old rows cannot immediately be reclaimed again while the current handler is running',{timeout:5000},async()=>{
 seed('failed');let release,entered;const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});let hold=true;
 globalThis.fetch=async(input,init)=>{const url=String(input instanceof Request?input.url:input);if(hold&&url.split('?')[0]===`${RESEND}/emails/receiving/${message.id}`){hold=false;entered();await gate;}return providerFetch(input,init);};
 const first=deliver(message);await ready;let second,sentBeforeRelease;
 try{second=await deliver(message);sentBeforeRelease=harness.sent.length;}finally{release();await first;}
 assert.deepEqual([second.status,sentBeforeRelease,harness.sent.length],[503,0,1],'the second delivery cannot start or send while the first claimed route is active');
 assert.equal(second.body.duplicate,undefined);assert.equal(rows()[0].status,'done');
});
test('a lost compare-and-swap race remains retryable and cannot process the winner’s claim',async()=>{
 seed('failed');intercept((q,run)=>{if(q.table==='inbound_emails'&&q.op==='update'){Object.assign(rows()[0],{status:'processing',updated_at:new Date().toISOString()});return{data:null,error:null};}return run();});
 const result=await deliver(message);assert.equal(result.status,503);assert.equal(result.body.duplicate,undefined);assert.equal(harness.sent.length,0);
});
for(const variant of ['missing','unknown','invalid-time','null-time'])test(`unexpected ${variant} duplicate state never becomes a successful acknowledgement`,async()=>{
 seed(variant==='unknown'?'not-a-real-state':'processing',{updated_at:variant==='invalid-time'?'not-a-date':variant==='null-time'?null:ago(20)});
 if(variant==='missing')intercept((q,run)=>q.table==='inbound_emails'&&q.op==='select'&&!q.opts.head?{data:null,error:null}:run());
 const result=await deliver(message);assert.equal(result.status,500);assert.equal(result.body.duplicate,undefined);assert.equal(harness.sent.length,0);
});
for(const status of ['failed','processing'])test(`an eligible ${status} attempt is reclaimed once and completed duplicates stay idempotent`,async()=>{
 seed(status);const first=await deliver(message);assert.equal(first.status,200);assert.equal(rows().length,1);assert.equal(rows()[0].status,'done');assert.equal(harness.sent.length,1);
 const duplicate=await deliver(message);assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);assert.equal(harness.sent.length,1);
});

test('a missing successful INSERT receipt is not a duplicate acknowledgement',async()=>{
 intercept((q,run)=>q.table==='inbound_emails'&&q.op==='insert'?{data:null,error:null}:run());
 const result=await deliver(message);assert.equal(result.status,500);assert.equal(result.body.duplicate,undefined);assert.equal(rows().length,0);assert.equal(harness.sent.length,0);
});
test('a reclaim receipt for a different row cannot authorize processing',async()=>{
 seed('failed');intercept((q,run)=>q.table==='inbound_emails'&&q.op==='update'?{data:{id:'another-ledger'},error:null}:run());
 const result=await deliver(message);assert.equal(result.status,500);assert.equal(result.body.duplicate,undefined);assert.equal(rows()[0].status,'failed');assert.equal(harness.sent.length,0);
});
