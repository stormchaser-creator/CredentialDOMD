import test from 'node:test';
import assert from 'node:assert/strict';
class MemoryStorage {
 constructor(){this.map=new Map();} get length(){return this.map.size;} key(i){return [...this.map.keys()][i]??null;}
 getItem(k){return this.map.get(k)??null;} setItem(k,v){this.map.set(k,String(v));} removeItem(k){this.map.delete(k);}
}
globalThis.localStorage=new MemoryStorage();globalThis.sessionStorage=new MemoryStorage();
const scope=await import('../../src/utils/storageScope.js');scope.setActiveUserId('user_synthetic_peek');
const drafts=await import('../../src/utils/formDrafts.js');
const base='crud:healthRecords',slot='crud:healthRecords|add|closed-synthetic-page';
const value={editId:null,base:null,form:{category:'Vaccination',name:'QA cold draft',doses:[{doseNumber:1,manufacturer:'QA-MFG',lotNumber:'QA-DOSE'}]},extra:{attachedDocs:[]}};
const options={base,slotFor:id=>`${base}|${id||'add'}|${drafts.formDraftTab()}`,records:[],recordsRead:true};
function reset(){globalThis.localStorage.map.clear();globalThis.sessionStorage.map.clear();scope.setActiveUserId('user_synthetic_peek');}
test('startup peeking retains the draft until its actual screen claims it',async()=>{
 reset();drafts.saveFormDraft(slot,value);const before=[...globalThis.localStorage.map];
 const result=await drafts.pickFormDraft({...options,peek:true});
 assert.deepEqual(result.restore.changed,value.form);
 assert.deepEqual([...globalThis.localStorage.map],before,'startup must not consume/move another page’s draft');
 const claimed=await drafts.pickFormDraft(options);
 assert.deepEqual(claimed.restore.changed,value.form);
 assert.equal(drafts.readFormDraft(slot),null,'normal screen claim still retires the old page slot');
});
test('a startup peek prunes neither untouched nor removed-edit drafts',async()=>{
 reset();drafts.saveFormDraft(slot,{editId:'removed',base:{name:'Old'},form:{name:'Changed'}});
 drafts.saveFormDraft('crud:healthRecords|add|closed-empty',{editId:null,form:{name:''}});
 const before=[...globalThis.localStorage.map];assert.deepEqual(await drafts.pickFormDraft({...options,peek:true}),{none:true});
 assert.deepEqual([...globalThis.localStorage.map],before);
 assert.deepEqual(await drafts.pickFormDraft(options),{none:true});
 assert.deepEqual(drafts.listFormDrafts(base+'|'),[],'the actual screen still cleans up unusable drafts');
});
test('account change or canceled navigation cannot consume the initiating account’s draft',async()=>{
 reset();drafts.saveFormDraft(slot,value);scope.setActiveUserId('user_synthetic_other');
 assert.deepEqual(await drafts.pickFormDraft({...options,peek:true}),{none:true});
 scope.setActiveUserId('user_synthetic_peek');
 assert.deepEqual(await drafts.pickFormDraft({...options,peek:true,stillWanted:()=>false}),{stopped:true});
 assert.deepEqual(drafts.readFormDraft(slot),value);
});
