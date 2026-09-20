import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const issuer = 'https://clerk.credentialdomd.com';
const sourceIssuer = 'https://example.clerk.accounts.dev';
const runId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64);
const start = Date.now();
const code = name => buildSync({entryPoints:[new URL(`../../supabase/functions/clerk-webhook/${name}`,import.meta.url).pathname],
  bundle:true,platform:'node',format:'cjs',write:false,external:['https://*']}).outputFiles[0].text;
const helperCode = code('reservedContinuity.ts');
const webhookCode = code('index.ts');

function fixture() {
  const f = { clock:start, requests:[], reads:[], probes:[], writes:0, dbError:null, providerError:null, hook:null, closed:false };
  f.user = { id:'user_Production',banned:false,locked:false,created_at:start-5000,updated_at:start-4000,
    primary_email_address_id:'primary',email_addresses:[{id:'primary',email_address:'member@example.test',reserved:true,verification:null}],
    external_id:'user_Legacy',private_metadata:{credentialdomd_continuity:{schemaVersion:1,runId,manifestSHA256:hash,sourceSubject:'user_Legacy'}} };
  f.source = { id:'user_Legacy',banned:false,locked:false,created_at:start-100000,updated_at:start-8000,
    primary_email_address_id:'legacy-primary',email_addresses:[{id:'legacy-primary',email_address:'member@example.test',verification:{status:'verified'}}] };
  f.tables = {
    clerk_continuity_runs:[{id:runId,enabled:true,target_issuer:issuer,source_issuer:sourceIssuer,manifest_sha256:hash}],
    clerk_continuity_accounts:[{id:'account',run_id:runId,profile_id:profileId,source_subject:'user_Legacy',verified_primary_email:'member@example.test',
      source_user_created_ms:f.source.created_at,source_user_updated_ms:f.source.updated_at,state:'prepared',target_subject:null,bound_at:null}],
    profiles:[{id:profileId,auth_user_id:'user_Legacy',access_status:'active',deleted_at:null}],
  };
  f.db = {from(table) {return {select(columns) {
    const filters=[];
    return {eq(column,value){filters.push([column,value]);return this;},async maybeSingle(){
      f.reads.push({table,columns,filters});
      if(f.dbError) return {data:null,error:f.dbError};
      f.hook?.({table,filters});
      const rows=f.tables[table].filter(row=>filters.every(([column,value])=>row[column]===value));
      return {data:rows.length===1?structuredClone(rows[0]):null,error:rows.length>1?'ambiguous':null};
    }};
  },insert(){f.writes++;throw Error('unexpected write');},update(){f.writes++;throw Error('unexpected write');}};},
    async rpc(name,args){assert.equal(name,'account_is_closed');assert.equal(args.p_profile,profileId);
      f.probes.push({name,args});return {data:f.closed,error:f.probeError||null};}};
  f.transport = async(url,options) => {
    f.requests.push({url,options});
    assert.equal(options.redirect,'error'); assert.ok(options.signal);
    if(f.providerError) return new Response('unavailable',{status:503});
    if(url==='https://api.clerk.com/v1/users/user_Production') {
      assert.equal(options.headers.Authorization,'Bearer sk_live_synthetic');
      return Response.json(f.user);
    }
    assert.equal(url,'https://api.clerk.com/v1/users/user_Legacy');
    assert.equal(options.headers.Authorization,'Bearer sk_test_synthetic');
    f.sourceHook?.();
    return Response.json(f.source);
  };
  f.options = {productionSecret:'sk_live_synthetic',sourceSecret:'sk_test_synthetic',sourceIssuer,transport:f.transport};
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[f.clock]));}static now(){return f.clock;}}
  const globals={AbortSignal,Response,Date:ClockDate,console:{log(){},warn(){},error(){}},fetch:f.transport};
  const module={exports:{}};
  vm.runInNewContext(helperCode,{...globals,module,exports:module.exports});
  f.run = () => module.exports.canDeferReservedContinuity(f.db,'user_Production',f.options);
  f.handler = () => {
    const env={CLERK_WEBHOOK_SECRET:'synthetic',CLERK_ISSUER:issuer,CLERK_CONTINUITY_ENABLED:'true',
      CLERK_SECRET_KEY:'sk_live_synthetic',CLERK_CONTINUITY_SOURCE_SECRET_KEY:'sk_test_synthetic',CLERK_CONTINUITY_SOURCE_ISSUER:sourceIssuer};
    let handler;
    const entry={exports:{}};
    vm.runInNewContext(webhookCode,{...globals,module:entry,exports:entry.exports,Deno:{env:{get:key=>env[key]}},require(specifier){
      if(specifier.includes('/http/server.ts')) return {serve(value){handler=value;}};
      if(specifier.includes('/svix@')) return {Webhook:class{verify(body){f.signatureChecked=true;return JSON.parse(body);}}};
      if(specifier.includes('/@supabase/supabase-js@')) return {createClient(){return f.db;}};
      throw Error(`unexpected dependency ${specifier}`);
    }});
    return handler(new Request('https://example.test/webhook',{method:'POST',headers:{'svix-id':'event','svix-signature':'synthetic'},
      body:JSON.stringify({type:'user.created',data:{...f.user,private_metadata:{forged:'event payload is not trusted'}}})}));
  };
  return f;
}

