import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf, find, pinClock } from '../harness/component-harness.mjs';

// The RVU log (PRAC-013): a dictation carrying a patient identifier is never
// sent to the AI coder or saved to the cloud, and editing an encounter's
// codes or date carries through to the case log it created. Driven through
// the real RVULog screen. Synthetic text only; no real patient data.

pinClock(test, 'America/Chicago', '2026-09-20T12:00:00-05:00');
const { RVULog } = await loadScreens('export {default as RVULog} from "./src/components/features/locum/RVULog.jsx";');

const fetches = [];
globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('no network in tests'); };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const CONTRACT = { id: 'c1', facility: 'Synthetic General', coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
const DIRTY = 'Jane Doe MRN 4455667 DOB 3/4/1950, crani for SDH';
const box = (m) => find(m.render(), n => n.type === 'textarea' && n.props.onChange && !('minHeight' in (n.props.style || {}) && n.props.value === undefined), 'dictation box');
const type = (m, text) => nodes(m.render()).find(n => n.type === 'textarea').props.onChange({ target: { value: text } });
const button = (m, label) => find(m.render(), n => n.type === 'button' && textOf(n).includes(label), label);
const addManualCode = async (m, code) => {
  find(m.render(), n => n.type === 'input' && n.props.inputMode === 'search', 'manual search').props.onChange({ target: { value: code } });
  await settle();
  find(m.render(), n => n.type === 'button' && n.key === code, `result ${code}`).props.onClick();
};

test('PRAC-013: a dictation with an MRN and DOB is not sent to the coder, and says why', async () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [], caseLogs: [], settings: { apiKey: 'synthetic-test-key' } } });
  type(m, DIRTY);
  await button(m, 'Code it').props.onClick();
  await settle();
  assert.equal(fetches.length, 0, 'nothing left the device');
  assert.match(textOf(m.render()), /Not sent: the description contains a medical record number\. CredentialDOMD doesn't keep patient identifiers; remove it and try again\./);
  assert.equal(nodes(m.render()).find(n => n.type === 'textarea').props.value, DIRTY, 'the text stays to be edited');
});

test('PRAC-013: Save refuses a description with an identifier, even for codes added by hand', async () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [], caseLogs: [] } });
  await addManualCode(m, '61312');
  type(m, DIRTY);
  button(m, 'Save').props.onClick();
  assert.equal(m.calls.filter(c => c[0] === 'add').length, 0, 'no encounter or case log written');
  assert.match(textOf(m.render()), /Not saved: the description contains a medical record number/);
  // A clean description saves.
  type(m, 'crani for SDH, two progress notes');
  button(m, 'Save').props.onClick();
  const enc = m.calls.find(c => c[0] === 'add' && c[1] === 'encounters')[2];
  assert.equal(enc.spokenText, 'crani for SDH, two progress notes');
});

const ENC = { id: 'e1', contractId: 'c1', date: '2026-09-10', codes: [{ code: '61312', desc: 'Craniotomy evac hematoma supratentorial, extradural or subdural', units: 1, wRVU: 29.42, modifier: '' }], note: '', spokenText: 'crani for SDH' };
const CASE = { id: 'cl1', date: '2026-09-10', title: 'Craniotomy evac hematoma supratentorial, extradural or subdural', category: 'Trauma', cptCodes: '61312', wRvu: 29.42, facility: 'Synthetic General', source: 'RVU log', customFields: { 'From RVU entry': 'e1' } };
const openEncounter = (m) => find(m.render(), n => n.type === 'div' && n.key === 'e1' && n.props.role === 'button', 'encounter row').props.onClick();
const caseEdits = (m) => m.calls.filter(c => c[0] === 'edit' && c[1] === 'caseLogs').map(c => c[2]);

test('PRAC-013: changing 61312 to 61313 rewrites the linked case log (codes, wRVU 27.39, title)', async () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(m);
  find(m.render(), n => n.type === 'input' && /Add a code/.test(n.props.placeholder || ''), 'code search').props.onChange({ target: { value: '61313' } });
  await settle();
  find(m.render(), n => n.type === 'button' && n.key === '61313', 'result').props.onClick();
  // Remove 61312 (the first code's × button).
  find(m.render(), n => n.type === 'button' && textOf(n) === '×', 'remove code').props.onClick();
  button(m, 'Save changes').props.onClick();
  const [cl] = caseEdits(m);
  assert.equal(cl.cptCodes, '61313');
  assert.equal(cl.wRvu, 27.39);
  assert.equal(cl.title, 'Craniotomy evac hematoma supratentorial, intracerebral (ICH)');
  assert.equal(cl.category, 'Trauma', 'the category picked earlier is kept');
  assert.equal(caseEdits(m).length, 1, 'one write per case log');
});

