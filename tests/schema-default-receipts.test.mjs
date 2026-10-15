import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { isAcknowledgedRecordCopy } from '../src/utils/recordAcknowledgements.js';
const columns=JSON.parse(readFileSync(new URL('./helpers/record-scalar-catalog.json',import.meta.url))).columns;
const numericColumns=JSON.parse(readFileSync(new URL('./helpers/record-numeric-catalog.json',import.meta.url))).columns;
const A='user_syntheticA',profile='profileA',clone=v=>JSON.parse(JSON.stringify(v));
const camel=s=>s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
const next=v=>typeof v==='boolean'?!v:typeof v==='number'?v+1:'historical';
function server(f,collection){
 let row=null,serial=0,intervene=null;
 const defaults=Object.fromEntries(columns.filter(c=>c.collection===collection).map(c=>[c.column,c.value]));
 const version=()=>new Date(Date.UTC(2026,9,1,0,0,++serial)).toISOString();
 const matches=op=>op.filters.every(([kind,key,value])=>kind==='is'?row?.[key]==null:row?.[key]===value);
 f.onRequest=async op=>{
  if(op.method==='insert'){row={...defaults,...clone(op.value),updated_at:version()};return{data:[clone(row)],error:null};}
  if(op.method==='select')return{data:matches(op)?clone(row):null,error:null};
  if(op.method==='update'){
   if(intervene){const fn=intervene;intervene=null;fn();}
   if(!matches(op))return{data:[],error:null};
   row={...row,...clone(op.value),updated_at:version()};return{data:[clone(row)],error:null};
  }
  throw Error(`Unexpected ${op.method}`);
 };
 return{get:()=>clone(row),change:patch=>{row={...row,...patch};},beforeUpdate:fn=>{intervene=fn;}};
}

test('catalog scalar defaults preserve null, changed content and non-numeric types; SQL numeric decimal spellings are equivalent',()=>{
 const {recordContent}=fixture().api;
 for(const c of columns){
  const field=camel(c.column),base={id:'row'};
  assert.equal(recordContent(c.collection,base),recordContent(c.collection,{...base,[field]:c.value}),`${c.table}.${c.column}`);
  for(const value of [null,next(c.value)]) assert.notEqual(recordContent(c.collection,base),recordContent(c.collection,{...base,[field]:value}),`${c.column}: explicit distinct value ${String(value)}`);
  const isNumeric=numericColumns.some(n=>n.collection===c.collection&&n.column===c.column);
  const typed=recordContent(c.collection,{...base,[field]:typeof c.value==='string'?false:String(c.value)});
  if(isNumeric) assert.equal(recordContent(c.collection,base),typed,`${c.column}: only a schema-confirmed SQL numeric decimal spelling is equivalent`);
  else assert.notEqual(recordContent(c.collection,base),typed,`${c.column}: boolean/text/integer types remain distinct`);
  assert.notEqual(recordContent('education',base),recordContent('education',{...base,[field]:c.value}),'same column spelling does not infer a default on another table');
 }
 for(const [collection,field,value] of [['licenses','unknown',false],['locumContracts','dayRate',0],['documents','uploadedAt','2026-10-01T00:00:00Z'],['taskNotes','capturedAt','2026-10-01T00:00:00Z']]) assert.notEqual(recordContent(collection,{id:'row'}),recordContent(collection,{id:'row',[field]:value}),'unknown/nondefault/volatile values are never filled');
});

test('every omitted constant on a returning insert yields a verified receipt and immediate offline edit replays through its typed old-value predicate',async()=>{
 for(const c of columns){
  const f=fixture(),db=server(f,c.collection),original={id:'row',notes:'Original'},field=camel(c.column);
  await f.api.insertItem(profile,c.collection,original);
  const accepted=await f.acknowledgements.acknowledgedRecordCopies({[c.collection]:[original]},{accountId:A,fence:null});
  assert.equal(isAcknowledgedRecordCopy(accepted,c.collection,original.id),true,`${c.column}: accepted local copy`);
  await f.api.updateItem(null,c.collection,{...original,[field]:next(c.value)},original,A);
  assert.equal(f.queue().length,1);assert.equal(f.queue()[0].expectedBase?.version,db.get().updated_at,`${c.column}: known server version`);
  await f.api.replayPendingOps(profile,A);
  assert.equal(db.get()[c.column],next(c.value));assert.equal(f.queue().length,0);assert.equal(f.recovery.readRecovery(A).length,0);
  const patch=f.requests.findLast(r=>r.method==='update');assert.ok(patch.filters.some(([kind,key,v])=>kind==='eq'&&key===c.column&&v===c.value),`${c.column}: exact old typed constant`);
  assert.deepEqual(Object.keys(patch.value).sort(),[c.column,'updated_at'].sort(),'unrelated omitted desired fields are not patched');
 }
});

