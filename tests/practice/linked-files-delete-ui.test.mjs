import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, find, pinClock } from '../harness/component-harness.mjs';

// Deleting an expense or an agreement also deletes the files linked to it
// (AppContext deleteItem cascades: the document rows, their stored files and
// a tombstone). The confirm must say so and count them (PRAC-019, PRAC-017);
// "Its receipts stay in Files" was false. Synthetic records only.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { Expenses, Contracts } = await loadScreens('export {default as Expenses} from "./src/components/features/locum/Expenses.jsx"; export {default as Contracts} from "./src/components/features/locum/Contracts.jsx";');

const EXP = { id: 'x1', contractId: null, date: '2026-09-05', category: 'Lodging', vendor: 'Synthetic Inn', amount: 412.4, agency: 'Synthetic Staffing', invoiceId: null };
const receipt = (id, linkedTo) => ({ id, name: `${id}.jpg`, type: 'image/jpeg', linkedTo, storagePath: `u/${id}.jpg` });
const confirmText = (m) => m.dialogs.filter(d => d[0] === 'confirm').map(d => d[1]);

test('PRAC-019: deleting an expense with 2 receipts says both receipts are deleted too', () => {
  const docs = [receipt('r1', 'travelExpenses:x1'), receipt('r2', 'travelExpenses:x1'), receipt('r3', 'travelExpenses:other')];
  const m = mount(Expenses, { data: { travelExpenses: [EXP], documents: docs } });
  find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete expense', 'delete').props.onClick({ stopPropagation() {} });
  const [ask] = confirmText(m);
  // The shared wording (helpers.deleteConfirmText), as every other delete says it.
  assert.equal(ask, 'Delete this expense and its 2 receipts? The receipts will be removed from Files too. This cannot be undone.');
  assert.doesNotMatch(ask, /stay in Files/);
  assert.deepEqual(m.calls, [['delete', 'travelExpenses', 'x1']]);
});

test('PRAC-019: an expense with no receipt asks plainly, and a declined confirm deletes nothing', () => {
  const m = mount(Expenses, { data: { travelExpenses: [EXP], documents: [] }, confirm: () => false });
  find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete expense', 'delete').props.onClick({ stopPropagation() {} });
  assert.deepEqual(confirmText(m), ['Delete this expense? This cannot be undone.']);
  assert.equal(m.calls.length, 0);
});

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'hourly', hourlyRate: 250, incrementMinutes: 15, minCallMinutes: 15 };

test('PRAC-017: deleting an agreement with 2 attached files names the loss', () => {
  const docs = [receipt('a1', 'locumContracts:c1'), receipt('a2', 'locumContracts:c1')];
  const m = mount(Contracts, { data: { locumContracts: [CONTRACT], documents: docs } });
  find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete agreement', 'delete').props.onClick();
  assert.deepEqual(confirmText(m), ['Delete this agreement and its 2 attached files (a1.jpg, a2.jpg)? The files will be removed from Files too. Work log entries keep their data. This cannot be undone.']);
  assert.deepEqual(m.calls, [['delete', 'locumContracts', 'c1']]);
});

test('PRAC-017: an agreement with no file keeps the old confirm', () => {
  const m = mount(Contracts, { data: { locumContracts: [CONTRACT], documents: [] } });
  find(m.render(), n => n.type === 'button' && n.props['aria-label'] === 'Delete agreement', 'delete').props.onClick();
  assert.deepEqual(confirmText(m), ['Delete this agreement? Work log entries keep their data. This cannot be undone.']);
});
