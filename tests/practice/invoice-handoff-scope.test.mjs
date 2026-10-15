import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { createMemoryIndexedDB } from '../helpers/memory-indexeddb.mjs';

const A = 'user_handoffA', B = 'user_handoffB';
const PA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', PB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const base = 'credentialdomd-invoice-handoff-v1', dbName = 'credentialdomd-invoice-handoff';
const note = n => ({ number: `INV-20261001-${n}`, sentAt: new Date().toISOString(), total: 12, handed: true });
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({ stdin: { contents: 'export * from "./src/utils/invoiceHandoff.js"; export {setActiveUserId,purgeForSignOut,purgeAfterSessionEnd,sweepPendingOfflinePurges,setInvoiceHandoffPurge} from "./src/utils/storageScope.js"; export {honorAccountDataDeletion} from "./src/utils/dataDeletion.js"; export {purgeHandoffStores} from "./src/utils/invoiceHandoffStore.js";', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false, define: { 'import.meta.env': '{}' }, plugins: [{ name: 'synthetic-cloud', setup(b) {
  b.onResolve({filter:/supabase(?:\.js)?$/}, () => ({path:'cloud',namespace:'synthetic'}));
  b.onResolve({filter:/errorReport(?:\.js)?$/}, () => ({path:'report',namespace:'synthetic'}));
  b.onLoad({filter:/.*/,namespace:'synthetic'}, ({path}) => ({contents:path === 'cloud' ? 'export const listSharedInvoiceNumbersRpc=(...a)=>globalThis.__cloud.list(...a); export const markInvoiceNumberSharedRpc=(...a)=>globalThis.__cloud.mark(...a);' : 'export const reportError=(message,kind,extra)=>globalThis.__reported.push({message,kind,extra});'}));
  if (process.env.HANDOFF_SOURCE_FILE) b.onLoad({filter:/src\/utils\/invoiceHandoff\.js$/}, async () => ({contents:await readFile(process.env.HANDOFF_SOURCE_FILE,'utf8'),loader:'js'}));
} }] });
function store() { const m = new Map(); return { m, fail: false, get length(){ return m.size; }, key:i=>[...m.keys()][i]??null, getItem:k=>m.get(k)??null, setItem(k,v){ if(this.fail)throw Error('quota'); m.set(k,String(v)); }, removeItem(k){m.delete(k);} }; }
function fixture({idb=createMemoryIndexedDB(), local=store(), session=store()}={}) {
  const calls=[], clerk={user:{id:A},session:{user:{id:A},getToken:async()=> 'synthetic'}};
  const cloud={list:(account)=>{calls.push({kind:'list',account,actor:clerk.user.id});return Promise.resolve({data:[],error:null});},mark:(number,options,account)=>{calls.push({kind:'mark',number,options,account,actor:clerk.user.id});return Promise.resolve({data:true,error:null});}};
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,console,Blob,TextEncoder,TextDecoder,structuredClone,crypto:webcrypto,Date,Math,setTimeout,clearTimeout,setImmediate,queueMicrotask,AbortController,atob,btoa,
    indexedDB:idb,localStorage:local,sessionStorage:session,__cloud:cloud,__reported:[],window:{Clerk:clerk,localStorage:local,sessionStorage:session,indexedDB:idb},navigator:{onLine:true}});
  vm.runInContext(bundled.outputFiles[0].text,context);
  const api=module.exports;api.setActiveUserId(A);
  return {api,calls,cloud,local,session,idb,context,clerk,rows:()=>idb.dump(dbName,'notes'),switch(id){clerk.user={id};clerk.session={user:{id},getToken:async()=> 'synthetic'};api.setActiveUserId(id);}};
}
const numbers = list => Array.from(list,n=>n.number);
const tick = () => new Promise(r=>setImmediate(r));
async function seed(f) { await f.api.refreshInvoiceNotes(A);f.calls.length=0; }

