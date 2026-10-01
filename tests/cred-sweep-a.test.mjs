// QA sweep, credential screens (CRED-004, CRED-016, CRED-021, CRED-023,
// CRED-024). Real components, synthetic records only, no network: the
// device's localStorage and the cloud are in-memory fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadScreens, mount, nodes, textOf, find, button } from './harness/component-harness.mjs';

const screens = await loadScreens('export { default as CrudSection } from "./src/components/features/CrudSection.jsx"; export { default as CustomCategorySection, NewCategoryPanel } from "./src/components/features/CustomCategorySection.jsx"; export { default as HealthRecordsSection } from "./src/components/features/HealthRecordsSection.jsx";');
const { CrudSection, CustomCategorySection, NewCategoryPanel, HealthRecordsSection } = screens;
const box = await import('../src/utils/secretBox.js');

// One device's localStorage. A fresh one is a second device.
const device = () => {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
  return m;
};
const USER = 'user_syntheticCredA';
const extraApp = { user: { id: USER }, allTrackedStates: [], toggleFavorite() {}, navigate() {}, userIdRef: { current: 'profileA' }, isDesktop: false };
const waitFor = async (cond, what) => {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};
const input = (tree, key) => find(tree, (n) => n.type === 'input' && n.props['data-fkey'] === key, key);
const saveButton = (tree) => nodes(tree).filter((n) => n.type === 'button' && /^(Add|Save|Saving\.\.\.)$/.test(textOf(n).trim())).at(-1);
const headerAdd = (m) => nodes(m.render()).find((n) => n.type === 'button' && textOf(n).trim() === 'Add').props.onClick();

// ── CRED-024: a custom category's number field ──────────────────────────────
const DOSIMETRY = { id: 'C1', name: 'Dosimetry Reports', icon: 'D', fields: [{ key: 'deepDose', label: 'Deep dose', type: 'number' }] };
function category(records = []) {
  const m = mount(CustomCategorySection, { props: { categoryId: 'C1', onShare() {} }, data: { customCategories: [DOSIMETRY], customRecords: records } });
  Object.assign(globalThis.__screen.app, extraApp);
  // The category hands CrudSection its form; drive that form as the member does.
  const crud = find(m.render(), (n) => n.type === CrudSection, 'the category form');
  const form = mount(CrudSection, { props: crud.props, data: m.data });
  Object.assign(globalThis.__screen.app, extraApp);
  return { m, form };
}

test('CRED-024: a decimal in a custom number field saves, and the field takes decimals', () => {
  const { m, form } = category();
  headerAdd(form);
  input(form.render(), 'name').props.onChange({ target: { value: 'Synthetic badge report' } });
  const dose = input(form.render(), 'deepDose');
  assert.notEqual(dose.props.step, '1', 'no whole-number stepper');
  assert.equal(dose.props.inputMode, 'decimal', 'a decimal keypad on a phone');
  dose.props.onChange({ target: { value: '0.25' } });
  saveButton(form.render()).props.onClick();
  assert.doesNotMatch(textOf(form.render()), /whole number/);
  const adds = m.calls.filter((c) => c[0] === 'add' && c[1] === 'customRecords');
  assert.equal(adds.length, 1, 'the record was saved');
  assert.equal(adds[0][2].fieldValues.deepDose, '0.25');
});

test('CRED-024: a scanned "12 mSv" shows in its field and does not block another edit', () => {
  const scanned = { id: 'R1', categoryId: 'C1', categoryName: 'Dosimetry Reports', name: 'Synthetic quarter', fieldValues: { deepDose: '12 mSv' }, fieldLabels: { deepDose: 'Deep dose' } };
  const { m, form } = category([scanned]);
  nodes(form.render()).find((n) => n.type === 'button' && n.props['aria-label'] === 'Edit').props.onClick({ stopPropagation() {} });
  const dose = input(form.render(), 'deepDose');
  assert.equal(dose.props.value, '12 mSv');
  assert.notEqual(dose.props.type, 'number', 'a number input would draw "12 mSv" as an empty box');
  input(form.render(), 'expirationDate').props.onChange({ target: { value: '2027-03-31' } });
  saveButton(form.render()).props.onClick();
  assert.doesNotMatch(textOf(form.render()), /whole number/);
  const edits = m.calls.filter((c) => c[0] === 'edit' && c[1] === 'customRecords');
  assert.equal(edits.length, 1, 'the edit was saved');
  assert.equal(edits[0][2].expirationDate, '2027-03-31');
  assert.equal(edits[0][2].fieldValues.deepDose, '12 mSv');
});

