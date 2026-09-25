import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agencyKey, sameAgency, agencyOptions, agencyForDate, isEnded, contractEndDate, termCovers,
  pickableContracts, hiddenEndedCount, selectableContracts, SHOW_ENDED,
} from '../src/utils/contractsForDate.js';
import { loadScreens, mount, nodes, textOf, find, click, pinClock } from './harness/component-harness.mjs';

// Ticket 8360f6e6: the expense agency defaults from the contract in force on
// the expense date, agency lists are one per agency with no archived or
// long-ended contracts, and archived or ended contracts stay out of pickers.
// The contracts below are shaped like the owner's (dates, agencies, archive
// state), with synthetic facilities.

const clock = pinClock(test, 'America/Denver', '2026-09-25T12:00:00-06:00');
// Bundled before any test is registered: a top-level await after the first
// test() lets the root queue drain and run the clock's after-hook early.
const screens = await loadScreens('export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as ScanReviewCard} from "./src/components/features/ScanReviewCard.jsx"; export {default as DocumentsSection} from "./src/components/features/DocumentsSection.jsx";');
const TODAY = '2026-09-25';

const PENROSE_NOV = { id: 'c-72090639', facility: 'Synthetic Penrose (Nov block)', agency: 'MPLT Healthcare, LLC.', payModel: 'stipend', callStipend: 4000, startDate: '2026-10-30', endDate: '2026-11-02', coveragePeriods: [{ start: '2026-10-30', end: '2026-11-02' }], createdAt: '2026-08-28 05:08:41.504+00' };
const FELLOWSHIP = { id: 'c-4aee869f', facility: 'Synthetic fellowship (Jan-Jun 2026)', shortName: 'FELL', agency: null, payModel: null, callStipend: 0, startDate: '2026-01-01', endDate: '2026-06-30', termStart: '2026-01-01', termEnd: '2026-06-30', coveragePeriods: null, customFields: { archivedAt: '2026-08-30T04:01:02.996Z' }, createdAt: '2026-08-18 03:35:47.23034+00' };
const GROUP = { id: 'c-647371d1', facility: 'Synthetic group practice', shortName: 'GRP', agency: null, payModel: 'daily', startDate: '2026-07-01', endDate: '2029-06-30', termStart: '2026-07-01', termEnd: '2029-06-30', coveragePeriods: [], createdAt: '2026-08-02 19:14:40.071+00' };
const SANFORD = { id: 'c-a94a56d3', facility: 'Synthetic Fargo', agency: 'Weatherby Locums, Inc.', payModel: 'stipend', callStipend: 3000, startDate: '2026-09-25', endDate: '2027-01-04', coveragePeriods: [{ start: '2026-09-25', end: '2026-09-28' }, { start: '2026-11-05', end: '2026-11-12' }, { start: '2026-12-29', end: '2027-01-04' }], createdAt: '2026-07-25 16:27:52.173+00' };
const GOODSAM = { id: 'c-daead6ab', facility: 'Synthetic Good Sam', agency: 'MPLT Healthcare', payModel: 'stipend', callStipend: 3000, startDate: '2026-07-28', endDate: '2026-09-21', coveragePeriods: [{ start: '2026-07-28', end: '2026-08-09' }, { start: '2026-09-14', end: '2026-09-20' }], createdAt: '2026-07-24 02:38:41.971067+00' };
const PENROSE_JUL = { id: 'c-4ad9edf8', facility: 'Synthetic Penrose (Jul block)', agency: 'MPLT Healthcare, LLC.', payModel: 'stipend', callStipend: 4000, startDate: '2026-07-24', endDate: '2026-07-27', coveragePeriods: [{ start: '2026-07-24', end: '2026-07-26' }], createdAt: '2026-07-23 23:44:47.194+00' };
// Newest-created first, the order the cloud returns them.
const CONTRACTS = [PENROSE_NOV, FELLOWSHIP, GROUP, SANFORD, GOODSAM, PENROSE_JUL];

// ── Agency names ─────────────────────────────────────────────────

