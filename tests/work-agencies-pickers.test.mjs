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
// The contracts below are synthetic (agencies, facilities, ids and dates are
// invented); what they keep is the shape the rules are tested on: blocks
// inside a longer term, a multi-year agreement, an archived fellowship and
// an ended block.

const clock = pinClock(test, 'America/Denver', '2026-10-30T12:00:00-06:00');
// Bundled before any test is registered: a top-level await after the first
// test() lets the root queue drain and run the clock's after-hook early.
const screens = await loadScreens('export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx"; export {default as ScanReviewCard} from "./src/components/features/ScanReviewCard.jsx"; export {default as DocumentsSection} from "./src/components/features/DocumentsSection.jsx";');
const TODAY = '2026-10-30';

const JUNIPER_LATE = { id: 'c-7c4f4004', facility: 'Synthetic Juniper (late block)', agency: 'Mossbank Healthcare, LLC.', payModel: 'stipend', callStipend: 4000, startDate: '2026-12-04', endDate: '2026-12-07', coveragePeriods: [{ start: '2026-12-04', end: '2026-12-07' }], createdAt: '2026-10-02 12:00:00+00' };
const FELLOWSHIP = { id: 'c-4a1d2002', facility: 'Synthetic fellowship', shortName: 'FELL', agency: null, payModel: null, callStipend: 0, startDate: '2026-02-05', endDate: '2026-08-04', termStart: '2026-02-05', termEnd: '2026-08-04', coveragePeriods: null, customFields: { archivedAt: '2026-10-04T12:00:00.000Z' }, createdAt: '2026-09-22 12:00:00+00' };
const GROUP = { id: 'c-6b3e3003', facility: 'Synthetic group practice', shortName: 'GRP', agency: null, payModel: 'daily', startDate: '2026-08-05', endDate: '2029-08-04', termStart: '2026-08-05', termEnd: '2029-08-04', coveragePeriods: [], createdAt: '2026-09-06 12:00:00+00' };
const PLAINSVIEW = { id: 'c-a05a5005', facility: 'Synthetic Plainsview', agency: 'Wexmoor Locums, Inc.', payModel: 'stipend', callStipend: 3000, startDate: '2026-10-30', endDate: '2027-02-08', coveragePeriods: [{ start: '2026-10-30', end: '2026-11-02' }, { start: '2026-12-10', end: '2026-12-17' }, { start: '2027-02-02', end: '2027-02-08' }], createdAt: '2026-08-29 12:00:00+00' };
const FOOTHILLS = { id: 'c-d16b6006', facility: 'Synthetic Foothills', agency: 'Mossbank Healthcare', payModel: 'stipend', callStipend: 3000, startDate: '2026-09-01', endDate: '2026-10-26', coveragePeriods: [{ start: '2026-09-01', end: '2026-09-13' }, { start: '2026-10-19', end: '2026-10-25' }], createdAt: '2026-08-28 12:00:00+00' };
const JUNIPER_EARLY = { id: 'c-4a0c1001', facility: 'Synthetic Juniper (early block)', agency: 'Mossbank Healthcare, LLC.', payModel: 'stipend', callStipend: 4000, startDate: '2026-08-28', endDate: '2026-08-31', coveragePeriods: [{ start: '2026-08-28', end: '2026-08-30' }], createdAt: '2026-08-27 12:00:00+00' };
// Newest-created first, the order the cloud returns them.
const CONTRACTS = [JUNIPER_LATE, FELLOWSHIP, GROUP, PLAINSVIEW, FOOTHILLS, JUNIPER_EARLY];

// ── Agency names ─────────────────────────────────────────────────

