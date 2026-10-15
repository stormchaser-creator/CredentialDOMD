import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@supabase/supabase-js';
import { fixture, deferred, tick } from '../limited-launch/persistence-fixture.mjs';
const A='user_syntheticA';
for(const kind of ['list','mark']){
  const call=(f,current=()=>true)=>kind==='list'?f.api.listSharedInvoiceNumbersRpc(A,current):f.api.markInvoiceNumberSharedRpc('INV-20261001-01',{shared:true},A,current);
  test(`${kind} handoff RPC uses captured session and refuses account switch during token minting`,async()=>{
    const f=fixture({supabaseJs:sdk}),gate=deferred();let started=false;
    f.clerk.session.getToken=()=>{started=true;return gate.promise;};
    const pending=call(f);while(!started)await tick();f.switchAccount();gate.resolve('synthetic');
    await assert.rejects(pending,{code:'membership_account_changed'});assert.equal(f.requests.length,0);
  });
  test(`${kind} handoff RPC refuses a purge during token minting`,async()=>{
    const f=fixture({supabaseJs:sdk}),gate=deferred();let started=false,current=true;
    f.clerk.session.getToken=()=>{started=true;return gate.promise;};
    const pending=call(f,()=>current);while(!started)await tick();current=false;gate.resolve('synthetic');
    await assert.rejects(pending,{code:'membership_account_changed'});assert.equal(f.requests.length,0);
  });
  test(`${kind} handoff RPC accepts ordinary same-account response but rejects a response after switch`,async()=>{
    for(const change of [false,true]){
      const f=fixture({supabaseJs:sdk}),gate=deferred();
      f.onRequest=()=>gate.promise;const pending=call(f);while(!f.requests.length)await tick();
      if(change)f.switchAccount();gate.resolve(new Response(JSON.stringify(kind==='list'?[]:true),{status:200,headers:{'Content-Type':'application/json'}}));
      if(change)await assert.rejects(pending,{code:'membership_account_changed'});else assert.equal((await pending).error,null);
      assert.equal(f.requests.length,1);
    }
  });
}
