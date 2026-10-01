import { BASE_KEYS, DEVICE_KEYS_BASE, WIPE_SEEN_KEY, CONTINUITY_JOURNAL_BASE,
  registerContinuityRecoverySubject, assertContinuityRecoveryAllowed, isOfflineStoreKey, readOfflineCopy, noteLocalCopyWritten } from './storageScope.js';

export const PRODUCTION_CLERK_ISSUER = 'https://clerk.credentialdomd.com';
export const DEVELOPMENT_CLERK_ISSUER = 'https://dynamic-goshawk-87.clerk.accounts.dev';
export const CONTINUITY_RECEIPT_MAX_AGE_MS = 120_000;
export { CONTINUITY_JOURNAL_BASE };
export { retireContinuityRecovery } from './storageScope.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT = /^user_[A-Za-z0-9]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isSubject = value => typeof value === 'string' && SUBJECT.test(value);
// The journal (schemaVersion 1) stores one entry per base, in this order, and
// validateJournal refuses any other list but d0c0935's below. It is written
// once per device and read on every load, so this list must never follow
// BASE_KEYS: adding accessAnswer to BASE_KEYS (a5379beb) made every existing
// journal invalid and stopped the account from loading. A new base needs a
// new schemaVersion that still accepts version 1 journals.
const BASES = Object.freeze([
  BASE_KEYS.data, BASE_KEYS.vault, BASE_KEYS.chat, BASE_KEYS.archives, BASE_KEYS.timer,
  BASE_KEYS.lastContract, BASE_KEYS.pendingOps, BASE_KEYS.callsync, DEVICE_KEYS_BASE, WIPE_SEEN_KEY,
]);
// d0c0935 derived the list from BASE_KEYS after accessAnswer joined it, so a
// device that first recovered while that build was live holds a version 1
// journal with an eleventh entry, accessAnswer, at index 8. It is accepted,
// and that entry is dropped: accessAnswer is never copied between accounts.
const ACCESS_ANSWER_BASE = 'credentialdomd-access-answer';
const BASES_D0C0935 = Object.freeze([...BASES.slice(0, 8), ACCESS_ANSWER_BASE, ...BASES.slice(8)]);
const issued = new WeakMap();
const running = new Map();
const encoder = new TextEncoder();

function failure(code) {
  const error = new Error(`Local account recovery stopped (${code}). Existing source data is unchanged.`);
  error.code = code;
  return error;
}

/**
 * Call ONLY with the response of a successful authenticated bootstrap. A JSON
 * receipt by itself is not authentication. isCurrent must close over the exact
 * subject, Clerk session and request/load generation used for that request.
 * authenticatedAt is the local time that authenticated bootstrap began.
 */
export function createContinuityBinding(receipt, { subject, issuer, session, isCurrent, authenticatedAt, now = Date.now } = {}) {
  if (!session || typeof isCurrent !== 'function' || typeof now !== 'function'
    || !Number.isFinite(authenticatedAt) || issuer !== PRODUCTION_CLERK_ISSUER
    || !isSubject(subject) || receipt?.schemaVersion !== 1
    || receipt.subject !== subject || receipt.issuer !== issuer || !isUuid(receipt.profileId)
    || receipt.continuity?.state !== 'bound' || !isUuid(receipt.continuity.id)
    || receipt.continuity.sourceIssuer !== DEVELOPMENT_CLERK_ISSUER
    || !isSubject(receipt.continuity.sourceSubject) || receipt.continuity.sourceSubject === subject) {
    throw failure('continuity_invalid_receipt');
  }
  const identity = Object.freeze({ subject, issuer, session });
  const check = (fresh = false) => {
    let current = false;
    try { current = isCurrent(identity) === true; } catch { /* fail closed */ }
    if (!current) throw failure('continuity_account_changed');
    if (fresh) {
      const age = now() - authenticatedAt;
      if (!Number.isFinite(age) || age < 0 || age > CONTINUITY_RECEIPT_MAX_AGE_MS) throw failure('continuity_stale_receipt');
    }
  };
  check(true);
  registerContinuityRecoverySubject(subject);
  const binding = Object.freeze({});
  issued.set(binding, Object.freeze({
    subject, issuer, profileId: receipt.profileId, continuityId: receipt.continuity.id,
    sourceSubject: receipt.continuity.sourceSubject, sourceIssuer: receipt.continuity.sourceIssuer, check,
  }));
  return binding;
}

