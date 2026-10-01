// CRED-039: publications.sort_order is an integer column. A decimal "Order on
// CV" (1.5, to slot a paper between 1 and 2) was refused by the database with
// the whole publication, and a stored 0 showed as a blank field. Synthetic
// records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './limited-launch/persistence-fixture.mjs';
import { loadScreens, mount, textOf, nodes } from './harness/component-harness.mjs';

// As App.jsx declares it: the integer column (FIELD_TYPES.publications.sortOrder)
// is what keeps the whole-number rule.
const FIELDS = [{ key: 'name', label: 'Short Label' }, { key: 'sortOrder', label: 'Order on CV', type: 'number' }];
const { CrudSection } = await loadScreens('export { default as CrudSection } from "./src/components/features/CrudSection.jsx";');
const extraApp = { allTrackedStates: [], toggleFavorite() {}, navigate() {}, userIdRef: { current: 'profileA' }, isDesktop: false };

function form(item) {
  const saved = [];
  const m = mount(CrudSection, { props: { title: 'Publications', sectionKey: 'publications', items: item ? [item] : [], fields: FIELDS,
    onAdd: (x) => { saved.push(x); return true; }, onEdit: (x) => { saved.push(x); return true; }, onDelete() {},
    ...(item ? { autoOpenEditId: item.id } : {}) }, data: { publications: item ? [item] : [] } });
  Object.assign(globalThis.__screen.app, extraApp);
  return { m, saved };
}
const input = (tree, key) => nodes(tree).find((n) => n.type === 'input' && n.props['data-fkey'] === key);

test('CRED-039: the form refuses a decimal Order on CV instead of saving a record the cloud refuses', () => {
  const { m, saved } = form();
  nodes(m.render()).find((n) => n.type === 'button' && /Add/.test(textOf(n))).props.onClick();
  input(m.render(), 'name').props.onChange({ target: { value: 'Synthetic paper' } });
  const order = input(m.render(), 'sortOrder');
  assert.equal(order.props.step, '1');
  assert.equal(order.props.inputMode, 'numeric');
  order.props.onChange({ target: { value: '1.5' } });
  nodes(m.render()).filter((n) => n.type === 'button' && /^(Add|Save)$/.test(textOf(n).trim())).at(-1).props.onClick();
  assert.deepEqual(saved, []);
  assert.match(textOf(m.render()), /Order on CV must be a whole number\./);
  input(m.render(), 'sortOrder').props.onChange({ target: { value: '2' } });
  nodes(m.render()).filter((n) => n.type === 'button' && /^(Add|Save)$/.test(textOf(n).trim())).at(-1).props.onClick();
  assert.equal(saved.length, 1);
});

test('CRED-039: a stored 0 shows as 0, not blank', () => {
  const { m } = form();
  nodes(m.render()).find((n) => n.type === 'button' && /Add/.test(textOf(n))).props.onClick();
  input(m.render(), 'sortOrder').props.onChange({ target: { value: 0 } });
  assert.equal(input(m.render(), 'sortOrder').props.value, 0);
});

test('CRED-039: the write path rounds an integer column, so a queued decimal lands', async () => {
  const f = fixture();
  await f.api.insertItem('profileA', 'publications', { id: 'p1', name: 'Synthetic', sortOrder: '1.5' });
  await f.api.updateItem('profileA', 'publications', { id: 'p1', name: 'Synthetic', sortOrder: 'first' }, null, 'user_syntheticA');
  await f.api.bulkSync('profileA', 'customCategories', [{ id: 'c1', name: 'Synthetic', sortOrder: '3' }], 'user_syntheticA');
  assert.equal(f.requests[0].value.sort_order, 2);
  assert.equal(f.requests[1].value.sort_order, null);
  assert.equal(f.requests[2].value[0].sort_order, 3);
});
