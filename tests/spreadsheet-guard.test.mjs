// The spreadsheet guard: a CSV or Excel upload whose header row names a
// patient identifier is refused on the device, with the column named.
// Every workbook here is built in the test from synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import {
  spreadsheetGuard, spreadsheetRefusal, isSpreadsheet, identifierColumn, headerRows, UNREADABLE_SPREADSHEET,
} from '../src/utils/spreadsheetGuard.js';

const workbook = (sheets, bookType = 'xlsx') => {
  const wb = XLSX.utils.book_new();
  sheets.forEach((rows, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `Sheet${i + 1}`));
  return XLSX.write(wb, { type: 'array', bookType });
};
const file = (bytes, name, type = '') => new File([bytes], name, { type });
const refusalFor = column => spreadsheetRefusal(column);

test('the refusal names the column and says what to do, in the words the owner chose', () => {
  assert.equal(refusalFor('MRN'),
    'This spreadsheet has a "MRN" column. CredentialDOMD does not store patient identifiers. Delete that column and upload it again.');
  assert.doesNotMatch(refusalFor('MRN'), /\u{2014}|HIPAA/u);
});

test('an xlsx whose header names an identifier is refused, whichever identifier it is', async () => {
  for (const header of ['MRN', 'Medical Record Number', 'Patient Name', 'Patient ID', 'pt name', 'DOB', 'Date of Birth', 'patient_dob',
    'SSN', 'Social Security Number', 'TIN', 'Account Number', 'Encounter Number', 'Passport Number']) {
    const sheet = workbook([[['Date', 'CPT', header], ['2025-01-06', '61510', 'synthetic']]]);
    assert.equal(await spreadsheetGuard(file(sheet, 'case-log.xlsx')), refusalFor(header), header);
  }
});

test('a title row above the headers does not hide them, and every sheet is read', async () => {
  const titled = workbook([[['Case log 2025'], [], ['Date', 'CPT', 'Patient Name'], ['2025-01-06', '61510', 'Synthetic']]]);
  assert.equal(await spreadsheetGuard(file(titled, 'log.xlsx')), refusalFor('Patient Name'));
  const second = workbook([[['Date', 'Hours'], ['2025-01-06', '12']], [['Name', 'DOB'], ['Synthetic', '1970-01-02']]]);
  assert.equal(await spreadsheetGuard(file(second, 'two-sheets.xlsx')), refusalFor('DOB'));
});

test('a spreadsheet of credentials passes, and so does a data cell that merely says Passport', async () => {
  const credentials = workbook([[['Credential', 'License Number', 'State', 'Expiration Date', 'Committee'],
    ['Medical license', 'A12345', 'CA', '2027-06-30', 'Patient Safety Committee']]]);
  assert.equal(await spreadsheetGuard(file(credentials, 'credentials.xlsx')), null);
  const ids = workbook([[['Document', 'Issued by', 'Expires'], ['Passport', 'State Department', '2031-01-01']]]);
  assert.equal(await spreadsheetGuard(file(ids, 'ids.xlsx')), null, 'only the header row is judged');
});

test('CSV, TSV, old .xls and .ods are read the same way, whatever type the browser reports', async () => {
  assert.equal(await spreadsheetGuard(file('Date,Hours,Facility\n2025-01-06,12,Synthetic General\n', 'hours.csv', 'text/csv')), null);
  assert.equal(await spreadsheetGuard(file('Date,Hours,MRN\n2025-01-06,12,000000\n', 'hours.csv', 'application/vnd.ms-excel')), refusalFor('MRN'));
  assert.equal(await spreadsheetGuard(file('Date;SSN\n2025-01-06;000-00-0000\n', 'export', 'text/csv')), refusalFor('SSN'));
  assert.equal(await spreadsheetGuard(file('Date\tPatient Name\n', 'roster.tsv')), refusalFor('Patient Name'));
  assert.equal(await spreadsheetGuard(file(workbook([[['Date', 'Account Number']]], 'biff8'), 'old.xls', 'application/vnd.ms-excel')), refusalFor('Account Number'));
  assert.equal(await spreadsheetGuard(file(workbook([[['Date', 'Chart #']]], 'ods'), 'calc.ods')), refusalFor('Chart #'));
});

test('a spreadsheet that cannot be opened is refused; anything that is not a spreadsheet passes untouched', async () => {
  assert.equal(await spreadsheetGuard(file(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9]), 'broken.xlsx')), UNREADABLE_SPREADSHEET);
  for (const [name, type] of [['license.pdf', 'application/pdf'], ['card.jpg', 'image/jpeg'], ['letter.docx', ''], ['notes.txt', 'text/plain']]) {
    assert.equal(isSpreadsheet({ name, type }), false, name);
    assert.equal(await spreadsheetGuard(file('MRN,DOB\n', name, type)), null, name);
  }
  assert.equal(await spreadsheetGuard(file('', 'empty.csv', 'text/csv')), null);
});

test('a file already read into a data URL is checked the same way', async () => {
  const csv = Buffer.from('Date,MRN\n').toString('base64');
  assert.equal(await spreadsheetGuard({ name: 'x.csv', type: 'text/csv', dataUrl: `data:text/csv;base64,${csv}` }), refusalFor('MRN'));
});

test('the header rule itself', () => {
  assert.deepEqual(headerRows([[], ['Title'], ['A', 'B'], ['1', '2']]), [['Title'], ['A', 'B']]);
  assert.deepEqual(headerRows([['A', 'B'], ['1', '2']]), [['A', 'B']]);
  assert.equal(identifierColumn([[['Date', 'Hours']]]), null);
  assert.deepEqual(identifierColumn([[['Date', '  Patient   Name ']]]), { column: 'Patient Name', reason: 'a patient identifier' });
  const long = `MRN ${'x'.repeat(100)}`;
  assert.ok(identifierColumn([[[long]]]).column.length <= 63, 'a long header is shortened for the message');
});

test('every place a CSV or Excel file can enter the app runs the guard before reading or storing it', async () => {
  const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [path, handler, firstRead] of [
    ['src/components/features/DocumentsSection.jsx', 'const handleFiles = useCallback(async (files) => {', 'extractOfficeText({ name: file.name'],
    ['src/components/features/CrudSection.jsx', 'const handleUpload = useCallback(async (files) => {', 'reader.readAsDataURL(file)'],
    ['src/components/features/DocAttach.jsx', 'const handleFiles = useCallback(async (files) => {', 'reader.readAsDataURL(file)'],
    ['src/components/features/AssistantSection.jsx', 'const handleFile = useCallback(async (file) => {', 'extractOfficeText({ name: file.name'],
    ['src/components/features/CvImportReview.jsx', 'const pickFile = useCallback(async (e) => {', 'reader.readAsDataURL(file)'],
    ['src/components/features/CMEImport.jsx', 'const handleFile = useCallback(async (file) => {', 'readImportFile(file)'],
    ['src/components/features/locum/StatementImport.jsx', 'const handleFile = async (file) => {', 'file.text()'],
    ['src/utils/imageAttachment.js', 'export async function readTicketAttachment(file) {', 'readAsDataUrl(file)'],
  ]) {
    const src = await read(path);
    const a = src.indexOf(handler);
    assert.ok(a >= 0, `${path}: upload handler not found`);
    const guard = src.indexOf('await spreadsheetGuard(file)', a);
    const readAt = src.indexOf(firstRead, a);
    assert.ok(guard > a, `${path} does not run the spreadsheet guard`);
    assert.ok(readAt > guard, `${path} reads the file before the guard runs`);
  }
});
