// Unit-style checks for src/utils/offlineSession.js and the storageScope
// slots it rides on. These pin the security invariants of the offline
// fallback: the activation predicate (every condition individually missing
// means NO fallback — a slow Clerk on a working network, a purged identity,
// a missing or corrupt cache), the sign-out purge of the identity slot, and
// cache-key derivation through the same per-user namespacing as the real
// session (never another account's namespace).
// Run: node scripts/offline-session.test.mjs   (pure node, no test runner)

// localStorage + window shims must exist before the modules are imported
// (module bodies don't read storage at import time, but every helper does).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
  clear: () => { store.clear(); },
};
globalThis.window = globalThis.window || {};

const { BASE_KEYS, scopedKey, purgeUserStorage, setActiveUserId } = await import("../src/utils/storageScope.js");
const {
  recordLastIdentity, readLastIdentity, offlineCacheKey, cachedDataParses,
  shouldActivateOfflineFallback,
} = await import("../src/utils/offlineSession.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const A = "user_2aaaAAAA";
const B = "user_2bbbBBBB";
const IDENTITY = { authUserId: A, name: "Dr. A" };

// ── Activation predicate: all three conditions required ─────────────────

// Base case: browser says offline + identity + cache → activate.
ok("activates: onLine false + identity + cache",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: false, clerkTimedOut: false, probeFailed: false, identity: IDENTITY, cacheOk: true }) === true);

// Clerk timed out AND probe failed (browser still claims online) → activate.
ok("activates: clerk timeout + probe failed",
  shouldActivateOfflineFallback({ onLine: true, clerkLoaded: false, clerkTimedOut: true, probeFailed: true, identity: IDENTITY, cacheOk: true }) === true);

// Condition (a) missing — slow Clerk on a WORKING network must never activate.
ok("no fallback: clerk timeout but probe succeeded (slow Clerk, working network)",
  shouldActivateOfflineFallback({ onLine: true, clerkLoaded: false, clerkTimedOut: true, probeFailed: false, identity: IDENTITY, cacheOk: true }) === false);
ok("no fallback: probe failed but Clerk not yet timed out",
  shouldActivateOfflineFallback({ onLine: true, clerkLoaded: false, clerkTimedOut: false, probeFailed: true, identity: IDENTITY, cacheOk: true }) === false);
ok("no fallback: network fine, nothing timed out",
  shouldActivateOfflineFallback({ onLine: true, clerkLoaded: false, clerkTimedOut: false, probeFailed: false, identity: IDENTITY, cacheOk: true }) === false);

// Condition (b) missing — no recorded identity (e.g. purged by sign-out).
ok("no fallback: identity missing (onLine false)",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: false, clerkTimedOut: true, probeFailed: true, identity: null, cacheOk: true }) === false);
ok("no fallback: identity object without authUserId",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: false, clerkTimedOut: true, probeFailed: true, identity: { name: "x" }, cacheOk: true }) === false);

// Condition (c) missing — no parseable cache for that identity.
ok("no fallback: cache missing/corrupt (onLine false)",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: false, clerkTimedOut: true, probeFailed: true, identity: IDENTITY, cacheOk: false }) === false);

// A loaded Clerk always wins, even with every other condition met —
// including Clerk resolving to signed-out.
ok("no fallback: Clerk reached loaded state",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: true, clerkTimedOut: true, probeFailed: true, identity: IDENTITY, cacheOk: true }) === false);

// ── Identity slot: record, read, tamper rejection ───────────────────────

store.clear();
recordLastIdentity({ id: A, fullName: "Dr. A", email: "a@example.com" });
{
  const slot = readLastIdentity();
  eq("recorded identity round-trips", [slot?.authUserId, slot?.name], [A, "Dr. A"]);
  ok("slot recordedAt stamped", typeof slot?.recordedAt === "string" && slot.recordedAt.length > 0);
  ok("slot lives under its own user's namespaced key",
    store.has(`${BASE_KEYS.lastIdentity}:${A}`));
}

// A slot whose contents name a DIFFERENT user than its own key suffix is a
// misfile or tamper — it must never be trusted.
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${B}`, JSON.stringify({ authUserId: A, name: "spoof", recordedAt: "2099-01-01T00:00:00Z" }));
ok("mismatched slot (key user_B, contents user_A) is rejected", readLastIdentity() === null);

// Corrupt slot parses to null identity, not a crash.
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, "{not json");
ok("corrupt slot ignored", readLastIdentity() === null);

// Most recent recordedAt wins if two slots ever coexist. Stamps are relative
// so the TTL (14 days) never makes this test rot.
store.clear();
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, JSON.stringify({ authUserId: A, name: "older", recordedAt: hoursAgo(48) }));
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${B}`, JSON.stringify({ authUserId: B, name: "newer", recordedAt: hoursAgo(2) }));
eq("latest recordedAt wins", readLastIdentity()?.authUserId, B);

