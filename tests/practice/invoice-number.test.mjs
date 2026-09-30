import test from 'node:test';
import assert from 'node:assert/strict';
import { pinClock } from '../harness/component-harness.mjs';
import { nextInvoiceNumber } from '../../src/utils/helpers.js';
import { invoiceDocumentArgs } from '../../src/utils/invoiceArgs.js';

// Invoice numbers (PRAC-007, PRAC-030). An AP department treats the number
// as the invoice's identity, so it must never repeat, and its date is the
// physician's own calendar day. 6 PM Pacific on Sep 29 is 01:00 UTC Sep 30.

const clock = pinClock(test, 'America/Los_Angeles', '2026-09-30T01:00:00.000Z');

test('PRAC-030: the number carries the local date, not the UTC one', () => {
  assert.equal(nextInvoiceNumber([]), 'INV-20260929-01');
});

test('PRAC-007: two expense invoices on one day get -01 and -02', () => {
  const first = nextInvoiceNumber([], 'EXP');
  assert.equal(first, 'EXP-20260929-01');
  assert.equal(nextInvoiceNumber([{ number: first }], 'EXP'), 'EXP-20260929-02');
});

test('PRAC-007: an INV invoice the same day does not shift or collide with the EXP sequence', () => {
  const list = [{ number: 'INV-20260929-01' }];
  const a = nextInvoiceNumber(list, 'EXP');
  const b = nextInvoiceNumber([...list, { number: a }], 'EXP');
  assert.deepEqual([a, b], ['EXP-20260929-01', 'EXP-20260929-02']);
  assert.equal(nextInvoiceNumber([...list, { number: a }, { number: b }]), 'INV-20260929-02');
});

test('PRAC-030: after an earlier number is deleted the next one is past the highest, never a gap refill', () => {
  assert.equal(nextInvoiceNumber([{ number: 'INV-20260929-01' }, { number: 'INV-20260929-03' }]), 'INV-20260929-04');
});

test('a number with a device suffix (issued offline) still counts toward the sequence', () => {
  assert.equal(nextInvoiceNumber([{ number: 'INV-20260929-02-K7Q' }]), 'INV-20260929-03');
});

test('PRAC-030: the Issued date on a resend is the local day the invoice was sent', () => {
  const args = invoiceDocumentArgs({ number: 'INV-20260929-01', sentAt: '2026-09-30T01:00:00.000Z', totalAmount: 100, lines: [] }, null, {}, 'Synthetic General');
  assert.equal(args.issuedDate, '2026-09-29');
  clock.setNow('2026-09-30T01:00:00.000Z');
});