test('agency key ignores case, punctuation and company suffixes, and nothing else', () => {
  assert.equal(agencyKey('MPLT Healthcare, LLC.'), 'mplt healthcare');
  assert.equal(agencyKey('mplt  HEALTHCARE'), 'mplt healthcare');
  assert.equal(agencyKey('Weatherby Locums, Inc.'), 'weatherby locums');
  assert.equal(agencyKey('A & B Staffing Co.'), 'a and b staffing');
  assert.equal(agencyKey('Staff Care L.L.C.'), 'staff care');
  assert.equal(agencyKey('LLC'), 'llc', 'a bare suffix is still a name');
  assert.ok(sameAgency('MPLT Healthcare', 'MPLT Healthcare, LLC.'));
  assert.ok(!sameAgency('MPLT Healthcare', 'Weatherby Locums, Inc.'));
  assert.ok(!sameAgency('CompHealth', 'Comp Health Partners'));
  assert.ok(!sameAgency('', ''), 'two blanks are not the same agency');
});

test('one chip per agency, spelled as on the newest contract, none from archived or long-ended ones', () => {
  assert.deepEqual(agencyOptions(CONTRACTS, { today: TODAY }), ['MPLT Healthcare, LLC.', 'Weatherby Locums, Inc.']);
  // An agency only an archived contract carries is not offered.
  const archivedOnly = [...CONTRACTS, { ...FELLOWSHIP, id: 'x', agency: 'Old Agency' }];
  assert.ok(!agencyOptions(archivedOnly, { today: TODAY }).includes('Old Agency'));
  // Nor one whose only contract ended more than 30 days ago.
  const endedOnly = [...CONTRACTS, { ...PENROSE_JUL, id: 'y', agency: 'Gone Staffing' }];
  assert.ok(!agencyOptions(endedOnly, { today: TODAY }).includes('Gone Staffing'));
  // An unbilled expense's agency is added when no chip matches it, never twice.
  assert.deepEqual(agencyOptions(CONTRACTS, { today: TODAY, extra: ['MPLT Healthcare', 'Gone Staffing', 'gone staffing'] }),
    ['MPLT Healthcare, LLC.', 'Weatherby Locums, Inc.', 'Gone Staffing']);
});

test('the agency defaults from the contract in force on the expense date', () => {
  // The day the owner filed the ticket: MPLT, not Weatherby.
  assert.ok(sameAgency(agencyForDate(CONTRACTS, '2026-08-26', { today: TODAY }), 'MPLT Healthcare'));
  // Spelled like the chip, so the chip shows as picked.
  assert.equal(agencyForDate(CONTRACTS, '2026-08-26', { today: TODAY }), 'MPLT Healthcare, LLC.');
  // Between Weatherby blocks: Weatherby, not the newest contract (MPLT, Oct 30).
  assert.equal(agencyForDate(CONTRACTS, '2026-10-01', { today: TODAY }), 'Weatherby Locums, Inc.');
  // Inside an MPLT block that sits inside Weatherby's term: the block wins.
  assert.equal(agencyForDate(CONTRACTS, '2026-10-31', { today: TODAY }), 'MPLT Healthcare, LLC.');
  // A July date under a contract that has since ended still names its agency.
  assert.equal(agencyForDate(CONTRACTS, '2026-07-25', { today: TODAY }), 'MPLT Healthcare, LLC.');
  // No contract with an agency covers these: blank, and the chips are there to pick.
  assert.equal(agencyForDate(CONTRACTS, '2026-06-15', { today: TODAY }), '');
  assert.equal(agencyForDate(CONTRACTS, '2027-03-01', { today: TODAY }), '');
  assert.equal(agencyForDate(CONTRACTS, '', { today: TODAY }), '');
  // An archived contract never supplies the default.
  assert.equal(agencyForDate([{ ...GOODSAM, customFields: { archivedAt: '2026-09-22T00:00:00Z' } }], '2026-08-26', { today: TODAY }), '');
});

