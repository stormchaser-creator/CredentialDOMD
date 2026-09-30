import test from 'node:test';
import assert from 'node:assert/strict';
import { pinClock } from '../harness/component-harness.mjs';
import { reserveInvoiceNumber, invoiceNumberUsed, _resetHeldInvoiceNumbers } from '../../src/utils/invoiceNumber.js';

// PRAC-030: the device asks the server for each invoice number, and falls
// back safely when it cannot. Unit level; the server is a fake with its own
// ledger, as allocate_invoice_number keeps one.

pinClock(test, 'America/Los_Angeles', '2026-09-29T18:00:00-07:00');

// One account's ledger on the "server": every number it hands out is kept.
function fakeServer() {
  const issued = new Set();
  const calls = [];
  const rpc = (kind, day, atLeast) => {
    calls.push([kind, day, atLeast]);
    let n = Math.max(1, atLeast);
    while (issued.has(`${kind}-${day}-${String(n).padStart(2, '0')}`)) n += 1;
    const number = `${kind}-${day}-${String(n).padStart(2, '0')}`;
    issued.add(number);
    return Promise.resolve({ data: number, error: null });
  };
  return { rpc, calls, issued };
}

test('two devices holding the same list get -01 and -02 from the server', async () => {
  _resetHeldInvoiceNumbers();
  const server = fakeServer();
  const a = reserveInvoiceNumber([], 'INV', { rpc: server.rpc });
  assert.equal(a.number, 'INV-20260929-01');
  assert.equal(a.pending, true);
  assert.equal(await a.done, 'INV-20260929-01');
  invoiceNumberUsed('INV-20260929-01'); // device A recorded it
  // Device B has not seen A's invoice yet: the same list, the same local
  // guess, and nothing of A's in its memory.
  _resetHeldInvoiceNumbers();
  const b = reserveInvoiceNumber([], 'INV', { rpc: server.rpc });
  assert.equal(b.number, 'INV-20260929-01');
  assert.equal(await b.done, 'INV-20260929-02');
  assert.deepEqual(server.calls[0], ['INV', '20260929', 1]);
});

test('a number whose invoice was deleted is not issued again', async () => {
  _resetHeldInvoiceNumbers();
  const server = fakeServer();
  const first = await reserveInvoiceNumber([], 'INV', { rpc: server.rpc }).done;
  invoiceNumberUsed(first);
  const second = await reserveInvoiceNumber([{ number: first }], 'INV', { rpc: server.rpc }).done;
  invoiceNumberUsed(second);
  // -02 is deleted: the list holds only -01 again. This device spent -02, so
  // it does not even guess it.
  const same = reserveInvoiceNumber([{ number: first }], 'INV', { rpc: server.rpc });
  assert.equal(same.number, 'INV-20260929-03');
  assert.equal(await same.done, 'INV-20260929-03');
  invoiceNumberUsed('INV-20260929-03');
  // Another device guesses -02 from the list; the server never issues it again.
  _resetHeldInvoiceNumbers();
  const other = reserveInvoiceNumber([{ number: first }], 'INV', { rpc: server.rpc });
  assert.equal(other.number, 'INV-20260929-02');
  assert.equal(await other.done, 'INV-20260929-04');
});

test('a preview closed unsent keeps its number for the next preview (no gap, no second ask)', async () => {
  _resetHeldInvoiceNumbers();
  const server = fakeServer();
  const first = await reserveInvoiceNumber([], 'EXP', { rpc: server.rpc }).done;
  const again = reserveInvoiceNumber([], 'EXP', { rpc: server.rpc });
  assert.deepEqual([again.number, again.pending], [first, false]);
  assert.equal(server.calls.length, 1);
});

test('no function on the server yet (migration not applied): the device number, unchanged', async () => {
  _resetHeldInvoiceNumbers();
  const rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.allocate_invoice_number' } });
  assert.equal(await reserveInvoiceNumber([{ number: 'INV-20260929-01' }], 'INV', { rpc }).done, 'INV-20260929-02');
});