test('PRAC-013: a date-only edit moves the case log date; an unchanged save writes nothing to it', () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(m);
  find(m.render(), n => n.type === 'input' && n.props.type === 'date' && n.props.value === '2026-09-10', 'date').props.onChange({ target: { value: '2026-09-11' } });
  button(m, 'Save changes').props.onClick();
  assert.deepEqual(caseEdits(m).map(c => [c.date, c.cptCodes, c.wRvu]), [['2026-09-11', '61312', 29.42]]);

  const same = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(same);
  button(same, 'Save changes').props.onClick();
  assert.equal(caseEdits(same).length, 0);
});

test('PRAC-013: removing every operative code leaves the case log as it was and says so', () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(m);
  find(m.render(), n => n.type === 'button' && textOf(n) === '×', 'remove code').props.onClick();
  button(m, 'Save changes').props.onClick();
  assert.equal(caseEdits(m).length, 0);
  assert.match(textOf(m.render()), /No operative code is left on this entry, so its case log was left as it was/);
});

test('PRAC-013: a contract-only edit still moves the case log to the new facility', () => {
  const other = { id: 'c2', facility: 'Synthetic Mercy', coveragePeriods: [{ start: '2026-09-01', end: '2026-09-30' }], startDate: '2026-09-01', endDate: '2026-09-30' };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT, other], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(m);
  const picker = find(m.render(), n => n.type === 'select' && n.props.value === 'c1', 'contract picker');
  picker.props.onChange({ target: { value: 'c2' } });
  button(m, 'Save changes').props.onClick();
  assert.deepEqual(caseEdits(m).map(c => [c.facility, c.cptCodes, c.date]), [['Synthetic Mercy', '61312', '2026-09-10']]);
});

test('PRAC-013: the note on an encounter is screened too', () => {
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [CASE] } });
  openEncounter(m);
  nodes(m.render()).filter(n => n.type === 'textarea').at(-1).props.onChange({ target: { value: 'f/u DOB 3/4/1950' } });
  button(m, 'Save changes').props.onClick();
  assert.equal(m.calls.length, 0);
  assert.match(textOf(m.render()), /Not saved: the note contains a full date of birth/);
});

test('PRAC-013: any other path that writes an encounter drops a flagged dictation (prepareRecord)', async () => {
  const { prepareRecord } = await import('../../src/utils/recordWrite.js');
  assert.equal(prepareRecord('encounters', { id: 'e9', spokenText: 'Jane Doe MRN 4455667 DOB 3/4/1950, crani for SDH', codes: [] }).spokenText, '');
  assert.equal(prepareRecord('encounters', { id: 'e9', spokenText: 'crani for SDH, two progress notes' }).spokenText, 'crani for SDH, two progress notes');
  assert.equal(prepareRecord('workLog', { id: 'w1', description: 'MRN 4455667' }).description, 'MRN 4455667', 'other sections are not touched here');
});

// A case log the surgeon has edited in Case Logs is a career record: an RVU
// entry edit carries its wRVU and date over, but never replaces a description
// or codes typed there. Fields still reading what the entry wrote follow it.
const setModifier = (m, value) => find(m.render(), n => n.type === 'select' && n.props.title === 'Assistant surgeon modifier', 'modifier').props.onChange({ target: { value } });

test('an edited case log title survives an RVU code edit; codes and wRVU still follow', () => {
  const retitled = { ...CASE, title: 'Evacuation of acute subdural, left convexity' };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [retitled] } });
  openEncounter(m);
  setModifier(m, '80');
  button(m, 'Save changes').props.onClick();
  const [cl] = caseEdits(m);
  assert.deepEqual([cl.title, cl.cptCodes, cl.wRvu], ['Evacuation of acute subdural, left convexity', '61312-80', 29.42]);
  assert.match(textOf(m.render()), /Saved\. The case log keeps the description you edited in Case Logs\./);
});

test('hand-edited case log codes survive an RVU code edit; the untouched title and the wRVU follow the entry', async () => {
  const recoded = { ...CASE, cptCodes: '61312, 69990' };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC], caseLogs: [recoded] } });
  openEncounter(m);
  find(m.render(), n => n.type === 'input' && /Add a code/.test(n.props.placeholder || ''), 'code search').props.onChange({ target: { value: '61313' } });
  await settle();
  find(m.render(), n => n.type === 'button' && n.key === '61313', 'result').props.onClick();
  find(m.render(), n => n.type === 'button' && textOf(n) === '×', 'remove code').props.onClick();
  button(m, 'Save changes').props.onClick();
  const [cl] = caseEdits(m);
  assert.deepEqual([cl.cptCodes, cl.wRvu, cl.title], ['61312, 69990', 27.39, 'Craniotomy evac hematoma supratentorial, intracerebral (ICH)']);
  assert.match(textOf(m.render()), /keeps the CPT codes you edited in Case Logs/);
});

