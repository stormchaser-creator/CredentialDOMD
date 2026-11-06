import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, textOf, find, nodes, pinClock } from '../harness/component-harness.mjs';

// AC-1: "Resolve which [facility]'s contract I am working under now." A
// physician can hold two agreements at one facility (a prior term and the
// current one). With nothing picked, no timer, no schedule row and no
// contract used yet on this device, Work > "Logging against" must default
// and label itself on the agreement whose own coverage dates actually cover
// today, not just the first agreement on file. Synthetic contracts only.

pinClock(test, 'America/Denver', '2026-07-10T09:00:00-06:00');
const { WorkLog } = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');

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

const picker = (tree) => find(tree, n => n.type === 'select' && n.props['aria-labelledby'] === 'work-log-contract', 'Logging against picker');

test('Logging against defaults to the Sanford agreement whose term covers today, not the first one on file', () => {
  // The prior, expired term is first in the array (as it would be if added
  // to the account before the renewal) and nothing on the device points at
  // either contract: no pick, no timer, no schedule row, no past entry.
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [], scheduleDays: [] } });
  const tree = m.render();
  assert.equal(picker(tree).props.value, CURRENT_TERM.id, 'opens on the agreement in force today (Jul 1 – Dec 31), not the one that ended Jun 30');
});

test('the two Sanford agreements are told apart in the Logging against options', () => {
  const m = mount(WorkLog, { data: { locumContracts: [PRIOR_TERM, CURRENT_TERM], workLog: [], scheduleDays: [] } });
  const options = nodes(picker(m.render())).filter(n => n.type === 'option');
  const labels = options.filter(o => o.props.value === PRIOR_TERM.id || o.props.value === CURRENT_TERM.id).map(textOf);
  assert.equal(labels.length, 2, 'both Sanford agreements are offered');
  assert.notEqual(labels[0], labels[1], 'their labels differ so the physician can tell which contract is which');
});
