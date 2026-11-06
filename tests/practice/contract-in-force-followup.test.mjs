import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, find, nodes, field, click, pinClock } from '../harness/component-harness.mjs';
import { termLabel, hasFacilitySibling, inForceAmongSiblings } from '../../src/utils/contractsForDate.js';

// Follow-up to AC-1 (ticket 8acf7241): the in-force fallback added for the
// Logging against picker must win over a stale remembered or last-logged
// contract at the same facility, not only when nothing is remembered at
// all; the same disambiguation is needed on Log past time and on the
// Agreements list; and a lone agreement at a facility should get no term
// suffix, since there is nothing to tell it apart from. Synthetic
// contracts and dates only.

const clock = pinClock(test, 'America/Denver', '2026-07-10T09:00:00-06:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const { Contracts } = await loadScreens('export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const PRIOR_TERM = {
  id: 'c-prior', facility: 'Synthetic Sanford Health', payModel: 'hourly', hourlyRate: 200,
  incrementMinutes: 15, minCallMinutes: 15, callStipend: 0,
  startDate: '2026-01-01', endDate: '2026-06-30',
};
const CURRENT_TERM = {
  id: 'c-current', facility: 'Synthetic Sanford Health', payModel: 'hourly', hourlyRate: 225,
  incrementMinutes: 15, minCallMinutes: 15, callStipend: 0,
  startDate: '2026-07-01', endDate: '2026-12-31',
};
const OTHER = {
  id: 'c-other', facility: 'Synthetic Other Clinic', payModel: 'hourly', hourlyRate: 180,
  incrementMinutes: 15, minCallMinutes: 15, callStipend: 0,
  startDate: '2026-01-01', endDate: '2026-12-31',
};

const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');
const formSelect = (m) => find(field(m.render(), 'Contract'), n => n.type === 'select', 'form contract');

// ── Logging against: a stale remembered/last-logged pick gives way ───

test('a contract last used on the device gives way to a sibling at the same facility that covers today', () => {
  const m = mount(WorkLog, {
    data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [], scheduleDays: [] },
    storage: { lastContract: PRIOR_TERM.id },
  });
  assert.equal(picker(m.render()).props.value, CURRENT_TERM.id, 'the renewed agreement, not the expired term the device remembers');
});

test('the contract of the most recent log entry gives way to a sibling that covers today too', () => {
  const logged = {
    id: 'w1', createdAt: '2026-06-15T15:00:00Z', contractId: PRIOR_TERM.id, type: 'Call',
    date: '2026-06-15', callDay: '2026-06-15', startTime: '2026-06-15T15:00:00.000Z',
    endTime: '2026-06-15T15:30:00.000Z', durationMin: 30, billedMin: 30, description: '', privateNote: '', invoiceId: null,
  };
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [logged], scheduleDays: [] } });
  assert.equal(picker(m.render()).props.value, CURRENT_TERM.id, 'the last entry was on the expired term, but the renewed one is in force now');
});

test('a deliberate pick for today still opens on the contract chosen, even the expired term', () => {
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [], scheduleDays: [] } });
  picker(m.render()).props.onChange({ target: { value: PRIOR_TERM.id } });
  assert.equal(picker(m.render()).props.value, PRIOR_TERM.id, 'a pick made by hand is never overridden by the in-force fallback');
});

test('before the new term\'s start hour, the call day in progress is still the prior term\'s, not the calendar date', () => {
  // CURRENT_TERM starts 2026-07-01; at 5 AM that calendar date the 7 AM call
  // day has not turned over yet, so the call day in progress is still
  // 2026-06-30 (PRIOR_TERM's last day), not the raw calendar date.
  clock.setNow('2026-07-01T05:00:00-06:00');
  try {
    const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [], scheduleDays: [] } });
    assert.equal(picker(m.render()).props.value, PRIOR_TERM.id, "last night's call day, not the new term's first calendar date");
  } finally { clock.setNow('2026-07-10T09:00:00-06:00'); }
});

// ── No suffix for a lone agreement at its own facility (cosmetic) ────

test('Logging against: the two Sanford options show their term, the lone Other Clinic option does not', () => {
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM, OTHER], workLog: [], scheduleDays: [] } });
  const options = nodes(picker(m.render())).filter(n => n.type === 'option');
  const label = (id) => textOf(options.find(o => o.props.value === id));
  assert.notEqual(label(PRIOR_TERM.id), label(CURRENT_TERM.id), 'the two Sanford agreements are still told apart');
  assert.equal(label(OTHER.id), OTHER.facility, 'no term suffix when nothing else shares this facility');
});

// ── Log past time gets the same disambiguation ───────────────────────

test('Log past time labels the two same-facility agreements with their term, and leaves a lone agreement unlabeled', () => {
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM, OTHER], workLog: [], scheduleDays: [] } });
  m.render();
  click(m, 'Log past time');
  const options = nodes(formSelect(m)).filter(n => n.type === 'option');
  const label = (id) => textOf(options.find(o => o.props.value === id));
  assert.notEqual(label(PRIOR_TERM.id), label(CURRENT_TERM.id), 'the two Sanford agreements are told apart here too');
  assert.equal(label(OTHER.id), OTHER.facility, 'a lone agreement at its facility needs no term suffix');
});

// ── Agreements marks the in-force one among facility siblings ────────

test('Agreements marks only the Sanford agreement in force now, not the expired term or the lone other-facility agreement', () => {
  const m = mount(Contracts, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM, OTHER] } });
  const tree = m.render();
  const cards = nodes(tree).filter(n => n.type === 'div' && typeof n.props?.onClick === 'function' && textOf(n).includes('summary ›'));
  assert.equal(cards.length, 3);
  assert.ok(!textOf(cards[0]).includes('In force now'), 'the expired Sanford term is not marked');
  assert.ok(textOf(cards[1]).includes('In force now'), 'the renewed Sanford term is marked');
  assert.ok(!textOf(cards[2]).includes('In force now'), 'a lone agreement at its own facility needs no marker');
});

// ── The pure rules (contractsForDate.js) ──────────────────────────────

test('termLabel reads an agreement whose dates live only in coverage blocks', () => {
  const blockOnly = {
    id: 'c-blocks', facility: 'Synthetic Sanford Health', payModel: 'hourly', hourlyRate: 200,
    coveragePeriods: [{ start: '2026-07-01', end: '2026-07-15' }, { start: '2026-08-01', end: '2026-08-15' }],
  };
  assert.equal(termLabel(blockOnly), 'Jul 2026 to Aug 2026', 'spans the earliest block start to the latest block end');
});

test('hasFacilitySibling is true only when another contract in the list shares the facility', () => {
  const list = [PRIOR_TERM, CURRENT_TERM, OTHER];
  assert.equal(hasFacilitySibling(list, PRIOR_TERM), true);
  assert.equal(hasFacilitySibling(list, CURRENT_TERM), true);
  assert.equal(hasFacilitySibling(list, OTHER), false);
});

test('inForceAmongSiblings marks the covering agreement only among contracts sharing a facility', () => {
  const marks = inForceAmongSiblings([PRIOR_TERM, CURRENT_TERM, OTHER], '2026-07-10');
  assert.deepEqual([...marks], [CURRENT_TERM.id], 'the in-force Sanford term is marked, the lone Other Clinic agreement is not');
});
