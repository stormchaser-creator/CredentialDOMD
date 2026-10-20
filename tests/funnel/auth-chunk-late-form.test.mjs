import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({entryPoints:[`${root}src/components/pages/AuthPage.jsx`],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],define:{'import.meta.env':JSON.stringify({VITE_CLERK_PUBLISHABLE_KEY:'pk_live_synthetic'})},plugins:[{name:'auth-effects-fixture',setup(b){
 b.onResolve({filter:/^@clerk\/clerk-react$|useOneTapEmailCode|visitBeacon|authOffer/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.includes('clerk-react')?'import React from "react";export const SignIn=()=>React.createElement("div",{"data-clerk-widget":""});export const useClerk=()=>null;export const useSignIn=()=>({isLoaded:false,signIn:null});export const useSignUp=()=>({isLoaded:false,signUp:null});':path.includes('useOneTapEmailCode')?'export const useOneTapEmailCode=()=>{};':path.includes('visitBeacon')?'export const sendAuthVisit=()=>{};':'export const loadAuthOffer=async()=>null;',loader:'jsx',resolveDir:root}));
}}]});
function fixture(initialFields=false){
 const saved={window:globalThis.window,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,MutationObserver:globalThis.MutationObserver};
 const listeners=new Map(),timers=new Map(),effects=[],cleanups=[],states=[],refs=[],writes=[];let fieldShown=initialFields,next=0,si=0,ri=0;
 const element={querySelector:()=>fieldShown?{value:'synthetic entered text'}:null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};globalThis.MutationObserver=class{observe(){}disconnect(){}};
 globalThis.window={location:{hash:'',pathname:'/app/'},innerWidth:393,history:{replaceState(){}},addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:(n)=>listeners.delete(n)};
 globalThis.setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
 const react={...React,useEffect:fn=>effects.push(fn),useRef:initial=>{const i=ri++;return refs[i]??=(i===0?{current:element}:{current:initial});},useState:initial=>{const i=si++;states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;writes.push({index:i,value:states[i]});}];}};
 const mod={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(name=>name==='react'?react:require(name),mod,mod.exports);
 renderToStaticMarkup(React.createElement(mod.exports.default));for(const fx of effects){const cleanup=fx();if(typeof cleanup==='function')cleanups.push(cleanup);}
 writes.length=0;return{writes,states,timers,showFields(){fieldShown=true;},fail(){listeners.get('unhandledrejection')({reason:Error('Loading chunk 1192 failed.')});},fireRetry(){for(const[id,t]of[...timers])if(t.ms===1200){timers.delete(id);t.fn();}},close(){for(const cleanup of cleanups)cleanup();for(const[k,v]of Object.entries(saved)){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}};
}
test('actual AuthPage does not remount when a field appears during the retry delay',()=>{const f=fixture();try{f.fail();f.showFields();f.fireRetry();assert.equal(f.writes.filter(x=>x.index===0).length,0,'a late-visible form must retain its widget and entered text');assert.equal(f.states[2],true,'show an explicit recovery notice');}finally{f.close();}});
test('actual AuthPage cancels the planned remount when another chunk fails first',()=>{const f=fixture();try{f.fail();f.fail();f.fireRetry();assert.equal(f.writes.filter(x=>x.index===0).length,0);assert.equal(f.states[2],true);}finally{f.close();}});
test('actual AuthPage still retries once when no form field has appeared',()=>{const f=fixture();try{f.fail();f.fireRetry();assert.equal(f.writes.filter(x=>x.index===0).length,1);assert.equal(f.states[0].version,1);}finally{f.close();}});
test('actual AuthPage never schedules remount for an already visible form',()=>{const f=fixture(true);try{f.fail();f.fireRetry();assert.equal(f.writes.filter(x=>x.index===0).length,0);assert.equal(f.states[2],true);}finally{f.close();}});
test('actual AuthPage cleanup cancels pending remount and removes failure listeners',()=>{const f=fixture();f.fail();f.close();assert.equal([...f.timers.values()].filter(t=>t.ms===1200).length,0);assert.equal(f.writes.filter(x=>x.index===0).length,0);});
