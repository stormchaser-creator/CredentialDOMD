import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_OPERATIONS_ENABLED, createSupportOperationsClient, supportActorLabel } from '../../src/utils/supportOperationsClient.js';

const id='10000000-0000-4000-8000-000000000001';
const other='10000000-0000-4000-8000-000000000002';
const input={subject:'A question',body:'A valid support question',category:'feedback',priority:'urgent'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function setup(fetchImpl, extra={}) {
  const session={user:{id:'user_a'},getToken:async()=> 'synthetic-token'};
  return {session,client:createSupportOperationsClient({accountId:'user_a',enabled:true,url:'https://project.invalid',anonKey:'public-test-key',getSession:()=>session,uuid:()=>id,fetchImpl,...extra})};
}
test('new API is disabled by default and never silently falls back to legacy mutation',async()=>{
  assert.equal(SUPPORT_OPERATIONS_ENABLED,false);
  let calls=0;
  const {client}=setup(async()=>{calls++;throw Error('must not call');},{enabled:false});
  await assert.rejects(client.create(input),/not enabled/);assert.equal(calls,0);
});
test('lost response retries the exact request UUID and body without account or role fields',async()=>{
  const requests=[];
  const {client}=setup(async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    if(requests.length===1) throw Error('connection lost after commit');
    return json({state:'queued',ticket_id:id,duplicate:true});
  });
  await assert.rejects(client.create({...input,profileId:other,isAdmin:true}),/connection lost/);
  await assert.rejects(client.create({...input,body:'Changed after an uncertain send'}),/previous message/);
  await client.create(input);
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.deepEqual(requests[0],{operation:'create_ticket',...input,requestId:id});
});
test('double click shares one in-flight request and provider success is not invented',async()=>{
  let release,calls=0;
  const {client}=setup(async()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const a=client.create(input),b=client.create(input);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  release(json({state:'queued',ticket_id:id}));await Promise.all([a,b]);
  const malformed=setup(async()=>json({ok:true})).client;
  await assert.rejects(malformed.reply({ticketId:id,body:'Follow up'}),/could not confirm receipt/);
});
test('confirmed read reconciles a lost reply receipt so a new reply can proceed',async()=>{
  let calls=0;const sent=[];
  const {client}=setup(async(_url,options)=>{
    const request=JSON.parse(options.body);sent.push(request);calls++;
    if(calls===1) throw Error('lost acknowledgement');
    if(request.operation==='read_ticket') return json({ticket:{id},messages:[{id:other,ticket_id:id,request_id:id,body:'First reply',actor_kind:'you'}],has_more:false});
    return json({state:'queued',ticket_id:id});
  });
  await assert.rejects(client.reply({ticketId:id,body:'First reply'}));
  const read=await client.read(id);assert.equal(read.messages[0].identity_source,'support-operations');
  await client.reply({ticketId:id,body:'Second reply'});assert.equal(sent.at(-1).body,'Second reply');
});
test('uncertain create and per-ticket reply drafts survive navigation and retry unchanged',async()=>{
  const requests=[];let failing=true;
  const {client}=setup(async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);
    if(request.operation==='list_tickets') return json({tickets:[]});
    if(failing) throw Error('request did not reach server');
    return json({state:'queued',ticket_id:id});
  });
  await assert.rejects(client.create(input));await client.list();
  const restored=client.createDraft();assert.deepEqual(restored,{operation:'create_ticket',...input});
  restored.body='Attempt to change stored draft';assert.equal(client.createDraft().body,input.body);
  await assert.rejects(client.reply({ticketId:id,body:'Original reply'}));
  assert.equal(client.replyDraft(other),null);assert.equal(client.replyDraft(id).body,'Original reply');
  failing=false;
  await client.create(client.createDraft());await client.reply(client.replyDraft(id));
  assert.equal(client.createDraft(),null);assert.equal(client.replyDraft(id),null);
  const creates=requests.filter(r=>r.operation==='create_ticket');const replies=requests.filter(r=>r.operation==='reply_ticket');
  assert.deepEqual(creates[0],creates[1]);assert.deepEqual(replies[0],replies[1]);
});
test('account changes before token issuance or after response cannot expose old-account data',async()=>{
  let releaseToken,releaseResponse,calls=0;
  let session={user:{id:'user_a'},getToken:()=>new Promise(resolve=>{releaseToken=resolve;})};
  const {client}=setup(async()=>{calls++;return new Promise(resolve=>{releaseResponse=resolve;});},{getSession:()=>session});
  const before=client.list();session={user:{id:'user_b'},getToken:async()=> 'b'};releaseToken('a');
  await assert.rejects(before,/sign-in changed/);assert.equal(calls,0);
  session={user:{id:'user_a'},getToken:async()=> 'a'};
  const after=client.list();await new Promise(resolve=>setImmediate(resolve));
  session={user:{id:'user_b'},getToken:async()=> 'b'};releaseResponse(json({tickets:[{id,subject:'Private old account'}]}));
  await assert.rejects(after,/sign-in changed/);
});
test('read result must match the requested ticket and identity does not trust legacy flags or emails',async()=>{
  const {client}=setup(async()=>json({ticket:{id},messages:[{id:other,ticket_id:other}]}));
  await assert.rejects(client.read(id),/Could not load this ticket/);
  assert.equal(supportActorLabel({is_admin_reply:true,author_email:'eric@example.invalid'}),'Reply');
  assert.equal(supportActorLabel({author_id:id,is_admin_reply:false},id),'You');
  assert.equal(supportActorLabel({author_id:id,is_admin_reply:true},id),'Reply');
  assert.equal(supportActorLabel({identity_source:'support-operations',actor_kind:'automated'}),'CredentialDOMD Support · Automated');
  assert.equal(supportActorLabel({identity_source:'support-operations',actor_kind:'support'}),'Support team');
});
