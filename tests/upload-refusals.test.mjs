// What the physician sees when an upload is refused, driven through the real
// components (tests/component-harness.mjs). Every file here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as photoOrPdf from '../src/utils/photoOrPdf.js';
import { mountComponent } from './component-harness.mjs';

const caseLog = () => new File(['Date,CPT,MRN\n2025-01-06,61510,000000\n'], 'caselog.csv', { type: 'text/csv' });
const licensePdf = () => new File(['%PDF-1.4 synthetic'], 'license.pdf', { type: 'application/pdf' });
const cardPhoto = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'card.jpg', { type: 'image/jpeg' });
const REFUSAL = `"caselog.csv" was not attached. ${guard.spreadsheetRefusal('MRN')}`;

function recorder() {
  const calls = [];
  const fn = name => (...args) => { calls.push([name, ...args]); };
  return { calls, fn, names: () => calls.map(c => c[0]) };
}

const account = (rec, over = {}) => ({
  data: { settings: {}, documents: [], followUps: [], locumContracts: [], deductibles: [] },
  theme: {}, user: { id: 'user_synthetic' }, isDesktop: false,
  addItem: rec.fn('addItem'), editItem: rec.fn('editItem'), setData: rec.fn('setData'), toggleFavorite: rec.fn('toggleFavorite'),
  ...over,
});
const scanner = rec => ({
  analyzePDF: async (...a) => { rec.calls.push(['analyzePDF', ...a]); return { extracted: { licenseNumber: 'A12345', expirationDate: '2027-06-30' } }; },
  analyzeDocument: async (...a) => { rec.calls.push(['analyzeDocument', ...a]); return { extracted: { expirationDate: '2027-06-30' } }; },
  analyzeDocText: async (...a) => { rec.calls.push(['analyzeDocText', ...a]); return null; },
  analyzeStatement: async (...a) => { rec.calls.push(['analyzeStatement', ...a]); return []; },
});
const common = rec => ({
  spreadsheetGuard: guard, photoOrPdf,
  aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.', aiAvailable: () => false },
  storageQuota: { checkStorageQuota: () => ({ ok: true }) },
  officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*' },
  documentScanner: scanner(rec),
});

// -- A refusal in a multi-file pick --
test('a record form keeps the spreadsheet refusal on screen when the next file in the pick fills fields', async () => {
  const rec = recorder();
  const form = await mountComponent('src/components/features/CrudSection.jsx', {
    app: account(rec),
    props: { title: 'Licenses', sectionKey: 'licenses', items: [], fields: [{ key: 'licenseNumber', label: 'License Number' }], autoOpen: true, onAutoOpenDone() {} },
    modules: { ...common(rec), docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) } },
  });
  const upload = form.fileInputs().find(n => n.props.multiple);
  assert.ok(upload, 'the form has its multi-file upload');
  await form.pick(upload, [caseLog(), licensePdf()]);
  assert.ok(rec.names().includes('analyzePDF'), 'the PDF was read');
  const page = form.pageText();
  assert.ok(page.includes(REFUSAL), 'the refusal is still on screen');
  assert.match(page, /2 fields filled\./, 'and so is what the PDF filled');
  assert.ok(page.indexOf(REFUSAL) < page.indexOf('2 fields filled.'), 'the refusal comes first');
  assert.ok(!form.nodes().some(n => form.text(n) === 'caselog.csv'), 'the case log is not staged for upload');
});

test('the shared attach control keeps every refusal in the pick after a later file is read', async () => {
  const rec = recorder();
  let staged = [];
  const attach = await mountComponent('src/components/features/DocAttach.jsx', {
    app: account(rec),
    props: { setForm: rec.fn('setForm'), attachedDocs: [], setAttachedDocs: u => { staged = typeof u === 'function' ? u(staged) : u; } },
    modules: { ...common(rec), docPrefill: { mergeExtracted: (p, e) => ({ ...p, ...e }), mergeScanned: p => ({ form: p }), findDuplicateDoc: () => null } },
  });
  const upload = attach.fileInputs().find(n => n.props.multiple);
  const secondLog = new File(['Date,Patient Last Name\n2025-01-06,Synthetic\n'], 'billing.csv', { type: 'text/csv' });
  await attach.pick(upload, [caseLog(), licensePdf(), secondLog, licensePdf()]);
  assert.equal(rec.names().filter(n => n === 'analyzePDF').length, 2);
  const page = attach.pageText();
  assert.ok(page.includes(REFUSAL), page);
  assert.ok(page.includes(`"billing.csv" was not attached. ${guard.spreadsheetRefusal('Patient Last Name')}`), 'a second refusal is kept too');
  assert.match(page, /Document read, fields auto-filled\./);
  assert.deepEqual(Array.from(staged, d => d.name), ['license.pdf', 'license.pdf'], 'only the PDFs are staged');
});

// -- Card statement import reads on the device and stores no file --
async function statementImport(rec) {
  return mountComponent('src/components/features/locum/StatementImport.jsx', {
    app: account(rec), props: { open: true, onClose() {} },
    modules: { ...common(rec), xlsx: XLSX, helpers: { generateId: () => 'synthetic-id' } },
  });
}

