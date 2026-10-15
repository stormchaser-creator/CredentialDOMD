// The real Setup hook under React hands bookkeeping to the membership-aware
// writer before Home unmounts. The real writer's network/access boundary is
// tested in limited-launch/no-answer-settings; this test covers the handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { loadScreens } from '../harness/component-harness.mjs';
import { installLiveDom } from '../harness/live-dom.mjs';
import { DEFAULT_DATA } from '../../src/constants/defaults.js';

const { useSetupState } = await loadScreens('export { useSetupState } from "./src/components/features/setup/useSetupState.js";');
const { doc } = installLiveDom();
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let mounted;
function fixture(access = null) {
  const writes = [];
  const app = {
    data: structuredClone(DEFAULT_DATA), user: { id: 'user_SyntheticSetup' },
    isPro: true, isFreeBeta: false, hasSubscription: true, subLoading: false,
    loaded: true, loadedFrom: 'cloud', limitedLaunch: { enabled: true, access },
    updateSettings(patch, options) {
      writes.push({ patch, options });
      if (!app.limitedLaunch.access) return false;
      app.data = { ...app.data, settings: { ...app.data.settings, ...patch } };
      return true;
    },
  };
  globalThis.__screen = { app, storage: {}, vault: {} };
  let force, api;
  function Page() {
    const [, tick] = React.useState(0);
    force = () => tick(n => n + 1);
    api = useSetupState();
    return null;
  }
  const host = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(Page)));
  mounted = { app, writes, get api() { return api; }, render: () => flushSync(() => force()),
    unmount() { flushSync(() => root.unmount()); host.parentNode?.removeChild(host); } };
  return mounted;
}
test.afterEach(() => { mounted?.unmount(); mounted = null; });

for (const leaveBeforeDebounce of [true, false]) {
  test(`pending membership: automatic start/progress reach the writer ${leaveBeforeDebounce ? 'when Home unmounts' : 'after the debounce'}`, async () => {
    const f = fixture();
    const originalRecords = f.app.data;
    if (leaveBeforeDebounce) { f.unmount(); mounted = null; }
    else await sleep(1400);
    assert.equal(f.writes.length, 1, 'one coalesced handoff must survive leaving Home');
    const { patch, options } = f.writes[0];
    assert.equal(options.automaticSetup, true);
    assert.deepEqual(Object.keys(patch), ['setupState']);
    assert.ok(patch.setupState.startedAt);
    assert.ok(patch.setupState.progress?.t1);
    assert.ok(patch.setupState.progress?.t2);
    assert.equal(f.app.data, originalRecords, 'handoff is not proof of persistence when the writer refuses it');
  });
}

test('manual setup declaration before an answer still reaches the refusing writer as manual', async () => {
  const f = fixture();
  flushSync(() => f.api.skip('dea'));
  await sleep(1400);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].options.automaticSetup, false);
  assert.equal(f.writes[0].patch.setupState.tasks.dea.s, 'skipped');
  assert.ok(!f.app.data.settings.setupState, 'a refused draft was not claimed saved');
});
