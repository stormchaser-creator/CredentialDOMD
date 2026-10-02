// IOS-SETTINGS-2 (QA lab, WebKit as the installed iPhone app, 2 runs, and a
// WebKit source read): Profile & settings > Lead time: 60 typed, the app sent
// to the background before leaving the field, iOS discards the page, and the
// server still held 45. iOS blurs the field as the app goes behind another
// one but sends no focusout, which React's onBlur listens for. A lead time or
// email typed and not yet left is now saved as the page is hidden.
// Synthetic account only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from '../component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../../src/constants/defaults.js';

const src = rel => new URL(`../../src/${rel}`, import.meta.url).href;
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

async function settings() {
  const saved = [];
  const listeners = { document: {}, window: {} };
  const on = (where) => ({
    addEventListener: (t, f) => { (listeners[where][t] ||= new Set()).add(f); },
    removeEventListener: (t, f) => { listeners[where][t]?.delete(f); },
  });
  const document = { visibilityState: 'visible', querySelector: () => null, createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} }, ...on('document') };
  const window = { navigator: {}, matchMedia: () => ({ matches: false }), confirm: () => true, ...on('window') };
  const app = {
    data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, email: 'old@example.invalid', reminderLeadDays: 45 } },
    updateSettings: u => { saved.push(JSON.parse(JSON.stringify(u))); app.data = { ...app.data, settings: { ...app.data.settings, ...u } }; return true; },
    clearSettingsRefusal() {}, theme: T, allTrackedStates: [], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false,
  };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app, modules, globals: { document, window } });
  const field = name => c.nodes().find(n => n.type === 'input' && n.props.name === name);
  const fire = (where, type) => { for (const f of [...(listeners[where][type] || [])]) f({ persisted: false }); c.render(); };
  return { c, saved, field, document, fire, listeners };
}

test('a lead time typed and not left is saved as the app goes to the background', async () => {
  const s = await settings();
  s.field('reminderLeadDays').props.onChange({ target: { value: '60' } });
  s.c.render();
  assert.deepEqual(s.saved, [], 'nothing saved while typing');
  s.document.visibilityState = 'hidden';
  s.fire('document', 'visibilitychange');
  assert.deepEqual(s.saved, [{ reminderLeadDays: 60 }]);
});

test('an address typed and not left is saved on pagehide; going hidden with nothing typed saves nothing', async () => {
  const s = await settings();
  s.document.visibilityState = 'hidden';
  s.fire('document', 'visibilitychange');
  assert.deepEqual(s.saved, []);
  s.document.visibilityState = 'visible';
  s.field('email').props.onChange({ target: { value: 'new@example.invalid' } });
  s.c.render();
  s.fire('window', 'pagehide');
  assert.deepEqual(s.saved, [{ email: 'new@example.invalid' }]);
});
