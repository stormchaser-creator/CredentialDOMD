import test from 'node:test';
import assert from 'node:assert/strict';
import { invoicesBilledTwice, billedTwiceTitle, billedTwiceLine, deleteSharesCallDay } from '../../src/utils/invoiceRecord.js';
import {
  stipendDayKey, parseStipendDayKey, coverageDaysOf, provesStipendDay, stipendDayItems, previewCheckIds,
  splitStipendDayKeys, withStipendDays, billedWhat, COVERAGE_LINE_LABEL,
} from '../../src/utils/stipendDays.js';
import { checkBeforeRecord } from '../../src/utils/invoiceRecordCheck.js';
import { computeBilling, callDayOf } from '../../src/utils/billing.js';

// Review of release/goal2 (2026-10-02): a stipend contract's coverage days
// with nothing logged bill their stipend with no entry (computeBilling's
// emptyStipendDays). INV-A billed them on the Mac (new zero-minute CallDay
// markers stamped with INV-A's id; INV-A.entryIds empty). A stale Work log
// preview on the iPhone sent INV-C for the same days: every check asked about
// entryIds only (none), the new markers never touched the server's move
// guard, and the billed twice card walked entryIds only, so nothing said the
// agency had two bills for the same stipends.
// Synthetic contracts, numbers and amounts only.

const C = { id: 'c-s', facility: 'Synthetic Hospital', agency: 'Synthetic Staffing', payModel: 'stipend', callStipend: 1000,
  stipendHours: 24, overageHourlyRate: 200, incrementMinutes: 15, startDate: '2026-09-01', endDate: '2026-12-31',
  coveragePeriods: [{ start: '2026-09-01', end: '2026-09-03' }] };
const DAYS = ['2026-09-01', '2026-09-02', '2026-09-03'];
const coverage = (date) => ({ date, label: COVERAGE_LINE_LABEL, detail: 'on-call coverage · no calls required', amount: 1000 });
const marker = (id, date, invoiceId) => ({ id, contractId: 'c-s', type: 'CallDay', date, callDay: date, startTime: null, endTime: null,
  durationMin: 0, billedMin: 0, description: 'Stipend billed, no calls required', invoiceId });
const inv = (id, number, sentAt, days, extra = {}) => ({ id, number, contractId: 'c-s', entryIds: [], totalAmount: 1000 * days.length,
  sentAt, lines: days.map(coverage), dayOverMin: Object.fromEntries(days.map(d => [d, 0])), ...extra });
const A = inv('inv-a', 'INV-20260904-01', '2026-09-04T15:00:00Z', DAYS);
const Cdup = inv('inv-c', 'INV-20260904-02', '2026-09-04T18:00:00Z', DAYS);
const seed = (extra = {}) => ({
  locumContracts: [C],
  workLog: [...DAYS.map((d, i) => marker(`ma${i}`, d, 'inv-a')), ...DAYS.map((d, i) => marker(`mc${i}`, d, 'inv-c'))],
  invoices: [A, Cdup],
  ...extra,
});

test('the reproduction: the stale copy bills the empty coverage days again, with no entry to list', () => {
  const stale = computeBilling(C, [], true, [], [], null);
  assert.deepEqual(stale.emptyStipendDays, DAYS);
  assert.equal(stale.total, 3000);
  // With INV-A and its markers in the copy, nothing is left to bill.
  const fresh = computeBilling(C, [], true, DAYS.map((d, i) => marker(`ma${i}`, d, 'inv-a')), [A], null);
  assert.equal(fresh.total, 0);
});

test('two invoices charging the same stipend days are found: the later one, by both numbers, counted in days', () => {
  const twice = invoicesBilledTwice(seed());
  assert.equal(twice.length, 1, 'one card, for INV-C');
  const [b] = twice;
  assert.equal(b.invoice.id, 'inv-c');
  assert.deepEqual(b.on, ['INV-20260904-01']);
  assert.deepEqual([b.count, b.listed, b.full, b.items], [3, 3, true, 'days']);
  assert.equal(billedTwiceTitle(b), 'INV-20260904-02 bills days already on INV-20260904-01');
  assert.match(billedTwiceLine(b), /^All 3 of its days are on INV-20260904-01, which was recorded first, so INV-20260904-02 asks for them a second time/);
  assert.match(billedTwiceLine(b), /delete INV-20260904-02 here\.$/);
  // Order in the account does not decide which is first: sentAt does.
  assert.deepEqual(invoicesBilledTwice(seed({ invoices: [Cdup, A] })).map(x => x.invoice.id), ['inv-c']);
  // Without the markers (a deleted marker, or one that never synced) the lines still say it.
  assert.deepEqual(invoicesBilledTwice(seed({ workLog: [] })).map(x => x.invoice.id), ['inv-c']);
});

