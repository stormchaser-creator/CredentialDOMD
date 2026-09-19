import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHelp, validateHelp } from './build-help.mjs';
import { loadVideoCatalog, watchHref } from './help-videos.mjs';
import { STATE_REQS } from '../src/constants/stateRequirements.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(resolve(root, file), 'utf8');
const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
const html = await read('landing/help.html');
const videos = await loadVideoCatalog(root);

test('product knowledge has evidence, bounded use and fourteen complete journeys', async () => {
  validateHelp(help);
  assert.equal(help.articles.length, 14);
  for (const article of help.articles) {
    assert.ok(article.steps.length >= 4, article.id);
    for (const ref of article.sourceRefs) await access(resolve(root, ref));
  }
  for (const id of ['scan-license', 'scan-cme', 'import-cme', 'locum-contract', 'locum-work', 'locum-invoice', 'locum-payment', 'get-help','share-references','share-documents']) {
    assert.ok(help.articles.some(article => article.id === id), id);
  }
  assert.match(help.verifiedScope, /not a live delivery check/);
  assert.ok(help.usePolicy.escalate.includes('An ambiguous CME rule or exemption'));
});

test('reviewed content and public page cannot drift', () => {
  assert.equal(html, renderHelp(help, videos));
  for (const article of help.articles) assert.ok(html.includes(`id="${article.id}"`));
  if (videos) {
    assert.equal((html.match(/<video\b/g)||[]).length,videos.tutorials.length);
    assert.doesNotMatch(html,/Videos are not available yet/);
  } else {
    assert.doesNotMatch(html, /<video\b|<iframe\b|\.mp4|\.webm/);
    assert.match(html, /Videos are not available yet/);
  }
});

test('guide validation rejects duplicate IDs, missing evidence and broken relationships', () => {
  const duplicate = structuredClone(help);
  duplicate.articles[1].id = duplicate.articles[0].id;
  assert.throws(() => validateHelp(duplicate), /duplicate/);
  const unreviewed = structuredClone(help);
  unreviewed.articles[0].verifiedScope = '';
  assert.throws(() => validateHelp(unreviewed), /verifiedScope/);
  const unsafePath = structuredClone(help);
  unsafePath.articles[0].sourceRefs = ['src/../../private/key'];
  assert.throws(() => validateHelp(unsafePath), /source reference/);
  const broken = structuredClone(help);
  broken.articles[0].related = ['missing-guide'];
  assert.throws(() => validateHelp(broken), /related guide/);
});

test('product prose renders as text, not executable markup', () => {
  const hostile = structuredClone(help);
  hostile.articles[0].title = '<img src=x onerror="alert(1)">';
  hostile.articles[0].steps[0] = '</script><script>alert(1)</script>';
  const output = renderHelp(hostile);
  assert.ok(output.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(output.includes('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(output, /<img src=x|<script>alert\(1\)/);
});

test('help links have existing destinations and use real app entry instead of fictional routes', async () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const routes = { '/': 'landing/index.html', '/app/': 'index.html', '/cme/': 'landing/cme.html', '/locums': 'landing/locums.html', '/security': 'landing/security.html', '/privacy': 'landing/privacy.html', '/terms': 'landing/terms.html' };
  for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), href);
    else if (href.startsWith('/help/videos/')) {
      assert.ok(videos);
      await access(resolve(root,'landing/help-videos',href.slice('/help/videos/'.length)));
    }
    else if (href.startsWith('/help/')) {
      assert.ok(videos?.tutorials.some(video => watchHref(video.id) === href), href);
    }
    else if (href.startsWith('mailto:')) assert.equal(href, 'mailto:support@credentialdomd.com');
    else { assert.ok(routes[href], href); await access(resolve(root, routes[href])); }
  }
});

test('Ohio app, public page and email guide retain the same conditional source meaning', async () => {
  const data = JSON.parse(await read('landing/states/states-data.json'));
  const ohio = data.states.find(state => state.abbreviation === 'OH');
  const email = JSON.parse(await read('supabase/functions/send-guide/stateGuides.json')).OH;
  const publicPage = await read('landing/states/ohio.html');
  const rule = STATE_REQS.OH.topics.find(topic => topic.topic === 'Pain Management');
  assert.ok(rule.condition?.field);
  assert.match(rule.condition.description, /own or provide care/);
  assert.equal(rule.checkedOn, '2026-09-18');
  for (const guide of [ohio, email]) {
    assert.match(guide.cmeDetails, /Only physicians who own or provide care at a qualifying pain management clinic/);
    assert.match(guide.cmeDetails, /board-approved duty-to-report/);
    assert.match(guide.cmeDetails, /those hours count toward renewal/);
    assert.ok(guide.sources.some(source => source.url === rule.url));
    assert.ok(guide.sources.some(source => source.url === 'https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02'));
    assert.equal(guide.faqs.find(faq => faq.question === 'What CME do I attest to at renewal?').answer, guide.cmeDetails);
  }
  assert.equal(ohio.cmeDetails, email.cmeDetails);
  assert.ok(publicPage.includes(ohio.cmeDetails));
  assert.ok(publicPage.includes(rule.url));
  assert.doesNotMatch(publicPage, /1 hour ethics, 20 hours pain management|additional 20-hour pain medicine/);
  const cmeHelp = help.articles.find(article => article.id === 'review-cme');
  assert.match(cmeHelp.notes.join(' '), /explicit conditional-rule pilot/);
  assert.match(cmeHelp.steps.join(' '), /Not sure/);
});

test('sharing guides are authored once with source evidence and support policy',()=>{
 for(const id of ['share-references','share-documents']){
  const article=help.articles.find(a=>a.id===id);assert.ok(article);
  assert.ok(article.sourceRefs.length>=4);assert.ok(article.usePolicy.allowed.length);assert.ok(article.usePolicy.escalate.length);assert.ok(article.usePolicy.limits.length);
  const changed=structuredClone(help);changed.articles.find(a=>a.id===id).summary='Single-source changed summary '+id;
  assert.ok(renderHelp(changed).includes('Single-source changed summary '+id));
 }
 assert.match(help.articles.find(a=>a.id==='share-references').steps[0],/Ask Vera/);
 assert.match(help.articles.find(a=>a.id==='share-documents').availability,/configured delivery/);
});
