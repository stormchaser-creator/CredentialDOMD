// Home's CME math modal sorts entries into "counted" and "not counting" with
// the engine's own window test, so an entry dated on the window's first day
// is counted in the list as it is in the total. Synthetic entries only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeCompliance, splitByCycle } from '../../src/utils/compliance.js';

test('a first-day entry is listed as counted, in Los Angeles and Chicago', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'America/Chicago']) {
      process.env.TZ = zone;
      const cme = [
        { id: 'a', date: '2024-11-30', hours: 10, category: 'AMA PRA Category 1' },
        { id: 'b', date: '2025-06-01', hours: 5, category: 'AMA PRA Category 1' },
        { id: 'c', date: '2024-11-29', hours: 1, category: 'AMA PRA Category 1' },
        { id: 'd', date: '2026-12-01', hours: 1, category: 'AMA PRA Category 1' },
        { id: 'e', hours: 1, category: 'AMA PRA Category 1' },
      ];
      const comp = computeCompliance(cme, 'TX', 'MD', { licenseExpiration: '2026-11-30' });
      assert.equal(comp.totalEarned, 15, zone);
      const { inWin, outWin } = splitByCycle(cme, comp.windowStart, comp.windowEnd);
      assert.deepEqual(inWin.map(c => c.id), ['a', 'b'], zone);
      assert.deepEqual(outWin.map(c => [c.id, c._bucket]), [['c', 'before'], ['d', 'after'], ['e', 'undated']], zone);
    }
  } finally { process.env.TZ = tz; }
});

test('the modal uses the shared split and says why an entry does not count', () => {
  const app = readFileSync(fileURLToPath(new URL('../../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /splitByCycle\(data\.cme, comp\.windowStart, comp\.windowEnd\)/);
  assert.match(app, /before this cycle opened/);
  assert.match(app, /after this renewal closes/);
  assert.doesNotMatch(app, /outside the cycle window/);
});
