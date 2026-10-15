import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import * as drafts from '../src/utils/healthRecordDraft.js';
import * as credentialTypes from '../src/constants/credentialTypes.js';
import * as helpers from '../src/utils/helpers.js';
import * as sectionFields from '../src/utils/sectionFields.js';

const memory = () => { const map = new Map(); return { map, getItem: key => map.get(key) ?? null, setItem: (key, v) => map.set(key, v), removeItem: key => map.delete(key) }; };
function lab() {
  const storage = memory(), calls = [];
  let active = 'actor-A', fence = null, full = false, now = 1000;
  const target = { getItem: storage.getItem, removeItem: storage.removeItem, setItem(key, value) { if (full) throw Error('quota'); storage.setItem(key, value); } };
  const factory = opts => drafts.createHealthRecordDraft({ ...opts, storage: () => target, isCurrent: () => active === opts.accountId, fence: () => fence, now: () => now });
  const app = { user: { id: active }, userIdRef: { current: 'profile-A' }, data: { healthRecords: [], documents: [], settings: {}, followUps: [] }, theme: {}, addItem: (...args) => { calls.push(args); return app.refuse ? false : true; }, editItem: (...args) => { calls.push(args); return true; }, deleteItem() {}, toggleFavorite() {}, navigate() {} };
  const mount = () => mountComponent(process.env.HEALTH_FORM_SOURCE || 'src/components/features/HealthRecordsSection.jsx', { app, modules: { credentialTypes, helpers, sectionFields, healthRecordDraft: { createHealthRecordDraft: factory } } });
  const switchAccount = id => { active = id; app.user = { id }; app.userIdRef.current = `profile-${id}`; };
  return { storage, app, calls, factory, mount, switchAccount, setFull: value => { full = value; }, setFence: value => { fence = value; }, setNow: value => { now = value; } };
}
const button = (ui, label) => ui.nodes().find(n => n.type === 'button' && ui.text(n).trim() === label);
const modal = ui => ui.nodes().find(n => n.type?.name === 'Modal' && /Health Record/.test(n.props.title));
const field = (ui, label) => ui.nodes(ui.nodes().find(n => n.type?.name === 'Field' && n.props.label === label)).find(n => ['input', 'select', 'textarea'].includes(n.type));
const type = (ui, label, value) => { field(ui, label).props.onChange({ target: { value } }); ui.render(); };
const add = ui => { button(ui, 'Add').props.onClick(); ui.render(); };

