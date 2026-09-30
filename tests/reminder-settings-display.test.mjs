import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DATA, DEFAULT_SETTINGS } from '../src/constants/defaults.js';
import { profileRowToSettings } from '../src/lib/supabase.js';
import { isReminderRecipient } from '../supabase/functions/_shared/reminderRecipients.mjs';

// The member's Settings screen, rendered for real (SettingsSection with the
// app context stubbed), from a profile row the way AppContext loads it:
// profileRowToSettings, then DEFAULT_SETTINGS merged underneath. The Email
// reminders switch must show what send-reminders will do with the same row:
// blank and true show ON and are mailed, false shows OFF and is not. The
// switch is also rendered from settings that skipped the merge (a stale
// cache), where the old `active={s.notifyEmail}` showed OFF for a blank and
// its `!s.notifyEmail` toggle turned it ON on the first tap.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const toggles = [];

const stubs = {
  name: 'settings-stubs',
  setup(b) {
    b.onResolve({ filter: /context\/AppContext(\.jsx)?$/ }, () => ({ path: 'app', namespace: 'stub' }));
    // Every ToggleRow SettingsSection renders is recorded (label, active,
    // onToggle) and then rendered by the real component.
    b.onResolve({ filter: /^\.\.\/shared\/ToggleRow$/ }, () => ({ path: 'toggle', namespace: 'stub' }));
    // The Password and sign-in email card needs a ClerkProvider (AUTH-012);
    // it is not what this test reads.
    b.onResolve({ filter: /^\.\/SignInMethodsCard$/ }, () => ({ path: 'signin', namespace: 'stub' }));
    b.onLoad({ filter: /^signin$/, namespace: 'stub' }, () => ({ contents: 'export default function SignInMethodsCard() { return null; }', loader: 'js' }));
    b.onLoad({ filter: /^app$/, namespace: 'stub' }, () => ({ contents: 'export const useApp = () => globalThis.__reminderSettingsApp;', loader: 'js' }));
    b.onLoad({ filter: /^toggle$/, namespace: 'stub' }, () => ({
      contents: `import Real from ${JSON.stringify(path.join(src, 'components', 'shared', 'ToggleRow.jsx'))};
        export default function ToggleRow(props) { globalThis.__reminderToggles.push(props); return Real(props); }`,
      loader: 'jsx', resolveDir: src,
    }));
  },
};

const bundle = await build({
  stdin: { contents: 'export { default } from "./components/pages/SettingsSection.jsx";', resolveDir: src },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  logLevel: 'error', plugins: [stubs], define: { 'import.meta.env': '{}' },
});
const temp = path.join(here, `.reminder-settings-${randomUUID()}.tmp.mjs`);
await writeFile(temp, bundle.outputFiles[0].text);
let Settings;
try { ({ default: Settings } = await import(temp)); } finally { await unlink(temp); }

const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

/** Render Settings for these settings; the Email reminders switch and what a tap saves. */
function emailSwitch(settings) {
  const saved = [];
  globalThis.__reminderToggles = toggles;
  toggles.length = 0;
  globalThis.__reminderSettingsApp = {
    data: { ...DEFAULT_DATA, settings }, theme: T, updateSettings: u => saved.push(u),
    allTrackedStates: [], manage: {}, limitedLaunch: { enabled: false }, user: null,
  };
  const html = renderToStaticMarkup(React.createElement(Settings, {}));
  const row = toggles.find(p => p.label === 'Email reminders');
  assert.ok(row, 'Settings renders the Email reminders switch');
  const aria = /<button[^>]*role="switch" aria-checked="(true|false)" aria-label="Email reminders"/.exec(html);
  assert.ok(aria, 'the switch is marked up as a named switch');
  row.onToggle();
  return { shown: aria[1] === 'true', active: row.active, saved };
}

/** Settings as AppContext builds them from a profile row. */
const loaded = row => ({ ...DEFAULT_DATA.settings, ...profileRowToSettings(row) });
const ROW = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.test', access_status: 'active' };

test('Settings shows the switch send-reminders obeys, from the real load path', () => {
  for (const [label, notify_email, on] of [['blank', null, true], ['on', true, true], ['off', false, false]]) {
    const row = { ...ROW, notify_email };
    const sw = emailSwitch(loaded(row));
    assert.equal(sw.shown, on, `${label}: the switch shows ${on ? 'ON' : 'OFF'}`);
    assert.equal(sw.active, on);
    assert.equal(isReminderRecipient(row), on, `${label}: send-reminders ${on ? 'mails' : 'skips'} the same row`);
    assert.deepEqual(sw.saved, [{ notifyEmail: !on }], `${label}: one tap turns it ${on ? 'off' : 'on'}`);
  }
});

test('a blank that skipped the defaults merge still shows ON and the first tap turns it OFF', () => {
  const { notifyEmail: _drop, ...rest } = DEFAULT_SETTINGS;
  for (const blank of [undefined, null]) {
    const sw = emailSwitch({ ...rest, email: 'a@example.test', notifyEmail: blank });
    assert.equal(sw.shown, true, `${String(blank)} shows ON`);
    assert.deepEqual(sw.saved, [{ notifyEmail: false }], `${String(blank)}: the first tap saves an explicit false`);
  }
});

test('the other switches keep their own readings', () => {
  emailSwitch(loaded({ ...ROW, notify_email: null, ack_requests: false }));
  const ack = toggles.find(p => p.label === 'Acknowledge document requests automatically');
  assert.equal(ack.active, false, 'the opt-out acknowledgement switch is untouched');
});