test('agency key ignores case, punctuation and company suffixes, and nothing else', () => {
  assert.equal(agencyKey('Mossbank Healthcare, LLC.'), 'mossbank healthcare');
  assert.equal(agencyKey('mossbank  HEALTHCARE'), 'mossbank healthcare');
  assert.equal(agencyKey('Wexmoor Locums, Inc.'), 'wexmoor locums');
  assert.equal(agencyKey('A & B Staffing Co.'), 'a and b staffing');
  assert.equal(agencyKey('Staff Care L.L.C.'), 'staff care');
  assert.equal(agencyKey('LLC'), 'llc', 'a bare suffix is still a name');
  assert.ok(sameAgency('Mossbank Healthcare', 'Mossbank Healthcare, LLC.'));
  assert.ok(!sameAgency('Mossbank Healthcare', 'Wexmoor Locums, Inc.'));
  assert.ok(!sameAgency('CompHealth', 'Comp Health Partners'));
  assert.ok(!sameAgency('', ''), 'two blanks are not the same agency');
});

test('one chip per agency, spelled as on the newest contract, none from archived or long-ended ones', () => {
  assert.deepEqual(agencyOptions(CONTRACTS, { today: TODAY }), ['Mossbank Healthcare, LLC.', 'Wexmoor Locums, Inc.']);
  // An agency only an archived contract carries is not offered.
  const archivedOnly = [...CONTRACTS, { ...FELLOWSHIP, id: 'x', agency: 'Old Agency' }];
  assert.ok(!agencyOptions(archivedOnly, { today: TODAY }).includes('Old Agency'));
  // Nor one whose only contract ended more than 30 days ago.
  const endedOnly = [...CONTRACTS, { ...JUNIPER_EARLY, id: 'y', agency: 'Gone Staffing' }];
  assert.ok(!agencyOptions(endedOnly, { today: TODAY }).includes('Gone Staffing'));
  // An unbilled expense's agency is added when no chip matches it, never twice.
  assert.deepEqual(agencyOptions(CONTRACTS, { today: TODAY, extra: ['Mossbank Healthcare', 'Gone Staffing', 'gone staffing'] }),
    ['Mossbank Healthcare, LLC.', 'Wexmoor Locums, Inc.', 'Gone Staffing']);
});

test('the agency defaults from the contract in force on the expense date', () => {
  // The day the ticket was filed: Mossbank, not Wexmoor.
  assert.ok(sameAgency(agencyForDate(CONTRACTS, '2026-09-30', { today: TODAY }), 'Mossbank Healthcare'));
  // Spelled like the chip, so the chip shows as picked.
  assert.equal(agencyForDate(CONTRACTS, '2026-09-30', { today: TODAY }), 'Mossbank Healthcare, LLC.');
  // Between Wexmoor blocks: Wexmoor, not the newest contract (Mossbank, Dec 4).
  assert.equal(agencyForDate(CONTRACTS, '2026-11-05', { today: TODAY }), 'Wexmoor Locums, Inc.');
  // Inside an Mossbank block that sits inside Wexmoor's term: the block wins.
  assert.equal(agencyForDate(CONTRACTS, '2026-12-05', { today: TODAY }), 'Mossbank Healthcare, LLC.');
  // A date under a contract that has since ended still names its agency.
  assert.equal(agencyForDate(CONTRACTS, '2026-08-29', { today: TODAY }), 'Mossbank Healthcare, LLC.');
  // No contract with an agency covers these: blank, and the chips are there to pick.
  assert.equal(agencyForDate(CONTRACTS, '2026-07-20', { today: TODAY }), '');
  assert.equal(agencyForDate(CONTRACTS, '2027-04-05', { today: TODAY }), '');
  assert.equal(agencyForDate(CONTRACTS, '', { today: TODAY }), '');
  // An archived contract never supplies the default.
  assert.equal(agencyForDate([{ ...FOOTHILLS, customFields: { archivedAt: '2026-10-27T00:00:00Z' } }], '2026-09-30', { today: TODAY }), '');
});

