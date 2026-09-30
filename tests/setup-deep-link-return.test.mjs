// SETTINGS-018: on a phone, a Setup drawer button deep links out (App's
// openAddIn / onOpenRecord) and the trip back remounts SetupPage with
// initialTask set. `seeded` started equal to initialTask, so the branch that
// unfolds Tier 1, opens the packet and opens the drawer never ran: the
// member came back to a folded section with the drawer hidden.
//
// The real SetupPage through the component harness with the real board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as setupTasks from '../src/utils/setupTasks.js';

async function setupPage(initialTask, data) {
  const setup = setupTasks.buildSetup(data, {});
  const c = await mountComponent('src/components/features/SetupPage.jsx', {
    app: { data, theme: {}, isDesktop: false },
    props: { initialTask },
    modules: { setupTasks, useSetupState: { useSetupState: () => ({ setup, skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {} }) } },
  });
  // A state update made during render is re-rendered by React before paint;
  // the harness does it by rendering once more.
  c.render();
  const row = id => c.nodes().find(n => n.props?.['data-task-row'] === id);
  const taskRow = id => row(id) && c.nodes(row(id)).find(n => n.props && 'open' in n.props && n.props.task?.id === id);
  return { c, setup, row, taskRow };
}
const tier1Open = { settings: { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'CA' }, licenses: [] };

test('Case A: back from a packet row with Tier 1 unfinished, the packet is open and its drawer shows', async () => {
  const p = await setupPage('education', tier1Open);
  assert.equal(p.setup.counts.tier1.complete, false);
  assert.ok(p.row('education'), 'the packet row is rendered, not folded away');
  assert.equal(p.taskRow('education')?.props.open, true, 'its drawer is open');
});

test('Case B: back to a Tier 1 row after Tier 1 completed, Tier 1 is unfolded and the drawer shows', async () => {
  const done = {
    settings: { name: 'Synthetic Physician', degreeType: 'DO', primaryState: 'CA', email: 'synthetic@example.invalid', notifyEmail: true, reminderLeadDays: 90 },
    licenses: [
      { id: 'l1', type: 'State Medical License (DO)', state: 'CA', licenseNumber: 'A1', expirationDate: '2027-06-30' },
      { id: 'd1', type: 'DEA Registration', state: 'CA', licenseNumber: 'BW1', expirationDate: '2027-01-31' },
    ],
    documents: [{ id: 'cv1', name: 'Synthetic CV 2026.pdf' }],
  };
  const p = await setupPage('dates', done);
  assert.equal(p.setup.counts.tier1.complete, true);
  assert.equal(p.taskRow('dates')?.props.open, true);
});
