// DOCS-003: a patient record found by the AI read must never reach the
// server. The Files upload used to store the file first and delete it after
// the read; that delete could run before the upload landed, or before a queued
// re-upload replayed, and the chart stayed on the server behind a tombstone.
// Driven through the real DocumentsSection with a stubbed scanner. Synthetic
// files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as phiGuard from '../src/utils/phiGuard.js';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as customCategories from '../src/utils/customCategories.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import * as contractsForDate from '../src/utils/contractsForDate.js';
import * as syncRules from '../src/utils/syncRules.js';
import * as documentBytes from '../src/utils/documentBytes.js';
import * as storedDuplicate from '../src/utils/storedDuplicate.js';
import { mountComponent, settle } from './component-harness.mjs';

const CHART = { documentType: 'unknown', extracted: { notes: 'Patient name: Synthetic Person. MRN 000000. Chief complaint: headache.' } };
const LICENSE = { documentType: 'license', extracted: { type: 'Medical License', state: 'CA', expirationDate: '2027-01-31' } };
const pdf = (name = 'scan.pdf') => new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });

async function upload(result, { canAdd = true, file = pdf(), confirm = undefined } = {}) {
  const calls = [];
  const app = {
    data: { settings: { apiKey: 'synthetic-key' }, documents: [], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [],
      locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [] },
    theme: {}, user: { id: 'user_synthetic' }, isDesktop: false, userIdRef: { current: 'profileA' },
    addItem: (...a) => { calls.push(['addItem', ...a]); return true; },
    canAddItem: (...a) => { calls.push(['canAddItem', a[0]]); return canAdd; },
    // AppContext's: settles an answer that is only old before the read.
    ...(confirm ? { confirmCanAddItem: async (...a) => { calls.push(['confirmCanAddItem', a[0]]); return confirm(); } } : {}),
    editItem: (...a) => { calls.push(['editItem', ...a]); return true; },
    deleteItem: (...a) => { calls.push(['deleteItem', ...a]); return true; },
    updateSettings() {}, setData() {}, navigate() {},
  };
  const reads = [];
  const view = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app,
    modules: {
      phiGuard, spreadsheetGuard: guard, customCategories, credentialTypes, inboxDocs, contractsForDate, syncRules,
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' },
      documentScanner: { analyzePDF: async (...a) => { reads.push(a); calls.push(['read']); return result; }, analyzeDocument: async () => result, CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other' },
      helpers: { generateId: () => '00000000-0000-4000-8000-000000000001', plainLabel: () => '' },
      limitedLaunchAccess: { alertWriteRefused: () => calls.push(['alertWriteRefused']), scopesForWrite: () => 'credential' },
    },
    globals: { requestAnimationFrame: (fn) => fn() },
  });
  const input = view.fileInputs().find((n) => n.props.multiple) || view.fileInputs()[0];
  await view.pick(input, [file]);
  await settle();
  return { calls, reads, page: view.pageText() };
}

test('DOCS-003: a scan read as a patient chart is refused before anything is stored', async () => {
  const { calls, page } = await upload(CHART);
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('read'), 'the file was read');
  assert.equal(names.includes('addItem'), false, 'and never stored: no upload, no row');
  assert.equal(names.includes('deleteItem'), false, 'so there is nothing to delete');
  assert.match(page, /"scan\.pdf" was not uploaded\./);
});

test('DOCS-003: a credential is read first, then stored, then offered for filing', async () => {
  const { calls } = await upload(LICENSE);
  const names = calls.map((c) => c[0]).filter((n) => n !== 'canAddItem');
  assert.deepEqual(names.slice(0, 2), ['read', 'addItem']);
  assert.equal(calls.find((c) => c[0] === 'addItem')[1], 'documents');
});

test('DOCS-003: a file that could not be saved is not sent to be read', async () => {
  const { calls, page } = await upload(LICENSE, { canAdd: false });
  const names = calls.map((c) => c[0]);
  assert.equal(names.includes('read'), false);
  assert.equal(names.includes('addItem'), false);
  assert.match(page, /was not saved, so it was not read/);
});

test('QA3: a file is not sent to be read until an old membership answer is settled, and never when it then refuses', async () => {
  // The check answers read-only: no paid read, nothing stored, and it says why.
  const refused = await upload(LICENSE, { confirm: async () => false });
  const names = refused.calls.map((c) => c[0]);
  assert.ok(names.includes('confirmCanAddItem'));
  assert.equal(names.includes('read'), false, 'the read is never paid for a save the check refused');
  assert.equal(names.includes('addItem'), false);
  assert.ok(names.includes('alertWriteRefused'));
  assert.match(refused.page, /was not saved, so it was not read/);
  // Allowed (or kept on this device): the read comes only after the answer.
  const allowed = await upload(LICENSE, { confirm: async () => true });
  const order = allowed.calls.map((c) => c[0]).filter((n) => n !== 'canAddItem');
  assert.deepEqual(order.slice(0, 3), ['confirmCanAddItem', 'read', 'addItem']);
});