test('partly: INV-C also charged a day of its own', () => {
  const C4 = inv('inv-c', 'INV-20260904-02', '2026-09-04T18:00:00Z', ['2026-09-02', '2026-09-03', '2026-09-04']);
  const [b] = invoicesBilledTwice(seed({ invoices: [A, C4] }));
  assert.deepEqual([b.invoice.id, b.count, b.listed, b.full, b.items], ['inv-c', 2, 3, false, 'days']);
  assert.match(billedTwiceLine(b), /^2 of its 3 days are on INV-20260904-01/);
  assert.match(billedTwiceLine(b), /bill the days that are not on INV-20260904-01 again\.$/);
});

test('must pass: nothing is flagged for invoices on their own days, other contracts, overage only lines, or a written off duplicate', () => {
  // Week by week: INV-A 09-01 to 09-02, INV-B 09-03.
  const A2 = inv('inv-a', 'INV-20260904-01', '2026-09-04T15:00:00Z', ['2026-09-01', '2026-09-02']);
  const B = inv('inv-b', 'INV-20260904-02', '2026-09-04T18:00:00Z', ['2026-09-03']);
  assert.deepEqual(invoicesBilledTwice({ invoices: [A2, B], workLog: [] }), []);
  // The same dates on another contract.
  assert.deepEqual(invoicesBilledTwice({ invoices: [A, { ...Cdup, contractId: 'c-other' }], workLog: [] }), []);
  // Late logged work on a billed day: the second invoice bills only the time
  // beyond the stipend (a line of another label), never the stipend again.
  const late = { ...Cdup, lines: [{ date: '2026-09-02', label: 'Call: Consult', detail: '30 min beyond', amount: 100 }] };
  assert.deepEqual(invoicesBilledTwice({ invoices: [A, late], workLog: [] }), []);
  // A coverage line with nothing charged.
  assert.deepEqual(invoicesBilledTwice({ invoices: [A, { ...Cdup, lines: DAYS.map(d => ({ ...coverage(d), amount: 0 })) }], workLog: [] }), []);
  // The duplicate written off: settled.
  assert.deepEqual(invoicesBilledTwice(seed({ invoices: [A, { ...Cdup, writeOffAt: '2026-09-20T00:00:00Z' }] })), []);
  // The duplicate deleted.
  assert.deepEqual(invoicesBilledTwice(seed({ invoices: [A] })), []);
  // Expense invoices never take part.
  assert.deepEqual(invoicesBilledTwice({ invoices: [A, { ...Cdup, kind: 'expenses' }], workLog: [] }), []);
});

test('stipend day keys: made, read back, kept apart from row ids', () => {
  const k = stipendDayKey('c-s', '2026-09-01');
  assert.deepEqual(parseStipendDayKey(k), { contractId: 'c-s', date: '2026-09-01' });
  assert.equal(parseStipendDayKey('e1'), null);
  assert.equal(parseStipendDayKey('stipend-day:c-s:not-a-day'), null);
  assert.deepEqual(splitStipendDayKeys(['e1', k, stipendDayKey('c-x', '2026-09-02')], 'c-s'), { rows: ['e1'], days: ['2026-09-01'] });
  assert.deepEqual([...coverageDaysOf(A)], DAYS);
  const preview = { entryIds: ['e9'], lines: [coverage('2026-09-02'), { date: '2026-09-02', label: 'Call: Consult', amount: 50 }] };
  assert.deepEqual(previewCheckIds(preview, 'c-s'), ['e9', stipendDayKey('c-s', '2026-09-02')]);
  assert.equal(billedWhat([k]), 'days');
  assert.equal(billedWhat({ e1: 'INV-1', [k]: 'INV-1' }), 'entries');
  assert.equal(billedWhat([]), 'entries');
});

