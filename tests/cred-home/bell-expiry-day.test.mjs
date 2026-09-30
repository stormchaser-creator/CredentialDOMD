// On its expiration day an item is counted once on the bell, not as both
// expired and expiring. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateAlerts } = await (async () => {
  const out = await build({ entryPoints: [`${root}src/utils/notifications.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', define: { 'import.meta.env': '{}' } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

test('a DEA registration whose expiration date is today is counted once', () => {
  const today = new Date().toISOString().slice(0, 10);
  const a = generateAlerts({
    settings: { reminderLeadDays: 90 }, licenses: [{ id: 'dea', type: 'DEA Registration', expirationDate: today }],
    cme: [], privileges: [], insurance: [], alertAcks: [],
  });
  const inExpired = a.expired.some(i => i.id === 'dea'), inSoon = a.soon.some(i => i.id === 'dea');
  assert.equal(Number(inExpired) + Number(inSoon), 1, 'in exactly one of expired and soon');
  assert.equal(a.count, 1);
  assert.ok(!Object.is(a.closestDays, -0));
});
