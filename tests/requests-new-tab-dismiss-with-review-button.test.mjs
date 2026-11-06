// Owner ticket 16ba1758, att-1: the screenshot shows a New-tab request card
// with a packet proposal, offering only a packet action and no way to close
// the request without acting on it. The component harness never calls into
// a child component (RequestsInbox.jsx's own ReviewButton/ApproveSendButton
// elements stay opaque leaf nodes, keyed by component identity, not text),
// so this pins the card by that identity: a New-tab row with a proposal
// still renders its ReviewButton element AND a real Dismiss button, and
// tapping Dismiss closes the request without sending anything. Every row is
// synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from './component-harness.mjs';

const OWN = '10000000-0000-4000-8000-0000000000a2';

function table(rows) {
  const db = rows.map(r => ({ ...r }));
  const writes = [];
  const invokes = [];
  const from = (name) => {
    const filters = [];
    let patch = null;
    let wantRows = false;
    const run = () => {
      const hit = db.filter(r => filters.every(([c, v]) => r[c] === v));
      if (patch) {
        writes.push({ table: name, patch: { ...patch }, filters: [...filters] });
        for (const r of hit) Object.assign(r, patch);
        return { data: wantRows ? hit.map(r => ({ id: r.id })) : null, error: null };
      }
      return { data: hit.map(r => ({ ...r })), error: null };
    };
    const b = {
      select() { if (patch) wantRows = true; return b; },
      update(p) { patch = p; return b; },
      insert() { return b; },
      eq(c, v) { filters.push([c, v]); return b; },
      is() { return b; },
      order() { return b; },
      single() { return b; },
      then(res, rej) { return Promise.resolve(name === 'document_requests' ? run() : { data: [], error: null }).then(res, rej); },
    };
    return b;
  };
  const client = { from, functions: { invoke: (fn) => { invokes.push(fn); return Promise.resolve({ data: null, error: null }); } } };
  return { client, db, writes, invokes };
}

async function mount(client) {
  const packet = await import('../src/components/features/RequestPacket.js');
  const T = new Proxy({}, { get: () => '#123456' });
  const app = { data: { settings: {}, documents: [] }, loaded: true, user: { email: 'owner@example.invalid' }, theme: T, navigate() {}, userIdRef: { current: OWN }, isDesktop: true, addItem() {}, editItem() {}, deleteItem() {} };
  const view = await mountComponent('src/components/features/RequestsInbox.jsx', {
    app,
    modules: {
      supabase: { supabase: client },
      useRequestProposals: { useRequestProposals: rows => rows },
      useIntakeNotes: { useIntakeNotes: () => ({ notes: [], replace() {} }) },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
      forwardingAddresses: { forwardingSenders: () => [], routableSenders: () => [], joinAddresses: () => '', accountMailboxVerified: () => false, CONFIRM_FIRST_SENTENCE: '' },
      RequestPacket: packet,
    },
    globals: {
      window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
      fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    },
  });
  view.render();
  await settle();
  const button = (label) => view.nodes().find(n => n.type === 'button' && view.text(n).trim() === label);
  const reviewElement = () => view.nodes().find(n => n.type === packet.ReviewButton);
  return { view, button, reviewElement };
}

const ROW = {
  id: 'req-2', user_id: OWN, status: 'new', from_addr: 'credentialing@example.invalid', from_name: 'Example Credentialing Office',
  subject: 'RE: Checking in', body_text: 'I wanted to check to see if you could send me your reference.',
  received_at: '2026-10-29T10:00:00Z',
  // A proposal that read an ask but matched nothing on file, so the card
  // offers Review, not a one-tap send (requestPacket.js oneTapReady: a
  // non-model source is never one-tap ready).
  proposal: { source: 'rules-client', items: [{ status: 'missing', kind: 'reference', ask: 'send me your reference' }] },
};

test('a New-tab card with a packet proposal also offers Dismiss, which closes it without opening the packet', async () => {
  const { client, db, writes, invokes } = table([ROW]);
  const { view, button, reviewElement } = await mount(client);
  assert.ok(reviewElement(), 'the card renders its packet action (ReviewButton), the control the ticket screenshot showed alone');
  const dismiss = button('Dismiss');
  assert.ok(dismiss, 'the same card also shows a Dismiss button, not just the packet action');

  dismiss.props.onClick({ stopPropagation() {} });
  await settle();
  view.render();

  const write = writes.find(w => w.table === 'document_requests');
  assert.equal(write.patch.status, 'dismissed');
  assert.equal(db[0].status, 'dismissed');
  assert.deepEqual(invokes, [], 'dismissing sends no email and opens no packet');
  assert.doesNotMatch(view.pageText(), /Checking in/, 'the dismissed request leaves the New tab');
});