test('travel days either side of a booking name that booking, not a gap in a longer contract', () => {
  // The Penrose block (Oct 30 to Nov 2) sits in a gap of Weatherby's term
  // (blocks Sep 25-28, Nov 5-12, Dec 29-Jan 4). The flight out the day
  // before and the flight home or rental return the day after are MPLT's.
  const at = (d) => agencyForDate(CONTRACTS, d, { today: TODAY });
  assert.equal(at('2026-10-29'), 'MPLT Healthcare, LLC.', 'the day before the Penrose block');
  assert.equal(at('2026-11-03'), 'MPLT Healthcare, LLC.', 'the day after: 1 day from Penrose, 2 from Weatherby');
  assert.equal(at('2026-11-04'), 'Weatherby Locums, Inc.', '2 days from Penrose, 1 from Weatherby');
  assert.equal(at('2026-10-28'), 'MPLT Healthcare, LLC.', '2 days before the Penrose block');
  assert.equal(at('2026-10-27'), 'Weatherby Locums, Inc.', '3 days out: back to the contract whose term covers it');
  // The day before a Weatherby block, outside any term: Weatherby, where
  // it used to be blank. Good Sam's last block ended Sep 20, 4 days before.
  assert.equal(at('2026-09-24'), 'Weatherby Locums, Inc.');
  // Two days after Good Sam's last block, three before Weatherby's first.
  assert.equal(at('2026-09-22'), 'MPLT Healthcare, LLC.');
  // Past the travel window of everything: still blank.
  assert.equal(at('2027-01-07'), '');
  assert.equal(at('2027-01-06'), 'Weatherby Locums, Inc.', '2 days after the last Weatherby block');
  // A booking still beats a travel day: Oct 30 is inside Penrose.
  assert.equal(at('2026-10-30'), 'MPLT Healthcare, LLC.');
  assert.equal(at('2026-11-05'), 'Weatherby Locums, Inc.');
  // A date that is not YYYY-MM-DD is never inside or near a booking.
  assert.equal(at('10/29/2026'), '');
  assert.equal(at('not a date'), '');
  // An archived contract's booking is not a travel day either.
  const archivedPenrose = CONTRACTS.map(c => (c.id === PENROSE_NOV.id ? { ...c, customFields: { archivedAt: '2026-10-01T00:00:00Z' } } : c));
  assert.equal(agencyForDate(archivedPenrose, '2026-10-29', { today: TODAY }), 'Weatherby Locums, Inc.');
});

test('a multi-year agreement with an agency does not outrank a nearby booking', () => {
  const longTerm = { id: 'c-long', facility: 'Synthetic long agreement', agency: 'Long Term Staffing', startDate: '2026-01-01', endDate: '2028-12-31', coveragePeriods: [], createdAt: '2026-09-01 00:00:00+00' };
  const list = [longTerm, ...CONTRACTS];
  const at = (d) => agencyForDate(list, d, { today: TODAY });
  assert.equal(at('2026-10-31'), 'MPLT Healthcare, LLC.', 'inside a block');
  assert.equal(at('2026-10-29'), 'MPLT Healthcare, LLC.', 'a travel day');
  assert.equal(at('2026-10-15'), 'Weatherby Locums, Inc.', 'a gap in a shorter contract');
  assert.equal(at('2027-06-01'), 'Long Term Staffing', 'nothing else near');
});

// ── Ended and archived contracts ─────────────────────────────────

test('a contract has ended once its last day is more than 30 days past', () => {
  assert.equal(contractEndDate(SANFORD), '2027-01-04');
  assert.equal(contractEndDate({ coveragePeriods: [{ start: '2026-05-01' }] }), '2026-05-01');
  assert.equal(contractEndDate({ startDate: '2026-01-01' }), '', 'open-ended');
  assert.equal(isEnded(PENROSE_JUL, TODAY), true);
  assert.equal(isEnded(GOODSAM, TODAY), false, 'ended Sep 21, only 4 days ago');
  assert.equal(isEnded(FELLOWSHIP, TODAY), true);
  assert.equal(isEnded({ endDate: '2026-08-26' }, TODAY), false, 'exactly 30 days: still offered');
  assert.equal(isEnded({ endDate: '2026-08-25' }, TODAY), true, '31 days: ended');
  assert.equal(isEnded({ startDate: '2026-01-01' }, TODAY), false, 'open-ended never ends');
  assert.equal(termCovers(GOODSAM, '2026-08-26'), true, 'between blocks, inside the term');
  assert.equal(termCovers(GOODSAM, '2026-09-22'), false);
});