test('a card statement with the bank\'s account-number lines above the table imports', async () => {
  const rec = recorder();
  const s = await statementImport(rec);
  const csv = 'Account Number:,XXXX0000\nStatement Period:,Sep 2026\nDate,Description,Amount\n09/02/2026,MARRIOTT DENVER,-212.40\n09/03/2026,UNITED AIRLINES,-389.00\n';
  await s.pick(s.fileInputs()[0], [new File([csv], 'statement.csv', { type: 'text/csv' })]);
  let page = s.pageText();
  assert.doesNotMatch(page, /This spreadsheet has/, 'not refused');
  assert.match(page, /MARRIOTT DENVER/);
  assert.match(page, /UNITED AIRLINES/);

  // An Amex export whose header says "Account #": same, in Excel.
  const s2 = await statementImport(rec);
  const ws = XLSX.utils.aoa_to_sheet([['Date', 'Description', 'Card Member', 'Account #', 'Amount'], ['09/02/2026', 'HERTZ DENVER', 'SYNTHETIC', '-00000', '88.10']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Activity');
  await s2.pick(s2.fileInputs()[0], [new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'activity.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })]);
  page = s2.pageText();
  assert.doesNotMatch(page, /This spreadsheet has/);
  assert.match(page, /HERTZ DENVER/);
  assert.ok(!rec.names().includes('analyzeStatement'), 'nothing went to the AI');

  // A headerless export keeps every row, even one whose merchant reads like a header.
  const s3 = await statementImport(rec);
  const headerless = '09/01/2026,STARBUCKS DENVER,-6.10\n09/02/2026,UPDATE NAME SERVICE AMOUNT,-9.99\n09/03/2026,HYATT DENVER,-180.00\n';
  await s3.pick(s3.fileInputs()[0], [new File([headerless], 'headerless.csv', { type: 'text/csv' })]);
  page = s3.pageText();
  for (const m of ['STARBUCKS DENVER', 'UPDATE NAME SERVICE AMOUNT', 'HYATT DENVER']) assert.ok(page.includes(m), m);
});

test('a statement spreadsheet that would go to the AI reader still passes the guard first', async () => {
  const rec = recorder();
  const s = await statementImport(rec);
  // A .tsv the browser gives no type for is not parsed here; it goes to the AI.
  await s.pick(s.fileInputs()[0], [new File(['Date\tPatient Name\tAmount\n2026-09-02\tSynthetic\t10\n'], 'statement.tsv', { type: '' })]);
  assert.ok(s.pageText().includes(guard.spreadsheetRefusal('Patient Name')));
  assert.ok(!rec.names().includes('analyzeStatement'), 'the file never reached the AI');
});

// -- Setup capture: a photo or a PDF only --
const setupModules = rec => ({
  ...common(rec),
  docPrefill: { mergeExtracted: (r, p) => ({ ...r, ...p }), findDuplicateDoc: () => null, attachExistingDoc: () => null },
  helpers: { generateId: () => 'synthetic-doc' },
  phiGuard: { screenDocument: () => null, phiWarningText: () => '' },
});
const LICENSE = { id: 'L1', state: 'CO', licenseNumber: 'SYN-1' };

test('the date strip refuses a spreadsheet picked through "All files" before reading or storing it', async () => {
  const rec = recorder();
  const row = await mountComponent('src/components/features/setup/DateFixList.jsx', {
    exportName: 'DateRow', app: account(rec), props: { rec: LICENSE, onCaptured: rec.fn('onCaptured') }, modules: setupModules(rec),
  });
  const [, filePicker] = row.fileInputs();
  await row.pick(filePicker, [caseLog()]);
  assert.deepEqual(rec.names(), [], 'nothing read, scanned or stored');
  assert.ok(row.pageText().includes(photoOrPdf.notPhotoOrPdf(caseLog())));

  // The control: a photo of the card is read and stored, linked to the record.
  await row.pick(filePicker, [cardPhoto()]);
  assert.ok(rec.names().includes('analyzeDocument'));
  const stored = rec.calls.find(c => c[0] === 'addItem' && c[1] === 'documents');
  assert.ok(stored, 'the photo is stored');
  assert.equal(stored[2].linkedTo, 'licenses:L1');
});

test('the capture run pauses on a spreadsheet and never stages it', async () => {
  const rec = recorder();
  const run = await mountComponent('src/components/features/setup/CaptureRun.jsx', {
    app: account(rec), props: { section: 'licenses', records: [LICENSE], onExit() {} }, modules: setupModules(rec),
  });
  run.nodes().find(n => n.type === 'button' && /^Start/.test(run.text(n))).props.onClick();
  const [, filePicker] = run.fileInputs();
  await run.pick(filePicker, [caseLog()]);
  assert.deepEqual(rec.names(), [], 'nothing read, scanned or stored');
  const page = run.pageText();
  assert.ok(page.includes(photoOrPdf.notPhotoOrPdf(caseLog())), page);
  assert.match(page, /The run is paused here\./);

  run.nodes().find(n => n.type === 'button' && run.text(n) === 'Try another file').props.onClick();
  await run.pick(run.fileInputs()[1], [licensePdf()]);
  assert.ok(rec.names().includes('analyzePDF'), 'a PDF goes ahead');
});

test('a photo or a PDF is recognised by type, or by extension when the browser gives none', () => {
  for (const f of [{ name: 'a.jpg', type: 'image/jpeg' }, { name: 'x', type: 'image/heic' }, { name: 'l.pdf', type: 'application/pdf' }, { name: 'card.HEIC', type: '' }, { name: 'scan.pdf', type: '' }]) {
    assert.equal(photoOrPdf.isPhotoOrPdf(f), true, f.name);
  }
  for (const f of [{ name: 'caselog.csv', type: 'text/csv' }, { name: 'log.xlsx', type: '' }, { name: 'card.jpg', type: 'text/csv' }, { name: 'notes.txt', type: 'text/plain' }, {}]) {
    assert.equal(photoOrPdf.isPhotoOrPdf(f), false, f.name);
  }
  assert.doesNotMatch(photoOrPdf.notPhotoOrPdf({ name: 'x.csv' }), /\u{2014}/u);
});
