// Exercise the actual baseline modal callbacks with reordered synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as drafts from '../../src/utils/supportTextDrafts.js';
import { attachmentsPayload, linksFor } from '../../src/utils/ticketAttachments.js';
const source=await readFile(new URL('../../src/components/pages/SupportModal.jsx',import.meta.url),'utf8');
const ID='11111111-1111-4111-8111-111111111111',ID2='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};};
const ticket=id=>({id,subject:`Issue ${id}`,body:'Synthetic initial report',status:'open',created_at:'2026-09-20T00:00:00Z'});
function fixture({storage=store(),account='user_A',operations=false}={}) {
 const hooks=[],effects=[],sends=[],timers=[];let cursor=0,closed=0,props={open:true,onClose:()=>closed++};
 const window={sessionStorage:storage,Clerk:{user:{id:account},session:{}},location:{pathname:'/app/'}};globalThis.window=window;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
 const react={useState(init){const i=cursor++;if(!(i in hooks))hooks[i]=typeof init==='function'?init():init;return [hooks[i],v=>hooks[i]=typeof v==='function'?v(hooks[i]):v];},useRef(init){const i=cursor++;return hooks[i]??=( {current:init});},useMemo(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={deps,value:fn()};return hooks[i].value;},useCallback(fn,deps){return react.useMemo(()=>fn,deps);},useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps)){const old=hooks[i];hooks[i]={deps};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=fn();});}}};
 const db={from(table){const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},limit(){return q;},maybeSingle:async()=>({data:{id:ID}}),then(resolve){return Promise.resolve({data:table==='support_tickets'?[ticket(ID),ticket(ID2)]:[]}).then(resolve);}};return q;},functions:{invoke(name,args){const d=deferred();sends.push({name,args,...d});return d.promise;}}};
 const operationClient={createDraft:()=>null,replyDraft:()=>null};
 const imports={react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},'../../context/AppContext':{useApp:()=>({theme:{},user:{id:account,email:'synthetic@example.invalid'},isDesktop:true})},'../../utils/deskKeys':{pushModal(){},popModal(){},isTopModal:()=>true},'../../utils/edgeError':{edgeErrorMessage:async()=> 'Synthetic read failure'},'../../lib/supabase':{supabase:db},'../shared':{ScreenshotAttach:'screenshot'},'../shared/TicketAttachments':{default:'attachments'},'../../utils/ticketAttachments':{attachmentsPayload,linksFor},'../../utils/supportTextDrafts':drafts,'../../utils/supportOperationsClient':{SUPPORT_OPERATIONS_ENABLED:operations,createSupportOperationsClient:()=>operationClient}};
 const module={exports:{}};const ctx=vm.createContext({module,exports:module.exports,require:n=>imports[n],window,document:{addEventListener(){},removeEventListener(){}},console,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}});
 vm.runInContext(transformSync(source+'\nexport {SupportModalContent};',{loader:'jsx',format:'cjs',jsx:'automatic'}).code,ctx);
 const render=()=>{cursor=0;let tree=module.exports.SupportModalContent(props);if(effects.length){effects.splice(0).forEach(fn=>fn());cursor=0;tree=module.exports.SupportModalContent(props);}return tree;};
 const nodes=(tree=render())=>{const out=[];const visit=n=>{if(n&&typeof n==='object'){if(n.type)out.push(n);const children=n.props?.children;for(const child of Array.isArray(children)?children:[children])Array.isArray(child)?child.forEach(visit):visit(child);}};visit(tree);return out;};
 const text=node=>{const c=node?.props?.children;return (Array.isArray(c)?c:[c]).map(v=>typeof v==='string'?v:v&&typeof v==='object'?text(v):'').join('');};
 const button=label=>{const n=nodes().find(n=>n.type==='button'&&text(n)===label);assert.ok(n,`Missing button ${label}`);return n;};
 return {storage,window,sends,timers,render,nodes,text,button,get closed(){return closed;},setOpen(open){props={...props,open};render();},edit(type,value){const n=nodes().find(n=>n.type===type);assert.ok(n);n.props.onChange({target:{value}});render();},unmount(){for(const h of hooks)h?.cleanup?.();},draft:()=>drafts.createSupportTextDrafts({accountId:account})};
}
const tick=()=>new Promise(r=>setImmediate(r));
async function openTicket(f,id=ID){f.button('Your tickets').props.onClick();f.render();await tick();const n=f.nodes().find(n=>n.type==='button'&&f.text(n).includes(`Issue ${id}`));assert.ok(n);await n.props.onClick();f.render();}
test('create failure, close and full component reopen restore text only; explicit discard removes it',async()=>{
 const f=fixture();f.edit('input','Draft subject');f.edit('textarea','My synthetic failing support request');
 const screenshot=f.nodes().find(n=>n.type==='screenshot');screenshot.props.onChange([{data:'data:image/png;base64,PRIVATE',name:'shot.png'}]);f.render();
 const send=f.button('Send ticket').props.onClick();assert.equal(f.sends.length,1);assert.equal(f.sends[0].args.body.attachment.data,'data:image/png;base64,PRIVATE');
 f.sends[0].resolve({error:{context:{status:504}}});await send;
 assert.match(f.text(f.render()),/Check Your tickets before retrying/);
 f.button('Cancel').props.onClick();f.setOpen(false);f.unmount();
 const reopened=fixture({storage:f.storage});assert.equal(reopened.nodes().find(n=>n.type==='textarea').props.value,'My synthetic failing support request');
 assert.equal(reopened.nodes().find(n=>n.type==='input').props.value,'Draft subject');
 assert.equal(reopened.nodes().find(n=>n.type==='screenshot').props.value.length,0);
 assert.doesNotMatch([...f.storage.m.values()].join(''),/PRIVATE|shot.png/);
 reopened.button('Discard text draft').props.onClick();assert.equal(reopened.nodes().find(n=>n.type==='textarea').props.value,'');assert.equal(reopened.draft().read(),null);
});
test('ambiguous success retains draft, confirmed success clears it, no automatic retries',async()=>{
 const f=fixture();f.edit('textarea','Synthetic report receipt validation');let send=f.button('Send ticket').props.onClick();f.sends[0].resolve({data:'<html>OK</html>'});await send;
 assert.ok(f.draft().read());assert.equal(f.sends.length,1);assert.doesNotMatch(f.text(f.render()),/Ticket received\./);
 send=f.button('Send ticket').props.onClick();f.sends[1].resolve({data:{ok:true,id:ID}});await send;assert.equal(f.draft().read(),null);assert.match(f.text(f.render()),/Ticket received\./);
});
test('late success after close preserves a newer draft and cannot close its window',async()=>{
 const f=fixture();f.edit('textarea','Original report text');const send=f.button('Send ticket').props.onClick();f.button('Cancel').props.onClick();f.setOpen(false);f.setOpen(true);f.edit('textarea','New report after reopening');
 f.sends[0].resolve({data:{ok:true,id:ID}});await send;assert.equal(f.draft().read().body,'New report after reopening');assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'New report after reopening');assert.equal(f.timers.length,0);
});
test('reply failure survives thread close/reopen and stays scoped to the exact ticket',async()=>{
 const f=fixture();await openTicket(f);f.edit('textarea','Reply must survive failed send');const send=f.button('Send reply').props.onClick();f.sends[0].resolve({error:{context:{status:401}}});await send;
 assert.match(f.text(f.render()),/could not verify/);assert.doesNotMatch(f.text(f.render()),/You are signed out/);
 f.button('Back').props.onClick();await openTicket(f,ID2);assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'');
 f.button('Back').props.onClick();await openTicket(f,ID);assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'Reply must survive failed send');
 const retry=f.button('Send reply').props.onClick();f.sends[1].resolve({data:{ok:true,id:ID2}});await retry;assert.equal(f.draft().read(ID),null);assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'');
});
test('late reply success cannot erase newer text, and another account cannot restore or submit old text',async()=>{
 const f=fixture();await openTicket(f);f.edit('textarea','Original reply');const send=f.button('Send reply').props.onClick();f.button('Back').props.onClick();await openTicket(f);f.edit('textarea','Newer reply');f.sends[0].resolve({data:{ok:true,id:ID2}});await send;
 assert.equal(f.draft().read(ID).body,'Newer reply');assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'Newer reply');
 f.window.Clerk={user:{id:'user_B'},session:{}};await f.button('Send reply').props.onClick();assert.equal(f.sends.length,1);
 f.unmount();const b=fixture({storage:f.storage,account:'user_B'});assert.equal(b.nodes().find(n=>n.type==='textarea').props.value,'');assert.equal(b.draft().read(ID),null);
 const a=fixture({storage:f.storage});await openTicket(a);assert.equal(a.nodes().find(n=>n.type==='textarea').props.value,'Newer reply');
});
test('staged operations path does not expose the baseline session draft controls',()=>{
 const f=fixture({operations:true});f.edit('textarea','Operations remain separate');assert.doesNotMatch(f.text(f.render()),/Text draft|Discard text draft/);assert.equal(f.storage.m.size,0);
});
test('unavailable tab storage warns and tab navigation preserves the still-mounted text',async()=>{
 const storage={getItem(){throw Error('unavailable');},setItem(){throw Error('quota');},removeItem(){throw Error('unavailable');}};
 const f=fixture({storage});f.edit('textarea','Text to copy before closing');assert.match(f.text(f.render()),/could not save your draft/);
 f.button('Your tickets').props.onClick();f.render();await tick();f.button('New ticket').props.onClick();assert.equal(f.nodes().find(n=>n.type==='textarea').props.value,'Text to copy before closing');
});
test('late confirmed receipt clears the unchanged closed draft without reopening or resaving it',async()=>{
 const f=fixture();f.edit('textarea','Submitted report then close');const send=f.button('Send ticket').props.onClick();f.button('Cancel').props.onClick();f.setOpen(false);f.unmount();
 f.sends[0].resolve({data:{ok:true,id:ID}});await send;assert.equal(f.draft().read(),null);assert.equal(f.timers.length,0);
 const reopened=fixture({storage:f.storage});assert.equal(reopened.nodes().find(n=>n.type==='textarea').props.value,'');
});
test('attachment-only replies preserve the existing wire payload and save no screenshot draft',async()=>{
 const f=fixture();await openTicket(f);f.nodes().find(n=>n.type==='screenshot').props.onChange([{data:'data:image/png;base64,ATTACHMENT_ONLY',name:'private.png'}]);f.render();
 const send=f.button('Send reply').props.onClick();assert.equal(f.sends[0].args.body.body,'');assert.equal(f.sends[0].args.body.attachments[0].data,'data:image/png;base64,ATTACHMENT_ONLY');assert.equal(f.storage.m.size,0);
 f.sends[0].resolve({data:{ok:true,id:ID2}});await send;assert.match(f.text(f.render()),/Reply received/);
});
