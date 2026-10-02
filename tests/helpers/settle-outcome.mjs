// A settle that waits for the outcome, bounded, instead of a fixed number of
// event-loop turns. Not a test file itself.
//
// A fixed number of setImmediate turns races anything that finishes on a
// timer or on a file read: a fake FileReader that fails on setTimeout, the
// harness's FileReader over a real Blob (Blob.arrayBuffer and text resolve
// from another thread), a module that waits a few milliseconds. On a slow
// runner the turns can end first, and the test fails although the code is
// right (CI, a6a00f5b; fixed for one test in 5c53366d). This counts what is
// still under way in this process, a real timer due within SHORT_TIMER_MS
// and a Blob or File read, and keeps turning until none is left, or until
// the deadline, after which the test's own assertions decide as before.
//
// A timer set further out (a 300 ms debounce, a retry after seconds, a
// transaction timeout) is not waited for: a test that asserts what shows
// before it fires still sees that. Timers a test hands its component itself
// (tests/component-harness.mjs `timers`) are the test's to run.
//
// Proof: RACE_DELAY_MS (tests/helpers/race-delay.mjs, loaded with --import)
// delays every real timer and Blob read; the tests that use this settle pass
// with it, and with the fixed-turn settle they failed.
const SHORT_TIMER_MS = 50;
const STATE = Symbol.for('credentialdomd.test.settleOutcome');

function install() {
  if (globalThis[STATE]) return globalThis[STATE];
  const state = { timers: new Set(), reads: 0, realSetTimeout: globalThis.setTimeout, realClearTimeout: globalThis.clearTimeout };
  const realSet = state.realSetTimeout, realClear = state.realClearTimeout;
  function trackedSetTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function') return realSet(fn, ms, ...args);
    const handle = realSet(function fire(...a) { state.timers.delete(handle); return fn.apply(this, a); }, ms, ...args);
    if (!(Number(ms) > SHORT_TIMER_MS)) state.timers.add(handle);
    return handle;
  }
  for (const key of Object.getOwnPropertySymbols(realSet)) trackedSetTimeout[key] = realSet[key];
  globalThis.setTimeout = trackedSetTimeout;
  globalThis.clearTimeout = function trackedClearTimeout(handle) { state.timers.delete(handle); return realClear(handle); };
  if (typeof Blob === 'function') {
    for (const name of ['arrayBuffer', 'text', 'bytes']) {
      const orig = Blob.prototype[name];
      if (typeof orig !== 'function') continue;
      Blob.prototype[name] = function trackedRead(...a) {
        state.reads += 1;
        let done = false;
        const finish = () => { if (!done) { done = true; state.reads -= 1; } };
        try {
          const out = orig.apply(this, a);
          Promise.resolve(out).then(finish, finish);
          return out;
        } catch (error) { finish(); throw error; }
      };
    }
  }
  globalThis[STATE] = state;
  return state;
}
const state = install();

/** Timers due within SHORT_TIMER_MS and Blob reads still under way in this process. */
export function pendingWork() { return { timers: state.timers.size, reads: state.reads }; }

/**
 * `turns` setImmediate turns, then more while a short timer or a file read is
 * still under way, until `timeoutMs` has passed.
 */
export async function settleOutcome(turns = 60, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
    if (!state.timers.size && !state.reads) return;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => state.realSetTimeout(resolve, 1));
  }
}

/** Turn until `done()` is true, bounded by `timeoutMs`; resolves whether it became true. */
export async function until(done, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
    if (!state.timers.size && !state.reads) continue;
    await new Promise((resolve) => state.realSetTimeout(resolve, 1));
  }
}
