// Vera's "Reply by email" answers the request the card was built for, never
// a request left over in the session (INTAKE-005). Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountVera } from './assistant-harness.mjs';

const REQUEST_A = { id: '11111111-1111-4111-8111-111111111111', from_addr: 'casey.example@osterly-health.example', subject: 'Docs for your file' };
const LICENSE_DOC = { id: 'doc-1', name: 'license.pdf', type: 'application/pdf', linkedTo: 'licenses:l1', data: 'data:application/pdf;base64,JVBERi0=' };
const packetTurn = async () => ({ reply: 'Here is the packet.', actions: [{ kind: 'send_packet', docIds: ['doc-1'], coverNote: 'Hello,', summary: 'License to someone else' }] });

test('a packet card from a chat opened for a request answers that request', async () => {
  const v = await mountVera({ props: { requestContext: REQUEST_A }, data: { documents: [LICENSE_DOC] }, turn: packetTurn });
  await v.ask('build the packet for this request');
  await v.button('Reply by email').props.onClick();
  v.render();
  const modal = v.node('EmailPacketModal');
  assert.equal(modal.props.request?.id, REQUEST_A.id);
  assert.equal(modal.props.request?.from_addr, REQUEST_A.from_addr);
});

test('a card with no request of its own is sent as a new email, even while an old request is in the session', async () => {
  // The card was built in a turn with no request (opened from More); the
  // session still holds request A from earlier.
  const saved = [
    { id: 'm1', role: 'user', text: 'send my license to someone else' },
    { id: 'm2', role: 'model', text: 'Here it is.', actions: [{ kind: 'send_packet', docIds: ['doc-1'], coverNote: 'Hello,', summary: 'License', request: null }] },
  ];
  const v = await mountVera({ props: { requestContext: REQUEST_A }, data: { documents: [LICENSE_DOC] }, saved });
  await v.button('Reply by email').props.onClick();
  v.render();
  assert.equal(v.node('EmailPacketModal').props.request, null, 'not addressed to or recorded against request A');
});

test('a card saved before cards carried their request is not bound to the session\'s request', async () => {
  const saved = [
    { id: 'm1', role: 'user', text: 'send my license' },
    { id: 'm2', role: 'model', text: 'Here it is.', actions: [{ kind: 'send_packet', docIds: ['doc-1'], coverNote: 'Hello,', summary: 'License' }] },
  ];
  const v = await mountVera({ props: { requestContext: REQUEST_A }, data: { documents: [LICENSE_DOC] }, saved });
  await v.button('Reply by email').props.onClick();
  v.render();
  assert.equal(v.node('EmailPacketModal').props.request, null);
});

test('New chat lets go of the request', async () => {
  const cleared = [];
  const v = await mountVera({ props: { requestContext: REQUEST_A, onClearRequest: () => cleared.push(true) }, data: { documents: [LICENSE_DOC] }, turn: packetTurn });
  await v.ask('build the packet');
  const newChat = v.buttons().find(b => /New chat/.test(v.text(b)));
  assert.ok(newChat, 'New chat is on screen');
  newChat.props.onClick();
  assert.equal(cleared.length, 1);
});

test('opening Vera from More does not carry a request from earlier', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const i = app.indexOf('{/* Assistant */}');
  assert.ok(i > 0);
  const button = app.slice(i, app.indexOf('className=', i));
  assert.match(button, /setVeraRequest\(null\)/, button);
  assert.match(app, /onClearRequest=\{\(\) => setVeraRequest\(null\)\}/);
});
