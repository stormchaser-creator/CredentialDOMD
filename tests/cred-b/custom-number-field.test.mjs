// CRED-047: a custom category's "number" field ("Fee", 12.50) is packed text
// in field_values, not an integer column. CrudSection's whole-number rule,
// written for the CV order, refused the save, and a scanned "$125.00" showed
// blank in a type=number box and blocked every later edit. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, nodes } from '../harness/component-harness.mjs';

const { CrudSection } = await loadScreens('export { default as CrudSection } from "./src/components/features/CrudSection.jsx";');
const extraApp = { allTrackedStates: [], toggleFavorite() {}, navigate() {}, userIdRef: { current: 'profileA' }, isDesktop: false };
const FIELDS = [{ key: 'name', label: 'Name' }, { key: 'f_fee', label: 'Fee', type: 'number' }];

function form(item) {
  const saved = [];
  const m = mount(CrudSection, { props: { title: 'Synthetic category', sectionKey: 'customRecords', items: item ? [item] : [], fields: FIELDS,
    onAdd: (x) => { saved.push(x); return true; }, onEdit: (x) => { saved.push(x); return true; }, onDelete() {},
    ...(item ? { autoEditId: item.id } : {}) }, data: { customRecords: item ? [item] : [] } });
  Object.assign(globalThis.__screen.app, extraApp);
  return { m, saved };
}
const input = (tree, key) => nodes(tree).find((n) => n.type === 'input' && n.props['data-fkey'] === key);
const save = (m) => nodes(m.render()).filter((n) => n.type === 'button' && /^(Add|Save)$/.test(textOf(n).trim())).at(-1).props.onClick();

test('a decimal in a custom Number field saves', () => {
  const { m, saved } = form();
  nodes(m.render()).find((n) => n.type === 'button' && /Add/.test(textOf(n))).props.onClick();
  input(m.render(), 'name').props.onChange({ target: { value: 'Synthetic record' } });
  const fee = input(m.render(), 'f_fee');
  assert.notEqual(fee.props.step, '1', 'no whole-number step');
  assert.equal(fee.props.inputMode, 'decimal');
  fee.props.onChange({ target: { value: '12.50' } });
  save(m);
  assert.doesNotMatch(textOf(m.render()), /must be a whole number/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].f_fee, '12.50');
});

test('a stored "$125.00" shows in the box and does not block another edit', () => {
  const { m, saved } = form({ id: 'cr-1', name: 'Synthetic record', f_fee: '$125.00' });
  m.render(); // the deep-link effect opens the edit form
  const fee = input(m.render(), 'f_fee');
  assert.ok(fee, 'the edit form is open');
  assert.notEqual(fee.props.type, 'number', 'a non-numeric value would show blank in a number box');
  assert.equal(fee.props.value, '$125.00');
  input(m.render(), 'name').props.onChange({ target: { value: 'Synthetic record, renamed' } });
  save(m);
  assert.doesNotMatch(textOf(m.render()), /must be a whole number/);
  assert.equal(saved.length, 1);
});
