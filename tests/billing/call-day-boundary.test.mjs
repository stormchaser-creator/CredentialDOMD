import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as live from '../../src/utils/billing.js';
import * as legacy from './legacy-billing-a9ce80d7.mjs';

// Ticket 73202ae8: the call day on daylight-saving mornings, and splitting a
// call that crosses the start of the call day. Synthetic entries only.
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

const { deriveCallDay, callDayOf, callDayStartHour, splitAtCallDay, splitRows, computeBilling, findContainer, splitPieceNote } = live;

// A local wall-clock instant: at('2026-11-01 06:30').
const at = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [hh, mi, ss = 0] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mi, ss).toISOString(); };
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// WorkLog's roundUp, applied once to the whole entry (finalizeEntry).
const roundUp = (raw, inc, min) => Math.max(min || 0, Math.ceil(raw / inc) * inc || inc);

const STIPEND = { id: 'c-stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-07-28', end: '2026-08-09' }] };
const ON = { ...STIPEND, splitAtDayStart: true };

// Build an entry exactly the way the WorkLog save paths do.
let seq = 0;
function entry(type, from, to, contract = ON, extra = {}) {
  const s = at(from), e = at(to);
  const raw = Math.max(1, Math.round((new RealDate(e) - new RealDate(s)) / 60000));
  const inc = contract.incrementMinutes || 15;
  const billed = roundUp(raw, inc, type === 'Call' || type === 'Transfer call' ? (contract.minCallMinutes || 15) : 0);
  seq += 1;
  return { id: `e${String(seq).padStart(3, '0')}`, createdAt: `2026-09-01T00:00:${String(seq % 60).padStart(2, '0')}Z`, contractId: contract.id, type, date: live.localDate(s), callDay: deriveCallDay(s, callDayStartHour(contract)), startTime: s, endTime: e, durationMin: raw, billedMin: billed, description: '', privateNote: '', invoiceId: null, ...extra };
}
let idn = 0;
const makeId = () => `g${++idn}`;
const rowsFor = (e, contract = ON) => splitRows(e, contract, makeId);
const shape = (rows) => rows.map(r => `${hhmm(r.startTime)}-${hhmm(r.endTime)} ${r.callDay} ${r.billedMin}`);

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

test('contract start hour: blank or invalid means 7, a stamped row never moves when it changes', () => {
  for (const v of [undefined, null, '', 'x', 24, -1, 7.5]) assert.equal(callDayStartHour({ dayStartHour: v }), 7, String(v));
  assert.equal(callDayStartHour({ dayStartHour: 8 }), 8);
  assert.equal(callDayStartHour({ dayStartHour: 0 }), 0);
  assert.equal(deriveCallDay(at('2026-08-05 07:30'), 8), '2026-08-04');
  const stamped = entry('Call', '2026-08-05 07:30', '2026-08-05 07:45', STIPEND);
  assert.equal(stamped.callDay, '2026-08-05');
  const priced = computeBilling({ ...STIPEND, dayStartHour: 8 }, [stamped], true, [stamped], [], new Set(['2026-08-04', '2026-08-05']));
  assert.deepEqual(priced.lines.filter(l => l.date).map(l => l.date), ['2026-08-04', '2026-08-05']);
  const i = priced.lines.findIndex(l => l.label === '· Call');
  assert.match(priced.lines[i].detail, /15 min/);
  assert.equal(priced.lines[i - 1].date, '2026-08-05', 'still listed under its stamped Aug 5, not moved to Aug 4');
});

// ── splitAtCallDay, rule R2 ──────────────────────────────────────

test('R2 examples from the audit (15-min increment, 15-min minimum)', () => {
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-05 06:45', '2026-08-05 07:15'), ON)),
    ['06:45-07:00 2026-08-04 15', '07:00-07:15 2026-08-05 15']);
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-05 06:50', '2026-08-05 07:05'), ON)),
    ['06:50-07:05 2026-08-04 15'], '15 on the earlier day, not split');
  // The production row 06463648 was 16 raw minutes (seconds on the clock).
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-06 06:47', '2026-08-06 07:02:40'), ON)),
    ['06:47-07:02 2026-08-05 30'], '30 on the earlier day, not split');
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-06 06:47', '2026-08-06 07:02'), ON)),
    ['06:47-07:02 2026-08-05 15']);
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-05 06:55', '2026-08-05 07:20'), ON)),
    ['06:55-07:20 2026-08-05 30'], '30 on the new day, not split');
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-05 06:52', '2026-08-05 07:09'), ON)),
    ['06:52-07:00 2026-08-04 15', '07:00-07:09 2026-08-05 15']);
  assert.deepEqual(shape(splitAtCallDay(entry('Procedure', '2026-08-08 06:00', '2026-08-09 08:00'), ON)),
    ['06:00-07:00 2026-08-07 60', '07:00-07:00 2026-08-08 1440', '07:00-08:00 2026-08-09 60']);
});