test('offline, a failed call or no answer in time: a device-suffixed number no other device issues', async () => {
  _resetHeldInvoiceNumbers();
  const random = () => 0; // deterministic tag
  const off = reserveInvoiceNumber([], 'INV', { rpc: () => { throw new Error('must not be called offline'); }, online: false, random });
  assert.deepEqual([off.number, off.pending], ['INV-20260929-01-AAA', false]);
  const failed = reserveInvoiceNumber([], 'INV', { rpc: () => Promise.reject(new Error('network')), random });
  assert.equal(await failed.done, 'INV-20260929-01-AAA');
  const refused = reserveInvoiceNumber([], 'INV', { rpc: () => Promise.resolve({ error: { code: '42501', message: 'practice is read-only' } }), random });
  assert.equal(await refused.done, 'INV-20260929-01-AAA');
  const slow = reserveInvoiceNumber([], 'INV', { rpc: () => new Promise(() => {}), timeoutMs: 5, random });
  assert.equal(await slow.done, 'INV-20260929-01-AAA');
});

test('no cloud client (local development): the device number at once', () => {
  _resetHeldInvoiceNumbers();
  const r = reserveInvoiceNumber([], 'INV', { rpc: () => null });
  assert.deepEqual([r.number, r.pending], ['INV-20260929-01', false]);
});

test('a number kept for one account is never handed to another signed in on the same device', async () => {
  _resetHeldInvoiceNumbers();
  const server = fakeServer();
  const a = await reserveInvoiceNumber([], 'INV', { rpc: server.rpc, account: 'profile-a' }).done;
  const b = reserveInvoiceNumber([], 'INV', { rpc: server.rpc, account: 'profile-b' });
  assert.equal(b.pending, true, 'account B asks its own server ledger');
  assert.equal(a, 'INV-20260929-01');
  assert.equal(reserveInvoiceNumber([], 'INV', { rpc: server.rpc, account: 'profile-a' }).number, a, 'account A still gets its kept number');
});

// PRAC-030: a number the device issued itself (no function on the server yet,
// no cloud client, offline) is spent once it leaves the device, even when the
// invoice's record is refused and so never reaches the list the next number
// is worked out from. Only the server's own ledger protected server numbers.
const missing = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.allocate_invoice_number' } });
const LIST = [{ number: 'INV-20260929-01' }, { number: 'INV-20260929-02' }];

test('function missing: a number that went out with its record refused is not issued again on this device', async () => {
  _resetHeldInvoiceNumbers();
  const first = await reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-a' }).done;
  assert.equal(first, 'INV-20260929-03');
  invoiceNumberUsed(first); // sent; addItem('invoices') refused, so LIST is unchanged
  const next = reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-a' });
  assert.equal(await next.done, 'INV-20260929-04');
  // Another account signed in on the device keeps its own numbering.
  assert.equal(await reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-b' }).done, 'INV-20260929-03');
});

test('no cloud client or offline: a number that went out is not issued again on this device', async () => {
  _resetHeldInvoiceNumbers();
  const local = reserveInvoiceNumber(LIST, 'INV', { rpc: () => null, account: 'profile-a' });
  assert.equal(local.number, 'INV-20260929-03');
  invoiceNumberUsed(local.number);
  assert.equal(reserveInvoiceNumber(LIST, 'INV', { rpc: () => null, account: 'profile-a' }).number, 'INV-20260929-04');
  // Offline, the device tag alone does not keep two invoices apart on one device.
  const random = () => 0;
  const off = reserveInvoiceNumber(LIST, 'EXP', { online: false, random, account: 'profile-a' });
  assert.equal(off.number, 'EXP-20260929-01-AAA');
  invoiceNumberUsed(off.number);
  assert.equal(reserveInvoiceNumber(LIST, 'EXP', { online: false, random, account: 'profile-a' }).number, 'EXP-20260929-02-AAA');
});

test('a spent number survives a reload of the page (the tab session keeps it)', async () => {
  _resetHeldInvoiceNumbers();
  const store = new Map();
  globalThis.sessionStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } };
  try {
    const first = await reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-a' }).done;
    invoiceNumberUsed(first);
    // A fresh copy of the module is the page after a reload: nothing in memory.
    const reloaded = await import(`../../src/utils/invoiceNumber.js?reload=${Date.now()}`);
    assert.equal(await reloaded.reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-a' }).done, 'INV-20260929-04');
    assert.equal(await reloaded.reserveInvoiceNumber(LIST, 'INV', { rpc: missing, account: 'profile-b' }).done, 'INV-20260929-03');
  } finally {
    _resetHeldInvoiceNumbers();
    delete globalThis.sessionStorage;
  }
});