test('this copy answers for a stipend day the way billing.js does', () => {
  // A billed marker, and a billed entry on its call day, prove the stipend; orientation does not.
  assert.equal(provesStipendDay(C, marker('m', '2026-09-01', 'inv-a')), '2026-09-01');
  assert.equal(provesStipendDay(C, { id: 'e', contractId: 'c-s', type: 'Call', callDay: '2026-09-02', invoiceId: 'inv-a' }), '2026-09-02');
  assert.equal(provesStipendDay(C, { id: 'o', contractId: 'c-s', type: 'Orientation', callDay: '2026-09-02', invoiceId: 'inv-a' }), null);
  assert.equal(provesStipendDay(C, marker('m', '2026-09-01', null)), null, 'unbilled');
  assert.equal(provesStipendDay(C, { ...marker('m', '2026-09-01', 'inv-a'), contractId: 'c-x' }), null, 'another contract');
  const items = stipendDayItems(C, [marker('ma0', '2026-09-01', 'inv-a')], [A]);
  assert.deepEqual(items.map(i => [i.id, i.invoiceId]), DAYS.map(d => [stipendDayKey('c-s', d), 'inv-a']));
  // An invoice's coverage line counts only where computeBilling reads it
  // (stamped dayOverMin), so a day this copy would bill is never called billed.
  assert.deepEqual(stipendDayItems(C, [], [{ ...A, dayOverMin: undefined }]), []);
  assert.deepEqual(stipendDayItems({ ...C, callStipend: 0 }, [marker('ma0', '2026-09-01', 'inv-a')], [A]), []);
});

test('the check before Send and Copy finds the stipend days billed, here or on the server', async () => {
  const ids = previewCheckIds({ entryIds: [], lines: DAYS.map(coverage) }, 'c-s');
  // This device's copy has INV-A now (the account read again on return).
  const here = await checkBeforeRecord({ number: '', invoices: [A], items: stipendDayItems(C, DAYS.map((d, i) => marker(`ma${i}`, d, 'inv-a')), [A]), ids });
  assert.equal(here.state, 'billed');
  assert.deepEqual(Object.values(here.billedOn), ['INV-20260904-01', 'INV-20260904-01', 'INV-20260904-01']);
  // Its copy is old; the server has INV-A's markers.
  const server = { data: { numberTaken: false, billedIds: [], billedOn: {}, stipendRows: [
    { id: 'ma0', invoiceId: 'inv-a', number: 'INV-20260904-01', contractId: 'c-s', type: 'CallDay', callDay: '2026-09-01', date: '2026-09-01' },
    { id: 'ma1', invoiceId: 'inv-a', number: 'INV-20260904-01', contractId: 'c-s', type: 'CallDay', callDay: '2026-09-02', date: '2026-09-02' },
  ] }, error: null };
  const read = (n, list) => {
    const { rows, days } = splitStipendDayKeys(list, 'c-s');
    assert.deepEqual(rows, []);
    assert.deepEqual(days, DAYS);
    return Promise.resolve(withStipendDays(server, C, days));
  };
  const there = await checkBeforeRecord({ number: '', invoices: [], items: [], ids, read });
  assert.equal(there.state, 'billed');
  assert.deepEqual(there.billedOn, { [stipendDayKey('c-s', '2026-09-01')]: 'INV-20260904-01', [stipendDayKey('c-s', '2026-09-02')]: 'INV-20260904-01' });
  // Must pass: nothing billed on those days, the server says free.
  const none = await checkBeforeRecord({ number: '', invoices: [], items: [], ids,
    read: (n, list) => Promise.resolve(withStipendDays({ data: { numberTaken: false, billedIds: [], billedOn: {}, stipendRows: [] }, error: null }, C, splitStipendDayKeys(list, 'c-s').days)) });
  assert.equal(none.state, 'free');
  // An error stays an error ("unknown", asked first).
  assert.deepEqual(withStipendDays({ data: null, error: { message: 'x' } }, C, DAYS), { data: null, error: { message: 'x' } });
});

