// Opt-in real Docker proof, isolated from every running QA lab:
// QA_EDGE_CLOCK_DOCKER=1 node --test tests/qa-lab/edge-clock-docker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../..', import.meta.url));
const docker = (...args) => {
  const r = spawnSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  if(r.status!==0 || r.error) throw new Error(`Disposable Docker fixture command failed: ${args[0]}: ${r.error?.message || r.stderr}`);
  return r.stdout.trim();
};

test('actual isolated Docker HTTP/log timestamps, exact claims, gateway negative and ambiguous refusal', {skip:process.env.QA_EDGE_CLOCK_DOCKER!=='1',timeout:60000}, async t => {
  const image='ghcr.io/mlflow/mlflow:v3.4.0';
  docker('image','inspect',image); // Cached image only; no network pull.
  const dir=mkdtempSync(path.join(os.tmpdir(),'qa-edge-clock-'));
  const name=`clock-${randomUUID().slice(0,8)}`;
  let containerId, idle;
  try {
    const files=['qa-lab/lib/edge-clock.mjs','qa-lab/lib/edge-health-claims.mjs','qa-lab/lib/edge-error-evidence.mjs','qa-lab/lib/refund-webhook-evidence.mjs','qa-lab/lib/stripe-retry-evidence.mjs','qa-lab/lib/config.mjs','qa-lab/lib/instance.mjs','qa-lab/lib/paths.mjs','qa-lab/e2e/support/edge-health.mjs','qa-lab/supabase-config.template.toml'];
    for(const f of files){mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});copyFileSync(path.join(root,f),path.join(dir,f));}
    mkdirSync(path.join(dir,'qa-lab/.generated'),{recursive:true});
    writeFileSync(path.join(dir,'qa-lab/.generated/instance.json'),JSON.stringify({name,ports:{api:55001,database:55002,shadow:55003,studio:55004,mail:55005,inspector:55006}}));
    const imported=rel=>import(pathToFileURL(path.join(dir,rel)).href);
    const {localContainer}=await imported('qa-lab/lib/config.mjs');
    const {readEdgeClock,timestampNs}=await imported('qa-lab/lib/edge-clock.mjs');
    const {EDGE_NEGATIVES,edgeErrorObservations,aggregateEdgeObservations,reconcileEdgeClaims}=await imported('qa-lab/lib/edge-health-claims.mjs');
    const {observeIntentionalEdgeRequest}=await imported('qa-lab/e2e/support/edge-health.mjs');
    // These four original HTTP controls prove Docker clock/log transport. The
    // refund bundle and outer fault need their dedicated refund-edge-claims and
    // refund-webhook-evidence fixtures; do not silently filter the shared registry.
    const kinds=['expired_checkout','unsigned_webhook','missing_authorization','unpaid_refund'];
    const specs=Object.fromEntries(kinds.map(kind=>[kind,EDGE_NEGATIVES[kind]]));
    assert.equal(Object.keys(specs).length,4);
    assert.equal(new Set(Object.values(specs).map(spec=>spec.path)).size,4);
    for(const spec of Object.values(specs)) {
      assert.equal(spec.method,'POST');assert.equal(typeof spec.path,'string');assert.equal(typeof spec.line,'string');
      assert.equal(spec.observationKind,undefined);assert.equal(spec.precedingLines,undefined);
    }
    const server=`import json\nfrom http.server import ThreadingHTTPServer,BaseHTTPRequestHandler\nspecs=json.loads(${JSON.stringify(JSON.stringify(specs))})\nclass Handler(BaseHTTPRequestHandler):\n def log_message(self,*args): pass\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'ready')\n def do_POST(self):\n  payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')\n  spec=next(s for s in specs.values() if s['path']==self.path)\n  for i in range(payload.get('duplicates',1)): print(spec['line'],flush=True)\n  data=json.dumps({spec['field']:spec['code']}).encode()\n  self.send_response(spec['status']); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)\nThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()\n`;
    containerId=docker('run','--detach','--rm','--name',localContainer('edge_runtime'),'--publish','127.0.0.1::8080','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','python',image,'-u','-c',server);
    assert.match(containerId,/^[a-f0-9]{64}$/);
    const published=docker('port',containerId,'8080/tcp');assert.match(published,/^127\.0\.0\.1:\d+$/);
    const origin=`http://${published}`;
    let ready=false;for(let i=0;i<50;i++){ready=await fetch(origin,{signal:AbortSignal.timeout(500)}).then(async r=>{await r.text();return r.ok;},()=>false);if(ready)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'isolated HTTP fixture ready');
    // HTTP clients may pre-open an idle socket; one must not starve real requests.
    idle=createConnection({host:'127.0.0.1',port:Number(published.split(':')[1])});
    await new Promise((resolve,reject)=>{idle.once('connect',resolve);idle.once('error',reject);});
    const before=readEdgeClock(),since=new Date().toISOString(),requests=[],claims=[];let hostMisses=0,actions=0;
    const attempt={test:'actual Docker proof',file:'edge-clock-docker.test.mjs',retry:0,repeatEachIndex:0,attemptStatus:'passed'};
    for(const [kind,spec] of Object.entries(specs)) {
      const result=await observeIntentionalEdgeRequest(kind,'intentional isolated HTTP negative',async()=>{
        actions++;const r=await fetch(`${origin}${spec.path}`,{method:'POST',body:'{}',signal:AbortSignal.timeout(3000)});
        return {url:r.url,method:'POST',status:r.status,text:await r.text()};
      });
      requests.push({...result.request,...attempt});claims.push({...result.claim,...attempt});
      const raw=edgeErrorObservations(docker('logs','--timestamps','--since',result.request.clock.before.dockerAt,'--until',result.request.clock.after.dockerAt,containerId));
      const observed=raw.find(row=>row.id===result.claim.observationId);assert.ok(observed);
      if(timestampNs(observed.at)>timestampNs(result.request.finishedAt)||timestampNs(observed.at)<timestampNs(result.request.startedAt))hostMisses++;
    }
    const until=new Date().toISOString(),after=readEdgeClock();
    const raw=edgeErrorObservations(docker('logs','--timestamps','--since',before.dockerAt,'--until',after.dockerAt,containerId));
    const reconciled=reconcileEdgeClaims({since,until,edgeClock:{before,after},edgeErrorObservations:raw,edgeFunctionErrors:aggregateEdgeObservations(raw)},requests,claims);
    assert.deepEqual(reconciled.problems,[]);assert.equal(reconciled.matched.length,4);assert.equal(actions,4);
    const captured=[];let duplicateActions=0;
    await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','two raw occurrences must refuse',async()=>{
      duplicateActions++;const r=await fetch(`${origin}${EDGE_NEGATIVES.expired_checkout.path}`,{method:'POST',body:'{"duplicates":2}',signal:AbortSignal.timeout(3000)});
      return {url:r.url,method:'POST',status:r.status,text:await r.text()};
    },{recordRequest:r=>captured.push(r)}),/ambiguous/);
    assert.equal(duplicateActions,1);assert.equal(captured.length,1);assert.equal(captured[0].status,409);
    t.diagnostic(JSON.stringify({actualHttpActions:actions,measuredClaims:reconciled.matched.length,hostOnlyWindowMisses:hostMisses,ambiguousRejected:true,containerId,before,after}));
  } finally {
    idle?.destroy();
    if(containerId)docker('rm','--force',containerId);
    rmSync(dir,{recursive:true,force:true});
  }
});
