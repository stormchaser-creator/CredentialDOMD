import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as live from '../../src/utils/billing.js';
import * as legacy from './legacy-billing-a9ce80d7.mjs';

// Ticket 73202ae8: the call day on daylight-saving mornings. Synthetic entries only.
//
// TZ first, before any Date below is created: the call day is a wall-clock
// rule, so these cases only mean something in a zone that observes DST.
const originalTimezone = process.env.TZ;
process.env.TZ = 'America/Denver';
const RealDate = globalThis.Date;
const NOW = '2026-09-01T12:00:00-06:00';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return new RealDate(NOW).getTime(); }
};
test.after(() => {
  globalThis.Date = RealDate;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

const { deriveCallDay, callDayOf } = live;

// A local wall-clock instant: at('2026-11-01 06:30').
const at = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [hh, mi, ss = 0] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mi, ss).toISOString(); };

// ── Daylight saving ──────────────────────────────────────────────

test('call day on the fall-back morning (2026-11-01) uses the wall clock', () => {
  assert.equal(deriveCallDay(at('2026-11-01 05:59')), '2026-10-31');
  assert.equal(deriveCallDay(at('2026-11-01 06:30')), '2026-10-31');
  assert.equal(deriveCallDay(at('2026-11-01 07:00')), '2026-11-01');
  // The old elapsed-time rule filed 6:30 under Nov 1: the bug being fixed.
  assert.equal(legacy.deriveCallDay(at('2026-11-01 06:30')), '2026-11-01');
});

test('call day on the spring-forward morning (2026-03-08) uses the wall clock', () => {
  assert.equal(deriveCallDay(at('2026-03-08 06:59')), '2026-03-07');
  assert.equal(deriveCallDay(at('2026-03-08 07:00')), '2026-03-08');
  assert.equal(deriveCallDay(at('2026-03-08 07:30')), '2026-03-08');
  assert.equal(legacy.deriveCallDay(at('2026-03-08 07:30')), '2026-03-07');
});

test('call day on an ordinary morning is unchanged', () => {
  assert.equal(deriveCallDay(at('2026-08-05 06:59')), '2026-08-04');
  assert.equal(deriveCallDay(at('2026-08-05 07:00')), '2026-08-05');
  // Every minute of an ordinary week agrees with the old rule.
  for (let m = 0; m < 7 * 24 * 60; m += 1) {
    const iso = new RealDate(new RealDate(2026, 7, 3, 0, 0).getTime() + m * 60000).toISOString();
    assert.equal(deriveCallDay(iso), legacy.deriveCallDay(iso), iso);
  }
});

test('the same fix holds in America/Chicago', () => {
  process.env.TZ = 'America/Chicago';
  try {
    assert.equal(deriveCallDay(at('2026-11-01 06:30')), '2026-10-31');
    assert.equal(deriveCallDay(at('2026-03-08 07:30')), '2026-03-08');
  } finally { process.env.TZ = 'America/Denver'; }
});

test('the saved stamp still wins, and Invoices no longer keeps its own copy of the rule', () => {
  assert.equal(callDayOf({ callDay: '2026-08-04', startTime: at('2026-08-05 07:30') }), '2026-08-04');
  const invoices = readFileSync(new URL('../../src/components/features/locum/Invoices.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(invoices, /const callDayOf\s*=/);
  assert.doesNotMatch(invoices, /7 \* 3600/);
  assert.match(invoices, /import \{ callDayOf \} from "..\/..\/..\/utils\/billing"/);
});
