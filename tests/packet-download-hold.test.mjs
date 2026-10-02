// Setup's packet download carries every linked file (SHARE-005).
//
// The ZIP used to be written only from the bytes this device held, so the
// card's Download waited while a linked file was "still coming back from the
// account". Since a load downloads no file (2026-10-02, the owner's iPhone),
// nothing comes back by itself and the download waited for good. The ZIP now
// fetches from the account what this device does not hold, and a file it
// cannot fetch stops it, named: a partial packet is never handed over. The
// Send sheet's "Download the whole packet as one file instead" goes the same
// way. Driven through the real SetupPage with synthetic hooks; every record
// here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as credentialExport from '../src/utils/credentialExport.js';
import { mountComponent, settle } from './component-harness.mjs';

const ACCOUNT_DOWNLOAD = async () => ({ failed: true });

async function setupPage({ documents, missing = [], build = null }) {
  const built = [];
  const summary = { lineItems: 14, documents, missing };
  const tier = total => ({ complete: true, total, done: total });
  const ui = await mountComponent('src/components/features/SetupPage.jsx', {
    app: { data: { settings: {}, documents: [] }, theme: {}, isDesktop: false },
    modules: {
      useSetupState: { useSetupState: () => ({
        setup: { counts: { tier1: tier(5), tier2: tier(6) }, tier1: [], tier2: [], skipped: [], notApplicable: [], byId: {}, open: [] },
        skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {},
      }) },
      setupTasks: { ladderState: () => ({ text: '', taskId: null, verb: '' }), TIER2_COPY: { header: 'Packet' } },
      supabase: { downloadDocumentBlob: ACCOUNT_DOWNLOAD },
      credentialExport: {
        // The real sentence builders; the counts and the ZIP are synthetic.
        packetSummaryLine: credentialExport.packetSummaryLine,
        packetMissingLine: credentialExport.packetMissingLine,
        packetSummary: () => summary,
        packetDocuments: () => [],
        generateCredentialZip: async (data, options) => {
          built.push(options);
          if (build) return build(options);
          return new Blob(['zip']);
        },
        downloadBlob() {},
      },
    },
  });
  return { ui, built };
}

const node = (ui, name) => ui.nodes().find(n => typeof n.type === 'function' && n.type.name === name);

test('with 3 of 12 linked files in the account and not on this device, both ways in build the ZIP and fetch them from the account', async () => {
  const { ui, built } = await setupPage({ documents: 12 });
  const ending = node(ui, 'PacketEnding');
  assert.doesNotMatch(ui.pageText(), /still coming back/, 'no wait for files that no longer come back by themselves');
  assert.equal(ending.props.busy, false);
  await ending.props.onDownload();
  await settle();
  assert.equal(built.length, 1, 'the card\'s Download builds it');
  assert.equal(built[0].download, ACCOUNT_DOWNLOAD, 'with the account\'s files fetched as it goes');
  const modal = node(ui, 'EmailPacketModal');
  assert.equal(typeof modal.props.onDownloadPacket, 'function', 'the whole-packet link is offered');
  await modal.props.onDownloadPacket();
  await settle();
  assert.equal(built.length, 2);
  assert.equal(built[1].download, ACCOUNT_DOWNLOAD);
});

test('a file the ZIP cannot fetch is named on the card, and nothing is handed over', async () => {
  const message = '1 document could not be fetched from your account ("Synthetic DEA.pdf") because you are offline. Nothing was downloaded. Try again in a moment.';
  const { ui, built } = await setupPage({ documents: 12, build: () => { throw new credentialExport.PacketFilesError([{ name: 'Synthetic DEA.pdf', reason: 'offline' }]); } });
  await node(ui, 'PacketEnding').props.onDownload();
  await settle();
  assert.equal(built.length, 1);
  assert.equal(String(node(ui, 'PacketEnding').props.error || ''), message);
});

test('a linked file the account does not have still holds both ways in, named', async () => {
  const { ui, built } = await setupPage({ documents: 12, missing: ['Synthetic renewal.pdf'] });
  await node(ui, 'PacketEnding').props.onDownload();
  await settle();
  assert.equal(built.length, 0);
  assert.match(String(node(ui, 'PacketEnding').props.error || ''), /"Synthetic renewal\.pdf" is missing from your account/);
  assert.equal(node(ui, 'EmailPacketModal').props.onDownloadPacket, undefined);
});