test('pickers: no archived or ended contract unless chosen, in force on the date, or asked for', () => {
  const ids = (list) => list.map(c => c.id);
  assert.deepEqual(ids(pickableContracts(CONTRACTS, null, { today: TODAY })), ['c-72090639', 'c-647371d1', 'c-a94a56d3', 'c-daead6ab']);
  assert.equal(hiddenEndedCount(CONTRACTS, null, { today: TODAY }), 1, 'the July Penrose block; the archived fellowship is not counted');
  assert.ok(ids(pickableContracts(CONTRACTS, null, { today: TODAY, showEnded: true })).includes('c-4ad9edf8'));
  assert.equal(hiddenEndedCount(CONTRACTS, null, { today: TODAY, showEnded: true }), 0);
  assert.ok(ids(pickableContracts(CONTRACTS, null, { today: TODAY, date: '2026-07-25' })).includes('c-4ad9edf8'), 'in force on the date being logged');
  assert.ok(ids(pickableContracts(CONTRACTS, 'c-4ad9edf8', { today: TODAY })).includes('c-4ad9edf8'), 'already chosen');
  // The archived fellowship appears in no picker unless an entry is bound to it.
  for (const opts of [{}, { showEnded: true }, { date: '2026-03-01' }]) {
    assert.ok(!ids(pickableContracts(CONTRACTS, null, { today: TODAY, ...opts })).includes('c-4aee869f'), JSON.stringify(opts));
  }
  assert.ok(ids(pickableContracts(CONTRACTS, 'c-4aee869f', { today: TODAY })).includes('c-4aee869f'));
  // Forecast's "load every coverage day" still sees ended contracts: it
  // reconciles the past, so it keeps using selectableContracts.
  assert.ok(ids(selectableContracts(CONTRACTS)).includes('c-4ad9edf8'));
});

test('no picker or fallback reads the raw contract list any more', () => {
  const src = (p) => readFileSync(new URL(`../src/components/features/${p}`, import.meta.url), 'utf8');
  const workLog = src('locum/WorkLog.jsx');
  assert.doesNotMatch(workLog, /contracts\.find\(c => c\.id === lastLoggedContractId\)/);
  assert.doesNotMatch(src('locum/RVULog.jsx'), /pickedId \|\| contracts\[0\]\?\.id/);
  assert.match(src('CPTLookup.jsx'), /pickableContracts\(data\.locumContracts, null\)/);
  for (const f of ['locum/Expenses.jsx', 'ScanReviewCard.jsx', 'locum/StatementImport.jsx']) {
    assert.doesNotMatch(src(f), /new Set\(\(?[\w.]*(?:locumContracts|contracts)[^)]*\)?\.map\(c => c\.agency\)/, `${f} builds its own agency list`);
    assert.doesNotMatch(src(f), /agencies\[0\]/, `${f} defaults to the first agency`);
  }
  for (const f of ['locum/WorkLog.jsx', 'locum/RVULog.jsx', 'locum/TaskNotes.jsx', 'locum/CallSyncPanel.jsx', 'locum/Forecast.jsx']) {
    assert.match(src(f), /SHOW_ENDED/, `${f} offers "Show ended contracts"`);
  }
  assert.equal(SHOW_ENDED.startsWith('__'), true, 'never a real contract id');
});

// ── The screens ──────────────────────────────────────────────────

const agencyInput = (tree) => find(tree, n => n.type === 'input' && /Bill to agency/.test(n.props.placeholder || ''), 'agency input');
const chipOn = (tree, name) => find(tree, n => n.type === 'button' && textOf(n) === name, name).props.style.color === '#fff';

