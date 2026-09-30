// The persistence fixture: the real src/lib/supabase.js run in a node:vm realm
// with a recording, in-memory Supabase client. No network, production data or
// deployment is involved. Shared by the persistence tests.
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../../src/utils/limitedLaunchAccess.js';
import * as syncRules from '../../src/utils/syncRules.js';
import { LOCAL_ONLY_SETTINGS } from '../../src/constants/defaults.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

export const source = await readFile(process.env.PERSISTENCE_SOURCE_FILE || new URL('../../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (practice = true) => ({ schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: '2026-09-19T12:00:00Z', enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false }, practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: practice, export: true } },
});
// `supabaseJs` swaps in another @supabase/supabase-js (the real one, for tests
// that need its own request and header handling against a synthetic fetch).
export function fixture({ enabled = true, practice = true, supabaseJs = null } = {}) {
  let actor = 'user_syntheticA';
  const values = new Map(), requests = [];
  const clerk = { user: { id: actor }, session: { user: { id: actor }, getToken: async () => 'synthetic-token' } };
  const authority = createAccessAuthority({ enabled, currentAccount: () => actor, now: () => 0 });
  authority.reset(actor); authority.accept(actor, snapshot(practice));
  const f = { requests, values, authority, clerk, onRequest: async () => ({ error: null }),
    switchAccount(id = 'user_syntheticB') { actor = id; clerk.user = { id }; clerk.session = { user: { id }, getToken: async () => 'synthetic-token' }; authority.reset(id); authority.accept(id, snapshot()); },
  };
  const dispatch = async operation => { requests.push({ ...operation, actor }); return f.onRequest(operation); };
  function createClient(_url, _key, config) {
    const execute = async operation => {
      await config.accessToken?.();
      return config.global?.fetch ? config.global.fetch(operation) : dispatch(operation);
    };
    return { from(table) {
      const operation = { table, filters: [] };
      const q = { then: (resolve, reject) => execute(operation).then(resolve, reject) };
      // A select after a write asks for the written rows back (returning).
      for (const method of ['insert', 'update', 'upsert', 'delete', 'select']) q[method] = (value, options) => { if (!operation.method) { operation.method = method; operation.value = value; if (options !== undefined) operation.options = options; } else if (method === 'select') operation.returning = value ?? '*'; return q; };
      for (const method of ['eq', 'order', 'range', 'in']) q[method] = (...args) => { operation.filters.push([method, ...args]); return q; };
      q.maybeSingle = q.single = () => q;
      // The real builder's: a request the caller may cancel (a settings save that had no answer).
      q.abortSignal = signal => { operation.signal = signal; return q; };
      return q;
    }, storage: { from: bucket => ({ upload: (path, blob, options) => execute({ method: 'upload', bucket, path, blob, options }), remove: paths => execute({ method: 'remove', bucket, paths }), download: path => execute({ method: 'download', bucket, path }) }) } };
  }
  const imports = {
    '@supabase/supabase-js': supabaseJs || { createClient }, '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data', LOCAL_ONLY_SETTINGS },
    '../utils/syncRules.js': syncRules,
    // No data deletion purges anything here, so the purge fence never moves.
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor,
      adoptedLocalFence: () => undefined, localCopyCurrent: () => true, localFence: () => null },
    '../utils/limitedLaunchClient.js': { createLimitedLaunchClient() { throw Error('Continuity must be disabled'); } },
    '../utils/continuityRecovery.js': {},
    // Reached only from a sign-in receipt, which this continuity-disabled
    // fixture never has.
    '../utils/dataDeletion.js': { accountDataDeletedAt() { throw Error('Continuity must be disabled'); }, honorAccountDataDeletion() { throw Error('Continuity must be disabled'); } },
    '../utils/secretBox.js': { getLockCode: () => null, saveLockCode() {} },
    '../utils/founding.js': { foundingFromProfile: () => ({}) },
    '../utils/profileIssueDiagnostics.js': { profileInitializationError() { throw Error('Continuity must be disabled'); }, profileSupportReference: () => 'ID-TEST' },
    '../utils/limitedLaunchAccess.js': { accessAuthority: authority, allowsSettingsChange: (value, a = authority) => allowsSettingsChange(value, a), membershipWriteError,
      assertRecordWrite: (key, value, previous) => { if (!authority.allowsMutation(key, value, previous)) throw membershipWriteError(); } },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => { if (!imports[name]) throw Error(`Unexpected import ${name}`); return imports[name]; },
    window: { Clerk: clerk }, fetch: dispatch, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    console: { warn() {}, error() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout, AbortController,
  });
  vm.runInContext(code, context);
  f.api = module.exports;
  f.queue = (id = 'user_syntheticA') => JSON.parse(values.get(`ops:${id}`) || '[]');
  return f;
}
export const oldOp = (id, op = 'upsert', collectionKey = 'licenses') => ({ op, collectionKey, payload: op === 'upsert' ? { id, name: 'Synthetic' } : id, ts: 1 });
