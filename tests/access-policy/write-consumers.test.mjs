import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const id='10000000-0000-4000-8000-000000000001';
const profile={id,auth_user_id:'user_a',access_status:'active',deleted_at:null,email:'synthetic@example.invalid',verified_email:'synthetic@example.invalid'};
async function harness(route,snapshot={enforcementEnabled:true,credential:false,practice:false}) {
  const state={rpcs:[],fetches:[],writes:[],reads:[]};
  const db={
    rpc:async(name,args)=>{state.rpcs.push({name,args});return snapshot instanceof Error?{error:{code:'XX000'}}:{data:snapshot};},
    from(table){
      state.reads.push(table);
      const result=()=>({data:table==='profiles'?profile:table==='mailbox_claims'?{profile_id:id,proof:'clerk',terminal_at:null}:[],count:0,error:null});
      const q={then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);},maybeSingle:async()=>result()};
      for(const op of ['select','eq','neq','is','gte','in'])q[op]=()=>q;
      q.update=row=>{state.writes.push({table,row});return q;};
      q.insert=row=>{state.writes.push({table,row});return q;};
      return q;
    },
  };
  const context={Request,Response,Headers,URL,AbortController,TextEncoder,TextDecoder,Uint8Array,Buffer,setTimeout,clearTimeout,
    console:{log(){},warn(){},error(){}},db,state,
    identity:{profileId:id,clerkSubject:'user_a',isAdmin:false,db},
    fetch:async(url)=>{state.fetches.push(String(url));return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');},
  };
  context.Deno={env:{get:key=>['RESEND_API_KEY','RESEND_WEBHOOK_SECRET'].includes(key)?'SYNTHETIC':undefined},serve:handler=>{context.handler=handler;}};
  const filename=path.join(root,'supabase/functions',route,'index.ts');
  let contents=await readFile(filename,'utf8');
  if(route==='email-inbound')contents+='\nglobalThis.intakeHandlers={handleCme,handleContacts,handleDocsRequest};';
  const built=await build({stdin:{contents,resolveDir:path.dirname(filename),loader:'ts'},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent',plugins:[{name:'offline-only',setup(b){
    b.onResolve({filter:/clerkAuth\.ts$/},()=>({path:'auth',namespace:'mock'}));
    b.onResolve({filter:/^https:/},args=>({path:args.path,namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},args=>{
      const p=args.path;
      const code=p==='auth'?'export const clerkProfile=async()=>globalThis.identity;':
        p.endsWith('/server.ts')?'export const serve=handler=>{globalThis.handler=handler;};':
        p.includes('supabase-js')?'export const createClient=()=>globalThis.db;':
        p.includes('svix')?'export class Webhook {}':
        p.includes('base64')?'export const encodeBase64=()=>"SYNTHETIC";':null;
      if(code===null)throw Error('unmocked remote import '+p);
      return {contents:code,loader:'js'};
    });
  }}]});
  context.module={exports:{}};context.exports=context.module.exports;
  vm.runInNewContext(built.outputFiles[0].text,context);
  return {context,state};
}
for(const suffix of ['','/v1/messages'])test('real AI handler denies paid POST before key/quota/provider work '+suffix,async()=>{
  const {context,state}=await harness('ai-proxy');
  const response=await context.handler(new Request('https://synthetic.invalid/ai-proxy'+suffix,{method:'POST',body:'{}'}));
  assert.equal(response.status,403);assert.equal((await response.json()).error,'membership_read_only');
  assert.equal(state.fetches.length,0);assert.equal(state.reads.length,0);assert.equal(state.writes.length,0);
  assert.equal(state.rpcs.length,1);
});
test('real AI GET status remains available without membership RPC',async()=>{
  const {context,state}=await harness('ai-proxy');
  const response=await context.handler(new Request('https://synthetic.invalid/ai-proxy'));
  assert.equal(response.status,200);assert.equal(state.rpcs.length,0);assert.equal(state.fetches.length,0);
});
test('real CallSync handler requires Practice before upstream',async()=>{
  const {context,state}=await harness('callsync-feed',{enforcementEnabled:true,credential:true,practice:false});
  const response=await context.handler(new Request('https://synthetic.invalid/callsync-feed',{method:'POST',body:JSON.stringify({url:'https://callsync.anmg-ca.com/api/ical?token=synthetic-token'})}));
  assert.equal(response.status,403);assert.equal(state.fetches.length,0);
});
test('real CallSync OFF path still returns synthetic feed',async()=>{
  const {context,state}=await harness('callsync-feed',{enforcementEnabled:false,credential:true,practice:true});
  const response=await context.handler(new Request('https://synthetic.invalid/callsync-feed',{method:'POST',body:JSON.stringify({url:'https://callsync.anmg-ca.com/api/ical?token=synthetic-token'})}));
  assert.equal(response.status,200);assert.equal(state.fetches.length,1);assert.match((await response.json()).ics,/BEGIN:VCALENDAR/);
});
for(const name of ['handleCme','handleContacts','handleDocsRequest'])test('real inbound '+name+' refuses before reading provider content, sending or inserting records',async()=>{
  const {context,state}=await harness('email-inbound');
  const response=await context.intakeHandlers[name]('synthetic-ledger','synthetic-message','synthetic@example.invalid','subject','message-id');
  assert.equal(response.status,200);assert.equal((await response.json()).result,'membership_read_only');
  assert.equal(state.fetches.length,0);assert.equal(state.writes.length,1);assert.equal(state.writes[0].table,'inbound_emails');
  assert.equal(state.writes[0].row.status,'done');assert.equal(state.rpcs.length,1);
});
test('real inbound policy outage is retryable and not terminally acknowledged',async()=>{
  const {context,state}=await harness('email-inbound',new Error('offline'));
  await assert.rejects(context.intakeHandlers.handleCme('ledger','email','synthetic@example.invalid','subject','message'),/access policy unavailable/);
  assert.equal(state.fetches.length,0);assert.equal(state.writes.length,0);
});
