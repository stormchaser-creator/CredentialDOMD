// Health records: an "Add date" link lands on the Expiration Date field, and
// a record's follow-up history shows on its own detail and edit screens.
// Driven through the real component; synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';

const TB = { id: 'hr-1', category: 'TB Test', type: 'TB Skin Test (PPD)', name: 'Synthetic TB test', date: '2026-01-10' };
const followUps = [
  { id: 'f1', itemId: 'hr-1', recipient: 'Synthetic occupational health', note: 'Asked for the reading', emailed: true, createdAt: '2026-09-01T10:00:00Z' },
  { id: 'f2', itemId: 'other', note: 'Not this record', createdAt: '2026-09-02T10:00:00Z' },
];
const mount = async (props, over = {}) => {
  const focused = [];
  const m = await mountComponent('src/components/features/HealthRecordsSection.jsx', {
    app: { data: { settings: {}, documents: [], healthRecords: [TB], followUps, ...over }, theme: {}, addItem() {}, editItem() {}, deleteItem() {}, setData() {}, toggleFavorite() {} },
    props: { onShare() {}, ...props },
    modules: {
      credentialTypes: await import('../../src/constants/credentialTypes.js'),
      helpers: await import('../../src/utils/helpers.js'),
      // HEALTH_SCAN_KEYS is built from it at module load (CRED-037).
      sectionFields: await import('../../src/utils/sectionFields.js'),
    },
    globals: { document: { querySelector: (sel) => ({ focus() { focused.push(sel); }, scrollIntoView() {} }), addEventListener() {}, removeEventListener() {} } },
  });
  return { m, focused };
};

test('an Add date link opens the form and puts the cursor on Expiration Date', async () => {
  const { m, focused } = await mount({ autoEditId: 'hr-1', onAutoEditDone() {}, autoFocusField: 'expirationDate' });
  m.render();
  const input = m.nodes().find(n => n.type === 'input' && n.props['data-fkey'] === 'expirationDate');
  assert.ok(input, 'the Expiration Date input is tagged');
  m.timers.splice(0).forEach(fn => fn());
  assert.deepEqual(focused, ['[data-fkey="expirationDate"]']);
});

test('the detail view and the edit form show the record\'s follow-up history', async () => {
  const view = (await mount({ autoViewId: 'hr-1', onAutoViewDone() {} })).m;
  const history = view.nodes().filter(n => n.type?.name === 'FollowUpHistory');
  assert.ok(history.some(n => n.props.item?.id === 'hr-1'), 'the detail view carries it');
  const edit = (await mount({ autoEditId: 'hr-1', onAutoEditDone() {} })).m;
  assert.ok(edit.nodes().some(n => n.type?.name === 'FollowUpHistory' && n.props.item?.id === 'hr-1'), 'so does the edit form');
});

test('CME forms and every CrudSection record use the same history block', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(read('src/components/features/CMESection.jsx'), /\{editItem && <FollowUpHistory item=\{editItem\} \/>\}/);
  assert.match(read('src/components/features/CrudSection.jsx'), /const renderFollowUps = \(item\) => <FollowUpHistory item=\{item\} \/>;/);
  const { followUpsFor } = await import('../../src/utils/followUps.js');
  assert.deepEqual(followUpsFor(followUps, TB).map(f => f.id), ['f1']);
  assert.match(read('src/components/shared/FollowUpHistory.jsx'), /import \{ followUpsFor \} from "\.\.\/\.\.\/utils\/followUps";/);
});
