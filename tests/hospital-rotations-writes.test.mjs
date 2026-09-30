// QA OPS-010: HospitalRotations is not mounted anywhere today (CURRENT-STATE.md
// "Dormant code"), but it wrote through setData with 'rot-...' ids. setData
// only writes the device cache, and the load-time self-heal then upserts the
// row into rotations.id, a uuid column that rejects that id. Its writes now
// go through addItem, editItem and deleteItem with uuid ids, so a remount is
// safe. Runs the real component with a recording account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes } from './harness/component-harness.mjs';

const screens = await loadScreens('export {default as HospitalRotations} from "./src/components/features/locum/HospitalRotations.jsx";');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const byName = (tree, name) => nodes(tree).find(n => typeof n.type === 'function' && n.type.name === name);

test('a new rotation is added through addItem with a uuid id', () => {
  const m = mount(screens.HospitalRotations);
  nodes(m.render()).find(n => n.type === 'button' && /Add/.test(String([].concat(n.props.children).join('')))).props.onClick();
  let form = byName(m.render(), 'RotationForm');
  form.props.setForm({ ...form.props.form, hospital: 'Synthetic General', state: 'CO', startDate: '2026-09-01' });
  form = byName(m.render(), 'RotationForm');
  form.props.onSave();
  const [op, key, item] = m.calls[0];
  assert.deepEqual([op, key], ['add', 'rotations']);
  assert.match(item.id, UUID);
  assert.equal(item.hospital, 'Synthetic General');
});

test('editing and removing go through editItem and deleteItem', () => {
  const row = { id: '00000000-0000-4000-8000-00000000a001', hospital: 'Synthetic North', startDate: '2020-01-01', endDate: '2020-02-01' };
  const m = mount(screens.HospitalRotations, { data: { rotations: [row] } });
  const section = byName(m.render(), 'Section');
  section.props.onEdit(row);
  const form = byName(m.render(), 'RotationForm');
  form.props.setForm({ ...form.props.form, role: 'Hospitalist' });
  byName(m.render(), 'RotationForm').props.onSave();
  assert.deepEqual(m.calls[0].slice(0, 2), ['edit', 'rotations']);
  assert.equal(m.calls[0][2].id, row.id);
  assert.equal(m.calls[0][2].role, 'Hospitalist');
  byName(m.render(), 'Section').props.onRemove(row.id);
  assert.deepEqual(m.calls[1], ['delete', 'rotations', row.id]);
});