test('CRED-024: only an integer column keeps the whole-number rule (Order on CV)', async () => {
  const app = readFileSync(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /key: "sortOrder", label: "Order on CV", type: "number"/);
  const { FIELD_TYPES } = await import('../src/utils/sectionFields.js');
  assert.equal(FIELD_TYPES.publications.sortOrder, 'integer', 'the CV order is an integer column');
  const saved = [];
  const m = mount(CrudSection, { props: { title: 'Synthetic', sectionKey: 'publications', items: [], onAdd: (x) => { saved.push(x); return true; }, onEdit() {}, onDelete() {},
    fields: [{ key: 'name', label: 'Short Label' }, { key: 'weight', label: 'Weight', type: 'number' }] } });
  Object.assign(globalThis.__screen.app, extraApp);
  headerAdd(m);
  input(m.render(), 'weight').props.onChange({ target: { value: '1.5' } });
  saveButton(m.render()).props.onClick();
  assert.equal(saved.length, 1, 'a plain number field keeps its decimal');
  assert.equal(saved[0].weight, '1.5');
});

// ── CRED-004: saved-password lock code on a second device ───────────────────
const PRIV_FIELDS = [{ key: 'name', label: 'Display Name', required: true }, { key: 'loginSecret', label: 'Portal password', type: 'secret' }];
async function savedOnDeviceA(code = 'abcd') {
  device();
  box.setSecretUser(USER);
  return box.encryptSecret('synthetic-portal-A', code, USER);
}
function privileges(items, props = {}, data = {}) {
  const saved = [];
  const m = mount(CrudSection, { props: { title: 'Privileges', sectionKey: 'privileges', items, fields: PRIV_FIELDS, onShare() {}, onDelete() {}, onEdit: (x) => { saved.push(x); return true; },
    onAdd: (x) => { saved.push(x); return true; }, ...props }, data: { privileges: items, ...data } });
  Object.assign(globalThis.__screen.app, extraApp);
  m.render();
  return { m, saved };
}
const typePassword = (m, password) => {
  headerAdd(m);
  input(m.render(), 'name').props.onChange({ target: { value: 'Synthetic General' } });
  input(m.render(), 'loginSecret').props.onChange({ target: { value: password } });
};
const lockBox = (m) => nodes(m.render()).find((n) => n.type === 'input' && n.props['aria-label'] === 'Lock code');

test('CRED-004: a second device asks for the account\'s lock code and refuses one that does not open the saved passwords', async () => {
  const enc = await savedOnDeviceA('abcd');
  device(); // device B: nothing stored
  const { m, saved } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }]);
  typePassword(m, 'synthetic-portal-B');
  assert.match(textOf(m.render()), /Enter your lock code for saved passwords/);
  assert.doesNotMatch(textOf(m.render()), /Set a lock code/);
  lockBox(m).props.onChange({ target: { value: 'wxyz' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => /did not open your saved passwords/.test(textOf(m.render())), 'the refusal');
  assert.equal(saved.length, 0, 'nothing saved under a code no other device has');
  assert.equal(box.getLockCode(USER), null, 'and the wrong code is not remembered');
  lockBox(m).props.onChange({ target: { value: 'abcd' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-B', 'device A can open it');
});

test('CRED-004: a code a device took from Protected Identity is checked before a password is saved under it', async () => {
  const enc = await savedOnDeviceA('abcd');
  device();
  assert.equal(box.saveIdentityLockCode('synthetic99', USER), true);
  assert.equal(box.getLockCode(USER), 'synthetic99', 'the identity code became this device\'s lock code');
  const { m, saved } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }]);
  typePassword(m, 'synthetic-portal-B');
  saveButton(m.render()).props.onClick();
  await waitFor(() => /does not open your saved passwords/.test(textOf(m.render())), 'the refusal');
  assert.equal(saved.length, 0);
  assert.ok(lockBox(m), 'the form asks for the account\'s code');
  lockBox(m).props.onChange({ target: { value: 'abcd' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-B');
});

test('CRED-004: Show on a device holding the wrong code asks for the right one and remembers it', async () => {
  const enc = await savedOnDeviceA('abcd');
  device();
  box.saveLockCode('wxyz', USER);
  const { m } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }], { autoViewId: 'p1', onAutoViewDone() {} });
  const prompts = [];
  globalThis.window.prompt = (q) => { prompts.push(q); return 'abcd'; };
  m.render();
  // The detail sheet's Show; the closed Add form draws one of its own first.
  nodes(m.render()).filter((n) => n.type === 'button' && textOf(n).trim() === 'Show').at(-1).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-A'), 'the password');
  assert.equal(prompts.length, 1, 'asked once, for the code it was saved under');
  assert.equal(box.getLockCode(USER), 'abcd', 'and this device now holds that code');
  assert.deepEqual(m.dialogs.filter((d) => d[0] === 'alert'), []);
});

