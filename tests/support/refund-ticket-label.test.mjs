// A ticket the refund ledger opens for a member (20260930071000) is filed in
// the member's name, so Get help lists it as theirs, but its opening text is
// CredentialDOMD's. Review round 3 (2026-09-30): Get help labelled that text
// "You" in member styling, and Admin showed it under the member's email as if
// the physician wrote it. It is labelled by source now; a member's own ticket
// still reads "You". The database keeps the source to the ledger
// (limited_refund_ticket_guard, tested in limited-refund-ticket-sql).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ID, ID2, fixture, ticket, openTicket } from './support-modal-harness.mjs';
import { ticketOpenedBySupport } from '../../src/utils/supportOperationsClient.js';

const AUTO = 'CredentialDOMD opened this ticket for you automatically.\n\nRefund: $99.00, your annual membership payment made on September 1, 2026.';
// The label line alone: who, a middle dot, the date (no ticket text).
const LABEL = /^(You|CredentialDOMD Support) · [0-9][0-9/.,:\s]*(AM|PM)?$/;
const labelsOf = f => f.nodes().filter(n => n.type === 'div' && LABEL.test(f.text(n)) && !/Refund:|Synthetic/.test(f.text(n)));

test('only a ticket the refund ledger opened reads as from Support', () => {
  assert.equal(ticketOpenedBySupport({ context_payload: { source: 'limited_refund', refund_request_id: ID } }), true);
  for (const t of [{ context_payload: {} }, { context_payload: { source: 'assistant' } }, { context_payload: null }, {}, null]) assert.equal(ticketOpenedBySupport(t), false);
});

test('Get help labels the refund ticket\'s text CredentialDOMD Support, styled as a team reply; the member\'s own ticket still reads You', async () => {
  const f = fixture({ tickets: [ticket(ID, { subject: `Issue ${ID}`, body: AUTO, context_payload: { source: 'limited_refund', refund_request_id: ID2 } }), ticket(ID2)] });
  await openTicket(f, ID);
  const labels = labelsOf(f);
  assert.equal(labels.length, 1, labels.map(n => f.text(n)).join(' | '));
  assert.match(f.text(labels[0]), /^CredentialDOMD Support · /, 'never "You" over text the member did not write');
  const own = fixture();
  await openTicket(own, ID);
  const mine = labelsOf(own);
  assert.equal(mine.length, 1);
  assert.match(own.text(mine[0]), /^You · /, 'a member\'s own words are still theirs');
  assert.notDeepEqual(labels[0].props.style, mine[0].props.style, 'styled as a team reply, not as the member');
});

test('Admin shows the refund ticket\'s text as CredentialDOMD\'s, for the member, not as the physician\'s', () => {
  const source = readFileSync(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
  const detail = source.slice(source.indexOf('Tap a ticket'), source.indexOf('{openTicket.body}'));
  assert.match(detail, /ticketOpenedBySupport\(openTicket\) \? `CredentialDOMD \(automatic\) for \$\{openTicket\.user_email\}` : openTicket\.user_email/);
});
