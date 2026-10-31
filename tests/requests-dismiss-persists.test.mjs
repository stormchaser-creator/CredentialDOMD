// Owner ticket 16ba1758: a request the physician will not act on must be
// closable without sending anything, and it must STAY closed: across a
// reload and on another device, which means the closing write has to land on
// the stored row, not just hide the card on this screen. The fake client
// below is a tiny in-memory document_requests table that applies the update
// and the filters the code asks for, so a remount reads what was stored.
// Every row is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from './component-harness.mjs';

const OWN = '10000000-0000-4000-8000-0000000000a1';

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
  const client = { from, functions: { invoke: (fn, body) => { invokes.push(fn); return Promise.resolve({ data: null, error: null }); } } };
  return { client, db, writes, invokes };
}

async function mount(client) {
  const packet = await import('../src/components/features/RequestPacket.js');
  const T = new Proxy({}, { get: () => '#123456' });
  const app = { data: { settings: {}, documents: [] }, loaded: true, user: { email: 'owner@example.invalid' }, theme: T, navigate() {}, userIdRef: { current: OWN }, isDesktop: true, addItem() {}, editItem() {}, deleteItem() {} };
  const fetches = [];
  const view = await mountComponent('src/components/features/RequestsInbox.jsx', {
    app,
    modules: {
      supabase: { supabase: client },
      RequestPacket: { ...packet, ApproveSendButton: () => null, ReviewButton: () => null, ProposalChecklist: () => null, UnclearNote: () => null },
      useRequestProposals: { useRequestProposals: rows => rows },
      useIntakeNotes: { useIntakeNotes: () => ({ notes: [], replace() {} }) },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
      forwardingAddresses: { forwardingSenders: () => [], routableSenders: () => [], joinAddresses: () => '', accountMailboxVerified: () => false, CONFIRM_FIRST_SENTENCE: '' },
    },
    globals: {
      window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
      fetch: (...a) => { fetches.push(a); return Promise.resolve({ ok: true, json: async () => ({}) }); },
    },
  });
  view.render();
  await settle();
  const button = (label) => view.nodes().find(n => n.type === 'button' && view.text(n).trim() === label);
  const tabButton = (key) => view.nodes().find(n => n.type === 'button' && new RegExp(`^${key}\\b`).test(view.text(n).trim()));
  return { view, button, tabButton, fetches };
}

const ROW = { id: 'req-1', user_id: OWN, status: 'new', from_addr: 'office@example.invalid', from_name: 'Example Credentialing Office', subject: 'Checking in', body_text: 'Could you send the reference?', received_at: '2026-10-29T10:00:00Z' };

test('Dismiss on a request card writes status dismissed to the stored row, and a reload keeps it out of New', async () => {
  const { client, db, writes, invokes } = table([ROW]);
  const first = await mount(client);
  assert.match(first.view.pageText(), /New \(1\)/);
  const dismiss = first.button('Dismiss');
  assert.ok(dismiss, 'the new request card has a Dismiss button');
  dismiss.props.onClick({ stopPropagation() {} });
  await settle();
  first.view.render();

  const write = writes.find(w => w.table === 'document_requests');
  assert.equal(write.patch.status, 'dismissed');
  assert.equal(db[0].status, 'dismissed', 'the stored row is dismissed, not just the card');
  assert.deepEqual(invokes, [], 'closing a request sends no email');
  assert.doesNotMatch(first.view.pageText(), /Could you send the reference/);

  // A reload, or the same account on another device, reads the stored row.
  const second = await mount(client);
  const page = second.view.pageText();
  assert.doesNotMatch(page, /New \(/, 'New has no count left');
  assert.match(page, /Dismissed \(1\)/);
  assert.doesNotMatch(page, /Could you send the reference/);
  second.tabButton('Dismissed').props.onClick();
  second.view.render();
  assert.match(second.view.pageText(), /Checking in/, 'the Dismissed tab lists it');
});

test('a dismissed request goes back to New from its Dismissed view, stored the same way', async () => {
  const { client, db, invokes } = table([{ ...ROW, status: 'dismissed' }]);
  const m = await mount(client);
  m.tabButton('Dismissed').props.onClick();
  m.view.render();
  const card = m.view.nodes().find(n => n.type === 'div' && n.props.role === 'button');
  card.props.onClick();
  m.view.render();
  m.button('Move back to New').props.onClick();
  await settle();
  assert.equal(db[0].status, 'new');
  assert.deepEqual(invokes, []);
  const again = await mount(client);
  assert.match(again.view.pageText(), /New \(1\)/);
});

test('a dismiss that changed no stored row is not shown as done: the card comes back with a reason', async () => {
  // Another device replied to this request a moment ago. The screen still
  // reads it as new; the stored row is replied. Dismissing it here must not
  // overwrite the reply's record, and must not pretend it closed anything.
  const { client, db } = table([ROW]);
  const stale = await mount(client);
  db[0].status = 'replied';
  stale.button('Dismiss').props.onClick({ stopPropagation() {} });
  await settle();
  stale.view.render();
  assert.equal(db[0].status, 'replied', 'the reply on the stored row is kept');
  assert.match(stale.view.pageText(), /already answered or dismissed/);
});