// Protected Identity saved first on this device: its 8+ character code is the
// device's lock code. Switching the password code must keep it.
async function identityFirstDevice() {
  const enc = await savedOnDeviceA('abcd');
  device();
  assert.equal(box.saveIdentityLockCode('synthetic99', USER), true);
  const ssn = await box.encryptSecret('000-00-0000', 'synthetic99', USER);
  // The SSN sits in this device's Protected Identity section.
  const vault = { identityVault: [{ id: 'v1', label: 'Synthetic', ssn }] };
  return { enc, ssn, vault };
}
const showButton = (m) => nodes(m.render()).filter((n) => n.type === 'button' && textOf(n).trim() === 'Show').at(-1);

test('CRED-004: typing the account\'s password code keeps this device\'s Protected Identity code', async () => {
  const { enc, ssn, vault } = await identityFirstDevice();
  const { m, saved } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }], {}, vault);
  typePassword(m, 'synthetic-portal-B');
  saveButton(m.render()).props.onClick();
  await waitFor(() => /does not open your saved passwords/.test(textOf(m.render())), 'the refusal');
  lockBox(m).props.onChange({ target: { value: 'abcd' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(box.getLockCode(USER), 'abcd', 'passwords use the account\'s code');
  assert.equal(box.getIdentityLockCode(USER), 'synthetic99', 'Protected Identity keeps its code');
  assert.equal(await box.decryptSecret(ssn, box.getIdentityLockCode(USER), USER), '000-00-0000', 'the SSN still opens');
});

test('CRED-004: Show with another device\'s code keeps this device\'s Protected Identity code', async () => {
  const { enc, ssn, vault } = await identityFirstDevice();
  const { m } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }], { autoViewId: 'p1', onAutoViewDone() {} }, vault);
  globalThis.window.prompt = () => 'abcd';
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-A'), 'the password');
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(box.getIdentityLockCode(USER), 'synthetic99', 'Protected Identity keeps its code');
  assert.equal(await box.decryptSecret(ssn, box.getIdentityLockCode(USER), USER), '000-00-0000', 'the SSN still opens');
});

test('CRED-004: Show on one stray password does not switch a device whose code opens the others', async () => {
  device();
  box.setSecretUser(USER);
  box.saveLockCode('1111', USER);
  const p1 = await box.encryptSecret('synthetic-portal-1', '1111', USER);
  const p2 = await box.encryptSecret('synthetic-portal-2', '2222', USER);
  const p3 = await box.encryptSecret('synthetic-portal-3', '1111', USER);
  const items = [{ id: 'p1', name: 'Synthetic One', loginSecret: p1 }, { id: 'p2', name: 'Synthetic Two', loginSecret: p2 }, { id: 'p3', name: 'Synthetic Three', loginSecret: p3 }];
  const { m, saved } = privileges(items, { autoViewId: 'p2', onAutoViewDone() {} });
  const prompts = [];
  globalThis.window.prompt = (q) => { prompts.push(q); return '2222'; };
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-2'), 'the stray password');
  assert.equal(prompts.length, 1);
  assert.equal(box.getLockCode(USER), '1111', 'the device keeps the code that opens its other passwords');
  assert.deepEqual(m.dialogs.filter((d) => d[0] === 'alert'), []);
  // The next new password goes under the device's code, not the stray one.
  typePassword(m, 'synthetic-portal-4');
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, '1111', USER), 'synthetic-portal-4');
});

