import test from 'node:test';
import assert from 'node:assert/strict';
import { writeClipboardText } from '../src/utils/clipboard.js';
import { copyToClipboard } from '../src/utils/helpers.js';

const text='Synthetic 123-45-6789\nÉlodie & colleague';
function browser(t,{write,missing=false,command=true,failAt,cleanupThrows=false}={}){
  const original=new Map(['navigator','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor]of original)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const seen={native:[],fallback:[],areas:[],restored:0};
  const doc={activeElement:{focus(){seen.restored++;}},body:{
    appendChild(area){if(failAt==='append')throw Error('synthetic append denied');area.parentNode=this;},
    removeChild(area){if(cleanupThrows)throw Error('synthetic removed DOM');area.parentNode=null;},
  },createElement(tag){assert.equal(tag,'textarea');if(failAt==='create')throw Error('synthetic DOM unavailable');
    const area={value:'',style:{},select(){if(failAt==='select')throw Error('synthetic selection denied');}};seen.areas.push(area);return area;},
    execCommand(cmd){assert.equal(cmd,'copy');seen.fallback.push(seen.areas.at(-1).value);if(failAt==='command')throw Error('synthetic copy denied');return command;},
  };
  const nav=missing?{}:{clipboard:{writeText(value){seen.native.push(value);return write?write(value):Promise.resolve();}}};
  Object.defineProperty(globalThis,'navigator',{value:nav,configurable:true});Object.defineProperty(globalThis,'document',{value:doc,configurable:true});
  return seen;
}

test('native clipboard confirmation is awaited and does not invoke fallback',async t=>{
  let confirm;const seen=browser(t,{write:()=>new Promise(resolve=>{confirm=resolve;})});
  let settled=false;const copying=writeClipboardText(text).then(result=>{settled=true;return result;});
  await Promise.resolve();assert.equal(settled,false);assert.equal(seen.areas.length,0);
  confirm();assert.equal(await copying,true);assert.deepEqual(seen.native,[text]);assert.equal(seen.areas.length,0);
});
for(const [label,options]of [['permission rejection',{write:async()=>{throw Error('NotAllowedError');}}],['synchronous API failure',{write:()=>{throw Error('synthetic API failure');}}],['missing clipboard API',{missing:true}]]){
  test(`${label}: a confirmed legacy copy succeeds, clears temporary data and restores focus`,async t=>{
    const seen=browser(t,options);assert.equal(await writeClipboardText(text),true);assert.deepEqual(seen.fallback,[text]);
    assert.equal(seen.areas[0].parentNode,null);assert.equal(seen.areas[0].value,'');assert.equal(seen.restored,1);
  });
}
for(const command of [false,undefined,'true'])test(`legacy answer ${String(command)} cannot claim success`,async t=>{
  const seen=browser(t,{missing:true,command:null});
  globalThis.document.execCommand=()=>command;
  assert.equal(await writeClipboardText(text),false);assert.equal(seen.areas[0].value,'');assert.equal(seen.areas[0].parentNode,null);
});
for(const failAt of ['create','append','select','command'])test(`legacy ${failAt} throwing is a resolved false, never an unhandled rejection`,async t=>{
  const seen=browser(t,{missing:true,failAt});assert.equal(await writeClipboardText(text),false);
  if(seen.areas.length)assert.equal(seen.areas[0].value,'');
});
test('DOM cleanup throwing cannot reject an already confirmed copy or retain its temporary secret text',async t=>{
  const seen=browser(t,{missing:true,cleanupThrows:true});assert.equal(await writeClipboardText(text),true);
  assert.equal(seen.areas[0].value,'');assert.equal(seen.restored,1);
});
test('shared copy scrubs SSNs on native and fallback routes; deliberate secret copy preserves exact text',async t=>{
  const seen=browser(t);assert.equal(await copyToClipboard(text),true);
  assert.equal(seen.native[0],'Synthetic [SSN removed]\nÉlodie & colleague');
  assert.equal(await writeClipboardText(text),true);assert.equal(seen.native[1],text);
  globalThis.navigator.clipboard.writeText=async()=>{throw Error('synthetic denied');};
  assert.equal(await copyToClipboard(text),true);assert.equal(seen.fallback[0],'Synthetic [SSN removed]\nÉlodie & colleague');
  assert.equal(await writeClipboardText(text),true);assert.equal(seen.fallback[1],text);
});
test('no navigator or document resolves false rather than throwing',async t=>{
  browser(t);delete globalThis.navigator;delete globalThis.document;
  assert.equal(await writeClipboardText(text),false);
});
