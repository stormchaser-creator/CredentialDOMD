// A CME record Vera files with topics as text must not crash the app
// (VERA-004, VERA-002). splitFields passed every jsonb field through as the
// model wrote it, so "add 2 hours of Pain Management CME" stored
// cme.topics = "Pain Management", a string, and (c.topics || []).some(...)
// in computeCompliance threw on every launch for a DEA holder (the root
// ErrorBoundary, again after each reload, since the row is in the offline copy
// and the cloud). The CME screen threw on item.topics.map for everyone else.
// Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFields, SECTION_FIELDS, JSON_FIELDS } from '../src/utils/sectionFields.js';
import { computeCompliance, cmeTopics } from '../src/utils/compliance.js';
import { mountComponent, settle } from './component-harness.mjs';

const day = (n) => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('CME topics written as text are stored as a list of topics', () => {
  const { clean, extra } = splitFields('cme', { title: 'Synthetic opioid course', hours: 2, date: '2026-08-01', topics: 'Pain Management, Opioid Prescribing' });
  assert.deepEqual(clean.topics, ['Pain Management', 'Opioid Prescribing']);
  assert.equal(extra, null);
  assert.deepEqual(splitFields('cme', { topics: 'Pain Management' }).clean.topics, ['Pain Management']);
  assert.deepEqual(splitFields('cme', { topics: ['Ethics', 7, ' '] }).clean.topics, ['Ethics'], 'only words stay in the list');
});

test('a screening component list or a contract period list that is not a list goes to custom fields', () => {
  const s = splitFields('screenings', { name: 'Synthetic screen', components: 'drug screen, background' });
  assert.equal(s.clean.components, undefined);
  assert.deepEqual(s.extra, { Components: 'drug screen, background' });
  const c = splitFields('locumContracts', { facility: 'Synthetic Hospital', coveragePeriods: 'Jan 5 to Jan 12', callRateGrid: { weekday: 1 } });
  assert.equal(c.clean.coveragePeriods, undefined);
  assert.equal(c.clean.callRateGrid, undefined);
  assert.deepEqual(c.extra, { 'Coverage Periods': 'Jan 5 to Jan 12', 'Call Rate Grid': '{"weekday":1}' });
  const periods = [{ start: '2026-01-05', end: '2026-01-12' }];
  assert.deepEqual(splitFields('locumContracts', { facility: 'Synthetic Hospital', coveragePeriods: periods }).clean.coveragePeriods, periods);
});

test('every jsonb field typed here is a field Vera may write', () => {
  for (const [section, keys] of Object.entries(JSON_FIELDS)) {
    for (const k of Object.keys(keys)) assert.ok(SECTION_FIELDS[section].includes(k), `${section}.${k}`);
  }
});

test('a CME row already saved with topics as text does not crash compliance, and still counts', () => {
  const rows = [{ id: 'a', date: day(30), hours: 8, category: 'AMA PRA Category 1', topics: 'Opioid Prescribing' }];
  let c;
  assert.doesNotThrow(() => { c = computeCompliance(rows, 'TX', 'MD', { hasDEA: true }); });
  assert.equal(c.mate.earned, 8);
  assert.deepEqual(cmeTopics({ topics: 'Ethics; Pain Management' }), ['Ethics', 'Pain Management']);
  assert.deepEqual(cmeTopics({ topics: { x: 1 } }), []);
});

test('the CME screen opens with a row saved with topics as text', async () => {
  const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
  const app = {
    data: { settings: { degreeType: 'MD' }, cme: [{ id: 'cme-1', title: 'Synthetic course', date: day(10), hours: 2, category: 'AMA PRA Category 1', topics: 'Pain Management' }], documents: [], licenses: [] },
    addItem: () => true, editItem: () => true, deleteItem() {}, theme: {}, allTrackedStates: [], navigate() {}, isDesktop: false, toggleFavorite() {},
  };
  const c = await mountComponent('src/components/features/CMESection.jsx', { app, props: { onShare() {} }, modules: {
    useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
    forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
    credentialTypes: await import(src('constants/credentialTypes.js')),
    cmeTopics: await import(src('constants/cmeTopics.js')),
    stateRequirements: await import(src('constants/stateRequirements.js')),
    boardRequirements: await import(src('constants/boardRequirements.js')),
    states: await import(src('constants/states.js')),
    useInputStyle: { useInputStyle: () => ({}) },
  } });
  await settle();
  c.render();
  const chips = c.nodes().filter(n => n.type === 'span' && c.text(n) === 'Pain Management');
  assert.ok(chips.length >= 1, 'the topic shows as a chip');
});
