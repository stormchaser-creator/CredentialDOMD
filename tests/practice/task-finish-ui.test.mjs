import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, field, click, pinClock } from '../harness/component-harness.mjs';

// PRAC-020: a to-do is marked done only once its work entry exists, and the
// finish form's note field says where that note goes. Driven through the
// real To do and Work screens. Synthetic records only.

pinClock(test, 'America/Denver', '2026-08-12T12:00:00-06:00');
const { TaskNotes, WorkLog } = await loadScreens('export {default as TaskNotes} from "./src/components/features/locum/TaskNotes.jsx"; export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');

const CONTRACT = { id: 'c1', facility: 'Synthetic General', payModel: 'stipend', callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [{ start: '2026-08-01', end: '2026-08-20' }], startDate: '2026-08-01', endDate: '2026-08-20' };
const TASK = { id: 't1', text: 'call back Dr. Synthetic about the ICU consult', contractId: 'c1', capturedAt: '2026-08-12T15:00:00.000Z' };

// Each task row is a small inner component (no hooks); render it in place.
const rows = (m) => nodes(m.render()).filter(n => typeof n.type === 'function' && 'isDone' in (n.props || {})).map(n => n.type(n.props));
const rowButton = (m, label) => find(rows(m), n => n.type === 'button' && textOf(n).includes(label), label);
const finish = (m) => {
  rowButton(m, 'Finish & log time').props.onClick();
  field(m.render(), 'Begin').props.onCommit('09:00');
  field(m.render(), 'End').props.onCommit('09:30');
};

test('Finish hands the task to the Work tab without marking it done', () => {
  const drafts = [];
  const m = mount(TaskNotes, { data: { locumContracts: [CONTRACT], taskNotes: [TASK] }, props: { onBill: (d) => drafts.push(d) } });
  finish(m);
  click(m, 'Log it to the Work tab');
  assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'taskNotes').length, 0, 'no completedAt before the entry exists');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].taskId, 't1');
  assert.equal(drafts[0].start, '09:00');
});

const logDraft = (draft, opts = {}) => {
  const m = mount(WorkLog, { data: { locumContracts: [CONTRACT], taskNotes: [TASK], workLog: [] }, props: { billDraft: draft, onBillDraftDone() {} }, ...opts });
  m.render();
  click(m, 'Log it');
  const yes = nodes(m.render()).find(n => n.type === 'button' && textOf(n).includes('Yes, log it here'));
  if (yes) yes.props.onClick();
  return m;
};
const DRAFT = { date: '2026-08-12', type: 'Call', start: '09:00', end: '09:30', description: TASK.text, privateNote: '', contractId: 'c1', taskId: 't1' };

test('the task is marked done, with its work entry, once the entry is saved', () => {
  const m = logDraft(DRAFT);
  const row = m.calls.find(c => c[0] === 'add' && c[1] === 'workLog')?.[2];
  assert.ok(row, 'the work entry was written');
  const task = m.calls.find(c => c[0] === 'edit' && c[1] === 'taskNotes')?.[2];
  assert.ok(task?.completedAt, 'completed after the entry');
  assert.equal(task.workLogId, row.id);
  assert.deepEqual(Object.keys(task).sort(), ['capturedAt', 'completedAt', 'contractId', 'id', 'text', 'workLogId']);
});

test('a refused work entry leaves the task open', () => {
  const m = logDraft(DRAFT, { refuse: (op, key) => key === 'workLog' });
  assert.equal(m.calls.filter(c => c[0] === 'edit' && c[1] === 'taskNotes').length, 0);
});

test('a finished task says billed only when it has a work entry', () => {
  const done = [
    { ...TASK, id: 'a', completedAt: '2026-08-12T16:00:00.000Z', workLogId: 'w1' },
    { ...TASK, id: 'b', text: 'old one', completedAt: '2026-08-11T16:00:00.000Z' },
  ];
  const m = mount(TaskNotes, { data: { locumContracts: [CONTRACT], taskNotes: done } });
  click(m, 'Show finished');
  const text = rows(m).map(textOf).join('\n');
  assert.match(text, /call back Dr\. Synthetic about the ICU consultCame in .* · billed/);
  assert.match(text, /old oneCame in .* · finished/);
});

test('the finish form labels the device-only note as private, and the billing note as the invoice text', () => {
  const m = mount(TaskNotes, { data: { locumContracts: [CONTRACT], taskNotes: [TASK] } });
  rowButton(m, 'Finish & log time').props.onClick();
  const tree = m.render();
  assert.equal(nodes(tree).filter(n => n.props?.label === 'Notes (for the invoice)').length, 0);
  assert.match(field(tree, 'Private note (this device only)').props.hint, /Never uploaded, never on invoices/);
  assert.ok(field(tree, 'Billing note (shows on the invoice)'));
});
