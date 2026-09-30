// Smart Scan (src/components/features/DocumentsSection.jsx), driven through
// the real component with synthetic hooks (tests/component-harness.mjs).
// Every file, record and name here is synthetic.
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
import { mountComponent } from './component-harness.mjs';

function recorder() {
  const calls = [];
  const fn = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  return { calls, fn, names: () => calls.map(c => c[0]), of: name => calls.filter(c => c[0] === name) };
}

const baseData = over => ({
  settings: { degreeType: 'MD' }, documents: [], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [],
  locumContracts: [], travelExpenses: [], deductibles: [], customCategories: [], customRecords: [], screenings: [],
  ...over,
});

async function smartScan(rec, { data = {}, modules = {} } = {}) {
  return mountComponent('src/components/features/DocumentsSection.jsx', {
    app: {
      data: baseData(data), theme: {}, userIdRef: { current: 'user_synthetic' },
      addItem: rec.fn('addItem'), editItem: rec.fn('editItem'), deleteItem: rec.fn('deleteItem'),
      setData: rec.fn('setData'), updateSettings: rec.fn('updateSettings'), navigate: rec.fn('navigate'),
    },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, helpers, spreadsheetGuard: guard, phiGuard, customCategories,
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: f => /\.(docx?|xlsx?|csv|txt|rtf)$/i.test(f?.name || ''), UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      // The shared input style, as the app builds it (16px so iOS never zooms).
      useInputStyle: { useInputStyle: () => ({ width: '100%', fontSize: 16 }) },
      ...modules,
    },
  });
}

const LICENSE = { id: 'lic-1', type: 'State Medical License', state: 'CO', licenseNumber: 'SYN-0001' };
const POLICY = { id: 'ins-1', type: 'Malpractice', carrier: 'Synthetic Mutual' };
const pdfDoc = over => ({ id: 'doc-1', name: 'license.pdf', type: 'application/pdf', size: 2048, uploadedAt: '2026-09-01T10:00:00Z', data: 'data:application/pdf;base64,JVBERi0=', ...over });

const selects = ui => ui.nodes().filter(n => n.type === 'select');
const optionValues = sel => [sel.props.children].flat(Infinity).filter(o => o && o.type === 'option').map(o => o.props.value);

// -- DOCS-008: a linked document can be moved or unlinked --
test('a linked document keeps its link picker, showing the current link, and can be moved to another record', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { data: { licenses: [LICENSE], insurance: [POLICY], documents: [pdfDoc({ linkedTo: 'licenses:lic-1' })] } });
  const [sel] = selects(ui);
  assert.ok(sel, 'a linked card still offers the link picker');
  assert.equal(sel.props.value, 'licenses:lic-1', 'the current link is the selected option');
  assert.ok(optionValues(sel).includes(''), 'an Unlinked option is offered');
  assert.ok(optionValues(sel).includes('insurance:ins-1'), 'another record is offered');
  assert.ok(ui.pageText().includes('Unlinked'), 'the empty option reads Unlinked on a linked file');
  sel.props.onChange({ target: { value: 'insurance:ins-1' } });
  const [, key, written] = rec.of('editItem').at(-1);
  assert.equal(key, 'documents');
  assert.equal(written.linkedTo, 'insurance:ins-1');
  assert.ok(!ui.pageText().includes('File with AI'), 'File with AI stays for unlinked files only');
});

test('a linked document can be set back to unlinked, and its type is left alone', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { data: { licenses: [LICENSE], documents: [pdfDoc({ linkedTo: 'licenses:lic-1' })] } });
  selects(ui)[0].props.onChange({ target: { value: '' } });
  const [, , written] = rec.of('editItem').at(-1);
  assert.equal(written.linkedTo, '');
  assert.equal(written.type, 'application/pdf');
});

test('a link the picker does not list (a custom record) still shows as the current option', async () => {
  const rec = recorder();
  const record = { id: 'cr-1', categoryId: 'cat-1', categoryName: 'Synthetic Permits', documentIds: ['doc-1'] };
  const ui = await smartScan(rec, { data: { customRecords: [record], licenses: [LICENSE], documents: [pdfDoc({ linkedTo: 'customRecords:cr-1' })] } });
  const [sel] = selects(ui);
  assert.equal(sel.props.value, 'customRecords:cr-1');
  assert.ok(optionValues(sel).includes('customRecords:cr-1'), 'the current link is an option, so the select does not read as unlinked');
  // Moving it off a custom record takes the file out of that record's
  // documentIds too; otherwise the next load restores the old link.
  sel.props.onChange({ target: { value: 'licenses:lic-1' } });
  const recordEdit = rec.of('editItem').find(c => c[1] === 'customRecords');
  assert.ok(recordEdit, 'the custom record is edited');
  assert.deepEqual(recordEdit[2].documentIds, []);
});

