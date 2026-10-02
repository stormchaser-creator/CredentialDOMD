// SHARE-005: a linked packet file that Storage does not have (fileMissing)
// held "Download the packet" for good under "still coming back from your
// account", a file that was never coming back, and never said which one.
// It is now named, with the way to Documents; a file in the account is
// fetched by the ZIP as it is built. Every record here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as credentialExport from '../src/utils/credentialExport.js';
import { mountComponent, settle } from './component-harness.mjs';

const { packetSummary, packetMissingLine } = credentialExport;

const DATA = {
  licenses: [{ id: 'l1', state: 'ZZ', licenseNumber: 'SYN-0001', expirationDate: '2099-01-01' }],
  documents: [
    { id: 'd1', name: 'Synthetic license.pdf', linkedTo: 'licenses:l1', data: 'data:application/pdf;base64,AAAA', storagePath: 'u/d1.pdf' },
    { id: 'd2', name: 'Synthetic renewal.pdf', linkedTo: 'licenses:l1', storagePath: 'u/d2.pdf', fileMissing: true },
  ],
};

test('a missing file is named', () => {
  const summary = packetSummary(DATA);
  assert.equal(summary.documents, 2);
  assert.deepEqual(summary.missing, ['Synthetic renewal.pdf']);
  assert.equal(typeof packetMissingLine, 'function');
  const line = packetMissingLine(summary);
  assert.match(line, /"Synthetic renewal\.pdf" is missing from your account/);
  assert.match(line, /Upload it again or delete it in Documents/);
  assert.doesNotMatch(line, /[—]/);
});

test('a file in the account beside a missing one: only the missing one is named', () => {
  const data = { ...DATA, documents: [...DATA.documents, { id: 'd3', name: 'Synthetic DEA.pdf', linkedTo: 'licenses:l1', storagePath: 'u/d3.pdf' }] };
  const summary = packetSummary(data);
  assert.equal(summary.documents, 3);
  assert.match(packetMissingLine(summary), /Synthetic renewal\.pdf/);
  assert.doesNotMatch(packetMissingLine(summary), /Synthetic DEA\.pdf/);
});

async function setupPage(summary, extra = {}) {
  const built = [];
  const tier = total => ({ complete: true, total, done: total });
  const ui = await mountComponent('src/components/features/SetupPage.jsx', {
    app: { data: { settings: {}, documents: [] }, theme: {}, isDesktop: false },
    props: extra,
    modules: {
      useSetupState: { useSetupState: () => ({
        setup: { counts: { tier1: tier(5), tier2: tier(6) }, tier1: [], tier2: [], skipped: [], notApplicable: [], byId: {}, open: [] },
        skip() {}, markNa() {}, restore() {}, declare() {}, narration: null, ackNarration() {},
      }) },
      setupTasks: { ladderState: () => ({ text: '', taskId: null, verb: '' }), TIER2_COPY: { header: 'Packet' } },
      credentialExport: {
        packetSummaryLine: credentialExport.packetSummaryLine,
        packetMissingLine: credentialExport.packetMissingLine,
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

test('Setup names the missing file instead of saying it is still coming back, and builds no partial ZIP', async () => {
  const { ui, built } = await setupPage({ lineItems: 1, documents: 2, missing: ['Synthetic renewal.pdf'] });
  const ending = node(ui, 'PacketEnding');
  await ending.props.onDownload();
  await settle();
  assert.equal(built.length, 0);
  const error = String(node(ui, 'PacketEnding').props.error || '');
  assert.match(error, /Synthetic renewal\.pdf/);
  assert.doesNotMatch(error, /still coming back/);
  const modal = node(ui, 'EmailPacketModal');
  assert.equal(modal.props.onDownloadPacket, undefined, 'the Send sheet does not offer the whole packet either');
});
