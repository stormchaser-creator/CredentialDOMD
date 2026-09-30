// SETTINGS-014: on a phone, Profile & settings drew its switches as the tap
// target itself (44x24, the theme switch 48x28), the reminder frequency
// chips at about 26px tall and Test at about 29px, under the 32px the QA lab
// holds every phone control to (and the minHeight 32 to 44 the app gives
// its other controls). The fix keeps the drawn track and gives the button
// around it a real height.
//
// The real SettingsSection and ToggleRow rendered to markup (the app context
// stubbed); a control passes when its own inline style guarantees the height:
// a height or min-height of at least 32px. Padding plus font size is not a
// guarantee. Synthetic account.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const MIN = 32;

const bundle = await build({
  stdin: { contents: 'export { default } from "./components/pages/SettingsSection.jsx";', resolveDir: src },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  logLevel: 'error', define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /context\/AppContext(\.jsx)?$/ }, () => ({ path: 'app', namespace: 'stub' }));
    b.onLoad({ filter: /^app$/, namespace: 'stub' }, () => ({ contents: 'export const useApp = () => globalThis.__tapTargetApp;', loader: 'js' }));
    // The sign-in card needs a ClerkProvider; it is not what this test reads.
    b.onResolve({ filter: /^\.\/SignInMethodsCard$/ }, () => ({ path: 'signin', namespace: 'stub' }));
    b.onLoad({ filter: /^signin$/, namespace: 'stub' }, () => ({ contents: 'export default function SignInMethodsCard() { return null; }', loader: 'js' }));
  } }],
});
const temp = path.join(here, `.settings-tap-${randomUUID()}.tmp.mjs`);
await writeFile(temp, bundle.outputFiles[0].text);
let Settings;
try { ({ default: Settings } = await import(temp)); } finally { await unlink(temp); }

const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

function render() {
  globalThis.Notification = { permission: 'default', requestPermission: async () => 'default' };
  globalThis.__tapTargetApp = {
    data: { ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, name: 'Synthetic Physician', email: 'a@example.test', phone: '5550100170', primaryState: 'CO', additionalStates: ['NM'] } },
    theme: T, updateSettings() {}, toggleTheme() {}, allTrackedStates: ['CO', 'NM'], manage: {}, limitedLaunch: { enabled: false }, user: null,
  };
  try { return renderToStaticMarkup(React.createElement(Settings, {})); } finally { delete globalThis.Notification; }
}

/** Every button: its attributes, its text and the px value of each inline style property. */
function buttons(html) {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => {
    const style = Object.fromEntries((/style="([^"]*)"/.exec(attrs)?.[1] || '').split(';').filter(Boolean).map(d => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }));
    const label = /aria-label="([^"]*)"/.exec(attrs)?.[1] || inner.replace(/<[^>]*>/g, '').trim();
    const px = key => (/^[\d.]+px$/.test(style[key] || '') ? parseFloat(style[key]) : 0);
    return { attrs, inner, style, label, height: Math.max(px('height'), px('min-height')), width: Math.max(px('width'), px('min-width')) };
  });
}

const html = render();
const all = buttons(html);
const named = label => { const b = all.find(x => x.label === label); assert.ok(b, `Settings renders "${label}"`); return b; };

test('every switch on Profile & settings is at least 32px tall, with its track still drawn inside', () => {
  const switches = all.filter(b => /role="switch"/.test(b.attrs));
  assert.ok(switches.length >= 5, `found ${switches.length} switches`);
  for (const sw of switches) {
    assert.ok(sw.height >= MIN, `${sw.label}: ${sw.height}px tall`);
    assert.ok(sw.width >= 44, `${sw.label}: ${sw.width}px wide`);
    assert.match(sw.inner, /<span aria-hidden="true" style="[^"]*height:(24|28)px/, `${sw.label}: the 44x24 (theme 48x28) track is kept`);
  }
  assert.ok(switches.some(b => b.label === 'Dark Mode'), 'the theme switch is one of them');
});

test('the reminder frequency chips, Test and Enable are at least 32px tall', () => {
  for (const label of ['Daily', '3 Days', 'Weekly', 'Biweekly', 'Monthly', 'Test', 'Enable']) {
    assert.ok(named(label).height >= MIN, `${label}: ${named(label).height}px tall`);
  }
});

test('the Licensed States buttons are at least 32px in both directions', () => {
  const primary = named('Set Primary');
  assert.ok(primary.height >= MIN, `Set Primary: ${primary.height}px tall`);
  const stop = named('Stop tracking NM');
  assert.ok(stop.height >= MIN && stop.width >= MIN, `Stop tracking: ${stop.width}x${stop.height}`);
});
