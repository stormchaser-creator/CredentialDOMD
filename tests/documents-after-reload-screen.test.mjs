// QA lab DOCS-008/DOCS-009 on the screen itself: the real Documents tab, its
// real byte hooks (components/shared/useDocumentBytes.js) and the real store
// (utils/documentBytes.js) over a synthetic account. After a reload the tab
// asks for the stored file it shows; the membership answer's second load puts
// the same rows on screen again while the file downloads; the file must still
// open (View PDF), never "Fetching the file from your account." for good. And
// offline it says so, then opens once the connection is back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf } from './harness/component-harness.mjs';
import { createDocumentBytes } from '../src/utils/documentBytes.js';

const { DocumentsSection } = await loadScreens('export { default as DocumentsSection } from "./src/components/features/DocumentsSection.jsx";');

const OWNER = 'user_synthetic';
const FILE = 'data:application/pdf;base64,JVBERi0xLjQgc3ludGhldGlj';
const row = () => ({ id: 'doc-letter', name: 'qa-loose-letter.pdf', type: 'application/pdf', size: 24, uploadedAt: '2026-10-02T08:00:00.000Z', storagePath: `${OWNER}/doc-letter`, linkedTo: '' });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function documentsTab({ online = true } = {}) {
  const m = mount(DocumentsSection, { data: {
    settings: { apiKey: 'synthetic', degreeType: 'MD' }, documents: [row()], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [],
    locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [], shareLog: [], travelDocs: [],
  } });
  const downloads = [];
  const net = { online };
  const bytes = createDocumentBytes({
    documents: () => m.data.documents,
    account: () => OWNER,
    fetch: (path) => new Promise((resolve) => downloads.push({ path, resolve })),
    update: (fn) => { m.data.documents = fn(m.data.documents); },
    online: () => net.online,
    defer: (fn) => queueMicrotask(fn),
  });
  Object.assign(globalThis.__screen.app, {
    user: { id: OWNER }, userIdRef: { current: 'profile-synthetic' }, navigate() {}, updateSettings() {}, updateSection() {}, confirmCanAddItem: async () => true,
    requestDocumentBytes: (ids) => bytes.want(ids), releaseDocumentBytes: (ids) => bytes.unwant(ids), documentBytes: bytes,
  });
  const page = () => textOf(m.render());
  const viewPdf = () => nodes(m.render()).some((n) => n.type === 'button' && /View PDF/.test(textOf(n)));
  return { m, bytes, downloads, net, page, viewPdf };
}

test('DOCS-008: the stored file opens after a reload, though the second load replaced the rows while it downloaded', async () => {
  const t = documentsTab();
  assert.match(t.page(), /Fetching the file from your account\. File with AI appears when it is here\./);
  await settle();
  assert.deepEqual(t.downloads.map((d) => d.path), [`${OWNER}/doc-letter`], 'the tab asked for the file it shows');
  // The membership answer's second load: the same row, read again, no bytes
  // (AppContext's effect on the documents asks the store to look again).
  t.m.data.documents = [row()];
  t.bytes.pump();
  t.m.render();
  await settle();
  assert.equal(t.downloads.length, 1, 'still one download');
  t.downloads[0].resolve({ dataUrl: FILE });
  await settle();
  assert.equal(t.viewPdf(), true, 'View PDF');
  assert.doesNotMatch(t.page(), /Fetching the file from your account/);
});

test('offline, the card says so instead of "Fetching"; back online the file opens', async () => {
  const t = documentsTab({ online: false });
  t.m.render();
  await settle();
  assert.equal(t.downloads.length, 0);
  assert.match(t.page(), /You are offline\. The file opens here once you are back online\./);
  assert.doesNotMatch(t.page(), /Fetching the file/);
  t.net.online = true;
  t.bytes.retryNow();
  await settle();
  assert.equal(t.downloads.length, 1);
  t.downloads[0].resolve({ dataUrl: FILE });
  await settle();
  assert.equal(t.viewPdf(), true);
});

test('a download that failed on a weak link says it is trying again, and the file opens when it lands', async () => {
  const t = documentsTab();
  t.m.render();
  await settle();
  t.downloads[0].resolve({ failed: true });
  await settle();
  assert.match(t.page(), /The file could not be fetched from your account yet\. Trying again\./);
  t.bytes.retryNow();
  await settle();
  t.downloads[1].resolve({ dataUrl: FILE });
  await settle();
  assert.equal(t.viewPdf(), true);
});
