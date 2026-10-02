// Practice > Work on the installed iPhone app (QA lab, WebKit + the iOS
// model, 2026-10-01):
//  - a timer started with localStorage nearly full was lost when iOS
//    discarded the app during the call, with nothing said (PRAC-009 tight);
//  - Log past time lost everything typed when iOS discarded the app while he
//    was in another one (PRAC-011).
// The timer is kept in this tab's sessionStorage when localStorage refuses
// it, and he is told at once; the Log past time form is kept as a draft and
// opens again. "Discarded" here is a new mount over the same storage, as the
// lab models it (a reload while hidden). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, click, pinClock } from '../harness/component-harness.mjs';

pinClock(test, 'America/Denver', '2026-09-29T10:00:00-06:00');
const screens = await loadScreens('export {default as WorkLog} from "./src/components/features/locum/WorkLog.jsx";');
const CONTRACT = { id: 'c-1', facility: 'Synthetic North Hospital', payModel: 'hourly', hourlyRate: 200, incrementMinutes: 15, minCallMinutes: 15, callStipend: 0, startDate: '2026-01-01', endDate: '2026-12-31' };

function memoryTab() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const work = (storage = {}) => mount(screens.WorkLog, { data: { locumContracts: [CONTRACT], workLog: [] }, storage });
const settle = (m) => { m.render(); m.render(); return m.render(); };
// A form opened by an effect (the restored draft) focuses its first field.
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, querySelector: () => null, activeElement: null, body: { style: {} } };

test('a timer the full device refuses is kept in this tab, he is told as it starts, and it survives the discard', () => {
  globalThis.sessionStorage = memoryTab();
  try {
    const m = work();
    globalThis.__screen.storageFull = true;
    click(m, 'Got a call? Start the timer');
    assert.match(m.html(), /could not save this timer on this phone, so it is kept only while the app stays open in this window/);
    assert.doesNotMatch(m.html(), /storage is full|Free space/, 'nothing untrue, and nothing he cannot do');
    const note = find(settle(m), n => n.type === 'textarea' || (n.type === 'input' && /note/i.test(n.props?.placeholder || '')), 'billing note');
    note.props.onChange({ target: { value: 'QA iOS ED consult, head CT review' } });
    // iOS discards the page while the Phone app is in front; it loads again.
    const again = work({});
    globalThis.__screen.storageFull = true;
    const html = again.html();
    assert.match(html, /Stop &amp; Log/, 'the timer is still running');
    assert.match(html, /QA iOS ED consult, head CT review/, 'and the note typed during the call');
  } finally { delete globalThis.sessionStorage; }
});

test('with room on the device nothing is said and nothing stays in the tab', () => {
  globalThis.sessionStorage = memoryTab();
  try {
    const m = work();
    click(m, 'Got a call? Start the timer');
    assert.doesNotMatch(m.html(), /could not save this timer/);
    assert.ok(m.storage.timer, 'on the device');
    assert.equal(globalThis.sessionStorage.m.size, 0);
  } finally { delete globalThis.sessionStorage; }
});

test('Log past time typed and then discarded by iOS opens again with what he typed; Cancel drops it', () => {
  const m = work();
  click(m, 'Log past time');
  find(settle(m), n => n.type === 'textarea' && /ED consult/.test(n.props?.placeholder || ''), 'billing note').props.onChange({ target: { value: 'QA iOS discarded consult' } });
  find(settle(m), n => n.type === 'input' && n.props?.type === 'number', 'minutes').props.onChange({ target: { value: '45' } });
  settle(m);
  assert.ok(m.storage.formDrafts?.['work:manual'], 'kept as it is typed');
  // Discarded and loaded again over the same device storage.
  const again = mount(screens.WorkLog, { data: { locumContracts: [CONTRACT], workLog: [] }, storage: m.storage });
  const tree = settle(again);
  assert.ok(nodes(tree).some(n => n.props?.role === 'status' && /Restored what you were typing before the app closed/.test(textOf(n))), 'the form is open again and says why');
  assert.equal(find(tree, n => n.type === 'textarea' && /ED consult/.test(n.props?.placeholder || ''), 'billing note').props.value, 'QA iOS discarded consult');
  assert.equal(find(tree, n => n.type === 'input' && n.props?.type === 'number', 'minutes').props.value, '45');
  click(again, 'Cancel');
  settle(again);
  assert.equal(again.storage.formDrafts?.['work:manual'], undefined, 'Cancel discards the draft');
});

test('the private note never goes into the draft', () => {
  const m = work();
  click(m, 'Log past time');
  const priv = nodes(settle(m)).find(n => n.type === 'input' && /MRN/.test(n.props?.placeholder || ''));
  assert.ok(priv, 'private note field');
  priv.props.onChange({ target: { value: 'Synthetic MRN 0000' } });
  settle(m);
  assert.doesNotMatch(JSON.stringify(m.storage.formDrafts || {}), /MRN 0000/);
});