test('DOCS-001: a file the browser typed as "" is stored with the type its name says', async () => {
  const { calls } = await upload(LICENSE, { file: new File(['x'], 'card.heic', { type: '' }) });
  const added = calls.find((c) => c[0] === 'addItem');
  assert.equal(added?.[2]?.type, 'image/heic');
});

// ── SYNC-013: a file missing from the account is said, and can be replaced ──
async function listDocs(documents, { uploaded = 'user_synthetic/doc-m', uploadError = null, scan = null, quota = { ok: true }, globals = {}, confirm = undefined, stored = {} } = {}) {
  const calls = [];
  let state = { settings: { apiKey: 'synthetic-key' }, documents, licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [],
    locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [] };
  const view = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app: { get data() { return state; }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: false, userIdRef: { current: 'profileA' },
      addItem: () => true, canAddItem: () => true, deleteItem: () => true, updateSettings() {}, navigate() {},
      ...(confirm ? { confirmCanAddItem: async (...a) => { calls.push(['confirmCanAddItem', a[0]]); return confirm(); } } : {}),
      editItem: (key, item) => { calls.push(['editItem', item]); state = { ...state, documents: state.documents.map((d) => (d.id === item.id ? item : d)) }; return true; },
      updateSection: (key, fn) => { calls.push(['updateSection', key]); state = { ...state, [key]: fn(state[key]) }; return true; },
      setData: (fn) => { calls.push(['setData']); state = typeof fn === 'function' ? fn(state) : fn; return true; } },
    modules: {
      phiGuard, spreadsheetGuard: guard, customCategories, credentialTypes, inboxDocs, contractsForDate, syncRules, documentBytes, storedDuplicate,
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => '' },
      storageQuota: { checkStorageQuota: (docs, files) => { calls.push(['quota', docs.map((d) => d.id), files.length]); return quota; } }, officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' },
      documentScanner: { CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
        analyzePDF: async () => { calls.push(['read']); return scan; }, analyzeDocument: async () => { calls.push(['read']); return scan; } },
      supabase: { supabase: {}, uploadDocumentFile: async (doc, auth, profile) => { calls.push(['upload', doc.id, auth, profile, !!doc.data]); if (uploadError) throw uploadError; return uploaded; },
        downloadDocumentBlob: async (path) => { calls.push(['download', path]); return path in stored ? new Blob([stored[path]]) : null; } },
      limitedLaunchAccess: { alertWriteRefused: () => calls.push(['alertWriteRefused']), scopesForWrite: () => 'credential' },
    },
    globals,
  });
  return { view, calls, state: () => state };
}

test('SYNC-013: a missing file says so instead of "Fetching" for ever, and a linked one shows its loading hint', async () => {
  const { view } = await listDocs([
    { id: 'doc-m', name: 'sheet.xlsx', storagePath: 'user_old/doc-m', fileMissing: true, size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: '' },
    { id: 'doc-l', name: 'license.pdf', storagePath: 'user_synthetic/doc-l', size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: 'licenses:l1' },
  ]);
  const page = view.pageText();
  assert.match(page, /This file is missing from your account\. Upload it again or delete this entry\./);
  assert.match(page, /Upload it again/);
  assert.equal((page.match(/Fetching the file from your account/g) || []).length, 1, 'only the linked one is loading');
});

