import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderCme,validateCme,safeUrl} from './build-cme.mjs';
import {findGuides,matchesState} from '../public/cme-assets/cme.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFile(resolve(root,path),'utf8');
const content=JSON.parse(await read('public/knowledge/credentialdo-cme.json'));
const states=JSON.parse(await read('landing/states/states-data.json'));
const html=await read('landing/cme.html');
const entries=[...content.resources.map(r=>({kind:'resource',title:r.title,summary:r.summary,tags:(r.tags||[]).join(' '),href:`#${r.id}`})),...content.topics.map(r=>({title:r.title,summary:r.summary,href:`#${r.id}`})),...content.faqs.map(r=>({title:r.question,summary:r.answer,tags:r.tags.join(' '),href:`#${r.id}`})),...states.states.map(s=>({title:`${s.name} licensing board and CME guide`,summary:`Open the ${s.name} licensing board and the existing state renewal guide.`,href:`#board-${s.slug}`,abbreviation:s.abbreviation.toLowerCase(),stateName:s.name.toLowerCase(),tags:s.abbreviation}))];

test('published CME page matches sourced content and has unique working navigation targets',async()=>{
 assert.equal(html,renderCme(content,states));
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length);
 for(const [,href]of html.matchAll(/\bhref="([^"]+)"/g)){
  if(href.startsWith('#'))assert.ok(ids.includes(href.slice(1)),href);
  if(href.startsWith('/states/')&&href!='/states/')await access(resolve(root,`landing${href}.html`));
 }
 for(const [,id]of html.matchAll(/href="\/help\/#([^"]+)"/g))assert.ok((await read('landing/help.html')).includes(`id="${id}"`));
 assert.equal((html.match(/class="state-card"/g)||[]).length,51);
 assert.equal((html.match(/class="faq"/g)||[]).length,content.faqs.length);
});
test('every statement group has real source references and source review scope',()=>{
 validateCme(content,states);
 const missing=structuredClone(content);missing.topics[0].sourceIds=['made-up'];
 assert.throws(()=>validateCme(missing,states),/Missing source/);
 assert.match(content.reviewScope,/not been verified/);
 for(const state of states.states)assert.ok(html.includes(`Guide review: ${state.verified}`));
 assert.match(html,/50 states \+ Washington, DC/);
 assert.match(html,/MD licensing/);assert.match(html,/DO licensing/);
 assert.doesNotMatch(html,/DO osteopathic board/);
});
test('reserved controls, generated board IDs and duplicate records cannot break browser controls',()=>{
 for(const id of ['vera-query','vera-form','board-ohio','state-status']){
  const bad=structuredClone(content);bad.topics[0].id=id;assert.throws(()=>validateCme(bad,states),/duplicate/);
 }
 const duplicate=structuredClone(states);duplicate.states[1].slug=duplicate.states[0].slug;
 assert.throws(()=>validateCme(content,duplicate),/Duplicate state/);
 const source=structuredClone(content);source.sources[1].id=source.sources[0].id;
 assert.throws(()=>validateCme(source,states),/duplicate/);
});
test('CME prose is escaped and executable or credential-bearing source URLs are rejected',()=>{
 const bad=structuredClone(content);bad.faqs[0].question='<img src=x onerror=alert(1)>';bad.topics[0].summary='</script><script>alert(1)</script>';
 const rendered=renderCme(bad,states);assert.doesNotMatch(rendered,/<img src=x|<script>alert/);assert.match(rendered,/&lt;img/);
 for(const url of ['javascript:alert(1)','data:text/html,test','http://example.com','https://user:secret@example.com'])assert.throws(()=>safeUrl(url));
});
test('free-course searches return sourced no-charge options and not blanket paid-directory recommendations',()=>{
 const results=findGuides(entries,'free');
 assert.ok(results.some(r=>r.href==='#free-cme'));assert.ok(results.some(r=>r.href==='#cdc-train'));assert.ok(results.some(r=>r.href==='#pcss-moud'));
 assert.ok(!results.some(r=>['#ama-ed-hub','#aoa-cme'].includes(r.href)));
});
test('state abbreviations, osteopathic intent and uncertain questions lead to guides instead of conclusions',()=>{
 for(const code of ['IN','ME','OR','CA'])assert.equal(findGuides(entries,code)[0]?.abbreviation,code.toLowerCase());
 assert.equal(findGuides(entries,'How many hours do I need in Ohio?')[0].href,'#board-ohio');
 assert.ok(findGuides(entries,'DO').some(r=>['#aoa-cme','#md-do-equivalence','#credit-types'].includes(r.href)));
 assert.equal(findGuides(entries,'MOC points')[0].href,'#moc-versus-cme');
 assert.deepEqual(findGuides(entries,'zzzxxyyyunknown'),[]);
 assert.equal(findGuides(entries,'my password was stolen')[0].href,'/help/#get-help');
 assert.deepEqual(findGuides(entries,'was this on my unknownthing'),[]);
 assert.deepEqual(findGuides(entries,'  '),[]);
});
test('state search handles exact abbreviations and multiword names without unrelated substring matches',()=>{
 assert.equal(matchesState('california ca','ca','CA',true),true);
 assert.equal(matchesState('north carolina nc','nc','CA',true),false);
 assert.equal(matchesState('new york ny','ny','new york',false),true);
 assert.equal(matchesState('ohio oh','oh','not a state',false),false);
});
test('public guide has no chat backend, persistence, inline script or external connection permission',async()=>{
 const runtime=await read('public/cme-assets/cme.mjs');
 assert.doesNotMatch(runtime,/\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|innerHTML|apiKey|aiClient/);
 assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);
 assert.doesNotMatch(html,/<script(?![^>]*src=)[^>]*>/);
 assert.ok(html.includes('<noscript>'));assert.ok(html.includes('Website navigation'));
 assert.match(html,/Product tutorials do not award CME credit/);
});
