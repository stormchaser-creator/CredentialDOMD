// SETTINGS-007: the Settings Email field saved on every keystroke. Typing an
// address another account holds saved 'x', 'x@', ... 'x@example.co' one after
// another; only the last keystroke hit the unique index (23505), and
// saveSettings' { savedExcept: 'email' } was dropped by updateSettings, so
// the database kept the truncated prefix and nobody was told.
//
// The real SettingsSection through the component harness (no DOM, synthetic
// account), the real updateSettings body from AppContext in a vm, and the
// real saveSettings retry. Synthetic addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mountComponent, settle } from './component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
const modules = {
  states: await import(src('constants/states.js')),
  contactFormat: await import(src('utils/contactFormat.js')),
  cmePassport: await import(src('utils/cmePassport.js')),
  stateRequirements: await import(src('constants/stateRequirements.js')),
  boardRequirements: await import(src('constants/boardRequirements.js')),
  membershipCopy: await import(src('content/membershipCopy.js')),
  reminderPreferences: await import(src('utils/reminderPreferences.js')),
  forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
  useInputStyle: { useInputStyle: () => ({}) },
  useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [], loading: false }) },
  aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
  cptCoder: { CODER_MODELS: [] },
  deskKeys: { DESK_KEYS: [] },
};
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

async function settings(extra = {}) {
  const saved = [], cleared = [];
  const app = {
    data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, email: 'old@example.invalid' } },
    updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); app.data = { ...app.data, settings: { ...app.data.settings, ...u } }; return true; },
    clearSettingsRefusal: () => cleared.push(true),
    theme: T, allTrackedStates: [], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false, ...extra,
  };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules });
  const field = () => c.nodes().find(n => n.type === 'input' && n.props.name === 'email');
  const type = value => { field().props.onChange({ target: { value } }); c.render(); };
  return { c, app, saved, cleared, field, type };
}

test('typing an address saves nothing until the field is left, then saves the whole address once', async () => {
  const s = await settings();
  for (let i = 1; i <= 'taken@example.invalid'.length; i++) s.type('taken@example.invalid'.slice(0, i));
  assert.deepEqual(s.saved, [], 'no keystroke is a save');
  assert.equal(s.field().props.value, 'taken@example.invalid', 'the field shows what was typed');
  s.field().props.onBlur({ target: { value: 'taken@example.invalid' } });
  assert.deepEqual(s.saved, [{ email: 'taken@example.invalid' }]);
});

test('an address with a problem, or the same address, is not saved on blur', async () => {
  const s = await settings();
  s.type('half@');
  s.field().props.onBlur({ target: { value: 'half@' } });
  assert.deepEqual(s.saved, []);
  const t = await settings();
  t.type('old@example.invalid');
  t.field().props.onBlur({ target: { value: 'old@example.invalid' } });
  assert.deepEqual(t.saved, []);
});

test('Enter saves too', async () => {
  const s = await settings();
  s.type('new@example.invalid');
  s.field().props.onKeyDown({ key: 'Enter', target: { value: 'new@example.invalid', blur() {} } });
  assert.deepEqual(s.saved, [{ email: 'new@example.invalid' }]);
});

test('clearing the field saves the blank on blur', async () => {
  const s = await settings();
  s.type('');
  s.field().props.onBlur({ target: { value: '' } });
  assert.deepEqual(s.saved, [{ email: '' }]);
});

test('a refused address is named under the field, and editing clears it', async () => {
  const s = await settings({ settingsRefusal: { field: 'email', address: 'taken@example.invalid' } });
  const hint = () => s.c.nodes().find(n => n.props?.label === 'Email')?.props.hint;
  assert.match(hint(), /taken@example\.invalid is on another CredentialDOMD account, so it was not saved/);
  assert.match(s.field().props.style.borderColor, /#ef4444/);
  s.type('other@example.invalid');
  assert.equal(s.cleared.length, 1);
});

// The real updateSettings from AppContext, with its dependencies synthetic.
const appSource = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  const updateSettings = useCallback(');
const end = appSource.indexOf('  // A device-only section', start);
function updateSettingsFixture(saveResult) {
  let data = { settings: { email: 'old@example.invalid', name: 'Synthetic A' } };
  const refusals = [];
  const context = {
    useCallback: fn => fn, user: { id: 'user_syntheticA' }, userIdRef: { current: 'profileA' },
    dataRef: { get current() { return data; } },
    allowsSettingsChange: () => true, accessVerifying: () => false, accessAuthority: {}, alertWriteRefused() {},
    guardedSetData: updater => { data = updater(structuredClone(data)); return true; },
    sbSaveSettings: async () => saveResult,
    setSettingsRefusal: value => refusals.push(value),
  };
  vm.runInNewContext(`${appSource.slice(start, end)}\nglobalThis.updateSettings = updateSettings;`, context);
  return { run: context.updateSettings, data: () => data, refusals };
}

test('a taken address is rolled back to the stored one and reported; nothing else is touched', async () => {
  const f = updateSettingsFixture({ email: 'old@example.invalid', name: 'Synthetic A', savedExcept: 'email' });
  assert.equal(f.run({ email: 'taken@example.invalid' }), true);
  assert.equal(f.data().settings.email, 'taken@example.invalid', 'shown at once, as every setting is');
  await settle();
  assert.equal(f.data().settings.email, 'old@example.invalid', 'the stored address comes back');
  assert.equal(f.data().settings.name, 'Synthetic A');
  assert.deepEqual(f.refusals.map(r => [r.field, r.address, r.accountId]), [['email', 'taken@example.invalid', 'user_syntheticA']]);
});

test('without a stored copy the address before the edit comes back', async () => {
  const f = updateSettingsFixture({ savedExcept: 'email' });
  f.run({ email: 'taken@example.invalid' });
  await settle();
  assert.equal(f.data().settings.email, 'old@example.invalid');
});

test('an accepted address stays and nothing is reported', async () => {
  const f = updateSettingsFixture({ email: 'new@example.invalid' });
  f.run({ email: 'new@example.invalid' });
  await settle();
  assert.equal(f.data().settings.email, 'new@example.invalid');
  assert.deepEqual(f.refusals, []);
});
