import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupportTextDrafts, clearSupportTextDrafts, SUPPORT_DRAFT_BASE, SUPPORT_DRAFT_TTL, supportReceiptConfirmed, supportRequestHash, supportSubmissionError } from '../../src/utils/supportTextDrafts.js';
import { purgeUserStorage, purgeForSignOut } from '../../src/utils/storageScope.js';
const ID='11111111-1111-4111-8111-111111111111';
export function memoryStorage() { const m=new Map();return { getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),key:i=>[...m.keys()][i],get length(){return m.size;},m }; }
const value={subject:'Synthetic issue',body:'Steps to reproduce the synthetic issue',category:'bug',priority:'high'};
function fixture() {const storage=memoryStorage();let owner='A',time=1000;return {storage,client:accountId=>createSupportTextDrafts({accountId,storage:()=>storage,isCurrent:()=>owner===accountId,now:()=>time}),owner:x=>owner=x,time:x=>time=x};}
test('drafts preserve exact text, category and priority only, with account/ticket isolation',()=>{
 const f=fixture(),a=f.client('A');const saved=a.save({...value,attachment:[{data:'SECRET-SCREENSHOT',name:'private.png'}],context_payload:{token:'secret'}});
 assert.ok(saved.saved);assert.equal(a.read().body,value.body);a.save({body:'Reply A'},ID);
 assert.equal(a.read(ID).body,'Reply A');assert.equal(a.read().priority,'high');
 assert.doesNotMatch([...f.storage.m.values()].join(''),/SECRET|private.png|context_payload|attachment|token/);
 f.owner('B');const b=f.client('B');assert.equal(b.read(),null);assert.equal(a.read(),null);assert.equal(a.save(value).saved,false);
 b.save({...value,body:'Other account'});f.owner('A');assert.equal(a.read().body,value.body);assert.equal(a.read(ID).body,'Reply A');
});
test('only matching success revision clears; identical retyped text is a new draft',()=>{
 const f=fixture(),a=f.client('A'),first=a.save(value).draft;
 const newer=a.save(value).draft;assert.notEqual(first.revision,newer.revision);
 assert.equal(a.clear('create',first.revision),false);assert.equal(a.read().revision,newer.revision);
 assert.equal(a.clear('create',newer.revision),true);assert.equal(a.read(),null);
});
test('expiry, malformed data, signed-out and unavailable storage do not leak or claim saving',()=>{
 const f=fixture(),a=f.client('A');a.save(value);f.time(1000+SUPPORT_DRAFT_TTL);assert.equal(a.read(),null);
 f.storage.setItem(`${SUPPORT_DRAFT_BASE}:A`,'{broken');assert.equal(a.read(),null);
 f.owner(null);assert.equal(a.read(),null);assert.equal(a.save(value).saved,false);
 const broken=createSupportTextDrafts({accountId:'A',isCurrent:()=>true,storage:()=>{throw Error('quota');}});
 assert.equal(broken.save(value).saved,false);assert.equal(broken.read(),null);
});
test('session loss preserves same-account drafts; explicit sign-out and server wipe remove only that account',async()=>{
 const f=fixture();globalThis.localStorage=memoryStorage();globalThis.window={sessionStorage:f.storage};
 f.client('A').save(value);f.owner('B');f.client('B').save(value);
 await purgeUserStorage('A',{keepVault:true});assert.ok(f.storage.getItem(`${SUPPORT_DRAFT_BASE}:A`));
 await purgeForSignOut('A');assert.equal(f.storage.getItem(`${SUPPORT_DRAFT_BASE}:A`),null);assert.ok(f.storage.getItem(`${SUPPORT_DRAFT_BASE}:B`));
 await purgeUserStorage('B',{keepVault:true,retireRecovery:true});assert.equal(f.storage.length,0);
 f.owner('A');f.client('A').save(value);clearSupportTextDrafts('A',()=>f.storage);assert.equal(f.storage.length,0);
});
test('only receipt envelope confirms success, and 504/401 make no false delivery/session claims',async()=>{
 for(const data of [null,'<html>OK</html>',{}, {ok:true}, {ok:true,id:'bad'}, {ok:false,id:ID}]) assert.equal(supportReceiptConfirmed(data),false);
 assert.equal(supportReceiptConfirmed({ok:true,id:ID}),true);
 assert.equal(await supportSubmissionError({context:{status:504}}),'We could not confirm receipt. Check Your tickets before retrying.');
 const auth=await supportSubmissionError({context:{status:401}});assert.doesNotMatch(auth,/You are signed out|not created|not sent/);assert.match(auth,/may need to sign in/);
});

// Review 2026-09-30 (QA SUPPORT-001): the key a draft was sent with survives
// the component, so a retry after a reload is still the same request.
test('a sent draft keeps its request key and digest through edits and a reload; confirmation clears both',()=>{
 const f=fixture(),a=f.client('A');const KEY='33333333-3333-4333-8333-333333333333';const hash=supportRequestHash('["synthetic"]');
 assert.match(hash,/^[0-9a-f]{28}$/);assert.equal(supportRequestHash('["synthetic"]'),hash);assert.notEqual(supportRequestHash('["synthetic."]'),hash);
 a.save({...value,request:{id:KEY,hash}});assert.deepEqual(a.read().request,{id:KEY,hash});
 a.save({...value,body:'Edited after the failed send'});assert.deepEqual(a.read().request,{id:KEY,hash},'an edit keeps it; the digest decides at the next send');
 assert.deepEqual(f.client('A').read().request,{id:KEY,hash},'a new client (a reload) reads it back');
 a.save({body:'Reply text',request:{id:KEY,hash}},ID);assert.deepEqual(a.read(ID).request,{id:KEY,hash});
 a.save({...value,request:null});assert.equal(a.read().request,undefined,'null drops it');
 for(const bad of [{id:'not-a-uuid',hash},{id:KEY,hash:'short'},{id:KEY},'text']){a.save({...value,request:bad});assert.equal(a.read().request,undefined);}
 a.save({...value,request:{id:KEY,hash,extra:'x'}});assert.deepEqual(a.read().request,{id:KEY,hash},'only the two fields are kept');
 assert.equal(a.clear('create',a.read().revision),true);assert.equal(a.read(),null);
});
