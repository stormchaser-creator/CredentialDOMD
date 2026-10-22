// Addresses in the exports and on a shared record: Home then Work, oldest
// first, with Present for a current one. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCredentialText, describeItem } from '../src/utils/helpers.js';
import { buildCredentialRows } from '../src/utils/credentialExport.js';
import { recordCounts } from '../src/utils/dataCounts.js';
import { COLLECTION_KEYS } from '../src/lib/supabase.js';
import { isStarrable } from '../src/utils/favorites.js';

const home1 = { id: 'h1', kind: 'home', street: '9 Old St', city: 'Boulder', state: 'CO', postalCode: '80301', startDate: '2018-01-01', endDate: '2021-06-30' };
const home2 = { id: 'h2', street: '1 Now Rd', city: 'Denver', state: 'CO', startDate: '2021-06-30', isCurrent: true, notes: 'private' };
const work1 = { id: 'w1', kind: 'work', placeName: 'Synthetic General Hospital', street: '100 Clinic Way', city: 'Aurora', state: 'CO', startDate: '2019-07-01', endDate: '2022-06-30' };
const work2 = { id: 'w2', kind: 'work', placeName: 'Example Spine Practice', city: 'Denver', state: 'CO', startDate: '2022-07-01', isCurrent: true };

test('the credential export lists Home then Work, each oldest first, Present for current', () => {
  const rows = buildCredentialRows({ addressHistory: [work2, home2, work1, home1] }).filter(r => /Address$/.test(r.Type));
  assert.deepEqual(rows.map(r => r.Type), ['Home Address', 'Home Address', 'Work Address', 'Work Address']);
  assert.deepEqual(rows.map(r => r['Issue Date']), ['2018-01-01', '2021-06-30', '2019-07-01', '2022-07-01']);
  assert.deepEqual(rows.map(r => r['Expiration Date']), ['2021-06-30', 'Present', '2022-06-30', 'Present']);
  assert.deepEqual(rows.map(r => r.Status), ['Past', 'Current', 'Past', 'Current']);
  assert.equal(rows[2].Credential, 'Synthetic General Hospital, 100 Clinic Way, Aurora, CO');
  assert.equal(rows[1].Notes, '', 'notes stay out unless private notes are asked for, as for every other record');
  assert.equal(buildCredentialRows({ addressHistory: [home2] }, { privateNotes: true }).find(r => r.Type === 'Home Address').Notes, 'private');
});

test('a shared address says Home or Work, its place, and From and To', () => {
  const work = buildCredentialText(work2, 'addressHistory', { name: 'Synthetic Physician' });
  assert.match(work, /Type: Work/);
  assert.match(work, /Place: Example Spine Practice/);
  assert.match(work, /To: Present/);
  const home = buildCredentialText(home1, 'addressHistory', { name: 'Synthetic Physician' });
  assert.match(home, /Type: Home/);
  assert.doesNotMatch(home, /Place:/);
});

test('a work address card is named by its place; a home by its street', () => {
  assert.match(describeItem(work1, '', 'addressHistory'), /Synthetic General Hospital/);
  assert.match(describeItem(home1, '', 'addressHistory'), /9 Old St/);
});

test('addresses are counted on Data & Backup and can be starred', () => {
  const c = recordCounts({ addressHistory: [home1, work1] }, COLLECTION_KEYS).find(x => x.key === 'addressHistory');
  assert.deepEqual(c, { key: 'addressHistory', label: 'Addresses', count: 2 });
  assert.ok(isStarrable('addressHistory'));
});
