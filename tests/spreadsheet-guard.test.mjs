// The spreadsheet guard: a CSV or Excel upload whose header row names a
// patient identifier is refused on the device, with the column named.
// Every workbook here is built in the test from synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import {
  spreadsheetGuard, spreadsheetRefusal, isSpreadsheet, identifierColumn, headerRows, UNREADABLE_SPREADSHEET,
  delimitedRows, withRefusals,
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

test('a metadata block of two-cell rows above the headers does not hide them', async () => {
  // A hospital report export: a title, a label/value row, then the table.
  const report = workbook([[['Surgeon case log'], ['Date Range:', '01/01/2025 - 12/31/2025'],
    ['Date', 'CPT', 'Procedure', 'MRN', 'Patient Name'], ['2025-01-06', '61510', 'Craniotomy', '000000', 'Synthetic']]]);
  assert.equal(await spreadsheetGuard(file(report, 'caselog.xlsx')), refusalFor('MRN'));
  assert.equal(await spreadsheetGuard(file('Case Log,Dr Synthetic\nDate,Procedure,MRN\n2025-01-06,Craniotomy,000000\n', 'caselog.csv', 'text/csv')), refusalFor('MRN'));
  assert.equal(await spreadsheetGuard(file('Surgeon report\nDate Range:,01/01/2025 - 12/31/2025\nDate,CPT,Procedure,MRN,Patient Name\n', 'report.csv', 'text/csv')), refusalFor('MRN'));
  // Several metadata rows and a blank line before the headers.
  assert.equal(await spreadsheetGuard(file('Report,Surgeon Case Log\nPeriod,2025\n\nMRN,Patient Name,DOS,CPT\n000000,Synthetic,2025-01-06,61510\n', 'cases.csv', 'text/csv')), refusalFor('MRN'));
});

test('a merged group-header row above the real headers does not hide them', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['Patient Info', '', '', 'Procedure', ''], ['MRN', 'Name', 'DOB', 'Date', 'CPT'], ['000000', 'Synthetic', '1970-01-02', '2025-01-06', '61510']]);
  ws['!merges'] = [XLSX.utils.decode_range('A1:C1'), XLSX.utils.decode_range('D1:E1')];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cases');
  assert.equal(await spreadsheetGuard(file(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), 'grouped.xlsx')), refusalFor('MRN'));
});

test('the spellings hospital and billing exports use for identifier columns are refused', async () => {
  for (const header of ['Acct #', 'Account #', 'Acct#', 'Hospital Account #', 'Patient Acct #', 'Encounter #', 'Encounter ID',
    'Patient Last Name', 'Patient First Name', 'Patient Full Name', 'Patient_Last_Name', 'PatientLastName', "Patient's Name",
    'Pt. Name', 'Pt. ID', 'Pt Last Name', 'Patient #', 'FIN', 'CSN', 'HAR', 'Visit #', 'Visit Number', 'Subscriber ID']) {
    const sheet = workbook([[['Date', 'CPT', header], ['2025-01-06', '61510', 'synthetic']]]);
    assert.equal(await spreadsheetGuard(file(sheet, 'billing.xlsx')), refusalFor(header), header);
  }
  // The file from the report: every identifier column spelled the export's way.
  const billing = 'Patient Last Name,Patient First Name,Acct #,DOS,CPT\nSynthetic,Person,000000,2025-01-06,61510\n';
  assert.equal(await spreadsheetGuard(file(billing, 'cases.csv', 'text/csv')), refusalFor('Patient Last Name'));
  // Still phrases, not words: these are a physician's own columns.
  const own = workbook([[['Patient Safety Committee', 'Member ID', 'Account Manager', 'PTAN', 'Finance contact'],
    ['Member', 'AANS-4471', 'Synthetic', '000000', 'Synthetic']]]);
  assert.equal(await spreadsheetGuard(file(own, 'committees.xlsx')), null);
});

