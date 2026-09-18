import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {loadVideoCatalog,validateVideoCatalog,copyVideoAssets,VIDEO_FILES} from './help-videos.mjs';
import {renderHelp} from './build-help.mjs';
import {packageSite} from './package-site.mjs';
const help=JSON.parse(await readFile(new URL('../public/knowledge/credentialdo-help.json',import.meta.url),'utf8'));
const bytes={video:Buffer.from('synthetic MP4 fixture; never published'),poster:Buffer.from('synthetic poster fixture; never published'),captions:Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic demo\n'),transcript:Buffer.from('Synthetic tutorial transcript.\n')};
const sha=data=>createHash('sha256').update(data).digest('hex');
function entry(id='first-license') {return {id,title:'First license',transcriptText:bytes.transcript.toString('utf8'),status:'approved_for_publication',durationSeconds:50,width:1920,height:1080,demoLabel:true,burnedCaptions:true,sourceRevision:'2c28f87a',review:{visual:true,playback:true,videoSHA256:sha(bytes.video),reviewedAt:'2026-09-18T23:00:00Z',reviewedBy:'synthetic test only'},files:Object.fromEntries(Object.entries(VIDEO_FILES).map(([kind,file])=>[kind,{file:`${id}/${file}`,sha256:sha(bytes[kind])}]))};}
function catalog(ids=['first-license']) {return {schemaVersion:1,status:'approved_for_publication',tutorials:ids.map(entry)};}
async function fixture(t,metadata=catalog()) {
 const root=await mkdtemp(resolve(tmpdir(),'credentialdo-help-video-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=resolve(root,'landing/help-videos');await mkdir(directory,{recursive:true});
 for(const item of metadata.tutorials){await mkdir(resolve(directory,item.id));for(const [kind,file]of Object.entries(item.files))await writeFile(resolve(directory,file.file),bytes[kind]);}
 await writeFile(resolve(directory,'manifest.json'),JSON.stringify(metadata));return root;
}
test('an absent catalog keeps all written guides without advertising a player',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'credentialdo-no-videos-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.equal(await loadVideoCatalog(root),null);
 const html=renderHelp(help);assert.doesNotMatch(html,/<video\b/);assert.match(html,/id="share-references"/);assert.match(html,/id="share-documents"/);assert.match(html,/Videos are not available yet/);
});
test('drafts, incomplete QA, unknown paths and unexpected assets are rejected',()=>{
 for(const mutate of [c=>{c.status='draft';},c=>{c.tutorials[0].status='draft_awaiting_visual_and_playback_qa';},c=>{c.tutorials[0].review.playback=false;},c=>{delete c.tutorials[0].review;},c=>{c.tutorials[0].files.video.file='../secret.mp4';},c=>{c.tutorials[0].files.private={file:'private.txt',sha256:'a'.repeat(64)};},c=>{c.tutorials.push(entry());},c=>{c.tutorials[0].durationSeconds=120;}]) {const c=catalog();mutate(c);assert.throws(()=>validateVideoCatalog(c));}
});
test('every asset hash is verified, including captions and transcript',async t=>{
 for(const kind of Object.keys(VIDEO_FILES)){const root=await fixture(t);await writeFile(resolve(root,'landing/help-videos/first-license',VIDEO_FILES[kind]),'changed since review');await assert.rejects(loadVideoCatalog(root),/hash mismatch/);}
});
test('asset symlinks and missing files cannot be published',async t=>{
 const root=await fixture(t),file=resolve(root,'landing/help-videos/first-license/tutorial.mp4');await rm(file);await assert.rejects(loadVideoCatalog(root),{code:'ENOENT'});
 await writeFile(resolve(root,'unreviewed.mp4'),bytes.video);await symlink(resolve(root,'unreviewed.mp4'),file);await assert.rejects(loadVideoCatalog(root),/regular file/);
});
test('only approved canonical files copy to public help, outside app assets',async t=>{
 const root=await fixture(t),output=resolve(root,'packaged');const metadata=await loadVideoCatalog(root);
 await writeFile(resolve(root,'landing/help-videos/first-license/private-review.txt'),'not public');await copyVideoAssets(root,output,metadata);
 for(const [kind,file]of Object.entries(VIDEO_FILES))assert.deepEqual(await readFile(resolve(output,'help/videos/first-license',file)),bytes[kind]);
 for(const path of ['app','help/videos/manifest.json','help/videos/first-license/private-review.txt'])await assert.rejects(access(resolve(output,path)),{code:'ENOENT'});
});
test('reviewed players have controls, captions, transcript and no automatic playback',()=>{
 const c=catalog(['first-license','share-references','share-documents']);const html=renderHelp(help,c);
 assert.equal((html.match(/<video\b/g)||[]).length,3);assert.equal((html.match(/<track kind="captions"/g)||[]).length,3);
 for(const item of c.tutorials){assert.ok(html.includes(`id="${item.id}"`));for(const file of Object.values(VIDEO_FILES))assert.ok(html.includes(`/help/videos/${item.id}/${file}`));}
 assert.match(html,/controls playsinline preload="none"/);assert.doesNotMatch(html,/\bautoplay\b|<iframe\b|Videos are not available yet/);assert.match(html,/Ask Vera to prepare a draft/);assert.match(html,/coordinator|reserved example.com/);
 assert.match(html,/video.pause\(\)/);assert.match(html,/video-note-first-license/);
});
test('video titles are escaped and cannot inject page markup',()=>{
 const c=catalog();c.tutorials[0].title='"><img src=x onerror=alert(1)>';
 const html=renderHelp(help,c);assert.ok(html.includes('&quot;&gt;&lt;img'));assert.doesNotMatch(html,/<img src=x/);
});

test('packaging refuses modified video bytes or stale advertised players before deleting previous output',async t=>{
 const root=await fixture(t);
 for(const path of ['dist','scripts','public/knowledge','site-dist'])await mkdir(resolve(root,path),{recursive:true});
 await writeFile(resolve(root,'dist/index.html'),'<script src="/app/assets/test.js"></script>');
 for(const page of ['index','locums','security','privacy','terms','help','credential-access'])await writeFile(resolve(root,`landing/${page}.html`),'synthetic');
 await writeFile(resolve(root,'scripts/root-sw-retirement.js'),'synthetic');
 await writeFile(resolve(root,'public/knowledge/credentialdo-help.json'),JSON.stringify(help));
 await writeFile(resolve(root,'site-dist/keep.txt'),'previous package');
 await writeFile(resolve(root,'landing/help-videos/first-license/tutorial.mp4'),'changed');
 await assert.rejects(packageSite(root),/hash mismatch/);
 assert.equal(await readFile(resolve(root,'site-dist/keep.txt'),'utf8'),'previous package');
 await writeFile(resolve(root,'landing/help-videos/first-license/tutorial.mp4'),bytes.video);
 await assert.rejects(packageSite(root),/Help page is stale/);
 assert.equal(await readFile(resolve(root,'site-dist/keep.txt'),'utf8'),'previous package');
});

test('actual help search excludes video boilerplate and pauses the hidden license player',()=>{
 const html=renderHelp(help,catalog(help.articles.map(a=>a.id)));
 const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[entity]));
 const guides=[...html.matchAll(/<article id="([^"]+)" data-guide data-category="([^"]+)" data-search="([^"]*)">([\s\S]*?)<\/article>/g)].map(([,id,category,index,body])=>{
  const details={open:false,addEventListener(){}},video={pauses:0,pause(){this.pauses++;}};
  return {id,hidden:false,dataset:{category:decode(category),search:decode(index)},textContent:decode(body.replace(/<[^>]*>/g,' ')),details,video,querySelector:selector=>selector==='details'?details:selector==='video'?video:null,scrollIntoView(){}};
 });
 assert.equal(guides.length,14);
 const first=guides.find(g=>g.id==='first-license');assert.match(first.textContent,/no live messages or payments/);
 const handlers={},input={value:'',addEventListener:(name,callback)=>{handlers[name]=callback;}};
 const elements={'help-search':input,'result-count':{textContent:''},'no-results':{hidden:true},'search-tools':{hidden:true}};
 const document={querySelectorAll:selector=>selector==='[data-guide]'?guides:selector==='[data-filter]'?[]:guides.map(g=>g.video),getElementById:id=>elements[id],addEventListener(){}};
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 vm.runInNewContext(script,{document,window:{addEventListener(){}},location:{hash:''}});
 input.value='payment';handlers.input();
 assert.equal(first.hidden,true);assert.equal(first.details.open,false);assert.equal(first.video.pauses,1);
 assert.equal(guides.find(g=>g.id==='locum-payment').hidden,false);assert.ok(guides.filter(g=>!g.hidden).length<14);
 input.value='license   expiration';handlers.input();
 assert.equal(first.hidden,false,'authored multiword queries split on whitespace');assert.equal(first.details.open,true);
 input.value='watch the walkthrough';handlers.input();assert.equal(guides.filter(g=>!g.hidden).length,0,'shared player headings are not indexed');
});