test('SYNC-013: "Upload it again" stores the new file under the same document and records where it lives', async () => {
  const { view, calls, state } = await listDocs([{ id: 'doc-m', name: 'sheet.xlsx', storagePath: 'user_old/doc-m', fileMissing: true, size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: '' }]);
  const button = view.nodes().find((n) => n.type === 'button' && view.text(n) === 'Upload it again');
  button.props.onClick();
  const input = view.nodes().find((n) => n.type === 'input' && n.props['data-reupload'] === '');
  await view.pick(input, [new File(['a,b\n1,2\n'], 'sheet.xlsx', { type: '' })]);
  await settle();
  // Kept on the device, never sent as an edit: a landed edit would make the
  // row look newer than these bytes if the upload then failed.
  assert.equal(calls.some((c) => c[0] === 'editItem'), false);
  assert.deepEqual(calls.find((c) => c[0] === 'updateSection'), ['updateSection', 'documents']);
  assert.deepEqual(calls.find((c) => c[0] === 'upload'), ['upload', 'doc-m', 'user_synthetic', 'profileA', true]);
  const [doc] = state().documents;
  assert.equal(doc.id, 'doc-m');
  assert.equal(doc.fileMissing, undefined);
  assert.equal(doc.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(Date.parse(doc.updatedAt) > Date.parse('2026-08-01T00:00:00Z'), 'stamped, so the next load uploads it if this upload fails');
  assert.equal(doc.storagePath, 'user_synthetic/doc-m');
  assert.equal(doc.pendingUpload, undefined, 'the file is in Storage');
});

test('SYNC-013: a file given again whose upload failed stays marked for the next load', async () => {
  const { view, state } = await listDocs([{ id: 'doc-m', name: 'sheet.xlsx', storagePath: 'user_old/doc-m', fileMissing: true, size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: '' }], { uploaded: null });
  view.nodes().find((n) => n.type === 'button' && view.text(n) === 'Upload it again').props.onClick();
  await view.pick(view.nodes().find((n) => n.type === 'input' && n.props['data-reupload'] === ''), [new File(['a,b\n1,2\n'], 'sheet.xlsx', { type: '' })]);
  await settle();
  const [doc] = state().documents;
  assert.equal(doc.pendingUpload, true);
  assert.equal(doc.storagePath, undefined);
  assert.ok(doc.data);
  assert.match(view.pageText(), /is back on this device\. It goes to your account the next time the app opens online\./);
});

// "Upload it again" stores a file: it passes the same gate as any upload.
const missing = () => [
  { id: 'doc-m', name: 'license.pdf', storagePath: 'user_old/doc-m', fileMissing: true, size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: 'licenses:l1' },
  { id: 'doc-o', name: 'other.pdf', storagePath: 'user_synthetic/doc-o', size: 18, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: '' },
];
async function uploadAgain(file, options) {
  const run = await listDocs(missing(), options);
  run.view.nodes().find((n) => n.type === 'button' && run.view.text(n) === 'Upload it again').props.onClick();
  await run.view.pick(run.view.nodes().find((n) => n.type === 'input' && n.props['data-reupload'] === ''), [file]);
  await settle();
  const names = run.calls.map((c) => c[0]);
  return { ...run, names, page: run.view.pageText(), stored: names.includes('updateSection') || names.includes('upload') };
}

test('SYNC-013: a file given again that the read finds is a patient chart is never stored', async () => {
  const { names, stored, page } = await uploadAgain(pdf('license.pdf'), { scan: CHART });
  assert.ok(names.includes('read'), 'screened like any upload');
  assert.equal(stored, false, 'no device write, no upload');
  assert.match(page, /"license\.pdf" was not uploaded\./);
});

test('SYNC-013: a spreadsheet given again that names a patient column is refused before it is read', async () => {
  const { names, stored, page } = await uploadAgain(new File(['MRN,Patient Name\n000000,Synthetic Person\n'], 'list.csv', { type: 'text/csv' }));
  assert.equal(stored, false);
  assert.equal(names.includes('read'), false);
  assert.match(page, /"list\.csv" was not uploaded\./);
});

test('SYNC-013: a file given again is held to the 2 GB line, the size limit and the duplicate check', async () => {
  const quota = await uploadAgain(pdf('license.pdf'), { quota: { ok: false, message: 'Synthetic quota message.' } });
  assert.equal(quota.stored, false);
  assert.match(quota.page, /Synthetic quota message\./);
  assert.deepEqual(quota.calls.find((c) => c[0] === 'quota'), ['quota', ['doc-o'], 1], 'counted without the file it replaces');
  const big = await uploadAgain(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'license.pdf', { type: 'application/pdf' }));
  assert.equal(big.stored, false);
  assert.match(big.page, /exceeds the 10 MB size limit/);
  const dup = await uploadAgain(new File(['%PDF-1.4 synthetic'], 'other.pdf', { type: 'application/pdf' }));
  assert.equal(dup.stored, false);
  assert.match(dup.page, /"other\.pdf" is already stored as another document\./);
});