// This is the actual original race: an IDB read resolves after Clerk changed.
// The old function then invokes the current shared client and labels B's rows A.
test('account switch during IndexedDB read never fetches or caches the next account under the first', async()=>{
  const f=fixture();await seed(f);
  f.cloud.list=account=>{const actor=f.clerk.user.id;f.calls.push({account,actor});return Promise.resolve({data:[{number:`INV-20261001-${actor === A ? 'A' : 'B'}`,shared_at:new Date().toISOString()}]});};
  f.idb.readHook=(key,value)=>{if(key===`${base}:${A}`)f.switch(B);return value;};
  await f.api.refreshInvoiceNotes(A);
  assert.ok(f.calls.every(call => call.account === A && call.actor === A), 'parallel reads may start for A, but never ask as B or label B as A');
  assert.deepEqual(numbers(f.api.invoiceNotes(B)), []);
  f.switch(A);assert.ok(!numbers(f.api.invoiceNotes(A)).includes('INV-20261001-B'));
});
test('a delayed server response is discarded after an account or same-subject session change',async()=>{
  for(const sessionOnly of [false,true]){
    const f=fixture();let release;f.cloud.list=()=>new Promise(r=>release=r);
    const pending=f.api.refreshInvoiceNotes(A);while(!release)await tick();
    f.switch(sessionOnly?A:B);release({data:[{number:'INV-20261001-foreign',shared_at:new Date().toISOString()}]});await pending;
    if(!sessionOnly)f.switch(A);assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);
  }
});
test('handoff uses authenticated subject and preserves ordinary synchronous note plus server stamp',async()=>{
  const f=fixture();const result=f.api.handOffInvoice(A,note('01'));assert.equal(result.kept,true);assert.equal(await result.durable,true);await tick();
  assert.deepEqual(numbers(f.api.invoiceNotes(A)),[note('01').number]);assert.equal(f.calls[0].account,A);
  assert.equal(f.local.getItem(`${base}:${PA}`),null);
  f.switch(B);assert.equal(f.api.keepInvoiceNote(A,note('stale')).kept,false);assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);
  f.api.handOffInvoice(A,note('stale'));assert.equal(f.calls.length,1);
});
test('legacy profile UUID notes are quarantined and explicit sign-out purges only the verified account and aliases',async()=>{
  const f=fixture();await seed(f);
  for(const target of [PA,PB]){f.local.setItem(`${base}:${target}`,JSON.stringify([note(target)]));f.session.setItem(`${base}:${target}`,JSON.stringify([note(target)]));f.rows().set(`${base}:${target}`,[note(target)]);}
  assert.deepEqual(numbers(f.api.invoiceNotes(PA)),[]);assert.equal(f.api.keepInvoiceNote(PA,note('bad')).kept,false);
  assert.equal(f.api.registerInvoiceHandoffOwner(A,PA),true);await f.api.keepInvoiceNote(A,note('own')).durable;
  f.api._resetInvoiceHandoff(); // aliases must survive page destruction, not only a live Map
  assert.equal(await f.api.purgeForSignOut(A),true);
  for(const target of [A,PA]){assert.equal(f.local.getItem(`${base}:${target}`),null);assert.equal(f.session.getItem(`${base}:${target}`),null);assert.equal(f.rows().has(`${base}:${target}`),false);}
  assert.ok(f.local.getItem(`${base}:${PB}`));assert.ok(f.rows().has(`${base}:${PB}`));assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);
});
test('remote explicit data deletion clears subject and legacy alias before recording the deletion stamp',async()=>{
  const f=fixture();await seed(f);f.rows().set(`${base}:${PA}`,[note('legacy')]);f.api.registerInvoiceHandoffOwner(A,PA);await f.api.keepInvoiceNote(A,note('own')).durable;
  await f.api.honorAccountDataDeletion(A,'2026-10-01T01:00:00Z');
  assert.equal(f.rows().has(`${base}:${A}`),false);assert.equal(f.rows().has(`${base}:${PA}`),false);assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);
});
test('ordinary session expiry retains handoff notes for that same subject',async()=>{
  const f=fixture();f.api.registerInvoiceHandoffOwner(A,PA);await f.api.keepInvoiceNote(A,note('retained')).durable;
  assert.equal(await f.api.purgeAfterSessionEnd(A),true);
  assert.deepEqual(numbers(f.api.invoiceNotes(A)),[note('retained').number]);assert.ok(f.rows().has(`${base}:${A}`));
  f.switch(B);assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);f.switch(A);assert.deepEqual(numbers(f.api.invoiceNotes(A)),[note('retained').number]);
});
test('purge invalidates a pending open/write and an already-started cloud read',async()=>{
  const idb=createMemoryIndexedDB(),open=idb.open.bind(idb);let release; const releases=[];
  idb.open=(...args)=>{const actual=open(...args),held={};actual.onupgradeneeded=()=>held.onupgradeneeded?.();Object.defineProperty(held,'result',{get:()=>actual.result});actual.onsuccess=()=>{releases.push(()=>held.onsuccess?.()); release=()=>releases.splice(0).forEach(fn=>fn());};return held;};
  const f=fixture({idb});const pending=f.api.keepInvoiceNote(A,note('late'));while(!release)await tick();
  idb.open=open; const purged=f.api.purgeInvoiceHandoff(A);await tick();release();assert.equal(await pending.durable,false);assert.equal(await purged,true);assert.equal(f.rows().has(`${base}:${A}`),false);
  let response;f.cloud.list=()=>new Promise(r=>response=r);const read=f.api.refreshInvoiceNotes(A);while(!response)await tick();
  await f.api.purgeInvoiceHandoff(A);response({data:[{number:'INV-20261001-late',shared_at:new Date().toISOString()}]});await read;assert.deepEqual(numbers(f.api.invoiceNotes(A)),[]);
});
test('a failed IndexedDB purge leaves a durable fence and retries before a new page can restore old notes',async()=>{
  const f=fixture();await seed(f);f.rows().set(`${base}:${PA}`,[note('old')]);f.api.registerInvoiceHandoffOwner(A,PA);await f.api.keepInvoiceNote(A,note('own')).durable;
  f.idb.closeConnections();f.idb.failOpen=true;
  assert.equal(await f.api.purgeInvoiceHandoff(A),true);assert.ok(f.local.getItem(`${base}-purge:${A}`));assert.ok(f.rows().has(`${base}:${PA}`));
  f.idb.failOpen=false;const next=fixture({idb:f.idb,local:f.local,session:f.session});
  assert.deepEqual(numbers(next.api.invoiceNotes(A)),[]);await next.api.refreshInvoiceNotes(A);
  assert.equal(next.rows().has(`${base}:${A}`),false);assert.equal(next.rows().has(`${base}:${PA}`),false);assert.equal(next.local.getItem(`${base}-purge:${A}`),null);assert.equal(next.calls.length,0);
});
test('unread IDB-only legacy alias is retained until the next purge can identify and remove it',async()=>{
  const f=fixture();await seed(f);f.rows().set(`${base}-owners:${A}`,[PA]);f.rows().set(`${base}:${PA}`,[note('legacy')]);f.idb.loseConnections();
  assert.equal(await f.api.purgeInvoiceHandoff(A),true);if(f.rows().has(`${base}:${PA}`)) assert.ok(f.rows().has(`${base}-owners:${A}`) || f.local.getItem(`${base}-purge:${A}`)?.includes(PA), 'an unread alias always retains its removal association');
  const next=fixture({idb:f.idb,local:f.local,session:f.session});await next.api.refreshInvoiceNotes(A);
  assert.equal(next.rows().has(`${base}:${PA}`),false);assert.equal(next.rows().has(`${base}-owners:${A}`),false);
});
test('malformed alias storage never authorizes another account or prevents an explicit purge',async()=>{
  const f=fixture();await seed(f);f.local.setItem(`${base}-owners:${A}`,'{}');f.session.setItem(`${base}-owners:${A}`,'42');
  assert.equal(f.api.registerInvoiceHandoffOwner(B,PB),false);assert.equal(f.api.registerInvoiceHandoffOwner(A,PA),true);
  assert.equal(await f.api.purgeInvoiceHandoff(A),true);
});
test('another tab cannot commit a pre-purge handoff after the first tab has finished deleting',async()=>{
  const first=fixture();await seed(first);
  const actual=first.idb, delayed=Object.create(actual), open=actual.open.bind(actual);let release;
  delayed.open=(...args)=>{const req=open(...args),held={};Object.defineProperty(held,'result',{get:()=>req.result});req.onupgradeneeded=()=>held.onupgradeneeded?.();req.onsuccess=()=>{release=()=>held.onsuccess?.();};return held;};
  const second=fixture({idb:delayed,local:first.local,session:store()});
  const writing=second.api.keepInvoiceNote(A,note('sibling-late'));while(!release)await tick();
  assert.equal(await first.api.purgeInvoiceHandoff(A),true);release();
  assert.equal(await writing.durable,false);assert.equal(first.rows().has(`${base}:${A}`),false);assert.equal(first.local.getItem(`${base}:${A}`),null);
});
test('purge refuses success when neither database deletion nor a durable owed-deletion marker is possible',async()=>{
  const f=fixture();await seed(f);await f.api.keepInvoiceNote(A,note('old')).durable;
  f.idb.closeConnections();f.idb.failOpen=true;f.local.fail=true;f.session.fail=true;
  assert.equal(await f.api.purgeInvoiceHandoff(A),false);
  assert.ok(f.rows().has(`${base}:${A}`),'unavailable database is not falsely called deleted');
});
test('temporarily absent IndexedDB never clears an owed purge or restores old notes on the next page',async()=>{
  const f=fixture();await seed(f);f.api.registerInvoiceHandoffOwner(A,PA);await f.api.keepInvoiceNote(A,note('old')).durable;f.rows().set(`${base}:${PA}`,[note('legacy')]);
  // A new page has lost the browser capability, while its persistent database remains.
  const blocked=fixture({idb:null,local:f.local,session:f.session});delete blocked.context.indexedDB;delete blocked.context.window.indexedDB;
  assert.equal(await blocked.api.purgeInvoiceHandoff(A),true);assert.ok(blocked.local.getItem(`${base}-purge:${A}`));
  assert.ok(f.rows().has(`${base}:${A}`));assert.deepEqual(numbers(blocked.api.invoiceNotes(A)),[]);
  const restored=fixture({idb:f.idb,local:f.local,session:f.session});await restored.api.refreshInvoiceNotes(A);
  assert.equal(restored.rows().has(`${base}:${A}`),false);assert.equal(restored.rows().has(`${base}:${PA}`),false);assert.equal(restored.local.getItem(`${base}-purge:${A}`),null);
});