function contextFor(binding, fresh = false) {
  const context = binding && issued.get(binding);
  if (!context) throw failure('continuity_invalid_binding');
  context.check(fresh);
  return context;
}

/** A session-bound legacy derivation, never an email/profile-derived alias. */
export function continuitySourceSubject(binding, subject) {
  const context = contextFor(binding);
  if (context.subject !== subject) throw failure('continuity_account_changed');
  return context.sourceSubject;
}

export function continuityBindingSubject(binding) { return contextFor(binding).subject; }

export function continuityJournalKey(binding) {
  const context = contextFor(binding);
  return `${CONTINUITY_JOURNAL_BASE}:${context.subject}:${context.continuityId}`;
}

/**
 * Synchronous localStorage compare-before-write. Run recovery before normal
 * destination hydration/writes. Web Locks serialize cooperating recovery tabs;
 * localStorage cannot make other, noncooperating tab writers transactional.
 * Async/native adapters must call check immediately before their actual commit
 * and implement compareAndSet atomically within their own storage mechanism.
 * The retirement barrier always uses localStorage, including native adapters.
 */
export function createLocalContinuityStorage(storage = globalThis.localStorage, { readOffline = readOfflineCopy, onLocalCopy = noteLocalCopyWritten } = {}) {
  // The file, the transcript and the archives live in IndexedDB now
  // (storageScope.js OFFLINE_STORE_BASES), and localStorage holds them only
  // before they move or when IndexedDB refused. A destination there is a
  // destination that exists: it is never overwritten from the source, as a
  // populated localStorage slot never was. An IndexedDB that could not be
  // read is not an empty one: readOffline throws, and recovery stops
  // (continuity_storage_unavailable) instead of copying over what it could
  // not see. Every other key stays synchronous.
  const offline = key => typeof readOffline === 'function' && isOfflineStoreKey(key);
  const commit = (key, value) => {
    storage.setItem(key, value);
    // The transcript the Assistant reads from memory follows what recovery
    // put in localStorage, which outranks every other copy.
    if (offline(key) && storage === globalThis.localStorage && typeof onLocalCopy === 'function') onLocalCopy(key, value);
    return true;
  };
  return {
    read(key) {
      const value = storage.getItem(key);
      if (value !== null || !offline(key)) return value;
      return readOffline(key);
    },
    compareAndSet(key, expected, value, check) {
      check();
      if (storage.getItem(key) !== expected) return false;
      if (expected !== null || !offline(key)) { check(); return commit(key, value); }
      return readOffline(key).then(stored => {
        check();
        if (stored !== null || storage.getItem(key) !== null) return false;
        return commit(key, value);
      });
    },
  };
}

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateJournal(raw, context) {
  let journal;
  try { journal = JSON.parse(raw); } catch { throw failure('continuity_invalid_journal'); }
  const bases = journal?.entries?.length === BASES_D0C0935.length ? BASES_D0C0935 : BASES;
  if (journal?.schemaVersion !== 1 || journal.continuityId !== context.continuityId
    || journal.profileId !== context.profileId || journal.subject !== context.subject
    || journal.sourceSubject !== context.sourceSubject || !['recovering', 'complete'].includes(journal.state)
    || !Array.isArray(journal.entries) || journal.entries.length !== bases.length
    || journal.entries.some((entry, index) => entry?.base !== bases[index]
      || !['pending', 'copied', 'absent'].includes(entry.state)
      || (entry.state === 'absent' ? entry.digest !== null : typeof entry.digest !== 'string' || !HASH.test(entry.digest)))
    || (journal.state === 'complete' && journal.entries.some(entry => entry.state === 'pending'))) {
    throw failure('continuity_invalid_journal');
  }
  // The next save writes the pinned version 1 list back.
  if (bases === BASES_D0C0935) journal.entries = journal.entries.filter(entry => entry.base !== ACCESS_ANSWER_BASE);
  return journal;
}