// Review of release/goal2 (2026-10-02, round 4): the entry path and the
// stipend path chose the holder differently. INV-C recorded offline on the
// phone at 10:00 synced after the Mac's INV-A of 11:00: the server kept the
// entry on INV-A, but INV-C came first by sentAt for the days. Both were
// listed, each told to delete itself, and deleting INV-A freed the entry
// INV-C billed (a third bill) while INV-C's card went away.
const both = () => {
  const covEntry = { id: 'e1', contractId: 'c-s', type: 'Call', date: '2026-09-01', callDay: '2026-09-01', billedMin: 60, invoiceId: 'inv-a' };
  const Coff = inv('inv-c', 'INV-20260904-02', '2026-09-04T10:00:00Z', ['2026-09-01', '2026-09-02'], { entryIds: ['e1'] });
  const Amac = inv('inv-a', 'INV-20260904-01', '2026-09-04T11:00:00Z', ['2026-09-01', '2026-09-02'], { entryIds: ['e1'] });
  return { locumContracts: [C], invoices: [Coff, Amac],
    workLog: [covEntry, marker('ma1', '2026-09-02', 'inv-a'), marker('mc1', '2026-09-02', 'inv-c')] };
};

test('the invoice holding the other\'s entry holds its stipend days too: one card, never both', () => {
  const data = both();
  const twice = invoicesBilledTwice(data);
  assert.deepEqual(twice.map(b => b.invoice.id), ['inv-c'], 'INV-A, which kept e1, is never told to delete itself');
  const [b] = twice;
  assert.deepEqual(b.on, ['INV-20260904-01']);
  assert.deepEqual([b.count, b.listed, b.full, b.items], [2, 2, true, 'days']);
  assert.deepEqual([...b.days].sort(), ['2026-09-01', '2026-09-02']);
  // Deleting INV-C, as its card says, is the plain question and leaves e1 on INV-A.
  assert.equal(deleteSharesCallDay(data, data.invoices[0], callDayOf), false);
  // INV-A, if deleted instead, still warns (INV-C's marker shares 09-02).
  assert.equal(deleteSharesCallDay(data, data.invoices[1], callDayOf), true);
  // Must pass: with no entry held either way, the one recorded first holds the days.
  const plain = { ...data, invoices: data.invoices.map(i => ({ ...i, entryIds: [] })), workLog: data.workLog.filter(r => r.id !== 'e1') };
  assert.deepEqual(invoicesBilledTwice(plain).map(x => x.invoice.id), ['inv-a']);
});

test('deleting a stipend duplicate still warns for a day it alone charged that another invoice shares', () => {
  const Aone = inv('inv-a', 'INV-20260904-01', '2026-09-05T00:00:00Z', ['2026-09-01']);
  const Ctwo = inv('inv-c', 'INV-20260904-02', '2026-09-14T00:00:00Z', ['2026-09-01', '2026-09-03']);
  const Blate = { id: 'inv-b', number: 'INV-20260904-03', contractId: 'c-s', sentAt: '2026-09-20T00:00:00Z', entryIds: ['w1'], totalAmount: 0,
    lines: [{ date: '2026-09-03', label: 'Additional work (daily total)', amount: 0 }], dayOverMin: { '2026-09-03': 0 } };
  const w1 = { id: 'w1', contractId: 'c-s', type: 'Consult', callDay: '2026-09-03', date: '2026-09-03', billedMin: 60, invoiceId: 'inv-b' };
  const data = { locumContracts: [C], invoices: [Aone, Ctwo, Blate],
    workLog: [marker('ma0', '2026-09-01', 'inv-a'), marker('mc2', '2026-09-03', 'inv-c'), w1] };
  const [b] = invoicesBilledTwice(data);
  assert.deepEqual([b.invoice.id, b.count, b.listed, b.full], ['inv-c', 1, 2, false]);
  assert.equal(deleteSharesCallDay(data, Ctwo, callDayOf), true, '09-03 is shared with INV-B, not duplicated: the Delete BOTH warning stays');
  // Must pass: without INV-B's late work, deleting the duplicate is the plain question.
  const alone = { ...data, invoices: [Aone, Ctwo], workLog: data.workLog.filter(r => r.id !== 'w1') };
  assert.equal(deleteSharesCallDay(alone, Ctwo, callDayOf), false);
  // A duplicate whose only shared day is the one it duplicates: plain question.
  const dupOnly = { ...data, workLog: [marker('ma0', '2026-09-01', 'inv-a'), marker('mc0', '2026-09-01', 'inv-c')], invoices: [Aone, Ctwo] };
  assert.equal(deleteSharesCallDay(dupOnly, Ctwo, callDayOf), false);
  // An invoice that is not a duplicate warns as before.
  const B2 = inv('inv-b2', 'INV-20260904-04', '2026-09-06T00:00:00Z', ['2026-09-02']);
  const plain = { invoices: [Aone, B2], workLog: [marker('ma0', '2026-09-01', 'inv-a'),
    { id: 'w2', contractId: 'c-s', type: 'Consult', callDay: '2026-09-02', billedMin: 30, invoiceId: 'inv-a' }, marker('mb', '2026-09-02', 'inv-b2')] };
  assert.equal(deleteSharesCallDay(plain, B2, callDayOf), true);
});

