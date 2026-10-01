// NOTIFY-007: Home and the bell alert on a dated record in the member's own
// category (alertItems.js credentialRecords), but the daily reminder email
// (send-reminders TABLES) never read custom_records. A permit due in 15 days
// with a license due in 20 and a DEA in 25 was emailed as "2 due within 30
// days", naming only the license and the DEA; alone, it sent no email at
// all. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALERT_SECTIONS, alertRecords } from '../../src/utils/alertItems.js';
import { SECTION_FIELDS } from '../../src/utils/sectionFields.js';
import { RECORD_COLUMNS } from '../../src/utils/customCategories.js';
import { remindable, reminderLabel, withCurrentCategoryNames } from '../../supabase/functions/_shared/reminderRows.mjs';
import { categoryLabelFor } from '../../src/utils/customCategories.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fn = readFileSync(`${root}supabase/functions/send-reminders/index.ts`, 'utf8');
const TABLES = [...fn.matchAll(/\{\s*table:\s*"([a-z_]+)",\s*label:\s*"([^"]+)"\s*\}/g)].map(m => ({ table: m[1], label: m[2] }));
const supa = readFileSync(`${root}src/lib/supabase.js`, 'utf8');
const TABLE_MAP = Object.fromEntries([...supa.slice(supa.indexOf('const TABLE_MAP')).matchAll(/^\s+([A-Za-z]+): "([a-z_]+)",/gm)].map(m => [m[1], m[2]]));

test('the reminder email reads custom_records', () => {
  assert.ok(TABLES.length >= 8, 'TABLES was read');
  const custom = TABLES.find(t => t.table === 'custom_records');
  assert.ok(custom, 'custom_records is one of the tables the digest reads');
  assert.equal(TABLE_MAP.customRecords, 'custom_records', 'and it is the table the app syncs customRecords to');
  assert.equal(custom.label, 'Your categories', 'its fallback label is the app\'s own');
});

test('every dated section the app alerts on is a table the reminder email reads', () => {
  // A section is dated when its stored fields include the expiration date:
  // the known sections (sectionFields.js), a custom record (RECORD_COLUMNS)
  // and travel documents (defaults.js).
  const dated = ALERT_SECTIONS.filter(s => (SECTION_FIELDS[s] || []).includes('expirationDate')
    || (s === 'customRecords' && RECORD_COLUMNS.includes('expirationDate'))
    || s === 'travelDocs');
  assert.ok(dated.includes('customRecords'));
  const read = new Set(TABLES.map(t => t.table));
  for (const s of dated) assert.ok(read.has(TABLE_MAP[s]), `${s} (${TABLE_MAP[s]}) alerts in the app, so the email reads it`);
  // The app side of the same record: it is on the alert list.
  const permit = { id: 'p', categoryId: 'k', name: 'Synthetic fluoroscopy permit', expirationDate: '2026-10-15' };
  assert.deepEqual(alertRecords({ customRecords: [permit], customCategories: [{ id: 'k', name: 'Synthetic Permits' }] }).map(i => [i.id, i._sec]), [['p', 'customRecords']]);
});

test('a custom record row is remindable and named by its name and category', () => {
  const row = { id: 'r', category_id: 'k', category_name: 'Synthetic Permits', name: 'Synthetic fluoroscopy permit', number: 'SYN-PERMIT-1', expiration_date: '2026-10-15', field_values: {} };
  assert.equal(remindable(row, { table: 'custom_records', today: '2026-09-30' }), true, 'no lifecycle column reads as active');
  assert.equal(reminderLabel(row, 'Your categories', 'Synthetic Physician'), 'Synthetic fluoroscopy permit \u{B7} Synthetic Permits');
  assert.equal(reminderLabel({ ...row, name: '' }, 'Your categories', 'Synthetic Physician'), 'Synthetic Permits', 'an unnamed record reads as its category');
  assert.equal(reminderLabel({ ...row, name: 'Synthetic Physician' }, 'Your categories', 'Synthetic Physician'), 'Synthetic Permits', 'never the physician\'s own name');
  assert.equal(reminderLabel({ expiration_date: '2026-10-15' }, 'Your categories', 'Synthetic Physician'), 'Your categories');
  // Rows from the other tables read exactly as before.
  assert.equal(reminderLabel({ name: 'Synthetic DEA', type: 'DEA Registration', state: 'CO' }, 'Licenses', 'Synthetic Physician'), 'Synthetic DEA \u{B7} DEA Registration \u{B7} CO');
  assert.equal(reminderLabel({ category: 'TB Test', type: 'QuantiFERON', name: 'Synthetic TB' }, 'Health records', 'Synthetic Physician'), 'Synthetic TB \u{B7} QuantiFERON');
});

test('a renamed category: the email names the record by the category\'s name today, as the app does', () => {
  // custom_records.category_name is the name at write time; a rename never
  // rewrites the records (customCategories.js categoryLabelFor).
  const permit = { id: 'r1', category_id: 'k', category_name: 'Synthetic Permits', name: 'Synthetic fluoroscopy permit', expiration_date: '2026-10-15' };
  const unnamed = { id: 'r2', category_id: 'k', category_name: 'Synthetic Permits', name: '', expiration_date: '2026-10-20' };
  const orphan = { id: 'r3', category_id: 'gone', category_name: 'Synthetic Old Badges', name: 'Synthetic badge', expiration_date: '2026-10-25' };
  const categories = [{ id: 'k', name: 'Synthetic Radiation permits' }, { id: 'blank', name: '  ' }];
  const rows = withCurrentCategoryNames([permit, unnamed, orphan], categories);
  const label = (r) => reminderLabel(r, 'Your categories', 'Synthetic Physician');
  assert.deepEqual(rows.map(label), [
    'Synthetic fluoroscopy permit \u{B7} Synthetic Radiation permits',
    'Synthetic Radiation permits',
    'Synthetic badge \u{B7} Synthetic Old Badges',
  ]);
  // The very name the app shows for each record.
  const app = { customCategories: categories };
  for (const [i, r] of [permit, unnamed, orphan].entries()) {
    assert.equal(rows[i].category_name, categoryLabelFor(app, { categoryId: r.category_id, categoryName: r.category_name }));
  }
  assert.equal(rows[2], orphan, 'a row whose name did not change is passed through as it came');
  assert.equal(permit.category_name, 'Synthetic Permits', 'the rows read from the database are not changed in place');
  assert.deepEqual(withCurrentCategoryNames([permit], null).map(label), ['Synthetic fluoroscopy permit \u{B7} Synthetic Permits'], 'no categories read: the saved name stands');
  assert.deepEqual(withCurrentCategoryNames(undefined, categories), []);
});

test('send-reminders reads the member\'s categories and names custom records through them', () => {
  const loop = fn.slice(fn.indexOf('for (const t of TABLES)'), fn.indexOf('if (!items.length)'));
  assert.match(loop, /if \(t\.table === "custom_records" && rows\.length\) \{/);
  // The categories are read once for the group (_shared/reminderReads.mjs), by user_id.
  const reads = readFileSync(`${root}supabase/functions/_shared/reminderReads.mjs`, 'utf8');
  assert.match(reads, /db\.from\('custom_categories'\)\s*\.select\('id, user_id, name'\)\s*\.in\('user_id', withCustom\)/, 'the members\' own categories, archived ones too');
  assert.match(loop, /rows = withCurrentCategoryNames\(rows, read\.categories\.get\(p\.id\) \|\| \[\]\);/);
  assert.match(loop, /for \(const r of rows\) \{/, 'the renamed rows are the ones labelled');
  assert.ok(loop.indexOf('withCurrentCategoryNames') < loop.indexOf('reminderLabel(r, t.label, p.name)'));
  assert.match(fn, /import \{ remindable, reminderLabel, withCurrentCategoryNames \} from "\.\.\/_shared\/reminderRows\.mjs";/);
});