/**
 * Copies absent destination slots, never deletes source slots or replays queues.
 * The durable journal contains identity, base names, digests and state only.
 * Once complete it will NEVER restore a destination later purged by the user.
 * Explicit purges also durably retire incomplete recovery before removing data.
 * Conflicting destinations and changed source snapshots require explicit review.
 */
export async function recoverContinuity(binding, { storage = createLocalContinuityStorage(), digest = sha256, locks = globalThis.navigator?.locks } = {}) {
  const context = contextFor(binding, true), key = continuityJournalKey(binding);
  const check = () => { context.check(true); assertContinuityRecoveryAllowed(context.subject); };
  check();
  if (!storage || typeof storage.read !== 'function' || typeof storage.compareAndSet !== 'function' || typeof digest !== 'function') throw failure('continuity_invalid_adapter');
  const existing = running.get(key);
  if (existing) {
    await existing;
    check();
    return recoverContinuity(binding, { storage, digest, locks });
  }
  const work = async () => {
    const read = async name => {
      check(); let value;
      try { value = await storage.read(name, check); } catch { check(); throw failure('continuity_storage_unavailable'); }
      check();
      if (value !== null && typeof value !== 'string') throw failure('continuity_invalid_adapter');
      return value;
    };
    const hash = async value => {
      check(); let result;
      try { result = await digest(value); } catch { check(); throw failure('continuity_digest_failed'); }
      check();
      if (typeof result !== 'string' || !HASH.test(result)) throw failure('continuity_invalid_digest');
      return result;
    };
    const cas = async (name, expected, value) => {
      check(); let result;
      try { result = await storage.compareAndSet(name, expected, value, check); }
      catch { check(); throw failure('continuity_storage_unavailable'); }
      check(); return result === true;
    };
    let raw = await read(key), journal;
    if (raw !== null) journal = validateJournal(raw, context);
    else {
      const entries = [];
      for (const base of BASES) {
        const value = await read(`${base}:${context.sourceSubject}`);
        entries.push({ base, digest: value === null ? null : await hash(value), state: value === null ? 'absent' : 'pending' });
      }
      journal = { schemaVersion: 1, continuityId: context.continuityId, profileId: context.profileId,
        subject: context.subject, sourceSubject: context.sourceSubject, state: 'recovering', entries };
      raw = JSON.stringify(journal);
      if (!await cas(key, null, raw)) throw failure('continuity_journal_conflict');
    }
    // Do not resurrect copies erased by sign-out or an explicit data deletion.
    if (journal.state === 'complete') return { state: 'complete', copied: [], conflicts: [], alreadyComplete: true };
    const copied = [], conflicts = [];
    const saveJournal = async () => {
      const next = JSON.stringify(journal);
      if (!await cas(key, raw, next)) throw failure('continuity_journal_conflict');
      raw = next;
    };
    for (const entry of journal.entries) {
      if (entry.state === 'absent') {
        if (await read(`${entry.base}:${context.sourceSubject}`) !== null) conflicts.push({ base: entry.base, reason: 'source_changed' });
        continue;
      }
      if (entry.state !== 'pending') continue;
      const sourceKey = `${entry.base}:${context.sourceSubject}`, destinationKey = `${entry.base}:${context.subject}`;
      const source = await read(sourceKey);
      if (source === null || await hash(source) !== entry.digest || await read(sourceKey) !== source) {
        conflicts.push({ base: entry.base, reason: 'source_changed' }); continue;
      }
      let destination = await read(destinationKey);
      if (destination === null) {
        if (await cas(destinationKey, null, source)) { destination = source; copied.push(entry.base); }
        else destination = await read(destinationKey);
      }
      if (destination !== source) { conflicts.push({ base: entry.base, reason: 'destination_exists' }); continue; }
      entry.state = 'copied';
      await saveJournal();
    }
    if (!conflicts.length) { journal.state = 'complete'; await saveJournal(); }
    return { state: journal.state, copied, conflicts, alreadyComplete: false };
  };
  const task = Promise.resolve().then(() => typeof locks?.request === 'function' ? locks.request(key, work) : work());
  running.set(key, task);
  try { return await task; }
  finally { if (running.get(key) === task) running.delete(key); }
}
