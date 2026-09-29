// A reply email links to /app/#support/<ticket id> (send-ticket-reply,
// 20260929134100). App.jsx turns that hash into initialTicketId; the real
// SupportModal then opens that ticket once its list loads. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ID, ID2, fixture, ticket, tick } from './support-modal-harness.mjs';

const openSubject = f => f.nodes().find(n => n.type === 'h2' && /^Issue /.test(f.text(n)))?.props.children ?? null;
const listed = (f, id) => f.nodes().some(n => n.type === 'button' && f.text(n).includes(`Issue ${id}`));

test('a linked ticket opens straight away on "Your tickets"', async () => {
  const f = fixture({ props: { initialTab: 'tickets', initialTicketId: ID2 } });
  f.render(); await tick(); f.render(); await tick(); f.render();
  assert.equal(openSubject(f), `Issue ${ID2}`, 'the thread of the linked ticket is open');
  f.button('Back').props.onClick(); f.render(); await tick(); f.render();
  assert.equal(openSubject(f), null, 'Back shows the list, and the link does not reopen the ticket');
  assert.ok(listed(f, ID) && listed(f, ID2));
});

test('a link to a ticket that is not in the member\'s list leaves the list showing', async () => {
  const f = fixture({ props: { initialTab: 'tickets', initialTicketId: '33333333-3333-4333-8333-333333333333' } });
  f.render(); await tick(); f.render();
  assert.equal(openSubject(f), null);
  assert.ok(listed(f, ID), 'the member\'s own tickets are listed');
});

test('without a linked ticket the sheet opens on the list, as the older #support link did', async () => {
  const f = fixture({ props: { initialTab: 'tickets' } });
  f.render(); await tick(); f.render();
  assert.equal(openSubject(f), null);
  assert.ok(listed(f, ID2));
});

test('with support operations on, the linked ticket opens through the operations client', async () => {
  const reads = [];
  const f = fixture({ operations: true, props: { initialTab: 'tickets', initialTicketId: ID },
    operationsClient: { list: async () => [ticket(ID), ticket(ID2)], read: async id => { reads.push(id); return { ticket: ticket(id), messages: [], before_message_id: null }; } } });
  f.render(); await tick(); f.render(); await tick(); f.render();
  assert.deepEqual(reads, [ID]);
  assert.equal(openSubject(f), `Issue ${ID}`);
});

test('App.jsx hands the email link to the sheet and clears it on close', () => {
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const supportLink = supportDeepLink\(hash\);\n\s+if \(supportLink\) \{\n\s+setSupportTab\("tickets"\);\n\s+setSupportTicketId\(supportLink\.ticketId\);\n\s+setShowSupport\(true\);/);
  assert.match(app, /<SupportModal open=\{showSupport\} onClose=\{\(\) => \{ setShowSupport\(false\); setSupportTab\("new"\); setSupportTicketId\(null\); \}\} initialTab=\{supportTab\} initialTicketId=\{supportTicketId\}/);
});