// ── TTL: the lost-device ceiling ────────────────────────────────────────
// A slot older than OFFLINE_IDENTITY_TTL_MS is dead: a session revoked while
// the app was closed never runs a purge, so age has to end the fallback.
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, JSON.stringify({ authUserId: A, name: "stale", recordedAt: hoursAgo(15 * 24) }));
ok("15-day-old identity is rejected (TTL)", readLastIdentity() === null);
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, JSON.stringify({ authUserId: A, name: "fresh", recordedAt: hoursAgo(13 * 24) }));
eq("13-day-old identity still works", readLastIdentity()?.authUserId, A);
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, JSON.stringify({ authUserId: A, name: "future", recordedAt: "2099-01-01T00:00:00Z" }));
ok("future-stamped identity is rejected (clock tamper)", readLastIdentity() === null);
store.clear();
localStorage.setItem(`${BASE_KEYS.lastIdentity}:${A}`, JSON.stringify({ authUserId: A, name: "no-stamp" }));
ok("missing recordedAt is rejected under the TTL rule", readLastIdentity() === null);

// ── Namespace derivation ────────────────────────────────────────────────

eq("cache key = scopedKey(BASE_KEYS.data, authUserId)",
  offlineCacheKey(A), scopedKey(BASE_KEYS.data, A));
eq("cache key literal shape", offlineCacheKey(A), `credentialdomd-data:${A}`);
ok("no user id → no key (never an un-namespaced read)", offlineCacheKey(null) === null);
ok("lastIdentity slot is part of BASE_KEYS (so purgeUserStorage covers it)",
  typeof BASE_KEYS.lastIdentity === "string" && BASE_KEYS.lastIdentity.length > 0);

store.clear();
localStorage.setItem(offlineCacheKey(A), JSON.stringify({ settings: { name: "Dr. A" }, licenses: [] }));
ok("cache parses for its owner", cachedDataParses(A) === true);
ok("another user's cache is invisible (own namespace only)", cachedDataParses(B) === false);
localStorage.setItem(offlineCacheKey(A), "{corrupt");
ok("corrupt cache does not parse", cachedDataParses(A) === false);

// ── Sign-out purge covers the identity slot ─────────────────────────────

store.clear();
setActiveUserId(A);
recordLastIdentity({ id: A, fullName: "Dr. A" });
localStorage.setItem(offlineCacheKey(A), JSON.stringify({ settings: {} }));
ok("precondition: identity + cache present", readLastIdentity()?.authUserId === A && cachedDataParses(A));
await purgeUserStorage(A, { keepVault: false });
ok("sign-out purge removes the identity slot", readLastIdentity() === null);
ok("sign-out purge removes the cached file", cachedDataParses(A) === false);
ok("after purge the fallback can never activate",
  shouldActivateOfflineFallback({ onLine: false, clerkLoaded: false, clerkTimedOut: true, probeFailed: true, identity: readLastIdentity(), cacheOk: cachedDataParses(A) }) === false);

// Involuntary sign-out (keepVault: true — session expiry, remote revocation)
// also removes the identity slot: a revoked session must not reopen offline.
store.clear();
recordLastIdentity({ id: A, fullName: "Dr. A" });
localStorage.setItem(scopedKey(BASE_KEYS.vault, A), JSON.stringify({ "licenses:x": "note" }));
await purgeUserStorage(A, { keepVault: true });
ok("keepVault purge still removes the identity slot", readLastIdentity() === null);
ok("keepVault purge keeps the vault", localStorage.getItem(scopedKey(BASE_KEYS.vault, A)) !== null);

// Purging one account never touches another account's slots.
store.clear();
recordLastIdentity({ id: A, fullName: "Dr. A" });
recordLastIdentity({ id: B, fullName: "Dr. B" });
localStorage.setItem(offlineCacheKey(B), JSON.stringify({ settings: {} }));
await purgeUserStorage(A, { keepVault: false });
eq("purge of A leaves B's identity", readLastIdentity()?.authUserId, B);
ok("purge of A leaves B's cache", cachedDataParses(B) === true);

setActiveUserId(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
