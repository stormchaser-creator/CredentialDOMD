import test from 'node:test';
import assert from 'node:assert/strict';
import { clockReceiptBounds, dockerClockWindow, readEdgeClock, timestampNs, withinDockerWindow } from '../../qa-lab/lib/edge-clock.mjs';
import { localContainer } from '../../qa-lab/lib/config.mjs';
import { labHealth } from '../../qa-lab/e2e/run.mjs';
import { EDGE_NEGATIVES, edgeErrorObservations, edgeRequestClaim, edgeRequestObservation, reconcileEdgeClaims } from '../../qa-lab/lib/edge-health-claims.mjs';
import { observeIntentionalEdgeRequest } from '../../qa-lab/e2e/support/edge-health.mjs';

const container = localContainer('edge_runtime'), containerId = 'a'.repeat(64);
const instant = offset => new Date(Date.parse('2026-10-01T00:00:00.000Z') + offset).toISOString();
const receipt = (start, end, docker) => ({ container, containerId, hostStartedAt: instant(start), hostFinishedAt: instant(end), dockerAt: instant(docker).replace('Z','000000Z'), elapsedNs: String((end-start)*1e6), hostSamplingNs: '0' });
const before = receipt(0, 20, 90), after = receipt(40,60,130);
const spec = EDGE_NEGATIVES.expired_checkout;
const response = { url: `http://127.0.0.1:55421${spec.path}`, method: 'POST', status: 409, text: '{"error":"quote_expired"}' };
const request = () => edgeRequestObservation({ startedAt: instant(21), finishedAt: instant(39), url: response.url, method: response.method, status: response.status, responseText: response.text, clock: { before, after } });
const rows = () => edgeErrorObservations(`${instant(120).replace('Z','000001Z')} ${spec.line}`);
function deps(extra = {}) {
  const clocks = [before, after], times = [instant(21), instant(39)];
  return { clock: () => clocks.shift(), now: () => times.shift(), read: rows, ...extra };
}

test('clock reads inspect exact named container then execute by immutable identity within the same measured bracket', () => {
  const calls = [], times = [instant(0), instant(20)], monotimes = [0n, 0n, 10_000_000n, 20_000_000n, 20_000_000n];
  const r = readEdgeClock({ now: () => times.shift(), monotonic: () => monotimes.shift(), run: (cmd,args,opts) => {
    calls.push({cmd,args,opts});
    return { status: 0, stdout: args[0] === 'inspect' ? `/${container}\t${containerId}\ttrue\n` : `${instant(90).replace('Z','000000Z')}\n` };
  } });
  assert.deepEqual(r, before); assert.equal(Object.isFrozen(r),true);
  assert.equal(calls[0].args.at(-1),container); assert.equal(calls[1].args[1],containerId);
  assert.equal(calls[1].opts.timeout,1990); assert.equal(calls[0].opts.maxBuffer,4096);
});

test('foreign/stopped/malformed identity or inspect errors never execute the clock', () => {
  for (const result of [
    {status:0,stdout:`/supabase_edge_runtime_foreign\t${containerId}\ttrue`},
    {status:0,stdout:`/${container}\tshort\ttrue`}, {status:0,stdout:`/${container}\t${containerId}\tfalse`},
    {status:0,stdout:`/${container}\t${containerId}\ttrue\nextra`},
    {status:1,stdout:''}, {status:null,error:new Error('ETIMEDOUT')},
  ]) {
    let calls=0; assert.throws(() => readEdgeClock({run:()=>{calls++;return result;}}),/identify/); assert.equal(calls,1);
  }
  assert.throws(()=>readEdgeClock({container:'not-a-container',run:()=>assert.fail()}),/exact/);
});