test('Expenses: a new expense takes the agency in force on its date and follows the date until one is picked', () => {
  clock.setNow('2026-08-26T09:00:00-06:00');
  try {
    const m = mount(screens.Expenses, { data: { locumContracts: CONTRACTS } });
    click(m, '+ Expense');
    let tree = m.render();
    assert.equal(agencyInput(tree).props.value, 'MPLT Healthcare, LLC.');
    assert.equal(chipOn(tree, 'MPLT Healthcare, LLC.'), true);
    // One chip per agency, none for the archived fellowship or the ended July block.
    const chips = nodes(tree).filter(n => n.type === 'button' && /MPLT|Weatherby/.test(textOf(n))).map(textOf);
    assert.deepEqual([...new Set(chips)], ['MPLT Healthcare, LLC.', 'Weatherby Locums, Inc.']);
    find(tree, n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2026-10-01' } });
    tree = m.render();
    assert.equal(agencyInput(tree).props.value, 'Weatherby Locums, Inc.');
    find(tree, n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2027-03-01' } });
    assert.equal(agencyInput(m.render()).props.value, '', 'no contract then: blank, chips shown');
    // Once the physician picks, a date change leaves the pick alone.
    find(m.render(), n => n.type === 'button' && textOf(n) === 'MPLT Healthcare, LLC.', 'chip').props.onClick();
    find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2026-10-01' } });
    assert.equal(agencyInput(m.render()).props.value, 'MPLT Healthcare, LLC.');
  } finally { clock.setNow('2026-09-25T12:00:00-06:00'); }
});

test('Expenses: invoicing one agency picks up both spellings, and the saved expense keeps no helper keys', () => {
  const expenses = [
    { id: 'x1', date: '2026-08-01', amount: 40, category: 'Tolls', vendor: 'Synthetic tolls', agency: 'MPLT Healthcare', invoiceId: null },
    { id: 'x2', date: '2026-08-02', amount: 90, category: 'Lodging', vendor: 'Synthetic inn', agency: 'MPLT Healthcare, LLC.', invoiceId: null },
    { id: 'x3', date: '2026-09-26', amount: 60, category: 'Fuel', vendor: 'Synthetic fuel', agency: 'Weatherby Locums, Inc.', invoiceId: null },
  ];
  const m = mount(screens.Expenses, { data: { locumContracts: CONTRACTS, travelExpenses: expenses } });
  click(m, 'Invoice');
  // Only the "Invoice expenses" sheet: the add form has agency chips too.
  const sheet = () => find(m.render(), n => n.props?.title === 'Invoice expenses', 'invoice sheet');
  let tree = sheet();
  const box = (id) => nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[['x3', 'x2', 'x1'].indexOf(id)];
  // Newest first: x3 (Weatherby) leads, so Weatherby is the starting bill-to.
  assert.deepEqual(['x3', 'x2', 'x1'].map(id => box(id).props.checked), [true, false, false]);
  find(tree, n => n.type === 'button' && textOf(n) === 'MPLT Healthcare, LLC.', 'MPLT chip').props.onClick();
  tree = sheet();
  assert.deepEqual(['x3', 'x2', 'x1'].map(id => box(id).props.checked), [false, true, true], 'both spellings bill together');
  // The row that differs only in spelling is not flagged as another agency.
  assert.doesNotMatch(textOf(tree), /\(MPLT Healthcare\)/);
  // With no agency anywhere, a blank bill-to still gathers the blank expenses.
  const bare = mount(screens.Expenses, { data: { locumContracts: [], travelExpenses: [{ id: 'b1', date: '2026-08-01', amount: 10, category: 'Parking', agency: '', invoiceId: null }] } });
  click(bare, 'Invoice');
  assert.equal(nodes(find(bare.render(), el => el.props?.title === 'Invoice expenses', 'sheet')).find(el => el.type === 'input' && el.props.type === 'checkbox').props.checked, true);

  const n = mount(screens.Expenses, { data: { locumContracts: CONTRACTS } });
  click(n, '+ Expense');
  find(n.render(), el => el.type === 'input' && el.props.placeholder === '$ amount', 'amount').props.onChange({ target: { value: '12.5' } });
  click(n, 'Add expense');
  const saved = n.calls.find(c => c[0] === 'add' && c[1] === 'travelExpenses')[2];
  assert.equal(saved.agency, 'Weatherby Locums, Inc.', 'today, Sep 25, is Weatherby');
  assert.deepEqual(Object.keys(saved).sort(), ['agency', 'amount', 'category', 'date', 'id', 'vendor']);
});

test('receipt scan: the agency follows the receipt date until picked', () => {
  const result = { documentType: 'receipt', confidence: 'high', extracted: { merchant: 'Synthetic rental tolls', date: '08/26/2026', total: '18.40', category: 'Tolls' } };
  const m = mount(screens.ScanReviewCard, { data: { locumContracts: CONTRACTS }, props: { result, onSave: () => {}, onDiscard: () => {} } });
  let tree = m.render();
  assert.equal(agencyInput(tree).props.value, 'MPLT Healthcare, LLC.');
  const dateInput = () => find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'receipt date');
  dateInput().props.onChange({ target: { value: '2026-10-01' } });
  assert.equal(agencyInput(m.render()).props.value, 'Weatherby Locums, Inc.');
  find(m.render(), n => n.type === 'button' && textOf(n) === 'MPLT Healthcare, LLC.', 'chip').props.onClick();
  dateInput().props.onChange({ target: { value: '2026-09-26' } });
  tree = m.render();
  assert.equal(agencyInput(tree).props.value, 'MPLT Healthcare, LLC.', 'a pick is kept');
  assert.equal(chipOn(tree, 'MPLT Healthcare, LLC.'), true);
});

test('Work Log: the archived fellowship and the ended July block are in no picker, and never the fallback', () => {
  const m = mount(screens.WorkLog, { data: { locumContracts: CONTRACTS, workLog: [] }, storage: { lastContract: 'c-4aee869f' } });
  const tree = m.render();
  const picker = find(tree, n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Good Sam')), 'Logging against');
  assert.notEqual(picker.props.value, 'c-4aee869f', 'a remembered pick that has since been archived does not hold');
  const opts = nodes(picker).filter(o => o.type === 'option').map(o => o.props.value);
  assert.ok(!opts.includes('c-4aee869f'));
  assert.ok(!opts.includes('c-4ad9edf8'));
  assert.equal(opts.at(-1), SHOW_ENDED);
  picker.props.onChange({ target: { value: SHOW_ENDED } });
  const again = nodes(find(m.render(), n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Good Sam')), 'picker')).filter(o => o.type === 'option').map(o => o.props.value);
  assert.ok(again.includes('c-4ad9edf8'), 'shown on request');
  assert.ok(!again.includes('c-4aee869f'), 'archived stays out; Unarchive is on Agreements');
});

test('Work Log: an archived contract with unbilled work opens when picked, as "Needs invoicing" does', () => {
  // Invoices' "Needs invoicing" lists every contract with unbilled entries,
  // archived ones included, and opens one by remembering it as the pick.
  const archivedGoodSam = { ...GOODSAM, customFields: { archivedAt: '2026-09-22T00:00:00Z' } };
  const contracts = CONTRACTS.map(c => (c.id === GOODSAM.id ? archivedGoodSam : c));
  const unbilled = { id: 'w-unbilled', createdAt: '2026-09-20T15:00:00Z', contractId: GOODSAM.id, type: 'Call', date: '2026-09-20', callDay: '2026-09-20', startTime: '2026-09-20T15:00:00.000Z', endTime: '2026-09-20T15:30:00.000Z', durationMin: 30, billedMin: 30, description: '', privateNote: '', invoiceId: null };
  const picker = (m) => find(m.render(), n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Fargo')), 'Logging against');
  const m = mount(screens.WorkLog, { data: { locumContracts: contracts, workLog: [unbilled] }, storage: { lastContract: GOODSAM.id } });
  assert.equal(picker(m).props.value, GOODSAM.id, 'the archived contract opens');
  assert.ok(nodes(picker(m)).some(o => o.type === 'option' && o.props.value === GOODSAM.id), 'and is listed while it is the one open');
  assert.ok(nodes(m.render()).some(n => n.key === 'w-unbilled'), 'its unbilled entry is on screen to invoice');
  // Once that work is invoiced, the archived pick no longer holds.
  const done = mount(screens.WorkLog, { data: { locumContracts: contracts, workLog: [{ ...unbilled, invoiceId: 'inv-1' }] }, storage: { lastContract: GOODSAM.id } });
  assert.notEqual(picker(done).props.value, GOODSAM.id);
});

test('Documents: archived agreements are labelled and listed after current ones', () => {
  const doc = { id: 'd1', name: 'synthetic-agreement.pdf', type: 'application/pdf', uploadedAt: '2026-09-01T00:00:00Z', linkedTo: '' };
  const m = mount(screens.DocumentsSection, { data: { locumContracts: CONTRACTS, documents: [doc], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], deductibles: [], customCategories: [], customRecords: [] } });
  const labels = nodes(m.render()).filter(n => n.type === 'option' && /^Agreement: /.test(textOf(n))).map(textOf);
  assert.equal(labels.length, CONTRACTS.length, 'every agreement stays linkable');
  assert.match(labels.at(-1), /Synthetic fellowship.*\(archived\)$/);
  assert.equal(labels.filter(l => l.endsWith('(archived)')).length, 1);
});
