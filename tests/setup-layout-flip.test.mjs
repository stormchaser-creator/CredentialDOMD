// Setup's two layouts give the page root different children (the desk rail
// and pane; the phone's strip, rows and groups). React matches unkeyed
// children by position, so the Send sheet (EmailPacketModal) sat at child 2
// at desk width and child 8 on a phone, and crossing 1024px with it open
// remounted it and dropped the draft in it. It and the task drawer are now
// keyed children of the same root in both layouts. The drawer's own
// survival is driven live in layout-flip-keeps-open-forms.test.mjs; the
// Send sheet needs a finished packet, so its place is checked here on the
// real SetupPage with synthetic hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as credentialExport from '../src/utils/credentialExport.js';
import { mountComponent } from './component-harness.mjs';

async function finishedPacket() {
  const tier = total => ({ complete: true, total, done: total });
  const app = { data: { settings: {}, documents: [] }, theme: {}, isDesktop: false };
  const ui = await mountComponent('src/components/features/SetupPage.jsx', {
    app,
    modules: {
      useSetupState: { useSetupState: () => ({
        setup: { counts: { tier1: tier(5), tier2: tier(6) }, tier1: [], tier2: [], skipped: [], notApplicable: [], byId: {}, open: [] },
        skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {},
      }) },
      setupTasks: { ladderState: () => null, TIER2_COPY: { header: 'Packet' } },
      credentialExport: {
        packetSummaryLine: credentialExport.packetSummaryLine,
        packetPendingLine: credentialExport.packetPendingLine,
        packetMissingLine: credentialExport.packetMissingLine,
        packetSummary: () => ({ lineItems: 14, documents: 2, onDevice: 2 }),
        packetDocuments: () => [],
        generateCredentialZip: async () => new Blob(['zip']),
        downloadBlob() {},
      },
    },
  });
  return { ui, app };
}

const rootChildren = tree => [tree.props.children].flat(Infinity).filter(n => n && typeof n === 'object');
const named = (children, name) => children.find(n => typeof n.type === 'function' && n.type.name === name);

test('the Send sheet and the task drawer are the same keyed children of the same root at both widths', async () => {
  const { ui, app } = await finishedPacket();
  const seen = {};
  for (const isDesktop of [false, true]) {
    app.isDesktop = isDesktop;
    const tree = ui.render();
    assert.equal(tree.type, 'div', `${isDesktop ? 'desk' : 'phone'}: the root is a div`);
    const children = rootChildren(tree);
    const mailer = named(children, 'EmailPacketModal');
    const drawer = named(children, 'KeptPanel');
    assert.ok(mailer, `${isDesktop ? 'desk' : 'phone'}: the Send sheet is a child of the root`);
    assert.ok(drawer, `${isDesktop ? 'desk' : 'phone'}: the task drawer is a child of the root`);
    seen[isDesktop] = { mailer: mailer.key, drawer: drawer.key };
  }
  assert.deepEqual(seen[false], { mailer: 'packet-mailer', drawer: 'task-drawer' });
  assert.deepEqual(seen[true], seen[false], 'the same keys at both widths, so React keeps each one');
});
