import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = await readFile(new URL('../../src/hooks/useAdministratorAccessStatus.js', import.meta.url), 'utf8');
const code = transformSync(source, { format: 'cjs' }).code;
const tick = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

function fixture({ enabled = true } = {}) {
  const listeners = new Map(), timers = new Map(), requests = [], cells = [];
  let timerId = 0, cursor = 0;
  const effects = [];
  const context = { user: { id: 'owner-a' } };
  const window = {
    addEventListener(name, fn) { const handlers = listeners.get(name) || new Set(); handlers.add(fn); listeners.set(name, handlers); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  };
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, value => { cells[i].value = value; }]; },
    useEffect(fn, deps) {
      const i = cursor++, old = cells[i];
      if (old && deps.every((d, at) => Object.is(d, old.deps[at]))) return;
      cells[i] = { deps, cleanup: old?.cleanup };
      effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); });
    },
  };
  const module = { exports: {} };
  const imports = {
    react,
    '../context/AppContext': { useApp: () => context },
    '../utils/credentialPortalClient.js': {
      CREDENTIAL_PORTAL_ENABLED: enabled,
      credentialPortalRequest: () => new Promise((resolve, reject) => requests.push({ owner: context.user.id, resolve, reject })),
    },
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(imports[name], `Unexpected import: ${name}`); return imports[name];
  }, window, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  return {
    context, requests,
    render() { cursor = 0; const value = module.exports.useAdministratorAccessStatus(); for (const effect of effects.splice(0)) effect(); return value; },
    event(name, pointerId = 1) { for (const fn of listeners.get(name) || []) fn({ pointerId }); },
    tasks() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
    timerCount() { return timers.size; },
  };
}

test('late allowed status waits through pointerup and click, then becomes visible in a task', async () => {
  const f = fixture(); assert.equal(f.render(), false);
  f.event('pointerdown'); f.requests[0].resolve({ available: true }); await tick();
  assert.equal(f.render(), false, 'the card must not move the pressed control');
  f.event('pointerup'); await tick();
  assert.equal(f.render(), false, 'promise microtasks must not move the target before click');
  f.event('click'); assert.equal(f.render(), false);
  f.tasks(); assert.equal(f.render(), true);
  f.unmount(); assert.equal(f.listenerCount(), 0); assert.equal(f.timerCount(), 0);
});

test('a result arriving between pointerup and click also waits for the release task', async () => {
  const f = fixture(); f.render(); f.event('pointerdown'); f.event('pointerup');
  f.requests[0].resolve({ available: true }); await tick();
  assert.equal(f.render(), false); f.tasks(); assert.equal(f.render(), true); f.unmount();
});

test('multiple pointers and another press before the release task keep the menu stable', async () => {
  const f = fixture(); f.render(); f.event('pointerdown', 1); f.event('pointerdown', 2);
  f.requests[0].resolve({ available: true }); await tick();
  f.event('pointerup', 1); f.tasks(); assert.equal(f.render(), false);
  f.event('pointerup', 2); f.event('pointerdown', 3); f.tasks(); assert.equal(f.render(), false);
  f.event('pointercancel', 3); f.tasks(); assert.equal(f.render(), true); f.unmount();
});

test('window blur releases an abandoned gesture, and unmount cancels queued visibility', async () => {
  const f = fixture(); f.render(); f.event('pointerdown');
  f.requests[0].resolve({ available: true }); await tick();
  f.event('blur'); assert.equal(f.render(), false); f.tasks(); assert.equal(f.render(), true); f.unmount();
  const gone = fixture(); gone.render(); gone.event('pointerdown');
  gone.requests[0].resolve({ available: true }); await tick(); gone.event('pointerup');
  assert.equal(gone.timerCount(), 1); gone.unmount();
  assert.equal(gone.timerCount(), 0); assert.equal(gone.listenerCount(), 0); gone.tasks(); assert.equal(gone.render(), false);
});

test('account handoff hides prior access immediately and discards its deferred answer', async () => {
  const f = fixture(); f.render(); f.requests[0].resolve({ available: true }); await tick(); assert.equal(f.render(), true);
  f.event('pointerdown'); f.context.user = { id: 'owner-b' };
  assert.equal(f.render(), false, 'prior account state is never offered to the next account');
  f.event('pointerdown'); f.requests[1].resolve({ available: true }); await tick();
  f.context.user = { id: 'owner-c' }; assert.equal(f.render(), false);
  f.event('pointerup'); f.tasks(); assert.equal(f.render(), false, 'B deferred result was disposed');
  f.requests[2].resolve({ available: false }); await tick(); assert.equal(f.render(), false); f.unmount();
});

test('denied, failed, and disabled availability never insert an entry or retain listeners', async () => {
  for (const failure of [false, true]) {
    const f = fixture(); f.render(); f.event('pointerdown');
    if (failure) f.requests[0].reject(new Error('offline')); else f.requests[0].resolve({ available: false });
    await tick(); assert.equal(f.render(), false); f.event('pointerup'); f.tasks(); assert.equal(f.render(), false);
    f.unmount(); assert.equal(f.listenerCount(), 0); assert.equal(f.timerCount(), 0);
  }
  const disabled = fixture({ enabled: false }); assert.equal(disabled.render(), false);
  assert.equal(disabled.requests.length, 0); assert.equal(disabled.listenerCount(), 0);
});
