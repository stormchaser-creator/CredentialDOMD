// A synthetic Supabase client for src/lib/supabase.js, loaded in a vm with
// every import replaced (the shape tests/limited-launch/persistence.test.mjs
// uses). Each request the module makes is recorded; f.onRequest answers it.
// Not a test file itself. Synthetic ids only; no network.
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { createAccessAuthority, allowsSettingsChange, membershipWriteError } from '../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../supabase/functions/_shared/accessPolicy.mjs';
import * as syncRules from '../src/utils/syncRules.js';
import { LOCAL_ONLY_SETTINGS } from '../src/constants/defaults.js';

const source = await readFile(new URL('../src/lib/supabase.js', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'js', format: 'cjs', define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public' }) } }).code;
const snapshot = () => ({ schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  evaluatedAt: '2026-09-19T12:00:00Z', enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: 'core', billingEnabled: false,
  lifetime: { credential: false, practice: false }, practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: true, export: true } },
});

export const TARGET = 'user_syntheticTarget';   // the account signed in now
export const SOURCE = 'user_syntheticSource';   // the account the file was uploaded under, before the bind

export function fixture() {
  const actor = TARGET;
  const values = new Map(), requests = [], warnings = [];
  const clerk = { user: { id: actor }, session: { user: { id: actor }, getToken: async () => 'synthetic-token' } };
  const authority = createAccessAuthority({ enabled: true, currentAccount: () => actor, now: () => 0 });
  authority.reset(actor); authority.accept(actor, snapshot());
  // `clerk.session = null`: Clerk could not mint a token (a resume from Mail).
  const f = { requests, values, warnings, clerk, onRequest: async () => ({ data: null, error: null }) };
  const dispatch = async operation => { requests.push(operation); return f.onRequest(operation); };
  // Every client the module makes, with its settings (a test reads the
  // keepalive fetch the share stamp's own client uses).
  f.clients = [];
  function createClient(_url, _key, config) {
    f.clients.push(config);
    const execute = async operation => { await config.accessToken?.(); return dispatch({ ...operation, client: f.clients.indexOf(config) }); };
    return { rpc: (name, args) => ({ then: (resolve, reject) => execute({ method: 'rpc', name, args, filters: [] }).then(resolve, reject) }), from(table) {
      const operation = { table, filters: [] };
      const q = { then: (resolve, reject) => execute(operation).then(resolve, reject) };
      for (const method of ['insert', 'update', 'upsert', 'delete', 'select']) q[method] = value => { if (!operation.method) { operation.method = method; operation.value = value; } return q; };
      for (const method of ['eq', 'order', 'range', 'ilike', 'in', 'not', 'limit', 'or', 'gte', 'lte']) q[method] = (...args) => { operation.filters.push([method, ...args]); return q; };
      q.maybeSingle = q.single = () => q;
      return q;
    }, storage: { from: bucket => ({ upload: (path, blob) => execute({ method: 'upload', bucket, path, blob }), remove: paths => execute({ method: 'remove', bucket, paths }) }) } };
  }
  const imports = {
    '@supabase/supabase-js': { createClient }, '../constants/defaults.js': { STORAGE_KEY: 'synthetic-data', LOCAL_ONLY_SETTINGS },
    '../utils/syncRules.js': syncRules,
    // No data deletion purges anything here, so the purge fence never moves.
    '../utils/storageScope.js': { BASE_KEYS: { pendingOps: 'ops' }, DEVICE_KEYS_BASE: 'device', getActiveUserId: () => actor,
      adoptedLocalFence: () => undefined, localCopyCurrent: () => true, localFence: () => null,
      // The queue's write (storageScope makes room first in the app).
      setItemMakingRoom: (key, value) => values.set(key, value) },
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
    // fetch: what the module's own fetch calls send; the options of each are
    // kept too (f.fetchOptions), as the request records only the first argument.
    window: { Clerk: clerk }, fetch: (input, init) => { (f.fetchOptions ||= []).push(init ?? null); return dispatch(input); }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    console: { warn: (...a) => warnings.push(a.join(' ')), error() {} }, Blob, atob, crypto, Date, setTimeout, clearTimeout,
  });
  vm.runInContext(code, context);
  f.api = module.exports;
  f.removed = () => requests.filter(r => r.method === 'remove').flatMap(r => r.paths);
  return f;
}

