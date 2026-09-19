import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('real receipt renders trusted fixed links, honest cached dates, saved-only and failed-source states', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vera-receipt-'));
  try {
    const output = path.join(directory, 'receipt.cjs');
    await build({ entryPoints: [new URL('../../src/components/features/VeraSourceReceipt.jsx', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: output, logLevel: 'silent' });
    const Receipt = createRequire(import.meta.url)(output).default;
    const render = evidence => renderToStaticMarkup(React.createElement(Receipt, { evidence }));
    assert.match(render({ mode: 'saved_references', attempted: false, sources: [] }), /Saved references; no live source check/);
    const page = render({ attempted: true, sources: [{ sourceId: 'oh-cme-general', status: 'available', fetchedAt: '2026-09-19T20:00:00Z', delivery: 'cache', url: 'javascript:evil()', title: '<script>bad</script>' }] });
    assert.match(page, /retrieved 2026-09-19 20:00 UTC \(cached\)/);
    assert.match(page, /https:\/\/codes.ohio.gov\/ohio-administrative-code\/rule-4731-10-02/);
    assert.ok(!page.includes('javascript:') && !page.includes('<script>'));
    assert.match(page, /not a compliance determination/);
    const failed = render({ attempted: true, sources: [{ sourceId: 'dea-mate', status: 'unavailable', fetchedAt: null }] });
    assert.match(failed, /Source check unavailable/); assert.match(failed, /not retrieved/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
