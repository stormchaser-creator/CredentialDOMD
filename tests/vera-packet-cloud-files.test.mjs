// Vera's packet shares the files its cover note lists (VERA-003). The offline
// copy keeps no bytes for a document already in the cloud, and Approve shared
// only documents whose bytes were in memory: a 3-document packet went out
// with 1 file while the cover note named all 3, and "Sent 1 of 3" appeared
// only after the share. The files are now fetched while the card waits (not
// in the tap, which would lose the share sheet's gesture), and a packet that
// still cannot carry every file says so on the card before Approve.
// Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF synthetic a').toString('base64');
const DOCS = [
  { id: 'doc-a', name: 'a-license.pdf', type: 'application/pdf', data: PDF, linkedTo: 'licenses:l-1' },
  { id: 'doc-b', name: 'b-diploma.pdf', type: 'application/pdf', storagePath: 'u/doc-b.pdf', linkedTo: 'education:e-1' },
  { id: 'doc-c', name: 'c-dea.pdf', type: 'application/pdf', storagePath: 'u/doc-c.pdf', linkedTo: 'licenses:l-2' },
];
const packetTurn = async () => ({ reply: 'Here is the packet.', actions: [{ kind: 'send_packet', docIds: ['doc-a', 'doc-b', 'doc-c'], coverNote: 'Enclosed: license, diploma, DEA.', summary: 'To the agency' }] });

async function mount(download) {
  const shared = [];
  const supabase = { from: () => ({ insert: () => ({ then: (a) => a({}) }) }) };
  const v = await mountVera({
    data: { documents: DOCS },
    modules: { inboxDocs, supabase: { supabase, downloadDocumentBlob: download } },
    turn: packetTurn,
    globals: { navigator: { userAgent: 'Synthetic', clipboard: { writeText: async () => {} }, canShare: () => true, share: async ({ files }) => { shared.push(...files); } } },
  });
  await v.ask('send my packet to the agency');
  await settle();
  v.render();
  return { v, shared };
}

test('a document held only in the cloud is fetched before Approve and shared with the rest', async () => {
  // downloadDocumentBlob(path, { detail: true }): doc-c is gone from storage.
  const { v, shared } = await mount(async (path) => (path === 'u/doc-b.pdf' ? { blob: new Blob(['%PDF synthetic b'], { type: 'application/pdf' }) } : { missing: true }));
  const page = v.pageText();
  assert.match(page, /Not on this device, so not shared: c-dea\.pdf\./, 'said before Approve');
  assert.match(page, /The cover note still names all 3\./);
  const approve = v.button('Share 2 of 3');
  assert.ok(approve, 'Approve says how many files the share carries');
  await approve.props.onClick();
  await settle();
  assert.deepEqual(shared.map(f => f.name), ['a-license.pdf', 'b-diploma.pdf']);
  assert.equal(shared[1].type, 'application/pdf');
});

test('Approve while a file is still downloading shares nothing yet', async () => {
  let finish;
  const { v, shared } = await mount(() => new Promise(r => { finish = r; }));
  assert.match(v.pageText(), /Getting 2 files ready/);
  await v.button('Approve').props.onClick();
  await settle();
  v.render();
  assert.equal(shared.length, 0, 'no partial share while files are on their way');
  assert.match(v.pageText(), /Still getting 2 of 3 files ready\. Approve again in a moment\./);
  finish({ blob: new Blob(['%PDF synthetic'], { type: 'application/pdf' }) });
});
