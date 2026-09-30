// After a category is renamed, Favorites, Home's alerts and search show the
// new name, read live from the category rather than the name each record
// saved when it was written. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildCategory, packRecord, categoryLabelFor } from '../../src/utils/customCategories.js';
import { credentialRecords } from '../../src/utils/alertItems.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');

const setup = () => {
  const cat = buildCategory({ name: 'Badges', fields: ['Badge number'] }, { id: '11111111-1111-4111-8111-111111111111', now: '2026-09-01T00:00:00Z' });
  const { record: rec } = packRecord(cat, { name: 'Synthetic hospital badge', expirationDate: '2027-01-01' }, { id: '22222222-2222-4222-8222-222222222222' });
  // Renamed through the same editItem shape CustomCategorySection uses: the
  // category changes, the records are not rewritten.
  const renamed = { ...cat, name: 'Hospital ID Badges' };
  return { cat, rec, data: { customCategories: [renamed], customRecords: [{ ...rec, favorite: true }], settings: {} } };
};

test('the live name wins over the name the record saved', () => {
  const { rec, data } = setup();
  assert.equal(rec.categoryName, 'Badges', 'the record still carries the old snapshot');
  assert.equal(categoryLabelFor(data, rec), 'Hospital ID Badges');
  assert.equal(categoryLabelFor({ customCategories: [] }, rec), 'Badges', 'a category that is gone falls back to the saved name');
});

test('Home alerts label the record with the new name', () => {
  const { data } = setup();
  assert.equal(credentialRecords(data).find(r => r._sec === 'customRecords')._cat, 'Hospital ID Badges');
});

test('search finds the record by its new category name and says it', async () => {
  const out = await build({ entryPoints: [`${root}src/components/features/HomeSearch.jsx`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'ctx', namespace: 'stub' })); b.onLoad({ filter: /^ctx$/, namespace: 'stub' }, () => ({ contents: 'export const useApp = () => ({});', loader: 'js' })); } }] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  const { data } = setup();
  const res = mod.exports.searchRecords(data, 'hospital id badges');
  const hit = res.find(g => g.sec.key === 'customRecords')?.hits[0];
  assert.ok(hit, 'found by the new name');
  assert.match(hit.sub, /^Hospital ID Badges/);
});

test('Home recomputes its alert labels when a category is renamed', () => {
  const app = read('src/App.jsx');
  const memo = app.slice(app.indexOf('const allCreds = useMemo(() => credentialRecords(data)'), app.indexOf('const alertCreds'));
  assert.match(memo, /data\.customCategories\]/);
});

test('Favorites, Documents and Vera read the live name', () => {
  assert.match(read('src/App.jsx'), /section === "customRecords" \? \(categoryLabelFor\(data, record\) \|\| "Your categories"\)/);
  assert.match(read('src/components/features/DocumentsSection.jsx'), /categoryLabelFor\(data, /);
  assert.match(read('src/utils/assistant.js'), /category: sanitizeText\(categoryLabelFor\(data, r\), 60\)/);
});
