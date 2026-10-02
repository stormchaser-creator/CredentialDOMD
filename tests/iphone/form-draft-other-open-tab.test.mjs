// Review of 5cb89c90: which page wrote a record form's draft (utils/formDrafts.js
// formDraftTab) was told only by an id in sessionStorage and a 250 ms
// BroadcastChannel ping. Desktop Chrome's Duplicate Tab copies sessionStorage,
// so the duplicate took the first tab's open Add form for its own and opened it
// as "restored"; a background tab Chrome froze could not answer the ping, so
// its open form was opened in the other tab too. Saving in both made two
// licenses. Each "tab" here is its own module instance over one origin's
// localStorage and Web Locks. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../../src/utils/spreadsheetGuard.js';
import * as inboxDocs from '../../src/utils/inboxDocs.js';
import { mountComponent } from '../component-harness.mjs';

class MemoryStorage {
  constructor(from = null) { this.map = new Map(from ? from.map : []); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.localStorage = new MemoryStorage();
const storageScope = await import('../../src/utils/storageScope.js');
storageScope.setActiveUserId('user_synthetic');
const wait = ms => new Promise(r => setTimeout(r, ms));

const FIELDS = [{ key: 'name', label: 'Display Name' }, { key: 'expirationDate', label: 'Expiration', type: 'date' }, { key: 'notes', label: 'Notes' }];
async function licenses({ drafts, autoOpen = false } = {}) {
  const app = { data: { settings: {}, documents: [], followUps: [] }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: true, loadedFrom: 'cloud',
    addItem() { return true; }, editItem() { return true; }, deleteItem() { return true; }, setData() {}, toggleFavorite() {}, navigate() {} };
  const ui = await mountComponent('src/components/features/CrudSection.jsx', {
    app,
    props: { title: 'Licenses', sectionKey: 'licenses', items: [], fields: FIELDS, autoOpen, onAutoOpenDone() {}, autoEditId: null, onAutoEditDone() {}, autoViewId: null, onAutoViewDone() {},
      onEdit: () => true, onAdd: () => true },
    modules: { caseBilling: { billedCodes: () => [] }, formDrafts: drafts, storageScope: { offlineCopyUnread: () => false }, spreadsheetGuard: guard, inboxDocs, lifecycle: await import('../../src/utils/lifecycle.js'), formLayout: await import('../../src/utils/formLayout.js'), docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) }, helpers: await import('../../src/utils/helpers.js'), credentialTypes: await import('../../src/constants/credentialTypes.js'), storageQuota: { checkStorageQuota: () => ({ ok: true }) }, officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' }, aiClient: { useAiAvailable: () => false, describeAiStatus: () => '', aiAvailable: () => false } },
  });
  ui.render();
  return ui;
}
const input = (ui, key) => ui.nodes().find(n => (n.type === 'input' || n.type === 'textarea') && n.props['data-fkey'] === key);
const formOpen = (ui) => ui.nodes().some(n => typeof n.type === 'function' && n.props?.open === true && /^(Add|Edit)/.test(String(n.props.title)) && 'onClose' in n.props);
const type = (ui, key, value) => { input(ui, key).props.onChange({ target: { value } }); ui.render(); };

test('a duplicated tab, which copied the first tab\'s sessionStorage, never opens that tab\'s open Add form as its own', async () => {
  globalThis.localStorage.map.clear();
  const sessionA = new MemoryStorage();
  globalThis.sessionStorage = sessionA;
  const tabA = await import('../../src/utils/formDrafts.js?dup-a');
  const inA = await licenses({ drafts: tabA, autoOpen: true });
  type(inA, 'name', 'QA typed in tab A');
  await wait(20);
  assert.equal(tabA.listFormDrafts('crud:licenses|').length, 1);
  // Duplicate Tab: the new page starts with a copy of A's sessionStorage.
  globalThis.sessionStorage = new MemoryStorage(sessionA);
  const tabB = await import('../../src/utils/formDrafts.js?dup-b');
  const inB = await licenses({ drafts: tabB });
  await wait(400);
  inB.render();
  assert.equal(formOpen(inB), false, 'A\'s open form stays in A');
  assert.notEqual(tabB.formDraftTab(), tabA.formDraftTab(), 'the duplicate takes its own id');
  assert.deepEqual(tabA.listFormDrafts('crud:licenses|').map(d => d.value.form.name), ['QA typed in tab A'], 'and A\'s draft is left');
  // Must-pass: a draft from a page that is gone (iOS discarded it) opens.
  globalThis.localStorage.map.clear();
  tabA.saveFormDraft('crud:licenses|add|page-gone', { editId: null, base: null, form: { name: 'QA from a closed page' } });
  const relaunch = await licenses({ drafts: tabB });
  await wait(400);
  relaunch.render();
  assert.ok(formOpen(relaunch));
  assert.equal(input(relaunch, 'name')?.props.value, 'QA from a closed page');
  delete globalThis.sessionStorage;
});

test('a background tab Chrome froze, which answers nothing, is still open: its Add form is not opened in the other tab', async () => {
  globalThis.localStorage.map.clear();
  const RealChannel = globalThis.BroadcastChannel;
  // A frozen page runs no handlers: its channel never answers.
  globalThis.BroadcastChannel = class { postMessage() {} close() {} };
  let tabA, inA;
  try {
    tabA = await import('../../src/utils/formDrafts.js?frozen-a');
    inA = await licenses({ drafts: tabA, autoOpen: true });
    type(inA, 'name', 'QA typed in the frozen tab');
    await wait(20);
  } finally { globalThis.BroadcastChannel = RealChannel; }
  const tabB = await import('../../src/utils/formDrafts.js?frozen-b');
  const inB = await licenses({ drafts: tabB });
  await wait(400);
  inB.render();
  assert.equal(formOpen(inB), false, 'the frozen tab still holds its form');
  assert.deepEqual(tabA.listFormDrafts('crud:licenses|').map(d => d.value.form.name), ['QA typed in the frozen tab']);
});

test('where there are no Web Locks, a duplicated tab still takes its own id (the ping), and its own answer is not taken for another page\'s', async () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    const session = new MemoryStorage();
    globalThis.sessionStorage = session;
    const tabA = await import('../../src/utils/formDrafts.js?nolocks-a');
    const idA = await tabA.formDraftTabReady();
    assert.equal(idA, tabA.formDraftTab(), 'alone, it keeps its id: its own answer does not count');
    globalThis.sessionStorage = new MemoryStorage(session);
    const tabB = await import('../../src/utils/formDrafts.js?nolocks-b');
    assert.equal(tabB.formDraftTab(), idA, 'the duplicate starts with the copied id');
    const idB = await tabB.formDraftTabReady();
    assert.notEqual(idB, idA, 'A answers for it, so B takes a new one');
    assert.deepEqual([...await tabB.formDraftTabsAlive([idA, 'page-gone'])], [idA]);
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    delete globalThis.sessionStorage;
  }
});
