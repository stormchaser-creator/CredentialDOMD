// SYNC-018: "Your Data" counted 15 of 33 synced collections by hand, so the
// total, and the export's _exportMeta.itemCount, understated what the export
// and the account held (every Practice section, every custom record).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordCounts, totalOf, COUNT_EXCLUDED } from '../src/utils/dataCounts.js';
import { BUILT_IN_SECTIONS } from '../src/utils/sectionFields.js';

test('SYNC-018: every synced collection is counted or named as bookkeeping', () => {
  const counted = new Set(recordCounts({}, BUILT_IN_SECTIONS).map((c) => c.key));
  for (const key of BUILT_IN_SECTIONS) assert.ok(counted.has(key) || COUNT_EXCLUDED.includes(key), key);
  for (const key of COUNT_EXCLUDED) assert.ok(BUILT_IN_SECTIONS.includes(key), `${key} is a real collection`);
});

test('SYNC-018: a Practice-heavy account\'s total includes its work log, invoices and custom records', () => {
  const data = { licenses: [{}], workLog: [{}, {}], invoices: [{}], locumContracts: [{}], customRecords: [{}], shareLog: [{}, {}, {}] };
  const counts = recordCounts(data, BUILT_IN_SECTIONS);
  assert.equal(totalOf(counts), 6, 'the share log is bookkeeping and is not counted');
  assert.equal(counts.find((c) => c.key === 'workLog').label, 'Work log');
});

test('SYNC-018: the screen, the export meta and the print total use the derived counts', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/components/features/DataExport.jsx', import.meta.url)), 'utf8');
  assert.match(src, /const counts = recordCounts\(data, COLLECTION_KEYS\);/);
  assert.match(src, /itemCount: totalItems/);
  assert.match(src, /Total: \$\{printed\} credential item/);
  assert.doesNotMatch(src, /Total: \$\{totalItems\} credential items/, 'the print summary no longer claims the page-wide total');
});
