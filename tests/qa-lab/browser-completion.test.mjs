import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { captureDownload, observeInitialSetupSave } from '../../qa-lab/e2e/support/browser-completion.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function pageFixture() {
  const context = new EventEmitter(), page = new EventEmitter();
  page.context = () => context;
  return { context, page };
}
const setup = { startedAt: '2026-09-30T23:00:00.000Z', progress: { done: 0, total: 5 } };
function response({ id = 'profile-a', filter = `eq.${id}`, status = 200, method = 'PATCH', payload = { setup_state: setup }, row = { id, setup_state: setup }, finished = async () => null } = {}) {
  return {
    status: () => status, finished, json: async () => row,
    request: () => ({ url: () => `http://127.0.0.1:55485/rest/v1/profiles?id=${filter}&select=*`, method: () => method, postDataJSON: () => payload }),
  };
}

test('initial setup readiness keeps a completed response observed before the waiter starts', async () => {
  const { page } = pageFixture(), receipt = observeInitialSetupSave(page);
  page.emit('response', response());
  await tick();
  assert.equal(await receipt.wait('profile-a', 50), true);
  receipt.dispose();
  assert.equal(page.listenerCount('response'), 0);
});

test('headers alone do not finish setup readiness; body completion and matching account are required', async () => {
  const { page } = pageFixture(), receipt = observeInitialSetupSave(page), body = deferred();
  page.emit('response', response({ finished: () => body.promise }));
  await assert.rejects(receipt.wait('profile-a', 5), /initial setup-state save/);
  body.resolve(null);
  assert.equal(await receipt.wait('profile-a', 50), true);
  receipt.dispose();
});

test('setup receipt comparison accepts JSONB object key ordering without weakening array order or values', async () => {
  const { page } = pageFixture(), receipt = observeInitialSetupSave(page);
  page.emit('response', response({ row: { id: 'profile-a', setup_state: { progress: { total: 5, done: 0 }, startedAt: setup.startedAt } } }));
  assert.equal(await receipt.wait('profile-a', 50), true);
  receipt.dispose();
});

for (const [label, args] of [
  ['other account', { id: 'profile-b' }],
  ['non-exact account filter', { filter: 'profile-a' }],
  ['failed save', { status: 500 }],
  ['profile read', { method: 'GET' }],
  ['unrelated settings', { payload: { name: 'Synthetic physician' } }],
  ['different returned account', { row: { id: 'profile-b', setup_state: setup } }],
  ['unconfirmed returned setup', { row: { id: 'profile-a', setup_state: { ...setup, startedAt: 'older' } } }],
  ['different returned progress', { row: { id: 'profile-a', setup_state: { ...setup, progress: { done: 5, total: 5 } } } }],
  ['failed body', { finished: async () => 'net::ERR_ABORTED' }],
]) {
  test(`initial setup readiness refuses ${label}`, async () => {
    const { page } = pageFixture(), receipt = observeInitialSetupSave(page);
    page.emit('response', response(args));
    await assert.rejects(receipt.wait('profile-a', 5), /initial setup-state save/);
    receipt.dispose();
  });
}

for (const where of ['original page', 'new child page']) {
  test(`download capture sees a synchronous handoff on the ${where} and removes listeners`, async () => {
    const { context, page } = pageFixture(), child = new EventEmitter(), file = { name: 'account.zip' };
    const got = await captureDownload(page, () => {
      if (where === 'new child page') context.emit('page', child);
      (where === 'new child page' ? child : page).emit('download', file);
    }, { timeoutMs: 50 });
    assert.equal(got, file);
    assert.equal(context.listenerCount('page'), 0);
    assert.equal(page.listenerCount('download'), 0);
    assert.equal(child.listenerCount('download'), 0);
  });
}

test('a popup alone is not a successful download', async () => {
  const { context, page } = pageFixture(), child = new EventEmitter();
  await assert.rejects(captureDownload(page, () => context.emit('page', child), { timeoutMs: 5 }), /No browser download/);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(child.listenerCount('download'), 0);
});

test('an existing unrelated page cannot satisfy download capture', async () => {
  const { context, page } = pageFixture(), other = new EventEmitter();
  await assert.rejects(captureDownload(page, () => other.emit('download', {}), { timeoutMs: 5 }), /No browser download/);
  assert.equal(context.listenerCount('page'), 0);
});

test('a click failure remains a failure and cleans up download listeners', async () => {
  const { context, page } = pageFixture();
  await assert.rejects(captureDownload(page, () => { throw Error('click refused'); }, { timeoutMs: 50 }), /click refused/);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('download'), 0);
});

test('the download deadline also bounds a stalled action', async () => {
  const { context, page } = pageFixture();
  await assert.rejects(captureDownload(page, () => new Promise(() => {}), { timeoutMs: 5 }), /No browser download/);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('download'), 0);
});
