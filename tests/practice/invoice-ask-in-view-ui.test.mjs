// iOS 26 Simulator pass of the owner's invoice flows (2026-10-02), on the
// screens themselves:
//  1. Home's and the Invoices tab's reminder of an unanswered invoice: the
//     first one is the one brought into view (RevealOnShow, whose behaviour
//     is in invoice-ask-in-view-live.test.mjs), clear of the top and tab bars;
//  2. the Invoices tab's status badge ("OWED · 0D") is one unit that never
//     breaks across two lines on a phone.
// Synthetic contracts, numbers and amounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, pinClock } from '../harness/component-harness.mjs';

pinClock(test, 'America/Chicago', '2026-10-02T12:00:00-05:00');
const S = await loadScreens([
  'export {_resetInvoiceHandoff, keepInvoiceNote} from "./src/utils/invoiceHandoff.js";',
  'export {default as UnansweredInvoices} from "./src/components/shared/UnansweredInvoices.jsx";',
  'export {default as RevealOnShow} from "./src/components/shared/RevealOnShow.jsx";',
  'export {default as Invoices} from "./src/components/features/locum/Invoices.jsx";',
].join(' '));

const AGREEMENT = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 2000 };

test('Home and the Invoices tab: the first unanswered invoice comes into view with its button', () => {
  S._resetInvoiceHandoff();
  const at = '2026-10-02T15:00:00.000Z';
  S.keepInvoiceNote('', { number: 'INV-20261002-11', sentAt: at, kind: 'INV', contractId: 'c-s', total: 2000, days: ['2026-10-01'], handed: true });
  S.keepInvoiceNote('', { number: 'EXP-20261002-12', sentAt: at, kind: 'EXP', contractId: null, total: 42, expenseIds: ['x1'], handed: true });
  const card = mount(S.UnansweredInvoices, { data: { locumContracts: [AGREEMENT], invoices: [] }, props: { onOpen() {} } });
  const notes = nodes(card.render()).filter(n => n.type === S.RevealOnShow);
  assert.equal(notes.length, 2, 'each reminder is a RevealOnShow');
  const keyed = notes.filter(n => n.props.revealKey);
  assert.equal(keyed.length, 1, 'only one is brought into view');
  const first = keyed[0];
  assert.equal(first, notes[0], 'the first one');
  assert.equal(first.props.revealKey, first.key, 'keyed by its own number, so another invoice asks again');
  assert.equal(first.props.margins, 'page', 'clear of the sticky top bar and the phone tab bar');
  assert.equal(first.props.role, 'status');
  assert.match(textOf(first), /is not recorded\. Did it go out\?/);
  assert.match(textOf(first), /Open (Synthetic Hospital|Expenses)/, 'its button is inside what comes into view');
  S._resetInvoiceHandoff();
});

test('Invoices tab on a phone: the status badge is one unit, "OWED · 0D" never split over two lines', () => {
  S._resetInvoiceHandoff();
  const inv = { id: 'i1', number: 'INV-20261002-13', contractId: 'c-s', totalAmount: 18225, sentAt: '2026-10-02T15:00:00.000Z', payments: [] };
  const tab = mount(S.Invoices, { data: { locumContracts: [AGREEMENT], invoices: [inv] }, props: { onOpenContract() {}, onOpenExpenses() {} } });
  const badge = nodes(tab.render()).find(n => typeof n.type === 'function' && n.type.name === 'StandingBadge');
  assert.ok(badge, 'the card has its status badge');
  assert.equal(badge.props.tone.label, 'owed · 0d');
  // The harness does not expand a nested component: call it as React would.
  const span = badge.type(badge.props);
  assert.equal(span.type, 'span');
  assert.equal(span.props.style.whiteSpace, 'nowrap', 'the label never wraps inside the badge');
  assert.equal(span.props.style.display, 'inline-block', 'the badge moves to the next line whole, padding and color with it');
  assert.equal(textOf(span), 'owed · 0d');
});