// Device B, on an older build, saved one password under its own wrong code;
// the account's other passwords are under the code from device A.
async function strayOnDeviceB() {
  device();
  box.setSecretUser(USER);
  const a = await Promise.all([1, 2, 3].map((n) => box.encryptSecret(`synthetic-portal-${n}`, 'abcd', USER)));
  const b = await box.encryptSecret('synthetic-portal-B', 'wxyz', USER);
  box.saveLockCode('wxyz', USER);
  return [...a.map((loginSecret, i) => ({ id: `p${i + 1}`, name: `Synthetic ${i + 1}`, loginSecret })), { id: 'pb', name: 'Synthetic B', loginSecret: b }];
}

test('CRED-004: Show with the account\'s code switches a device whose wrong code opens only one stray password', async () => {
  const items = await strayOnDeviceB();
  const { m, saved } = privileges(items, { autoViewId: 'p1', onAutoViewDone() {} });
  const prompts = [];
  globalThis.window.prompt = (q) => { prompts.push(q); return 'abcd'; };
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-1'), 'the password');
  assert.equal(prompts.length, 1);
  assert.equal(box.getLockCode(USER), 'abcd', 'the code that opens most of the passwords wins');
  typePassword(m, 'synthetic-portal-new');
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-new', 'device A can open it');
});

