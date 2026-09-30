// The desk tiles beside the ring partition what can lapse: Active,
// Expiring, Expired and No date add up to credStats.total. An acknowledged
// renewal is already inside Expiring or Expired, so it gets no tile of its
// own (it is listed under Action Required).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../../src/App.jsx', import.meta.url)), 'utf8');
const tiles = app.slice(app.indexOf('const heroTiles = ['), app.indexOf('];', app.indexOf('const heroTiles = [')));

test('the desk hero has exactly the four partition tiles', () => {
  const keys = [...tiles.matchAll(/key: "([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(keys, ['active', 'expiring', 'expired', 'undated']);
  assert.doesNotMatch(tiles, /snoozed\.length/, 'no Snoozed tile double-counting acknowledged items');
});

test('the four tiles are the credStats parts that make up its total', () => {
  assert.match(app, /return \{ active, expiring, expired, undated, total: active \+ expiring \+ expired \+ undated \};/);
  for (const k of ['active', 'expiring', 'expired', 'undated']) assert.match(tiles, new RegExp(`value: credStats\\.${k},`));
});
