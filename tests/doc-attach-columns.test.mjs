// CRED-037 and CRED-009: a scan attached inside a form must only fill that
// form with its own table's columns. The default classifier reads a drug
// screen as a health record and a course certificate as a licence; their keys
// used to be merged unfiltered, and one key the table lacks makes the database
// refuse the WHOLE record, which then lived on one device only. Driven through
// the real DocAttach with the real scan split. Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/utils/spreadsheetGuard.js';
import * as photoOrPdf from '../src/utils/photoOrPdf.js';
import * as docPrefill from '../src/utils/docPrefill.js';
import { SECTION_FIELDS } from '../src/utils/sectionFields.js';
import { mountComponent } from './component-harness.mjs';

const columns = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./member-view/production-columns.json', import.meta.url), 'utf8')).tables;
const snake = (k) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const pdf = () => new File(['%PDF-1.4 synthetic'], 'report.pdf', { type: 'application/pdf' });

async function attachInto(allowedKeys, result) {
  let form = {};
  const attach = await mountComponent('src/components/features/DocAttach.jsx', {
    app: { data: { settings: {}, documents: [] }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: false },
    props: { setForm: (u) => { form = typeof u === 'function' ? u(form) : u; }, attachedDocs: [], setAttachedDocs() {}, allowedKeys },
    modules: {
      spreadsheetGuard: guard, photoOrPdf, docPrefill,
      aiClient: { useAiAvailable: () => true, describeAiStatus: () => 'AI is off.' },
      storageQuota: { checkStorageQuota: () => ({ ok: true }) },
      officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' },
      documentScanner: { analyzePDF: async () => result, analyzeDocument: async () => result },
    },
  });
  await attach.pick(attach.fileInputs().find((n) => n.props.multiple), [pdf()]);
  return { form, page: attach.pageText() };
}

const strays = (form, table) => Object.keys(form).filter((k) => !new Set(columns[table]).has(snake(k)));

test('CRED-037: a drug screen read as a health record fills a Screening with screenings columns only', async () => {
  const { form, page } = await attachInto(SECTION_FIELDS.screenings, {
    documentType: 'healthRecord',
    extracted: { category: 'Titer', type: 'Drug Screen Report', name: 'Synthetic 10-panel', dateAdministered: '2026-09-01',
      lotNumber: 'LOT-SYN', facility: 'Synthetic Lab', doses: [{ date: '2026-09-01' }], result: 'Negative', expirationDate: '2027-09-01' },
  });
  assert.deepEqual(strays(form, 'screenings'), [], JSON.stringify(form));
  assert.equal(form.result, 'Negative');
  assert.equal(form.type, 'Drug Screen Report');
  assert.ok(form.customFields && Object.keys(form.customFields).length >= 3, 'the other facts are kept as details, not lost');
  assert.match(page, /more details? kept on the record/);
});

test('CRED-009: a course certificate read as a licence fills a CME entry with cme columns only', async () => {
  const { form } = await attachInto(SECTION_FIELDS.cme, {
    documentType: 'license',
    extracted: { type: 'Certification', name: 'Synthetic Course', licenseNumber: 'C-000', state: 'CA', issuedDate: '2026-05-01', expirationDate: '2028-05-01', title: 'Synthetic Course', hours: 4 },
  });
  assert.deepEqual(strays(form, 'cme'), [], JSON.stringify(form));
  assert.equal(form.expirationDate, undefined, 'a stray expiry must not put the entry into Home alerts');
  assert.equal(form.title, 'Synthetic Course');
  assert.equal(form.hours, 4);
});

test('a health record host keeps a vaccine series (doses is a real column there)', async () => {
  const { form } = await attachInto([...SECTION_FIELDS.healthRecords, 'doses'], {
    documentType: 'healthRecord',
    extracted: { category: 'Vaccination', type: 'Hepatitis B', doses: [{ date: '2020-01-01' }, { date: '2020-02-01' }], licenseNumber: 'X' },
  });
  assert.deepEqual(strays(form, 'health_records'), []);
  assert.equal(form.doses.length, 2);
});

test('CRED-037, CRED-009: CME, Screenings and Health Records hand DocAttach their columns', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [file, keys] of [['CMESection', 'SECTION_FIELDS.cme'], ['ScreeningsSection', 'SECTION_FIELDS.screenings'], ['HealthRecordsSection', 'HEALTH_SCAN_KEYS']]) {
    const src = await readFile(new URL(`../src/components/features/${file}.jsx`, import.meta.url), 'utf8');
    const uses = [...src.matchAll(/<DocAttach\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(uses.length > 0, file);
    for (const use of uses) assert.ok(use.includes(`allowedKeys={${keys}}`), `${file}: ${use}`);
  }
});
