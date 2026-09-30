// NOTIFY-006: 'Send Test Notification' on a new or fully current account
// (generateAlerts returns null) said "No active alerts to send." and did
// nothing, so a member could not check notifications worked until something
// was about to expire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './component-harness.mjs';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';

const src = rel => new URL(`../src/${rel}`, import.meta.url).href;
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });
async function settings(permission) {
  const fired = [], alerts = [], composed = [];
  const app = { data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, email: 'synthetic@example.invalid', notifyEmail: true } }, updateSettings: () => true,
    theme: T, allTrackedStates: [], navigate() {}, limitedLaunch: { enabled: false }, isDesktop: false };
  const c = await mountComponent('src/components/pages/SettingsSection.jsx', { app,
    globals: { alert: m => alerts.push(m), ...(permission ? { Notification: { permission } } : {}) },
    modules: {
      notifications: { generateAlerts: () => null, buildNotificationMessage: () => null, fireBrowserNotification: (...a) => fired.push(a), composeEmail: (...a) => composed.push(a), textAlert() {} },
      states: await import(src('constants/states.js')), contactFormat: await import(src('utils/contactFormat.js')), cmePassport: await import(src('utils/cmePassport.js')),
      stateRequirements: await import(src('constants/stateRequirements.js')), boardRequirements: await import(src('constants/boardRequirements.js')),
      membershipCopy: await import(src('content/membershipCopy.js')), reminderPreferences: await import(src('utils/reminderPreferences.js')),
      forwardingAddresses: await import(src('utils/forwardingAddresses.js')), useInputStyle: { useInputStyle: () => ({}) },
      useForwardingAddresses: { useForwardingAddresses: () => ({ rows: [] }) },
      aiClient: { useSharedAiStatus: () => ({}), fetchSharedAiStatus() {}, describeAiStatus: () => '', describeOpusStatus: () => '', describeAiBudget: () => null, useAnthropicAvailable: () => false },
      cptCoder: { CODER_MODELS: [] }, deskKeys: { DESK_KEYS: [] },
    } });
  const press = () => { c.nodes().find(n => n.type === 'button' && c.text(n) === 'Test').props.onClick(); c.render(); };
  return { c, fired, alerts, composed, press };
}

test('with nothing due and notifications allowed, a test notification still fires', async () => {
  const s = await settings('granted');
  s.press();
  assert.equal(s.fired.length, 1);
  assert.equal(s.fired[0][0], 'CredentialDOMD Test');
  assert.match(s.fired[0][1], /Notifications are working\. Nothing is due right now\./);
  assert.deepEqual(s.alerts, [], 'no dead-end alert');
  assert.deepEqual(s.composed, [], 'no mail app opens as a pretend email test');
  assert.match(s.c.pageText(), /Test sent/);
  assert.match(s.c.pageText(), /Email reminders come from a daily check and are sent only when something is due or has changed/);
});

test('with nothing due and notifications not allowed, the member is told how to test', async () => {
  for (const permission of ['default', 'denied', null]) {
    const s = await settings(permission);
    s.press();
    assert.equal(s.fired.length, 0);
    assert.deepEqual(s.alerts, []);
    const notice = s.c.nodes().find(n => n.props?.role === 'status' && /Nothing is due right now/.test(s.c.text(n)));
    assert.ok(notice, 'the notice is shown');
    assert.match(s.c.text(notice), /Turn on browser notifications/);
    assert.doesNotMatch(s.c.text(notice), /—/, 'no em dash in the notice');
  }
});
