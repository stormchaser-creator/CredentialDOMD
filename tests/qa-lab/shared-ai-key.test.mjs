import test from 'node:test';
import assert from 'node:assert/strict';
import { withTemporarySharedAiKey, callsSince } from '../../qa-lab/acceptance/shared-ai-key.mjs';
const key = 'qa-lab-placeholder-exclusive';
function fixture(initial = null) {
  let state = initial && {...initial}; let installs = 0; let restores = 0;
  return { get value() { return state; }, set value(v) { state=v; }, get installs() { return installs; }, get restores() { return restores; },
    store: { read: () => state && {...state}, install: (_before,value) => { installs++;state={value,updatedAt:'temporary'}; }, restore: before => { restores++;state=before && {...before}; } } };
}
test('absent and existing synthetic rows are restored exactly after success and failed scenario', async () => {
  for (const before of [null,{value:'qa-lab-placeholder-original',updatedAt:'2026-10-01 00:00:00+00'}]) for (const failure of [false,true]) {
    const f=fixture(before);const run=()=>withTemporarySharedAiKey(f.store,()=>{assert.equal(f.value.value,key);if(failure)throw Error('scenario failed');return 42;},key);
    if(failure) await assert.rejects(run,/scenario failed/);else assert.equal(await run(),42);
    assert.deepEqual(f.value,before);assert.equal(f.restores,1);
  }
});
test('a partial installation failure still restores its own mutation', async () => {
  const f=fixture();const install=f.store.install;f.store.install=(...args)=>{install(...args);throw Error('connection dropped after install');};
  await assert.rejects(()=>withTemporarySharedAiKey(f.store,()=>assert.fail('must not run'),key),/connection dropped/);assert.equal(f.value,null);
});
test('non-synthetic keys refuse before writes or scenario; concurrent replacement is never overwritten', async () => {
  const f=fixture({value:'non-placeholder-private-key',updatedAt:'old'});
  await assert.rejects(()=>withTemporarySharedAiKey(f.store,()=>assert.fail('must not run'),key),/non-synthetic/);assert.equal(f.installs,0);
  const g=fixture();await assert.rejects(()=>withTemporarySharedAiKey(g.store,()=>{g.value={value:'qa-lab-placeholder-another-writer',updatedAt:'later'};},key),/changed concurrently/);
  assert.equal(g.restores,0);assert.equal(g.value.value,'qa-lab-placeholder-another-writer');
});
test('failed exact restoration is a test failure, not a passed cleanup', async () => {
  const f=fixture();f.store.restore=()=>{};
  await assert.rejects(()=>withTemporarySharedAiKey(f.store,()=>{},key),/not restored exactly/);
});
test('provider journal requires its exact prior anchor and preserves all new calls', () => {
  const old={at:'old',provider:'gemini'};const count={at:'new1',provider:'anthropic',count:true};const reply={at:'new2',provider:'gemini',method:'generateContent'};
  assert.deepEqual(callsSince([old],[reply,count,old]),[reply,count]);assert.deepEqual(callsSince([],[reply]),[reply]);assert.throws(()=>callsSince([old],[reply]),/lost its starting anchor/);
});
