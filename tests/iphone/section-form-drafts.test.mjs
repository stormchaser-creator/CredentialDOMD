// CRED-021 (QA lab, 2026-10-02, release/goal2 and the build before it, in
// WebKit as the installed iPhone app and in Chromium): Credentials > Health
// Records > Add, Display Name and Administrator / Facility typed, a trip to
// Mail, and iOS discarded the page: on return no form was open and nothing
// typed was kept, though links-iphone (2fa6db0d) said Credentials drafts were
// kept. They were, in CrudSection; Health Records, Screenings and CME have
// forms of their own and kept nothing. "Discarded" here is a new mount over
// the same device storage, as the lab models it (a reload while hidden).
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreens, mount, nodes, textOf } from '../harness/component-harness.mjs';

const screens = await loadScreens(
  'export {default as HealthRecordsSection} from "./src/components/features/HealthRecordsSection.jsx"; export {default as ScreeningsSection} from "./src/components/features/ScreeningsSection.jsx"; export {default as CMESection} from "./src/components/features/CMESection.jsx";',
);
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, querySelector: () => null, activeElement: null, body: { style: {} } };

const settle = (m) => { m.render(); m.render(); return m.render(); };
// The first draft a page opens waits for this page's id to be its own
// (formDrafts formDraftTabReady): the form opens a moment after the mount.
const until = async (m, found) => {
  for (let i = 0; i < 100; i += 1) {
    const tree = settle(m);
    if (found(tree)) return tree;
    await new Promise((r) => setTimeout(r, 10));
  }
  return settle(m);
};
// A screen opened by a link tells its owner, who clears the link.
const linkProps = (key, id) => { const props = { [key]: id }; props[key === 'autoEditId' ? 'onAutoEditDone' : 'onAutoViewDone'] = () => { props[key] = null; }; return props; };
// CME reads the states the account tracks, and listens on the window.
const withStates = (m) => {
  Object.assign(globalThis.__screen.app, { allTrackedStates: [] });
  Object.assign(globalThis.window, { addEventListener() {}, removeEventListener() {} });
  return m;
};
const formModal = (tree, title) => nodes(tree).find((n) => typeof n.type === 'function' && n.props?.open === true && n.props?.title === title);
const inputBy = (tree, placeholder) => nodes(tree).find((n) => (n.type === 'input' || n.type === 'textarea') && n.props?.placeholder === placeholder);
const type = (m, placeholder, value) => { inputBy(settle(m), placeholder).props.onChange({ target: { value } }); settle(m); };
const tap = (m, label) => {
  const b = nodes(settle(m)).find((n) => n.type === 'button' && textOf(n).trim() === label);
  assert.ok(b, `no "${label}" button`);
  b.props.onClick({ stopPropagation() {} });
  return settle(m);
};
const NAME = 'e.g. Annual Flu Shot 2024';
const FACILITY = 'e.g. Employee Health, Hospital Name';
const data = (more = {}) => ({ settings: {}, documents: [], healthRecords: [], screenings: [], cme: [], followUps: [], ...more });

test('CRED-021: a health record half typed, then iOS discards the app: the Add form opens again with what was typed', async () => {
  const first = mount(screens.HealthRecordsSection, { data: data() });
  tap(first, 'Add');
  type(first, NAME, 'QA iPhone Hep B Titer typed');
  type(first, FACILITY, 'QA Lab Typed');
  assert.ok(Object.keys(first.storage.formDrafts || {}).some((slot) => slot.startsWith('crud:healthRecords|add|')), 'kept as it is typed');

  const again = mount(screens.HealthRecordsSection, { data: data(), storage: first.storage });
  const tree = await until(again, (t) => formModal(t, 'Add Health Record'));
  assert.ok(formModal(tree, 'Add Health Record'), 'the Add form is open again');
  assert.equal(inputBy(tree, NAME)?.props.value, 'QA iPhone Hep B Titer typed');
  assert.equal(inputBy(tree, FACILITY)?.props.value, 'QA Lab Typed');
  assert.ok(nodes(tree).some((n) => n.props?.role === 'status' && /Restored what you were typing before the app closed/.test(textOf(n))), 'and says why');

  // Cancel drops it: the next visit opens on the list.
  tap(again, 'Cancel');
  const third = mount(screens.HealthRecordsSection, { data: data(), storage: again.storage });
  assert.equal(formModal(settle(third), 'Add Health Record'), undefined);
});

