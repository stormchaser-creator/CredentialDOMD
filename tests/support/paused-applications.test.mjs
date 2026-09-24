import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAUSED_APPLICATION_SECTIONS, preservePausedApplicationRecords, pausedApplicationLinks } from '../../src/utils/pausedApplicationRecords.js';

test('paused records survive a cloud merge byte-for-byte without joining unrelated data or mutating the cache', () => {
  const cached = { answerBank: [{ id: 'answer-a', answer: 'No', notes: 'Private answer' }], identityVault: [{ id: 'identity-a', legalFirstName: 'Synthetic name', ssn: 'enc1:SYNTHETIC', fullDob: 'enc1:DATE' }], licenses: [{ id: 'stale-license' }], settings: { name: 'Stale name' } };
  const before = JSON.stringify(cached);
  const cloud = { answerBank: [], identityVault: [], licenses: [{ id: 'live-license' }], settings: { name: 'Current name' } };
  const merged = preservePausedApplicationRecords(cloud, cached);
  assert.deepEqual(merged.answerBank, cached.answerBank);
  assert.deepEqual(merged.identityVault, cached.identityVault);
  assert.equal(merged.identityVault[0].ssn, 'enc1:SYNTHETIC');
  assert.equal(merged.licenses, cloud.licenses);
  assert.equal(merged.settings, cloud.settings);
  assert.equal(JSON.stringify(cached), before);
  assert.deepEqual(cloud.answerBank, []);
});

test('tombstones remove paused records before the document link sweep while valid local links survive', () => {
  const cache = { answerBank: [{ id: 'keep-a' }, { id: 'delete-a' }], identityVault: [{ id: 'keep-i' }, { id: 'delete-i' }, null, {}] };
  const merged = preservePausedApplicationRecords({}, cache, new Set(['delete-a', 'delete-i']));
  const links = new Set(pausedApplicationLinks(merged));
  assert.deepEqual([...links], ['answerBank:keep-a', 'identityVault:keep-i']);
  const documents = ['answerBank:keep-a', 'identityVault:keep-i', 'answerBank:delete-a', 'identityVault:delete-i', 'identityVault:missing'];
  assert.deepEqual(documents.map(linkedTo => links.has(linkedTo) ? linkedTo : ''), ['answerBank:keep-a', 'identityVault:keep-i', '', '', '']);
});

test('a missing, malformed or other account cache never retains previous account records', () => {
  const previous = { answerBank: [{ id: 'account-a' }], identityVault: [{ id: 'account-a-secret' }] };
  assert.deepEqual(preservePausedApplicationRecords(previous, null), { answerBank: [], identityVault: [] });
  assert.deepEqual(preservePausedApplicationRecords(previous, { answerBank: {}, identityVault: 'invalid' }), { answerBank: [], identityVault: [] });
  assert.deepEqual(preservePausedApplicationRecords(previous, { answerBank: [{ id: 'account-b' }] }), { answerBank: [{ id: 'account-b' }], identityVault: [] });
  assert.deepEqual(Object.keys(PAUSED_APPLICATION_SECTIONS), ['answerBank', 'identityVault']);
});

test('actual availability UI exposes no editor, sharing control or record contents and describes backup limits', async () => {
  const output = await build({ entryPoints: [new URL('../../src/components/features/ApplicationRecordsPaused.jsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', plugins: [{ name: 'react-from-test', setup(builder) { builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'test' })); builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const {jsx,jsxs}=globalThis.__pausedJsx;' })); } }] });
  globalThis.__pausedJsx = jsxRuntime;
  try {
    const { default: Gate } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
    for (const section of Object.keys(PAUSED_APPLICATION_SECTIONS)) {
      const html = renderToStaticMarkup(React.createElement(Gate, { section, count: 2, theme: {} }));
      assert.match(html, /New entries, edits and sharing are paused/);
      assert.match(html, /This browser has 2 saved records/);
      assert.match(html, /cannot restore them yet/);
      assert.match(html, /signing out clears the local copy/);
      assert.doesNotMatch(html, /<(?:input|textarea|select|button|form)\b/);
      if (section === 'identityVault') assert.match(html, /Legal names and notes are plain text/);
    }
    const empty = renderToStaticMarkup(React.createElement(Gate, { section: 'answerBank', count: 0, theme: {} }));
    assert.doesNotMatch(empty, /This browser has/);
  } finally { delete globalThis.__pausedJsx; }
});

test('production wiring gates both editors and preserves the exact local collections before cache and link replacement', async () => {
  const read = name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
  const [app, context, database] = await Promise.all([read('src/App.jsx'), read('src/context/AppContext.jsx'), read('src/lib/supabase.js')]);
  assert.match(app, /Object\.hasOwn\(PAUSED_APPLICATION_SECTIONS, sub\)/);
  assert.match(app, /<ApplicationRecordsPaused section=\{sub\}/);
  assert.doesNotMatch(app, /sectionKey="(?:answerBank|identityVault)"/);
  const preserve = context.indexOf('merged = preservePausedApplicationRecords(merged, local, tombstones)');
  assert.ok(preserve > context.indexOf('await listTombstones(profileId)'));
  // The link pass (src/utils/documentLinks.js) must run after paused records
  // are preserved, or their document links would be cleared. Assert the call
  // exists, so a refactor that moves it cannot make this pass vacuously.
  const linkPass = context.indexOf('reconcileDocumentLinks(merged, COLLECTION_KEYS, pausedApplicationLinks(merged))');
  assert.ok(linkPass > 0, 'the link pass must still receive the paused application links');
  assert.ok(preserve < linkPass);
  assert.ok(preserve < context.indexOf('saveData(merged, authUserId)'));
  const registry = database.match(/const TABLE_MAP = \{[\s\S]*?\n\};/)[0];
  assert.doesNotMatch(registry, /answerBank|identityVault/);
});