test('R2 boundaries: touching 7:00 is not crossing it', () => {
  const ends = entry('Call', '2026-08-05 06:30', '2026-08-05 07:00');
  const starts = entry('Call', '2026-08-05 07:00', '2026-08-05 07:30');
  assert.equal(splitAtCallDay(ends, ON)[0], ends, 'not split, same row');
  assert.equal(splitAtCallDay(starts, ON)[0], starts);
  assert.equal(splitAtCallDay(ends, ON).length, 1);
  assert.equal(ends.callDay, '2026-08-04');
  assert.equal(starts.callDay, '2026-08-05');
});

test('R2 on daylight-saving mornings cuts at 7:00 on the clock', () => {
  const fall = splitAtCallDay(entry('Call', '2026-11-01 06:30', '2026-11-01 07:30'), ON);
  assert.deepEqual(shape(fall), ['06:30-07:00 2026-10-31 30', '07:00-07:30 2026-11-01 30']);
  assert.equal(fall[1].startTime, '2026-11-01T14:00:00.000Z', '7:00 MST');
  const spring = splitAtCallDay(entry('Call', '2026-03-08 06:30', '2026-03-08 07:30'), ON);
  assert.deepEqual(shape(spring), ['06:30-07:00 2026-03-07 30', '07:00-07:30 2026-03-08 30']);
  assert.equal(spring[1].startTime, '2026-03-08T13:00:00.000Z', '7:00 MDT');
});

test('never split: off, no stipend, markers, orientation, zero-length, missing times', () => {
  const crossing = entry('Call', '2026-08-05 06:45', '2026-08-05 07:15');
  for (const c of [STIPEND, { ...ON, splitAtDayStart: false }, { ...ON, splitAtDayStart: 'true' }, { ...ON, callStipend: 0 }, null]) {
    const out = splitAtCallDay(crossing, c);
    assert.equal(out.length, 1); assert.equal(out[0], crossing, 'the very same row');
  }
  for (const e of [
    { ...crossing, type: 'CallDay' },
    { ...crossing, type: 'Orientation' },
    { ...crossing, endTime: crossing.startTime },
    { ...crossing, endTime: null },
    { ...crossing, startTime: null },
  ]) assert.equal(splitAtCallDay(e, ON)[0], e);
});

test('R2 with a minimum that is not a whole increment: the remainder rides on the first piece', () => {
  const min20 = { ...ON, minCallMinutes: 20 };
  const short = entry('Call', '2026-08-05 06:55', '2026-08-05 07:05', min20);
  assert.equal(short.billedMin, 20);
  assert.deepEqual(shape(splitAtCallDay(short, min20)), ['06:55-07:05 2026-08-04 20'], 'tie goes to the earlier piece');
  const min40 = { ...ON, minCallMinutes: 40 };
  const e = entry('Call', '2026-08-05 06:50', '2026-08-05 07:10', min40);
  assert.equal(e.billedMin, 40);
  assert.deepEqual(shape(splitAtCallDay(e, min40)), ['06:50-07:00 2026-08-04 25', '07:00-07:10 2026-08-05 15']);
});

test('a contract whose call day starts at 8:00 cuts at 8:00, not 7:00', () => {
  const eight = { ...ON, dayStartHour: 8 };
  assert.deepEqual(shape(splitAtCallDay(entry('Call', '2026-08-05 07:45', '2026-08-05 08:15', eight), eight)),
    ['07:45-08:00 2026-08-04 15', '08:00-08:15 2026-08-05 15']);
  const noCut = entry('Call', '2026-08-05 06:45', '2026-08-05 07:15', eight);
  assert.equal(splitAtCallDay(noCut, eight)[0], noCut);
  assert.equal(noCut.callDay, '2026-08-04');
});

