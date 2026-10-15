import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const stubs={
  'https://deno.land/std@0.168.0/http/server.ts':'export function serve(handler){globalThis.__guideDelivery.handler=handler;}',
  'https://esm.sh/@supabase/supabase-js@2':'export function createClient(url,key,options){globalThis.__guideDelivery.options=options;return globalThis.__guideDelivery.db;}export class SupabaseClient{}',
  'https://esm.sh/jose@5':'export function createRemoteJWKSet(){return null;}export async function jwtVerify(){throw Error("synthetic no token");}',
};
registerHooks({resolve(specifier,context,next){return stubs[specifier]?{url:`data:text/javascript,${encodeURIComponent(stubs[specifier])}`,shortCircuit:true}:next(specifier,context);}});
const env={RESEND_API_KEY:'re_synthetic',WELCOME_HOOK_SECRET:'synthetic-hook',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'};
globalThis.Deno={env:{get:k=>env[k]}};globalThis.__guideDelivery={};
await import('../supabase/functions/send-guide/index.ts');
function fixture(){
  const row={id:'00000000-0000-4000-8000-000000000001',email:'guide@example.test',note:'guide-email CA',guide_request_id:'00000000-0000-4000-8000-000000000002',guide_sent_at:null,guide_attempts:0};
  const w={row,rpcs:[],frozen:null,leased:false,failAck:false,failClaim:false};
  w.db={from(){const q={};for(const name of ['select','ilike','is','lt','order','limit','eq'])q[name]=()=>q;
    q.then=(resolve)=>resolve({data:row.guide_sent_at?[]:[{...row}]});return q;},
    async rpc(name,args){
      w.rpcs.push({name,args});
      if(name==='guide_delivery_cleanup')return{data:null};
      if(name==='guide_delivery_claim'){
        w.onClaim?.();
        if(w.failClaim)return{error:{message:'synthetic failure'}};
        if(w.leased||row.guide_sent_at||row.guide_request_id!==args.p_request||row.email!==args.p_email||row.note!==args.p_note)return{data:null};
        w.leased=true;w.frozen||=structuredClone(args.p_payload);
        return{data:{request_id:row.guide_request_id,lease_token:'synthetic-lease',payload:structuredClone(w.frozen)}};
      }
      if(name==='guide_delivery_finish'){
        if(w.failAck)return{error:{message:'synthetic acknowledgement failure'}};
        if(args.p_outcome==='sent')row.guide_sent_at=new Date().toISOString();
        w.leased=false;return{data:true};
      }
      assert.fail(`Unexpected RPC ${name}`);
    }};
  return w;
}
async function run(w,{body={},status=200,authorized=true}={}){
  globalThis.__guideDelivery.db=w.db;
  const res=await globalThis.__guideDelivery.handler(new Request('https://fn.test/send-guide',{method:'POST',headers:authorized?{'x-hook-secret':env.WELCOME_HOOK_SECRET}:{},body:JSON.stringify(body)}));
  assert.equal(res.status,status);return res.json();
}
test('guide handler uses leased immutable delivery and never sends real mail',async t=>{
  const calls=[];let deliver;
  mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://api.resend.com/emails');assert.ok(init.signal instanceof AbortSignal);
    calls.push({...init,body:JSON.parse(init.body)});return deliver();
  });t.after(()=>mock.restoreAll());
  const accepted=()=>Response.json({id:'synthetic-email'});
  await t.test('simultaneous sweeps claim one provider send and commit its stamp',async()=>{
    calls.length=0;deliver=accepted;const w=fixture();
    const answers=await Promise.all([run(w),run(w)]);
    assert.equal(calls.length,1);assert.equal(answers.reduce((n,a)=>n+a.sent,0),1);assert.ok(w.row.guide_sent_at);
    assert.equal(calls[0].headers['Idempotency-Key'],`guide/${w.row.guide_request_id}`);
    assert.match(calls[0].body.html,/<h1/);assert.match(calls[0].body.text,/\n\n/);
    assert.deepEqual(calls[0].body.to,['guide@example.test']);
    assert.equal(typeof globalThis.__guideDelivery.options.global.fetch,'function');
  });
  for(const [name,response] of [['network',()=>{throw Error('synthetic network failure');}],['missing ID',()=>Response.json({})],['null JSON',()=>Response.json(null)],['blank ID',()=>Response.json({id:' '})],['rate limit',()=>Response.json({}, {status:429})],['conflict',()=>Response.json({}, {status:409})]]){
    await t.test(`${name} retries with frozen payload/key and no false sent stamp`,async()=>{
      calls.length=0;const w=fixture();deliver=response;
      const first=await run(w);assert.equal(first.sent,0);assert.equal(first.failed,1);assert.equal(w.row.guide_sent_at,null);
      const frozen=structuredClone(w.frozen);
      deliver=accepted;const next=await run(w);assert.equal(next.sent,1);assert.ok(w.row.guide_sent_at);
      assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);assert.deepEqual(calls[1].body,frozen);
    });
  }
  await t.test('provider acceptance followed by failed DB acknowledgement remains recoverable',async()=>{
    calls.length=0;const w=fixture();w.failAck=true;deliver=accepted;
    const first=await run(w);assert.equal(first.sent,0);assert.equal(first.results[0].error,'acknowledgement_unconfirmed');
    assert.equal(w.row.guide_sent_at,null);assert.equal(w.leased,true);
    w.leased=false;w.failAck=false;const next=await run(w);assert.equal(next.sent,1);
    assert.deepEqual(calls[0].body,calls[1].body);assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
  });
  await t.test('stale recipient snapshot and failed claim cannot send',async()=>{
    calls.length=0;deliver=accepted;const w=fixture();w.onClaim=()=>{w.row.email='changed@example.test';};
    assert.equal((await run(w)).skipped,1);assert.equal(calls.length,0);
    const bad=fixture();bad.failClaim=true;assert.equal((await run(bad)).failed,1);assert.equal(calls.length,0);
  });
  await t.test('dry-run and unauthorized requests cannot claim, clean up or send',async()=>{
    calls.length=0;const w=fixture();assert.ok((await run(w,{body:{dry_run:true}})).results[0].dry_run);
    assert.equal(w.rpcs.length,0);assert.equal(calls.length,0);
    await run(w,{authorized:false,status:401});assert.equal(w.rpcs.length,0);assert.equal(calls.length,0);
  });
});