test('CRED-021: an edit half typed comes back on its own record, laid over the record as it is now', async () => {
  const record = { id: 'hr-1', category: 'Titer', name: 'QA Hep B titer', facility: 'QA Clinic', lotNumber: 'L-1' };
  const first = mount(screens.HealthRecordsSection, { data: data({ healthRecords: [record] }), props: linkProps('autoEditId', 'hr-1') });
  assert.ok(formModal(settle(first), 'Edit Health Record'));
  type(first, FACILITY, 'QA Clinic typed');
  // Meanwhile the desk changed another field of the same record.
  const now = { ...record, lotNumber: 'L-2 from the desk' };
  const again = mount(screens.HealthRecordsSection, { data: data({ healthRecords: [now] }), storage: first.storage });
  const tree = await until(again, (t) => formModal(t, 'Edit Health Record'));
  assert.ok(formModal(tree, 'Edit Health Record'), 'the Edit form is open again');
  assert.equal(inputBy(tree, FACILITY)?.props.value, 'QA Clinic typed', 'what he typed');
  const lot = nodes(tree).find((n) => n.type === 'input' && n.props?.value === 'L-2 from the desk');
  assert.ok(lot, 'and the desk\'s change to another field stands');
});

test('opened by a link to one record, the section restores nothing; the draft waits for a plain visit', async () => {
  const record = { id: 'hr-1', category: 'Titer', name: 'QA Hep B titer' };
  const first = mount(screens.HealthRecordsSection, { data: data({ healthRecords: [record] }) });
  tap(first, 'Add');
  type(first, NAME, 'QA typed before a link');
  const linked = mount(screens.HealthRecordsSection, { data: data({ healthRecords: [record] }), storage: first.storage, props: linkProps('autoViewId', 'hr-1') });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(formModal(settle(linked), 'Add Health Record'), undefined);
  const plain = mount(screens.HealthRecordsSection, { data: data({ healthRecords: [record] }), storage: first.storage });
  assert.equal(inputBy(await until(plain, (t) => inputBy(t, NAME)), NAME)?.props.value, 'QA typed before a link');
});

test('CRED-037: a screening half typed opens again after a discard', async () => {
  const first = mount(screens.ScreeningsSection, { data: data() });
  tap(first, 'Add');
  const tree = settle(first);
  const agency = nodes(tree).find((n) => n.type === 'input' && /agency/i.test(`${n.props?.placeholder || ''} ${n.props?.['aria-label'] || ''}`));
  assert.ok(agency, 'the agency field');
  agency.props.onChange({ target: { value: 'QA Screening Co typed' } });
  settle(first);
  const again = mount(screens.ScreeningsSection, { data: data(), storage: first.storage });
  const back = await until(again, (t) => formModal(t, 'Add Screening'));
  assert.ok(formModal(back, 'Add Screening'), 'the Add form is open again');
  assert.ok(nodes(back).some((n) => n.type === 'input' && n.props?.value === 'QA Screening Co typed'));
});

test('CRED-009: a CME entry half typed opens again after a discard', async () => {
  const props = { autoOpen: true };
  props.onAutoOpenDone = () => { props.autoOpen = false; };
  const first = withStates(mount(screens.CMESection, { data: data(), props }));
  const title = 'e.g. Annual Pain Management Conference';
  assert.ok(formModal(settle(first), 'Add CME'));
  type(first, title, 'QA iPhone Spine Update typed');
  const again = withStates(mount(screens.CMESection, { data: data(), storage: first.storage }));
  const back = await until(again, (t) => formModal(t, 'Add CME'));
  assert.ok(formModal(back, 'Add CME'), 'the Add form is open again');
  assert.equal(inputBy(back, title)?.props.value, 'QA iPhone Spine Update typed');
});

