// Review of 9484782c: a running timer the device could keep at its start,
// then could not keep once the notes typed during the call made it larger.
// The later copies went to this tab's sessionStorage, and the reload after
// iOS discarded the app read the device's older copy first: the billing and
// private notes were lost, and the notice said the start time would be lost
// when it was the notes that were at risk. Real storageScope over a
// quota-limited localStorage. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';

class QuotaStorage {
  constructor(limit) { this.map = new Map(); this.limit = limit; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    const size = [...this.map].reduce((t, [key, val]) => t + (key === k ? 0 : key.length + val.length), 0) + k.length + String(v).length;
    if (size > this.limit) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}
globalThis.localStorage = new QuotaStorage(400);
globalThis.sessionStorage = new QuotaStorage(1e6);
const storageScope = await import('../../src/utils/storageScope.js');
storageScope.setActiveUserId('user_synthetic');
const { saveRunningTimer, loadRunningTimer, timerNotKeptNotice, timerStartKept } = await import('../../src/utils/runningTimerStore.js');

test('the notes typed after the device filled up survive the discard, and the notice says the notes are at risk, not the start', () => {
  globalThis.localStorage.setItem('filler', 'x'.repeat(230));
  const started = { contractId: 'c-1', type: 'Call', startedAt: '2026-09-29T15:00:00.000Z' };
  assert.equal(saveRunningTimer(started), 'device');
  const typed = { ...started, note: 'QA ED consult, head CT review '.repeat(3), privateNote: 'QA synthetic private note' };
  assert.equal(saveRunningTimer(typed), 'tab');
  // iOS discards the page; it loads again over the same storage.
  const back = loadRunningTimer();
  assert.equal(back.note, typed.note, 'the billing note typed during the call');
  assert.equal(back.privateNote, typed.privateNote);
  assert.equal(timerStartKept(typed), true);
  const said = timerNotKeptNotice('tab', typed.startedAt, { startKept: timerStartKept(typed) });
  assert.match(said, /could not save the notes on this timer on this phone, so they are kept only while the app stays open in this window\. Its start time is saved\./);
  assert.doesNotMatch(said, /storage is full|Free space/, 'nothing untrue, and nothing he cannot do');
  // A later save the device takes again is the one read.
  globalThis.localStorage.removeItem('filler');
  assert.equal(saveRunningTimer({ ...typed, note: 'QA shorter' }), 'device');
  assert.equal(loadRunningTimer().note, 'QA shorter');
});
