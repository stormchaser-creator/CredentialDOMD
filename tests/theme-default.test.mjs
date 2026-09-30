// SETTINGS-014: a new profile's theme column defaults to 'arctic', which is
// not a theme. The app rendered dark (THEMES.arctic is undefined, so it fell
// back to dark), but Settings read theme === 'dark' as false and showed
// 'Light Mode' with the switch off, the header showed the Moon, and the first
// tap computed 'arctic' === 'dark' ? 'light' : 'dark' = 'dark' and saved it:
// nothing changed on screen until a second tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mountComponent } from './component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';

const themes = await import('../src/constants/themes.js');
const src = rel => new URL(`../src/${rel}`, import.meta.url).href;

test('an unknown stored theme reads as dark, the theme the app actually renders', () => {
  assert.equal(typeof themes.effectiveThemeName, 'function');
  for (const stored of ['arctic', undefined, null, '', 'neon']) assert.equal(themes.effectiveThemeName(stored), 'dark', String(stored));
  assert.equal(themes.effectiveThemeName('light'), 'light');
  assert.equal(themes.effectiveThemeName('dark'), 'dark');
});

test('one toggle from arctic goes to light', async () => {
  const source = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const toggleTheme = useCallback(');
  const end = source.indexOf('  // Convenience CRUD helpers', start);
  let data = { settings: { theme: 'arctic' } };
  const saved = [];
  const context = { useCallback: fn => fn, dataOwnerRef: { current: 'user_a' }, userIdRef: { current: 'profile_a' }, getActiveUserId: () => 'user_a',
    setData: fn => { data = fn(data); }, sbSaveSettings: async (...args) => { saved.push(args[1]); }, THEMES: themes.THEMES, effectiveThemeName: themes.effectiveThemeName, nextThemeName: themes.nextThemeName };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.toggle = toggleTheme;`, context);
  context.toggle();
  assert.equal(data.settings.theme, 'light');
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ theme: 'light' }]);
});

test('Settings shows Dark Mode, switch on, for an arctic profile', async () => {
  const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });
  const app = { data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, theme: 'arctic' } }, updateSettings: () => true, theme: T,
    allTrackedStates: [], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false, toggleTheme() {} };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules: {
    themes, states: await import(src('constants/states.js')), contactFormat: await import(src('utils/contactFormat.js')),
    cmePassport: await import(src('utils/cmePassport.js')), stateRequirements: await import(src('constants/stateRequirements.js')),
    boardRequirements: await import(src('constants/boardRequirements.js')), membershipCopy: await import(src('content/membershipCopy.js')),
    reminderPreferences: await import(src('utils/reminderPreferences.js')), forwardingAddresses: await import(src('utils/forwardingAddresses.js')),
    useInputStyle: { useInputStyle: () => ({}) }, useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
    aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
    cptCoder: { CODER_MODELS: [] }, deskKeys: { DESK_KEYS: [] },
  } });
  assert.match(c.pageText(), /Dark Mode/);
  assert.doesNotMatch(c.pageText(), /Light Mode/);
});

test('the header and side nav read the same effective name', async () => {
  for (const file of ['src/App.jsx', 'src/components/shared/SideNav.jsx']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /settings\.theme === "dark"/, file);
  }
});
