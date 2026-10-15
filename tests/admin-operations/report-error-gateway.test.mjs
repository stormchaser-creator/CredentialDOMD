import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {createClient} from '@supabase/supabase-js';
import {startPostgres} from '../ops/pg.mjs';
import {pgSkip,withSlotWait,quote} from '../credential-portal/postgresFixture.mjs';

const source=readFileSync(process.env.REPORT_ERROR_ENTRYPOINT_FILE || new URL('../../supabase/functions/report-error/index.ts',import.meta.url),'utf8');
const code=transformSync(source,{loader:'ts',format:'cjs'}).code;
function handler(url,options={}) {
  let serve; const logs=[],waits=[];
  vm.runInNewContext(code,{
    require(name) {assert.match(name,/@supabase\/supabase-js/);return {createClient:options.createClient || createClient};},
    Request,Response,Headers,URL,TextEncoder,crypto,
    AbortSignal:{timeout(ms){assert.equal(ms,5000);return AbortSignal.timeout(options.retryTimeout ?? ms);}},
    setTimeout(fn,ms){waits.push(ms);return setTimeout(fn,ms);},
    console:{error(...parts){logs.push(parts);}},
    Deno:{env:{get(k){return {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ERROR_IP_PEPPER:'synthetic-pepper'}[k];}},serve(fn){serve=fn;}},
  });
  return {logs,waits,run(body={message:'Synthetic report',kind:'error',build:'synthetic-build'},ip=true){
    return serve(new Request('http://127.0.0.1/functions/v1/report-error',{method:'POST',headers:ip?{'cf-connecting-ip':'203.0.113.9'}:{},body:JSON.stringify(body)}));
  }};
}
async function gateway(t,statuses,options={}) {
  const writes=[],reads=[],rows=new Map();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='HEAD') {
      reads.push(url.pathname+url.search);
      res.writeHead(200,{'Content-Range':`0-0/${options.count ?? 0}`});res.end();return;
    }
    if(req.method==='GET') {
      assert.equal(url.pathname,'/rest/v1/profiles');reads.push(url.pathname+url.search);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000003'}));return;
    }
    assert.equal(req.method,'POST');assert.equal(url.pathname,'/rest/v1/client_errors');
    let raw='';for await(const chunk of req)raw+=chunk;
    const row=JSON.parse(raw),upsert=(req.headers.prefer || '').includes('resolution=ignore-duplicates');
    writes.push({raw,row,upsert,query:url.search,authorization:req.headers.authorization});
    const status=statuses[Math.min(writes.length-1,statuses.length-1)];
    if(status===201 || (writes.length===1 && options.commitBeforeFailure)) {
      if(options.persist)await options.persist(row,upsert);
      if(!rows.has(row.id))rows.set(row.id,{...row,acceptedAt:writes.length});
    }
    if(status==='hang')return;
    res.writeHead(status,{'Content-Type':'application/json'});
    res.end(status===201?'':JSON.stringify({message:'An invalid response was received from the upstream server'}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {url:`http://127.0.0.1:${server.address().port}`,writes,reads,rows};
}
function sameReport(g,count) {
  assert.equal(g.writes.length,count);
  assert.match(g.writes[0].row.id,/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(g.writes[0].upsert,false);
  for(const w of g.writes){assert.equal(w.raw,g.writes[0].raw);assert.equal(w.authorization,'Bearer synthetic-service-key');}
  if(count===2){assert.equal(g.writes[1].upsert,true);assert.equal(g.writes[1].query,'?on_conflict=id');}
}
test('ordinary error reporting writes one scrubbed report; caller identity cannot replace a stored row',async t=>{
  const g=await gateway(t,[201]),h=handler(g.url);
  const r=await h.run({id:'00000000-0000-4000-8000-000000000001',kind:'react',message:'Synthetic Bearer abcdefghijklmnop',extra:{token:'sk-testsyntheticabcdefghijklmnop'},auth_user_id:'user_SyntheticSubject',build:'synthetic-build'});
  assert.equal(r.status,200);sameReport(g,1);assert.equal(g.rows.size,1);assert.deepEqual(h.logs,[]);assert.deepEqual(h.waits,[]);
  assert.notEqual(g.writes[0].row.id,'00000000-0000-4000-8000-000000000001');
  assert.equal(g.writes[0].row.message,'Synthetic [redacted]');assert.equal(g.writes[0].row.extra.token,'[redacted]');
  assert.equal(g.writes[0].row.profile_id,'00000000-0000-4000-8000-000000000003');assert.equal(g.reads.length,3);
});
for(const status of [502,503,504])for(const commitBeforeFailure of [false,true])test(`gateway ${status}, first write committed=${commitBeforeFailure}: recover one immutable report`,async t=>{
  const g=await gateway(t,[status,201],{commitBeforeFailure}),h=handler(g.url),r=await h.run();
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});sameReport(g,2);assert.equal(g.rows.size,1);
  assert.equal([...g.rows.values()][0].acceptedAt,commitBeforeFailure?1:2);assert.deepEqual(h.logs,[]);assert.deepEqual(h.waits,[100]);
});
for(const status of [502,503,504])test(`persistent gateway ${status} returns failure after exactly two writes`,async t=>{
  const g=await gateway(t,[status]),h=handler(g.url),r=await h.run();assert.equal(r.status,500);sameReport(g,2);assert.equal(g.rows.size,0);assert.equal(h.logs.length,1);
});
for(const status of [400,401,403,409,422,429,500])test(`HTTP ${status} never triggers a gateway retry`,async t=>{
  const g=await gateway(t,[status]),h=handler(g.url),r=await h.run();assert.equal(r.status,500);sameReport(g,1);assert.equal(h.logs.length,1);assert.deepEqual(h.waits,[]);
});
test('retry time limit stops a stalled recovery and reports failure',async t=>{
  const g=await gateway(t,[502,'hang']),h=handler(g.url,{retryTimeout:30}),start=Date.now(),r=await h.run();
  assert.equal(r.status,500);sameReport(g,2);assert.ok(Date.now()-start<3000);assert.equal(h.logs.length,1);
});
test('rate caps remain in front of all writes',async t=>{
  const perIp=await gateway(t,[201],{count:30}),global=await gateway(t,[201],{count:300});
  assert.equal((await handler(perIp.url).run()).status,429);assert.equal(perIp.writes.length,0);
  assert.equal((await handler(global.url).run(undefined,false)).status,429);assert.equal(global.writes.length,0);
});
test('unknown, string-status and thrown failures do not trigger retries',async()=>{
  for(const mode of ['unknown','string','throw']) {
    let writes=0;
    const h=handler('http://127.0.0.1:1',{createClient(){return {from(){return {
      select(){return {gte:async()=>({count:0})};},
      async insert(){writes++;if(mode==='throw')throw Error('synthetic transport failure');return {error:{message:'synthetic'},status:mode==='string'?'502':0};},
    };}};}});
    assert.equal((await h.run(undefined,false)).status,500);assert.equal(writes,1);assert.equal(h.logs.length,1);
  }
});
test('actual table keeps the first committed report when the gateway loses its response',{skip:pgSkip(),timeout:withSlotWait(60000)},async t=>{
  const pg=await startPostgres(58973,'error-report-retry');t.after(()=>pg.close());
  const migration=readFileSync(new URL('../../supabase/migrations/20260816_errors.sql',import.meta.url),'utf8');
  await pg.sql(migration.match(/create table if not exists public\.client_errors[\s\S]+?\n\);/)[0]);
  const persist=async(row,upsert)=>{
    const columns=Object.keys(row);assert.ok(columns.every(c=>/^[a-z_]+$/.test(c)));
    await pg.sql(`insert into public.client_errors (${columns.join(',')}) select ${columns.join(',')} from jsonb_populate_record(null::public.client_errors,${quote(JSON.stringify(row))}::jsonb) ${upsert?'on conflict(id) do nothing':''}`);
  };
  const g=await gateway(t,[502,201],{commitBeforeFailure:true,persist}),h=handler(g.url),r=await h.run();
  assert.equal(r.status,200);sameReport(g,2);assert.equal(await pg.sql('select count(*) from client_errors'),'1');
  assert.equal(await pg.sql('select id::text from client_errors'),g.writes[0].row.id);
  assert.equal(await pg.sql('select message from client_errors'),'Synthetic report');
});
