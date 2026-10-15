// QA mocks only: idle provider sockets survive ordinary between-journey pauses,
// while normal Node close still promptly closes idle sockets at shutdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockServer } from '../../qa-lab/mocks/server.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';

export async function fixture() {
  const dir=mkdtempSync(path.join(tmpdir(),'qa-mock-keepalive-'));
  const mock=createMockServer({port:0,appOrigin:'http://127.0.0.1:54390',stateDir:dir,secrets:generateLabSecrets(),log:()=>{}});
  await mock.listen();
  return {mock,origin:`http://127.0.0.1:${mock.server.address().port}`,close:async()=>{
    mock.server.closeAllConnections();await new Promise(r=>mock.server.close(r));rmSync(dir,{recursive:true,force:true});
  }};
}
const request=(origin,agent)=>new Promise((resolve,reject)=>{
  const req=http.get(`${origin}/qa/health`,{agent,timeout:1500},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks)),socket:req.socket}));});
  req.on('timeout',()=>req.destroy(new Error('request deadline')));req.on('error',reject);
});

test('provider mock holds idle pooled socket beyond the former five-second boundary and closes promptly', {timeout:12000}, async()=>{
  const f=await fixture();const agent=new http.Agent({keepAlive:true,maxSockets:1});
  try {
    assert.equal(f.mock.server.keepAliveTimeout,600000);
    assert.equal(f.mock.server.headersTimeout,601000);
    const first=await request(f.origin,agent);assert.equal(first.status,200);assert.equal(first.body.ok,true);
    await new Promise(r=>setTimeout(r,6200));
    const second=await request(f.origin,agent);assert.equal(second.status,200);assert.equal(second.body.ok,true);
    assert.equal(second.socket,first.socket,'same pooled connection survives old Node timeout including its one-second buffer');
    const start=performance.now();
    await Promise.race([new Promise(r=>f.mock.server.close(r)),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('idle server shutdown deadline')),1500);timer.unref();})]);
    assert.ok(performance.now()-start<1500,'extended keepalive does not leave idle sockets holding shutdown');
  }finally{agent.destroy();await f.close();}
});

// Optional actual Deno check using the already cached local QA image:
// QA_MOCK_POOL_DOCKER=1 node --test tests/qa-lab/mock-keepalive.test.mjs
// No random race is required: one connection must survive the former boundary.
test('actual Deno pooled requests cross the old idle boundary on the same mock socket', {skip:process.env.QA_MOCK_POOL_DOCKER!=='1',timeout:45000}, async()=>{
  const image='public.ecr.aws/supabase/edge-runtime:v1.74.2';
  const inspected=spawnSync('docker',['image','inspect',image],{encoding:'utf8',timeout:10000});
  assert.equal(inspected.status,0,'existing local QA image required; never pull a substitute');
  const f=await fixture(),name=`qa-mock-pool-${randomUUID().slice(0,8)}`;
  let connections=0,requests=0,child;
  f.mock.server.on('connection',()=>connections++);f.mock.server.on('request',()=>requests++);
  try {
    const target=`http://host.docker.internal:${f.mock.server.address().port}/qa/health`;
    const entrypoint=`Deno.serve({port:8081},()=>new Response('ready'));const results=[];for(let i=0;i<3;i++){try{const r=await fetch(${JSON.stringify(target)},{signal:AbortSignal.timeout(3000)});const body=await r.json();results.push({status:r.status,ok:body.ok});}catch(e){results.push({error:e.message});}if(i<2)await new Promise(r=>setTimeout(r,6200));}console.log('POOL_RESULTS '+JSON.stringify(results));`;
    child=spawn('docker',['run','--rm','--name',name,'--cap-drop','ALL','--security-opt','no-new-privileges','--env',`QA_POOL_ENTRYPOINT=${entrypoint}`,'--entrypoint','sh',image,'-c',"mkdir -p /proof && printf '%s' \"$QA_POOL_ENTRYPOINT\" > /proof/index.ts && exec edge-runtime start --main-service=/proof --port=8081"],{stdio:['ignore','pipe','pipe']});
    let text='';child.stdout.on('data',v=>text+=v);child.stderr.on('data',v=>text+=v);
    let spawnError;child.on('error',e=>{spawnError=e;});
    const deadline=Date.now()+23000;
    while(!text.includes('POOL_RESULTS ')&&Date.now()<deadline&&child.exitCode===null&&!spawnError)await new Promise(r=>setTimeout(r,100));
    const line=text.split('\n').find(x=>x.includes('POOL_RESULTS '));
    assert.ok(line,`Deno result missing: ${spawnError?.message||text.slice(-600)}`);
    const results=JSON.parse(line.slice(line.indexOf('POOL_RESULTS ')+13));
    assert.deepEqual(results,Array.from({length:3},()=>({status:200,ok:true})));
    assert.equal(requests,3,'each request executes once, with no retry');
    assert.equal(connections,1,'Deno reuses one connection across both old idle deadlines');
  } finally {
    if(child){spawnSync('docker',['stop','-t','1',name],{encoding:'utf8',timeout:10000});child.kill();}
    await f.close();
  }
});