test('travel days either side of a booking name that booking, not a gap in a longer contract', () => {
  // The late Juniper block (Dec 4 to Dec 7) sits in a gap of Wexmoor's term
  // (blocks Oct 30-Nov 2, Dec 10-17, Feb 2-8). The flight out the day
  // before and the flight home or rental return the day after are Mossbank's.
  const at = (d) => agencyForDate(CONTRACTS, d, { today: TODAY });
  assert.equal(at('2026-12-03'), 'Mossbank Healthcare, LLC.', 'the day before the Juniper block');
  assert.equal(at('2026-12-08'), 'Mossbank Healthcare, LLC.', 'the day after: 1 day from Juniper, 2 from Wexmoor');
  assert.equal(at('2026-12-09'), 'Wexmoor Locums, Inc.', '2 days from Juniper, 1 from Wexmoor');
  assert.equal(at('2026-12-02'), 'Mossbank Healthcare, LLC.', '2 days before the Juniper block');
  assert.equal(at('2026-12-01'), 'Wexmoor Locums, Inc.', '3 days out: back to the contract whose term covers it');
  // The day before a Wexmoor block, outside any term: Wexmoor, where
  // it used to be blank. Foothills' last block ended Oct 25, 4 days before.
  assert.equal(at('2026-10-29'), 'Wexmoor Locums, Inc.');
  // Two days after Foothills' last block, three before Wexmoor's first.
  assert.equal(at('2026-10-27'), 'Mossbank Healthcare, LLC.');
  // Past the travel window of everything: still blank.
  assert.equal(at('2027-02-11'), '');
  assert.equal(at('2027-02-10'), 'Wexmoor Locums, Inc.', '2 days after the last Wexmoor block');
  // A booking still beats a travel day: Dec 4 is inside the late Juniper block.
  assert.equal(at('2026-12-04'), 'Mossbank Healthcare, LLC.');
  assert.equal(at('2026-12-10'), 'Wexmoor Locums, Inc.');
  // A date that is not YYYY-MM-DD is never inside or near a booking.
  assert.equal(at('12/03/2026'), '');
  assert.equal(at('not a date'), '');
  // An archived contract's booking is not a travel day either.
  const archivedJuniper = CONTRACTS.map(c => (c.id === JUNIPER_LATE.id ? { ...c, customFields: { archivedAt: '2026-11-05T00:00:00Z' } } : c));
  assert.equal(agencyForDate(archivedJuniper, '2026-12-03', { today: TODAY }), 'Wexmoor Locums, Inc.');
});

test('a multi-year agreement with an agency does not outrank a nearby booking', () => {
  const longTerm = { id: 'c-long', facility: 'Synthetic long agreement', agency: 'Long Term Staffing', startDate: '2026-02-05', endDate: '2029-02-04', coveragePeriods: [], createdAt: '2026-10-06 12:00:00+00' };
  const list = [longTerm, ...CONTRACTS];
  const at = (d) => agencyForDate(list, d, { today: TODAY });
  assert.equal(at('2026-12-05'), 'Mossbank Healthcare, LLC.', 'inside a block');
  assert.equal(at('2026-12-03'), 'Mossbank Healthcare, LLC.', 'a travel day');
  assert.equal(at('2026-11-19'), 'Wexmoor Locums, Inc.', 'a gap in a shorter contract');
  assert.equal(at('2027-07-06'), 'Long Term Staffing', 'nothing else near');
});

// ── Ended and archived contracts ─────────────────────────────────

test('a contract has ended once its last day is more than 30 days past', () => {
  assert.equal(contractEndDate(PLAINSVIEW), '2027-02-08');
  assert.equal(contractEndDate({ coveragePeriods: [{ start: '2026-06-05' }] }), '2026-06-05');
  assert.equal(contractEndDate({ startDate: '2026-02-05' }), '', 'open-ended');
  assert.equal(isEnded(JUNIPER_EARLY, TODAY), true);
  assert.equal(isEnded(FOOTHILLS, TODAY), false, 'ended Oct 26, only 4 days ago');
  assert.equal(isEnded(FELLOWSHIP, TODAY), true);
  assert.equal(isEnded({ endDate: '2026-09-30' }, TODAY), false, 'exactly 30 days: still offered');
  assert.equal(isEnded({ endDate: '2026-09-29' }, TODAY), true, '31 days: ended');
  assert.equal(isEnded({ startDate: '2026-02-05' }, TODAY), false, 'open-ended never ends');
  assert.equal(termCovers(FOOTHILLS, '2026-09-30'), true, 'between blocks, inside the term');
  assert.equal(termCovers(FOOTHILLS, '2026-10-27'), false);
});

