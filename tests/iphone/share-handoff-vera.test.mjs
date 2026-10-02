// SHARE-004 under Vera on the installed iPhone app (QA lab, WebKit + the iOS
// model, 3 runs): Approve on "Send packet · 1 documents" > share sheet > Mail.
// The sheet's promise never settles once Mail takes over: no share_log row,
// and the card stayed on a disabled "Working…" for as long as the page lived.
// The packet is now recorded and the card done as the files go.
// Synthetic files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../../src/utils/inboxDocs.js';
import { mountVera } from '../assistant-harness.mjs';
import { settle } from '../component-harness.mjs';

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF synthetic').toString('base64');
const DOCS = [{ id: 'doc-a', name: 'a-license.pdf', type: 'application/pdf', data: PDF, linkedTo: 'licenses:l-1' }];
const packet = { kind: 'send_packet', docIds: ['doc-a'], coverNote: 'Enclosed: the license.', summary: 'To the agency' };

async function mount(share) {
  const shared = [];
  const v = await mountVera({
    data: { documents: DOCS },
    modules: { inboxDocs, supabase: { supabase: null, downloadDocumentBlob: async () => null } },
    turn: async () => ({ reply: 'Here is the packet.', actions: [packet] }),
    globals: {
      navigator: { userAgent: 'Synthetic iPhone', clipboard: { writeText: async () => {} }, canShare: () => true, share: (p) => { shared.push(p); return share(p); } },
    },
  });
  await v.ask('send my license to the agency');
  await settle(); v.render();
  return { v, shared };
}

test('a share sheet that never answers: the packet is recorded and the card is done, not "Working…"', async () => {
  const { v, shared } = await mount(() => new Promise(() => {}));
  const approve = v.button('Approve');
  assert.ok(approve, `Approve offered (have: ${v.buttons().map(b => v.text(b).trim()).join(' | ')})`);
  void approve.props.onClick();
  for (let i = 0; i < 6; i++) { await settle(); v.render(); }
  assert.equal(shared.length, 1, 'the file went to the share sheet');
  const logged = v.rec.of('addItem').filter(c => c[1] === 'shareLog');
  assert.deepEqual(logged.map(c => c[2].itemName), ['Vera packet (1 files)']);
  const labels = v.buttons().map(b => v.text(b).trim());
  assert.ok(!labels.some(l => /Working/.test(l)), `no busy button left: ${labels.join(' | ')}`);
  assert.ok(!labels.includes('Approve'), 'not offered again: it went');
});

test('a cancelled share takes the record back and offers Approve again', async () => {
  const { v } = await mount(async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); });
  await v.button('Approve').props.onClick();
  for (let i = 0; i < 4; i++) { await settle(); v.render(); }
  const logged = v.rec.of('addItem').filter(c => c[1] === 'shareLog');
  assert.equal(logged.length, 1);
  assert.deepEqual(v.rec.of('deleteItem').map(c => [c[1], c[2]]), [['shareLog', logged[0][2].id]]);
  assert.ok(v.button('Approve'), 'Approve again');
});