test('half-typed health form and attachments survive a remount without becoming a saved record', async () => {
  const h = lab(), first = await h.mount(); add(first);
  type(first, 'Display Name', 'Synthetic titer draft'); type(first, 'Administrator / Facility', 'Synthetic lab');
  const files = [{ name: 'synthetic.pdf', type: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0=', size: 5 }];
  first.nodes().find(n => n.type?.name === 'DocAttach').props.setAttachedDocs(files);
  first.unmount();
  const resumed = await h.mount();
  assert.equal(modal(resumed).props.open, true);
  assert.equal(field(resumed, 'Display Name').props.value, 'Synthetic titer draft');
  assert.equal(field(resumed, 'Administrator / Facility').props.value, 'Synthetic lab');
  assert.deepEqual(resumed.nodes().find(n => n.type?.name === 'DocAttach').props.attachedDocs, files);
  assert.equal(h.calls.length, 0);
});

test('cancel clears a draft; a refused save keeps it; a successful save clears it', async () => {
  const h = lab(); let ui = await h.mount(); add(ui); type(ui, 'Display Name', 'Discard me');
  modal(ui).props.onClose(); ui.unmount(); ui = await h.mount(); assert.equal(modal(ui).props.open, false);
  add(ui); type(ui, 'Category', 'Vaccination'); type(ui, 'Display Name', 'Save me'); h.app.refuse = true;
  const save = ui.nodes().filter(n => n.type === 'button' && ['Add', 'Save'].includes(ui.text(n).trim())).at(-1); save.props.onClick(); ui.unmount();
  ui = await h.mount(); assert.equal(modal(ui).props.open, true); assert.equal(field(ui, 'Display Name').props.value, 'Save me');
  h.app.refuse = false; ui.nodes().filter(n => n.type === 'button' && ['Add', 'Save'].includes(ui.text(n).trim())).at(-1).props.onClick(); ui.unmount();
  ui = await h.mount(); assert.equal(modal(ui).props.open, false);
});

test('another account never reads the draft and stale A-to-B-to-A handlers cannot overwrite it', async () => {
  const h = lab(), ui = await h.mount(); add(ui); type(ui, 'Display Name', 'A private draft');
  const old = field(ui, 'Display Name').props.onChange;
  h.switchAccount('actor-B'); ui.render(); assert.equal(modal(ui).props.open, false); assert.equal(field(ui, 'Display Name').props.value, '');
  add(ui); type(ui, 'Display Name', 'B private draft');
  old({ target: { value: 'stale A' } }); ui.render(); assert.equal(field(ui, 'Display Name').props.value, 'B private draft');
  h.switchAccount('actor-A'); ui.render(); assert.equal(field(ui, 'Display Name').props.value, 'A private draft');
  old({ target: { value: 'late old A' } }); ui.render(); assert.equal(field(ui, 'Display Name').props.value, 'A private draft');
});

test('unavailable storage warns while preserving current input', async () => {
  const h = lab(), ui = await h.mount(); add(ui); h.setFull(true); type(ui, 'Display Name', 'Keep visible');
  assert.equal(field(ui, 'Display Name').props.value, 'Keep visible');
  assert.match(ui.pageText(), /draft could not be kept on this device/);
  assert.equal(h.factory({ accountId: 'actor-A' }).read(), null);
});

test('drafts expire and a changed account fence refuses both reads and old writes', () => {
  const h = lab(), store = h.factory({ accountId: 'actor-A' });
  const value = { form: { name: 'Private' }, attachedDocs: [], editId: null };
  assert.equal(store.save(value), true); h.setNow(1000 + drafts.HEALTH_DRAFT_TTL); assert.equal(store.read(), null);
  h.setNow(2000); assert.equal(store.save(value), true); h.setFence('purged');
  assert.equal(store.save(value), false); assert.equal(h.factory({ accountId: 'actor-A' }).read(), null);
});

test('explicit purge removes the draft and prevents held same-account writers from restoring it', () => {
  const h = lab(), store = h.factory({ accountId: 'actor-A' });
  const value = { form: { name: 'Private' }, attachedDocs: [] };
  assert.equal(store.save(value), true); drafts.clearHealthRecordDraft('actor-A', () => h.storage);
  assert.equal(h.storage.map.size, 0); assert.equal(store.save(value), false);
  assert.equal(h.factory({ accountId: 'actor-A' }).read(), null);
});

test('a draft editing a deleted record cannot reopen as an add', async () => {
  const h = lab(); h.factory({ accountId: 'actor-A' }).save({ form: { name: 'Old record' }, attachedDocs: [], editId: 'removed' });
  const ui = await h.mount(); assert.equal(modal(ui).props.open, false); assert.equal(h.calls.length, 0);
});

test('real account purges keep drafts on session expiry and clear them on sign-out or data deletion', async () => {
  const { purgeUserStorage, purgeForSignOut } = await import('../src/utils/storageScope.js');
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  const session = memory(), local = memory();
  globalThis.window = { sessionStorage: session }; globalThis.localStorage = local;
  try {
    for (const accountId of ['purge-A', 'purge-B']) drafts.createHealthRecordDraft({ accountId, storage: () => session, isCurrent: () => true }).save({ form: { name: accountId }, attachedDocs: [] });
    await purgeUserStorage('purge-A', { keepVault: true }); assert.ok(session.getItem(`${drafts.HEALTH_DRAFT_BASE}:purge-A`));
    await purgeForSignOut('purge-A'); assert.equal(session.getItem(`${drafts.HEALTH_DRAFT_BASE}:purge-A`), null); assert.ok(session.getItem(`${drafts.HEALTH_DRAFT_BASE}:purge-B`));
    await purgeUserStorage('purge-B', { keepVault: true, retireRecovery: true }); assert.equal(session.map.size, 0);
  } finally { globalThis.window = oldWindow; globalThis.localStorage = oldStorage; }
});
