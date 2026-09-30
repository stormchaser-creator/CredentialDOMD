// Home, the bell and the reminder email watch the same records. Synthetic
// records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { credentialRecords, alertRecords, ALERT_SECTIONS } from '../../src/utils/alertItems.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const day = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const bundle = async (entry) => {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};
const data = (over = {}) => ({
  settings: { name: 'Synthetic Physician', degreeType: 'MD', reminderLeadDays: 90 },
  licenses: [], cme: [], privileges: [], insurance: [], caseLogs: [], healthRecords: [], education: [], customRecords: [], alertAcks: [],
  ...over,
});

test('a passport expiring in 20 days raises one in-app alert', async () => {
  const { generateAlerts } = await bundle('src/utils/notifications.js');
  const a = generateAlerts(data({ travelDocs: [{ id: 'pp', type: 'Passport', expirationDate: day(20) }] }));
  assert.ok(a, 'the bell has something to say');
  assert.equal(a.count, 1);
  assert.deepEqual(a.soon.map(i => [i.id, i._sec]), [['pp', 'travelDocs']]);
});

test('an expired screening and a membership renewal alert on the bell as they do on Home', async () => {
  const { generateAlerts } = await bundle('src/utils/notifications.js');
  const a = generateAlerts(data({
    screenings: [{ id: 'sc', name: 'Synthetic background check', expirationDate: day(-3) }],
    memberships: [{ id: 'mem', organization: 'Synthetic Society', expirationDate: day(30) }],
  }));
  assert.deepEqual(a.expired.map(i => [i.id, i._sec]), [['sc', 'screenings']]);
  assert.deepEqual(a.soon.map(i => [i.id, i._sec]), [['mem', 'memberships']]);
  assert.equal(a.count, 2);
});

test('the alert list covers every table the reminder email reads', () => {
  const src = readFileSync(`${root}supabase/functions/send-reminders/index.ts`, 'utf8');
  const tables = [...src.matchAll(/\{\s*table:\s*"([a-z_]+)"/g)].map(m => m[1]);
  assert.ok(tables.length >= 7, 'TABLES was read');
  const supa = readFileSync(`${root}src/lib/supabase.js`, 'utf8');
  const map = Object.fromEntries([...supa.slice(supa.indexOf('const TABLE_MAP')).matchAll(/^\s+([A-Za-z]+): "([a-z_]+)",/gm)].map(m => [m[2], m[1]]));
  for (const t of tables) {
    assert.ok(map[t], `${t} is a synced table`);
    assert.ok(ALERT_SECTIONS.includes(map[t]), `${t} (${map[t]}) is in the alert list`);
  }
  const everySection = Object.fromEntries(ALERT_SECTIONS.map(s => [s, [{ id: `${s}-1` }]]));
  assert.deepEqual([...new Set(alertRecords(everySection).map(i => i._sec))].sort(), [...ALERT_SECTIONS].sort());
});

test('travel documents and screenings alert but stay out of the standing ring list', () => {
  const d = data({ travelDocs: [{ id: 'pp' }], screenings: [{ id: 'sc' }], licenses: [{ id: 'l' }] });
  assert.deepEqual(credentialRecords(d).map(i => i.id), ['l']);
  assert.deepEqual(alertRecords(d).map(i => i.id), ['l', 'pp', 'sc']);
});

test('Home builds its alerts, and the rail badges, from the shared alert list', () => {
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(app, /const allCreds = useMemo\(\(\) => credentialRecords\(data\)/);
  assert.match(app, /const alertCreds = useMemo\(\(\) => alertRecords\(data, allCreds\)/);
  const memo = app.slice(app.indexOf('const { expired, soon, urgent, snoozed } = useMemo'), app.indexOf('// CME math breakdown'));
  assert.match(memo, /alertCreds\.filter/);
  assert.doesNotMatch(memo, /allCreds\.filter/);
});
