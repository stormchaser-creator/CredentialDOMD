// The owner's iPhone, 2026-10-01: a launch on a weak signal timed out every
// try of initialize-clerk-profile, and the app stopped on "Your account
// identity could not be verified ... Reload to try again" with none of his
// records, until he tapped Reload, although the network was fine a moment
// later (lab: ios-practice.spec.mjs "weak network", 2 of 2 runs).
//
// Now a check that got no answer at all opens the account's own device copy,
// read-only, says so, and is asked again on its own. A server's answer (an
// identity conflict, a recovery conflict) still stops on the screen that
// says so. And a quiet read again (the app back in front) never replaces the
// records on screen with a stop screen.
//
// Runs AppContext's own loadDataForUser and loadLocalData (cut from the
// source) with the calls they make recorded. Synthetic account only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { profileInitializationError, profileSupportReference, localFallbackReference } from '../../src/utils/profileIssueDiagnostics.js';
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';
import { accessGateStatus } from '../../src/utils/accessGateStatus.js';

const OWNER = 'user_syntheticWeak';
const appSource = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
const start = appSource.indexOf('  async function loadDataForUser('), end = appSource.indexOf('  // ─── Auth actions', start);
assert.ok(start > 0 && end > start, 'AppContext loadDataForUser located');
const loadCode = `${appSource.slice(start, end)}\nglobalThis.api = { loadDataForUser };`;

// What the client throws when every try timed out (limitedLaunchClient phase
// "timeout" during "network"), as ensureProfile now marks it.
const timedOut = () => {
  const e = profileInitializationError('initialize', { code: 'membership_information_unavailable', phase: 'timeout', during: 'network' });
  e.transient = true;
  return e;
};
const conflict = () => profileInitializationError('initialize', { code: 'identity_conflict' }, 409);

function load({ ensureProfile, loadFromSupabase = async () => { throw new Error('unreachable'); } }) {
  const calls = [];
  const record = (name, value) => calls.push({ name, value });
  const deviceCopy = { settings: { accessStatus: 'active' }, licenses: [{ id: 'lic-1', name: 'QA device license' }] };
  const context = {
    offlineMode: false, window: { Clerk: { user: { id: OWNER } } },
    userIdRef: { current: null }, dataOwnerRef: { current: null }, dataLoadGeneration: { current: 0 }, dataRef: { current: null },
    loadedDeletionRef: { current: null }, cachedRecordsRef: { current: null },
    DEFAULT_DATA: { settings: {}, licenses: [] }, COLLECTION_KEYS: ['licenses'],
    getActiveUserId: () => OWNER, lsGet: () => null, localFence: () => null, adoptLocalFence() {}, WIPE_SEEN_KEY: 'wipe',
    beginLoadOver: () => null, memoryIsNewer: () => false, screenStillHeld: () => false,
    loadData: async () => { record('loadData'); return structuredClone(deviceCopy); },
    rebaseLocalChanges: d => d, localChangesSince: () => null, deviceOnlyOnScreen: (_a, _b, _c, d) => d,
    markOfflineCopyRead() {}, adoptOfflineCopyRead() {},
    ensureProfile, loadFromSupabase, profileSupportReference, localFallbackReference,
    ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords,
    accountDataDeletedAt: () => null, pendingOpCount: () => 0,
    reportUnlessLeaving: m => record('report', m), reportError: m => record('report', m),
    accessAuthority: { suspendWrites: () => record('suspendWrites') },
    setData: v => record('setData', v), setLoaded: v => record('setLoaded', v), setLoadedFrom: v => record('setLoadedFrom', v),
    setProfileOwner() {}, setProfileIssue: v => record('setProfileIssue', v), setIdentityWaiting: v => record('setIdentityWaiting', v),
    setRecordsLoadIssue: v => record('setRecordsLoadIssue', v), console: { log() {}, warn() {} },
  };
  vm.runInNewContext(loadCode, context);
  return { ...context.api, calls, named: n => calls.filter(c => c.name === n).map(c => c.value), context };
}

test('no answer from the identity check: the device copy opens read-only, with no stop screen', async () => {
  const f = load({ ensureProfile: async () => { throw timedOut(); } });
  await f.loadDataForUser(OWNER);
  // The device copy is read after the load returns (as on the generic fallback).
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(f.named('suspendWrites').length, 1, 'nothing can be saved until the check answers');
  const waiting = f.named('setIdentityWaiting').at(-1);
  assert.equal(waiting.accountId, OWNER);
  assert.equal(waiting.supportReference, 'ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK');
  assert.ok(!f.named('setProfileIssue').some(Boolean), 'no "could not be verified" screen');
  const shown = f.named('setData').at(-1);
  assert.deepEqual(shown.licenses.map(l => l.name), ['QA device license'], 'his records, from this device');
  assert.equal(f.named('setLoadedFrom').at(-1), 'local');
  assert.equal(f.context.dataOwnerRef.current, OWNER);
  assert.match(f.named('report').at(-1), /read-only \(ID-INIT-UNAVAILABLE-TIMEOUT-NETWORK\)/);
});

test('a server answer about the identity still stops on the screen that says so', async () => {
  const f = load({ ensureProfile: async () => { throw conflict(); } });
  await f.loadDataForUser(OWNER);
  const issue = f.named('setProfileIssue').at(-1);
  assert.match(issue.message, /could not be verified/);
  assert.equal(f.named('setIdentityWaiting').at(-1), null);
  assert.equal(f.named('loadData').length, 0, 'no device copy is shown for an unresolved identity');
});

test('a quiet read again that fails leaves the records on screen as they are', async () => {
  for (const ensureProfile of [async () => { throw timedOut(); }, async () => { throw conflict(); }, async () => ({ id: 'p1' })]) {
    const f = load({ ensureProfile });
    await f.loadDataForUser(OWNER, { quiet: true });
    for (const name of ['setData', 'setProfileIssue', 'setIdentityWaiting', 'setRecordsLoadIssue', 'suspendWrites', 'loadData']) {
      assert.deepEqual(f.named(name).filter(v => v !== null), [], `${name} untouched`);
    }
  }
});

test('the gate, when the device holds no membership answer to open on, says it is waiting and trying again', () => {
  const gate = accessGateStatus({ enabled: true, identityWaiting: true, profileReady: false });
  assert.match(gate.lines.join(' '), /too weak to confirm your account right now\. Trying again on its own\./);
  assert.ok(!/could not finish/.test(gate.lines.join(' ')));
});

test('the app asks the identity check again on its own, on wake and on a timer, and reads the account again on resume', async () => {
  // AppContext is a React provider; its two wake effects are checked in its source.
  const retry = appSource.slice(appSource.indexOf('// The identity check had no answer at launch (identityWaiting)'), appSource.indexOf('// The account read again, quietly'));
  for (const event of ['"visibilitychange"', '"online"', '"focus"', '"pageshow"']) assert.ok(retry.includes(event), `retries on ${event}`);
  assert.match(retry, /IDENTITY_RETRY_DELAYS_MS\[/);
  assert.match(retry, /loadDataForUser\(ownerId(, \{ fromWait: true \})?\)/);
  const resume = appSource.slice(appSource.indexOf('// The account read again, quietly'), appSource.indexOf('  // Delete All My Data run on another device while this one stays open'));
  assert.match(resume, /loadDataForUser\(ownerId, \{ quiet: true \}\)/);
  for (const event of ['"visibilitychange"', '"pageshow"', '"online"']) assert.ok(resume.includes(event), `reads again on ${event}`);
  assert.match(resume, /force: pendingOpCount\(ownerId\) > 0/, 'back online with saves waiting, at once');
});
