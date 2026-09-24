import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the real category screens and the uploader's review card with a
// synthetic account and no network, so a crash or a lost value on any of them
// fails here instead of on a physician's phone.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Category, NewCategoryPanel} from "./src/components/features/CustomCategorySection.jsx"; export {default as Review} from "./src/components/features/OtherDocumentReview.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-account', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context' ? 'export const useApp = () => globalThis.__customCategoryFixture;' : 'export {}' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Category, NewCategoryPanel, Review } = mod.exports;

const fail = () => { throw Error('No writes during render'); };
const fixture = (over = {}) => ({
  user: { id: 'user_synthetic' }, isDesktop: false, canWriteCredential: true,
  theme: { text: '#111', textMuted: '#666', textDim: '#888', border: '#aaa', card: '#fff', bg: '#eee', accent: '#2a7', accentDim: '#dfe', danger: '#c00', warning: '#a60' },
  addItem: fail, editItem: fail, deleteItem: fail, setData: fail, toggleFavorite: fail,
  data: {
    settings: {}, documents: [],
    customCategories: [
      { id: 'C1', name: 'Hospital ID Badges', icon: 'B', fields: [{ key: 'badgeNumber', label: 'Badge number' }, { key: 'accessLevel', label: 'Access level' }] },
      { id: 'C2', name: 'Awards', icon: 'A', fields: [] },
      { id: 'C3', name: 'Old Stuff', icon: 'O', fields: [], archivedAt: '2026-01-01T00:00:00Z' },
    ],
    customRecords: [
      { id: 'R1', categoryId: 'C1', categoryName: 'Hospital ID Badges', name: 'Penrose badge', issuer: 'Penrose Hospital', expirationDate: '2027-05-01', fieldValues: { badgeNumber: 'PX-4471' }, fieldLabels: { badgeNumber: 'Badge number' } },
      { id: 'R2', categoryId: 'C3', categoryName: 'Old Stuff', name: 'Old parking pass', fieldLabels: { lot: 'Lot' }, fieldValues: { lot: 'B' } },
    ],
  },
  ...over,
});
const render = (Component, props, over) => {
  globalThis.__customCategoryFixture = fixture(over);
  return renderToStaticMarkup(React.createElement(Component, props));
};

test('a category shows its own records and the tools to manage it', () => {
  const html = render(Category, { categoryId: 'C1' });
  assert.match(html, /Hospital ID Badges/);
  assert.match(html, /Penrose badge/);
  assert.doesNotMatch(html, /Old parking pass/, 'another category\'s record must not appear here');
  for (const tool of ['Rename', 'Add a field', 'Hide category', 'Move to another category']) assert.match(html, new RegExp(tool));
});

test('Unsorted records shows what a hidden category held, and cannot rename anything', () => {
  const html = render(Category, { categoryId: 'unsorted', onOpenCategory() {} });
  assert.match(html, /Unsorted records/);
  assert.match(html, /Old parking pass/);
  assert.doesNotMatch(html, /Penrose badge/);
  assert.doesNotMatch(html, />Rename</);
  assert.match(html, /belong to a category that was hidden or removed/);
});

test('a category id that no longer exists explains where its records went', () => {
  assert.match(render(Category, { categoryId: 'GONE' }), /This category no longer exists. Its records are under Unsorted records/);
});

test('a read-only account sees its records but no category tools', () => {
  const html = render(Category, { categoryId: 'C1' }, { canWriteCredential: false });
  assert.match(html, /Penrose badge/);
  assert.doesNotMatch(html, /Hide category|Move to another category/);
});

test('the new category form renders', () => {
  const html = render(NewCategoryPanel, {});
  assert.match(html, /New category/); assert.match(html, /Create category/);
});

test('an upload matching an existing category is filed there, with every detail shown and identifiers flagged', () => {
  const extracted = {
    suggestedCategory: { name: 'hospital id badges' }, name: 'Presbyterian badge', issuer: 'Presbyterian/St. Luke\'s',
    facts: [{ label: 'Badge number', value: 'PR-1' }, { label: 'Patient Name', value: 'Jane Doe' }], color: 'Blue',
  };
  const html = render(Review, { extracted, onFile() {}, onDiscard() {} });
  assert.match(html, /File in Hospital ID Badges/, 'a case-different suggestion reuses the existing category');
  assert.match(html, /value="Presbyterian badge"/);
  assert.match(html, /value="PR-1"/);
  assert.match(html, /value="Color"/, 'a stray field the scanner returned is kept as a detail');
  assert.match(html, /Not saved: a patient identifier/);
});

test('an upload whose category was hidden goes back into it instead of a duplicate', () => {
  const html = render(Review, { extracted: { suggestedCategory: { name: 'Old Stuff' }, name: 'New pass' }, onFile() {}, onDiscard() {} });
  assert.match(html, /You already have &quot;Old Stuff&quot;/);
  assert.match(html, /File in Old Stuff/);
});

test('an upload with nothing to match proposes a new category by name', () => {
  const html = render(Review, { extracted: { suggestedCategory: { name: 'Speaking Engagements' }, name: 'AANS 2026 talk' }, onFile() {}, onDiscard() {} });
  assert.match(html, /Create &quot;Speaking Engagements&quot; and file it/);
});
