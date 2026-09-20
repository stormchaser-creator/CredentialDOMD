import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CME_PROVIDERS } from '../src/constants/cmeProviders.js';

const temp = new URL(`.cme-link-status-${randomUUID()}.tmp.mjs`, import.meta.url);
const built = await build({
  stdin: { contents: 'export { default } from "../src/components/features/CMEResourcesSection.jsx";', resolveDir: new URL('.', import.meta.url).pathname },
  bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'test-context', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const useApp = () => globalThis.__cmeLinkContext;', loader: 'js' }));
  } }],
});
await writeFile(temp, built.outputFiles[0].text);
const { default: Resources } = await import(temp.href);
await unlink(temp);
const contextSource = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
const hookSource = contextSource.slice(contextSource.indexOf('export function useNotifications()')).replace(/^export /, '');

const dataWithLegacyStatus = status => ({
  settings: {
    degreeType: 'MD', specialties: [], notifyBrowser: true,
    cmeVerificationResults: Object.fromEntries(CME_PROVIDERS.map(p => [p.id, { status, checkedAt: '2026-09-19T12:00:00Z' }])),
    lastCmeVerification: '2026-09-19T12:00:00Z', cmeVerificationAlerted: true,
  },
  licenses: [], cme: [],
});

function render(data, initialTopicFilter) {
  globalThis.__cmeLinkContext = { data, theme: {}, allTrackedStates: [] };
  try { return renderToStaticMarkup(React.createElement(Resources, { initialTopicFilter })); }
  finally { delete globalThis.__cmeLinkContext; }
}

function runNotificationLifecycle(data, { credentialReminder = false, loaded = true } = {}) {
  const callbacks = [], effects = [], notifications = [], writes = [], requests = [];
  const sandbox = {
    useApp: () => ({ data, loaded, setData: change => writes.push(change) }),
    useState: value => [value, () => {}], useRef: value => ({ current: value }), useCallback: fn => fn,
    useEffect: fn => effects.push(fn),
    Notification: { permission: 'granted' },
    generateAlerts: () => credentialReminder ? { effectiveFreqDays: 1, fingerprint: 'credential-reminder' } : null,
    buildNotificationMessage: () => ({ shortText: 'Your license renewal is approaching.' }),
    fireBrowserNotification: (...args) => notifications.push(args),
    MS_PER_DAY: 86400000,
    setTimeout: fn => { callbacks.push(fn); return callbacks.length; }, clearTimeout: () => {},
    setInterval: fn => { callbacks.push(fn); return callbacks.length; }, clearInterval: () => {},
    document: { visibilityState: 'visible', addEventListener: (_event, fn) => callbacks.push(fn), removeEventListener: () => {} },
    // CSP, offline mode and provider refusal are deliberately indistinguishable to fetch.
    fetch: async (...args) => { requests.push(args); throw new TypeError('Failed to fetch'); },
  };
  runInNewContext(`${hookSource}\nuseNotifications();`, sandbox);
  const cleanups = effects.map(fn => fn());
  callbacks.forEach(fn => fn());
  cleanups.forEach(fn => fn?.());
  return { notifications, writes, requests };
}

test('legacy failures cannot label providers down or disable their direct links', () => {
  const data = dataWithLegacyStatus('unreachable');
  const before = JSON.stringify(data);
  const html = render(data);
  assert.equal(JSON.stringify(data), before, 'rendering must not delete or rewrite saved settings');
  assert.doesNotMatch(html, /Some links flagged|All reachable|Providers last verified|Verified reachable|Link may be down|Not yet verified/);
  assert.match(html, /Open a provider to check current courses, availability, pricing and credit details/);
  for (const provider of CME_PROVIDERS) {
    const escaped = provider.url.replaceAll('&', '&amp;');
    assert.ok(html.includes(`href="${escaped}" target="_blank" rel="noopener noreferrer"`), provider.id);
  }
});

test('timeout, opaque success, absent and malformed legacy results cannot assert availability', () => {
  const baseline = render(dataWithLegacyStatus('unreachable'));
  for (const status of ['timeout', 'ok', 'unknown']) assert.equal(render(dataWithLegacyStatus(status)), baseline);
  for (const results of [undefined, null, 'invalid']) {
    const data = dataWithLegacyStatus('ok');
    data.settings.cmeVerificationResults = results;
    assert.equal(render(data), baseline);
  }
});

test('topic navigation retains matching provider links without stale health labels', () => {
  const html = render(dataWithLegacyStatus('unreachable'), 'HIV/AIDS');
  const providers = CME_PROVIDERS.filter(p => p.topics.includes('HIV/AIDS'));
  assert.ok(providers.length > 0 && providers.length < CME_PROVIDERS.length);
  for (const p of providers) assert.ok(html.includes(`href="${p.url}"`), p.id);
  assert.doesNotMatch(html, /Link may be down|Some links flagged|Verified reachable/);
});

test('loaded notification lifecycle never probes external CME sites or sends availability alarms', () => {
  for (const lastCmeVerification of [null, '2000-01-01T00:00:00Z', '2026-09-19T12:00:00Z']) {
    const data = dataWithLegacyStatus('unreachable');
    data.settings.lastCmeVerification = lastCmeVerification;
    const before = JSON.stringify(data);
    const result = runNotificationLifecycle(data);
    assert.deepEqual(result, { notifications: [], writes: [], requests: [] });
    assert.equal(JSON.stringify(data), before);
  }
});

test('actual notification hook still emits a due credential reminder once', () => {
  const result = runNotificationLifecycle(dataWithLegacyStatus('unreachable'), { credentialReminder: true });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0][0], 'CredentialDOMD Alert');
  assert.equal(result.notifications[0][1], 'Your license renewal is approaching.');
  assert.deepEqual(result.requests, []);
  assert.deepEqual(runNotificationLifecycle(dataWithLegacyStatus('unreachable'), { loaded: false, credentialReminder: true }), { notifications: [], writes: [], requests: [] });
});
