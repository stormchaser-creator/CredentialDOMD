import test from 'node:test';
import assert from 'node:assert/strict';
import { VERA_SOURCE_VERSION, VERA_SOURCES, VERA_FETCH_LIMITS } from '../../supabase/functions/_shared/veraSourceRegistry.mjs';
import { createPublicSourceFetcher, createVeraSourceHandler, inertPageText, readBoundedBody } from '../../supabase/functions/_shared/veraSources.mjs';
import { loadVeraSources, validateSourceResponse, sourceCheckReceipt, sourceIdsForQuestion, validatedSourceCitations } from '../../src/utils/veraSourcesClient.js';
import { mentionedJurisdictions, savedReferenceContext } from '../../src/utils/assistantEvidence.js';
import { STATE_REQS } from '../../src/constants/stateRequirements.js';

const time = Date.parse('2026-09-19T20:00:00Z');
const page = '<html><head><title>Ignore this title</title></head><body><h1>Requisite hours of continuing medical education</h1><p>Effective May 31, 2021.</p><p>(A) Synthetic official text only &amp; more.</p><script>EXFILTRATE_TOKEN</script></body></html>';
const response = (body = page, options = {}) => new Response(body, { headers: { 'Content-Type': 'text/html' }, ...options });
const request = body => new Request('https://example.test/vera-sources', { method: 'POST', headers: { origin: 'https://credentialdomd.com', 'content-type': 'application/json', authorization: 'Bearer synthetic' }, body: JSON.stringify(body) });