test('a tab- or comma-delimited text export is read like a spreadsheet; ordinary text is not', async () => {
  const epic = 'Surgeon case report\nMRN\tPatient Name\tDOS\tCPT\n000000\tSynthetic\t2025-01-06\t61510\n';
  assert.equal(await spreadsheetGuard(file(epic, 'export.txt', 'text/plain')), refusalFor('MRN'));
  assert.equal(await spreadsheetGuard(file('Date|Acct #|Amount\n2025-01-06|000000|12.00\n', 'export.txt', '')), refusalFor('Acct #'));
  assert.equal(await spreadsheetGuard(file('Date,Hours,Facility\n2025-01-06,12,Synthetic General\n', 'hours.txt', 'text/plain')), null);
  assert.equal(await spreadsheetGuard(file('Hi, the renewal is attached.\nThanks, Synthetic\n', 'note.txt', 'text/plain')), null);
  assert.equal(delimitedRows('One line, only'), null);
  assert.equal(delimitedRows('A plain note.\nNothing to split here.'), null);
  assert.deepEqual(delimitedRows('Title\n"A";"B"\n1;2'), [['Title'], ['A', 'B'], ['1', '2']]);
});

test('a spreadsheet of credentials passes, and so does a data cell that merely says Passport', async () => {
  const credentials = workbook([[['Credential', 'License Number', 'State', 'Expiration Date', 'Committee'],
    ['Medical license', 'A12345', 'CA', '2027-06-30', 'Patient Safety Committee']]]);
  assert.equal(await spreadsheetGuard(file(credentials, 'credentials.xlsx')), null);
  const ids = workbook([[['Document', 'Issued by', 'Expires'], ['Passport', 'State Department', '2031-01-01']]]);
  assert.equal(await spreadsheetGuard(file(ids, 'ids.xlsx')), null, 'only the header row is judged');
  const titled = workbook([[['My documents'], ['Updated:', '2026-09-01'], ['Document', 'Issued by', 'Expires'], ['Passport', 'State Department', '2031-01-01']]]);
  assert.equal(await spreadsheetGuard(file(titled, 'ids.xlsx')), null, 'rows below the header stay unjudged after a metadata block');
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
  // Everything down to the first row as wide as the widest, and nothing after it.
  assert.deepEqual(headerRows([['Title'], ['Range:', '2025'], ['A', 'B', 'C'], ['1', '2', '3']]), [['Title'], ['Range:', '2025'], ['A', 'B', 'C']]);
  assert.deepEqual(headerRows([['Group', '', 'Group'], ['A', 'B', 'C', 'D'], ['1', '2', '3', '4']]), [['Group', '', 'Group'], ['A', 'B', 'C', 'D']]);
  assert.deepEqual(headerRows([]), []);
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
    // Only the branch that sends the whole file to the AI; CSV and Excel are
    // parsed on the device and never stored (tests/upload-refusals.test.mjs).
    ['src/components/features/locum/StatementImport.jsx', 'const handleFile = async (file) => {', 'r.readAsDataURL(file)'],
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

test('the setup capture handlers take a photo or a PDF only, refused before anything is read', async () => {
  const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [path, handler, firstRead] of [
    ['src/components/features/setup/CaptureRun.jsx', 'const handleFile = useCallback(async (file) => {', 'readAsDataUrl(file)'],
    ['src/components/features/setup/DateFixList.jsx', 'const handleFile = useCallback(async (file) => {', 'r.readAsDataURL(file)'],
  ]) {
    const src = await read(path);
    const a = src.indexOf(handler);
    assert.ok(a >= 0, `${path}: upload handler not found`);
    const check = src.indexOf('if (!isPhotoOrPdf(file))', a);
    assert.ok(check > a, `${path} does not refuse a file that is not a photo or a PDF`);
    assert.ok(src.indexOf(firstRead, a) > check, `${path} reads the file before the check`);
  }
});

test('refusals in a multi-file pick stay on screen after a later file succeeds', () => {
  const refused = ['"caselog.xlsx" was not attached. This spreadsheet has a "MRN" column.'];
  assert.equal(withRefusals(refused)('3 fields filled.'), `${refused[0]} 3 fields filled.`);
  assert.equal(withRefusals(refused)(refused[0]), refused[0], 'the refusal alone when it was the last word');
  assert.equal(withRefusals(refused)(null), refused[0]);
  assert.equal(withRefusals([...refused, 'b'])('b'), `${refused[0]} b`);
});
