// The Notification Center, bell and banner (src/utils/notifications.js and
// NotificationCenter.jsx). Synthetic records only; the module is bundled with
// esbuild because its imports carry no extensions.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = async entry => {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};
const notifications = await bundle('src/utils/notifications.js');

// NOTIFY-002 (history): loadFromSupabase returns notificationLog newest
// first; addItem appends a new send at the end. slice(-5).reverse() showed
// the five OLDEST sends after a reload.
test('Notification History shows the five most recent sends, newest first, however the log is ordered', () => {
  assert.equal(typeof notifications.recentNotifications, 'function');
  const log = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, method: 'email', alertCount: 1, date: `2026-09-${String(10 + i).padStart(2, '0')}T13:00:00Z` }));
  const newestFirst = [...log].reverse();
  const want = ['n8', 'n7', 'n6', 'n5', 'n4'];
  assert.deepEqual(notifications.recentNotifications(newestFirst).map(l => l.id), want, 'as loaded from the cloud');
  assert.deepEqual(notifications.recentNotifications(log).map(l => l.id), want, 'as appended in this session');
  const undated = [{ id: 'x', createdAt: '2026-09-30T00:00:00Z' }, ...newestFirst];
  assert.equal(notifications.recentNotifications(undated)[0].id, 'x', 'a row without a date sorts by when it was created');
  assert.deepEqual(notifications.recentNotifications(null), []);
});

test('NotificationCenter renders the helper\'s list, keyed by id', async () => {
  const source = await readFile(new URL('../src/components/pages/NotificationCenter.jsx', import.meta.url), 'utf8');
  assert.match(source, /recentNotifications\(data\.notificationLog\)/);
  assert.doesNotMatch(source, /notificationLog \|\| \[\]\)\.slice\(-5\)\.reverse\(\)/);
});

// NOTIFY-002 (parity): Home listed membership renewals and CME gaps in states
// held only through a medical license; the Notification Center and the bell
// count left both out (generateAlerts walked fewer sections, and only the
// primary and picked states).
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const alertData = over => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', primaryState: 'TX', additionalStates: [], reminderLeadDays: 90 },
  licenses: [], cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [], memberships: [],
  ...over,
});
test('a membership renewal inside the lead window is in the Notification Center, as on Home', () => {
  const alerts = notifications.generateAlerts(alertData({ memberships: [{ id: 'm1', organization: 'Synthetic Society', expirationDate: day(20) }] }));
  assert.deepEqual(alerts?.soon.map(i => [i.id, i._sec]), [['m1', 'memberships']]);
});
test('a CME gap in a state held only through a medical license is listed', () => {
  const alerts = notifications.generateAlerts(alertData({ licenses: [{ id: 'ca', type: 'State Medical License (MD)', state: 'CA', expirationDate: day(60) }] }));
  assert.ok(alerts?.cmeIssues.some(ci => ci.state === 'CA'), JSON.stringify(alerts?.cmeIssues));
});
test('Home and the Notification Center walk the same sections', async () => {
  assert.equal(typeof notifications.alertableCreds, 'function');
  const secs = new Set(notifications.alertableCreds(alertData({ workHistory: [{ id: 'w' }], peerReferences: [{ id: 'r' }], malpracticeHistory: [{ id: 'mp' }], publications: [{ id: 'p' }], memberships: [{ id: 'm' }], customRecords: [{ id: 'c', categoryId: 'k' }] })).map(i => i._sec));
  for (const s of ['workHistory', 'peerReferences', 'malpracticeHistory', 'publications', 'memberships', 'customRecords']) assert.ok(secs.has(s), s);
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  // Home's alerts and generateAlerts (through alertableCreds) both walk
  // src/utils/alertItems.js alertRecords.
  assert.match(app, /alertRecords\(data, allCreds\)/, 'Home builds its list with the same helper');
  const src = await readFile(new URL('../src/utils/notifications.js', import.meta.url), 'utf8');
  assert.match(src, /return alertRecords\(data\);/);
});

// NOTIFY-003: the banner's snooze holds only while alerts.fingerprint equals
// the stored one, and each CME gap's part carried daysLeft, which changes
// every day: a 7-day snooze ended the next morning for anyone with a CME gap
// in the lead window. (The server overwriting the column was fixed on main,
// 12ab2d34.)
test('a CME gap keeps its fingerprint from one day to the next; a changed gap changes it', t => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T15:00:00Z') });
  t.after(() => mock.timers.reset());
  const data = alertData({ licenses: [{ id: 'tx', type: 'State Medical License (MD)', state: 'TX', expirationDate: '2026-11-30' }] });
  const today = notifications.generateAlerts(data);
  assert.ok(today?.cmeIssues.some(ci => ci.state === 'TX'), 'the fixture has a TX CME gap inside the lead window');
  const fp = today.fingerprint;
  for (const later of ['2026-10-02T15:00:00Z', '2026-10-03T15:00:00Z']) {
    mock.timers.setTime(Date.parse(later));
    assert.equal(notifications.generateAlerts(data).fingerprint, fp, later);
  }
  const renewed = alertData({ licenses: [{ id: 'tx', type: 'State Medical License (MD)', state: 'TX', expirationDate: '2026-12-15' }] });
  assert.notEqual(notifications.generateAlerts(renewed).fingerprint.split('|').find(p => p.startsWith('cme:')), fp.split('|').find(p => p.startsWith('cme:')),
    'a new renewal date is a changed gap');
  const issues = today.cmeIssues.find(ci => ci.state === 'TX').issues.length;
  assert.match(fp, new RegExp(`cme:TX:${issues}:2026-11-30`));
});