test('a case log from Add to case log (no operative code) keeps its edited title too', () => {
  const EM = { id: 'e3', contractId: 'c1', date: '2026-09-12', codes: [{ code: '99223', desc: 'Initial hospital care, high', units: 1, wRVU: 3.5, modifier: '' }], note: '', spokenText: 'admit' };
  const fromEm = { id: 'cl3', date: '2026-09-12', title: 'Bedside EVD, right frontal', category: 'Other', cptCodes: '99223', wRvu: 3.5, facility: 'Synthetic General', source: 'RVU log', customFields: { 'From RVU entry': 'e3' } };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [EM], caseLogs: [fromEm] } });
  find(m.render(), n => n.type === 'div' && n.key === 'e3' && n.props.role === 'button', 'encounter row').props.onClick();
  find(m.render(), n => n.type === 'button' && textOf(n) === '+', 'units +').props.onClick();
  button(m, 'Save changes').props.onClick();
  const [cl] = caseEdits(m);
  assert.deepEqual([cl.title, cl.cptCodes, cl.wRvu], ['Bedside EVD, right frontal', '99223', 7]);
});

// PRAC-013: a surgical encounter whose case log was refused at Save, then
// added with "Add it to my case log anyway", has a case log built from every
// code ("99223, 61312", titled from 99223, wRVU of both). Which list built a
// case log is decided per case log, so a later code edit rewrites it from
// every code too, instead of reporting codes and a title the surgeon never
// edited and dropping 99223's wRVU.
test('a case log added anyway after a refused save follows a code edit from every code', async () => {
  let allowCaseLog = false;
  const m = mount(RVULog, {
    data: { locumContracts: [CONTRACT], encounters: [], caseLogs: [] },
    refuse: (op, key) => op === 'add' && key === 'caseLogs' && !allowCaseLog,
  });
  await addManualCode(m, '99223');
  await addManualCode(m, '61312');
  type(m, 'admit, crani for SDH');
  button(m, 'Save').props.onClick();
  assert.match(textOf(m.render()), /The case log could not be updated just now/);
  allowCaseLog = true;
  button(m, 'Add it to my case log anyway').props.onClick();
  const [added] = m.data.caseLogs;
  const [enc] = m.data.encounters;
  const em = enc.codes.find(c => c.code === '99223');
  assert.equal(added.cptCodes, '99223, 61312');
  assert.equal(added.title, em.desc);

  find(m.render(), n => n.type === 'div' && n.key === enc.id && n.props.role === 'button', 'encounter row').props.onClick();
  find(m.render(), n => n.type === 'input' && /Add a code/.test(n.props.placeholder || ''), 'code search').props.onChange({ target: { value: '61313' } });
  await settle();
  find(m.render(), n => n.type === 'button' && n.key === '61313', 'result').props.onClick();
  // Remove 61312: the second code's × button.
  nodes(m.render()).filter(n => n.type === 'button' && textOf(n) === '×')[1].props.onClick();
  button(m, 'Save changes').props.onClick();
  const [cl] = caseEdits(m);
  assert.equal(cl.cptCodes, '99223, 61313');
  assert.equal(cl.title, em.desc, 'the title still reads the first code');
  assert.equal(cl.wRvu, Math.round((em.wRVU + 27.39) * 100) / 100, 'the 99223 wRVU is kept');
  assert.doesNotMatch(textOf(m.render()), /keeps the/, 'no claim that the surgeon edited anything');
});

test('an encounter refused for an identifier does not carry its refusal to the next encounter opened', () => {
  const ENC2 = { ...ENC, id: 'e2', date: '2026-09-11', note: '' };
  const m = mount(RVULog, { data: { locumContracts: [CONTRACT], encounters: [ENC, ENC2], caseLogs: [CASE] } });
  const refuse = () => {
    nodes(m.render()).filter(n => n.type === 'textarea').at(-1).props.onChange({ target: { value: 'f/u MRN 4455667' } });
    button(m, 'Save changes').props.onClick();
    assert.match(textOf(m.render()), /Not saved: the note contains a medical record number/);
  };
  const row = (id) => find(m.render(), n => n.type === 'div' && n.key === id && n.props.role === 'button', id);
  // Cancel, then another encounter.
  openEncounter(m);
  refuse();
  button(m, 'Cancel').props.onClick();
  row('e2').props.onClick();
  assert.doesNotMatch(textOf(m.render()), /Not saved/);
  // Closing the sheet, then the same one again, by keyboard.
  find(m.render(), n => n.props?.title === 'Encounter', 'encounter sheet').props.onClose();
  openEncounter(m);
  refuse();
  find(m.render(), n => n.props?.title === 'Encounter', 'encounter sheet').props.onClose();
  row('e1').props.onKeyDown({ key: 'Enter' });
  assert.doesNotMatch(textOf(m.render()), /Not saved/);
});
