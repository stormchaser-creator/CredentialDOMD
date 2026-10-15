import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from './component-harness.mjs';
import * as helpers from '../src/utils/helpers.js';
import * as clipboard from '../src/utils/clipboard.js';
import * as shareText from '../src/utils/shareText.js';
import * as lifecycle from '../src/utils/lifecycle.js';
import * as caseBilling from '../src/utils/caseBilling.js';
import * as formLayout from '../src/utils/formLayout.js';
import * as actionButton from '../src/components/shared/actionButton.js';

function browser(t){
  const originals=new Map(['navigator','document'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  t.after(()=>{for(const[k,d]of originals)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
  const w={writes:[],write:async()=>{throw Error('synthetic permission denied');},fallback:false};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText(text){w.writes.push(text);return w.write(text);}}}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({style:{},select(){}}),body:{appendChild(area){area.parentNode=this;},removeChild(area){area.parentNode=null;}},execCommand:()=>w.fallback}});
  return w;
}
const app=()=>({data:{settings:{name:'Synthetic Physician'},documents:[],followUps:[],locumContracts:[]},theme:{},isDesktop:false,user:{id:'synthetic-user'}});
const button=(ui,label,tree)=>ui.nodes(tree).find(n=>n.type==='button'&&ui.text(n)===label);
const cpt=async()=>{
  const ui=await mountComponent('src/components/features/CPTLookup.jsx',{app:app(),modules:{helpers,cptSearch:{searchCPT:async()=>({confidence:'high',results:[{code:'61343',fullDesc:'Synthetic posterior fossa procedure',wRVU:31.06}]})}}});
  ui.nodes().find(n=>n.type==='input'&&n.props['aria-label']==='Search CPT codes').props.onChange({target:{value:'61343'}});
  await ui.timers.pop()();ui.render();return ui;
};
const hit=ui=>ui.nodes().find(n=>n.type==='button'&&n.key==='61343');

test('CPT copy denial has a usable manual-copy message and never claims copied',async t=>{
  const w=browser(t),ui=await cpt();
  hit(ui).props.onClick();await settle();
  assert.match(ui.pageText(),/Copy failed\. This browser did not allow copying; select the code to copy it\./);
  assert.doesNotMatch(ui.pageText(),/Copied to clipboard/);
  assert.equal(w.writes[0],'61343');
});
test('CPT copy confirms only after permission resolves, and clears old success during the next attempt',async t=>{
  const w=browser(t),ui=await cpt();let resolve;
  w.write=()=>new Promise(done=>{resolve=done;});
  hit(ui).props.onClick();assert.doesNotMatch(ui.pageText(),/Copied to clipboard/);
  resolve();await settle();assert.match(ui.pageText(),/Copied to clipboard/);
  // A click on the open row closes it; reopen to check the next visible attempt.
  w.write=async()=>{};hit(ui).props.onClick();await settle();
  w.write=()=>new Promise(done=>{resolve=done;});hit(ui).props.onClick();
  assert.doesNotMatch(ui.pageText(),/Copied to clipboard/);resolve();await settle();assert.match(ui.pageText(),/Copied to clipboard/);
});
test('CPT denied modern API can succeed through a confirmed fallback',async t=>{
  const w=browser(t),ui=await cpt();w.fallback=true;
  hit(ui).props.onClick();await settle();assert.match(ui.pageText(),/Copied to clipboard/);assert.doesNotMatch(ui.pageText(),/Copy failed/);
});
test('CPT an earlier same-code copy cannot confirm a newer pending or denied attempt',async t=>{
  const w=browser(t),ui=await cpt(),pending=[];
  w.write=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
  hit(ui).props.onClick();hit(ui).props.onClick();hit(ui).props.onClick();
  assert.equal(pending.length,3);
  pending[0].resolve();await settle();
  assert.doesNotMatch(ui.pageText(),/Copied to clipboard|Copy failed/,'newest open attempt is still pending');
  pending[2].reject(Error('synthetic denied latest copy'));await settle();
  assert.match(ui.pageText(),/Copy failed/);assert.doesNotMatch(ui.pageText(),/Copied to clipboard/);
  pending[1].resolve();await settle();
  assert.match(ui.pageText(),/Copy failed/);assert.doesNotMatch(ui.pageText(),/Copied to clipboard/,'late success cannot replace current denial');
});
for(const [title,opener]of [['Email Draft','✉️ Email Heads-Up'],['Text Draft','💬 Text Heads-Up']])test(`${title} remains visible after denied copy and closes only after confirmation`,async t=>{
  const w=browser(t);
  const ui=await mountComponent('src/components/features/PeerNotify.jsx',{app:app(),props:{peer:{id:'peer-1',name:'Synthetic Colleague',email:'',phone:''}},modules:{helpers,shareText,actionButton}});
  button(ui,opener).props.onClick();
  const modal=()=>ui.nodes().find(n=>n.props?.title===title);
  assert.equal(modal().props.open,true);
  await button(ui,'Copy to Clipboard',modal()).props.onClick();
  assert.equal(modal().props.open,true);assert.match(ui.text(modal()),/Could not copy/);assert.doesNotMatch(ui.text(modal()),/Copied to clipboard/);
  let finish;w.write=()=>new Promise(done=>{finish=done;});
  const pending=button(ui,'Copy to Clipboard',modal()).props.onClick();
  assert.equal(modal().props.open,true);assert.doesNotMatch(ui.text(modal()),/Copied to clipboard|Could not copy/);
  finish();await pending;assert.equal(modal().props.open,false);assert.match(ui.pageText(),/Copied to clipboard\./);
  button(ui,opener).props.onClick();assert.equal(modal().props.open,true);assert.doesNotMatch(ui.text(modal()),/Copied to clipboard/,'reopening a draft does not inherit old copy success');
});
test('revealed secret Copy preserves its exact value and reports denial without hiding the value',async t=>{
  const w=browser(t),alerts=[],secret='Synthetic-password-123-45-6789';
  const ui=await mountComponent('src/components/features/CrudSection.jsx',{
    app:app(),props:{title:'Synthetic credentials',sectionKey:'privileges',items:[{id:'secret-1',name:'Synthetic Portal',loginSecret:'encrypted-synthetic'}],fields:[{key:'loginSecret',label:'Password',type:'secret'}],autoViewId:'secret-1'},
    modules:{helpers,clipboard,lifecycle,caseBilling,formLayout,actionButton,secretBox:{hasLockCode:()=>true,isEncrypted:()=>true,decryptSecret:async()=>secret,setSecretUser(){}}},globals:{alert:message=>alerts.push(message)},
  });
  const detail=()=>ui.nodes().find(n=>n.props?.open===true&&typeof n.props.title==='string');
  button(ui,'Show',detail()).props.onClick({stopPropagation(){}});await settle();
  assert.match(ui.pageText(),/Synthetic-password-123-45-6789/);
  await button(ui,'Copy',detail()).props.onClick({stopPropagation(){}});
  assert.deepEqual(w.writes,[secret]);assert.equal(alerts.length,1);assert.match(alerts[0],/Could not copy/);
  assert.match(ui.pageText(),/Synthetic-password-123-45-6789/,'the manually selectable value remains visible');
  w.write=async()=>{};await button(ui,'Copy',detail()).props.onClick({stopPropagation(){}});
  assert.equal(w.writes.at(-1),secret);assert.equal(alerts.length,1,'a confirmed copy does not report a failure');
});