// Review of release/goal2 (2026-10-02): the phone, offline, sent INV-C at
// 10:00 with 09-01's stipend plus e1 and e2; e1's stamp was still queued when
// the Mac billed e1 on INV-A at 11:00, and INV-A charged no stipend because
// INV-C's coverage line already did. The server keeps e1 on INV-A, so INV-C is
// the duplicate on the entries path, yet it alone charges 09-01's stipend.
// `days` named 09-01 anyway, so its delete skipped the Delete BOTH warning and
// the stipend was lost (e1 on INV-A proves it billed; rebilling e2 gave $0).
test('a duplicate that alone charges a shared call day stipend keeps the Delete BOTH warning and the card says delete both', () => {
  const D = '2026-09-01';
  const C1 = { ...C, coveragePeriods: [{ start: D, end: D }] };
  const entry = (id, invoiceId, h) => ({ id, contractId: 'c-s', type: 'Consult', date: D, callDay: D,
    startTime: `${D}T${h}:00:00`, endTime: `${D}T${h}:30:00`, durationMin: 30, billedMin: 30, invoiceId });
  const e1 = entry('e1', 'inv-a', '20');
  const e2 = entry('e2', 'inv-c', '21');
  const Cinv = { id: 'inv-c', number: 'INV-20260904-02', contractId: 'c-s', sentAt: '2026-09-04T10:00:00Z', entryIds: ['e1', 'e2'],
    totalAmount: 1000, lines: [coverage(D)], dayOverMin: { [D]: 0 } };
  const mac = computeBilling(C1, [{ ...e1, invoiceId: null }], true, [{ ...e1, invoiceId: null }], [Cinv], null);
  assert.equal(mac.lines.filter(l => l.label === COVERAGE_LINE_LABEL).length, 0, 'the Mac sees the coverage line and charges no stipend');
  const Ainv = { id: 'inv-a', number: 'INV-20260904-01', contractId: 'c-s', sentAt: '2026-09-04T11:00:00Z', entryIds: ['e1'],
    totalAmount: mac.total, lines: mac.lines, dayOverMin: mac.dayOverMin || { [D]: 0 } };
  const data = { locumContracts: [C1], invoices: [Cinv, Ainv], workLog: [e1, e2] };
  const twice = invoicesBilledTwice(data);
  assert.deepEqual(twice.map(b => [b.invoice.id, b.items, b.count, b.listed]), [['inv-c', 'entries', 1, 2]]);
  assert.deepEqual([...twice[0].days], [], '09-01 is not a day INV-A keeps the stipend for');
  assert.deepEqual([...twice[0].keeps], [D]);
  assert.equal(deleteSharesCallDay(data, Cinv, callDayOf), true, 'deleting INV-C alone still warns');
  const line = billedTwiceLine(twice[0]);
  assert.match(line, /Only INV-20260904-02 charges the stipend for a call day they share/);
  assert.match(line, /delete INV-20260904-02 and INV-20260904-01 here and bill their entries again on one invoice\./);
  assert.doesNotMatch(line, /bill the entries that are not on/);
  assert.doesNotMatch(line, /\u2014/);
  // Following the card: both deleted, one invoice bills e1, e2 and the stipend.
  const freed = [{ ...e1, invoiceId: null }, { ...e2, invoiceId: null }];
  const rebill = computeBilling(C1, freed, true, freed, [], null);
  assert.equal(rebill.lines.filter(l => l.label === COVERAGE_LINE_LABEL).length, 1);
  assert.equal(rebill.total, 1000);
  // Must pass: when INV-A also charges 09-01 and holds e1, it holds the day,
  // so INV-C's delete is the plain question and the card is unchanged.
  const Aboth = { ...Ainv, totalAmount: 1000, lines: [coverage(D), ...mac.lines] };
  const both = { ...data, invoices: [Cinv, Aboth] };
  const tb = invoicesBilledTwice(both).find(b => b.invoice.id === 'inv-c');
  assert.deepEqual([...tb.days], [D]);
  assert.equal(tb.keeps.size, 0);
  assert.equal(deleteSharesCallDay(both, Cinv, callDayOf), false);
  assert.match(billedTwiceLine(tb), /which was recorded first/);
});