test('a file linked to Protected Identity is never offered a move into a shareable section', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { data: { licenses: [LICENSE], documents: [pdfDoc({ linkedTo: 'identityVault:v-1' })] } });
  assert.equal(selects(ui).length, 0);
});

test('an unlinked document still offers File with AI and the picker', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { data: { licenses: [LICENSE], documents: [pdfDoc({ linkedTo: '' })] } });
  assert.ok(ui.pageText().includes('File with AI'));
  const [sel] = selects(ui);
  assert.equal(sel.props.value, '');
  assert.ok(ui.pageText().includes('Link to credential...'));
  assert.equal(sel.props.style.fontSize, 16, 'a phone never zooms into the picker');
});

// -- DOCS-001: every refusal in a multi-file pick stays on screen --
const caseLog = () => new File(['Date,CPT,MRN\n2025-01-06,61510,000000\n'], 'caselog.csv', { type: 'text/csv' });
const bigPdf = () => new File([new Uint8Array(12 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' });

test('Smart Scan keeps the spreadsheet refusal on screen when a later file in the pick is refused too', async () => {
  const rec = recorder();
  const ui = await smartScan(rec);
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [caseLog(), bigPdf()]);
  const page = ui.pageText();
  const csvRefusal = `"caselog.csv" was not uploaded. ${guard.spreadsheetRefusal('MRN')}`;
  assert.ok(page.includes(csvRefusal), page);
  assert.ok(page.includes('"big.pdf" exceeds the 10 MB size limit.'), page);
  assert.equal(rec.of('addItem').length, 0, 'neither file was stored');
});

test('a refusal comes before what a later readable file said', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { modules: { documentScanner: {
    analyzePDF: async () => { throw new Error('Analysis failed. Document has been saved to your files.'); },
    analyzeDocument: async () => ({}), analyzeDocText: async () => ({}), CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
  } } });
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [caseLog(), new File(['%PDF-1.4 synthetic'], 'license.pdf', { type: 'application/pdf' })]);
  const page = ui.pageText();
  const csvRefusal = `"caselog.csv" was not uploaded. ${guard.spreadsheetRefusal('MRN')}`;
  assert.ok(page.includes(csvRefusal), page);
  assert.ok(page.includes('Analysis failed.'), page);
  assert.ok(page.indexOf(csvRefusal) < page.indexOf('Analysis failed.'));
});

test('the over-ten notice survives the pick', async () => {
  const rec = recorder();
  const ui = await smartScan(rec);
  const upload = ui.fileInputs().find(n => n.props.multiple);
  const many = Array.from({ length: 11 }, (_, i) => new File([new Uint8Array(11 * 1024 * 1024)], `big${i}.pdf`, { type: 'application/pdf' }));
  await ui.pick(upload, many);
  assert.ok(ui.pageText().includes('Only the first 10 files will be processed.'), ui.pageText());
});

// Each refusal is said once. The running list refuse() puts up as it goes is
// not one of the refusals, so the end-of-pick message used to repeat it:
// "R1 R2 R1 R2", and "R1 R2 stop R1 R2" when a later file was not saved.
const times = (page, s) => page.split(s).length - 1;
const CSV_REFUSAL = () => `"caselog.csv" was not uploaded. ${guard.spreadsheetRefusal('MRN')}`;
const BIG_REFUSAL = '"big.pdf" exceeds the 10 MB size limit.';

test('with two refusals in one pick, each is on screen exactly once', async () => {
  const rec = recorder();
  const ui = await smartScan(rec);
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [caseLog(), bigPdf()]);
  const page = ui.pageText();
  assert.equal(times(page, CSV_REFUSAL()), 1, page);
  assert.equal(times(page, BIG_REFUSAL), 1, page);
});

test('a pick stopped by a file that was not saved says each earlier refusal once, then why it stopped', async () => {
  const rec = recorder();
  const fn = rec.fn;
  rec.fn = (name, ret) => fn(name, name === 'addItem' ? false : ret); // the save is refused
  const ui = await smartScan(rec);
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [caseLog(), bigPdf(), new File(['%PDF-1.4 synthetic'], 'license.pdf', { type: 'application/pdf' })]);
  const page = ui.pageText();
  const stop = '"license.pdf" was not saved, so it was not read. Nothing was changed.';
  assert.equal(times(page, CSV_REFUSAL()), 1, page);
  assert.equal(times(page, BIG_REFUSAL), 1, page);
  assert.equal(times(page, stop), 1, page);
  assert.ok(page.indexOf(CSV_REFUSAL()) < page.indexOf(BIG_REFUSAL) && page.indexOf(BIG_REFUSAL) < page.indexOf(stop), page);
});

