// QA CRED-024 / CRED-014: the lab's full-page screenshots closed an open Add
// form and reset the NPI panel. Chromium takes a full-page capture by briefly
// resizing the page, and one resize event can read innerWidth 1 for about
// 15 ms. AppContext set isDesktop from every resize at once, so the app went
// to phone and back and remounted what the two layouts place differently.
// The flag now follows a settled, real width only (src/utils/deskBreakpoint.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESK_MIN_WIDTH, DESK_SETTLE_MS, deskFromWidth, initialDesk, watchDeskBreakpoint } from '../src/utils/deskBreakpoint.js';

/** A window whose clock the test moves by hand. */
function fakeWindow(width) {
  let now = 0, next = 1;
  const timers = new Map(), listeners = new Set();
  const win = {
    innerWidth: width,
    addEventListener(type, fn) { if (type === 'resize') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'resize') listeners.delete(fn); },
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  return {
    win, listeners,
    resize(w) { win.innerWidth = w; for (const fn of [...listeners]) fn(); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

test('the screenshot sequence (innerWidth 1, then the real width 15 ms later) changes nothing', () => {
  const w = fakeWindow(1280), seen = [];
  watchDeskBreakpoint(w.win, true, v => seen.push(v));
  w.resize(1); w.advance(15); w.resize(1280); w.advance(DESK_SETTLE_MS * 3);
  assert.deepEqual(seen, []);
});

test('a degenerate width that does not come back is still not a phone', () => {
  for (const width of [0, 1, 50, NaN, undefined]) {
    const w = fakeWindow(1280), seen = [];
    watchDeskBreakpoint(w.win, true, v => seen.push(v));
    w.resize(width); w.advance(DESK_SETTLE_MS * 3);
    assert.deepEqual(seen, [], `width ${width}`);
  }
});

test('a real crossing (an iPad turned, a window narrowed) flips once, after the width settles', () => {
  const w = fakeWindow(1180), seen = [];
  watchDeskBreakpoint(w.win, true, v => seen.push(v));
  w.resize(820);
  w.advance(DESK_SETTLE_MS - 1);
  assert.deepEqual(seen, [], 'not while it may still be moving');
  w.advance(1);
  assert.deepEqual(seen, [false], 'phone once settled');
  w.resize(1180); w.advance(DESK_SETTLE_MS);
  assert.deepEqual(seen, [false, true], 'and desk again');
});

test('a window dragged across 1024 and back in one motion does not flip at all', () => {
  const w = fakeWindow(1280), seen = [];
  watchDeskBreakpoint(w.win, true, v => seen.push(v));
  for (const width of [1200, 1100, 1000, 900, 980, 1050, 1150]) { w.resize(width); w.advance(16); }
  w.advance(DESK_SETTLE_MS);
  assert.deepEqual(seen, []);
});

test('a resize that stays on the same side never calls back', () => {
  const w = fakeWindow(1280), seen = [];
  watchDeskBreakpoint(w.win, true, v => seen.push(v));
  w.resize(1440); w.advance(DESK_SETTLE_MS);
  w.resize(DESK_MIN_WIDTH); w.advance(DESK_SETTLE_MS);
  assert.deepEqual(seen, []);
});

test('the cleanup removes the listener and a pending read', () => {
  const w = fakeWindow(1280), seen = [];
  const stop = watchDeskBreakpoint(w.win, true, v => seen.push(v));
  w.resize(700);
  stop();
  assert.equal(w.listeners.size, 0);
  assert.equal(w.pending(), 0);
  w.advance(DESK_SETTLE_MS * 2);
  assert.deepEqual(seen, []);
});

test('the breakpoint itself: 1024 is desk, 1023 is phone, a degenerate reading is neither', () => {
  assert.equal(deskFromWidth(1024), true);
  assert.equal(deskFromWidth(1023), false);
  assert.equal(deskFromWidth(320), false);
  assert.equal(deskFromWidth(1), null);
  assert.equal(initialDesk({ innerWidth: 1280 }), true);
  assert.equal(initialDesk({ innerWidth: 1 }), false, 'the first render on a degenerate reading is the phone, as before');
  assert.equal(initialDesk(undefined), false);
});

test('AppContext takes isDesktop from the settled watcher, never straight from a resize', async () => {
  const src = await readFile(new URL('../src/context/AppContext.jsx', import.meta.url), 'utf8');
  assert.match(src, /watchDeskBreakpoint\(window, firstDeskRef\.current, setIsDesktop\)/);
  assert.doesNotMatch(src, /setIsDesktop\(window\.innerWidth/, 'no unsettled read of the width');
  assert.equal((src.match(/setIsDesktop\b/g) || []).length, 2, 'declared once, handed to the watcher once');
});