test('clock output, timeouts, over-budget inspect, and wall-clock jumps fail closed', () => {
  for (const answer of [ {status:0,stdout:instant(90)}, {status:0,stdout:'2026-02-30T00:00:00.000000000Z'}, {status:0,stdout:'bad'}, {status:1}, {status:0,error:new Error('maxBuffer')}, {status:null,error:new Error('ETIMEDOUT')} ]) {
    let n=0; const times=[instant(0),instant(20)], mono=[0n,0n,10_000_000n,20_000_000n,20_000_000n];
    assert.throws(()=>readEdgeClock({ now:()=>times.shift(),monotonic:()=>mono.shift(),run:()=>n++?answer:{status:0,stdout:`/${container}\t${containerId}\ttrue`}}));
  }
  let calls=0; const mono=[0n,0n,2_000_000_001n];
  assert.throws(()=>readEdgeClock({monotonic:()=>mono.shift(),run:()=>{calls++;return {status:0,stdout:`/${container}\t${containerId}\ttrue`};}}),/deadline/);
  assert.equal(calls,1);
  for(const patch of [{hostFinishedAt:instant(-1)}, {elapsedNs:'-1'}, {elapsedNs:'2000000001'}, {elapsedNs:'0'}, {dockerAt:'infinity'}, {container:'supabase_edge_runtime_foreign'}]) {
    assert.throws(()=>clockReceiptBounds({...before,...patch}));
  }
});

test('measured VM offset admits a real timestamp beyond host response without widening Docker bounds', () => {
  const r=request(), raw=rows(); assert.ok(raw[0].at > r.finishedAt);
  const window=dockerClockWindow(before,after,{hostStartedAt:r.startedAt,hostFinishedAt:r.finishedAt});
  assert.deepEqual({since:window.since,until:window.until},{since:before.dockerAt,until:after.dockerAt});
  assert.equal(edgeRequestClaim(raw,r,{kind:'expired_checkout',reason:'expired synthetic quote'}).observationId,raw[0].id);
  assert.equal(withinDockerWindow('2026-10-01T00:00:00.130000001Z',window),false);
  assert.equal(timestampNs('2026-10-01T00:00:00.130000001Z')-timestampNs('2026-10-01T00:00:00.130000000Z'),1n);
});

test('replaced container, clock reversal/jump, misplaced action or missing receipts invalidate the window', () => {
  for(const other of [null,{...after,containerId:'b'.repeat(64)},{...after,dockerAt:instant(300).replace('Z','000000Z')},{...after,dockerAt:instant(1).replace('Z','000000Z')},{...after,hostStartedAt:instant(10),elapsedNs:'50000000'}]) {
    assert.throws(()=>dockerClockWindow(before,other));
  }
  for(const action of [{hostStartedAt:instant(19),hostFinishedAt:instant(39)}, {hostStartedAt:instant(21),hostFinishedAt:instant(41)}, {hostStartedAt:instant(39),hostFinishedAt:instant(21)}]) assert.throws(()=>dockerClockWindow(before,after,action),/bracket/);
});

test('delayed log ingestion rereads identical measured bounds without repeating the request', async () => {
  let actions=0, reads=0, tick=0; const windows=[], recorded=[];
  const result=await observeIntentionalEdgeRequest('expired_checkout','intentional expiry',async()=>{actions++;return response;},deps({
    monotonic:()=>tick,pause:async ms=>{tick+=ms;},recordRequest:r=>recorded.push(r),read:(...args)=>{windows.push(args.slice(0,2));return ++reads===3?rows():[];}
  }));
  assert.equal(actions,1);assert.equal(result.reads,3);assert.equal(recorded.length,1);
  assert.deepEqual(windows,Array(3).fill([before.dockerAt,after.dockerAt]));
});

test('ambiguity and unavailable evidence fail immediately while HTTP receipt remains recorded', async () => {
  for(const read of [()=>[...rows(),...edgeErrorObservations(`${instant(121).replace('Z','000000Z')} ${spec.line}`)],()=>{throw new Error('unavailable');}]) {
    let actions=0,pauses=0;const recorded=[];
    await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>{actions++;return response;},deps({read,recordRequest:r=>recorded.push(r),pause:async()=>{pauses++;}})));
    assert.equal(actions,1);assert.equal(pauses,0);assert.equal(recorded[0].status,409);
  }
});

test('bounded absence and post-response clock failure retain actual HTTP without creating claims', async () => {
  let tick=0,actions=0; const recorded=[];
  await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>{actions++;return response;},deps({
    timeoutMs:200,monotonic:()=>tick,pause:async ms=>{tick+=ms;},read:()=>[],recordRequest:r=>recorded.push(r)
  })),/absent/);
  assert.equal(actions,1);assert.equal(tick,200);assert.equal(recorded.length,1);
  const failure=[];let calls=0;
  await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>response,deps({clock:()=>{if(calls++)throw new Error('clock offline');return before;},recordRequest:r=>failure.push(r)})),/clock offline/);
  assert.equal(failure[0].responseText,response.text);assert.equal(failure[0].clock.after,null);
});

