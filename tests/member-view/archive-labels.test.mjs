import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recordCard, homeSummary } from '../../src/utils/memberViewer.js';
import { recordHeading, archiveSections } from '../../src/utils/readOnlyArchive.js';

const snapshot = { member: { name: 'Synthetic Archive Physician' }, sections: {} };
const data = { settings: { name: snapshot.member.name } };
const license = { id: 'synthetic-oh', type: 'State Medical License', state: 'OH', licenseNumber: 'QA-ARCHIVE-OH' };

test('a license with absent or populated optional name has one archive separator and a clean support main line', () => {
  for (const name of [undefined, null, '', 'QA Archive License']) {
    const record = { ...license, name }, before = structuredClone(record);
    assert.equal(recordCard('licenses', record, snapshot).mainLine, 'OH');
    assert.equal(recordHeading('licenses', record, data).title, 'State Medical License, OH');
    const archived = archiveSections({ ...data, licenses: [record] }, 'credential', ['licenses']);
    assert.equal(archived.sections[0].records[0].title, 'State Medical License, OH');
    assert.equal(archived.saved.licenses[0], record, 'formatting does not change exported records');
    assert.deepEqual(record, before);
  }
});

test('known title separators are removed once while meaningful provider and facility punctuation stays', () => {
  for (const [section, record, mainLine, title] of [
    ['insurance', { type: 'Malpractice', provider: 'Acme, Inc.' }, 'Acme, Inc.', 'Malpractice, Acme, Inc.'],
    ['privileges', { type: 'Surgical Privileges', facility: 'Mercy — West, Suite 2' }, 'Mercy — West, Suite 2', 'Surgical Privileges, Mercy, West, Suite 2'],
    ['education', { type: 'Fellowship', name: 'Fellowship — Skull Base' }, 'Skull Base', 'Fellowship, Skull Base'],
  ]) {
    assert.equal(recordCard(section, record, snapshot).mainLine, mainLine);
    assert.equal(recordHeading(section, record, data).title, title);
  }
  const workSnapshot = { ...snapshot, sections: { locumContracts: [{ id: 'agreement', shortName: 'Mercy, West' }] } };
  assert.equal(recordCard('workLog', { type: 'Chart review', contractId: 'agreement' }, workSnapshot).mainLine, 'Mercy, West');
});

test('a type prefix inside a meaningful title is not deleted', () => {
  for (const name of ['Fellowship-trained Neurosurgery', 'Fellowship Research in Skull Base', 'Fellowshipology']) {
    assert.equal(recordCard('education', { type: 'Fellowship', name }, snapshot).mainLine, name);
  }
});

test('type-only, state-only and empty records retain useful fallbacks without dangling separators', () => {
  for (const [record, main, title] of [
    [{ type: 'State Medical License' }, 'State Medical License', 'State Medical License'],
    [{ state: 'OH' }, 'License, OH', 'License, OH'],
    [{}, 'License', 'License'],
  ]) {
    assert.equal(recordCard('licenses', record, snapshot).mainLine, main);
    assert.equal(recordHeading('licenses', record, data).title, title);
  }
});

test('the support home attention list uses the same clean title without altering status or identifiers', () => {
  const item = { ...license, expirationDate: '2000-01-01', favorite: true };
  const home = homeSummary({ ...snapshot, sections: { licenses: [item] } });
  assert.equal(home.attention.length, 1);
  assert.equal(home.attention[0].mainLine, 'OH');
  assert.equal(home.attention[0].type, license.type);
  assert.equal(home.attention[0].id, license.id);
  assert.equal(home.attention[0].color, 'red');
  assert.equal(home.attention[0].favorite, true);
});

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  entryPoints: [`${root}src/components/features/ReadOnlyRecords.jsx`], bundle: true, platform: 'node', format: 'cjs', write: false,
  jsx: 'automatic', define: { 'import.meta.env': '{}' }, external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-archive', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__archiveLabelFixture;'
      : path === 'database' ? 'export const COLLECTION_KEYS=["licenses"];export const downloadDocumentFile=()=>{throw Error("No network");};'
        : 'export const downloadBlob=()=>{throw Error("No download");};export const invoicePdfFile=downloadBlob;export const invoiceTextPdfFile=downloadBlob;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);

test('the actual read-only archive renders the exact Ohio heading with saved details and file controls', () => {
  globalThis.__archiveLabelFixture = {
    data: { ...data, licenses: [{ ...license, name: 'QA Archive License' }], documents: [{ id: 'attachment', name: 'qa-license.pdf', type: 'application/pdf', linkedTo: `licenses:${license.id}` }] },
    theme: {}, isDesktop: true, limitedLaunch: { access: null }, navigate() { throw Error('No navigation'); },
  };
  try {
    const html = renderToStaticMarkup(React.createElement(mod.exports.default, { scope: 'credential' }));
    const summary = html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    assert.ok(summary);
    assert.match(summary, />State Medical License, OH<\/div>/);
    assert.doesNotMatch(summary, /,\s*,/);
    assert.match(summary, /QA-ARCHIVE-OH/);
    assert.match(html, /QA Archive License/);
    assert.match(html, />Download attachment<\/button>/);
    assert.doesNotMatch(html, />(Add|Edit|Save|Delete)<\/button>/);
  } finally { delete globalThis.__archiveLabelFixture; }
});
