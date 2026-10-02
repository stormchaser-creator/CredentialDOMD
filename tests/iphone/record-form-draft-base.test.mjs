// Review of 9484782c: the record form's draft (CrudSection, utils/formDrafts.js)
// and its save, with the installed iPhone app and desktop Chrome open on one
// account at once. Synthetic records only.
//  - A restored edit draft put back every field as it was when the form
//    opened, and a form kept open across the resume reload did the same on
//    Save: the desk's newer changes were overwritten without a word.
//  - Opening a record from search, Vera or Home (autoViewId) also opened a
//    saved draft form he did not choose; an Edit opened from there wrote over
//    another record's draft.
//  - A screen that first mounted on empty fallback records (weak signal, the
//    device copy unreadable) deleted an edit draft for good.
//  - A second desktop tab opened the first tab's unsaved Add form as
//    "restored", and its Cancel cleared the draft the first tab was typing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../../src/utils/spreadsheetGuard.js';
import * as inboxDocs from '../../src/utils/inboxDocs.js';
import { mountComponent } from '../component-harness.mjs';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.localStorage = new MemoryStorage();
const storageScope = await import('../../src/utils/storageScope.js');
storageScope.setActiveUserId('user_synthetic');
const formDrafts = await import('../../src/utils/formDrafts.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

const FIELDS = [{ key: 'name', label: 'Display Name' }, { key: 'expirationDate', label: 'Expiration', type: 'date' }, { key: 'notes', label: 'Notes' }];
async function licenses({ items = [], autoEditId = null, autoOpen = false, autoViewId = null, loadedFrom = 'cloud', unread = false, drafts = formDrafts, data: more = {} } = {}) {
  const edits = [];
  const app = { data: { settings: {}, documents: [], followUps: [], ...more }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: false, loadedFrom,
    addItem() { return true; }, editItem() { return true; }, deleteItem() { return true; }, setData() {}, toggleFavorite() {}, navigate() {} };
  const ui = await mountComponent('src/components/features/CrudSection.jsx', {
    app,
    props: { title: 'Licenses', sectionKey: 'licenses', items, fields: FIELDS, autoOpen, onAutoOpenDone() {}, autoEditId, onAutoEditDone() {}, autoViewId, onAutoViewDone() {},
      onEdit: item => { edits.push(item); return true; }, onAdd: () => true },
    modules: { caseBilling: { billedCodes: () => [] }, formDrafts: drafts, storageScope: { offlineCopyUnread: () => unread }, spreadsheetGuard: guard, inboxDocs, lifecycle: await import('../../src/utils/lifecycle.js'), formLayout: await import('../../src/utils/formLayout.js'), docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) }, helpers: await import('../../src/utils/helpers.js'), credentialTypes: await import('../../src/constants/credentialTypes.js'), storageQuota: { checkStorageQuota: () => ({ ok: true }) }, officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' }, aiClient: { useAiAvailable: () => false, describeAiStatus: () => '', aiAvailable: () => false } },
  });
  ui.render();
  return Object.assign(ui, { app, edits });
}
const input = (ui, key) => ui.nodes().find(n => (n.type === 'input' || n.type === 'textarea') && n.props['data-fkey'] === key);
const openModals = (ui) => ui.nodes().filter(n => typeof n.type === 'function' && n.props?.open === true && JSON.stringify(Object.keys(n.props)).includes('onClose')).map(n => n.props.title);
const formOpen = (ui) => openModals(ui).some(t => /^(Add|Edit)/.test(String(t)));
const type = (ui, key, value) => { input(ui, key).props.onChange({ target: { value } }); ui.render(); };
const button = (ui, label) => ui.nodes().filter(n => n.type === 'button' && ui.text(n).trim() === label).at(-1);
const reset = () => globalThis.localStorage.map.clear();

const v1 = { id: 'lic-1', name: 'QA original name', expirationDate: '2026-12-31', notes: '', favorite: false, updatedAt: '2026-09-01T00:00:00.000Z' };
const v2 = { ...v1, name: 'QA desk name', expirationDate: '2028-06-30', favorite: true, updatedAt: '2026-10-01T11:00:00.000Z' };

test('a restored edit draft lays only what he typed over the record as it is now, and Save keeps the desk\'s changes', async () => {
  reset();
  const first = await licenses({ items: [v1], autoEditId: 'lic-1' });
  type(first, 'notes', 'renewal filed');
  // iOS discards the app; the desk renames, renews and stars it; he reopens.
  const again = await licenses({ items: [v2] });
  assert.ok(formOpen(again));
  assert.equal(input(again, 'name')?.props.value, 'QA desk name', 'the desk name, not the one from before');
  assert.equal(input(again, 'expirationDate')?.props.value, '2028-06-30');
  assert.equal(input(again, 'notes')?.props.value, 'renewal filed', 'what he typed is back');
  button(again, 'Save').props.onClick();
  again.render();
  const [saved] = again.edits;
  assert.equal(saved.name, 'QA desk name');
  assert.equal(saved.expirationDate, '2028-06-30');
  assert.equal(saved.favorite, true);
  assert.equal(saved.notes, 'renewal filed');
});

