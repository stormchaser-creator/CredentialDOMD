// "Saved references; no live source check." under every Vera reply
// (VERA-012). With retrieval off (production), every turn carried a receipt
// with no sources, so the line sat under "Summarize my unbilled work" and a
// filing confirmation, and the Ohio CME question offered no official page to
// open. A receipt now comes only with a question about an official source,
// and lists those pages as not retrieved. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVeraSources, sourceCheckReceipt } from '../src/utils/veraSourcesClient.js';

const ask = text => [{ role: 'user', text }];

test('a reply no official source is about carries no receipt', async () => {
  for (const q of ['Summarize my unbilled work', "What's expiring in the next 90 days?", 'file this as my diploma']) {
    const context = await loadVeraSources(ask(q), { physician: { states: ['OH'] } }, { enabled: false });
    assert.equal(sourceCheckReceipt(context, [], 'Done.'), null, q);
  }
});

test('a rules question with retrieval off lists its official pages as not retrieved', async () => {
  const context = await loadVeraSources(ask('What CME does Ohio require for my renewal?'), { physician: { states: ['OH'] } }, { enabled: false });
  const receipt = sourceCheckReceipt(context, [], 'Ohio asks for 50 hours.');
  assert.equal(receipt.attempted, false);
  assert.deepEqual(receipt.sources.map(s => [s.sourceId, s.status]), [['oh-cme-general', 'not_retrieved'], ['oh-pain-clinic', 'not_retrieved']]);
  assert.ok(receipt.sources.every(s => /^https:\/\//.test(s.url)));
  assert.deepEqual(receipt.citations, []);
});
