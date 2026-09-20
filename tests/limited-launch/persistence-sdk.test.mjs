import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';

const source = await readFile(new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: {
  'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }),
} }).code;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Real Supabase SDK authentication and request serialization; the supplied
// fetch records synthetic requests only and never invokes a network transport.
function fixture({ switchAfterToken = false } = {}) {
  let actor = 'user_syntheticA';
  const requests = [], values = new Map();
  const clerk = { user: { id: actor }, session: { user: { id: actor }, getToken: async () => 'synthetic-token-A' } };
  const authority = createAccessAuthority({ enabled: false, currentAccount: () => actor });
  const switchAccount = () => {
    actor = 'user_syntheticB'; clerk.user = { id: actor };
    clerk.session = { user: { id: actor }, getToken: async () => 'synthetic-token-B' };
  };
  const imports = {
    '@supabase/supabase-js': { createClient: (url, key, options) => {
      if (switchAfterToken && options.global?.fetch) {
        const original = options.accessToken;
        options.accessToken = async () => { const token = await original(); switchAccount(); return token; };
      }
      return createClient(url, key, options);
    } },
    '../constants/defaults': { STORAGE_KEY: 'synthetic-data' },
    '../utils/storageScope': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor },
    '../utils/founding': { foundingFromProfile: () => ({}) },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: value => allowsSettingsChange(value, authority), membershipWriteError },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name],
    window: { Clerk: clerk }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    fetch: async (url, options) => {
      requests.push({ url: String(url), method: options.method, headers: new Headers(options.headers), actor });
      return new Response(null, { status: 204 });
    },
    console: { warn() {} }, crypto, Date, Blob, atob,
  });
  vm.runInContext(code, context);
  return { api: module.exports, requests, values, clerk, switchAccount };
}

test('real SDK cannot dispatch a write whose token resolves after account switch', async () => {
  const f = fixture();
  let release;
  f.clerk.session.getToken = () => new Promise(resolve => { release = resolve; });
  const writing = f.api.updateItem('profileA', 'licenses', { id: 'license' });
  await tick(); f.switchAccount(); release('synthetic-late-token-A');
  await assert.rejects(writing, error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.values.size, 0);
});

test('real SDK fetch boundary checks owner again after obtaining the token', async () => {
  const f = fixture({ switchAfterToken: true });
  await assert.rejects(f.api.updateItem('profileA', 'licenses', { id: 'license' }), error => error.code === 'membership_account_changed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.values.size, 0);
});

test('real SDK still sends a normal owner-bound update with its captured token', async () => {
  const f = fixture();
  await f.api.updateItem('profileA', 'licenses', { id: 'license', name: 'Synthetic' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].actor, 'user_syntheticA');
  assert.equal(f.requests[0].method, 'PATCH');
  assert.equal(f.requests[0].headers.get('authorization'), 'Bearer synthetic-token-A');
  assert.ok(f.requests[0].url.includes('user_id=eq.profileA'));
  assert.equal(f.values.size, 0);
});
