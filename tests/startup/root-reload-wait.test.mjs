// Ticket c39ed1e5 (2026-11-10): an iPhone, online (its report reached the
// server), "Importing a module script failed." on the root app chunk, sent
// once with no signed-in id yet. The root loader's recovery reload is a
// network-first navigation (public/sw.js revalidates index.html past the
// HTTP cache), so on a slow phone connection it can take longer than the
// 5 s the loader used to wait. The loader then rejected while its own reload
// was still in flight: the crash screen showed and the error boundary sent
// the report, even though the reload was about to replace the page. iOS
// Safari fires no beforeunload, so the page cannot tell it is leaving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STARTUP_RELOAD_WAIT_MS, waitForStartupReload } from '../../src/utils/startupModule.js';

test('the root loader waits out a slow network-first reload before the error screen', () => {
  assert.ok(STARTUP_RELOAD_WAIT_MS >= 20000, `a reload on a slow phone connection needs more than ${STARTUP_RELOAD_WAIT_MS} ms`);
  assert.ok(STARTUP_RELOAD_WAIT_MS <= 60000, 'a refused reload still reaches the error screen and its Reload button');
});

test('the wait still ends on the error screen when the reload never replaces the page', async () => {
  const timers = [];
  const error = new TypeError('Importing a module script failed.');
  const waiting = waitForStartupReload(error, { setTimer: (fn, ms) => timers.push([fn, ms]) });
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], STARTUP_RELOAD_WAIT_MS);
  timers[0][0]();
  await assert.rejects(waiting, e => e === error);
});

test('AuthGate keeps Suspense through the reload with the shared wait, not a 5 s deadline', () => {
  const src = readFileSync(new URL('../../src/AuthGate.jsx', import.meta.url), 'utf8');
  assert.match(src, /if \(recovering\) return waitForStartupReload\(error\);/);
  assert.doesNotMatch(src, /reject\(error\), 5000\)/);
});