// Review of r5 (940ca370, 2026-10-02): the same race, with INV-C listing only
// e1. INV-C then holds no row of its own on 09-01 (the server kept e1 on
// INV-A, and no marker is written for a day with an entry), so the r5 check
// of INV-C's own rows found no shared day, its delete was the plain question,
// and deleting it alone lost 09-01's stipend for good.
test('a duplicate holding no row of its own on the stipend day it alone charges still warns Delete BOTH', () => {
  const D = '2026-09-01';
  const C1 = { ...C, coveragePeriods: [{ start: D, end: D }] };
  const e1 = { id: 'e1', contractId: 'c-s', type: 'Consult', date: D, callDay: D,
    startTime: `${D}T20:00:00`, endTime: `${D}T20:30:00`, durationMin: 30, billedMin: 30, invoiceId: null };
  const phone = computeBilling(C1, [e1], true, [e1], [], null);
  assert.equal(phone.lines.filter(l => l.label === COVERAGE_LINE_LABEL).length, 1, 'the phone\'s INV-C carries the coverage line');
  const Cinv = { id: 'inv-c', number: 'INV-20260904-02', contractId: 'c-s', sentAt: '2026-09-04T10:00:00Z', entryIds: ['e1'],
    totalAmount: phone.total, lines: phone.lines, dayOverMin: phone.dayOverMin || { [D]: 0 } };
  const mac = computeBilling(C1, [e1], true, [e1], [Cinv], null);
  const Ainv = { id: 'inv-a', number: 'INV-20260904-01', contractId: 'c-s', sentAt: '2026-09-04T11:00:00Z', entryIds: ['e1'],
    totalAmount: mac.total, lines: mac.lines, dayOverMin: mac.dayOverMin || { [D]: 0 } };
  const data = { locumContracts: [C1], invoices: [Cinv, Ainv], workLog: [{ ...e1, invoiceId: 'inv-a' }] };
  const [b] = invoicesBilledTwice(data);
  assert.deepEqual([b.invoice.id, [...b.days], [...b.keeps]], ['inv-c', [], [D]]);
  assert.match(billedTwiceLine(b), /deleting INV-20260904-02 alone loses it/);
  assert.equal(deleteSharesCallDay(data, Cinv, callDayOf), true, 'the confirm warns as the card does');
  // What the warning prevents: INV-C deleted alone, the stipend is never offered again.
  assert.equal(computeBilling(C1, [], true, [{ ...e1, invoiceId: 'inv-a' }], [Ainv], null).total, 0);
  // Must pass: INV-A, which kept e1 and charges no stipend, is not a duplicate,
  // and deleting it is the plain question (INV-C holds no row there).
  assert.equal(deleteSharesCallDay(data, Ainv, callDayOf), false);
  // Must pass: the Mac never saw INV-C, so INV-A charges the stipend and holds
  // the day; INV-C's delete is the plain question (nothing is lost).
  const own = computeBilling(C1, [e1], true, [e1], [], null);
  const Aown = { ...Ainv, totalAmount: own.total, lines: own.lines };
  const blind = { ...data, invoices: [Cinv, Aown] };
  const tb = invoicesBilledTwice(blind).find(x => x.invoice.id === 'inv-c');
  assert.equal(tb.keeps.size, 0);
  assert.equal(deleteSharesCallDay(blind, Cinv, callDayOf), false);
});
