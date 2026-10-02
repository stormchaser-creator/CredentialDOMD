// IOS-CRED-2 and CRED-021 (QA lab, WebKit as the installed iPhone app, 3
// runs): Credentials > Licenses (or Health Records) > Add, Display Name and
// License # typed, a trip to Mail, and iOS discarded the page: on return no
// form was open and nothing typed was kept. The open form is now kept for the
// account as it is typed (utils/formDrafts.js) and opens again when the
// section next mounts; Cancel or Save drops it; a portal password never goes
// in it. Synthetic records only.
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

const FIELDS = [{ key: 'name', label: 'Display Name' }, { key: 'licenseNumber', label: 'License #' }];
const rec = () => { const calls = []; return { calls, fn: n => (...a) => { calls.push([n, ...a]); return true; } }; };
async function licenses({ items = [], autoOpen = false, autoEditId = null, props: extra = {}, data: more = {} } = {}) {
  const r = rec();
  const ui = await mountComponent('src/components/features/CrudSection.jsx', {
    app: { data: { settings: {}, documents: [], followUps: [], ...more }, theme: {}, user: { id: 'user_synthetic' }, isDesktop: false,
      addItem: r.fn('addItem'), editItem: r.fn('editItem'), deleteItem: r.fn('deleteItem'), setData: r.fn('setData'), toggleFavorite: r.fn('toggleFavorite'), navigate: r.fn('navigate') },
    props: { title: 'Licenses', sectionKey: 'licenses', items, fields: FIELDS, autoOpen, onAutoOpenDone() {}, autoEditId, onAutoEditDone() {}, ...extra },
    modules: { formDrafts, spreadsheetGuard: guard, inboxDocs, lifecycle: await import('../../src/utils/lifecycle.js'), formLayout: await import('../../src/utils/formLayout.js'), docPrefill: { splitScanned: e => ({ placed: e, extras: {}, withheld: [] }) }, helpers: await import('../../src/utils/helpers.js'), credentialTypes: await import('../../src/constants/credentialTypes.js'), storageQuota: { checkStorageQuota: () => ({ ok: true }) }, officeText: { isOfficeFile: () => false, UPLOAD_ACCEPT: '*' }, aiClient: { useAiAvailable: () => false, describeAiStatus: () => '', aiAvailable: () => false } },
  });
  ui.render();
  return ui;
}
const input = (ui, key) => ui.nodes().find(n => (n.type === 'input' || n.type === 'textarea') && n.props['data-fkey'] === key);
// The form is in a Modal; the stand-in renders its children either way, so
// "open" is the Modal's own prop.
const formOpen = (ui) => ui.nodes().some(n => typeof n.type === 'function' && n.props?.open === true && JSON.stringify(Object.keys(n.props)).includes('onClose'));
const type = (ui, key, value) => { input(ui, key).props.onChange({ target: { value } }); ui.render(); };

test('a license half typed, then iOS discards the app: the Add form opens again with what was typed', async () => {
  const first = await licenses({ autoOpen: true });
  type(first, 'name', 'QA iPhone license typed');
  type(first, 'licenseNumber', 'Q-77');
  // A new page over the same device storage.
  const again = await licenses();
  assert.ok(formOpen(again), 'the Add form is open again');
  assert.equal(input(again, 'name')?.props.value, 'QA iPhone license typed', 'with the name');
  assert.equal(input(again, 'licenseNumber')?.props.value, 'Q-77');
  assert.match(again.pageText(), /Restored what you were typing before the app closed/);
  // Cancel drops it: the next visit opens on the list.
  again.nodes().filter(n => n.type === 'button' && again.text(n).trim() === 'Cancel').at(-1).props.onClick();
  again.render();
  const third = await licenses();
  assert.equal(formOpen(third), false, 'no form after Cancel');
});

test('an edit half typed comes back on its own record; a record deleted meanwhile drops it', async () => {
  const lic = { id: 'lic-1', name: 'QA original', licenseNumber: 'Q-1' };
  const first = await licenses({ items: [lic], autoEditId: 'lic-1' });
  assert.ok(formOpen(first));
  type(first, 'licenseNumber', 'Q-2 typed');
  const again = await licenses({ items: [lic] });
  assert.ok(formOpen(again));
  assert.equal(input(again, 'licenseNumber')?.props.value, 'Q-2 typed');
  assert.equal(input(again, 'name')?.props.value, 'QA original', 'on its own record');
  const gone = await licenses({ items: [] });
  assert.equal(formOpen(gone), false, 'the record is gone: nothing to edit');
});

