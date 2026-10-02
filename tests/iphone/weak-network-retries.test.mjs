// Review of 9484782c, the installed iPhone app on a weak signal:
//  - the identity retry that got past the identity check and then failed one
//    records read swapped the read-only device copy for an empty "records
//    unavailable" screen and stopped retrying;
//  - the "online" event that came while a resume reload was still retrying
//    was ignored, so saves queued in a dead zone stayed on the phone while he
//    worked at the desk, until a later hide and show.
// Runs AppContext's own loadDataForUser and resume-refresh effect, cut from
// the source, with the calls they make recorded. Synthetic account only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { profileInitializationError, profileSupportReference, localFallbackReference } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';

const OWNER = 'user_syntheticWeak';
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');

// ─── The identity retry ─────────────────────────────────────────────────
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
assert.ok(start > 0 && end > start, 'AppContext loadDataForUser located');
const loadCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser };`;
const timedOut = () => {
  const e = profileInitializationError('initialize', { code: 'membership_information_unavailable', phase: 'timeout', during: 'network' });
  e.transient = true;
  return e;
};
function load({ ensureProfile, loadFromSupabase }) {
  const calls = [];
  const record = (name, value) => calls.push({ name, value });
  const deviceCopy = { settings: { accessStatus: 'active' }, licenses: [{ id: 'lic-1', name: 'QA device license' }] };
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: OWNER } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef: { current: null },
    loadedDeletionRef: { current: null }, cachedRecordsRef: { current: null },
    DEFAULT_DATA: { settings: {}, licenses: [] }, COLLECTION_KEYS: ['licenses'],
    getActiveUserId: () => OWNER, lsGet: () => null, lsGetJSON: () => null, localFence: () => null, adoptLocalFence() {}, WIPE_SEEN_KEY: 'wipe', BASE_KEYS: { pendingOps: 'ops' },
    beginLoadOver: () => null, memoryIsNewer: () => false, screenStillHeld: () => false,
    loadData: async () => { record('loadData'); return structuredClone(deviceCopy); },
    rebaseLocalChanges: d => d, localChangesSince: () => null, deviceOnlyOnScreen: (_a, _b, _c, d) => d,
    markOfflineCopyRead() {}, adoptOfflineCopyRead() {},
    ensureProfile, loadFromSupabase, profileSupportReference, localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    accountDataDeletedAt: () => null, pendingOpCount: () => 0, sameDeletionStamp: (a, b) => (a ?? null) === (b ?? null),
    localCopyCurrent: () => true,
    offlineCopyUnread: () => undefined,
    repairStoredIds: async () => {}, readCachedData: async () => null, saveData: async () => {}, lsSetJSON() {},
    reportUnlessLeaving: m => record('report', m), reportError: m => record('report', m),
    accessAuthority: { suspendWrites: () => record('suspendWrites') },
    setData: v => record('setData', v), setLoaded: v => record('setLoaded', v), setLoadedFrom: v => record('setLoadedFrom', v),
    setProfileOwner: v => record('setProfileOwner', v), setProfileIssue: v => record('setProfileIssue', v), setIdentityWaiting: v => record('setIdentityWaiting', v),
    setRecordsLoadIssue: v => record('setRecordsLoadIssue', v), console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return { ...context.api, calls, named: n => calls.filter(c => c.name === n).map(c => c.value), context };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('an identity retry that answers, then fails a records read, keeps the device copy on screen read-only and keeps retrying', async () => {
  let answers = false;
  const f = load({
    ensureProfile: async () => { if (!answers) throw timedOut(); return { id: 'profile-synthetic' }; },
    loadFromSupabase: async () => { throw accountRecordsLoadError(); },
  });
  await f.loadDataForUser(OWNER);
  await settle();
  assert.equal(f.named('setIdentityWaiting').at(-1)?.accountId, OWNER, 'the device copy opened read-only');
  const shownBefore = f.named('setData').length;
  // The retry: the identity answers, one records read times out.
  answers = true;
  await f.loadDataForUser(OWNER, { fromWait: true });
  await settle();
  assert.equal(f.named('setData').length, shownBefore, 'the records on screen are not replaced with an empty account');
  assert.deepEqual(f.named('setRecordsLoadIssue').filter(Boolean), [], 'no "records unavailable" screen');
  assert.equal(f.context.dataOwnerRef.current, OWNER, 'still his records');
  assert.equal(f.named('setIdentityWaiting').at(-1)?.accountId, OWNER, 'the retry keeps going');
  assert.equal(f.named('setProfileOwner').at(-1), null, 'no membership check over the device copy');
  assert.ok(f.named('suspendWrites').length >= 2, 'still read-only');
  // A launch that is not the retry still says the records did not load.
  const g = load({ ensureProfile: async () => ({ id: 'profile-synthetic' }), loadFromSupabase: async () => { throw accountRecordsLoadError(); } });
  await g.loadDataForUser(OWNER);
  assert.equal(g.named('setRecordsLoadIssue').at(-1)?.accountId, OWNER);
  // And the retry asks as the retry.
  const retry = appSource.slice(appSource.indexOf('// The identity check had no answer at launch (identityWaiting)'), appSource.indexOf('// The account read again, quietly'));
  assert.match(retry, /loadDataForUser\(ownerId, \{ fromWait: true \}\)/);
});

// ─── The resume refresh ─────────────────────────────────────────────────
const effectStart = appSource.indexOf('    if (offlineMode || !loaded || !user?.id || identityWaiting || typeof document === "undefined") return undefined;');
const effectEnd = appSource.indexOf('  }, [offlineMode, loaded, user?.id, identityWaiting]);', effectStart);
assert.ok(effectStart > 0 && effectEnd > effectStart, 'resume refresh effect located');
const effectBody = appSource.slice(effectStart, effectEnd);

function resume({ queued }) {
  const listeners = {};
  const add = (t, f) => { (listeners[t] ||= []).push(f); };
  const fire = (t, e) => (listeners[t] || []).forEach(f => f(e));
  const document = { visibilityState: 'visible', addEventListener: add, removeEventListener() {} };
  const window = { addEventListener: add, removeEventListener() {}, Clerk: { user: { id: 'u1' } } };
  const calls = [], gates = [];
  const state = { queued };
  const loadDataForUser = (_id, opts) => { calls.push(opts); return new Promise(r => gates.push(r)).then(ok => { if (ok) state.queued = 0; }); };
  const effect = new Function('offlineMode', 'loaded', 'user', 'identityWaiting', 'document', 'window', 'dataOwnerRef', 'getActiveUserId', 'loadDataForUser', 'pendingOpCount', 'RESUME_REFRESH_MIN_GAP_MS', effectBody);
  const cleanup = effect(false, true, { id: 'u1' }, null, document, window, { current: 'u1' }, () => 'u1', loadDataForUser, () => state.queued, 30000);
  return { fire, calls, gates, state, cleanup };
}

test('back online while a resume reload is still trying: one more read, at once, once it ends with saves still queued', async () => {
  const r = resume({ queued: 1 });
  r.fire('visibilitychange');
  assert.equal(r.calls.length, 1);
  r.fire('online');
  assert.equal(r.calls.length, 1, 'not two reads at once');
  r.gates[0](false); // its last try went out before the signal came back
  await settle();
  assert.equal(r.calls.length, 2, 'read again once it ended');
  r.gates[1](true);
  await settle();
  assert.equal(r.state.queued, 0, 'the queue went up');
  assert.equal(r.calls.length, 2, 'and nothing more');
});

test('back online during a read that sent the queue: no second read', async () => {
  const r = resume({ queued: 1 });
  r.fire('visibilitychange');
  r.fire('online');
  r.gates[0](true);
  await settle();
  assert.equal(r.calls.length, 1);
});