// Review of release/goal2 (2026-10-02): the duplicate check of "Upload it
// again" compared only bytes in memory, which stored documents no longer hold
// (a load does not download them), so a scan already stored under another
// name was stored a second time, and read again at a cost.
test('SYNC-013: a file given again that is already stored under another name is caught from the stored copy', async () => {
  const dup = await uploadAgain(new File(['%PDF-1.4 synthetic'], 'IMG_0412.pdf', { type: 'application/pdf' }),
    { scan: LICENSE, stored: { 'user_synthetic/doc-o': '%PDF-1.4 synthetic' } });
  assert.deepEqual(dup.calls.filter((c) => c[0] === 'download'), [['download', 'user_synthetic/doc-o']], 'the stored copy of the same size is compared');
  assert.equal(dup.stored, false, 'not stored twice');
  assert.equal(dup.names.includes('read'), false, 'and not read');
  assert.match(dup.page, /"IMG_0412\.pdf" is already stored as another document\./);
  // Must pass: other bytes of the same size are not a duplicate.
  const other = await uploadAgain(new File(['%PDF-1.4 different'], 'IMG_0413.pdf', { type: 'application/pdf' }),
    { scan: LICENSE, stored: { 'user_synthetic/doc-o': '%PDF-1.4 synthetic' } });
  assert.equal(other.stored, true);
});

test('SYNC-013: a file given again that cannot be read says so and changes nothing', async () => {
  class FailingReader { readAsDataURL() { setTimeout(() => this.onerror?.(new Error('synthetic read failure'))); } }
  const run = await uploadAgain(pdf('license.pdf'), { globals: { FileReader: FailingReader } });
  // The read fails on a timer after the pre-read check, which reads the file
  // itself; on a slow runner a fixed number of turns can end before either
  // finishes (CI failure on a6a00f5b). Wait for the outcome, bounded.
  const expected = /"license\.pdf" could not be read\. Nothing was changed\./;
  const deadline = Date.now() + 3000;
  while (!expected.test(run.view.pageText()) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    await settle();
    run.view.render();
  }
  const names = run.calls.map((c) => c[0]);
  assert.equal(names.includes('updateSection') || names.includes('upload'), false);
  assert.match(run.view.pageText(), expected);
});

test('SYNC-013: a credential given again is read, screened, then stored', async () => {
  const { names } = await uploadAgain(pdf('license.pdf'), { scan: LICENSE });
  assert.deepEqual(names.filter((n) => ['read', 'updateSection', 'upload'].includes(n)), ['read', 'updateSection', 'upload']);
});

test('QA3: a file given again is not read until an old membership answer is settled, and never when it then refuses', async () => {
  const refused = await uploadAgain(pdf('license.pdf'), { scan: LICENSE, confirm: async () => false });
  assert.ok(refused.names.includes('confirmCanAddItem'));
  assert.equal(refused.names.includes('read'), false, 'no paid read for a save the check refused');
  assert.equal(refused.stored, false);
  assert.match(refused.page, /"license\.pdf" was not saved, so it was not read\. Nothing was changed\./);
  const allowed = await uploadAgain(pdf('license.pdf'), { scan: LICENSE, confirm: async () => true });
  assert.deepEqual(allowed.names.filter((n) => ['confirmCanAddItem', 'read', 'updateSection', 'upload'].includes(n)), ['confirmCanAddItem', 'read', 'updateSection', 'upload']);
});

test('QA3 review: a file given again that the membership check then refuses is not said to be waiting on this device', async () => {
  // The answer was only old: the new file was kept while a check ran, which
  // answered read-only, so AppContext took it back and said so. The upload
  // rejects with that refusal.
  const refusal = Object.assign(new Error('This record is read-only.'), { code: 'membership_read_only' });
  const doc = { id: 'doc-m', name: 'sheet.xlsx', storagePath: 'user_old/doc-m', fileMissing: true, size: 10, uploadedAt: '2026-08-01T00:00:00Z', linkedTo: '' };
  const { view, calls } = await listDocs([doc], { uploadError: refusal });
  view.nodes().find((n) => n.type === 'button' && view.text(n) === 'Upload it again').props.onClick();
  await view.pick(view.nodes().find((n) => n.type === 'input' && n.props['data-reupload'] === ''), [new File(['a,b\n1,2\n'], 'sheet.xlsx', { type: '' })]);
  await settle();
  assert.ok(calls.some((c) => c[0] === 'upload'));
  assert.doesNotMatch(view.pageText(), /is back on this device/, 'not promised to go up: it is not on this device any more');
  assert.equal(calls.some((c) => c[0] === 'setData'), false, 'no storage path is recorded');
  // Any other failure still says the file waits here for the next load.
  const failed = await listDocs([doc], { uploadError: new Error('Failed to fetch') });
  failed.view.nodes().find((n) => n.type === 'button' && failed.view.text(n) === 'Upload it again').props.onClick();
  await failed.view.pick(failed.view.nodes().find((n) => n.type === 'input' && n.props['data-reupload'] === ''), [new File(['a,b\n1,2\n'], 'sheet.xlsx', { type: '' })]);
  await settle();
  assert.match(failed.view.pageText(), /is back on this device\. It goes to your account the next time the app opens online\./);
});
