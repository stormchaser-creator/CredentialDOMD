import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';

const A='user_syntheticA', profile='profileA';
const defaults={orientationBilled:false,splitAtDayStart:false,dayStartHour:7};
const fields=[['orientationBilled','orientation_billed',false,true],['splitAtDayStart','split_at_day_start',false,true],['dayStartHour','day_start_hour',7,8]];

test('the original three schema-proven contract defaults equal their omitted values',()=>{
  const {recordContent}=fixture().api;
  assert.equal(recordContent('locumContracts',{id:'row'}),recordContent('locumContracts',{id:'row',...defaults}));
  for(const [field,,value,changed] of fields){
    for(const other of [null,changed,String(value)]) assert.notEqual(recordContent('locumContracts',{id:'row',[field]:other}),recordContent('locumContracts',{id:'row'}),`${field}: explicit null, change and different type remain distinct`);
    assert.notEqual(recordContent('licenses',{id:'row',[field]:value}),recordContent('licenses',{id:'row'}),'same name on another collection has no inferred default');
  }
  for(const [field,value] of [['unknown',false],['dayRate',0],['coveragePeriods',[]]]) assert.notEqual(recordContent('locumContracts',{id:'row',[field]:value}),recordContent('locumContracts',{id:'row'}),'unknown/nondefault columns remain distinct');
});

test('direct edits from an omitted same-record base use the database scalar old value, with only changed desired fields',async()=>{
  for(const [field,column,old,value] of fields){
    const f=fixture(), previous={id:'row',facility:'Synthetic'};
    f.onRequest=async op=>({data:[{id:'row',facility:'Synthetic',...op.value}],error:null});
    await f.api.updateItem(profile,'locumContracts',{...previous,[field]:value},previous,A);
    const update=f.requests.find(r=>r.method==='update');assert.ok(update);
    assert.ok(update.filters.some(([kind,name,v])=>kind==='eq'&&name===column&&v===old));
    assert.deepEqual(Object.keys(update.value).sort(),[column,'updated_at'].sort());
  }
});

test('explicit null and absent or wrong-record predecessors keep their null predicate',async()=>{
  for(const [field,column,,value] of fields) for(const previous of [{id:'row',[field]:null},null,{id:'different'}]){
    const f=fixture();f.onRequest=async op=>({data:[{id:'row',...op.value}],error:null});
    await f.api.updateItem(profile,'locumContracts',{id:'row',[field]:value},previous,A);
    const update=f.requests.find(r=>r.method==='update');assert.ok(update.filters.some(([kind,name,v])=>kind==='is'&&name===column&&v===null));
    assert.ok(!update.filters.some(([kind,name])=>kind==='eq'&&name===column));
  }
});

test('a returning insert with only schema-filled defaults supplies a verified base for immediate offline edit',async()=>{
  const f=fixture(), original={id:'row',facility:'Initial'}, normalized={id:'row',facility:'Initial',orientation_billed:false,split_at_day_start:false,day_start_hour:7,updated_at:'2026-10-01T00:00:00Z'};
  f.onRequest=async()=>({data:[normalized],error:null});
  await f.api.insertItem(profile,'locumContracts',original);
  await f.api.updateItem(null,'locumContracts',{...original,facility:'Offline desired'},original,A);
  assert.equal(f.queue().length,1);assert.ok(f.queue()[0].expectedBase,'server defaults alone do not invalidate the insert receipt');
  assert.equal(f.queue()[0].expectedBase.version,normalized.updated_at);
});
