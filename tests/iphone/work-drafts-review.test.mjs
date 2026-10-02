// Review of 9484782c, Practice > Work on the installed iPhone app:
//  - a Log past time draft left from earlier replaced the finished to-do's
//    bill form when Work opened: the to-do's times and the link that marks
//    it done were lost;
//  - after dictation that could not be read, a restored draft said his words
//    were in the private note, which a draft never keeps.
// "Discarded" is a new mount over the same device storage. Synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, pinClock } from '../harness/component-harness.mjs';

pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const CONTRACT = { id: 'c-1', facility: 'Synthetic North Hospital', payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31' };
const DATA = () => ({ locumContracts: [CONTRACT], workLog: [], taskNotes: [{ id: 't1', title: 'QA to-do consult' }] });
const settle = (m) => { m.render(); m.render(); return m.render(); };
const billingNote = tree => find(tree, n => n.type === 'textarea' && /ED consult/.test(n.props?.placeholder || ''), 'billing note');
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, querySelector: () => null, activeElement: null, body: { style: {} } };

test('a finished to-do\'s bill form is what opens; the Log past time draft waits for the next visit', () => {
  const m = mount(screens.WorkLog, { data: DATA() });
  click(m, 'Log past time');
  billingNote(settle(m)).props.onChange({ target: { value: 'QA OLD DRAFT NOTE' } });
  settle(m);
  assert.ok(m.storage.formDrafts?.['work:manual']);
  // He switches to To do, finishes the to-do with its times, and taps to bill it.
  let done = 0;
  const billDraft = { contractId: 'c-1', type: 'Call', date: '2026-09-29', start: '09:00', end: '09:30', description: 'QA to-do consult', taskId: 't1' };
  const bill = mount(screens.WorkLog, { data: DATA(), storage: m.storage, props: { billDraft, onBillDraftDone: () => { done++; } } });
  const tree = settle(bill);
  assert.ok(done >= 1, 'the to-do handed over');
  assert.equal(billingNote(tree).props.value, 'QA to-do consult', 'the to-do\'s form, not the old draft');
  assert.ok(!nodes(tree).some(n => n.props?.role === 'status' && /Restored what you were typing/.test(textOf(n))));
  const times = nodes(tree).filter(n => /^(Start|End)( time)?$/.test(n.props?.label || '')).map(n => n.props.value ?? n.props.children?.props?.value);
  assert.deepEqual(times, ['09:00', '09:30'], 'with the times he typed on the to-do');
  // Cancelling it leaves the older draft for the next visit.
  click(bill, 'Cancel');
  settle(bill);
  const next = mount(screens.WorkLog, { data: DATA(), storage: bill.storage });
  assert.equal(billingNote(settle(next)).props.value, 'QA OLD DRAFT NOTE');
});

test('dictation that could not be read, then iOS discards the app: the restored form says the words are gone, not that they are in the private note', async () => {
  const m = mount(screens.WorkLog, { data: DATA() });
  let rec = null;
  globalThis.window.webkitSpeechRecognition = class { constructor() { rec = this; } start() {} stop() {} };
  click(m, 'Dictate an entry');
  const result = Object.assign([{ transcript: 'QA spoken consult nine to nine thirty' }], { isFinal: true });
  rec.onresult({ results: [result] });
  settle(m);
  click(m, 'Done, build the entry');
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  const tree = settle(m);
  assert.ok(nodes(tree).some(n => n.props?.role === 'alert' && /Your words are in the private note/.test(textOf(n))), 'said while the words are there');
  const stored = JSON.stringify(m.storage.formDrafts?.['work:manual'] || {});
  assert.doesNotMatch(stored, /QA spoken consult/, 'the words never go in the draft');
  assert.doesNotMatch(stored, /Your words are in the private note/);
  const again = mount(screens.WorkLog, { data: DATA(), storage: m.storage });
  const back = settle(again);
  const alerts = nodes(back).filter(n => n.props?.role === 'alert').map(textOf).join(' ');
  assert.doesNotMatch(alerts, /Your words are in the private note/);
  assert.match(alerts, /The words you dictated were in the private note, which is not kept when the app closes, so they are gone/);
});
