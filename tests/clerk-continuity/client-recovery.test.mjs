import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createContinuityBinding, recoverContinuity, continuityJournalKey, createLocalContinuityStorage,
  PRODUCTION_CLERK_ISSUER, DEVELOPMENT_CLERK_ISSUER, CONTINUITY_RECEIPT_MAX_AGE_MS, retireContinuityRecovery,
} from '../../src/utils/continuityRecovery.js';
import { BASE_KEYS, DEVICE_KEYS_BASE, WIPE_SEEN_KEY, CONTINUITY_RETIREMENT_BASE,
  purgeUserStorage, purgeForSignOut } from '../../src/utils/storageScope.js';
import { configureSecretContinuity, setSecretUser, encryptSecret, decryptSecret } from '../../src/utils/secretBox.js';

const current = 'user_ProdA', legacy = 'user_DevA';
const receipt = () => ({ schemaVersion: 1, profileId: '00000000-0000-4000-8000-000000000001', subject: current,
  issuer: PRODUCTION_CLERK_ISSUER, continuity: { id: '00000000-0000-4000-8000-000000000002', sourceSubject: legacy,
    sourceIssuer: DEVELOPMENT_CLERK_ISSUER, state: 'bound' } });
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function fixture(subject = current) {
  const state = { subject, session: {}, now: 1000 }, values = new Map(), writes = [], effects = [];
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, String(value)); effects.push({ kind: 'set', key }); },
    removeItem(key) { values.delete(key); effects.push({ kind: 'remove', key }); },
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { storage: { remove: async key => { effects.push({ kind: 'nativeRemove', key }); } } } });
  const session = state.session;
  const options = { subject, issuer: PRODUCTION_CLERK_ISSUER, session, authenticatedAt: state.now,
    now: () => state.now, isCurrent: pinned => pinned.subject === state.subject && pinned.session === state.session };
  const proof = receipt(); proof.subject = subject;
  const binding = createContinuityBinding(proof, options);
  const storage = {
    read: key => values.get(key) ?? null,
    compareAndSet(key, expected, value, check) {
      check(); if ((values.get(key) ?? null) !== expected) return false;
      check(); values.set(key, value); writes.push({ key, value }); return true;
    },
  };
  return { state, values, writes, effects, localStorage, proof, options, binding, storage,
    source: base => `${base}:${legacy}`, target: base => `${base}:${subject}`,
    recover: extra => recoverContinuity(binding, { storage, ...extra }),
  };
}
test.afterEach(() => {
  configureSecretContinuity(null); setSecretUser(null);
  for (const [key, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

let reloadCount = 0;
async function reloadedRecovery() {
  const scopeUrl = new URL(`../../src/utils/storageScope.js?retirement-test=${++reloadCount}`, import.meta.url).href;
  const source = await readFile(new URL('../../src/utils/continuityRecovery.js', import.meta.url), 'utf8');
  const recovery = await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll("'./storageScope.js'", JSON.stringify(scopeUrl))).toString('base64')}`);
  return { recovery, scope: await import(scopeUrl) };
}

test('copies eligible slots only, retains every source, and journals digests before any destination write', async () => {
  const f = fixture();
  const bases = [...Object.values(BASE_KEYS), DEVICE_KEYS_BASE, WIPE_SEEN_KEY];
  for (const base of bases) f.values.set(f.source(base), `synthetic-private-value-${base}`);
  const before = new Map(f.values), result = await f.recover();
  assert.equal(result.state, 'complete');
  for (const base of bases) {
    assert.equal(f.values.get(f.source(base)), before.get(f.source(base)));
    if (base === BASE_KEYS.lastIdentity) assert.equal(f.values.has(f.target(base)), false);
    else assert.equal(f.values.get(f.target(base)), before.get(f.source(base)));
  }
  assert.equal(f.writes[0].key, continuityJournalKey(f.binding));
  const first = JSON.parse(f.writes[0].value);
  assert.equal(first.state, 'recovering');
  assert.equal(first.entries.every(entry => entry.state === 'pending' && /^[a-f0-9]{64}$/.test(entry.digest)), true);
  for (const write of f.writes.filter(write => write.key === continuityJournalKey(f.binding))) {
    assert.equal(write.value.includes('synthetic-private-value'), false);
    assert.equal(write.value.includes(BASE_KEYS.lastIdentity), false);
  }
});

test('existing destination conflict is surfaced without overwrite while independent absent slots recover', async () => {
  const f = fixture();
  f.values.set(f.source(BASE_KEYS.data), 'old-data'); f.values.set(f.target(BASE_KEYS.data), 'new-data');
  f.values.set(f.source(DEVICE_KEYS_BASE), 'synthetic-device-secret');
  const result = await f.recover();
  assert.deepEqual(result.conflicts, [{ base: BASE_KEYS.data, reason: 'destination_exists' }]);
  assert.equal(result.state, 'recovering');
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'new-data');
  assert.equal(f.values.get(f.target(DEVICE_KEYS_BASE)), 'synthetic-device-secret');
});

test('retry after crash between destination copy and progress journal does not duplicate or overwrite', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'synthetic-local-file');
  const compare = f.storage.compareAndSet; let failed = false;
  f.storage.compareAndSet = (key, expected, value, check) => {
    if (!failed && key === continuityJournalKey(f.binding) && f.values.has(f.target(BASE_KEYS.data))) { failed = true; throw new Error('Synthetic quota interruption'); }
    return compare(key, expected, value, check);
  };
  await assert.rejects(f.recover(), error => error.code === 'continuity_storage_unavailable');
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'synthetic-local-file');
  assert.equal(JSON.parse(f.values.get(continuityJournalKey(f.binding))).entries[0].state, 'pending');
  const result = await f.recover();
  assert.equal(result.state, 'complete');
  assert.equal(f.writes.filter(write => write.key === f.target(BASE_KEYS.data)).length, 1);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'synthetic-local-file');
});

test('destination quota failure preserves source and durable plan for a later successful retry', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'synthetic-large-file');
  const compare = f.storage.compareAndSet; let quota = true;
  f.storage.compareAndSet = (key, expected, value, check) => {
    if (quota && key === f.target(BASE_KEYS.data)) throw new Error('Synthetic full storage');
    return compare(key, expected, value, check);
  };
  await assert.rejects(f.recover(), error => error.code === 'continuity_storage_unavailable');
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'synthetic-large-file');
  assert.equal(JSON.parse(f.values.get(continuityJournalKey(f.binding))).state, 'recovering');
  quota = false; assert.equal((await f.recover()).state, 'complete');
});

test('destination appearing before conditional commit is not overwritten', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'old-data');
  const compare = f.storage.compareAndSet;
  f.storage.compareAndSet = (key, expected, value, check) => {
    if (key === f.target(BASE_KEYS.data)) f.values.set(key, 'concurrent-new-data');
    return compare(key, expected, value, check);
  };
  const result = await f.recover();
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'concurrent-new-data');
  assert.equal(result.conflicts[0].reason, 'destination_exists');
});

test('source snapshot change during digest cannot silently become the copied snapshot', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'original'); let first = true;
  const result = await f.recover({ digest: async value => {
    if (first) { first = false; f.values.set(f.source(BASE_KEYS.data), 'new-source'); }
    return digest(value);
  } });
  assert.deepEqual(result.conflicts, [{ base: BASE_KEYS.data, reason: 'source_changed' }]);
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
});

test('digest failure never exposes slot contents through its propagated error', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'synthetic-private-content');
  await assert.rejects(f.recover({ digest: async value => { throw new Error(value); } }), error =>
    error.code === 'continuity_digest_failed' && !error.message.includes('synthetic-private-content'));
  assert.equal(f.writes.length, 0);
});

test('switch during asynchronous digest stops before journal or destination writes', async () => {
  const f = fixture(), pending = deferred(); f.values.set(f.source(BASE_KEYS.data), 'private-file');
  const recovery = f.recover({ digest: () => pending.promise });
  await tick(); f.state.subject = 'user_ProdB'; pending.resolve(await digest('private-file'));
  await assert.rejects(recovery, error => error.code === 'continuity_account_changed');
  assert.equal(f.writes.length, 0);
});

test('guarded async adapter checks immediately before commit after an account switch', async () => {
  const f = fixture(), pending = deferred(); f.values.set(f.source(BASE_KEYS.data), 'private-file');
  const compare = f.storage.compareAndSet;
  f.storage.compareAndSet = async (...args) => { await pending.promise; return compare(...args); };
  const recovery = f.recover(); await tick(); f.state.subject = 'user_ProdB'; pending.resolve();
  await assert.rejects(recovery, error => error.code === 'continuity_account_changed');
  assert.equal(f.writes.length, 0);
  assert.equal(f.values.has(`${BASE_KEYS.data}:user_ProdB`), false);
});

test('session replacement invalidates an otherwise same-subject binding', async () => {
  const f = fixture(); f.state.session = {};
  await assert.rejects(f.recover(), error => error.code === 'continuity_account_changed');
  assert.equal(f.writes.length, 0);
});

test('expired bootstrap receipt cannot begin or continue local recovery', async () => {
  const f = fixture(); f.state.now += CONTINUITY_RECEIPT_MAX_AGE_MS + 1;
  await assert.rejects(f.recover(), error => error.code === 'continuity_stale_receipt');
  assert.throws(() => createContinuityBinding(receipt(), f.options), error => error.code === 'continuity_stale_receipt');
  assert.equal(f.writes.length, 0);
});

test('invalid identity, issuer, state, and forged bindings fail closed', async () => {
  const f = fixture();
  for (const mutate of [r => { r.subject = 'user_ProdB'; }, r => { r.issuer = DEVELOPMENT_CLERK_ISSUER; },
    r => { r.continuity.sourceIssuer = PRODUCTION_CLERK_ISSUER; }, r => { r.continuity.state = 'pending'; },
    r => { r.continuity.sourceSubject = current; }, r => { r.profileId = 'not-a-uuid'; }]) {
    const value = receipt(); mutate(value);
    assert.throws(() => createContinuityBinding(value, f.options), error => error.code === 'continuity_invalid_receipt');
  }
  await assert.rejects(recoverContinuity({}, { storage: f.storage }), error => error.code === 'continuity_invalid_binding');
  assert.throws(() => configureSecretContinuity({}), error => error.code === 'continuity_invalid_binding');
  assert.equal(f.writes.length, 0);
});

test('completed journal never resurrects destination data later cleared by the user', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'old-private-file');
  await f.recover(); f.values.delete(f.target(BASE_KEYS.data)); const before = f.writes.length;
  const result = await f.recover();
  assert.equal(result.alreadyComplete, true);
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
  assert.equal(f.writes.length, before);
});

test('tampered journal base names cannot redirect a later write', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'old'); f.values.set(f.target(BASE_KEYS.data), 'conflict');
  await f.recover(); const key = continuityJournalKey(f.binding), journal = JSON.parse(f.values.get(key));
  journal.entries[0].base = 'unrelated-account'; f.values.set(key, JSON.stringify(journal)); const before = f.writes.length;
  await assert.rejects(f.recover(), error => error.code === 'continuity_invalid_journal');
  assert.equal(f.writes.length, before);
});

test('concurrent cooperating recovery callers perform each destination copy once', async () => {
  const f = fixture(); f.values.set(f.source(BASE_KEYS.data), 'file');
  const results = await Promise.all([f.recover(), f.recover()]);
  assert.equal(results.every(result => result.state === 'complete'), true);
  assert.equal(f.writes.filter(write => write.key === f.target(BASE_KEYS.data)).length, 1);
});

test('account switch while waiting for a browser lock prevents recovery writes', async () => {
  const f = fixture(), pending = deferred(); f.values.set(f.source(BASE_KEYS.data), 'file');
  const recovery = f.recover({ locks: { request: async (_key, work) => { await pending.promise; return work(); } } });
  await tick(); f.state.subject = 'user_ProdB'; pending.resolve();
  await assert.rejects(recovery, error => error.code === 'continuity_account_changed');
  assert.equal(f.writes.length, 0);
});

test('localStorage adapter never overwrites a populated destination', () => {
  const values = new Map([['destination', 'keep']]); let checks = 0;
  const adapter = createLocalContinuityStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  assert.equal(adapter.compareAndSet('destination', null, 'replace', () => { checks += 1; }), false);
  assert.equal(values.get('destination'), 'keep'); assert.equal(checks, 1);
});

test('legacy ciphertext needs validated continuity, while new ciphertext uses the production subject', async () => {
  const f = fixture(), lock = 'synthetic-lock-code', plain = 'synthetic-portal-password';
  const oldCiphertext = await encryptSecret(plain, lock, legacy);
  setSecretUser(current);
  await assert.rejects(decryptSecret(oldCiphertext, lock, current), /wrong-lock-code/);
  configureSecretContinuity(f.binding);
  assert.equal(await decryptSecret(oldCiphertext, lock, current), plain);
  const newCiphertext = await encryptSecret('new-synthetic-password', lock, current);
  assert.equal(await decryptSecret(newCiphertext, lock, current), 'new-synthetic-password');
  configureSecretContinuity(null);
  await assert.rejects(decryptSecret(newCiphertext, lock, legacy), /wrong-lock-code/);
  assert.equal(await encryptSecret(oldCiphertext, lock, current), oldCiphertext);
});

test('switching account or session disables legacy decryption without changing stored ciphertext', async () => {
  const f = fixture(), lock = 'synthetic-code', ciphertext = await encryptSecret('synthetic-password', lock, legacy);
  setSecretUser(current); configureSecretContinuity(f.binding); f.state.session = {};
  await assert.rejects(decryptSecret(ciphertext, lock, current), /wrong-lock-code/);
  setSecretUser('user_ProdB');
  await assert.rejects(decryptSecret(ciphertext, lock, 'user_ProdB'), /wrong-lock-code/);
});

test('account switch during legacy key derivation cannot return plaintext', async () => {
  const f = fixture(), lock = 'synthetic-code', ciphertext = await encryptSecret('synthetic-password', lock, legacy);
  setSecretUser(current); configureSecretContinuity(f.binding);
  const original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let derivations = 0;
  const subtle = new Proxy(original.subtle, { get(target, key) {
    if (key === 'deriveKey') return async (...args) => {
      const result = await target.deriveKey(...args);
      if (++derivations === 2) f.state.subject = 'user_ProdB';
      return result;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle } });
  try { await assert.rejects(decryptSecret(ciphertext, lock, current), /wrong-lock-code/); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('explicit signout during the first digest retires recovery before any journal or purge await', async () => {
  const f = fixture('user_RetireBeforeJournal'), entered = deferred(), pending = deferred();
  f.values.set(f.source(BASE_KEYS.data), 'legacy-private-data');
  f.values.set(f.source(DEVICE_KEYS_BASE), 'legacy-device-code');
  f.values.set(f.target(BASE_KEYS.data), 'current-private-data');
  f.values.set(f.target(DEVICE_KEYS_BASE), 'current-device-code');
  f.values.set(`${BASE_KEYS.data}:user_Other`, 'other-account-data');
  const recovery = f.recover({ digest: async value => { entered.resolve(); await pending.promise; return digest(value); } });
  await entered.promise;
  assert.equal(f.values.has(continuityJournalKey(f.binding)), false);
  const purge = purgeForSignOut(f.state.subject);
  const marker = f.target(CONTINUITY_RETIREMENT_BASE);
  assert.deepEqual(f.effects[0], { kind: 'set', key: marker });
  assert.equal(f.values.get(marker), 'retired');
  await purge; pending.resolve();
  await assert.rejects(recovery, error => error.code === 'continuity_recovery_retired');
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
  assert.equal(f.values.has(f.target(DEVICE_KEYS_BASE)), false);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'legacy-private-data');
  assert.equal(f.values.get(f.source(DEVICE_KEYS_BASE)), 'legacy-device-code');
  assert.equal(f.values.get(`${BASE_KEYS.data}:user_Other`), 'other-account-data');
  assert.equal(f.writes.length, 0);
  const { recovery: fresh } = await reloadedRecovery();
  const binding = fresh.createContinuityBinding(f.proof, f.options);
  await assert.rejects(fresh.recoverContinuity(binding, { storage: f.storage }), error => error.code === 'continuity_recovery_retired');
  assert.equal(f.writes.length, 0);
});

test('a reloaded purge discovers an unfinished journal and stops the pending destination commit and every retry', async () => {
  const f = fixture('user_RetirePendingCommit'), entered = deferred(), pending = deferred();
  f.values.set(f.source(BASE_KEYS.data), 'legacy-file');
  const compare = f.storage.compareAndSet;
  f.storage.compareAndSet = async (...args) => {
    if (args[0] === f.target(BASE_KEYS.data)) { entered.resolve(); await pending.promise; }
    return compare(...args);
  };
  const recovery = f.recover(); await entered.promise;
  const journalKey = continuityJournalKey(f.binding), before = f.values.get(journalKey);
  assert.equal(JSON.parse(before).state, 'recovering');
  // This module has no in-memory knowledge of the original binding.
  const { scope } = await reloadedRecovery();
  await scope.purgeForSignOut(f.state.subject); pending.resolve();
  await assert.rejects(recovery, error => error.code === 'continuity_recovery_retired');
  assert.equal(f.values.get(journalKey), before);
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'legacy-file');
  const writes = f.writes.length, { recovery: fresh } = await reloadedRecovery();
  await assert.rejects(fresh.recoverContinuity(fresh.createContinuityBinding(f.proof, f.options), { storage: f.storage }),
    error => error.code === 'continuity_recovery_retired');
  assert.equal(f.writes.length, writes);
});

test('ordinary involuntary purge preserves the vault and does not retire valid continuity recovery', async () => {
  const f = fixture('user_InvoluntaryContinuity');
  f.values.set(f.source(BASE_KEYS.data), 'recoverable-file');
  f.values.set(f.target(BASE_KEYS.vault), 'keep-private-vault');
  await purgeUserStorage(f.state.subject, { keepVault: true });
  assert.equal(f.values.get(f.target(BASE_KEYS.vault)), 'keep-private-vault');
  assert.equal(f.values.has(f.target(CONTINUITY_RETIREMENT_BASE)), false);
  assert.equal((await f.recover()).state, 'complete');
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'recoverable-file');
});

test('an explicit server-wipe option retires recovery even when a private vault is retained', async () => {
  const f = fixture('user_ServerWipeContinuity');
  f.values.set(f.source(BASE_KEYS.data), 'must-not-restore');
  f.values.set(f.target(BASE_KEYS.vault), 'keep-private-vault');
  await purgeUserStorage(f.state.subject, { keepVault: true, retireRecovery: true });
  assert.equal(f.values.get(f.target(BASE_KEYS.vault)), 'keep-private-vault');
  assert.equal(f.values.get(f.target(CONTINUITY_RETIREMENT_BASE)), 'retired');
  await assert.rejects(f.recover(), error => error.code === 'continuity_recovery_retired');
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
});

test('retirement quota failure aborts purge visibly and stops pending recovery until a durable retry succeeds', async () => {
  const f = fixture('user_RetirementQuota'), entered = deferred(), pending = deferred();
  f.values.set(f.source(BASE_KEYS.data), 'legacy-file');
  f.values.set(f.target(BASE_KEYS.data), 'current-file');
  const recovery = f.recover({ digest: async value => { entered.resolve(); await pending.promise; return digest(value); } });
  await entered.promise;
  const setItem = f.localStorage.setItem;
  f.localStorage.setItem = () => { throw new Error('synthetic-private-quota-detail'); };
  await assert.rejects(purgeForSignOut(f.state.subject), error =>
    error.code === 'continuity_retirement_unavailable' && !error.message.includes('synthetic-private-quota-detail'));
  assert.equal(f.effects.length, 0);
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'current-file');
  assert.equal(f.values.has(f.target(CONTINUITY_RETIREMENT_BASE)), false);
  pending.resolve();
  await assert.rejects(recovery, error => error.code === 'continuity_recovery_retired');
  assert.equal(f.writes.length, 0);
  f.localStorage.setItem = setItem;
  await purgeForSignOut(f.state.subject);
  assert.equal(f.values.get(f.target(CONTINUITY_RETIREMENT_BASE)), 'retired');
  assert.equal(f.values.has(f.target(BASE_KEYS.data)), false);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'legacy-file');
});

test('silent marker write failure cannot proceed to local or native deletion', async () => {
  const f = fixture('user_RetirementSilentFailure');
  f.values.set(f.target(BASE_KEYS.data), 'still-here');
  f.localStorage.setItem = () => {};
  await assert.rejects(purgeUserStorage(f.state.subject), error => error.code === 'continuity_retirement_unavailable');
  assert.equal(f.values.get(f.target(BASE_KEYS.data)), 'still-here');
  assert.equal(f.effects.length, 0);
});

test('unreadable retirement storage fails recovery before adapter reads or writes', async () => {
  const f = fixture('user_UnreadableRecovery'); let reads = 0;
  f.localStorage.getItem = () => { throw new Error('unavailable'); };
  f.storage.read = () => { reads += 1; return null; };
  await assert.rejects(f.recover(), error => error.code === 'continuity_retirement_unavailable');
  assert.equal(reads, 0); assert.equal(f.writes.length, 0);
  await assert.rejects(purgeUserStorage(f.state.subject), error => error.code === 'continuity_retirement_unavailable');
  assert.equal(f.effects.length, 0);
});

test('ordinary accounts keep the previous best-effort purge behavior when marker storage is blocked', async () => {
  const f = fixture('user_UnrelatedKnownContinuity'), ordinary = 'user_OrdinaryWithoutContinuity';
  f.values.set(`${BASE_KEYS.data}:${ordinary}`, 'ordinary-cache');
  f.values.set(f.source(BASE_KEYS.data), 'unrelated-legacy');
  f.localStorage.getItem = () => { throw new Error('blocked'); };
  f.localStorage.setItem = () => { throw new Error('blocked'); };
  await purgeForSignOut(ordinary);
  assert.equal(f.values.has(`${BASE_KEYS.data}:${ordinary}`), false);
  assert.equal(f.values.get(f.source(BASE_KEYS.data)), 'unrelated-legacy');
  assert.equal(f.effects.some(effect => effect.kind === 'set'), false);
  assert.equal(f.effects.some(effect => effect.kind === 'nativeRemove' && effect.key === `${BASE_KEYS.data}:${ordinary}`), true);
});

test('a present malformed retirement marker still denies recovery after a reload', async () => {
  const f = fixture('user_DamagedRetirement');
  f.values.set(f.target(CONTINUITY_RETIREMENT_BASE), '');
  const { recovery: fresh } = await reloadedRecovery();
  await assert.rejects(fresh.recoverContinuity(fresh.createContinuityBinding(f.proof, f.options), { storage: f.storage }),
    error => error.code === 'continuity_recovery_retired');
  assert.equal(f.writes.length, 0);
});

test('retirement blocks local restoration while a freshly authenticated owner may decrypt existing cloud ciphertext', async () => {
  const f = fixture('user_RetiredCloudDecrypt'), lock = 'synthetic-lock';
  const ciphertext = await encryptSecret('cloud-password', lock, legacy);
  retireContinuityRecovery(f.state.subject);
  const binding = createContinuityBinding(f.proof, f.options);
  setSecretUser(f.state.subject); configureSecretContinuity(binding);
  assert.equal(await decryptSecret(ciphertext, lock, f.state.subject), 'cloud-password');
  await assert.rejects(recoverContinuity(binding, { storage: f.storage }), error => error.code === 'continuity_recovery_retired');
});
