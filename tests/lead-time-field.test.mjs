// NOTIFY-004: the Settings lead-time field saved on every keystroke with
// parseInt(value) || 90: -30 or 3 were saved as typed (Home then showed
// nothing, or a 3-day window, and the Setup Reminders task un-completed at a
// negative value) while send-reminders clamps to 7..365, and clearing the
// field to retype snapped it back to 90 on the first keystroke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { mountComponent } from './component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';
import { buildSetup } from '../src/utils/setupTasks.js';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });
async function settings(lead = 90) {
  const saved = [];
  const app = { data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, reminderLeadDays: lead } }, updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); return true; },
    theme: T, allTrackedStates: [], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules: {
    states: await import(src('constants/states.js')), contactFormat: await import(src('utils/contactFormat.js')), cmePassport: await import(src('utils/cmePassport.js')),
    stateRequirements: await import(src('constants/stateRequirements.js')), boardRequirements: await import(src('constants/boardRequirements.js')),
    membershipCopy: await import(src('content/membershipCopy.js')), reminderPreferences: await import(src('utils/reminderPreferences.js')),
    forwardingAddresses: await import(src('utils/forwardingAddresses.js')), useInputStyle: { useInputStyle: () => ({}) },
    useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
    aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
    cptCoder: { CODER_MODELS: [] }, deskKeys: { DESK_KEYS: [] },
  } });
  const field = () => c.nodes().find(n => n.type === 'input' && n.props.name === 'reminderLeadDays');
  const type = value => { field().props.onChange({ target: { value } }); c.render(); };
  return { c, saved, field, type };
}

test('the field can sit empty while retyping, and saves once, clamped to what the server honours', async () => {
  const s = await settings();
  assert.equal(s.field().props.min, 7);
  assert.equal(s.field().props.max, 365);
  s.type('');
  assert.equal(s.field().props.value, '', 'no snap back to 90 on the first keystroke');
  s.type('4'); s.type('45');
  assert.deepEqual(s.saved, [], 'no keystroke is a save');
  s.field().props.onBlur({ target: { value: '45' } });
  assert.deepEqual(s.saved, [{ reminderLeadDays: 45 }]);
  for (const [typed, stored] of [['-30', 7], ['3', 7], ['400', 365], ['', 90]]) {
    const t = await settings(60);
    t.type(typed);
    t.field().props.onBlur({ target: { value: typed } });
    assert.deepEqual(t.saved, [{ reminderLeadDays: stored }], typed);
  }
  const e = await settings();
  e.type('120');
  e.field().props.onKeyDown({ key: 'Enter', target: { value: '120', blur() {} } });
  assert.deepEqual(e.saved, [{ reminderLeadDays: 120 }]);
});

test('a stored value out of range is read the way send-reminders reads it', async () => {
  const require = createRequire(import.meta.url);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = await build({ entryPoints: [`${root}src/utils/notifications.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const data = lead => ({ settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: '', reminderLeadDays: lead },
    licenses: [{ id: 'dea', type: 'DEA Registration', expirationDate: day(5) }], cme: [], privileges: [], insurance: [], alertAcks: [] });
  for (const lead of [3, -30]) assert.deepEqual(mod.exports.generateAlerts(data(lead))?.soon.map(i => i.id), ['dea'], `lead ${lead} reads as 7`);
  const reminders = st => buildSetup({ settings: { email: 'synthetic@example.invalid', notifyEmail: true, reminderLeadDays: st }, licenses: [] }).byId.reminders.status;
  assert.equal(reminders(-30), 'done', 'a negative stored lead no longer un-completes Reminders');
  for (const file of ['src/App.jsx', 'src/components/pages/NotificationCenter.jsx', 'src/components/features/SetupCard.jsx', 'src/components/features/SetupPage.jsx']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /reminderLeadDays\) \|\| 90|reminderLeadDays \|\| 90/, `${file} reads the lead through reminderLeadDays()`);
  }
});
