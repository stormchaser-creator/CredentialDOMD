// Executes the real admin callbacks with synthetic, deliberately reordered I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
const source=await readFile(new URL('../../src/components/pages/AdminDashboard.jsx',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(){
  const hooks=[],cleanups=[],reads=[],attachments=[],replies=[],timers=[];let cursor=0;
  const react={useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return [hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;}];},useRef(initial){const i=cursor++;if(!(i in hooks))hooks[i]={current:initial};return hooks[i];},useEffect(effect){if(!cleanups.length)cleanups.push(effect());}};
  const db={from(){const q={select(){return q;},limit:async()=>({data:[]}),update(){return q;},eq:async()=>({error:null})};return q;},functions:{invoke(name,args){const d=deferred();(name==='ticket-attachment-url'?attachments:replies).push({...d,args});return d.promise;}}};
  const imports={react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props)=>({type,props})},'../../context/AppContext':{useApp:()=>({theme:{},user:{id:'synthetic-owner'},data:{},userIdRef:{current:'owner'}})},'../../lib/supabase':{supabase:db},'../../lib/admin':{isAdminUser:()=>true},'../../utils/adminSupportThread':{loadAdminSupportThread(_client,id){const d=deferred();reads.push({...d,id});return d.promise;}},'../../utils/edgeError':{edgeErrorMessage:async()=> 'Synthetic failure'},'../../utils/ticketAttachments':{attachmentsPayload:()=>({}),linksFor:x=>x||[]}};
  const injected=source.replace('  const [reloadedAt, setReloadedAt] = useState(null);','  const [reloadedAt, setReloadedAt] = useState(null); globalThis.current={openTicketDetail,closeTicketDetail,sendReply,resolveAndArchive,setReply,openTicket,thread,attachmentUrls,replyUrls,ticketMsg,busy}; return null;')+'\nexport {AdminDashboardContent};';
  const module={exports:{}};
  const ctx=vm.createContext({module,exports:module.exports,require:n=>imports[n]||{},console,setTimeout:fn=>timers.push(fn)});
  vm.runInContext(transformSync(injected,{loader:'jsx',format:'cjs',jsx:'automatic'}).code,ctx);
  const render=()=>{cursor=0;module.exports.AdminDashboardContent();return ctx.current;};
  return {render,reads,attachments,replies,timers,unmount:()=>cleanups.forEach(fn=>fn?.())};
}
const ticket=id=>({id,subject:id,context_payload:{attachment_path:'synthetic'}});
const message=id=>({id,body:id});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('opening B discards A late thread and clears the old conversation immediately',async()=>{
  const f=fixture();const a=f.render().openTicketDetail(ticket('A'));const b=f.render().openTicketDetail(ticket('B'));
  assert.equal(f.render().thread.length,0);
  f.reads[1].resolve({data:[message('B')],error:null});await tick();f.attachments[0].resolve({data:{urls:['B-file']}});await b;
  f.reads[0].resolve({data:[message('A')],error:null});await a;
  assert.equal(f.render().thread[0].id,'B');assert.equal(f.attachments.length,1);assert.equal(f.render().attachmentUrls[0],'B-file');
});
test('late screenshots and unmounted reads cannot repopulate another conversation',async()=>{
  const f=fixture();const a=f.render().openTicketDetail(ticket('A'));f.reads[0].resolve({data:[message('A')]});await tick();
  const b=f.render().openTicketDetail(ticket('B'));f.reads[1].resolve({data:[message('B')]});await tick();
  f.attachments[1].resolve({data:{urls:['B-file']}});await b;f.attachments[0].resolve({data:{urls:['A-file']}});await a;
  assert.equal(f.render().attachmentUrls[0],'B-file');
  const c=f.render().openTicketDetail(ticket('C'));f.unmount();f.reads[2].resolve({data:[message('C')]});await c;
  assert.equal(f.render().thread.length,0);assert.equal(f.attachments.length,2);
});
test('reply close timer and delayed reply failure cannot clear or alter a newly opened ticket',async()=>{
  const f=fixture();const a=f.render().openTicketDetail({id:'A'});f.reads[0].resolve({data:[]});await a;
  f.render().setReply('Synthetic reply');const send=f.render().sendReply('resolved');f.replies[0].resolve({data:{}});await tick();f.reads[1].resolve({data:[]});await send;
  assert.equal(f.timers.length,1);
  const b=f.render().openTicketDetail({id:'B'});f.reads[2].resolve({data:[]});await b;f.timers[0]();
  assert.equal(f.render().openTicket.id,'B');
  f.render().setReply('B reply');const sendB=f.render().sendReply();
  const c=f.render().openTicketDetail({id:'C'});f.reads[3].resolve({data:[]});await c;
  f.replies[1].resolve({error:{}});await sendB;
  assert.equal(f.render().openTicket.id,'C');assert.equal(f.render().ticketMsg,'');assert.equal(f.render().busy,false);
});
