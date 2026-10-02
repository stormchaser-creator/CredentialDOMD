// SYNC-013: a file attached inside a record form, and how a record shows a
// file it holds. Driven through the real components (tests/component-harness.mjs).
// Every file and record here is synthetic.
//
// 1. The record forms (CrudSection's own upload, and DocAttach used by CME,
//    Health Records, Screenings and Contracts) had no per-file size limit.
//    The documents bucket refuses anything over 15 MB, the refused upload was
//    queued whole with its data URL, localStorage threw, and the member read
//    that this device's storage was full. They now hold the Documents tab's
//    10 MB line before the file is read.
// 2. A linked file whose Storage object is gone (doc.fileMissing, set by
//    AppContext reconcileDocumentFiles, which then stops asking) read
//    "is downloading from the cloud; check back shortly" forever on the
//    license, health record and screening detail views.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import * as helpers from '../src/utils/helpers.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import * as documentBytes from '../src/utils/documentBytes.js';
import { mountComponent } from './component-harness.mjs';
import { settleOutcome } from './helpers/settle-outcome.mjs';

const MB = 1024 * 1024;
const pdf = (name, bytes) => new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
const BIG = '"scan-18mb.pdf" exceeds the 10 MB size limit.';

function recorder() {
  const calls = [];
  const fn = name => (...args) => { calls.push([name, ...args]); return true; };
  return { calls, fn, names: () => calls.map(c => c[0]) };
}
const account = (rec, data = {}) => ({
  data: { settings: {}, documents: [], followUps: [], locumContracts: [], deductibles: [], ...data },
  theme: {}, user: { id: 'user_synthetic' }, isDesktop: false,
  addItem: rec.fn('addItem'), editItem: rec.fn('editItem'), deleteItem: rec.fn('deleteItem'), setData: rec.fn('setData'),
  toggleFavorite: rec.fn('toggleFavorite'), navigate: rec.fn('navigate'),
});
const common = rec => ({
  spreadsheetGuard: guard, inboxDocs, documentBytes,
  aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.', aiAvailable: () => false },
  storageQuota: { checkStorageQuota: () => ({ ok: true }) },
  officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' },
  documentScanner: {
    analyzePDF: async (...a) => { rec.calls.push(['analyzePDF', ...a]); return { extracted: { licenseNumber: 'A12345' } }; },
    analyzeDocument: async () => null, analyzeDocText: async () => null, analyzeStatement: async () => [],
  },
});

// -- 1. The 10 MB line on the record forms --
test('SYNC-013: a record form refuses a file over 10 MB before reading it, and keeps the next file', async () => {
  const rec = recorder();
  const form = await mountComponent('src/components/features/CrudSection.jsx', {
    app: account(rec),
    props: { title: 'Licenses', sectionKey: 'licenses', items: [], fields: [{ key: 'licenseNumber', label: 'License Number' }], autoOpen: true, onAutoOpenDone() {} },
    modules: { ...common(rec), lifecycle: await import('../src/utils/lifecycle.js'), formLayout: await import('../src/utils/formLayout.js'), docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) } },
  });
  const upload = form.fileInputs().find(n => n.props.multiple);
  await form.pick(upload, [pdf('scan-18mb.pdf', 18 * MB), pdf('license.pdf', 2048)]);
  const page = form.pageText();
  assert.ok(page.includes(BIG), page);
  assert.equal(rec.names().filter(n => n === 'analyzePDF').length, 1, 'only the small PDF was read');
  assert.ok(!form.nodes().some(n => form.text(n) === 'scan-18mb.pdf'), 'the large file is not staged to save');
  assert.ok(form.nodes().some(n => form.text(n) === 'license.pdf'), 'the small one is');
});