// Review of release/goal2 (2026-10-02): the draft was saved as soon as a form
// was open. CME has no details view, so reading an entry opens its Edit form;
// read and left (iOS discarding the app, or a reload), it came back as an
// edit saying "Restored what you were typing" when nothing was. Untouched Add
// forms did the same: { topics: [] }, { components: [] }, { category: "" }.
const cmeRecord = { id: 'cme-1', title: 'QA Synthetic Grand Rounds', category: 'AMA PRA Category 1', hours: '2', date: '2026-08-01' };
test('a CME entry opened only to read it is not opened again after a discard', async () => {
  const first = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), props: linkProps('autoViewId', 'cme-1') }));
  assert.ok(formModal(settle(first), 'Edit CME'), 'reading an entry opens its Edit form');
  assert.equal(Object.keys(first.storage.formDrafts || {}).filter((s) => s.startsWith('crud:cme|')).length, 0, 'nothing typed, nothing kept');
  const again = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), storage: first.storage }));
  await new Promise((r) => setTimeout(r, 50));
  const tree = settle(again);
  assert.equal(formModal(tree, 'Edit CME'), undefined);
  assert.equal(nodes(tree).some((n) => /Restored what you were typing/.test(textOf(n))), false);
});

test('an Add form opened and left untouched is not opened again (Health Records, Screenings, CME)', async () => {
  for (const [screen, title, extra] of [['HealthRecordsSection', 'Add Health Record'], ['ScreeningsSection', 'Add Screening'], ['CMESection', 'Add CME', true]]) {
    const wrap = extra ? withStates : (m) => m;
    const first = wrap(mount(screens[screen], { data: data() }));
    tap(first, 'Add');
    assert.ok(formModal(settle(first), title));
    const again = wrap(mount(screens[screen], { data: data(), storage: first.storage }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(formModal(settle(again), title), undefined, `${screen}: not opened again`);
  }
});

test('must pass: an edit typed in then read again keeps its draft, and a restored draft survives a second discard', async () => {
  const first = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), props: linkProps('autoViewId', 'cme-1') }));
  settle(first);
  type(first, 'e.g. Annual Pain Management Conference', 'QA Synthetic Grand Rounds typed');
  const again = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), storage: first.storage }));
  const back = await until(again, (t) => formModal(t, 'Edit CME'));
  assert.equal(inputBy(back, 'e.g. Annual Pain Management Conference')?.props.value, 'QA Synthetic Grand Rounds typed');
  // Discarded again before saving: still there.
  const third = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), storage: again.storage }));
  const still = await until(third, (t) => formModal(t, 'Edit CME'));
  assert.equal(inputBy(still, 'e.g. Annual Pain Management Conference')?.props.value, 'QA Synthetic Grand Rounds typed');
  // Typed back to what the record says: nothing left to keep.
  const fourth = withStates(mount(screens.CMESection, { data: data({ cme: [cmeRecord] }), props: linkProps('autoViewId', 'cme-1') }));
  settle(fourth);
  type(fourth, 'e.g. Annual Pain Management Conference', 'QA Synthetic Grand Rounds x');
  assert.equal(Object.keys(fourth.storage.formDrafts || {}).filter((s) => s.startsWith('crud:cme|cme-1|')).length, 1, 'kept while it differs');
  type(fourth, 'e.g. Annual Pain Management Conference', 'QA Synthetic Grand Rounds');
  assert.equal(Object.keys(fourth.storage.formDrafts || {}).filter((s) => s.startsWith('crud:cme|cme-1|')).length, 0);
});
