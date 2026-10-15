import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockServer } from '../../qa-lab/mocks/server.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';
import { SAVE_AFTER_MS } from '../../qa-lab/mocks/store.mjs';

test('closing an embedded mock flushes its final state before its private directory is removed', { timeout: 5000 }, async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'qa-mock-close-'));
  const mock = createMockServer({ port: 0, appOrigin: 'http://127.0.0.1:1', supabaseUrl: 'http://127.0.0.1:1',
    stateDir, secrets: generateLabSecrets(), env: {}, serviceRoleKey: '', log() {} });
  t.after(async () => {
    if (mock.server.listening) await new Promise(resolve => mock.server.close(resolve));
    mock.store.flush(); await rm(stateDir, { recursive: true, force: true });
  });
  await mock.listen();
  mock.store.update(state => state.telegram.push({ text: 'synthetic shutdown marker' }));
  await new Promise(resolve => mock.server.close(resolve));
  const saved = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'));
  assert.equal(saved.telegram.at(-1).text, 'synthetic shutdown marker');
  await rm(stateDir, { recursive: true });
  // No delayed write may recreate state or throw after the close callback.
  await new Promise(resolve => setTimeout(resolve, SAVE_AFTER_MS + 20));
});