test('SYNC-013: the shared attach control refuses a file over 10 MB and stages only what fits', async () => {
  const rec = recorder();
  let staged = [];
  const attach = await mountComponent('src/components/features/DocAttach.jsx', {
    app: account(rec),
    props: { setForm: rec.fn('setForm'), attachedDocs: [], setAttachedDocs: u => { staged = typeof u === 'function' ? u(staged) : u; } },
    modules: { ...common(rec), docPrefill: { mergeExtracted: (p, e) => ({ ...p, ...e }), mergeScanned: p => ({ form: p }), findDuplicateDoc: () => null } },
  });
  const upload = attach.fileInputs().find(n => n.props.multiple);
  // Exactly 10 MB is inside the line, as on the Documents tab.
  await attach.pick(upload, [pdf('scan-18mb.pdf', 18 * MB), pdf('at-limit.pdf', 10 * MB)]);
  assert.ok(attach.pageText().includes(BIG), attach.pageText());
  assert.deepEqual(Array.from(staged, d => d.name), ['at-limit.pdf']);
});

// -- 2. A file Storage does not have is said so, with the way to fix it --
const MISSING = (linkedTo) => ({ id: 'doc-m', name: 'card.pdf', type: 'application/pdf', size: 2048, storagePath: 'user_synthetic/doc-m.pdf', fileMissing: true, linkedTo });
const assertMissingShown = (ui, rec) => {
  const page = ui.pageText();
  assert.doesNotMatch(page, /downloading from the cloud/, 'never "downloading" for a file Storage does not have');
  assert.ok(page.includes('card.pdf is missing from your account. Upload it again in Documents.'), page);
  const open = ui.nodes().find(n => n.type === 'button' && ui.text(n) === 'Open Documents');
  assert.ok(open, 'a way to the Documents tab, where it can be uploaded again');
  open.props.onClick();
  assert.deepEqual(rec.calls.filter(c => c[0] === 'navigate').map(c => c[1]), ['documents']);
};

test('SYNC-013: a license whose file is missing from Storage says so instead of "downloading"', async () => {
  const rec = recorder();
  const ui = await mountComponent('src/components/features/CrudSection.jsx', {
    app: account(rec, { documents: [MISSING('licenses:lic-1')] }),
    props: { title: 'Licenses', sectionKey: 'licenses', items: [{ id: 'lic-1', type: 'State Medical License', state: 'CO' }], fields: [{ key: 'type', label: 'Type' }], onShare() {}, onDelete() {}, autoViewId: 'lic-1', onAutoViewDone() {} },
    modules: {
      helpers, inboxDocs, documentBytes, lifecycle: await import('../src/utils/lifecycle.js'), actionButton: await import('../src/components/shared/actionButton.js'),
      caseBilling: await import('../src/utils/caseBilling.js'), formLayout: await import('../src/utils/formLayout.js'),
    },
  });
  assertMissingShown(ui, rec);
});

test('SYNC-013: a health record whose file is missing from Storage says so', async () => {
  const rec = recorder();
  const ui = await mountComponent('src/components/features/HealthRecordsSection.jsx', {
    app: account(rec, { documents: [MISSING('healthRecords:hr-1')], healthRecords: [{ id: 'hr-1', category: 'TB Test', name: 'Synthetic TB test' }] }),
    props: { onShare() {}, autoViewId: 'hr-1', onAutoViewDone() {} },
    modules: { helpers, inboxDocs, documentBytes, credentialTypes, sectionFields: await import('../src/utils/sectionFields.js') },
  });
  assertMissingShown(ui, rec);
});

test('SYNC-013: a screening whose file is missing from Storage says so', async () => {
  const rec = recorder();
  const ui = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: account(rec, { documents: [MISSING('screenings:scr-1')], screenings: [{ id: 'scr-1', type: 'Background Check', components: [] }] }),
    props: { onShare() {}, autoViewId: 'scr-1', onAutoViewDone() {} },
    modules: { helpers, inboxDocs, documentBytes, credentialTypes },
  });
  assertMissingShown(ui, rec);
});