test('R2 invariants over every start minute from 5:30 to 7:30 and every length to 3 hours', () => {
  const contracts = [
    ON,
    { ...ON, incrementMinutes: 30, minCallMinutes: 30 },
    { ...ON, incrementMinutes: 60, minCallMinutes: 0 },
    { ...ON, incrementMinutes: 15, minCallMinutes: 20 },
  ];
  let checked = 0;
  for (const c of contracts) {
    const inc = c.incrementMinutes;
    for (let startMin = 5 * 60 + 30; startMin <= 7 * 60 + 30; startMin += 1) {
      for (let len = 1; len <= 180; len += 1) {
        const s = new RealDate(2026, 7, 5, 0, startMin).toISOString();
        const eIso = new RealDate(new RealDate(s).getTime() + len * 60000).toISOString();
        const whole = { id: 'x', contractId: c.id, type: 'Call', date: '2026-08-05', callDay: deriveCallDay(s), startTime: s, endTime: eIso, durationMin: len, billedMin: roundUp(len, inc, c.minCallMinutes) };
        const pieces = splitAtCallDay(whole, c);
        const crosses = new RealDate(s).getHours() < 7 && new RealDate(eIso) > new RealDate(2026, 7, 5, 7, 0);
        if (!crosses) { assert.equal(pieces.length, 1); assert.equal(pieces[0], whole); continue; }
        // The call bills exactly what it billed whole, and logs the same time.
        assert.equal(pieces.reduce((t, p) => t + p.billedMin, 0), whole.billedMin);
        assert.equal(pieces.reduce((t, p) => t + p.durationMin, 0), whole.durationMin);
        // Contiguous, covering the whole span, cut only at 7:00.
        assert.equal(pieces[0].startTime, whole.startTime);
        assert.equal(pieces.at(-1).endTime, whole.endTime);
        for (let i = 1; i < pieces.length; i++) {
          assert.equal(pieces[i].startTime, pieces[i - 1].endTime);
          assert.equal(hhmm(pieces[i].startTime), '07:00');
          assert.ok(pieces[i].callDay > pieces[i - 1].callDay);
          assert.equal(pieces[i].billedMin % inc, 0);
          assert.ok(pieces[i].billedMin >= inc);
        }
        if (pieces.length > 1) assert.ok(pieces[0].billedMin >= inc, 'no piece is split off without a whole increment');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 20000, `checked ${checked}`);
});

test('splitRows: pieces share a group id, the first keeps the entry id; off returns the row untouched', () => {
  const e = entry('Call', '2026-08-10 06:45', '2026-08-10 07:15');
  const rows = rowsFor(e);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, e.id);
  assert.notEqual(rows[1].id, e.id);
  assert.ok(rows[0].splitGroupId && rows[0].splitGroupId === rows[1].splitGroupId);
  const off = entry('Call', '2026-08-10 06:45', '2026-08-10 07:15', STIPEND);
  const offRows = splitRows(off, STIPEND, () => assert.fail('no id is minted when nothing splits'));
  assert.equal(offRows.length, 1); assert.equal(offRows[0], off);
  assert.equal('splitGroupId' in offRows[0], false, 'no new key reaches the row');
});

// ── Billing with the setting on ──────────────────────────────────

const days = (...d) => new Set(d);
const bill = (contract, rows, filter, all = rows, invoices = []) => computeBilling(contract, rows, true, all, invoices, filter);

test('last morning: a 6:45 to 7:15 call on Aug 10 bills $3,075 split, $3,000 whole', () => {
  const call = () => entry('Call', '2026-08-10 06:45', '2026-08-10 07:15');
  assert.equal(bill(ON, rowsFor(call()), days('2026-08-09', '2026-08-10')).total, 3075);
  assert.equal(bill(STIPEND, [call()], days('2026-08-09', '2026-08-10')).total, 3000);
});

test('first morning: a 6:45 to 7:15 call on Jul 28 bills $3,075 split, $3,150 whole', () => {
  const call = () => entry('Call', '2026-07-28 06:45', '2026-07-28 07:15');
  assert.equal(bill(ON, rowsFor(call()), days('2026-07-27', '2026-07-28')).total, 3075);
  assert.equal(bill(STIPEND, [call()], days('2026-07-27', '2026-07-28')).total, 3150);
});

test('mid-contract with Aug 4 allowance used: $6,075 split, $6,150 whole', () => {
  const build = (c) => [...rowsFor(entry('Procedure', '2026-08-04 08:00', '2026-08-04 12:00', c), c), ...rowsFor(entry('Call', '2026-08-05 06:45', '2026-08-05 07:15', c), c)];
  assert.equal(bill(ON, build(ON), days('2026-08-04', '2026-08-05')).total, 6075);
  assert.equal(bill(STIPEND, build(STIPEND), days('2026-08-04', '2026-08-05')).total, 6150);
});

test('a crossing call with allowance to spare stays at $6,000 either way', () => {
  for (const c of [ON, STIPEND]) {
    assert.equal(bill(c, rowsFor(entry('Call', '2026-08-05 06:45', '2026-08-05 07:15', c), c), days('2026-08-04', '2026-08-05')).total, 6000);
  }
});

test('calls inside a split procedure are still no charge, split or not', () => {
  const rows = [
    ...rowsFor(entry('Procedure', '2026-08-05 05:00', '2026-08-05 09:00')),
    ...rowsFor(entry('Call', '2026-08-05 07:15', '2026-08-05 07:30')),
    ...rowsFor(entry('Call', '2026-08-05 06:50', '2026-08-05 07:10')),
    // Stays whole across 7:00 (R2), so only the procedure's WHOLE span contains it.
    ...rowsFor(entry('Call', '2026-08-05 06:50', '2026-08-05 07:05')),
  ];
  assert.deepEqual(rows.filter(r => r.type === 'Procedure').map(r => r.billedMin), [120, 120]);
  assert.equal(rows.filter(r => r.type === 'Call').length, 4);
  const priced = bill(ON, rows, days('2026-08-04', '2026-08-05'));
  assert.equal(priced.total, 6000);
  const callLines = priced.lines.filter(l => l.label === '· Call');
  assert.equal(callLines.length, 4);
  for (const l of callLines) {
    assert.equal(l.flag, 'no charge', l.detail);
    assert.match(l.detail, /during Procedure 5:00\sAM–9:00\sAM/, 'the whole logged span, not the piece');
  }
  // Pieces of one entry never contain each other.
  const call = rows.filter(r => r.type === 'Call' && r.splitGroupId);
  assert.equal(findContainer(call[0], [call[1]]), null);
});

test('invoicing only Aug 9 leaves the 7:00 piece for Aug 10 unbilled', () => {
  const rows = rowsFor(entry('Call', '2026-08-10 06:45', '2026-08-10 07:15'));
  const pick = days('2026-08-09');
  const picked = rows.filter(r => pick.has(callDayOf(r)));
  assert.equal(picked.length, 1);
  assert.equal(bill(ON, picked, pick, rows).total, 3000);
  const invoiced = rows.map(r => (pick.has(callDayOf(r)) ? { ...r, invoiceId: 'inv-1' } : r));
  const left = invoiced.filter(r => !r.invoiceId);
  assert.deepEqual(left.map(r => r.callDay), ['2026-08-10']);
  assert.equal(bill(ON, left, days('2026-08-10'), invoiced).total, 75);
});

test('each piece says where the rest of the call is billed', () => {
  const rows = rowsFor(entry('Call', '2026-08-10 06:45', '2026-08-10 07:15'));
  assert.equal(splitPieceNote(rows[0], rows), 'continues on the Aug 10, 2026 call day');
  assert.equal(splitPieceNote(rows[1], rows), 'continued from the Aug 9, 2026 call day');
  const priced = bill(ON, rows, days('2026-08-09', '2026-08-10'));
  const details = priced.lines.filter(l => l.date === null || l.label.startsWith('Call')).map(l => l.detail).join('\n');
  assert.match(details, /\(continues on the Aug 10, 2026 call day\)/);
  assert.match(details, /\(continued from the Aug 9, 2026 call day\)/);
  assert.equal(splitPieceNote(entry('Call', '2026-08-10 08:00', '2026-08-10 08:15'), rows), '');
});

// ── With the setting off, billing is byte-identical to before ────

test('setting off: every representative entry saves the same row and prices exactly as the frozen engine', () => {
  const FLAT = { id: 'c-flat', callStipend: 0, hourlyRate: 250, callHourlyRate: 150, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] };
  const ORIENT = { ...STIPEND, id: 'c-orient', orientationFee: 500, orientationHourlyRate: 0 };
  for (const c of [STIPEND, { ...STIPEND, splitAtDayStart: false, dayStartHour: 7 }, { ...STIPEND, splitAtDayStart: null, dayStartHour: null }, FLAT, ORIENT]) {
    const mk = (type, a, b, extra) => entry(type, a, b, c, extra);
    const list = [
      mk('Call', '2026-08-05 06:45', '2026-08-05 07:15'),
      mk('Call', '2026-08-05 06:50', '2026-08-05 07:05'),
      mk('Call', '2026-08-05 02:10', '2026-08-05 02:40'),
      mk('Transfer call', '2026-08-05 23:50', '2026-08-06 00:20'),
      mk('Procedure', '2026-08-04 08:00', '2026-08-04 12:00'),
      mk('Procedure', '2026-08-06 05:00', '2026-08-06 09:00'),
      mk('Call', '2026-08-06 07:15', '2026-08-06 07:30'),
      mk('Call', '2026-08-06 06:50', '2026-08-06 07:10'),
      mk('Rounding', '2026-08-08 07:00', '2026-08-08 11:00'),
      mk('Call', '2026-08-09 06:40', '2026-08-09 06:41'),
      mk('Call', '2026-08-10 06:45', '2026-08-10 07:15'),
      mk('Call', '2026-07-28 06:45', '2026-07-28 07:15'),
      mk('Consult', '2026-08-07 13:00', '2026-08-07 14:00'),
      mk('Orientation', '2026-07-28 06:10', '2026-07-28 09:50'),
      { ...mk('Call', '2026-08-03 20:00', '2026-08-03 20:30'), callDay: undefined },
      { ...mk('Call', '2026-08-03 06:20', '2026-08-03 06:35'), callDay: undefined },
      { ...mk('Call', '2026-08-02 10:00', '2026-08-02 10:00'), endTime: at('2026-08-02 10:00') },
      { id: 'dur-only', contractId: c.id, type: 'Consult', date: '2026-08-01', durationMin: 60, billedMin: 60, invoiceId: null },
      { id: 'marker', contractId: c.id, type: 'CallDay', date: '2026-08-11', callDay: '2026-08-11', durationMin: 0, billedMin: 0, invoiceId: null },
    ];
    for (const e of list) {
      assert.equal(splitRows(e, c, () => assert.fail('nothing splits with the setting off'))[0], e, `${e.id} saves unchanged`);
      if (e.startTime) assert.equal(deriveCallDay(e.startTime, callDayStartHour(c)), legacy.deriveCallDay(e.startTime), `${e.id} stamp`);
    }
    // Half of it already invoiced, with a stamped invoice, to exercise the prior-billing paths.
    const invoiced = list.map((e, i) => (i % 3 === 0 ? { ...e, invoiceId: 'inv-old' } : e));
    const invoices = [{ id: 'inv-old', contractId: c.id, entryIds: invoiced.filter(e => e.invoiceId).map(e => e.id), dayOverMin: { '2026-08-05': 0, '2026-08-06': 15 }, lines: [{ date: '2026-08-05', label: 'On-call coverage (daily total)', amount: 3000 }] }];
    const unbilled = invoiced.filter(e => !e.invoiceId);
    for (const filter of [null, days('2026-08-04', '2026-08-05', '2026-08-06'), days('2026-07-27', '2026-07-28', '2026-08-10', '2026-08-11')]) {
      for (const [l, all, inv] of [[list, list, []], [unbilled, invoiced, invoices]]) {
        const a = computeBilling(c, l, true, all, inv, filter);
        const b = legacy.computeBilling(c, l, true, all, inv, filter);
        assert.deepEqual(a, b, `${c.id} ${filter ? [...filter].join(',') : 'all days'}`);
        assert.equal(JSON.stringify(a), JSON.stringify(b), 'byte-identical, key order included');
      }
    }
    for (const e of list) {
      const sibs = live.overlapSiblings(list, c.id, callDayOf(e));
      assert.equal(findContainer(e, sibs), legacy.findContainer(e, legacy.overlapSiblings(list, c.id, legacy.callDayOf(e))));
    }
  }
});