test('pickers: no archived or ended contract unless chosen, in force on the date, or asked for', () => {
  const ids = (list) => list.map(c => c.id);
  assert.deepEqual(ids(pickableContracts(CONTRACTS, null, { today: TODAY })), ['c-7c4f4004', 'c-6b3e3003', 'c-a05a5005', 'c-d16b6006']);
  assert.equal(hiddenEndedCount(CONTRACTS, null, { today: TODAY }), 1, 'the early Juniper block; the archived fellowship is not counted');
  assert.ok(ids(pickableContracts(CONTRACTS, null, { today: TODAY, showEnded: true })).includes('c-4a0c1001'));
  assert.equal(hiddenEndedCount(CONTRACTS, null, { today: TODAY, showEnded: true }), 0);
  assert.ok(ids(pickableContracts(CONTRACTS, null, { today: TODAY, date: '2026-08-29' })).includes('c-4a0c1001'), 'in force on the date being logged');
  assert.ok(ids(pickableContracts(CONTRACTS, 'c-4a0c1001', { today: TODAY })).includes('c-4a0c1001'), 'already chosen');
  // The archived fellowship appears in no picker unless an entry is bound to it.
  for (const opts of [{}, { showEnded: true }, { date: '2026-04-05' }]) {
    assert.ok(!ids(pickableContracts(CONTRACTS, null, { today: TODAY, ...opts })).includes('c-4a1d2002'), JSON.stringify(opts));
  }
  assert.ok(ids(pickableContracts(CONTRACTS, 'c-4a1d2002', { today: TODAY })).includes('c-4a1d2002'));
  // Forecast's "load every coverage day" still sees ended contracts: it
  // reconciles the past, so it keeps using selectableContracts.
  assert.ok(ids(selectableContracts(CONTRACTS)).includes('c-4a0c1001'));
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
  clock.setNow('2026-09-30T09:00:00-06:00');
  try {
    const m = mount(screens.Expenses, { data: { locumContracts: CONTRACTS } });
    click(m, '+ Expense');
    let tree = m.render();
    assert.equal(agencyInput(tree).props.value, 'Mossbank Healthcare, LLC.');
    assert.equal(chipOn(tree, 'Mossbank Healthcare, LLC.'), true);
    // One chip per agency, none for the archived fellowship or the ended early block.
    const chips = nodes(tree).filter(n => n.type === 'button' && /Mossbank|Wexmoor/.test(textOf(n))).map(textOf);
    assert.deepEqual([...new Set(chips)], ['Mossbank Healthcare, LLC.', 'Wexmoor Locums, Inc.']);
    find(tree, n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2026-11-05' } });
    tree = m.render();
    assert.equal(agencyInput(tree).props.value, 'Wexmoor Locums, Inc.');
    find(tree, n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2027-04-05' } });
    assert.equal(agencyInput(m.render()).props.value, '', 'no contract then: blank, chips shown');
    // Once the physician picks, a date change leaves the pick alone.
    find(m.render(), n => n.type === 'button' && textOf(n) === 'Mossbank Healthcare, LLC.', 'chip').props.onClick();
    find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'date').props.onChange({ target: { value: '2026-11-05' } });
    assert.equal(agencyInput(m.render()).props.value, 'Mossbank Healthcare, LLC.');
  } finally { clock.setNow('2026-10-30T12:00:00-06:00'); }
});

test('Expenses: invoicing one agency picks up both spellings, and the saved expense keeps no helper keys', () => {
  const expenses = [
    { id: 'x1', date: '2026-09-05', amount: 40, category: 'Tolls', vendor: 'Synthetic tolls', agency: 'Mossbank Healthcare', invoiceId: null },
    { id: 'x2', date: '2026-09-06', amount: 90, category: 'Lodging', vendor: 'Synthetic inn', agency: 'Mossbank Healthcare, LLC.', invoiceId: null },
    { id: 'x3', date: '2026-10-31', amount: 60, category: 'Fuel', vendor: 'Synthetic fuel', agency: 'Wexmoor Locums, Inc.', invoiceId: null },
  ];
  const m = mount(screens.Expenses, { data: { locumContracts: CONTRACTS, travelExpenses: expenses } });
  click(m, 'Invoice');
  // Only the "Invoice expenses" sheet: the add form has agency chips too.
  const sheet = () => find(m.render(), n => n.props?.title === 'Invoice expenses', 'invoice sheet');
  let tree = sheet();
  const box = (id) => nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')[['x3', 'x2', 'x1'].indexOf(id)];
  // Newest first: x3 (Wexmoor) leads, so Wexmoor is the starting bill-to.
  assert.deepEqual(['x3', 'x2', 'x1'].map(id => box(id).props.checked), [true, false, false]);
  find(tree, n => n.type === 'button' && textOf(n) === 'Mossbank Healthcare, LLC.', 'Mossbank chip').props.onClick();
  tree = sheet();
  assert.deepEqual(['x3', 'x2', 'x1'].map(id => box(id).props.checked), [false, true, true], 'both spellings bill together');
  // The row that differs only in spelling is not flagged as another agency.
  assert.doesNotMatch(textOf(tree), /\(Mossbank Healthcare\)/);
  // With no agency anywhere, a blank bill-to still gathers the blank expenses.
  const bare = mount(screens.Expenses, { data: { locumContracts: [], travelExpenses: [{ id: 'b1', date: '2026-09-05', amount: 10, category: 'Parking', agency: '', invoiceId: null }] } });
  click(bare, 'Invoice');
  assert.equal(nodes(find(bare.render(), el => el.props?.title === 'Invoice expenses', 'sheet')).find(el => el.type === 'input' && el.props.type === 'checkbox').props.checked, true);

  const n = mount(screens.Expenses, { data: { locumContracts: CONTRACTS } });
  click(n, '+ Expense');
  find(n.render(), el => el.type === 'input' && el.props.placeholder === '$ amount', 'amount').props.onChange({ target: { value: '12.5' } });
  click(n, 'Add expense');
  const saved = n.calls.find(c => c[0] === 'add' && c[1] === 'travelExpenses')[2];
  assert.equal(saved.agency, 'Wexmoor Locums, Inc.', 'today, Oct 30, is Wexmoor');
  assert.deepEqual(Object.keys(saved).sort(), ['agency', 'amount', 'category', 'date', 'id', 'vendor']);
});

test('receipt scan: the agency follows the receipt date until picked', () => {
  const result = { documentType: 'receipt', confidence: 'high', extracted: { merchant: 'Synthetic rental tolls', date: '09/30/2026', total: '18.40', category: 'Tolls' } };
  const m = mount(screens.ScanReviewCard, { data: { locumContracts: CONTRACTS }, props: { result, onSave: () => {}, onDiscard: () => {} } });
  let tree = m.render();
  assert.equal(agencyInput(tree).props.value, 'Mossbank Healthcare, LLC.');
  const dateInput = () => find(m.render(), n => n.type === 'input' && n.props.type === 'date', 'receipt date');
  dateInput().props.onChange({ target: { value: '2026-11-05' } });
  assert.equal(agencyInput(m.render()).props.value, 'Wexmoor Locums, Inc.');
  find(m.render(), n => n.type === 'button' && textOf(n) === 'Mossbank Healthcare, LLC.', 'chip').props.onClick();
  dateInput().props.onChange({ target: { value: '2026-10-31' } });
  tree = m.render();
  assert.equal(agencyInput(tree).props.value, 'Mossbank Healthcare, LLC.', 'a pick is kept');
  assert.equal(chipOn(tree, 'Mossbank Healthcare, LLC.'), true);
});

test('Work Log: the archived fellowship and the ended early block are in no picker, and never the fallback', () => {
  const m = mount(screens.WorkLog, { data: { locumContracts: CONTRACTS, workLog: [] }, storage: { lastContract: 'c-4a1d2002' } });
  const tree = m.render();
  const picker = find(tree, n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Foothills')), 'Logging against');
  assert.notEqual(picker.props.value, 'c-4a1d2002', 'a remembered pick that has since been archived does not hold');
  const opts = nodes(picker).filter(o => o.type === 'option').map(o => o.props.value);
  assert.ok(!opts.includes('c-4a1d2002'));
  assert.ok(!opts.includes('c-4a0c1001'));
  assert.equal(opts.at(-1), SHOW_ENDED);
  picker.props.onChange({ target: { value: SHOW_ENDED } });
  const again = nodes(find(m.render(), n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Foothills')), 'picker')).filter(o => o.type === 'option').map(o => o.props.value);
  assert.ok(again.includes('c-4a0c1001'), 'shown on request');
  assert.ok(!again.includes('c-4a1d2002'), 'archived stays out; Unarchive is on Agreements');
});

test('Work Log: an archived contract with unbilled work opens when picked, as "Needs invoicing" does', () => {
  // Invoices' "Needs invoicing" lists every contract with unbilled entries,
  // archived ones included, and opens one by remembering it as the pick.
  const archivedFoothills = { ...FOOTHILLS, customFields: { archivedAt: '2026-10-27T00:00:00Z' } };
  const contracts = CONTRACTS.map(c => (c.id === FOOTHILLS.id ? archivedFoothills : c));
  const unbilled = { id: 'w-unbilled', createdAt: '2026-10-25T15:00:00Z', contractId: FOOTHILLS.id, type: 'Call', date: '2026-10-25', callDay: '2026-10-25', startTime: '2026-10-25T15:00:00.000Z', endTime: '2026-10-25T15:30:00.000Z', durationMin: 30, billedMin: 30, description: '', privateNote: '', invoiceId: null };
  const picker = (m) => find(m.render(), n => n.type === 'select' && nodes(n).some(o => o.type === 'option' && textOf(o).includes('Synthetic Plainsview')), 'Logging against');
  const m = mount(screens.WorkLog, { data: { locumContracts: contracts, workLog: [unbilled] }, storage: { lastContract: FOOTHILLS.id } });
  assert.equal(picker(m).props.value, FOOTHILLS.id, 'the archived contract opens');
  assert.ok(nodes(picker(m)).some(o => o.type === 'option' && o.props.value === FOOTHILLS.id), 'and is listed while it is the one open');
  assert.ok(nodes(m.render()).some(n => n.key === 'w-unbilled'), 'its unbilled entry is on screen to invoice');
  // Once that work is invoiced, the archived pick no longer holds.
  const done = mount(screens.WorkLog, { data: { locumContracts: contracts, workLog: [{ ...unbilled, invoiceId: 'inv-1' }] }, storage: { lastContract: FOOTHILLS.id } });
  assert.notEqual(picker(done).props.value, FOOTHILLS.id);
});

test('Documents: archived agreements are labelled and listed after current ones', () => {
  const doc = { id: 'd1', name: 'synthetic-agreement.pdf', type: 'application/pdf', uploadedAt: '2026-10-06T00:00:00Z', linkedTo: '' };
  const m = mount(screens.DocumentsSection, { data: { locumContracts: CONTRACTS, documents: [doc], licenses: [], privileges: [], insurance: [], cme: [], healthRecords: [], education: [], deductibles: [], customCategories: [], customRecords: [] } });
  const labels = nodes(m.render()).filter(n => n.type === 'option' && /^Agreement: /.test(textOf(n))).map(textOf);
  assert.equal(labels.length, CONTRACTS.length, 'every agreement stays linkable');
  assert.match(labels.at(-1), /Synthetic fellowship.*\(archived\)$/);
  assert.equal(labels.filter(l => l.endsWith('(archived)')).length, 1);
});
