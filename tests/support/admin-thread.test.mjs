import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({entryPoints:[new URL('../../src/utils/adminSupportThread.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',define:{'import.meta.env.VITE_SUPPORT_OPERATIONS_ENABLED':'"false"'}});
const {adminSupportActorLabel,loadAdminSupportThread} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const automated={id:'message-1',author_id:null,support_actor_id:'00000000-0000-4000-8000-000000000018',support_job_id:'job-1',is_admin_reply:true};

test('admin labels require protected service metadata; historical account IDs never prove a human author',()=>{
  assert.equal(adminSupportActorLabel(automated,true),'CredentialDO Support · Automated');
  for(const message of [automated,{...automated,author_id:'owner-id'},{...automated,support_job_id:null},{...automated,support_actor_id:'unknown'},{author_id:'owner-id',is_admin_reply:true,author_email:'owner@example.invalid'}]) {
    assert.equal(adminSupportActorLabel(message,false),'Reply');
    if(message!==automated) assert.equal(adminSupportActorLabel(message,true),'Reply');
  }
});

test('admin reader retains legacy view until enabled and reads protected fields from the RLS table when enabled',async()=>{
  for(const enabled of [false,true]) {
    const calls=[];
    const query={select(fields){calls.push(['select',fields]);return this;},eq(field,value){calls.push(['eq',field,value]);return this;},order(field){calls.push(['order',field]);return this;},then(resolve){return Promise.resolve({data:[automated],error:null}).then(resolve);}};
    const client={from(table){calls.push(['from',table]);return query;}};
    const result=await loadAdminSupportThread(client,'ticket-1',enabled);
    assert.deepEqual(calls[0],['from',enabled?'support_messages':'ticket_thread']);
    assert.deepEqual(calls[2],['eq','ticket_id','ticket-1']);
    assert.equal(result.data[0].support_display_label,enabled?'CredentialDO Support · Automated':'Reply');
    if(enabled) assert.match(calls[1][1],/support_actor_id,support_job_id/);
  }
});

test('a denied or failed admin read returns no apparently trusted conversation',async()=>{
  const query={select(){return this;},eq(){return this;},order(){return this;},then(resolve){return Promise.resolve({data:[automated],error:{message:'denied'}}).then(resolve);}};
  const result=await loadAdminSupportThread({from(){return query;}},'foreign-ticket',true);
  assert.equal(result.data,null);assert.equal(result.error.message,'denied');
});