test('a file still on its way keeps saying it is downloading', async () => {
  const rec = recorder();
  const ui = await mountComponent('src/components/features/ScreeningsSection.jsx', {
    app: account(rec, { documents: [{ ...MISSING('screenings:scr-1'), fileMissing: undefined }], screenings: [{ id: 'scr-1', type: 'Background Check', components: [] }] }),
    props: { onShare() {}, autoViewId: 'scr-1', onAutoViewDone() {} },
    modules: { helpers, inboxDocs, documentBytes, credentialTypes },
  });
  assert.match(ui.pageText(), /card\.pdf is downloading from the cloud; check back shortly/);
  assert.doesNotMatch(ui.pageText(), /missing from your account/);
});

// -- 3. The Contracts form's "Use a document already uploaded" picker --
// SYNC-013 step 4 repeats the check from Contracts. agreementDocCandidates
// read only d.data, so a file Storage does not have sat in the picker as
// "Still downloading to this device", disabled, for good. Since a load no
// longer downloads any file (2026-10-02), every stored file sat there the
// same way: one in the account is picked now and fetched as it is picked.
test('SYNC-013: the agreement picker says a file is missing; a stored file is picked and fetched from the account', async () => {
  const docPrefill = await import('../src/utils/docPrefill.js');
  const docs = [
    { id: 'gone', name: 'gone-agreement.pdf', type: 'application/pdf', size: 2048, storagePath: 'user_synthetic/gone.pdf', fileMissing: true, linkedTo: '' },
    { id: 'coming', name: 'coming-agreement.pdf', type: 'application/pdf', size: 2048, storagePath: 'user_synthetic/coming.pdf', linkedTo: '' },
    { id: 'here', name: 'here-agreement.pdf', type: 'application/pdf', size: 2048, data: 'data:application/pdf;base64,AAA', fileMissing: true, linkedTo: '' },
  ];
  const cands = docPrefill.agreementDocCandidates(docs);
  const byId = Object.fromEntries(cands.map(c => [c.doc.id, c]));
  assert.equal(byId.gone.missing, true, 'Storage has no file and this device has no bytes');
  assert.equal(byId.coming.missing, false, 'in the account');
  assert.equal(byId.coming.ready, true, 'fetched when picked');
  assert.equal(byId.here.missing, false, 'bytes on this device can still be read');
  assert.equal(byId.here.ready, true);

  const rec = recorder();
  let staged = [];
  const fetched = [];
  const attach = await mountComponent('src/components/features/DocAttach.jsx', {
    app: account(rec, { documents: docs }),
    props: { setForm: rec.fn('setForm'), attachedDocs: [], setAttachedDocs: u => { staged = typeof u === 'function' ? u(staged) : u; }, existingDocs: cands },
    modules: {
      ...common(rec), docPrefill, storedBytes: await import('../src/utils/storedBytes.js'),
      supabase: { downloadDocumentFile: async (path, o) => { fetched.push([path, o]); return { dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=' }; } },
    },
  });
  const toggle = attach.nodes().find(n => n.type === 'button' && attach.text(n) === 'Use a document already uploaded');
  assert.ok(toggle);
  toggle.props.onClick();
  attach.render();
  const row = id => attach.nodes().find(n => n.type === 'button' && attach.text(n).includes(id));
  const gone = row('gone-agreement.pdf');
  assert.ok(gone, attach.pageText());
  assert.match(attach.text(gone), /Missing from your account\. Upload it again in Documents\./);
  assert.doesNotMatch(attach.text(gone), /Still downloading/);
  assert.equal(gone.props.disabled, true, 'a missing file cannot be picked');
  const coming = row('coming-agreement.pdf');
  assert.doesNotMatch(attach.text(coming), /Still downloading|Missing from your account/);
  assert.equal(coming.props.disabled, false, 'a file in the account can be picked');
  assert.equal(row('here-agreement.pdf').props.disabled, false);
  // Picked: fetched from the account, staged with its bytes, read into the form.
  await coming.props.onClick();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(fetched.map(([path]) => path), ['user_synthetic/coming.pdf']);
  assert.equal(JSON.stringify(staged.map(d => [d.existingId, d.data])), JSON.stringify([['coming', 'data:application/pdf;base64,JVBERi0xLjQ=']]));
  assert.equal(rec.names().filter(n => n === 'analyzePDF').length, 1, 'read into the form');
});

test('SYNC-013: a stored file that cannot be fetched when picked is said, and nothing is staged', async () => {
  const docPrefill = await import('../src/utils/docPrefill.js');
  const docs = [{ id: 'coming', name: 'coming-agreement.pdf', type: 'application/pdf', size: 2048, storagePath: 'user_synthetic/coming.pdf', linkedTo: '' }];
  const rec = recorder();
  let staged = [];
  const attach = await mountComponent('src/components/features/DocAttach.jsx', {
    app: account(rec, { documents: docs }),
    props: { setForm: rec.fn('setForm'), attachedDocs: [], setAttachedDocs: u => { staged = typeof u === 'function' ? u(staged) : u; }, existingDocs: docPrefill.agreementDocCandidates(docs) },
    modules: { ...common(rec), docPrefill, storedBytes: await import('../src/utils/storedBytes.js'), supabase: { downloadDocumentFile: async () => ({ failed: true }) } },
  });
  attach.nodes().find(n => n.type === 'button' && attach.text(n) === 'Use a document already uploaded').props.onClick();
  await attach.nodes().find(n => n.type === 'button' && attach.text(n).includes('coming-agreement.pdf')).props.onClick();
  await new Promise(r => setTimeout(r, 0));
  assert.match(attach.pageText(), /"coming-agreement\.pdf" could not be fetched from your account\. Check your connection and try again\./);
  assert.equal(staged.length, 0);
  assert.equal(rec.names().filter(n => n === 'analyzePDF').length, 0);
});

// -- 4. The record's edit form, "Documents already linked" --
// SYNC-013 step 1 is "edit > attach". The view said a missing file was
// missing, but tapping Edit showed the same row as an hourglass and
// "syncing…" for the whole session, and a tap on it did nothing.
test('SYNC-013: the edit form says a linked file is missing, not "syncing"', async () => {
  const rec = recorder();
  const ui = await mountComponent('src/components/features/CrudSection.jsx', {
    app: account(rec, { documents: [MISSING('licenses:lic-1'), { ...MISSING('licenses:lic-1'), id: 'doc-c', name: 'coming.pdf', fileMissing: undefined }] }),
    props: { title: 'Licenses', sectionKey: 'licenses', items: [{ id: 'lic-1', type: 'State Medical License', state: 'CO' }], fields: [{ key: 'type', label: 'Type' }], onShare() {}, onDelete() {}, onEdit() { return true; }, autoViewId: 'lic-1', onAutoViewDone() {} },
    modules: {
      ...common(rec), helpers, lifecycle: await import('../src/utils/lifecycle.js'), actionButton: await import('../src/components/shared/actionButton.js'),
      caseBilling: await import('../src/utils/caseBilling.js'), formLayout: await import('../src/utils/formLayout.js'),
      docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) },
    },
  });
  const edit = ui.nodes().find(n => n.type === 'button' && ui.text(n) === 'Edit');
  assert.ok(edit, ui.pageText());
  edit.props.onClick();
  ui.render();
  const rowOf = name => ui.nodes().find(n => n.type === 'div' && n.key === name);
  const gone = rowOf('doc-m');
  assert.ok(gone, ui.pageText());
  assert.match(ui.text(gone), /card\.pdf/);
  assert.match(ui.text(gone), /Missing from your account\. Upload it again in Documents\./);
  assert.doesNotMatch(ui.text(gone), /syncing/);
  // A file still on its way keeps its "syncing" row.
  const coming = rowOf('doc-c');
  assert.ok(coming, ui.pageText());
  assert.match(ui.text(coming), /syncing/);
  assert.doesNotMatch(ui.text(coming), /Missing from your account/);
});

// The Expenses bundle is built once per file: a second build re-runs jsPDF's
// module setup, which throws under node.
let expenseBundle;
const expenseScreens = () => (expenseBundle ||= import('./harness/component-harness.mjs')
  .then(h => h.loadScreens('export {default as Expenses} from "./src/components/features/locum/Expenses.jsx";')));

// -- 5. Expense receipts, the same 10 MB line --
// Expenses.stageFiles read any image or PDF whole; saveExpense filed it as a
// documents row the bucket (15 MB) would refuse, and the bytes stayed queued
// on the device with no word to the member.
test('SYNC-013: an expense refuses a receipt over 10 MB before reading it, and keeps the others', async () => {
  const { mount, nodes, textOf, click } = await import('./harness/component-harness.mjs');
  const screens = await expenseScreens();
  const realReader = globalThis.FileReader;
  const read = [];
  globalThis.FileReader = class { readAsDataURL(file) { read.push(file.name); file.arrayBuffer().then(b => { this.onload?.({ target: { result: `data:${file.type};base64,${Buffer.from(b.slice(0, 16)).toString('base64')}` } }); }); } };
  try {
    const m = mount(screens.Expenses, { data: { locumContracts: [], documents: [] } });
    click(m, '+ Expense');
    const upload = nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'file' && n.props.multiple);
    upload.props.onChange({ target: { files: [pdf('scan-18mb.pdf', 18 * MB), pdf('at-limit.pdf', 10 * MB), new File([new Uint8Array([1, 2, 3])], 'synthetic-receipt.jpg', { type: 'image/jpeg' })], value: '' } });
    // Each receipt is read from a real File (another thread), one after the
    // other: wait for the reads, bounded, not a fixed number of turns.
    await settleOutcome(20);
    const page = textOf(m.render());
    assert.ok(page.includes(BIG), page);
    assert.deepEqual(read, ['at-limit.pdf', 'synthetic-receipt.jpg'], 'the large receipt was never read');
    assert.match(page, /at-limit\.pdf/);
    assert.match(page, /synthetic-receipt\.jpg/);
    assert.doesNotMatch(page.split(BIG).join(''), /scan-18mb\.pdf/, 'the large receipt is not staged to save (the notice shows on the page and on the form)');
  } finally { globalThis.FileReader = realReader; }
});

