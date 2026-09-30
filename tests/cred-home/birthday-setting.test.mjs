// The birth month and day (ACCME's learner match field) stays on the device
// and survives the next online load. Synthetic settings only.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
  clear: () => { store.clear(); },
};
globalThis.window ??= {};

const { LOCAL_ONLY_SETTINGS, withLocalOnlySettings, settingsToProfileRow, profileRowToSettings } = await import('../../src/lib/supabase.js');
const { DEFAULT_DATA, DEFAULT_SETTINGS } = await import('../../src/constants/defaults.js');

test('the birthday never goes into the profile row', () => {
  const row = settingsToProfileRow({ name: 'Synthetic Physician', birthMonthDay: '07-14' });
  assert.ok(!Object.values(row).includes('07-14'));
  assert.ok(LOCAL_ONLY_SETTINGS.includes('birthMonthDay'), 'so it is carried on the device instead');
  assert.ok(!('birthMonthDay' in DEFAULT_SETTINGS), 'a default would stop the carry');
});

test('an online load keeps the birthday the device holds', () => {
  const cloud = profileRowToSettings({ name: 'Synthetic Physician', theme: 'dark' });
  // AppContext's load: defaults, then the cloud row, then the device-only keys.
  const merged = withLocalOnlySettings({ ...DEFAULT_DATA.settings, ...cloud }, { name: 'Synthetic Physician', birthMonthDay: '07-14' });
  assert.equal(merged.birthMonthDay, '07-14');
});
