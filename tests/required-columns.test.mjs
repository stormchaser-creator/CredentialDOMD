import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { loadScreens, mount, button, textOf, nodes } from './harness/component-harness.mjs';
import { licenseFields, privilegeFields, insuranceFields } from '../src/utils/credentialForms.js';
import { prepareRecord } from '../src/utils/recordWrite.js';
import { REQUIRED_COLUMN_DEFAULTS } from '../src/utils/syncRules.js';

// SYNC-002, CRED-009, CRED-018, CRED-019, CRED-020, CRED-021.
//
// These columns are NOT NULL with no default in production
// (information_schema.columns, read 2026-09-29, names only). A record saved on
// "Select..." sent null, the database refused the WHOLE row (23502), and the
// record lived on one device only while it was retried on every load.
const TYPE_AND_CATEGORY = {
  licenses: 'type', privileges: 'type', insurance: 'type', education: 'type', workHistory: 'type',
  cme: 'category', healthRecords: 'category', caseLogs: 'category',
};
const snake = (k) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const appSource = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('every NOT NULL Type/Category column has a default the write path fills', () => {
  for (const [key, field] of Object.entries(TYPE_AND_CATEGORY)) {
    assert.equal(REQUIRED_COLUMN_DEFAULTS[key]?.[field], 'Other', `${key}.${field}`);
  }
});

for (const [key, field] of Object.entries(TYPE_AND_CATEGORY)) {
  test(`${key}: an add with a blank ${field} still sends a ${snake(field)}, on insert, replay and self-heal`, async () => {
    const f = fixture();
    await f.api.insertItem('profileA', key, { id: `${key}-1`, [field]: '', notes: 'Synthetic' });
    await f.api.bulkSync('profileA', key, [{ id: `${key}-2`, notes: 'Synthetic' }], 'user_syntheticA');
    // A row already stuck in a device's queue from before this fix.
    f.values.set('ops:user_syntheticA', JSON.stringify([{ op: 'upsert', collectionKey: key, payload: { id: `${key}-3`, [field]: null }, ts: 1, queueId: 'q' }]));
    await f.api.replayPendingOps('profileA', 'user_syntheticA');
    const rows = f.requests.flatMap((r) => [].concat(r.value));
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row[snake(field)], 'Other', `${row.id}: ${JSON.stringify(row)}`);
  });

  test(`${key}: an edit that clears ${field} leaves the column out instead of sending null`, async () => {
    const f = fixture();
    await f.api.updateItem('profileA', key, { id: `${key}-1`, [field]: '', notes: 'Edited' }, null, 'user_syntheticA');
    const [req] = f.requests;
    assert.equal(req.method, 'update');
    assert.equal(Object.hasOwn(req.value, snake(field)), false);
    assert.equal(req.value.notes, 'Edited', 'the rest of the edit still goes');
  });
}

test('a record from a path that skips the form (Vera, an importer) is stored with the default', () => {
  assert.equal(prepareRecord('education', { id: 'e', type: '' }).type, 'Other');
  assert.equal(prepareRecord('cme', { id: 'c' }).category, 'Other');
  assert.equal(prepareRecord('caseLogs', { id: 'k', category: '  ' }).category, 'Other');
  assert.equal(prepareRecord('cme', { id: 'c', category: 'AMA PRA Category 1' }).category, 'AMA PRA Category 1', 'a chosen value is kept');
  assert.equal(prepareRecord('peerReferences', { id: 'p' }).relationship, undefined, 'a relationship is never invented');
});

test('SYNC-002: Licenses, Privileges and Insurance require a Type', () => {
  for (const fields of [licenseFields({ degreeType: 'MD' }), licenseFields({ degreeType: 'DO' }), privilegeFields(), insuranceFields()]) {
    assert.equal(fields.find((f) => f.key === 'type').required, true);
  }
});

test('CRED-018, CRED-019, CRED-020: Education Type, Position Type and case Category are required in their forms', () => {
  // The list follows the profession (getEducationTypes: EDUCATION_TYPES for MD, DO and blank).
  assert.match(appSource, /\{ key: "type", label: "Type", type: "select", options: getEducationTypes\(data\.settings\.degreeType\), required: true \}/);
  assert.match(appSource, /\{ key: "type", label: "Position Type", type: "select", options: WORK_HISTORY_TYPES, required: true \}/);
  assert.match(appSource, /\{ key: "category", label: "Category", type: "select", options: CASE_CATEGORIES, groups: CASE_CATEGORY_GROUPS, required: true \}/);
});

// The two sections that render their own form rather than CrudSection's.
const { CMESection, HealthRecordsSection, CrudSection } = await loadScreens(`
  export { default as CMESection } from "./src/components/features/CMESection.jsx";
  export { default as HealthRecordsSection } from "./src/components/features/HealthRecordsSection.jsx";
  export { default as CrudSection } from "./src/components/features/CrudSection.jsx";
`);
const extraApp = { allTrackedStates: [], toggleFavorite() {}, navigate() {}, userIdRef: { current: 'profileA' }, isDesktop: false };
const alerts = (tree) => nodes(tree).filter((n) => n.props?.role === 'alert').map(textOf).join(' ');

test('CRED-009: a CME entry without a Credit Category is not saved, and says why', () => {
  const m = mount(CMESection, { data: { cme: [], licenses: [], settings: { degreeType: 'MD' } } });
  Object.assign(globalThis.__screen.app, extraApp);
  Object.assign(globalThis.window, { addEventListener() {}, removeEventListener() {} });
  nodes(m.render()).find((n) => n.props?.actionLabel === 'Add CME').props.onAction();
  const save = nodes(m.render()).filter((n) => n.type === 'button' && textOf(n).trim() === 'Add').at(-1);
  save.props.onClick();
  assert.deepEqual(m.calls, [], 'nothing was added');
  assert.match(alerts(m.render()), /Choose a credit category/);
});

test('CRED-021: a health record added from the All tab without a Category is not saved, and says why', () => {
  const m = mount(HealthRecordsSection, { data: { healthRecords: [], settings: {} } });
  Object.assign(globalThis.__screen.app, extraApp);
  const tree = m.render();
  const add = nodes(tree).find((n) => n.type === 'button' && /Add/.test(textOf(n)) && !/Health Record$/.test(textOf(n)));
  add.props.onClick();
  const save = nodes(m.render()).filter((n) => n.type === 'button' && /^(Add|Save)$/.test(textOf(n).trim())).at(-1);
  save.props.onClick();
  assert.deepEqual(m.calls, []);
  assert.match(textOf(m.render()), /Choose a category so this record can be saved/);
});

test('a missing Type says only that it is required, not a sentence about expiration dates', () => {
  const fields = [{ key: 'type', label: 'Type', type: 'select', options: ['A'], required: true }, { key: 'notes', label: 'Notes' }];
  const m = mount(CrudSection, { props: { title: 'Education', sectionKey: 'education', items: [], fields, onAdd: () => true, onEdit: () => true, onDelete() {} }, data: {} });
  Object.assign(globalThis.__screen.app, extraApp);
  const add = nodes(m.render()).find((n) => n.type === 'button' && /Add/.test(textOf(n)));
  add.props.onClick();
  const save = nodes(m.render()).filter((n) => n.type === 'button' && /^(Add|Save)$/.test(textOf(n).trim())).at(-1);
  save.props.onClick();
  const text = textOf(m.render());
  assert.match(text, /Required: Type\./);
  assert.doesNotMatch(text, /Expiration dates are how/);
});