test('app-launch sweep completes a signed-out account purge without opening any invoice screen',async()=>{
  const f=fixture();await seed(f);f.api.registerInvoiceHandoffOwner(A,PA);await f.api.keepInvoiceNote(A,note('old')).durable;f.rows().set(`${base}:${PA}`,[note('legacy')]);
  f.idb.closeConnections();f.idb.failOpen=true;assert.equal(await f.api.purgeForSignOut(A),true);
  f.idb.failOpen=false;const next=fixture({idb:f.idb,local:f.local,session:f.session});next.switch(null);
  await next.api.sweepPendingOfflinePurges();assert.equal(next.rows().has(`${base}:${PA}`),false);assert.equal(next.rows().has(`${base}:${A}`),false);
  assert.equal([...next.local.m.keys()].some(k=>k.includes(A)),false);assert.equal(next.calls.length,0);
});

test('an open share sheet belongs to its initiating account, even when another account uses the same number', async () => {
  const f = fixture(), n = note('57');
  f.api.handOffInvoice(A, n); await tick();
  assert.equal(f.api.shareInFlight(n.number, A), true);
  f.switch(B);
  assert.equal(f.api.shareInFlight(n.number, B), false);
  f.api.handOffInvoice(B, n); await tick();
  f.api.shareAnswered(n.number, A);
  assert.equal(f.api.shareInFlight(n.number, B), true, 'a late answer for A cannot release B');
  f.api.shareAnswered(n.number, B);
  assert.equal(f.api.shareInFlight(n.number, B), false);
});