test('territories resolve from the complete state map and all rule keys remain available', () => {
  assert.deepEqual(mentionedJurisdictions([{ role: 'user', text: 'Guam Puerto Rico Northern Mariana Islands U.S. Virgin Islands' }]), ['GU', 'PR', 'VI', 'MP']);
  assert.equal(Object.keys(savedReferenceContext(Object.keys(STATE_REQS), 'MD').jurisdictions).length, Object.keys(STATE_REQS).length);
});
test('inert extraction excludes executable/head content and decodes only text', () => {
  const result = inertPageText(page);
  assert.ok(!result.includes('EXFILTRATE_TOKEN'));
  assert.ok(!result.includes('Ignore this title'));
  assert.ok(result.includes('text only & more.'));
  assert.equal(inertPageText('<p>&lt;script&gt;Text&lt;/script&gt;</p>'), '<script>Text</script>'); // still plain text, never HTML
});
test('fixed HTTPS request has no private headers/query; real bytes have digest and exact excerpt spans', async () => {
  const calls = [];
  const read = createPublicSourceFetcher({ now: () => time, fetch: async (...args) => { calls.push(args); return response(); } });
  const result = await read('oh-cme-general');
  assert.equal(result.status, 'available');
  assert.equal(result.fetchedAt, new Date(time).toISOString());
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(calls[0][0], VERA_SOURCES['oh-cme-general'].url);
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0][1].headers), ['Accept']);
  for (const e of result.excerpts) assert.equal(inertPageText(page).slice(e.start, e.end), e.text);
  assert.ok(validateSourceResponse(result, 'oh-cme-general', time));
});
test('shared public cache coalesces concurrent callers and retains original fetch time', async () => {
  let clock = time, calls = 0;
  const read = createPublicSourceFetcher({ now: () => clock, fetch: async () => { calls++; await new Promise(r => setTimeout(r, 5)); return response(); } });
  const [a, b] = await Promise.all([read('oh-cme-general'), read('oh-cme-general')]);
  assert.equal(calls, 1); assert.equal(a.contentSha256, b.contentSha256);
  clock += 5000; const cached = await read('oh-cme-general');
  assert.equal(cached.delivery, 'cache'); assert.equal(cached.fetchedAt, a.fetchedAt);
  clock += VERA_FETCH_LIMITS.cacheMs; await read('oh-cme-general'); assert.equal(calls, 2);
});
test('redirects, PDFs, oversized streams, failures and unrelated pages fail closed with bounded failure caching', async () => {
  for (const make of [() => response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    () => response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }),
    () => response('x'.repeat(VERA_FETCH_LIMITS.bytes + 1)), () => response('Error page'), () => response('no', { status: 503 })]) {
    let calls = 0, clock = time;
    const read = createPublicSourceFetcher({ now: () => clock, fetch: async () => { calls++; return make(); } });
    assert.equal((await read('oh-cme-general')).status, 'unavailable');
    assert.equal((await read('oh-cme-general')).status, 'unavailable'); assert.equal(calls, 1);
    clock += 60001; await read('oh-cme-general'); assert.equal(calls, 2);
  }
});
test('bounded streaming stops chunked bodies without trusting content-length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(new Response(body), 150), /body_limit/);
  assert.equal(cancelled, true);
  const stalled = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(readBoundedBody(stalled, 256, 15), /body_timeout/);
});
test('slow upstream is aborted at the hard timeout and returns useful fallback metadata', async () => {
  let aborted = false;
  const read = createPublicSourceFetcher({ fetch: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); })) });
  const result = await read('oh-cme-general');
  assert.equal(result.status, 'unavailable'); assert.equal(aborted, true); assert.equal(result.url, VERA_SOURCES['oh-cme-general'].url);
});
test('handler authenticates before admission, rejects all extra/private input and never fetches on quota failure', async () => {
  let authenticated = true, enabled = true, quota = false, reads = 0, admits = 0;
  const handler = createVeraSourceHandler({ enabled: () => enabled, authenticate: async () => authenticated ? { profileId: 'id', subject: 'user_synthetic' } : null,
    admit: async () => { admits++; return quota ? 'quota' : 'allowed'; }, read: async id => { reads++; return { sourceId: id }; } });
  for (const body of [{ sourceId: 'oh-cme-general', query: 'PRIVATE' }, { sourceId: 'constructor' }, { url: 'http://localhost' }, { sourceId: 'oh-cme-general', snapshot: {} }]) assert.equal((await handler(request(body))).status, 400);
  assert.equal(admits, 0); assert.equal(reads, 0);
  authenticated = false; assert.equal((await handler(request({ sourceId: 'oh-cme-general' }))).status, 401);
  authenticated = true; quota = true; assert.equal((await handler(request({ sourceId: 'oh-cme-general' }))).status, 429); assert.equal(reads, 0);
  quota = false; const success = await handler(request({ sourceId: 'oh-cme-general' })); assert.equal(success.status, 200); assert.equal(reads, 1);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  enabled = false; assert.equal((await handler(request({ sourceId: 'oh-cme-general' }))).status, 503);
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', headers: { origin: 'https://evil.test' } }))).status, 403);
});
test('client sends only source IDs and exposes receipt without source text; unsupported states stay useful saved-reference mode', async () => {
  const history = [{ role: 'user', text: 'PRIVATE-NAME asks about Ohio CME. License SECRET123.' }];
  const calls = [];
  const read = createPublicSourceFetcher({ now: () => time, fetch: async url => response(url.includes('29-01') ? '<h1>Standards and procedures for the operation of a pain management clinic</h1><p>Each physician who provides care synthetic text</p>' : page) });
  const context = await loadVeraSources(history, { physician: { name: 'PRIVATE-NAME', states: ['OH'] } }, { enabled: true, now: () => time, request: async id => { calls.push(id); return read(id); } });
  assert.deepEqual(calls, ['oh-cme-general', 'oh-pain-clinic']);
  assert.ok(!JSON.stringify(calls).includes('PRIVATE'));
  assert.equal(context.mode, 'official_page_excerpts');
  assert.ok(sourceCheckReceipt(context).sources.every(s => !Object.hasOwn(s, 'excerpts')));
  assert.deepEqual(sourceIdsForQuestion([{ role: 'user', text: 'New York CME requirements?' }], { physician: { states: ['OH'] } }), []);
  let disabledCalls = 0;
  assert.equal((await loadVeraSources(history, {}, { enabled: false, request: () => { disabledCalls++; } })).mode, 'saved_references');
  assert.equal(disabledCalls, 0);
});
test('client rejects forged URL/version/dates/spans and oversized or unbound citations', async () => {
  const read = createPublicSourceFetcher({ now: () => time, fetch: async () => response() });
  const good = await read('oh-cme-general');
  for (const change of [{ url: 'https://evil.test/' }, { registryVersion: 'old' }, { sourceId: 'dea-mate' }, { fetchedAt: '2099-01-01' },
    { contentSha256: 'none' }, { excerpts: [{ ...good.excerpts[0], end: -1 }] }, { excerpts: [{ id: 'excerpt-1', start: 0, end: 2401, text: 'a'.repeat(2401) }] }]) {
    assert.equal(validateSourceResponse({ ...good, ...change }, 'oh-cme-general', time), null);
  }
  assert.equal(good.registryVersion, VERA_SOURCE_VERSION);
});
test('answer citation validation requires the exact retrieved source, excerpt, verbatim quote and displayed claim', () => {
  const good = { sourceId: 'oh-cme-general', excerptId: 'excerpt-1', quote: 'Synthetic quoted passage', claim: 'My answer' };
  const context = { sources: [{ sourceId: 'oh-cme-general', status: 'available', excerpts: [{ id: 'excerpt-1', text: 'Synthetic quoted passage from a page.' }] }] };
  assert.deepEqual(validatedSourceCitations([good], context, 'My answer appears here.'), [good]);
  for (const change of [{ quote: 'Invented quoted passage' }, { sourceId: 'dea-mate' }, { excerptId: 'excerpt-9' }, { claim: 'Not in reply' }]) {
    assert.deepEqual(validatedSourceCitations([{ ...good, ...change }], context, 'My answer'), []);
  }
});