test('reviewed reserved login defers without profile, access or mailbox writes',async()=>{
  const f=fixture();assert.equal(await f.run(),true);assert.equal(f.writes,0);
  assert.equal(f.requests.length,2);assert.equal(f.reads.length,10);
  assert.equal(f.probes.length,2);
  assert.equal(f.tables.clerk_continuity_accounts[0].state,'prepared');
});
test('pending email-code verification and prepared identity without an old profile can defer',async()=>{
  const f=fixture();f.user.email_addresses[0].verification={status:'unverified'};
  f.tables.clerk_continuity_accounts[0].profile_id=null;f.tables.profiles=[];
  assert.equal(await f.run(),true);assert.equal(f.writes,0);
});

for(const [name,change] of [
  ['no private marker',f=>{f.user.private_metadata={};}],
  ['marker only in public metadata',f=>{f.user.public_metadata=f.user.private_metadata;f.user.private_metadata={};}],
  ['marker only in unsafe metadata',f=>{f.user.unsafe_metadata=f.user.private_metadata;f.user.private_metadata={};}],
  ['wrong marker schema',f=>{f.user.private_metadata.credentialdomd_continuity.schemaVersion=2;}],
  ['extra marker fields',f=>{f.user.private_metadata.credentialdomd_continuity.email='member@example.test';}],
  ['wrong manifest hash',f=>{f.user.private_metadata.credentialdomd_continuity.manifestSHA256='b'.repeat(64);}],
  ['wrong run',f=>{f.user.private_metadata.credentialdomd_continuity.runId='99999999-9999-4999-8999-999999999999';}],
  ['wrong source subject',f=>{f.user.private_metadata.credentialdomd_continuity.sourceSubject='user_Other';}],
  ['external identity absent',f=>{delete f.user.external_id;}],
  ['external identity mismatch',f=>{f.user.external_id='user_Other';}],
  ['reserved flag absent',f=>{delete f.user.email_addresses[0].reserved;}],
  ['ordinary unverified address',f=>{f.user.email_addresses[0].reserved=false;}],
  ['already verified primary',f=>{f.user.email_addresses[0].verification={status:'verified'};}],
  ['malformed verification',f=>{delete f.user.email_addresses[0].verification;}],
  ['extra mailbox',f=>{f.user.email_addresses.push({...f.user.email_addresses[0],id:'second'});}],
  ['primary identity missing',f=>{f.user.primary_email_address_id='missing';}],
  ['wrong provider subject',f=>{f.user.id='user_Other';}],
  ['banned identity',f=>{f.user.banned=true;}],
  ['locked identity',f=>{f.user.locked=true;}],
  ['deleted identity',f=>{f.user.deleted=true;}],
  ['invalid provider clocks',f=>{f.user.updated_at=0;}],
  ['disabled run',f=>{f.tables.clerk_continuity_runs[0].enabled=false;}],
  ['wrong source issuer',f=>{f.tables.clerk_continuity_runs[0].source_issuer='https://wrong.example';}],
  ['wrong target issuer',f=>{f.tables.clerk_continuity_runs[0].target_issuer='https://wrong.example';}],
  ['bound account',f=>{Object.assign(f.tables.clerk_continuity_accounts[0],{state:'bound',target_subject:'user_Production',bound_at:'now'});}],
  ['another account bound to target',f=>{f.tables.clerk_continuity_accounts.push({id:'other',target_subject:'user_Production'});}],
  ['ordinary target profile',f=>{f.tables.profiles.push({id:'other',auth_user_id:'user_Production'});}],
  ['missing original profile',f=>{f.tables.profiles=[];}],
  ['revoked original profile',f=>{f.tables.profiles[0].access_status='revoked';}],
  ['deleted original profile',f=>{f.tables.profiles[0].deleted_at='now';}],
  ['source account has closure tombstone',f=>{f.closed=true;}],
  ['mismatched original profile UUID',f=>{f.tables.profiles[0].id='other';}],
  ['profile appeared after manifest',f=>{f.tables.clerk_continuity_accounts[0].profile_id=null;}],
  ['changed staged mailbox',f=>{f.tables.clerk_continuity_accounts[0].verified_primary_email='other@example.test';}],
  ['changed live source mailbox',f=>{f.source.email_addresses[0].email_address='other@example.test';}],
  ['changed source creation time',f=>{f.source.created_at--;}],
  ['regressed source update time',f=>{f.source.updated_at--;}],
  ['source verified after proof expired',f=>{f.sourceHook=()=>{f.clock+=300001;};}],
  ['run disabled during source read',f=>{f.sourceHook=()=>{f.tables.clerk_continuity_runs[0].enabled=false;};}],
  ['account bound during source read',f=>{f.sourceHook=()=>{f.tables.clerk_continuity_accounts[0].state='bound';};}],
  ['target profile created during source read',f=>{f.sourceHook=()=>{f.tables.profiles.push({id:'new',auth_user_id:'user_Production'});};}],
  ['source account closes during provider read',f=>{f.sourceHook=()=>{f.closed=true;};}],
]) test(`${name} cannot be acknowledged as a pending migration`,async()=>{
  const f=fixture();change(f);assert.equal(await f.run(),false);assert.equal(f.writes,0);
});

