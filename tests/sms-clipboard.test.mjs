import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {scrubSsn} from '../src/utils/outgoingText.js';
import {smsBody, alertTextBody, smsCutNotice, alertCutNotice} from '../src/utils/shareText.js';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/utils/notifications.js',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const raw='Élodie & colleague: synthetic 123-45-6789\n\n'+'  - Credential: review license & CME.\n'.repeat(100);
function browser(t,mode,{legacy=false}={}){
 const old=new Map(['window','navigator','document'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const[k,d]of old)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]});
 const seen={opened:[],native:[],fallback:[],areas:[]};
 const nav={userAgent:'iPhone'};
 if(mode==='getter')Object.defineProperty(nav,'clipboard',{get(){throw new DOMException('Denied','NotAllowedError')}});
 else if(mode!=='missing')nav.clipboard={writeText(value){seen.native.push(value);if(mode==='throw')throw new DOMException('Denied','NotAllowedError');if(mode==='reject')return Promise.reject(new DOMException('Denied','NotAllowedError'));return new Promise(resolve=>{seen.confirm=resolve})}};
 const doc={activeElement:{focus(){}},body:{appendChild(area){area.parentNode=this},removeChild(area){area.parentNode=null}},createElement(){const area={value:'',style:{},select(){}};seen.areas.push(area);return area},execCommand(){seen.fallback.push(seen.areas.at(-1).value);return legacy}};
 for(const[k,value]of Object.entries({navigator:nav,document:doc,window:{open:url=>seen.opened.push(url)}}))Object.defineProperty(globalThis,k,{value,configurable:true});
 return seen;
}
for(const channel of ['composeText','textAlert']){
 const call=notices=>channel==='composeText'?api.composeText('+1 (202) 555-0100',raw,{copyFullOnCut:true}):api.textAlert('+1 (202) 555-0100',raw,n=>notices.push(n));
 const expected=channel==='composeText'?smsBody(scrubSsn(raw)).text:scrubSsn(alertTextBody(raw).text);
 const notice=ok=>channel==='composeText'?smsCutNotice(ok):alertCutNotice(ok);
 test(`${channel}: a pending native copy never delays the synchronous SMS handoff`,async t=>{
  const seen=browser(t,'pending'),notices=[];
  const result=call(notices);
  assert.equal(result.truncated,true);assert.equal(seen.opened.length,1,'Messages opens before clipboard confirmation');
  assert.equal(decodeURIComponent(seen.opened[0].split('&body=')[1]),expected);
  assert.deepEqual(seen.native,[scrubSsn(raw)]);
  let settled=false;result.copied.then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false);
  seen.confirm();assert.equal(await result.copied,true);
  if(channel==='textAlert')assert.deepEqual(notices,[notice(true)]);
 });
 for(const mode of ['getter','throw','missing','reject'])for(const legacy of [false,true])test(`${channel}: ${mode} clipboard with fallback ${legacy} preserves SMS and truthful copy status`,async t=>{
  const seen=browser(t,mode,{legacy}),notices=[];
  const result=call(notices);
  assert.equal(result.truncated,true);assert.equal(seen.opened.length,1,'Messages still opens during the call');
  assert.equal(decodeURIComponent(seen.opened[0].split('&body=')[1]),expected);
  const copied=await result.copied;assert.equal(copied,legacy);
  assert.deepEqual(seen.fallback,[scrubSsn(raw)]);
  assert.ok(seen.areas.every(area=>area.value===''&&area.parentNode===null));
  const feedback=channel==='composeText'?notice(copied):notices[0];
  assert.equal(feedback,notice(legacy));
  assert.doesNotMatch(seen.opened[0]+seen.fallback.join(''),/123-45-6789/);
 });
}
test('short shares and long shares without copy opt-in leave clipboard untouched',async t=>{
 const seen=browser(t,'getter');
 assert.equal(await api.composeText('2025550100','Short note',{copyFullOnCut:true}).copied,false);
 assert.equal(await api.composeText('2025550100',raw).copied,false);
 assert.equal(await api.textAlert('2025550100','Short note').copied,false);
 assert.equal(seen.opened.length,3);assert.equal(seen.areas.length,0);
});
