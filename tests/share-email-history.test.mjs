// An email with attachments sent from a record's Send sheet shows up in that
// record's Send history (SHARE-003). send-packet-email wrote every share_log
// row with item_id null and item_name "Email packet (N files)", and the
// Send sheet's history matches a row by item_id (or a null item_id with the
// record's own name), so the email never appeared. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as docLabel from '../src/utils/docLabel.js';
import * as paused from '../src/utils/pausedApplicationRecords.js';
import * as outgoingText from '../src/utils/outgoingText.js';
import { shareLogItem } from '../supabase/functions/_shared/requestFlow.ts';
import { mountComponent, settle } from './component-harness.mjs';

const LICENSE_ID = '11111111-2222-4333-8444-555555555555';
const DOC = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'license.pdf', type: 'application/pdf', size: 100, linkedTo: `licenses:${LICENSE_ID}`, data: 'data:application/pdf;base64,JVBERi0=', storagePath: `user_x/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` };

async function sendFrom(props) {
  const bodies = [];
  const supabase = {
    functions: { invoke: async (_name, { body }) => { bodies.push(body); return { data: { ok: true, email_id: 'e1', attached: 1 } }; } },
    from: () => { const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, limit: async () => ({ data: [] }) }; return q; },
  };
  const ui = await mountComponent('src/components/features/EmailPacketModal.jsx', {
    app: { data: { settings: { name: 'Rowan Testa', degreeType: 'MD', email: 'rowan.testa@clinic.example' }, documents: [DOC] }, updateSection() {}, userIdRef: { current: 'p1' }, theme: {} },
    props: { open: true, onClose() {}, request: null, initialTo: 'casey.example@osterly-health.example', initialSubject: 'License', initialNote: 'Hello', initialDocIds: [DOC.id], ...props },
    modules: { supabase: { supabase }, docLabel, pausedApplicationRecords: paused, outgoingText, 'react-dom': { createPortal: el => el }, useInputStyle: { useInputStyle: () => ({ fontSize: 16 }) } },
  });
  const send = ui.nodes().find(n => n.type === 'button' && /^Send 1 document$/.test(ui.text(n)));
  assert.ok(send, 'the Send button');
  await send.props.onClick();
  await settle();
  return bodies[0];
}

test('the Send sheet names the record it was opened for, so the server can log the email against it', async () => {
  const body = await sendFrom({ shareItem: { id: LICENSE_ID, name: 'State Medical License, CO', section: 'licenses' } });
  assert.equal(body.item_id, LICENSE_ID);
  assert.equal(body.item_name, 'State Medical License, CO');
  assert.equal(body.item_section, 'licenses');
});

test('a send with no record (Vera, the packet) carries no item', async () => {
  const body = await sendFrom({});
  assert.ok(!('item_id' in body) && !('item_name' in body) && !('item_section' in body));
});

test('ShareModal hands its record to the email sheet', async () => {
  const src = await readFile(new URL('../src/components/features/ShareModal.jsx', import.meta.url), 'utf8');
  const i = src.indexOf('<EmailPacketModal');
  const block = src.slice(i, src.indexOf('/>', i));
  assert.match(block, /shareItem=\{/);
});

test('send-packet-email reads the item only as a label: a uuid, a plain name, a known section', () => {
  eq(shareLogItem({ item_id: LICENSE_ID, item_name: '  State Medical License, CO ', item_section: 'licenses' }), { itemId: LICENSE_ID, itemName: 'State Medical License, CO', section: 'licenses' });
  eq(shareLogItem({ item_id: 'not-a-uuid', item_name: 'X', item_section: 'licenses' }), { itemId: null, itemName: 'X', section: 'licenses' });
  eq(shareLogItem({ item_id: LICENSE_ID, item_name: 'Two\nlines', item_section: 'nonsense' }), { itemId: LICENSE_ID, itemName: 'Two lines', section: 'documents' });
  assert.equal(shareLogItem({ item_name: 'x'.repeat(500), item_section: 'cme' }).itemName.length, 200);
  eq(shareLogItem({}), null);
  eq(shareLogItem({ item_section: 'licenses' }), null, 'no id and no name is no item');
});

function eq(got, want, msg) { assert.equal(JSON.stringify(got), JSON.stringify(want), msg); }