test('each direct scalar edit refuses a same-version competing NULL and preserves both copies',async()=>{
 for(const c of columns){
  const f=fixture(),db=server(f,c.collection),original={id:'row',notes:'Original'},field=camel(c.column);
  await f.api.insertItem(profile,c.collection,original);const version=db.get().updated_at;
  db.beforeUpdate(()=>db.change({[c.column]:null}));
  await f.api.updateItem(profile,c.collection,{...original,[field]:next(c.value)},original,A);
  assert.equal(db.get()[c.column],null);assert.equal(db.get().updated_at,version);
  const copies=f.recovery.readRecovery(A);assert.ok(copies.some(x=>x.local[field]===next(c.value)&&x.cloud[field]===null),`${c.column}: both versions remain`);
  assert.ok(f.requests.find(r=>r.method==='update').filters.some(([kind,key,v])=>kind==='eq'&&key===c.column&&v===c.value));
 }
});

test('explicit NULL bases retain IS NULL and cannot overwrite a concurrent stored default',async()=>{
 for(const c of columns){
  const f=fixture(),db=server(f,c.collection),field=camel(c.column),original={id:'row',notes:'Original',[field]:null};
  await f.api.insertItem(profile,c.collection,original);assert.equal(db.get()[c.column],null);
  db.beforeUpdate(()=>db.change({[c.column]:c.value}));
  await f.api.updateItem(profile,c.collection,{...original,[field]:next(c.value)},original,A);
  assert.equal(db.get()[c.column],c.value);assert.ok(f.recovery.readRecovery(A).some(x=>x.local[field]===next(c.value)&&x.cloud[field]===c.value));
  assert.ok(f.requests.find(r=>r.method==='update').filters.some(([kind,key,v])=>kind==='is'&&key===c.column&&v===null));
 }
});

test('absent or other-record predecessors never infer a scalar default',async()=>{
 for(const c of columns)for(const previous of [null,{id:'different'}]){
  const f=fixture();f.onRequest=async()=>({data:null,error:null});
  await f.api.updateItem(profile,c.collection,{id:'row',[camel(c.column)]:next(c.value)},previous,A);
  const patch=f.requests.find(r=>r.method==='update');assert.ok(patch.filters.some(([kind,key,v])=>kind==='is'&&key===c.column&&v===null));
  assert.ok(!patch.filters.some(([kind,key])=>kind==='eq'&&key===c.column));
 }
});

test('a duty invoice link acknowledges its exact copy while real scholarly changes before queued replay remain recoverable',async()=>{
 for(const remote of [undefined,true,null]){
  const f=fixture(),db=server(f,'dutyDays'),original={id:'duty',date:'2026-09-26',workedDay:true,callPeriods:[],callHospital:null,callRole:null,notes:'Synthetic clinic day',placementOk:false,amount:2000};
  await f.api.insertItem(profile,'dutyDays',original);
  assert.equal(f.api.recordContent('dutyDays',original),f.api.recordContent('dutyDays',Object.fromEntries(Object.entries(db.get()).map(([k,v])=>[camel(k),v]))),'schema-filled scholarly:false is not a conflict');
  const linked={...original,invoiceId:'synthetic-invoice'};
  if(remote===undefined){
   await f.api.updateItem(profile,'dutyDays',linked,original,A);
   assert.equal(db.get().invoice_id,linked.invoiceId);assert.equal(f.recovery.readRecovery(A).length,0);
   const accepted=await f.acknowledgements.acknowledgedRecordCopies({dutyDays:[linked]},{accountId:A,fence:null});assert.equal(isAcknowledgedRecordCopy(accepted,'dutyDays',original.id),true);
  }else{
   await f.api.updateItem(null,'dutyDays',linked,original,A);assert.ok(f.queue()[0].expectedBase);
   db.change({scholarly:remote});await f.api.replayPendingOps(profile,A);
   assert.equal(db.get().invoice_id,undefined);assert.equal(db.get().scholarly,remote);
   assert.ok(f.recovery.readRecovery(A).some(x=>x.local.invoiceId===linked.invoiceId&&x.cloud.scholarly===remote));
   assert.equal(f.requests.some(r=>r.method==='update'),false,'genuine cloud change prevents queued invoice association');
  }
 }
});
