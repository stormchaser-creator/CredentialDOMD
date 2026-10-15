import test from 'node:test';
import assert from 'node:assert/strict';
import { receivingMetadataJson } from '../supabase/functions/_shared/receivingMetadata.mjs';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('one transport retry repeats only the GET with the same headers and abortable budget', async () => {
  const calls = [], headers = { Authorization: 'synthetic-test-only' };
  const result = await receivingMetadataJson('https://resend.test/receiving/synthetic', { headers, retryDelayMs: 0, fetchImpl: async (url, options) => {
    calls.push({url,...options});
    if(calls.length===1) throw new TypeError('connection closed before message completed');
    return json({id:'synthetic'});
  }});
  assert.deepEqual(result,{id:'synthetic'});assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.method==='GET'&&call.headers===headers&&call.signal instanceof AbortSignal&&call.signal.aborted));
  assert.equal(calls[0].url,calls[1].url);
});

test('a body transport failure also retries, while malformed JSON and HTTP refusals do not', async () => {
  let calls=0;
  const value=await receivingMetadataJson('https://resend.test/synthetic',{retryDelayMs:0,fetchImpl:async()=>++calls===1?{ok:true,json:async()=>{throw new TypeError('terminated')}}:json({ok:true})});
  assert.deepEqual(value,{ok:true});assert.equal(calls,2);
  for(const response of [()=>new Response('invalid-json'),()=>new Response('denied',{status:401}),()=>new Response('later',{status:503})]){
    calls=0;
    await assert.rejects(receivingMetadataJson('https://resend.test/synthetic',{retryDelayMs:0,fetchImpl:async()=>{calls++;return response()}}));
    assert.equal(calls,1);
  }
});

for(const phase of ['fetch','body'])test(`a hung ${phase} is bounded to two attempts and every signal is aborted`,async()=>{
  const signals=[];
  const start=performance.now();
  await assert.rejects(receivingMetadataJson('https://resend.test/synthetic',{timeoutMs:10,retryDelayMs:0,fetchImpl:async(_url,{signal})=>{
    signals.push(signal);
    return phase==='fetch'?new Promise(()=>{}):{ok:true,json:()=>new Promise(()=>{})};
  }}),error=>error.name==='TimeoutError');
  assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));assert.ok(performance.now()-start<500);
});

test('a continuing transport failure stops after one retry',async()=>{
  let calls=0;
  await assert.rejects(receivingMetadataJson('https://resend.test/synthetic',{retryDelayMs:0,fetchImpl:async()=>{calls++;throw new TypeError('closed')}}),/closed/);
  assert.equal(calls,2);
});
