import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { VERA_SOURCE_VERSION, VERA_SOURCES } from '../../supabase/functions/_shared/veraSourceRegistry.mjs';

const sourceId = 'dea-mate';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const payload = () => ({ schemaVersion: 1, registryVersion: VERA_SOURCE_VERSION, sourceId,
  url: VERA_SOURCES[sourceId].url, verification: 'page_fetch_not_legal_determination',
  status: 'available', fetchedAt: new Date().toISOString(), contentSha256: 'a'.repeat(64),
  delivery: 'network', excerpts: [{ id: 'excerpt-1', start: 0, end: 19, text: 'Synthetic page text' }] });

async function fixture({ getToken = async () => 'synthetic-token', fetcher, clock, parse = JSON.parse } = {}) {
  const calls = [], deadlines = [];
  class Clock extends Date { static now() { return clock.value; } }
  const context = vm.createContext({ Date: clock ? Clock : Date, TextEncoder, TextDecoder, AbortController,
    JSON: { stringify: JSON.stringify, parse },
    // Run the actual nine-second deadline under a shortened timer. No test
    // option in production can increase or disable that deadline.
    setTimeout: (fn, ms) => { deadlines.push(ms); return setTimeout(fn, ms === 9000 ? 40 : ms); }, clearTimeout,
    window: { Clerk: { session: { id: 'synthetic-session', getToken } } },
    fetch: (...args) => { calls.push(args); return fetcher ? fetcher(...args) : Promise.resolve(new Response(JSON.stringify(payload()))); },
  });
  const registry = new vm.SourceTextModule(await readFile(new URL('../../supabase/functions/_shared/veraSourceRegistry.mjs', import.meta.url), 'utf8'), { context });
  const routing = new vm.SyntheticModule(['mentionedJurisdictions'], function () { this.setExport('mentionedJurisdictions', () => []); }, { context });
  const client = new vm.SourceTextModule(await readFile(new URL('../../src/utils/veraSourcesClient.js', import.meta.url), 'utf8'), {
    context, initializeImportMeta(meta) { meta.env = { VITE_VERA_SOURCE_RETRIEVAL_ENABLED: 'true', VITE_SUPABASE_URL: 'https://synthetic.invalid' }; },
  });
  await client.link(name => name.includes('veraSourceRegistry') ? registry : routing);
  await client.evaluate();
  return { calls, deadlines, run: () => client.namespace.loadVeraSources([{ role: 'user', text: 'DEA MATE training requirements' }], {}) };
}
async function boundedResult(run) {
  let timer;
  try {
    return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Client failed to return within the synthetic deadline')), 500); })]);
  } finally { clearTimeout(timer); }
}
function assertFallback(result) {
  assert.equal(result.mode, 'saved_references');
  assert.equal(result.attempted, true);
  assert.equal(result.sources[0].status, 'unavailable');
  assert.equal(result.sources[0].url, VERA_SOURCES[sourceId].url);
}

test('stalled Clerk token acquisition returns saved references without a fetch', async () => {
  const f = await fixture({ getToken: () => new Promise(() => {}) });
  assertFallback(await boundedResult(f.run));
  assert.deepEqual(f.deadlines, [9000]);
  assert.equal(f.calls.length, 0);
});

test('a token resolving after fallback never starts a late or quota-consuming fetch', async () => {
  let resolveToken;
  const f = await fixture({ getToken: () => new Promise(resolve => { resolveToken = resolve; }) });
  assertFallback(await boundedResult(f.run));
  resolveToken('late-synthetic-token');
  await delay(10);
  assert.equal(f.calls.length, 0);
});

test('a stalled transport is aborted under the same deadline', async () => {
  let signal;
  const f = await fixture({ fetcher: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assertFallback(await boundedResult(f.run));
  assert.equal(f.calls.length, 1);
  assert.equal(signal.aborted, true);
});

test('the deadline covers a stalled response body and cancels its reader', async () => {
  let cancelled = false;
  const f = await fixture({ fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"schemaVersion":1,')); },
    cancel() { cancelled = true; },
  })) });
  assertFallback(await boundedResult(f.run));
  assert.equal(cancelled, true);
  assert.equal(f.calls[0][1].signal.aborted, true);
});

test('parsing that crosses the original deadline cannot return available evidence', async () => {
  const clock = { value: Date.now() };
  const f = await fixture({ clock, parse: text => { const value = JSON.parse(text); clock.value += 9001; return value; } });
  assertFallback(await boundedResult(f.run));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].signal.aborted, true);
});

test('a completed request keeps fixed-ID privacy and usable evidence without aborting success', async () => {
  const f = await fixture();
  const result = await boundedResult(f.run);
  assert.equal(result.mode, 'official_page_excerpts');
  assert.equal(result.sources[0].status, 'available');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { sourceId });
  assert.equal(f.calls[0][1].signal.aborted, false);
  assert.equal(f.calls[0][1].redirect, 'error');
  assert.deepEqual(f.deadlines, [9000]);
});
