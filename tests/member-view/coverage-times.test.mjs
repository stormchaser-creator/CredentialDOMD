// The member-consented and administrator views of a contract whose coverage
// blocks carry times (src/utils/coverageBlocks.js). Without the times, "Sep
// 25 to Sep 28" reads as four call days when the block is Sep 25 4:00 PM to
// Sep 28 7:00 AM: three. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeSnapshot } from '../../supabase/functions/_shared/memberView.mjs';
import { recordDetails } from '../../src/utils/memberViewer.js';

const originalTimezone = process.env.TZ;
process.env.TZ = 'America/Chicago';
test.after(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; });

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snapshot = () => shapeSnapshot({
  profile: { id: uuid(1), name: 'Synthetic Physician', degree_type: 'DO', access_status: 'active' },
  collections: {
    locumContracts: [{
      id: uuid(70), facility: 'Synthetic Regional Hospital', agency: 'Synthetic Staffing', day_start_hour: 7,
      coverage_periods: [
        { start: '2026-09-25', startTime: '16:00', end: '2026-09-28', endTime: '07:00', tz: 'America/Chicago', rate: 3000 },
        { start: '2026-11-05', end: '2026-11-11' },
      ],
    }],
  },
});

test('a timed block keeps its times and zone in the view, and nothing else it carries', () => {
  const [contract] = snapshot().sections.locumContracts;
  assert.deepEqual(contract.coveragePeriods, [
    { start: '2026-09-25', end: '2026-09-28', startTime: '16:00', endTime: '07:00', tz: 'America/Chicago' },
    { start: '2026-11-05', end: '2026-11-11' },
  ]);
});

test('the viewer reads a timed block the way the app lists it, and an untimed one as before', () => {
  const snap = snapshot();
  const [contract] = snap.sections.locumContracts;
  const periods = recordDetails('locumContracts', contract, snap).find(d => d.label === 'Coverage periods');
  assert.equal(periods.value, 'Sep 25, 4:00 PM to Sep 28, 7:00 AM; 2026-11-05 to 2026-11-11');
  // Read from another zone, the block is still on its own clock.
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(recordDetails('locumContracts', contract, snap).find(d => d.label === 'Coverage periods').value, 'Sep 25, 4:00 PM to Sep 28, 7:00 AM; 2026-11-05 to 2026-11-11');
  } finally { process.env.TZ = 'America/Chicago'; }
});