// -- DOCS-001: a generic MIME type is judged by the file's name --
const GENERIC = 'application/octet-stream';
const readingScanner = rec => ({
  analyzePDF: async (url) => { rec.calls.push(['analyzePDF', url]); return { documentType: 'license', extracted: {} }; },
  analyzeDocument: async (url) => { rec.calls.push(['analyzeDocument', url]); return { documentType: 'license', extracted: {} }; },
  analyzeDocText: async (text) => { rec.calls.push(['analyzeDocText', text]); return { documentType: 'license', extracted: {} }; },
  CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
});

test('a file the picker calls application/octet-stream is refused unless its name is a type the app reads', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { modules: { documentScanner: readingScanner(rec) } });
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [new File(['synthetic'], 'archive.bin', { type: GENERIC })]);
  assert.equal(rec.of('addItem').length, 0, 'not stored');
  assert.ok(ui.pageText().includes(`"archive.bin" isn't a file type this app reads`), ui.pageText());
});

test('a PDF or Word file with a generic type is stored as what its name says, and read', async () => {
  const rec = recorder();
  const ui = await smartScan(rec, { modules: { documentScanner: readingScanner(rec) } });
  const upload = ui.fileInputs().find(n => n.props.multiple);
  await ui.pick(upload, [new File(['%PDF-1.4 synthetic'], 'license.pdf', { type: GENERIC }), new File(['synthetic docx'], 'letter.docx', { type: GENERIC })]);
  const stored = rec.of('addItem').filter(c => c[1] === 'documents').map(c => c[2]);
  assert.deepEqual(stored.map(d => d.type), ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
  assert.ok(stored[0].data.startsWith('data:application/pdf;base64,'), 'the bytes say what they are');
  const pdfRead = rec.of('analyzePDF');
  assert.equal(pdfRead.length, 1, 'the PDF was read');
  assert.ok(pdfRead[0][1].startsWith('data:application/pdf;base64,'));
  assert.equal(rec.of('analyzeDocText').length, 1, 'the Word file was read');
});

// -- DOCS-002: filing a credential says where it went, with a way to open it --
const HOME_SECTIONS = { SECTIONS: [
  { key: 'licenses', label: 'Licenses & certs', tab: 'credentials', sub: 'licenses' },
  { key: 'insurance', label: 'Insurance', tab: 'credentials', sub: 'insurance' },
  { key: 'locumContracts', label: 'Contracts', tab: 'locum', sub: 'contracts' },
] };

async function reviewAndSave(docType, fields, { ids = ['new-rec'] } = {}) {
  const rec = recorder();
  const scanner = {
    analyzePDF: async () => ({ documentType: docType, extracted: fields }), analyzeDocument: async () => ({}), analyzeDocText: async () => ({}),
    CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
  };
  let n = 0;
  const ui = await smartScan(rec, { modules: { documentScanner: scanner, HomeSearch: HOME_SECTIONS, helpers: { ...helpers, generateId: () => ids[n++] || `id-${n}` } } });
  const upload = ui.fileInputs().find(x => x.props.multiple);
  await ui.pick(upload, [new File(['%PDF-1.4 synthetic'], 'scan.pdf', { type: 'application/pdf' })]);
  const card = ui.nodes().find(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard');
  assert.ok(card, 'a review card is shown');
  card.props.onSave(docType, fields, null, 'scan.pdf');
  ui.render();
  return { ui, rec };
}

test('filing a licence shows a Saved banner whose button opens the new record', async () => {
  const { ui, rec } = await reviewAndSave('license', { type: 'State Medical License', state: 'CO' }, { ids: ['doc-a', 'lic-new'] });
  assert.ok(rec.of('addItem').some(c => c[1] === 'licenses' && c[2].id === 'lic-new'));
  const page = ui.pageText();
  assert.match(page, /Saved to /, page);
  const open = ui.nodes().find(x => x.type === 'button' && /^Open /.test(ui.text(x)));
  assert.ok(open, 'an Open button');
  open.props.onClick();
  const nav = rec.of('navigate').at(-1);
  assert.equal(JSON.stringify(nav.slice(1)), JSON.stringify(['credentials', 'licenses', { sec: 'licenses', id: 'lic-new' }]));
});

test('filing a contract opens it under Work, not Credentials', async () => {
  const { ui, rec } = await reviewAndSave('agreement', { facility: 'Synthetic Hospital' }, { ids: ['doc-b', 'con-new'] });
  const open = ui.nodes().find(x => x.type === 'button' && /^Open /.test(ui.text(x)));
  open.props.onClick();
  assert.equal(JSON.stringify(rec.of('navigate').at(-1).slice(1)), JSON.stringify(['locum', 'contracts', { sec: 'locumContracts', id: 'con-new' }]));
});

// -- DOCS-006: a receipt billed to an agency names the tab it went to --
// The expense lands on Practice > Exp. ("Open Expenses" opens it there); the
// banner said "Work > Expenses", and Work is a separate Practice tab, so a
// member following the words found nothing there.
test('a receipt billed to an agency says it went to Practice > Expenses, and Open Expenses opens it', async () => {
  const receiptScan = await import('../src/utils/receiptScan.js');
  const rec = recorder();
  const scanner = {
    analyzePDF: async () => ({ documentType: 'receipt', extracted: {} }), analyzeDocument: async () => ({}), analyzeDocText: async () => ({}),
    CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
  };
  const ids = ['doc-r', 'exp-new'];
  let n = 0;
  const ui = await smartScan(rec, {
    data: { locumContracts: [{ id: 'K1', facility: 'Synthetic Regional', agency: 'Synthetic Staffing', startDate: '2026-08-01', endDate: '2027-01-31' }] },
    modules: { documentScanner: scanner, receiptScan, helpers: { ...helpers, generateId: () => ids[n++] || `id-${n}` } },
  });
  await ui.pick(ui.fileInputs().find(x => x.props.multiple), [new File(['%PDF-1.4 synthetic'], 'ride.pdf', { type: 'application/pdf' })]);
  const card = ui.nodes().find(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard');
  assert.ok(card, 'a review card is shown');
  card.props.onSave('receipt', { merchant: 'Synthetic Rides', category: 'Rideshare / Taxi', total: '42.50', date: '2026-09-20', destination: 'expense', agency: 'Synthetic Staffing' }, null, 'ride.pdf');
  ui.render();
  const saved = rec.of('addItem').find(c => c[1] === 'travelExpenses');
  assert.ok(saved, 'the expense row was written');
  const page = ui.pageText();
  assert.match(page, /Saved Rideshare \/ Taxi, Synthetic Rides, \$42\.50 to Practice > Expenses, billable to Synthetic Staffing\./, page);
  assert.doesNotMatch(page, /Work > /, 'Work is another Practice tab');
  const open = ui.nodes().find(x => x.type === 'button' && ui.text(x) === 'Open Expenses');
  assert.ok(open, 'an Open Expenses button');
  open.props.onClick();
  assert.equal(JSON.stringify(rec.of('navigate').at(-1).slice(1, 3)), JSON.stringify(['locum', 'expenses']));
});

// -- DOCS-003: File with AI screens what it read, as the upload path does --
const CHART = { documentType: 'other', extracted: { notes: 'Operative note for the patient. Medical record number 000000. Discharge summary to follow.' } };

async function rescan(result, { confirm = true } = {}) {
  const rec = recorder();
  const scanner = {
    analyzePDF: async () => result, analyzeDocument: async () => result, analyzeDocText: async () => result,
    CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other',
  };
  const ui = await mountComponent('src/components/features/DocumentsSection.jsx', {
    app: {
      data: baseData({ documents: [pdfDoc({ id: 'doc-9', name: 'scan.pdf', linkedTo: '' })] }), theme: {}, userIdRef: { current: 'user_synthetic' },
      addItem: rec.fn('addItem'), editItem: rec.fn('editItem'), deleteItem: rec.fn('deleteItem'),
      setData: rec.fn('setData'), updateSettings: rec.fn('updateSettings'), navigate: rec.fn('navigate'),
    },
    modules: {
      inboxDocs, docLabel, pausedApplicationRecords: paused, credentialTypes, helpers, spreadsheetGuard: guard, phiGuard, customCategories,
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*', extractOfficeText: async () => '', mimeFromName: officeText.mimeFromName },
      docPrefill: { isReadableDoc: () => true, contractFromScan: e => ({ entry: e }) },
      documentScanner: scanner,
    },
    globals: { window: { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => { rec.calls.push(['confirm']); return confirm; }, open() {} } },
  });
  const button = ui.nodes().find(x => x.type === 'button' && ui.text(x) === 'File with AI');
  await button.props.onClick();
  ui.render();
  return { ui, rec };
}

test('File with AI on a stored patient chart asks, then removes it, and never queues it for filing', async () => {
  const { ui, rec } = await rescan(CHART);
  assert.equal(rec.of('confirm').length, 1, 'the physician is asked first');
  assert.deepEqual(rec.of('deleteItem').map(c => c.slice(1)), [['documents', 'doc-9']]);
  assert.ok(ui.pageText().includes('"scan.pdf" was removed. This looks like a patient record.'), ui.pageText());
  assert.ok(!ui.nodes().some(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard'), 'no review card');
});

test('declined, the chart stays but is still not offered for filing, and the warning shows', async () => {
  const { ui, rec } = await rescan(CHART, { confirm: false });
  assert.equal(rec.of('deleteItem').length, 0);
  assert.ok(ui.pageText().includes('This looks like a patient record.'), ui.pageText());
  assert.ok(!ui.nodes().some(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard'));
});

test('a credential re-read with File with AI still goes to review', async () => {
  const { ui, rec } = await rescan({ documentType: 'license', extracted: { type: 'State Medical License', state: 'CO' } });
  assert.equal(rec.of('confirm').length, 0);
  assert.ok(ui.nodes().some(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard'));
});

// -- DOCS-007: no button says Discard while the file stays; deleting is its own, asked, action --
async function reviewCard(props) {
  const real = async p => import(`../src/${p}.js`);
  return mountComponent('src/components/features/ScanReviewCard.jsx', {
    app: { theme: {}, data: { settings: { degreeType: 'MD' }, locumContracts: [] }, allTrackedStates: [] },
    props: { result: { documentType: 'license', confidence: 'high', extracted: { type: 'State Medical License', state: 'CO', expirationDate: '2027-06-30' } }, imageData: null, fileName: 'scan.pdf', onSave() {}, ...props },
    modules: {
      credentialTypes, helpers, customCategories,
      cmeTopics: await real('constants/cmeTopics'), stateRequirements: await real('constants/stateRequirements'), states: await real('constants/states'),
      receiptScan: await real('utils/receiptScan'), scanShape: await real('utils/scanShape'), contractsForDate: await real('utils/contractsForDate'), coverageBlocks: await real('utils/coverageBlocks'),
      useInputStyle: { useInputStyle: () => ({ fontSize: 16 }) },
    },
  });
}

// DOCS-006: the receipt card's destination chip names the tab the expense
// lands on, as the banner after saving does.
test('a receipt card offers "Bill to agency (Practice > Expenses)", never Work', async () => {
  const card = await reviewCard({ result: { documentType: 'receipt', confidence: 'high', extracted: { merchant: 'Synthetic Rides', date: '2026-09-20', total: '42.50', category: 'Rideshare / Taxi' } } });
  const chips = card.nodes().filter(n => n.type === 'button' && n.props['aria-pressed'] !== undefined).map(n => card.text(n));
  assert.ok(chips.includes('Bill to agency (Practice > Expenses)'), chips.join(' | '));
  assert.doesNotMatch(card.pageText(), /Work > /);
});

test('a recognised review card offers Keep as plain document, never a Discard that keeps the file', async () => {
  const card = await reviewCard({ onDiscard() {} });
  const labels = card.nodes().filter(n => n.type === 'button').map(b => card.text(b).trim());
  assert.ok(!labels.includes('Discard'), labels.join(' | '));
  assert.ok(labels.includes('Keep as plain document'), labels.join(' | '));
});

test('Delete this file asks, then removes the stored file and its card', async () => {
  const rec = recorder();
  const scanner = { analyzePDF: async () => ({ documentType: 'license', confidence: 'high', extracted: {} }), analyzeDocument: async () => ({}), analyzeDocText: async () => ({}), CV_DOC_TYPE: 'cv', OTHER_DOC_TYPE: 'other' };
  let n = 0;
  const ui = await smartScan(rec, { modules: { documentScanner: scanner, helpers: { ...helpers, generateId: () => `doc-${++n}` } } });
  await ui.pick(ui.fileInputs().find(x => x.props.multiple), [new File(['%PDF-1.4 synthetic'], 'wrong.pdf', { type: 'application/pdf' })]);
  const card = ui.nodes().find(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard');
  assert.equal(typeof card.props.onDeleteFile, 'function', 'the card is handed a delete');
  card.props.onDeleteFile();
  ui.render();
  assert.deepEqual(rec.of('deleteItem').map(c => c.slice(1)), [['documents', 'doc-1']]);
  assert.ok(!ui.nodes().some(x => typeof x.type === 'function' && x.type.name === 'ScanReviewCard'), 'the card is gone');
});
