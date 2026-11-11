// Ticket c39ed1e5 (2026-11-10): the root app chunk threw "Importing a module
// script failed." straight to the error boundary instead of recovering on
// its own. src/utils/startupModule.js's recoverStartupModule sets a
// once-per-build sessionStorage guard before reloading so a cold-start
// failure gets exactly one retry, but nothing ever lifts that guard once the
// reload succeeds and the real app mounts -- so a later, unrelated
// module-load failure in the same tab/build/session is never retried and
// goes straight to the error UI instead of getting its own reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as startupModule from '../../src/utils/startupModule.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
  };
}

test('a later chunk-load failure in the same build gets its own retry after an earlier one recovered', () => {
  const storage = fakeStorage();
  const build = 'build-20261110T2125-1a3426a';
  const chunkError = new TypeError('Importing a module script failed.');
  let reloads = 0;
  const reload = () => { reloads += 1; };

  const firstRecovered = startupModule.recoverStartupModule(chunkError, {
    storage, reload, online: true, build,
  });
  assert.equal(firstRecovered, true);
  assert.equal(reloads, 1);

  // The reload worked and the real App component mounted -- that is the
  // signal that this build's chunk is good again, so the guard should lift.
  startupModule.clearStartupModuleGuard?.(storage, build);

  // A second, unrelated module-load failure later in the same session/build
  // must still get its own retry instead of being thrown to the error screen.
  const secondRecovered = startupModule.recoverStartupModule(chunkError, {
    storage, reload, online: true, build,
  });
  assert.equal(secondRecovered, true);
  assert.equal(reloads, 2);
});
