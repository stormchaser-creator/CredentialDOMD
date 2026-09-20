import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accessWriteDecision } from '../../supabase/functions/_shared/accessWrite.mjs';
const id='10000000-0000-4000-8000-000000000001';
const allow={enforcementEnabled:true,credential:true,practice:false};
test('service gate pins exact current identity and server-selected scope', async()=>{
  const calls=[];
  const db={rpc:async(...args)=>{calls.push(args);return {data:allow};}};
  assert.deepEqual(await accessWriteDecision(db,id,'user_current','credential'),{allowed:true});
  assert.deepEqual(await accessWriteDecision(db,id,'user_current','practice'),{allowed:false,status:403,error:'membership_read_only'});
  assert.deepEqual(calls[0],['credentialdo_service_write_snapshot',{p_profile_id:id,p_clerk_subject:'user_current'}]);
});
test('invalid identity/scope never call RPC',async()=>{
  const db={rpc:()=>{throw Error('must not call');}};
  for(const args of [[id,'user_current','bodySelected'],[id,'email@example.test','credential'],['other','user_current','credential']])
    assert.equal((await accessWriteDecision(db,...args)).error,'membership_unavailable');
});
test('outage and malformed RPC responses fail closed; stale pair has no upstream work',async()=>{
  for(const result of [{error:{code:'XX000'}},{data:null},{data:{...allow,credential:'true'}},{data:{credential:true,practice:true}}])
    assert.equal((await accessWriteDecision({rpc:async()=>result},id,'user_current','credential')).status,503);
  assert.equal((await accessWriteDecision({rpc:async()=>{throw Error('offline');}},id,'user_current','credential')).status,503);
  assert.equal((await accessWriteDecision({rpc:async()=>({error:{code:'42501'}})},id,'user_old','credential')).status,403);
});
test('disabled enforcement permits existing routes only on a valid typed snapshot',async()=>{
  assert.deepEqual(await accessWriteDecision({rpc:async()=>({data:{enforcementEnabled:false,credential:true,practice:true}})},id,'user_current','practice'),{allowed:true});
});
test('source package changes no rollout flags, SELECT/DELETE policies or email holds',async()=>{
  const sql=await readFile(new URL('../../supabase/migrations/20260920230000_access_write_enforcement.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/(insert into|update) public\.(access_policy_settings|access_grants|limited_beta_grants|limited_billing_invitations)\b/i);
  assert.doesNotMatch(sql,/create policy[^;]*for (select|delete)\b/i);
  assert.doesNotMatch(sql,/drop policy[^;]*(?:_select|_delete)/i);
  assert.match(sql,/current_setting\('role',true\)/);
  assert.doesNotMatch(sql,/auth\.jwt\(\)->>'role'/);
  assert.match(sql,/for d in select user_id,linked_to/);
  assert.match(sql,/continuity_owns_subject/);
});
