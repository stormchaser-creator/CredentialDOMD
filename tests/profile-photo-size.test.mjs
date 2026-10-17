import test from 'node:test';
import assert from 'node:assert/strict';
import { downscalePhoto } from '../src/utils/helpers.js';
function imageEnvironment(t, encode, { context = true } = {}) {
 const previous={Image:globalThis.Image,document:globalThis.document};
 const canvas={width:0,height:0,getContext:()=>context?{drawImage(){}}:null,toDataURL(type,quality){return encode(this,quality);}};
 globalThis.Image=class {width=700;height=700;set src(value){this.input=value;queueMicrotask(()=>this.onload());}};
 globalThis.document={createElement:()=>canvas};
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 return canvas;
}
test('a browser encoding above the profile budget is recompressed before resolving',async t=>{
 let calls=0;imageEnvironment(t,(_canvas,quality)=>{calls++;return 'data:image/jpeg;base64,'+'x'.repeat(quality>0.8?345000:220000);});
 const photo=await downscalePhoto('data:image/png;base64,synthetic');
 assert.ok(photo.length<300000);assert.ok(calls>1);
});
test('an already small avatar keeps its first encoding and dimensions',async t=>{
 let calls=0;const canvas=imageEnvironment(t,()=>{calls++;return 'data:image/jpeg;base64,small';});
 assert.equal(await downscalePhoto('synthetic'),'data:image/jpeg;base64,small');assert.equal(calls,1);assert.equal(canvas.width,512);assert.equal(canvas.height,512);
});
test('a codec ignoring quality is bounded by reducing avatar dimensions',async t=>{
 const canvas=imageEnvironment(t,c=>'data:image/jpeg;base64,'+'x'.repeat(c.width*c.height*2));
 const photo=await downscalePhoto('synthetic');assert.ok(photo.length<300000);assert.ok(canvas.width>0&&canvas.width<512);assert.equal(canvas.width,canvas.height);
});
test('an unavailable canvas rejects instead of leaving the photo save pending',async t=>{
 imageEnvironment(t,()=>'',{context:false});await assert.rejects(downscalePhoto('synthetic'),/could not be resized/);
});
