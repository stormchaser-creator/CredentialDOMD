// Work history "Current Position" is one boolean, written and read the same
// way everywhere. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCredentialText, isCurrentJob } from '../../src/utils/helpers.js';
import { prepareRecord } from '../../src/utils/recordWrite.js';
import { buildCredentialRows } from '../../src/utils/credentialExport.js';
import { normalizeCvSections } from '../../src/utils/cvImport.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const job = (current) => ({ id: 'w1', position: 'Synthetic Attending', employer: 'Synthetic Medical Center', startDate: '2020-07-01', endDate: '', current });

test('a saved Current Position is stored as a boolean on every write path', () => {
  assert.equal(prepareRecord('workHistory', job('Yes')).current, true);
  assert.equal(prepareRecord('workHistory', job('No')).current, false);
  assert.equal(prepareRecord('workHistory', job(true)).current, true);
  assert.equal(prepareRecord('workHistory', job('false')).current, false);
  assert.ok(!('current' in prepareRecord('workHistory', { id: 'w2', employer: 'X' })), 'a record without the key gains none');
});

test('a current job reloaded from the cloud (current: true) still sends "End Date: Current"', () => {
  const text = buildCredentialText(job(true), 'workHistory', { name: 'Synthetic Physician' });
  assert.match(text, /End Date: Current/);
  assert.match(buildCredentialText(job('Yes'), 'workHistory', { name: 'Synthetic Physician' }), /End Date: Current/, 'a cached "Yes" too');
});

test('the credential export labels a past job Past, not Current', () => {
  const rows = buildCredentialRows({ workHistory: [job('No'), job(false), job(true), job('Yes')] }).filter(r => r.Type === 'Work History');
  assert.deepEqual(rows.map(r => r.Status), ['Past', 'Past', 'Current', 'Current']);
});

test('the reader accepts every spelling a stored row can hold', () => {
  for (const v of [true, 'true', 'Yes', 'yes', 'Current', 'present', 1]) assert.equal(isCurrentJob(v), true, String(v));
  for (const v of [false, 'false', 'No', '', null, undefined, 0]) assert.equal(isCurrentJob(v), false, String(v));
});

test('a CV import writes the boolean the column holds', () => {
  const secs = normalizeCvSections({ workHistory: [{ employer: 'A', current: 'Yes' }, { employer: 'B', current: 'No' }] });
  assert.deepEqual(secs.workHistory.map(w => w.current), [true, false]);
});

test('the form asks with a checkbox, so a reloaded true is never an unknown select value', () => {
  const src = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(src, /\{ key: "current", label: "Current Position", type: "checkbox", checkboxLabel: "Current position" \}/);
});

test('the detail view shows Current position only for a ticked job', async () => {
  const { mountComponent } = await import('../component-harness.mjs');
  const fields = [{ key: 'employer', label: 'Employer' }, { key: 'current', label: 'Current Position', type: 'checkbox', checkboxLabel: 'Current position' }];
  const mount = async (item) => mountComponent('src/components/features/CrudSection.jsx', {
    app: { data: { settings: {}, documents: [], followUps: [] }, theme: {}, isDesktop: false, addItem() {}, editItem() {}, toggleFavorite() {} },
    props: { title: 'Work History', sectionKey: 'workHistory', items: [item], fields, autoViewId: item.id, onAutoViewDone() {} },
    modules: { helpers: await import('../../src/utils/helpers.js'), lifecycle: await import('../../src/utils/lifecycle.js'), caseBilling: await import('../../src/utils/caseBilling.js'), formLayout: await import('../../src/utils/formLayout.js') },
  });
  const detail = m => m.nodes().filter(n => n.type?.name === 'Modal' && n.props.open).map(n => m.text(n)).join(' ');
  const past = await mount({ ...job('No'), id: 'w-past' });
  assert.match(detail(past), /Synthetic Medical Center/, 'the detail view is open');
  assert.doesNotMatch(detail(past), /Current position/);
  const now = await mount({ ...job(true), id: 'w-now' });
  assert.match(detail(now), /Current position/);
});
