// SHARE-004: Documents "Select to send" read only doc.data, which is stripped
// once a document has a storagePath and comes back only on an account load.
// A ticked file that was in the account but not in memory answered "N file(s)
// haven't downloaded to this device yet. Try again in a moment." for good,
// and a file Storage does not have (fileMissing) was never named. The
// selected files are now fetched when ticked (before the tap, so the share
// keeps its gesture), and a missing one is named. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import * as docLabel from '../src/utils/docLabel.js';
import * as paused from '../src/utils/pausedApplicationRecords.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import * as helpers from '../src/utils/helpers.js';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as phiGuard from '../src/utils/phiGuard.js';
import * as customCategories from '../src/utils/customCategories.js';
import * as officeText from '../src/utils/officeText.js';
import * as receiptFiles from '../src/utils/receiptFiles.js';
import * as shareText from '../src/utils/shareText.js';
import { mountComponent, settle } from './component-harness.mjs';

const base = { size: 2048, uploadedAt: '2026-09-01T10:00:00Z', type: 'application/pdf' };
const DOCS = [
  { ...base, id: 'd-here', name: 'Synthetic license.pdf', data: 'data:application/pdf;base64,JVBERi0=' },
  { ...base, id: 'd-cloud', name: 'Synthetic DEA.pdf', storagePath: 'user_synthetic/d-cloud.pdf' },
  { ...base, id: 'd-flaky', name: 'Synthetic board.pdf', storagePath: 'user_synthetic/d-flaky.pdf' },
  { ...base, id: 'd-gone', name: 'Synthetic renewal.pdf', storagePath: 'user_synthetic/d-gone.pdf', fileMissing: true },
];

async function documents({ failFirst = new Set() } = {}) {
  const shared = [], downloads = [];
  const app = {
    data: { settings: { degreeType: 'MD', name: 'Dana Synthetic' }, documents: DOCS, licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [], shareLog: [] },
    theme: {}, userIdRef: { current: 'user_synthetic' }, addItem() {}, editItem() {}, deleteItem() {}, setData() {}, updateSettings() {}, navigate() {},
  };
  const ui = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app,
    globals: {
      navigator: {
        userAgent: 'Synthetic desktop', onLine: true, clipboard: { writeText: async () => {} },
        canShare: ({ files }) => Array.isArray(files) && files.length > 0,
        share: async payload => { shared.push(payload); },
      },
    },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, helpers, spreadsheetGuard: guard, phiGuard, customCategories, receiptFiles, shareText,
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt|rtf)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      useInputStyle: { useInputStyle: () => ({ width: '100%', fontSize: 16 }) },
      supabase: {
        supabase: null, uploadDocumentFile: async () => null,
        downloadDocumentBlob: async path => {
          downloads.push(path);
          if (failFirst.has(path)) { failFirst.delete(path); return null; }
          return path.endsWith('d-gone.pdf') ? null : new Blob(['%PDF-synthetic'], { type: 'application/pdf' });
        },
      },
    },
  });
  const button = label => ui.nodes().find(n => n.type === 'button' && (typeof label === 'string' ? ui.text(n).trim() === label : label.test(ui.text(n))));
  const tick = async id => { ui.nodes().find(n => n.key === id && typeof n.props.onClick === 'function').props.onClick(); ui.render(); await settle(); ui.render(); };
  const send = async () => { await button(/as one packet$/).props.onClick(); await settle(); ui.render(); };
  button('Select to send').props.onClick();
  ui.render();
  return { ui, shared, downloads, tick, send };
}

test('a ticked file that is in the account but not in memory is fetched and goes in the bundle', async () => {
  const h = await documents();
  await h.tick('d-here');
  await h.tick('d-cloud');
  await h.send();
  assert.equal(h.shared.length, 1, `shared once (${h.ui.pageText().match(/[^.]*(download|missing|sent)[^.]*\./gi)})`);
  assert.deepEqual(h.shared[0].files.map(f => f.name), ['Synthetic license.pdf', 'Synthetic DEA.pdf']);
  assert.deepEqual(h.downloads, ['user_synthetic/d-cloud.pdf'], 'only the file not in memory is fetched');
  assert.match(h.ui.pageText(), /Sent 2 documents as one packet\./);
});

test('a ticked file Storage does not have is named, and nothing is sent', async () => {
  const h = await documents();
  await h.tick('d-here');
  await h.tick('d-gone');
  await h.send();
  assert.equal(h.shared.length, 0);
  const text = h.ui.pageText();
  assert.match(text, /"Synthetic renewal\.pdf" is missing from your account/);
  assert.doesNotMatch(text, /Try again in a moment/);
  assert.ok(!h.downloads.includes('user_synthetic/d-gone.pdf'), 'a file known to be missing is not asked for again');
});

test('a fetch that failed is named, fetched again, and the next tap sends', async () => {
  const h = await documents({ failFirst: new Set(['user_synthetic/d-flaky.pdf']) });
  await h.tick('d-flaky');
  await h.send();
  assert.equal(h.shared.length, 0);
  assert.match(h.ui.pageText(), /Synthetic board\.pdf/);
  await settle(); h.ui.render(); await settle(); h.ui.render();
  await h.send();
  assert.equal(h.shared.length, 1);
  assert.deepEqual(h.shared[0].files.map(f => f.name), ['Synthetic board.pdf']);
});
