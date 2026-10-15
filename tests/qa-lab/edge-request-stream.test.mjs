import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { streamPlan, readEdgeRequestStream, ORIGINAL_MAIN_SHA, TRANSFER_MAIN_SHA } from '../../qa-lab/lib/edge-request-stream.mjs';
import { replaceOwnedEdge } from '../../qa-lab/lib/edge-request-stream-transaction.mjs';
const original = readFileSync(new URL('./fixtures/edge-runtime-v1.74.2-main.ts', import.meta.url),'utf8');
const project='credentialdomd-qa-lab-stream-test', root='/owned/checkout', network=`supabase_network_${project}`;
function fixture() { return {Name:`/supabase_edge_runtime_${project}`, Id:'a'.repeat(64), State:{Running:true},
  Config:{Image:'public.ecr.aws/supabase/edge-runtime:v1.74.2', Env:['SYNTHETIC_SECRET=never-log'], Cmd:null,
    Entrypoint:['sh','-c',`cat <<'EOF' > /root/index.ts && edge-runtime start --main-service=/root --port=8081 --policy=per_worker\n${original}EOF\n`]},
  Mounts:[{Type:'bind',Source:`${root}/qa-lab/.generated/stack/supabase/functions`}],
  HostConfig:{NetworkMode:network,PortBindings:{},Privileged:false,AutoRemove:false,PublishAllPorts:false},
  NetworkSettings:{Networks:{[network]:{Aliases:['edge_runtime']}}}}; }
test('reviewed installed dispatcher changes exactly one request expression and is idempotent',()=>{
  const e=fixture(), before=structuredClone(e), p=streamPlan(e,{project,root});
  assert.equal(p.before,ORIGINAL_MAIN_SHA); assert.equal(p.after,TRANSFER_MAIN_SHA);
  assert.equal(p.entrypoint[2], e.Config.Entrypoint[2].replace('new Request(t,e.clone())','new Request(t,e)'));
  assert.deepEqual(e,before); e.Config.Entrypoint=p.entrypoint;
  assert.equal(streamPlan(e,{project,root}).before,TRANSFER_MAIN_SHA);
});
test('unknown image, dispatcher, checkout, networking, security or port configuration is refused',()=>{
  for(const mutate of [e=>{e.Config.Image='unknown';}, e=>{e.Config.Entrypoint[2]+=' ';}, e=>{e.Mounts[0].Source='/other/supabase/functions';},e=>{e.NetworkSettings.Networks.bridge={};},e=>{e.HostConfig.Privileged=true;},e=>{e.HostConfig.PortBindings={'9000/tcp':[{HostIp:'0.0.0.0',HostPort:'9000'}]};},e=>{e.Name='/production';},e=>{e.State.Running=false;},e=>{e.Config.Entrypoint[2]=e.Config.Entrypoint[2].replace('verifyHybridJWT','skipHybridJWT');}]) {
    const e=fixture(); mutate(e); assert.throws(()=>streamPlan(e,{project,root}),/QA edge request stream/);
  }
});
test('read-only acceptance refuses an uncorrected runtime without any mutation',()=>{
  const calls=[]; const run=(cmd,args)=>{calls.push([cmd,args]);return {status:0,stdout:JSON.stringify(fixture())};};
  assert.throws(()=>readEdgeRequestStream({project,root,run}),/restart the owned lab/);
  assert.equal(calls.length,1); assert.equal(calls[0][1][0],'inspect');
});
test('read-only acceptance requires the active file to match the corrected startup',()=>{
  const e=fixture();e.Config.Entrypoint=streamPlan(e,{project,root}).entrypoint;
  let active=original;
  const run=(cmd,args)=>({status:0,stdout:args[0]==='inspect'?JSON.stringify(e):active});
  assert.throws(()=>readEdgeRequestStream({project,root,run}),/active dispatcher/);
  active=original.replace('new Request(t,e.clone())','new Request(t,e)');
  const receipt=readEdgeRequestStream({project,root,run});assert.equal(receipt.recreated,false);assert.equal(receipt.dispatcherSha256,TRANSFER_MAIN_SHA);
});
test('replacement preserves private config and existing network, and deletes no volume',async()=>{
  const edge=fixture(), calls=[], created='b'.repeat(64);
  const api=async(method,path,body)=>{calls.push({method,path,body}); if(method==='GET')return structuredClone(edge);if(path.startsWith('/containers/create'))return {Id:created};};
  const receipt=await replaceOwnedEdge({edge,project,root,api,ready:async id=>id===created});
  const body=calls.find(c=>c.path.startsWith('/containers/create')).body;
  assert.deepEqual(body.Env,edge.Config.Env); assert.deepEqual(body.HostConfig,edge.HostConfig);
  assert.deepEqual(Object.keys(body.NetworkingConfig.EndpointsConfig),[network]);
  assert.equal(receipt.containerId,created);
  assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.path),[`/containers/${edge.Id}`]);
});
test('failed startup removes only replacement and restores old name/start',async()=>{
  const edge=fixture(),calls=[],created='b'.repeat(64);
  const api=async(method,path)=>{calls.push({method,path});if(method==='GET')return edge;if(path.startsWith('/containers/create'))return {Id:created};};
  await assert.rejects(replaceOwnedEdge({edge,project,root,api,ready:async()=>false}),/rollback completed/);
  assert.deepEqual(calls.slice(-3),[{method:'DELETE',path:`/containers/${created}?force=true`},{method:'POST',path:`/containers/${edge.Id}/rename?name=${edge.Name.slice(1)}`},{method:'POST',path:`/containers/${edge.Id}/start`}]);
});
test('replacement refuses a changed configuration before stopping, and surfaces incomplete rollback',async()=>{
  const edge=fixture(),calls=[];
  await assert.rejects(replaceOwnedEdge({edge,project,root,api:async(method,path)=>{calls.push(path);const changed=structuredClone(edge);changed.Config.Env=[];return changed;},ready:async()=>true}),/changed before/);
  assert.equal(calls.length,1);
  await assert.rejects(replaceOwnedEdge({edge,project,root,api:async(method,path)=>{if(method==='GET')return edge;if(path.includes('/create'))return {Id:'b'.repeat(64)};if(path.includes('force=true'))throw Error('synthetic failure');},ready:async()=>false}),/rollback incomplete/);
});