test('a form kept open across the resume reload saves the record as it is now with what he changed', async () => {
  reset();
  const ui = await licenses({ items: [v1], autoEditId: 'lic-1' });
  ui.setProps({ items: [v2], autoEditId: null }); // the quiet reload brings the desk's copy
  assert.equal(input(ui, 'name')?.props.value, 'QA original name', 'the open form is left as it was');
  type(ui, 'notes', 'renewal filed');
  button(ui, 'Save').props.onClick();
  ui.render();
  const [saved] = ui.edits;
  assert.equal(saved.name, 'QA desk name', 'the desk rename stands');
  assert.equal(saved.expirationDate, '2028-06-30');
  assert.equal(saved.favorite, true);
  assert.equal(saved.notes, 'renewal filed');
  // A field he did change still goes up as he typed it.
  const other = await licenses({ items: [v1], autoEditId: 'lic-1' });
  other.setProps({ items: [v2], autoEditId: null });
  type(other, 'name', 'QA phone name');
  button(other, 'Save').props.onClick();
  assert.equal(other.edits[0].name, 'QA phone name');
});

test('a link to one record\'s details opens only the details; the draft waits, and an Edit from there keeps the other record\'s draft', async () => {
  reset();
  const a = { ...v1, id: 'lic-A', name: 'QA License A' };
  const b = { ...v1, id: 'lic-B', name: 'QA License B' };
  const first = await licenses({ items: [a, b], autoEditId: 'lic-A' });
  type(first, 'notes', 'A typed');
  const viewing = await licenses({ items: [a, b], autoViewId: 'lic-B' });
  assert.deepEqual(openModals(viewing).filter(t => /^(Add|Edit)/.test(String(t))), [], 'no draft form over the details');
  // He edits B from there (a link to edit it), types, and cancels.
  const editB = await licenses({ items: [a, b], autoEditId: 'lic-B' });
  type(editB, 'notes', 'B typed');
  const plain = await licenses({ items: [a, b] });
  assert.equal(input(plain, 'notes')?.props.value, 'B typed', 'the newest draft opens first');
  button(plain, 'Cancel').props.onClick();
  plain.render();
  const next = await licenses({ items: [a, b] });
  assert.ok(formOpen(next));
  assert.equal(input(next, 'notes')?.props.value, 'A typed', 'A\'s draft was never written over');
  assert.equal(input(next, 'name')?.props.value, 'QA License A');
});

test('an edit draft is not deleted on empty fallback records, and opens once his records arrive', async () => {
  reset();
  const first = await licenses({ items: [v1], autoEditId: 'lic-1' });
  type(first, 'notes', 'renewal filed');
  // Relaunch on a weak signal: the device copy could not be read, the screen
  // holds empty defaults.
  const ui = await licenses({ items: [], loadedFrom: 'local', unread: true, data: { licenses: [] } });
  assert.equal(formOpen(ui), false);
  assert.equal(formDrafts.listFormDrafts('crud:licenses|').length, 1, 'the draft is kept');
  // The account's records land.
  ui.app.loadedFrom = 'cloud';
  ui.app.data = { ...ui.app.data, licenses: [v1] };
  ui.setProps({ items: [v1] });
  assert.ok(formOpen(ui), 'the draft opens on its record');
  assert.equal(input(ui, 'notes')?.props.value, 'renewal filed');
  // Must-pass: a record read for real as gone still drops its draft.
  reset();
  const again = await licenses({ items: [v1], autoEditId: 'lic-1' });
  type(again, 'notes', 'x');
  await licenses({ items: [], loadedFrom: 'cloud', data: { licenses: [] } });
  assert.equal(formDrafts.listFormDrafts('crud:licenses|').length, 0);
});

test('a second desktop tab never opens the first tab\'s open Add form, nor clears it; a draft from a page that is gone still opens', async () => {
  reset();
  const tabB = await import('../../src/utils/formDrafts.js?second-tab');
  const tabA = await licenses({ autoOpen: true });
  type(tabA, 'name', 'QA typed in tab A');
  const inB = await licenses({ drafts: tabB });
  await wait(400); // the ping to the page that wrote it
  inB.render();
  assert.equal(formOpen(inB), false, 'tab A answers: its form is not opened here');
  // Tab B's own Add, cancelled, leaves tab A's draft.
  const addB = await licenses({ autoOpen: true, drafts: tabB });
  type(addB, 'name', 'QA typed in tab B');
  button(addB, 'Cancel').props.onClick();
  addB.render();
  assert.deepEqual(formDrafts.listFormDrafts('crud:licenses|').map(d => d.value.form.name), ['QA typed in tab A']);
  // A draft from a page nobody answers for (iOS discarded it): opened.
  reset();
  formDrafts.saveFormDraft('crud:licenses|add|page-gone', { editId: null, base: null, form: { name: 'QA from a discarded page' } });
  const relaunch = await licenses({ drafts: tabB });
  await wait(400);
  relaunch.render();
  assert.ok(formOpen(relaunch));
  assert.equal(input(relaunch, 'name')?.props.value, 'QA from a discarded page');
});