test('a stale handoff cannot spend the current account’s number or create an in-flight share', async () => {
  const f = fixture(), n = note('58'); f.switch(B);
  f.api.handOffInvoice(A, n); await tick();
  assert.equal(f.api.shareInFlight(n.number, B), false);
  assert.equal(f.calls.length, 0);
});

test('explicit purge clears a still-open share and an outstanding retry without recreating its note', async () => {
  const f = fixture(), n = note('59');
  f.api._setHandoffTimes({ retryMs: 5, retryMaxMs: 10 });
  f.cloud.mark = (...args) => { f.calls.push({ kind: 'mark', account: args[2] }); return Promise.resolve({ error: { code: '42501' } }); };
  await f.api.handOffInvoice(A, n).durable; await tick();
  assert.equal(f.api.shareInFlight(n.number, A), true);
  await f.api.purgeInvoiceHandoff(A);
  assert.equal(f.api.shareInFlight(n.number, A), false);
  const before = f.calls.length;
  await new Promise(r => setTimeout(r, 35));
  assert.equal(f.calls.length, before); assert.deepEqual(numbers(f.api.invoiceNotes(A)), []);
});


test('the actual startup purge wiring clears the account and legacy purge barriers after completed sign-out', async () => {
  const f = fixture();
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  // Exercise the checked-in startup registration against the real bundled
  // storage modules. The prior unit fixtures never ran this wiring.
  f.context.setInvoiceHandoffPurge = f.api.setInvoiceHandoffPurge;
  f.context.purgeHandoffStores = f.api.purgeHandoffStores;
  for (const registration of main.match(/setInvoiceHandoffPurge\([^;]+\);/g) || []) {
    vm.runInContext(registration, f.context);
  }
  await seed(f);
  f.api.registerInvoiceHandoffOwner(A, PA);
  await f.api.keepInvoiceNote(A, note('A')).durable;
  f.switch(B);
  f.api.registerInvoiceHandoffOwner(B, PB);
  await f.api.keepInvoiceNote(B, note('B')).durable;
  f.switch(A);
  const deletes = new Map();
  f.context.caches = { open: async () => ({ delete: async key => {
    const count = (deletes.get(key) || 0) + 1;
    deletes.set(key, count);
    // Real Cache Storage can finish the duplicate purge after the legacy
    // cleanup has already examined its still-pending barrier.
    if (count === 2) await new Promise(resolve => setTimeout(resolve, 20));
    return true;
  } }) };
  assert.equal(await f.api.purgeForSignOut(A), true);
  await tick();
  assert.deepEqual([...f.local.m.keys()].filter(key => key.endsWith(`:${A}`)), [], 'successful purge must retire its barriers as well as its notes');
  assert.deepEqual([...f.session.m.keys()].filter(key => key.endsWith(`:${A}`)), []);
  assert.ok(![...f.rows().keys()].some(key => key.endsWith(`:${A}`) || key.endsWith(`:${PA}`)));
  f.switch(B);
  assert.deepEqual(numbers(f.api.invoiceNotes(B)), ['INV-20261001-B'], 'another account remains intact');
});


test('a successful member confirmation is informational while actual handoff failures stay errors', () => {
  const f = fixture();
  f.api.setInvoiceHandoffReporter(null);
  assert.equal(f.api.reportHandoffEvent('invoice_share_confirmed_by_member', { count: 1 }), true);
  assert.equal(f.api.reportHandoffEvent('invoice_share_confirmed_by_member', { count: 2 }), false, 'one audit event per page');
  assert.equal(f.api.reportHandoffEvent('invoice_handoff_not_kept'), true);
  assert.equal(f.api.reportHandoffEvent('invoice_handoff_stamp_failed'), true);
  assert.equal(f.api.reportHandoffEvent('invoice_share_unanswered'), true);
  assert.deepEqual(Array.from(f.context.__reported, value => value.kind), ['info', 'error', 'error', 'error']);
  assert.equal(f.context.__reported[0].extra.event, 'invoice_share_confirmed_by_member');
  assert.equal(f.api.reportHandoffEvent('unknown_event'), false);
});
