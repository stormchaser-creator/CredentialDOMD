// Free CME providers sort first in the directory, as the comment always said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareProviders } from '../../src/utils/cmeProviderSort.js';
import { CME_PROVIDERS } from '../../src/constants/cmeProviders.js';

test('every free provider sorts before every priced one', () => {
  const sorted = [...CME_PROVIDERS].sort((a, b) => compareProviders(a, b));
  const firstPriced = sorted.findIndex(p => p.pricing !== 'free');
  const lastFree = sorted.map(p => p.pricing).lastIndexOf('free');
  assert.ok(CME_PROVIDERS.some(p => p.pricing === 'free'));
  assert.ok(lastFree < firstPriced, `free providers end at ${lastFree}, priced start at ${firstPriced}`);
});

test('the directory uses the shared order', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/components/features/CMEResourcesSection.jsx', import.meta.url)), 'utf8');
  assert.match(src, /providers\.sort\(\(a, b\) => compareProviders\(a, b, \{ unmetTopics, specialtyIds: specialtyProviderIds \}\)\);/);
  assert.doesNotMatch(src, /priceOrder\[a\.pricing\] \|\| 5/);
});
