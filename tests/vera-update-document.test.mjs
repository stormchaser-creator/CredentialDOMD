// Filing an emailed inbox document through Vera takes it out of the inbox
// type, as every other filing path does (VERA-011). update_document set
// linkedTo but left type "email-inbox", which record views read as the MIME
// type: no thumbnail, and View opened a Blob of type "email-inbox". A later
// packet share built File{type:"email-inbox"}. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as inboxDocs from '../src/utils/inboxDocs.js';
import { mountVera } from './assistant-harness.mjs';
import { settle } from './component-harness.mjs';

const LICENSE = { id: 'lic-1', type: 'State Medical License', state: 'CO' };
const inboxDoc = (type) => ({ id: 'doc-1', name: 'forwarded.pdf', type, mimeType: 'application/pdf', linkedTo: '', data: 'data:application/pdf;base64,JVBERi0=' });

async function approve(action, doc) {
  const v = await mountVera({
    data: { documents: [doc], licenses: [LICENSE] },
    modules: { inboxDocs },
    turn: async () => ({ reply: 'Done.', actions: [action] }),
  });
  await v.ask('file it');
  await v.button('Approve').props.onClick();
  await settle();
  return v.rec.of('editItem').filter(c => c[1] === 'documents').map(c => c[2]);
}

for (const type of ['email-inbox', 'cme-certificate-inbox']) {
  test(`linking a ${type} document writes its MIME type into type`, async () => {
    const [written] = await approve({ kind: 'update_document', id: 'doc-1', linkedTo: 'licenses:lic-1', name: 'CO license.pdf', summary: 'File it' }, inboxDoc(type));
    assert.equal(written.linkedTo, 'licenses:lic-1');
    assert.equal(written.type, 'application/pdf');
    assert.equal(written.name, 'CO license.pdf');
  });
}

test('unlinking leaves the type as it was', async () => {
  const [written] = await approve({ kind: 'update_document', id: 'doc-1', linkedTo: '', summary: 'Unlink it' }, { ...inboxDoc('email-inbox'), linkedTo: 'licenses:lic-1' });
  assert.equal(written.linkedTo, '');
  assert.equal(written.type, 'email-inbox');
});

test('a Vera packet share of an emailed file sends it with its real MIME type', async () => {
  const shared = [];
  const v = await mountVera({
    data: { documents: [inboxDoc('email-inbox')] },
    modules: { inboxDocs },
    turn: async () => ({ reply: 'Here.', actions: [{ kind: 'send_packet', docIds: ['doc-1'], coverNote: 'Hello,', summary: 'To someone' }] }),
    globals: { navigator: { userAgent: 'Synthetic', clipboard: { writeText: async () => {} }, canShare: () => true, share: async ({ files }) => { shared.push(...files); } } },
  });
  await v.ask('send it');
  await v.button('Approve').props.onClick();
  await settle();
  assert.equal(shared.length, 1);
  assert.equal(shared[0].type, 'application/pdf');
});