test('provider, database and source-verification failures remain retryable errors',async()=>{
  for(const change of [f=>{f.providerError=true;},f=>{f.dbError='unavailable';},f=>{f.source.email_addresses[0].verification.status='unverified';},
    f=>{f.source.banned=true;},f=>{f.options.sourceSecret='sk_live_wrong';},f=>{f.probeError='database unavailable';},f=>{f.closed=null;}]) {
    const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.writes,0);
  }
});
test('wrong production key fails before any provider or database access',async()=>{
  const f=fixture();f.options.productionSecret='sk_test_wrong';assert.equal(await f.run(),false);
  assert.equal(f.requests.length,0);assert.equal(f.reads.length,0);
});
test('signed webhook acknowledges only fresh reserved evidence before any writes',async()=>{
  const f=fixture();const response=await f.handler();assert.equal(response.status,200);
  assert.equal(await response.text(),'Awaiting email verification');assert.equal(f.signatureChecked,true);assert.equal(f.writes,0);
});
test('webhook keeps unrelated unverified identities and provider failures retryable',async()=>{
  const f=fixture();f.user.private_metadata={};assert.equal((await f.handler()).status,503);assert.equal(f.writes,0);
  const unavailable=fixture();unavailable.providerError=true;assert.equal((await unavailable.handler()).status,503);
  assert.equal(unavailable.requests.length,1);assert.equal(unavailable.reads.length,0);
});