test('CRED-004: Save on a device whose code opens only one stray password asks for the account\'s code', async () => {
  const items = await strayOnDeviceB();
  const { m, saved } = privileges(items);
  typePassword(m, 'synthetic-portal-new');
  saveButton(m.render()).props.onClick();
  await waitFor(() => /does not open your saved passwords/.test(textOf(m.render())), 'the refusal');
  assert.equal(saved.length, 0, 'nothing saved under the stray code');
  lockBox(m).props.onChange({ target: { value: 'abcd' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-new');
});

test('CRED-004: Show breaks a tie toward the code the member typed for the other device', async () => {
  device();
  box.setSecretUser(USER);
  const a = await box.encryptSecret('synthetic-portal-A', 'abcd', USER);
  const b = await box.encryptSecret('synthetic-portal-B', 'wxyz', USER);
  box.saveLockCode('wxyz', USER);
  const { m } = privileges([{ id: 'p1', name: 'Synthetic A', loginSecret: a }, { id: 'pb', name: 'Synthetic B', loginSecret: b }], { autoViewId: 'p1', onAutoViewDone() {} });
  globalThis.window.prompt = () => 'abcd';
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-A'), 'the password');
  assert.equal(box.getLockCode(USER), 'abcd');
});

// 2 passwords under the account's code, then 3 strays an older build saved
// under a wrong one, then 5 more under the account's code: the oldest five
// are mostly strays, but the account's code opens 7 of the 10.
async function straysAmongTheOldest() {
  device();
  box.setSecretUser(USER);
  const plan = ['abcd', 'abcd', 'wxyz', 'wxyz', 'wxyz', 'abcd', 'abcd', 'abcd', 'abcd', 'abcd'];
  const secrets = await Promise.all(plan.map((code, i) => box.encryptSecret(`synthetic-portal-${i}`, code, USER)));
  return secrets.map((loginSecret, i) => ({ id: `p${i}`, name: `Synthetic ${i}`, loginSecret }));
}

test('CRED-004: the lock code is checked against the whole list, not its oldest passwords', () => {
  const values = Array.from({ length: 30 }, (_, i) => `v${i}`);
  const sample = box.spreadSample(values);
  assert.equal(sample.length, box.SECRET_SAMPLE_MAX);
  assert.equal(new Set(sample).size, sample.length, 'no password counted twice');
  assert.equal(sample[0], 'v0');
  assert.equal(sample.at(-1), 'v29', 'the newest is counted');
  assert.ok(sample.filter((v) => Number(v.slice(1)) >= 15).length >= 7, 'the newer half is counted as much as the older');
  assert.deepEqual(box.spreadSample(values.slice(0, 10)), values.slice(0, 10), 'ten passwords are all counted');
});

test('CRED-004: a new device saves under the account\'s code when strays are most of the oldest passwords', async () => {
  const items = await straysAmongTheOldest();
  device(); // device B: nothing stored
  const { m, saved } = privileges(items);
  typePassword(m, 'synthetic-portal-new');
  lockBox(m).props.onChange({ target: { value: 'abcd' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1 || /did not open/.test(textOf(m.render())), 'the save');
  assert.doesNotMatch(textOf(m.render()), /did not open your saved passwords/, 'the account\'s code is not refused');
  assert.equal(saved.length, 1);
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-new', 'the other devices can open it');
});

test('CRED-004: a device holding the account\'s code saves when strays are most of the oldest passwords', async () => {
  const items = await straysAmongTheOldest();
  box.saveLockCode('abcd', USER);
  const { m, saved } = privileges(items);
  typePassword(m, 'synthetic-portal-new');
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1 || /does not open/.test(textOf(m.render())), 'the save');
  assert.doesNotMatch(textOf(m.render()), /does not open your saved passwords/);
  assert.equal(saved.length, 1);
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-new');
});

test('CRED-004: Show on a stray among the oldest passwords does not switch the device to the stray code', async () => {
  const items = await straysAmongTheOldest();
  box.saveLockCode('abcd', USER);
  const { m, saved } = privileges(items, { autoViewId: 'p2', onAutoViewDone() {} });
  globalThis.window.prompt = () => 'wxyz';
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-2'), 'the stray password');
  assert.equal(box.getLockCode(USER), 'abcd', 'the code that opens 7 of 10 stays');
  typePassword(m, 'synthetic-portal-new');
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(await box.decryptSecret(saved[0].loginSecret, 'abcd', USER), 'synthetic-portal-new');
});

// Device B set an 8+ character password code under an older build and never
// saved an SSN or date of birth; the account's passwords are under another.
async function longWrongPasswordCode() {
  device();
  box.setSecretUser(USER);
  const enc = await box.encryptSecret('synthetic-portal-A', 'Account99', USER);
  box.saveLockCode('wrongpw1', USER);
  return [{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }];
}

test('CRED-004: typing the account\'s code drops a long wrong code Protected Identity never used', async () => {
  const items = await longWrongPasswordCode();
  const { m, saved } = privileges(items);
  typePassword(m, 'synthetic-portal-B');
  saveButton(m.render()).props.onClick();
  await waitFor(() => /does not open your saved passwords/.test(textOf(m.render())), 'the refusal');
  lockBox(m).props.onChange({ target: { value: 'Account99' } });
  saveButton(m.render()).props.onClick();
  await waitFor(() => saved.length === 1, 'the save');
  assert.equal(box.getLockCode(USER), 'Account99');
  assert.equal(box.getIdentityLockCode(USER), 'Account99', 'a new SSN goes under the account\'s code, not the one just refused');
});

test('CRED-004: Show with the account\'s code drops a long wrong code Protected Identity never used', async () => {
  const items = await longWrongPasswordCode();
  const { m } = privileges(items, { autoViewId: 'p1', onAutoViewDone() {} });
  globalThis.window.prompt = () => 'Account99';
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-A'), 'the password');
  assert.equal(box.getLockCode(USER), 'Account99');
  assert.equal(box.getIdentityLockCode(USER), 'Account99');
});

test('CRED-004: a long code is kept for Protected Identity while this device\'s copy is still unread', async () => {
  const items = await longWrongPasswordCode();
  const { m } = privileges(items, { autoViewId: 'p1', onAutoViewDone() {} });
  globalThis.__screen.offlineCopyUnread = true;
  globalThis.window.prompt = () => 'Account99';
  m.render();
  showButton(m).props.onClick({ stopPropagation() {} });
  await waitFor(() => textOf(m.render()).includes('synthetic-portal-A'), 'the password');
  assert.equal(box.getLockCode(USER), 'Account99');
  assert.equal(box.getIdentityLockCode(USER), 'wrongpw1', 'an SSN the unread copy may hold still opens');
});

test('CRED-004: switchLockCode keeps the identity code only when Protected Identity uses it', () => {
  device();
  box.saveLockCode('wrongpw1', USER);
  box.switchLockCode('Account99', { identityHeld: false, uid: USER });
  assert.equal(box.getIdentityLockCode(USER), 'Account99');
  device();
  box.saveLockCode('synthetic99', USER);
  box.switchLockCode('abcd', { identityHeld: true, uid: USER });
  assert.equal(box.getLockCode(USER), 'abcd');
  assert.equal(box.getIdentityLockCode(USER), 'synthetic99');
  // A code Protected Identity set beside a short one is always its own.
  device();
  box.saveLockCode('abcd', USER);
  assert.equal(box.saveIdentityLockCode('synthetic99', USER), true);
  box.switchLockCode('efgh', { identityHeld: false, uid: USER });
  assert.equal(box.getIdentityLockCode(USER), 'synthetic99');
});

test('CRED-004: a double tap on Save while the password is encrypted adds the privilege once', async () => {
  device();
  box.setSecretUser(USER);
  box.saveLockCode('abcd', USER);
  const enc = await box.encryptSecret('synthetic-portal-A', 'abcd', USER);
  const { m, saved } = privileges([{ id: 'p1', name: 'Synthetic Mercy', loginSecret: enc }]);
  typePassword(m, 'synthetic-portal-B');
  const tap = saveButton(m.render()).props.onClick;
  tap(); tap();
  const disabledWhileSaving = saveButton(m.render()).props.disabled;
  await waitFor(() => saved.length >= 1, 'the save');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(saved.length, 1, 'one privilege, not two');
  assert.equal(disabledWhileSaving, true, 'Save is disabled while it saves');
});

// ── CRED-016: a linked file Storage does not have ───────────────────────────
const MISSING = { id: 'd1', name: 'synthetic-letter.pdf', type: 'application/pdf', storagePath: 'u/synthetic-letter.pdf', fileMissing: true };

test('CRED-016: a record\'s missing file says so and where to upload it, not "downloading" for ever', () => {
  const item = { id: 'p1', name: 'Synthetic Mercy' };
  const m = mount(CrudSection, { props: { title: 'Privileges', sectionKey: 'privileges', items: [item], fields: PRIV_FIELDS, onShare() {}, onDelete() {}, onAdd() {}, onEdit() {}, autoViewId: 'p1', onAutoViewDone() {} },
    data: { documents: [{ ...MISSING, linkedTo: 'privileges:p1' }] } });
  Object.assign(globalThis.__screen.app, extraApp);
  m.render();
  const page = textOf(m.render());
  assert.match(page, /synthetic-letter\.pdf is missing from your account\. Upload it again in Documents\./);
  assert.doesNotMatch(page, /downloading from the cloud/);
  nodes(m.render()).find((n) => n.type === 'button' && n.props['aria-label'] === 'Edit').props.onClick({ stopPropagation() {} });
  assert.match(textOf(m.render()), /Missing from your account\. Upload it again in Documents\./);
  assert.doesNotMatch(textOf(m.render()), /syncing/);
});

test('CRED-016: the same on a health record', () => {
  const m = mount(HealthRecordsSection, { props: { onShare() {}, autoViewId: 'h1', onAutoViewDone() {} },
    data: { healthRecords: [{ id: 'h1', category: 'Vaccination', type: 'Influenza' }], documents: [{ ...MISSING, linkedTo: 'healthRecords:h1' }] } });
  Object.assign(globalThis.__screen.app, extraApp);
  m.render();
  const page = textOf(m.render());
  assert.match(page, /synthetic-letter\.pdf is missing from your account\. Upload it again in Documents\./);
  assert.doesNotMatch(page, /downloading from the cloud/);
});

// ── CRED-021: vaccine doses by hand ─────────────────────────────────────────
const doseInput = (m, i, what) => find(m.render(), (n) => n.type === 'input' && n.props['aria-label'] === `Dose ${i} ${what}`, `dose ${i} ${what}`);

test('CRED-021: a vaccination is added with its doses typed by hand', () => {
  const m = mount(HealthRecordsSection, { props: { onShare() {} }, data: { healthRecords: [] } });
  Object.assign(globalThis.__screen.app, extraApp);
  headerAdd(m);
  find(m.render(), (n) => n.type === 'select' && n.props.required, 'category').props.onChange({ target: { value: 'Vaccination' } });
  for (const [i, date] of [[1, '2026-01-05'], [2, '2026-02-05'], [3, '2026-07-05']]) {
    button(m.render(), 'Add a dose').props.onClick();
    doseInput(m, i, 'date').props.onChange({ target: { value: date } });
  }
  doseInput(m, 3, 'lot').props.onChange({ target: { value: 'SYN-LOT-3' } });
  button(m.render(), 'Add a dose').props.onClick(); // a fourth row left blank is not saved
  saveButton(m.render()).props.onClick();
  const adds = m.calls.filter((c) => c[0] === 'add' && c[1] === 'healthRecords');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0][2].doses, [
    { doseNumber: 1, date: '2026-01-05' },
    { doseNumber: 2, date: '2026-02-05' },
    { doseNumber: 3, date: '2026-07-05', lotNumber: 'SYN-LOT-3' },
  ]);
});

test('CRED-021: a scanned series gets its third dose, and a misread lot is corrected', () => {
  const rec = { id: 'h1', category: 'Vaccination', type: 'Hepatitis B', doses: [
    { doseNumber: 1, date: '2026-01-05', manufacturer: 'Synthetic Bio', lotNumber: 'SYN-0O1' },
    { doseNumber: 2, date: '2026-02-05', manufacturer: 'Synthetic Bio', lotNumber: 'SYN-002' },
  ] };
  const m = mount(HealthRecordsSection, { props: { onShare() {} }, data: { healthRecords: [rec] } });
  Object.assign(globalThis.__screen.app, extraApp);
  nodes(m.render()).find((n) => n.type === 'button' && n.props['aria-label'] === 'Edit').props.onClick({ stopPropagation() {} });
  assert.equal(doseInput(m, 2, 'lot').props.value, 'SYN-002', 'the scanned doses are in the form');
  doseInput(m, 1, 'lot').props.onChange({ target: { value: 'SYN-001' } });
  button(m.render(), 'Add a dose').props.onClick();
  doseInput(m, 3, 'date').props.onChange({ target: { value: '2026-07-05' } });
  saveButton(m.render()).props.onClick();
  const edits = m.calls.filter((c) => c[0] === 'edit' && c[1] === 'healthRecords');
  assert.equal(edits.length, 1);
  assert.equal(edits[0][2].doses.length, 3);
  assert.equal(edits[0][2].doses[0].lotNumber, 'SYN-001');
  assert.equal(edits[0][2].doses[0].manufacturer, 'Synthetic Bio', 'what was not edited is kept');
  assert.deepEqual(edits[0][2].doses[2], { doseNumber: 3, date: '2026-07-05' });
});

// ── CRED-023: a new category's description ──────────────────────────────────
function newCategory() {
  const m = mount(NewCategoryPanel, { props: { onCreated() {} }, data: { customCategories: [] } });
  Object.assign(globalThis.__screen.app, extraApp);
  const box = (id) => find(m.render(), (n) => n.type === 'input' && n.props['aria-labelledby'] === id, id);
  return { m, box };
}

test('CRED-023: New category takes a description and saves it', () => {
  const { m, box: el } = newCategory();
  el('new-category-name').props.onChange({ target: { value: 'Synthetic Badges' } });
  el('new-category-description').props.onChange({ target: { value: 'ID badges each hospital issues' } });
  button(m.render(), 'Create category').props.onClick();
  const adds = m.calls.filter((c) => c[0] === 'add' && c[1] === 'customCategories');
  assert.equal(adds.length, 1);
  assert.equal(adds[0][2].description, 'ID badges each hospital issues');
});

test('CRED-023: a description holding an identifier is refused, as a field would be', () => {
  const { m, box: el } = newCategory();
  el('new-category-name').props.onChange({ target: { value: 'Synthetic Badges' } });
  el('new-category-description').props.onChange({ target: { value: 'SSN 123-45-6789' } });
  button(m.render(), 'Create category').props.onClick();
  assert.equal(m.calls.filter((c) => c[0] === 'add').length, 0);
  assert.match(textOf(m.render()), /A description cannot hold a Social Security number/);
});
