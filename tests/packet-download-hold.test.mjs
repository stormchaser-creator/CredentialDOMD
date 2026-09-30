// Setup's packet download waits for every linked file (SHARE-005).
//
// The ZIP is built from the bytes this device holds, so while a linked file
// is still coming back from the account the card's Download is held and says
// why. The Send sheet's "Download the whole packet as one file instead" link
// called the same builder without that hold and handed over a partial packet
// with no warning. Driven through the real SetupPage with synthetic hooks;
// every record here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as credentialExport from '../src/utils/credentialExport.js';
import { mountComponent, settle } from './component-harness.mjs';

async function setupPage({ documents, onDevice }) {
  const built = [];
  const summary = { lineItems: 14, documents, onDevice };
  const tier = total => ({ complete: true, total, done: total });
  const ui = await mountComponent('src/components/features/SetupPage.jsx', {
    app: { data: { settings: {}, documents: [] }, theme: {}, isDesktop: false },
    modules: {
      useSetupState: { useSetupState: () => ({
        setup: { counts: { tier1: tier(5), tier2: tier(6) }, tier1: [], tier2: [], skipped: [], notApplicable: [], byId: {}, open: [] },
        skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {},
      }) },
      setupTasks: { ladderState: () => ({ text: '', taskId: null, verb: '' }), TIER2_COPY: { header: 'Packet' } },
      credentialExport: {
        // The real sentence builders; the counts and the ZIP are synthetic.
        packetSummaryLine: credentialExport.packetSummaryLine,
        packetPendingLine: credentialExport.packetPendingLine,
        packetSummary: () => summary,
        packetDocuments: () => [],
        generateCredentialZip: async () => { built.push(summary); return new Blob(['zip']); },
        downloadBlob() {},
      },
    },
  });
  return { ui, built };
}

const node = (ui, name) => ui.nodes().find(n => typeof n.type === 'function' && n.type.name === name);

test('with 3 of 12 linked files still downloading, the Send sheet\'s whole-packet link builds nothing', async () => {
  const { ui, built } = await setupPage({ documents: 12, onDevice: 9 });
  const modal = node(ui, 'EmailPacketModal');
  assert.ok(modal, 'the Send sheet is on the page');
  if (typeof modal.props.onDownloadPacket === 'function') {
    await modal.props.onDownloadPacket();
    await settle();
  }
  assert.equal(built.length, 0, 'no partial ZIP is built');
  const ending = node(ui, 'PacketEnding');
  if (typeof modal.props.onDownloadPacket === 'function') {
    assert.match(String(ending.props.error || ''), /still coming back from your account/, 'the card says why');
  }
});

test('the card\'s own Download refuses the same way, even if the button were tapped', async () => {
  const { ui, built } = await setupPage({ documents: 12, onDevice: 9 });
  await node(ui, 'PacketEnding').props.onDownload();
  await settle();
  assert.equal(built.length, 0);
  assert.match(String(node(ui, 'PacketEnding').props.error || ''), /3 of them are still coming back/);
});

test('with every linked file on the device, both ways in build the ZIP', async () => {
  const { ui, built } = await setupPage({ documents: 12, onDevice: 12 });
  const modal = node(ui, 'EmailPacketModal');
  assert.equal(typeof modal.props.onDownloadPacket, 'function', 'the whole-packet link is offered');
  await modal.props.onDownloadPacket();
  await settle();
  assert.equal(built.length, 1);
  ui.render();
  await node(ui, 'PacketEnding').props.onDownload();
  await settle();
  assert.equal(built.length, 2);
});
