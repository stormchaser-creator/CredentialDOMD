// A membership the physician has ended is not renewed: it never alerts, is
// never in the ring, and is never emailed. A membership's reminder line names
// the society. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { remindable, reminderLabel } from '../../supabase/functions/_shared/reminderRows.mjs';
import { membershipEnded, lapsingRecords, credentialRecords } from '../../src/utils/alertItems.js';
import { standingScore } from '../../src/utils/compliance.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateAlerts } = await (async () => {
  const out = await build({ entryPoints: [`${root}src/utils/notifications.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();
const day = (n) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const base = { settings: { reminderLeadDays: 90 }, licenses: [], cme: [], privileges: [], insurance: [], alertAcks: [] };

test('an ended membership is not emailed; a current one is', () => {
  const t = 'professional_memberships';
  assert.equal(remindable({ organization: 'Synthetic Society', expiration_date: day(-10), end_date: day(-40) }, { table: t, today: day(0) }), false);
  assert.equal(remindable({ organization: 'Synthetic Society', expiration_date: day(10), end_date: day(0) }, { table: t, today: day(0) }), false, 'ended today');
  assert.equal(remindable({ organization: 'Synthetic Society', expiration_date: day(10), end_date: null }, { table: t, today: day(0) }), true);
  assert.equal(remindable({ organization: 'Synthetic Society', expiration_date: day(10), end_date: day(30) }, { table: t, today: day(0) }), true, 'ending later still renews until then');
  assert.equal(remindable({ expiration_date: day(10), end_date: day(-5) }, { table: 'licenses', today: day(0) }), true, 'only memberships use the rule');
  const src = readFileSync(`${root}supabase/functions/send-reminders/index.ts`, 'utf8');
  assert.match(src, /remindable\(r, \{ table: t\.table, today \}\)/);
});

test('an ended membership raises no alert and is not in the ring', () => {
  const ended = { id: 'm-end', organization: 'Synthetic Society', expirationDate: day(-10), endDate: day(-40) };
  const current = { id: 'm-now', organization: 'Other Society', expirationDate: day(20) };
  assert.equal(generateAlerts({ ...base, memberships: [ended] }), null);
  assert.deepEqual(generateAlerts({ ...base, memberships: [ended, current] }).soon.map(i => i.id), ['m-now']);
  assert.equal(membershipEnded(ended), true);
  const items = lapsingRecords(credentialRecords({ memberships: [ended, current] }));
  assert.deepEqual(items.map(i => i.id), ['m-now']);
  assert.deepEqual(standingScore({ items }).needsAction.map(n => n.item.id), ['m-now']);
  const app = readFileSync(`${root}src/App.jsx`, 'utf8');
  assert.match(app, /const lapsingCreds = useMemo\(\(\) => lapsingRecords\(allCreds\), \[allCreds\]\);/);
  assert.match(app, /items: lapsingCreds, missingRequired: missingExpiration, stateComps: ringComps,/);
  assert.match(app, /for \(const c of lapsingCreds\) \{/);
});

test('a membership reminder names the society and the membership type', () => {
  assert.equal(reminderLabel({ organization: 'Congress of Neurological Surgeons', role: 'Member', expiration_date: '2026-10-01' }, 'Memberships', 'Synthetic Physician'), 'Congress of Neurological Surgeons \u{B7} Member');
  assert.equal(reminderLabel({ organization: 'Congress of Neurological Surgeons' }, 'Memberships', 'Synthetic Physician'), 'Congress of Neurological Surgeons');
  assert.equal(reminderLabel({ expiration_date: '2026-10-01' }, 'Memberships', 'Synthetic Physician'), 'Memberships');
  assert.equal(reminderLabel({ name: 'Synthetic DEA', type: 'DEA Registration', state: 'CO' }, 'Licenses', 'Synthetic Physician'), 'Synthetic DEA \u{B7} DEA Registration \u{B7} CO', 'a named record reads as before');
});
