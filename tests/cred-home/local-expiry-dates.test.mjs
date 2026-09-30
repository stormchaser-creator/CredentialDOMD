// A date-only expiration is a local calendar day: its countdown, color and
// Expired/Expiring split turn at local midnight, not at UTC midnight (5 pm
// the day before in California). Real modules, clock fixed, TZ Los Angeles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
process.env.TZ = 'America/Los_Angeles';

const entry = `
export { getStatusColor, getStatusLabel, daysUntil } from "${root}src/utils/helpers.js";
export { generateAlerts, activeAckFor } from "${root}src/utils/notifications.js";
export { standingScore, findStateLicense } from "${root}src/utils/compliance.js";
`;
const code = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } })).outputFiles[0].text;
const RealDate = Date;
const at = (y, m, d, h, min) => {
  const fixed = new RealDate(y, m - 1, d, h, min).getTime();
  class FixedDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'Date', code)(require, mod, mod.exports, FixedDate);
  return mod.exports;
};
const data = (lic, over = {}) => ({ settings: { reminderLeadDays: 90 }, licenses: [lic], cme: [], privileges: [], insurance: [], alertAcks: [], ...over });
const LIC = { id: 'lic', type: 'State Medical License (MD)', state: 'CO', expirationDate: '2026-09-30' };

test('5:30 pm on the last valid day: expires today, orange, not expired', () => {
  const m = at(2026, 9, 30, 17, 30);
  assert.equal(m.getStatusLabel('2026-09-30'), 'Expires today');
  assert.equal(m.getStatusColor('2026-09-30'), 'orange');
  assert.equal(m.daysUntil('2026-09-30'), 0);
  const a = m.generateAlerts(data(LIC));
  assert.deepEqual([a.expired.length, a.soon.length], [0, 1]);
  assert.equal(m.standingScore({ items: [LIC] }).needsAction[0].days, 0);
  assert.equal(m.findStateLicense([LIC], 'CO')?.id, 'lic', 'still the license in force');
});

test('half past midnight the next day: expired 1d ago', () => {
  const m = at(2026, 10, 1, 0, 30);
  assert.equal(m.getStatusLabel('2026-09-30'), 'Expired 1d ago');
  assert.equal(m.getStatusColor('2026-09-30'), 'red');
  const a = m.generateAlerts(data(LIC));
  assert.deepEqual([a.expired.length, a.soon.length], [1, 0]);
});

test('5:30 pm the day before: 1d left', () => {
  const m = at(2026, 9, 29, 17, 30);
  assert.equal(m.getStatusLabel('2026-09-30'), '1d left');
  assert.equal(m.daysUntil('2026-09-30'), 1);
});

test('an acknowledgment runs through its own last local day', () => {
  const m = at(2026, 9, 29, 18, 0);
  assert.ok(m.activeAckFor({ alertAcks: [{ itemId: 'lic', until: '2026-09-29' }] }, 'lic'), 'still quiet on its until date in the evening');
});
