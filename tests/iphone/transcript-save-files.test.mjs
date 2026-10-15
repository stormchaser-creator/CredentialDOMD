// Actual native controls: title/text add an unnamed text item, and a repeat
// Save to Files fails after partially saving the PDF. Explicit Save PDF must
// carry only the intended files; ordinary email sharing keeps its message.
import '../helpers/app-rules.mjs';
import {sharedRuleResolver} from '../helpers/shared-rule-resolver.mjs';
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../..',import.meta.url));
mock.timers.enable({apis:['Date'],now:new Date(2026,9,14,12).getTime()});
const plugins=process.env.TRANSCRIPT_SOURCE?[{name:'original-transcript-negative',setup(b){b.onLoad({filter:/\/cmeTranscriptPdf\.js$/},()=>({contents:readFileSync(process.env.TRANSCRIPT_SOURCE,'utf8'),loader:'js'}));}},sharedRuleResolver]:[sharedRuleResolver];
const bundle=await build({entryPoints:[`${root}src/utils/cmeTranscriptPdf.js`],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',define:{'import.meta.env':'{}'},plugins});
const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports);const T=mod.exports;
const data=()=>({settings:{name:'Synthetic Nursing QA',degreeType:'NP',primaryState:'AL'},licenses:[],cme:[{id:'ce1',date:'2026-10-13',hours:2.5,category:'Accredited Nursing CE',title:'Synthetic native CE',provider:'Synthetic QA Provider',pharmacologyHours:1}],documents:[]});
async function capture(model,options={}){const old=Object.getOwnPropertyDescriptor(globalThis,'navigator');let payload;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Mozilla/5.0 (iPhone)',canShare:()=>true,share:async p=>{payload=p;}}});try{const result=await T.shareTranscriptPdf(model,{onHanded(){},...options});return {payload,result};}finally{if(old)Object.defineProperty(globalThis,'navigator',old);else delete globalThis.navigator;}}
async function pdfText(blob) {
  const {inflateSync}=await import('node:zlib');
  const raw=Buffer.from(await blob.arrayBuffer()), streams=[];
  for(let at=0;;){const start=raw.indexOf('stream\n',at);if(start<0)break;const end=raw.indexOf('\nendstream',start);assert.ok(end>=0);const bytes=raw.subarray(start+7,end);try{streams.push(inflateSync(bytes).toString('latin1'));}catch{streams.push(bytes.toString('latin1'));}at=end+10;}
  return streams.join(' ');
}
test('explicit file saving carries the actual nursing PDF without an unnamed title/text file',async()=>{const model=T.stateTranscriptModel(data(),'AL',{kind:'aprn'});assert.equal(model.error,undefined);const {payload,result}=await capture(model,{filesOnly:true});assert.deepEqual(Object.keys(payload),['files']);assert.equal(payload.files.length,1);assert.equal(payload.files[0].type,'application/pdf');const bytes=Buffer.from(await payload.files[0].arrayBuffer());assert.match(bytes.toString('latin1'),/^%PDF-/);assert.match(await pdfText(payload.files[0]),/Synthetic native CE/);assert.equal(result.method,'share');assert.equal(result.model.rows.length,1);assert.equal(result.model.rows[0].entry.hours,2.5);});
test('ordinary transcript sharing still includes the formatted sender message and exact PDF name',async()=>{const model=T.stateTranscriptModel(data(),'AL',{kind:'aprn'});const before=model.fileName;const {payload}=await capture(model);assert.ok(payload.title);assert.match(payload.text,/Synthetic Nursing QA/);assert.equal(payload.files[0].name,before);assert.equal(model.fileName,before);});

// Drive the real screen handlers as well as the file builder: action choice,
// timestamped save filename, clearing the picker and returning to normal share.
const {loadScreens,mount,nodes,textOf}=await import('../harness/component-harness.mjs');
const screens=await loadScreens('export {default as CMESection} from "./src/components/features/CMESection.jsx";');
test('the actual transcript picker offers a distinct Save PDF action and restores message sharing on reopen',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');const payloads=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:async p=>{payloads.push(p);}}});
  globalThis.document ??= {addEventListener(){},removeEventListener(){},querySelector:()=>null,activeElement:null,body:{style:{}}};
  try{
    const m=mount(screens.CMESection,{data:data()});Object.assign(globalThis.__screen.app,{allTrackedStates:['AL']});Object.assign(globalThis.window,{addEventListener(){},removeEventListener(){}});
    const tree=()=>{m.render();return m.render();};
    const tap=async label=>{const b=nodes(tree()).find(n=>n.type==='button'&&textOf(n).trim()===label);assert.ok(b,`Missing visible action ${label}`);assert.notEqual(b.props.disabled,true);await b.props.onClick();tree();};
    const modal=()=>nodes(tree()).find(n=>typeof n.type==='function'&&n.props?.title==='Transcript PDF');
    await tap('Transcript PDF');assert.equal(modal().props.open,true);await tap('Save PDF');
    const save=nodes(tree()).find(n=>n.type==='button'&&textOf(n).trim()==='Save PDF');assert.equal(save.props['aria-pressed'],true);
    const choose=async()=>{const b=nodes(tree()).find(n=>n.type==='button'&&/Alabama APRN/.test(textOf(n)));assert.ok(b);await b.props.onClick();tree();};
    await choose();assert.equal(modal().props.open,false);assert.deepEqual(Object.keys(payloads[0]),['files']);assert.match(payloads[0].files[0].name,/2026-10-14T.*\.pdf$/);assert.equal(payloads[0].files[0].type,'application/pdf');assert.equal(m.calls.length,0,'export never modifies the saved CE record');
    assert.match(textOf(tree()),/File saving requested\. Confirm the save in the device dialog\./);
    await tap('Transcript PDF');const sharing=nodes(tree()).find(n=>n.type==='button'&&textOf(n).trim()==='Share with message');assert.equal(sharing.props['aria-pressed'],true);await choose();assert.ok(payloads[1].text);assert.ok(payloads[1].title);assert.notEqual(payloads[1].files[0].name,payloads[0].files[0].name);assert.equal(m.data.cme[0].title,'Synthetic native CE');
  }finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;}
});