test('a portal password typed into the form is never kept in the draft', async () => {
  const first = await licenses({ autoOpen: true });
  type(first, 'name', 'QA license');
  const stored = JSON.stringify([...globalThis.localStorage.map.values()]);
  assert.match(stored, /QA license/);
  // CrudSection names its secret fields (type "secret": portal passwords) to the draft as never kept.
  assert.deepEqual(Object.keys(formDrafts.draftableValues({ name: 'x', portalPassword: 'y', photo: 'data:image/png;base64,AA', n: 3 }, { secretKeys: ['portalPassword'] })), ['name', 'n']);
});

// Link audit, 2026-10-01: every custom category is its own screen over one
// collection (customRecords), and they shared one draft slot. A Badges add
// opened in Vaccines, prefilled, and Save filed it there; an edit draft was
// deleted the moment another category opened. Case Logs shows one academic
// year, and an edit draft for a case in another year was deleted on mount.
const category = (id) => ({ sectionKey: 'customRecords', draftKey: `customRecords:${id}`, title: id });

test('a custom category draft opens only in its own category', async () => {
  const badges = await licenses({ autoOpen: true, props: category('cat-badges') });
  type(badges, 'name', 'QA badge typed');
  const vaccines = await licenses({ props: category('cat-vaccines') });
  assert.equal(formOpen(vaccines), false, 'Vaccines opens on its list');
  const again = await licenses({ props: category('cat-badges') });
  assert.ok(formOpen(again), 'Badges opens its own draft');
  assert.equal(input(again, 'name')?.props.value, 'QA badge typed');
});

test('an edit draft survives opening another category first', async () => {
  const badge = { id: 'rec-badge', categoryId: 'cat-badges', name: 'QA badge', licenseNumber: 'B-1' };
  const data = { customRecords: [badge] };
  const first = await licenses({ items: [badge], autoEditId: 'rec-badge', props: category('cat-badges'), data });
  type(first, 'licenseNumber', 'B-2 typed');
  const vaccines = await licenses({ items: [], props: category('cat-vaccines'), data });
  assert.equal(formOpen(vaccines), false);
  const again = await licenses({ items: [badge], props: category('cat-badges'), data });
  assert.ok(formOpen(again), 'not deleted by the other category');
  assert.equal(input(again, 'licenseNumber')?.props.value, 'B-2 typed');
});

test('Case Logs: an edit draft for a case outside the year on view opens on that case, and is never deleted for being out of view', async () => {
  const older = { id: 'case-old', name: 'QA older case', licenseNumber: 'C-1' };
  const data = { caseLogs: [older] };
  const props = { sectionKey: 'caseLogs', title: 'Case Logs' };
  const first = await licenses({ items: [older], autoEditId: 'case-old', props, data });
  type(first, 'licenseNumber', 'C-2 typed');
  // The year on view after the relaunch does not include it.
  const again = await licenses({ items: [], props: { ...props, draftItems: [older] }, data });
  assert.ok(formOpen(again), 'opens on the case from the whole collection');
  assert.equal(input(again, 'licenseNumber')?.props.value, 'C-2 typed');
  // A screen that only knows the filtered list leaves the draft alone.
  const filtered = await licenses({ items: [], props, data });
  assert.equal(formOpen(filtered), false);
  const kept = await licenses({ items: [older], props, data });
  assert.ok(formOpen(kept), 'still there');
});

test('each custom category keys its own draft, and Case Logs looks an edit up in every case', async () => {
  const { readFileSync } = await import('node:fs');
  const custom = readFileSync(new URL('../../src/components/features/CustomCategorySection.jsx', import.meta.url), 'utf8');
  assert.match(custom, /sectionKey="customRecords"\s+draftKey=\{`customRecords:\$\{category\.id\}`\}/);
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /sectionKey="caseLogs"[^>]*items=\{shownCases\} draftItems=\{allCases\}/);
});
