import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as setupTasks from '../src/utils/setupTasks.js';

const data = { settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'OR' }, licenses: [], education: [] };
const setup = setupTasks.buildSetup(data, { isPro: true });
const drawer = c => c.nodes().find(n => n.type?.name === 'PacketDrawer');
async function mount(isDesktop) {
  const c = await mountComponent('src/components/features/SetupPage.jsx', {
    app: { data, theme: {}, isDesktop }, props: { initialTask: 'education' },
    modules: { setupTasks, useSetupState: { useSetupState: () => ({ setup, skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {} }) } },
  });
  c.render(); return c;
}
for (const isDesktop of [true, false]) test(`task-owned drawer identity at ${isDesktop ? 'desktop' : 'phone'} width`, async () => {
  const c = await mount(isDesktop);
  const first = drawer(c); assert.ok(first); assert.equal(first.key, 'education');
  c.render(); assert.equal(drawer(c).key, first.key, 'ordinary rerenders retain the mounted review and capture queue');
  const work = c.nodes().find(n => n.props?.task?.id === 'work' && typeof n.props.onToggle === 'function');
  assert.ok(work); work.props.onToggle(); c.render();
  assert.equal(drawer(c).props.task.id, 'work');
  assert.equal(drawer(c).key, 'work');
  assert.notEqual(drawer(c).key, first.key, 'switching sections cannot reuse a frozen record queue');
});