test('changing a video hash cannot retain approval for the old encoded file',()=>{
 const c=catalog();c.tutorials[0].files.video.sha256=sha(Buffer.from('new encoding requiring fresh playback review'));
 assert.throws(()=>validateVideoCatalog(c),/Playback review does not match video bytes/);
});


test('inline transcript comes from exact verified file bytes, overriding catalog text',async t=>{
 const c=catalog();c.tutorials[0].transcriptText='Unverified catalog wording';
 const root=await fixture(t,c),loaded=await loadVideoCatalog(root);
 assert.equal(loaded.tutorials[0].transcriptText,bytes.transcript.toString('utf8'));
 const html=renderHelp(help,loaded);
 assert.ok(html.includes('<details class="video-transcript"><summary>Read the transcript</summary><div class="transcript-text">Synthetic tutorial transcript.\n</div></details>'));
 assert.doesNotMatch(html,/Unverified catalog wording/);
 assert.match(html,/<a href="\/help\/videos\/first-license\/transcript.txt" download>Download transcript<\/a>/);
 assert.equal(JSON.parse(await readFile(resolve(root,'landing/help-videos/manifest.json'),'utf8')).tutorials[0].transcriptText,'Unverified catalog wording','loading does not rewrite approval metadata');
});

test('verified transcript markup renders as literal text without fetching or injection',async t=>{
 const text='  Exact opening whitespace\n</div><script>alert("x")</script>\n<img src=x onerror=alert(1)> & \'quoted\'\n';
 const c=catalog();c.tutorials[0].files.transcript.sha256=sha(Buffer.from(text));
 const root=await fixture(t,c);
 await writeFile(resolve(root,'landing/help-videos/first-license/transcript.txt'),text);
 const loaded=await loadVideoCatalog(root),html=renderHelp(help,loaded);
 assert.equal(loaded.tutorials[0].transcriptText,text);
 assert.ok(html.includes('<div class="transcript-text">  Exact opening whitespace\n&lt;/div&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quoted&#39;\n</div>'));
 assert.doesNotMatch(html,/<script>alert|<img src=x|fetch\(/);
 const unloaded=catalog();delete unloaded.tutorials[0].transcriptText;
 assert.throws(()=>renderHelp(help,unloaded),/Missing loaded transcript/);
});

test('nested transcript toggles preserve the outer guide and do not pause its player',()=>{
 const html=renderHelp(help,catalog()),handlers={};
 const details={open:true,addEventListener:(name,handler)=>{handlers[name]=handler;}},transcript={open:false};
 const video={pauses:0,pause(){this.pauses++;}};
 const guide={id:'first-license',dataset:{search:'license',category:'Getting started'},querySelector:selector=>selector==='details'?details:selector==='video'?video:null};
 const input={value:'',addEventListener(){}};
 const elements={'help-search':input,'result-count':{},'no-results':{},'search-tools':{}};
 const document={querySelectorAll:selector=>selector==='[data-guide]'?[guide]:[],getElementById:id=>elements[id],addEventListener(){}};
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document,window:{addEventListener(){}},location:{hash:''}});
 for(const open of [true,false]){transcript.open=open;handlers.toggle({target:transcript,currentTarget:details});assert.equal(video.pauses,0);assert.equal(details.open,true);}
 handlers.toggle({target:details,currentTarget:details});assert.equal(video.pauses,0);
 details.open=false;handlers.toggle({target:details,currentTarget:details});assert.equal(video.pauses,1);
});
