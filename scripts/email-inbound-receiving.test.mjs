// The real inbound handler with synthetic I/O only. Retrieving metadata is
// retried before request creation or acknowledgement, never by rerunning the route.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadFunction, resetWorld, deliver, harness, RESEND } from './email-inbound-harness.mjs';
const providerFetch=globalThis.fetch;
const PROFILE='00000000-0000-4000-8000-000000000081', ME='physician@clinic.example', REQUESTER='coordinator@agency.example';
const rows=t=>harness.db.rows(t);
const message={id:'receiving-synthetic',from:`Synthetic Physician <${ME}>`,to:'docs@credentialdomd.com',subject:'Fwd: Credentials requested',text:`---------- Forwarded message ---------\nFrom: Coordinator <${REQUESTER}>\nDate: Tue, Sep 29, 2026 at 10:00 AM\nSubject: Credentials requested\nTo: ${ME}\n\nPlease send your current CV.\nThank you.`};
before(async()=>{await loadFunction()});
beforeEach(()=>{
 resetWorld();globalThis.fetch=providerFetch;
 rows('mailbox_claims').push({address:ME,profile_id:PROFILE,proof:'verified',terminal_at:null});
 rows('profiles').push({id:PROFILE,auth_user_id:'user_synthetic',email:ME,verified_email:ME,access_status:'active',deleted_at:null,name:'Synthetic Physician',degree_type:'MD',ack_requests:true});
});
afterEach(()=>{globalThis.fetch=providerFetch});
function fault(target,reply){let n=0;globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 const metadata=url.startsWith(`${RESEND}/emails/receiving/`);
 if(metadata&&(target==='email'?!url.includes('/attachments'):url.includes('/attachments'))){n++;const result=await reply(n,url,init);if(result)return result;}
 return providerFetch(input,init);
};return()=>n;}
for(const target of ['email','attachments'])test(`transient ${target} metadata failure still creates one request and one requester acknowledgement`,async()=>{
 const calls=fault(target,n=>{if(n===1)throw new TypeError('connection closed before message completed')});
 const result=await deliver(message);
 assert.equal(result.status,200);assert.equal(calls(),2);assert.equal(rows('document_requests').length,1);
 assert.equal(rows('inbound_emails').length,1);assert.equal(rows('inbound_emails')[0].status,'done');
 assert.equal(harness.sent.filter(m=>m.to?.includes(REQUESTER)).length,1);
 assert.equal(harness.sent.filter(m=>m.to?.includes(ME)).length,1);
 const duplicate=await deliver(message);assert.equal(duplicate.body.duplicate,true);assert.equal(calls(),2);
 assert.equal(rows('document_requests').length,1);assert.equal(harness.sent.length,2);
});
test('a self-addressed forward survives a transient metadata failure without acknowledging itself',async()=>{
 const calls=fault('email',n=>{if(n===1)throw new TypeError('connection closed before message completed')});
 const self={...message,id:'receiving-self-synthetic',text:message.text.replaceAll(REQUESTER,ME)};
 const result=await deliver(self);
 assert.equal(result.status,200);assert.equal(calls(),2);assert.equal(rows('document_requests').length,1);
 assert.equal(rows('inbound_emails')[0].status,'done');
 assert.equal(harness.sent.length,1);assert.ok(harness.sent[0].to.includes(ME));
 const duplicate=await deliver(self);assert.equal(duplicate.body.duplicate,true);
 assert.equal(rows('document_requests').length,1);assert.equal(harness.sent.length,1);
});
for(const permanent of ['transport','http','malformed'])test(`continuing ${permanent} failure stays visible and the failed ledger can be reclaimed`,async()=>{
 const calls=fault('email',()=>{if(permanent==='transport')throw new TypeError('connection remains closed');if(permanent==='http')return new Response('unavailable',{status:503});return new Response('not-json');});
 const result=await deliver(message);
 assert.equal(result.status,500);assert.equal(calls(),permanent==='transport'?2:1);
 assert.equal(rows('inbound_emails').length,1);assert.equal(rows('inbound_emails')[0].status,'failed');
 assert.ok(rows('inbound_emails')[0].detail);assert.equal(rows('document_requests').length,0);assert.equal(harness.sent.length,0);
 globalThis.fetch=providerFetch;
 const recovered=await deliver(message);assert.equal(recovered.status,200);
 assert.equal(rows('inbound_emails').length,1);assert.equal(rows('inbound_emails')[0].status,'done');
 assert.equal(rows('document_requests').length,1);assert.equal(harness.sent.filter(m=>m.to?.includes(REQUESTER)).length,1);
});