test('full health uses measured Docker bounds for timestamped server rows/logs and preserves host scope', () => {
  const sql=[],calls=[];
  const h=labHealth(instant(21),instant(39),{before,after},{json:q=>{sql.push(q);return [];},run:(...args)=>{calls.push(args);return {status:0,stdout:`${rows()[0].raw}\n`,stderr:''};}});
  assert.equal(h.since,instant(21));assert.equal(h.until,instant(39));assert.deepEqual(h.edgeErrorObservations,rows());
  assert.ok(sql[0].includes(`created_at >= '${before.dockerAt}' and created_at <= '${after.dockerAt}'`));
  assert.deepEqual(calls[0][1],['logs','--timestamps','--since',before.dockerAt,'--until',after.dockerAt,containerId]);
  let callsInvalid=0;const bad=labHealth(instant(21),instant(39),{before,after:{...after,containerId:'b'.repeat(64)}},{json:()=>{callsInvalid++;},run:()=>{callsInvalid++;}});
  assert.equal(callsInvalid,0);assert.match(bad.edgeFunctionErrors,/unavailable/);assert.match(bad.clockProblem,/container|clock offset/i);
});

test('full reconciliation rejects request/run clock mismatch and unknown old reports', () => {
  const runBefore=receipt(-100,-80,-10),runAfter=receipt(100,120,190);
  const attempt={test:'negative',file:'negative.spec.mjs',retry:0,repeatEachIndex:0,attemptStatus:'passed'};
  const r={...request(),...attempt}, raw=rows(),claim={...edgeRequestClaim(raw,r,{kind:'expired_checkout',reason:'negative'}),...attempt};
  const h=labHealth(instant(-79),instant(99),{before:runBefore,after:runAfter},{json:()=>[],run:()=>({status:0,stdout:raw[0].raw,stderr:''})});
  assert.equal(reconcileEdgeClaims(h,[r],[claim]).problems.length,0);
  for(const clock of [undefined,{before:{...before,containerId:'b'.repeat(64)},after:{...after,containerId:'b'.repeat(64)}},{before:receipt(-200,-180,-110),after}]) {
    assert.ok(reconcileEdgeClaims(h,[{...r,clock}],[claim]).problems.length);
  }
  assert.ok(reconcileEdgeClaims({...h,edgeClock:null},[r],[claim]).problems.length);
});


test('unexpected200/503 and malformed/body-failed HTTP remain visible but never make a claim', async () => {
  for (const actual of [{...response,status:200},{...response,status:503},{...response,url:'bad'},{...response,text:undefined}]) {
    const recorded=[];let actions=0;
    await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>{actions++;return actual;},deps({recordRequest:r=>recorded.push(r),read:()=>assert.fail('cannot reach raw match')})));
    assert.equal(actions,1);assert.equal(recorded.length,1);assert.equal(recorded[0].status,actual.status);assert.ok(recorded[0].captureProblem);
  }
  const recorded=[];
  await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>({url:()=>response.url,status:()=>409,request:()=>({method:()=>response.method}),text:async()=>{throw new Error('body aborted');}}),deps({recordRequest:r=>recorded.push(r)})),/body aborted/);
  assert.equal(recorded[0].status,409);assert.match(recorded[0].captureProblem,/body/);
  let actions=0;
  await assert.rejects(observeIntentionalEdgeRequest('expired_checkout','negative',async()=>{actions++;},deps({clock:()=>{throw new Error('before-clock unavailable');}})),/before-clock unavailable/);
  assert.equal(actions,0);
});


test('actual host sample duration accounts for scheduling without inventing a clock tolerance', () => {
  assert.doesNotThrow(()=>clockReceiptBounds({...before,elapsedNs:'23000000',hostSamplingNs:'4000000'}));
  assert.throws(()=>clockReceiptBounds({...before,elapsedNs:'23000000',hostSamplingNs:'0'}),/host clock/);
  assert.throws(()=>clockReceiptBounds({...before,hostSamplingNs:'20000001'}),/host clock/);
  assert.throws(()=>clockReceiptBounds({...before,hostSamplingNs:undefined}),/Malformed/);
});