// -- 6. Expense receipts: both refusals in one tap are said --
// stageFiles called showNotice for the 10 MB refusal and then again for the
// 2 GB quota in the same tap; the second replaced the first, so the member
// freed space, picked the same files again, and only then learned the scan
// was over 10 MB.
test('SYNC-013: an expense says both the 10 MB refusal and the 2 GB refusal from one pick', async () => {
  const { mount, nodes, textOf, click } = await import('./harness/component-harness.mjs');
  const screens = await expenseScreens();
  const realReader = globalThis.FileReader;
  const read = [];
  globalThis.FileReader = class { readAsDataURL(file) { read.push(file.name); this.onload?.({ target: { result: `data:${file.type};base64,AAAA` } }); } };
  try {
    const nearlyFull = { id: 'doc-full', name: 'synthetic-archive.pdf', type: 'application/pdf', size: 2 * 1024 * MB - MB, uploadedAt: '2026-01-01T00:00:00.000Z' };
    const m = mount(screens.Expenses, { data: { locumContracts: [], documents: [nearlyFull] } });
    click(m, '+ Expense');
    const upload = nodes(m.render()).find(n => n.type === 'input' && n.props.type === 'file' && n.props.multiple);
    upload.props.onChange({ target: { files: [pdf('scan-18mb.pdf', 18 * MB), pdf('synthetic-receipt.pdf', 2 * MB)], value: '' } });
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    const page = textOf(m.render());
    assert.ok(page.includes(BIG), page);
    assert.match(page, /"synthetic-receipt\.pdf" \(2\.0 MB\) would bring your documents to .*past the 2\.0 GB/);
    assert.deepEqual(read, [], 'nothing is read when the quota refuses the batch');
  } finally { globalThis.FileReader = realReader; }
});
