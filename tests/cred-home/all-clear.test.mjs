// "All Clear" never shows while the ring on the same screen lists something
// that needs action (an undated licence, a CME state that is due). A renewal
// that is only snoozed still reads "Nothing to do today". Synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clearStateBanner, openActionItems } from '../../src/utils/clearState.js';
import { standingScore } from '../../src/utils/compliance.js';

test('an NPI-imported TX licence with no date and no CME is not All Clear', () => {
  const lic = { id: 'tx', type: 'State Medical License (MD)', state: 'TX' };
  const standing = standingScore({ items: [lic], missingRequired: [{ item: lic }], stateComps: [{ st: 'TX', comp: { fullyCompliant: false, daysLeft: null } }] });
  const open = openActionItems(standing.needsAction, []);
  assert.equal(open.length, 2, 'the undated licence and the CME state');
  assert.equal(clearStateBanner([], () => null, d => d, { openAction: open }), null);
});

test('a snoozed renewal in the window still reads Nothing to do today', () => {
  const lic = { id: 'co', type: 'State Medical License (MD)', state: 'CO', expirationDate: '2099-01-01' };
  const soon = { ...lic, expirationDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10) };
  const standing = standingScore({ items: [soon] });
  const open = openActionItems(standing.needsAction, [soon]);
  assert.equal(open.length, 0);
  const b = clearStateBanner([soon], () => '2099-10-05', d => d, { openAction: open });
  assert.equal(b.title, 'Nothing to do today');
});

test('Home gates the banner on the open action items', () => {
  const app = readFileSync(fileURLToPath(new URL('../../src/App.jsx', import.meta.url)), 'utf8');
  assert.match(app, /const openAction = openActionItems\(standing\.needsAction, snoozed\);/);
  assert.match(app, /const allClear = allCreds\.length > 0 && urgent\.length === 0 && clearState && \(/);
});
