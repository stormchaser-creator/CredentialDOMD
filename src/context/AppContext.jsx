import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useUser, useClerk } from "@clerk/clerk-react";
import { accessAuthority, accessVerifying, alertWriteRefused, dataChangeStatus, holdForAccess, reportWriteAccess, scopesForWrite, setWriteAccessReporter, settleWriteAccess, writeRefusalReason } from "../utils/limitedLaunchAccess.js";
import { applyHeldQueue, changesBetween, revertChanges } from "../utils/heldChanges.js";
import { localChangesSince, rebaseLocalChanges } from "../utils/loadRebase.js";
import { beginLoadOwes, firstAnswerPlan, layWithheldSaves, readAfterReplay, replayLeftUnsent } from "../utils/loadOwes.js";
import { needsAppRules, preloadAppRules, loadAppRules, rememberAppRulesOnDevice, withoutAppRuleNeeds } from "../utils/appRules.js";
import { useAppRulesReady, useAppRulesFailed } from "../hooks/useAppRulesReady.js";
import { DEFAULT_DATA } from "../constants/defaults";
import { THEMES, themeNameOf, nextThemeName } from "../constants/themes";
import { useSubscription } from "../hooks/useSubscription";
import { useBillingReturn } from "../hooks/useBillingReturn.js";
import { loadData, saveData, readCachedData, clearLocalData, onCacheFullChange, cacheStaleReason, deviceOnlySaveBlocked, retryOfflineSave,
  adoptOfflineCopyRead, deviceOnlyForLoad, offlineCopyUnchangedSinceKnown, deviceOnlyUnsavedState, onDeviceOnlyUnsavedChange,
  setCacheWritePending, spillOfflineSave, offlineCopyMayBeBehind } from "../utils/storage";
import { onPageLeave } from "../utils/pageLeave.js";
import { setActiveUserId, getActiveUserId, setStorageFullReporter, purgeAfterSessionEnd, markDeliberateSignOut, clearDeliberateSignOut, adoptLegacyStorage, hasLegacyStorage, lsGet, lsGetJSON, lsSet, lsSetJSON, scopedKey, BASE_KEYS, WIPE_SEEN_KEY, LOCAL_FENCE_KEY, localFence, adoptLocalFence, localCopyCurrent, pendingOpCount, awaitingAccessOpCount, accessRefusedOpCount, deviceOnlyRecordCounts, retireContinuityRecovery, offlineCopyUnread, markOfflineCopyRead, probeOfflineFile } from "../utils/storageScope";
import { repairStoredIds } from "../utils/idRepair.js";
import { accountDataDeletedAt, honorAccountDataDeletion, sameDeletionStamp } from "../utils/dataDeletion.js";
import { recordLastIdentity } from "../utils/offlineSession";
import { initialDesk, watchDeskBreakpoint } from "../utils/deskBreakpoint.js";
import { noteMembershipStatus, resetSharedAiStatus } from "../utils/aiClient";
import { configureSecretContinuity } from "../utils/secretBox.js";
import { localFallbackReference, profileSupportReference } from "../utils/profileIssueDiagnostics.js";
import { ACCOUNT_RECORDS_SUPPORT_REFERENCE, accountRecordsLoadError, assertCompleteAccountRecords } from "../utils/accountRecordsLoad.js";
import { reportError, reportUnlessLeaving } from "../lib/errorReport.js";
import { DELETION_SUPPORT_REFERENCE } from "../utils/accountDeletionResult.js";
import { vaultCount } from "../utils/privateVault";
import { preservePausedApplicationRecords, pausedApplicationLinks, isDeviceOnlySection, DEVICE_ONLY_SECTIONS, deviceOnlySectionsChanged, deviceOnlyBlockedMessage } from "../utils/pausedApplicationRecords.js";
import { reconcileDocumentLinks } from "../utils/documentLinks.js";
import { createDocumentBytes, storedFileOf } from "../utils/documentBytes.js";
import { docMime } from "../utils/inboxDocs";
import { prepareRecord } from "../utils/recordWrite.js";
import { withStoragePath } from "../utils/docStoragePath.js";
import { clearServerBilled, setRecordsRefresher } from "../utils/serverBilling.js";
import { trackedStates } from "../utils/compliance.js";
import { generateAlerts, fireBrowserNotification, buildNotificationMessage } from "../utils/notifications";
import { MS_PER_DAY, generateId } from "../utils/helpers";
import {
  supabase,
  ensureProfile,
  invalidateAccountWrites,
  loadFromSupabase,
  readAccountDataDeletion,
  insertItem as sbInsert,
  updateItem as sbUpdate,
  setFavorite as sbSetFavorite,
  deleteItem as sbDelete,
  saveSettings as sbSaveSettings,
  bulkSync,
  uploadDocumentFile,
  downloadDocumentBlob,
  recordTombstone,
  listTombstones,
  replayPendingOps,
  createDataDeletionContext,
  isCurrentDataDeletionContext,
  COLLECTION_KEYS,
  withLocalOnlySettings,
  setWriteRejectionReporter,
  onSyncChange,
  syncIssuesFor,
  writtenAheadCount,
  onWrittenAheadFreed,
} from "../lib/supabase";

const AppContext = createContext(null);

// Stored files this session found missing (utils/documentBytes.js
// missingKeyOf: the row's path, size, type and last change): not requested
// again until the app reloads or the row's file is given again.
const missingDocumentFiles = new Set();

// A stored file as the data URL the screens show, for utils/documentBytes.js:
// { dataUrl } | { missing: true } (Storage has no such object) | { failed: true }.
// Read as a stream (onProgress), so a download that stalls on a weak link can
// be told from one that is slow. A streamed file has no type of its own, so
// the data URL carries the document's (docMime): untyped, it read
// "data:application/octet-stream", and a file picked again under another name
// no longer matched the stored copy's bytes on screen, and was stored twice
// (QA lab DOCS-001 on this change).
async function documentDataUrl(storagePath, { signal, onProgress, doc } = {}) {
  const got = await downloadDocumentBlob(storagePath, { signal, detail: true, onProgress });
  if (!got?.blob) return got?.missing ? { missing: true } : { failed: true };
  if (signal?.aborted) return { failed: true };
  const type = docMime(doc) || got.blob.type || "application/octet-stream";
  const blob = got.blob.type === type ? got.blob : new Blob([got.blob], { type });
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(typeof e.target?.result === "string" ? e.target.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
  return dataUrl ? { dataUrl } : { failed: true };
}

// How often an open, visible tab asks whether the account's data was deleted
// on another device, and the shortest gap between two focus-driven asks.
const RECHECK_INTERVAL_MS = 3 * 60 * 1000;
const RECHECK_MIN_GAP_MS = 30 * 1000;
// The app back in front: the account read again at most this often, so a
// change made on another device shows, and a save queued without a signal
// goes up, without a relaunch (IOS-SYNC-1, IOS-OFFLINE-2).
const RESUME_REFRESH_MIN_GAP_MS = 30 * 1000;
// An identity check that got no answer at launch (a weak signal) is asked
// again after these pauses, and whenever the app comes back to the front or
// online. The last pause repeats.
const IDENTITY_RETRY_DELAYS_MS = Object.freeze([5000, 15000, 30000, 60000, 120000]);
// How long the page load's first membership answer waits for the writes the
// load before it began (they wait on that answer) to settle before deciding
// what the load still owes (settleFirstAnswer).
const OWED_WRITES_WAIT_MS = 5000;
// The tracked states the screens get while the rule data loads.
const NO_STATES = Object.freeze([]);

/**
 * Normalize Clerk's user → the `{ id, email }` shape the rest of the app
 * already expects. Keeps downstream code (admin checks, banners, support
 * forms) untouched during the Supabase-Auth → Clerk migration.
 */
function normalizeClerkUser(clerkUser) {
  if (!clerkUser) return null;
  return {
    id: clerkUser.id,
    email: clerkUser.primaryEmailAddress?.emailAddress
      || clerkUser.emailAddresses?.[0]?.emailAddress
      || null,
    // VERIFIED addresses only. Clerk lists a secondary address in
    // emailAddresses the instant it is typed, with verification.status
    // "unverified" and no code sent to it, so this array used to carry
    // anything the account holder cared to claim. It fed the client admin
    // check, which fed the invite-only gate, so adding
    // admin@credentialdomd.com to your own Clerk profile was enough to walk
    // past the invite screen. The admin check no longer reads addresses at
    // all (src/lib/admin.js), and this array is filtered as well, because an
    // unverified address is a claim and nothing downstream should be able to
    // mistake it for a fact.
    emails: (clerkUser.emailAddresses || [])
      .filter((e) => e?.verification?.status === "verified")
      .map((e) => e?.emailAddress)
      .filter(Boolean),
    fullName: clerkUser.fullName || null,
    imageUrl: clerkUser.imageUrl || null,
  };
}

/**
 * `offlineSession` ({ authUserId, name } or null) puts the provider in
 * offline mode: Clerk never resolved (network down), so the app renders as
 * the last identity that signed in on THIS device. Data comes only from
 * that identity's own namespaced local cache; every write goes through the
 * normal addItem/editItem/deleteItem paths, whose cloud calls queue into
 * the per-account pending-ops replay slot. Nothing touches profiles, Clerk,
 * or any other account's namespace. See src/utils/offlineSession.js.
 */
export function AppProvider({ children, onNavigate, offlineSession = null }) {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);
  // Where the record file in state came from. The setup board must not
  // stamp its first-render marks off the local fallback: a degraded load
  // looks like a brand-new account, and the next real load would then
  // congratulate an established physician for finishing setup.
  const [profileOwner, setProfileOwner] = useState(null);
  const [profileIssue, setProfileIssue] = useState(null);
  // { accountId, supportReference } while this account's identity check has
  // had no answer at all (every try timed out or never connected): the app
  // shows this device's copy, read-only, and asks again (identity retry).
  const [identityWaiting, setIdentityWaiting] = useState(null);
  const [recordsLoadIssue, setRecordsLoadIssue] = useState(null);
  // A setting the server refused while saving the rest, e.g. { field: "email",
  // address } when the address is on another account. Shown by the field.
  const [settingsRefusal, setSettingsRefusal] = useState(null);
  const [loadedFrom, setLoadedFrom] = useState(null); // "cloud" | "local"
  // Loaded from this device's copy while that copy may lack a change made on
  // this device (a save that never landed before the page was left,
  // storage.js offlineCopyMayBeBehind): the screens then never say a section
  // holds no saved records. Only for a "local" load.
  const [deviceCopyBehind, setDeviceCopyBehind] = useState(false);
  const userIdRef = useRef(null);
  // Clerk id the in-memory `data` was loaded for. The on-device cache is
  // written under this id only, so a stale timer can never file one
  // account's data under another's key.
  const dataOwnerRef = useRef(null);
  const dataLoadGeneration = useRef(0);
  // { owner, stamp, fence }: the server data deletion the records in memory
  // were loaded after (this device's WIPE_SEEN_KEY once that load had purged
  // what it had to, null when none), and the device's purge fence at that
  // moment (storageScope.js LOCAL_FENCE_KEY). A server deletion with another
  // stamp, or a fence that has moved on, means they predate a purge.
  const loadedDeletionRef = useRef(null);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  // The records last handed to saveData for the offline copy (the debounced
  // write, a load's own save). Records on screen that are not these have a
  // write still owed; only then does a load begin by writing them
  // (beginLoadOver). Writing them regardless put this window's older copy
  // over Protected Identity rows another window had saved.
  const cachedRecordsRef = useRef(null);
  // What the latest account load left for the membership answer
  // (utils/loadOwes.js), and the account whose kept saves are being replayed.
  const loadOwesRef = useRef(null);
  const replayingRef = useRef(null);

  // ─── Desktop breakpoint (>=1024px) ────────────────────────
  // One flag for the whole app: components branch on layout here instead of
  // each keeping its own resize listener. Below 1024 nothing branches and
  // the phone renders exactly as before. SSR-safe: no window means phone.
  // A flip remounts what the two layouts place differently, so it follows
  // only a settled, real width: one resize reading innerWidth 1 (a Chromium
  // full-page capture) closed an open Add form (src/utils/deskBreakpoint.js).
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && initialDesk(window)
  );
  // The flag the first render showed; from then on only the watcher sets it.
  const firstDeskRef = useRef(isDesktop);
  useEffect(() => {
    if (typeof window === "undefined") return;
    return watchDeskBreakpoint(window, firstDeskRef.current, setIsDesktop);
  }, []);

  // ─── Auth: read from Clerk ────────────────────────────────
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const clerk = useClerk();
  const { signOut: clerkSignOut } = clerk;

  const offlineMode = !!offlineSession;
  const user = useMemo(() => {
    if (offlineSession) {
      // The recorded last identity on this device. No email: the offline
      // session never gains email-derived privileges (admin gate matches
      // addresses, so it can never open offline).
      return {
        id: offlineSession.authUserId,
        email: null,
        emails: [],
        fullName: offlineSession.name || null,
        imageUrl: null,
        offline: true,
      };
    }
    return normalizeClerkUser(isSignedIn ? clerkUser : null);
  }, [offlineSession, isSignedIn, clerkUser]);
  const authChecked = offlineMode ? true : clerkLoaded;

  // Remember who signed in on this device — the offline fallback identity.
  // Real, Clerk-verified sessions only; the offline session must never
  // re-record itself. Sign-out purges the slot with everything else.
  // A new session also ends any earlier Sign out's claim on the session-end
  // listener (purgeAfterSessionEnd), in this tab's memory and on the device,
  // so a later expiry keeps what it keeps.
  useEffect(() => {
    if (offlineMode || !user?.id) return;
    try { recordLastIdentity(user); } catch { /* storage unavailable */ }
    clearDeliberateSignOut(user.id);
  }, [offlineMode, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every on-device key (file, vault, chat, timers) is namespaced by the
  // Clerk user id. Set synchronously during render so children mounting in
  // this same pass (their useState initializers read storage) see the
  // right namespace. Idempotent, so StrictMode double-render is harmless.
  if (getActiveUserId() !== (user?.id || null)) setActiveUserId(user?.id || null);

  // ─── Refused cloud writes ─────────────────────────────────
  // A row the database refuses for good (a blank required field, a value of
  // the wrong type) is reported to client_errors by table and code, and the
  // record is named on screen until a later save of it lands. Also the count
  // of writes still queued for this account (lib/supabase.js).
  const [syncState, setSyncState] = useState({ issues: [], pending: 0, awaitingAccess: 0, accessRefused: 0 });
  // The on-device copy could not be updated: what opens offline is older
  // than what is on screen. The reason ("full", "unavailable", "unread")
  // picks the words (SyncIssuesNotice); null when it is current.
  const [offlineCopyStale, setOfflineCopyStale] = useState(() => cacheStaleReason());
  useEffect(() => onCacheFullChange(setOfflineCopyStale), []);
  // Protected Identity or Answer Bank changes that are in no copy of the
  // offline file: "held" (kept aside on this device until a save takes them),
  // "memory" (on screen only). SyncIssuesNotice says so, and what to do.
  const [deviceOnlyUnsaved, setDeviceOnlyUnsaved] = useState(null);
  useEffect(() => {
    const accountId = user?.id || null;
    const refresh = () => setDeviceOnlyUnsaved(deviceOnlyUnsavedState(accountId));
    refresh();
    const stop = onDeviceOnlyUnsavedChange(refresh);
    const stopStale = onCacheFullChange(refresh);
    return () => { stop(); stopStale(); };
  }, [user?.id]);

  // An offline copy that could not be saved (full, a store that would not
  // open) or read (unread) is tried again on its own: when the app comes back
  // to the front, the device comes online, and on a backoff timer. It used to
  // be tried again only when the member next changed Protected Identity or
  // the Answer Bank, and a change accepted just before the store stopped
  // answering stayed in memory until the app closed. A copy that can be read
  // again is loaded again (the load takes what it holds, and the changes held
  // aside); a refused save is made again (storage.js retryOfflineSave).
  useEffect(() => {
    const ownerId = user?.id || null;
    const stuck = offlineCopyStale === "full" || offlineCopyStale === "unavailable" || offlineCopyStale === "unread";
    if (!ownerId || !loaded || !stuck || typeof window === "undefined") return undefined;
    let stopped = false, busy = false, attempt = 0, timer = null;
    const retry = async () => {
      if (stopped || busy || getActiveUserId() !== ownerId || dataOwnerRef.current !== ownerId) return;
      busy = true;
      try {
        if (offlineCopyUnread(ownerId)) {
          if (await probeOfflineFile(ownerId) && !stopped && dataOwnerRef.current === ownerId && getActiveUserId() === ownerId) void loadDataForUser(ownerId);
        } else await retryOfflineSave(ownerId);
      } catch { /* the next try */ }
      finally { busy = false; }
    };
    const schedule = () => {
      timer = setTimeout(async () => { await retry(); attempt += 1; if (!stopped) schedule(); }, Math.min(5000 * 3 ** attempt, 5 * 60 * 1000));
    };
    const onVisible = () => { if (typeof document === "undefined" || document.visibilityState === "visible") void retry(); };
    const onWake = () => { void retry(); };
    document.addEventListener?.("visibilitychange", onVisible);
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [offlineCopyStale, loaded, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setWriteRejectionReporter((message) => reportError(message)); }, []);
  // A cache write the device refused for want of space (IndexedDB and
  // localStorage both, or either one) reaches client_errors once per session:
  // the store, the reason and the size rounded to 100 KB, never contents.
  useEffect(() => { setStorageFullReporter((message, extra) => reportError(message, "error", extra)); }, []);
  // Refused saves, and saves kept on this device for want of a membership
  // answer, reach client_errors too (event, reason code and section only). A
  // refusal the page being left can cause (writes stopped by a load that a
  // reload cut off) is dropped with the page, as that load's stop is.
  useEffect(() => { setWriteAccessReporter((message, extra, options) => (options?.unlessLeaving ? reportUnlessLeaving(message, "error", extra, options) : reportError(message, "error", extra))); }, []);
  useEffect(() => {
    const accountId = user?.id || null;
    if (!accountId) { setSyncState({ issues: [], pending: 0, awaitingAccess: 0, accessRefused: 0 }); return undefined; }
    const refresh = (changed) => {
      if (changed && changed !== accountId) return;
      // A settings save made before the page load's first answer is on the
      // queue at once, but this tab is still waiting on that answer to decide
      // it (lib/supabase.js writtenAhead): not yet a change "saved on this
      // device", so the notice does not count it until the wait is over.
      const deciding = writtenAheadCount(accountId);
      setSyncState({ issues: syncIssuesFor(accountId), pending: Math.max(0, pendingOpCount(accountId) - deciding),
        awaitingAccess: Math.max(0, awaitingAccessOpCount(accountId) - deciding), accessRefused: accessRefusedOpCount(accountId) });
    };
    refresh();
    return onSyncChange(refresh);
  }, [user?.id]);

  // Saves kept on this device for want of a membership answer go up as soon
  // as a check answers, not at the next launch (replayKeptSaves).
  useEffect(() => {
    if (offlineMode || !user?.id || !accessAuthority.enabled) return undefined;
    const ownerId = user.id;
    // Also run when a save another page of this browser wrote ahead turns
    // out to have no live page behind it after a replay here left it to that
    // page (lib/supabase.js onWrittenAheadFreed): the page this one reloaded
    // flushed it at pagehide, and it would otherwise wait for the next answer.
    const replay = (accountId) => { if (accountId === ownerId) replayKeptSaves(ownerId); };
    const stopAnswers = accessAuthority.onAnswer(replay);
    const stopFreed = onWrittenAheadFreed(replay);
    return () => { stopAnswers?.(); stopFreed(); };
  }, [offlineMode, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load data when user changes (sign in / sign out) ─────
  useEffect(() => {
    if (!authChecked) return;

    // A different account (or none): drop what is in memory before loading
    // so nothing of the previous account renders or gets cached under the
    // new key. Also cancels the debounced cache write via its effect cleanup.
    if (dataOwnerRef.current !== (user?.id || null)) {
      dataOwnerRef.current = null;
      userIdRef.current = null;
      setProfileOwner(null);
      setLoaded(false);
      setData(DEFAULT_DATA);
      clearServerBilled(Infinity);
    }

    if (user) {
      // A PA or NP account on this device: its rule data starts loading now,
      // alongside the account read (utils/appRules.js).
      if (lsGet(BASE_KEYS.appRulesHint, user.id) === "1") preloadAppRules();
      loadDataForUser(user.id);
    } else {
      // Not authenticated: nothing to load. There is no namespace without a
      // user, so the local cache is not read (or written) at all.
      setData(DEFAULT_DATA);
      setLoaded(true);
    }
    return () => { dataLoadGeneration.current += 1; };
  }, [user?.id, authChecked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Involuntary sign-out (session expiry, revocation from the Clerk
  // dashboard, "sign out of all devices"): the provider unmounts, but the
  // Clerk listener fires first, so purge this account's on-device keys
  // right there. What exists nowhere else is kept: the private vault,
  // Protected Identity, the Answer Bank and the settings with no cloud
  // column (the file is cut down to those), the unsynced-edits queue (for a limited time, storageScope.js
  // KEPT_QUEUE_MAX_AGE_MS) and the running timer. A token timing out must
  // not destroy them, and every key is unreadable to any other account. The
  // Sign out button marks itself first, so its own listener call (and other
  // tabs') purges the way it always did, after warning. See
  // purgeAfterSessionEnd.
  useEffect(() => {
    if (offlineMode || !clerkLoaded || !user?.id || typeof clerk?.addListener !== "function") return;
    const ownerId = user.id;
    const unsub = clerk.addListener((e) => {
      if ((e?.user?.id || null) !== ownerId) {
        purgeAfterSessionEnd(ownerId).catch(() => {});
      }
    });
    return () => { try { unsub?.(); } catch { /* already gone */ } };
  }, [clerkLoaded, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The identity check had no answer at launch (identityWaiting): asked
  // again on a backoff timer and whenever the app comes back to the front,
  // gets the focus, is shown from the back-forward cache or comes back
  // online, one try at a time. Its answer replaces the read-only device copy
  // with the account (or, for a real identity problem, the screen that says
  // so).
  useEffect(() => {
    const ownerId = user?.id || null;
    if (offlineMode || !ownerId || identityWaiting?.accountId !== ownerId || typeof window === "undefined") return undefined;
    let stopped = false, busy = false, attempt = 0, timer = null;
    const retry = async () => {
      if (stopped || busy || getActiveUserId() !== ownerId) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      busy = true;
      // fromWait: a records read that fails after the identity answered
      // keeps the device copy on screen and this retry going.
      try { await loadDataForUser(ownerId, { fromWait: true }); } catch { /* the next try */ }
      finally { busy = false; }
    };
    const schedule = () => {
      const wait = IDENTITY_RETRY_DELAYS_MS[Math.min(attempt, IDENTITY_RETRY_DELAYS_MS.length - 1)];
      timer = setTimeout(async () => { await retry(); attempt += 1; if (!stopped) schedule(); }, wait);
    };
    const onVisible = () => { if (typeof document === "undefined" || document.visibilityState === "visible") void retry(); };
    const onWake = () => { void retry(); };
    document.addEventListener?.("visibilitychange", onVisible);
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [offlineMode, user?.id, identityWaiting?.accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The account read again, quietly, when the app comes back to the front,
  // is shown from the back-forward cache, or comes back online. An installed
  // iPhone app stays in memory for days: a license added or renamed at the
  // desk meanwhile never showed until a relaunch (IOS-SYNC-1), and a save
  // made in a dead zone stayed on the phone, queued, although the signal was
  // back (IOS-OFFLINE-2): only a load sends the queue. At most every
  // RESUME_REFRESH_MIN_GAP_MS, except back online with saves waiting. The
  // records on screen stay while it reads, open forms included, and a read
  // that fails changes nothing (quiet).
  useEffect(() => {
    if (offlineMode || !loaded || !user?.id || identityWaiting || typeof document === "undefined") return undefined;
    const ownerId = user.id;
    let busy = false, lastAt = 0, onlineWhileBusy = false, stopped = false;
    const current = () => dataOwnerRef.current === ownerId && getActiveUserId() === ownerId && window.Clerk?.user?.id === ownerId;
    const refresh = async ({ force = false } = {}) => {
      if (busy || !current() || document.visibilityState === "hidden") return;
      if (!force && Date.now() - lastAt < RESUME_REFRESH_MIN_GAP_MS) return;
      busy = true; lastAt = Date.now();
      try { await loadDataForUser(ownerId, { quiet: true }); } catch { /* quiet */ }
      finally { busy = false; }
      // Back online while that read was under way (its last try may have
      // gone out before the signal came back, and failed quietly): one more,
      // at once, while saves still wait (review of 9484782c).
      if (onlineWhileBusy && !stopped) {
        onlineWhileBusy = false;
        if (pendingOpCount(ownerId) > 0) void refresh({ force: true });
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const onPageShow = (event) => { if (event?.persisted) void refresh(); };
    const onOnline = () => {
      if (busy) { onlineWhileBusy = true; return; }
      void refresh({ force: pendingOpCount(ownerId) > 0 });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    // A screen that learned from the server that its copy is out of date (an
    // invoice recorded on another device, 2026-10-02) asks for this read at
    // once: an installed iPhone app has no reload button.
    // (Guarded: tests run this effect alone, without the module's imports.)
    const offRefresher = typeof setRecordsRefresher === "function" ? setRecordsRefresher(() => { void refresh({ force: true }); }) : () => {};
    return () => {
      stopped = true;
      offRefresher();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [offlineMode, loaded, user?.id, identityWaiting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete All My Data run on another device while this one stays open: the
  // records on screen predate it, and so does anything this tab would write
  // back. Read the account's deletion stamp (two columns of the member's own
  // profile row) and, when the records in memory were loaded before it, load
  // the account again, which purges this device's copy before anything is
  // shown, replayed or pushed. Asked when the app returns to the foreground,
  // when its window gets the focus back or the connection returns (at most
  // every 30 seconds), and every 3 minutes while it is visible, so a tab left
  // open in its own window or on a second screen is caught too. Another tab
  // on this device that purged moves WIPE_SEEN_KEY or the purge fence: that
  // needs no request, is checked first, and arrives here at once as a storage
  // event, so that tab drops what it shows straight away.
  useEffect(() => {
    if (offlineMode || !loaded || !user?.id || typeof document === "undefined") return;
    const ownerId = user.id;
    let checking = false, serverAskedAt = 0;
    const current = () => dataOwnerRef.current === ownerId && getActiveUserId() === ownerId && window.Clerk?.user?.id === ownerId;
    const loadAgain = () => { setLoaded(false); void loadDataForUser(ownerId); };
    const loadedUnder = () => (loadedDeletionRef.current?.owner === ownerId ? loadedDeletionRef.current : null);
    // This device purged since these records loaded (another tab honored a
    // deletion, or ran Delete All My Data): no request needed.
    const purgedHere = () => {
      const under = loadedUnder();
      return !sameDeletionStamp(under?.stamp ?? null, lsGet(WIPE_SEEN_KEY, ownerId))
        || !localCopyCurrent(ownerId, under ? under.fence ?? null : undefined);
    };
    const check = async ({ server = true, throttle = false } = {}) => {
      if (checking) return;
      checking = true;
      try {
        if (purgedHere()) { if (current()) loadAgain(); return; }
        if (!server || document.visibilityState !== "visible") return;
        if (throttle && Date.now() - serverAskedAt < RECHECK_MIN_GAP_MS) return;
        serverAskedAt = Date.now();
        const stamp = await readAccountDataDeletion(ownerId);
        // A storage event that arrived during the read was not checked on its own.
        if (((stamp && !sameDeletionStamp(loadedUnder()?.stamp ?? null, stamp)) || purgedHere()) && current()) loadAgain();
      } catch { /* offline, or the stamp column is not deployed yet: the next check or load asks again */ }
      finally { checking = false; }
    };
    const onVisible = () => { void check(); };
    const onFocus = () => { void check({ throttle: true }); };
    const watched = new Set([scopedKey(WIPE_SEEN_KEY, ownerId), scopedKey(LOCAL_FENCE_KEY, ownerId)]);
    const onStorage = (event) => { if (event?.key == null || watched.has(event.key)) void check({ server: false }); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    window.addEventListener("storage", onStorage);
    const timer = setInterval(() => { void check({ throttle: true }); }, RECHECK_INTERVAL_MS);
    // A purge by another tab while this one was loading: caught now, without a request.
    void check({ server: false });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("storage", onStorage);
      clearInterval(timer);
    };
  }, [offlineMode, loaded, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // `quiet`: a read again while this account's records are on screen (the
  // app back in front, back online). A failure leaves the screen as it is:
  // the next load, or the next launch, tries again.
  // `fromWait`: the identity retry (identityWaiting), with the device copy on
  // screen read-only. A records read that fails once the identity answered
  // keeps that copy on screen and the retry going, instead of an empty
  // "records unavailable" screen that tries no more (review of 9484782c).
  //
  // What the load leaves for the membership answer is noted on its own record
  // (utils/loadOwes.js; settleFirstAnswer below).
  // (Guarded: tests run this function alone, without the component's refs.)
  async function loadDataForUser(authUserId, options = {}) {
    const owes = typeof loadOwesRef === "object" && loadOwesRef ? beginLoadOwes(loadOwesRef, authUserId) : null;
    try { return await readAccountForUser(authUserId, options, owes); }
    finally { owes?.finish(); }
  }

  // A write a load begins and does not wait for: never unhandled, and noted
  // on the load's record (`owes`) when the membership answer held or refused
  // it, or when it threw (the network): utils/loadOwes.js failed().
  function owedWrite(owes, write) {
    const settled = Promise.resolve(write).catch((error) => { owes?.failed(error); });
    owes?.track(settled);
    return settled;
  }

  // The self-heal push (bulkSync): rows kept for want of an answer are held
  // (onHeld); a row that did not land is told by how it failed (onFailed),
  // and nothing queues it (only a load pushes it again): on the network it
  // is lost (review of e1f4b4c9: a weak network failed the push, and the
  // record only on this device stayed there all session), refused by the
  // membership on the server it is held, and refused as permanent it is
  // neither, since a load again pushes it and is refused the same way, on
  // every launch (review of f06d9276; utils/loadOwes.js).
  function owedSync(owes, push) {
    return owedWrite(owes, push({ onHeld: () => owes?.held(), onFailed: kind => owes?.unlanded(kind) }));
  }

  async function readAccountForUser(authUserId, { quiet = false, fromWait = false } = {}, owes = null) {
    const generation = ++dataLoadGeneration.current;
    // What the server said about billed rows before this read began is in
    // what it reads (utils/serverBilling.js): dropped once it lands.
    const readBegan = Date.now();
    const current = () => generation === dataLoadGeneration.current
      && getActiveUserId() === authUserId
      && (offlineMode || window.Clerk?.user?.id === authUserId);
    // This account's records on screen as this load begins (a load again:
    // the membership answer, the deletion re-check), which the member can go
    // on changing while it reads. The replace at the end lays every change
    // made since over what it read (changesSinceLoadBegan, utils/loadRebase.js);
    // it used to drop a save that landed after its table was read. The
    // generation moved above also cancelled the cache write still waiting for
    // the last change (the debounced one below): it is written now, under the
    // same purge checks, so the device copy this load reads has it. That write
    // goes to IndexedDB and commits later: this load reads the device copy
    // only once it has landed or been refused (begun.flushed).
    const begun = beginLoadOver(authUserId);
    // Offline session: straight to this identity's own local cache — the
    // same read path the normal load falls back to when the cloud is
    // unreachable. No profile fetch, no Clerk token, no cloud reads.
    if (offlineMode) return loadLocalData(authUserId, current, begun);
    // How far the load got, for the fallback report below: "profile" until
    // the profile is ready (so the membership check can run), then "records".
    let loadStage = "profile";
    try {
      // Ensure profile exists for this auth user
      const profile = await ensureProfile(authUserId, { isCurrent: current });
      if (!current()) return;
      if (profile) {
        setProfileOwner(authUserId);
        loadStage = "records";
        setProfileIssue(null);
        setIdentityWaiting(null);
        // The server deleted this account's data (Delete All My Data on
        // another device, or the deletion 7 days after a cancellation) and
        // took the tombstone ledger with it; the account is open and empty
        // now (owner decision 2026-09-29). A device that has not yet purged
        // for THIS deletion still holds a copy that predates it: drop it,
        // vault, queued writes and device keys included, BEFORE the pending-op
        // replay and the self-heal push below can send it back up. The stamp
        // is per device, so every device purges once, however many sign-ins
        // the first one has done since. ensureProfile has usually done this
        // already from the sign-in receipt; this reads the row itself, which
        // also covers the path without continuity. src/utils/dataDeletion.js.
        const dataDeletedAt = accountDataDeletedAt(profile);
        if (dataDeletedAt) {
          // Records already in memory in this session (an open tab loading
          // again) were loaded before this deletion: stop showing them and
          // stop every edit and cache write from them before going on.
          const inMemoryStamp = loadedDeletionRef.current?.owner === authUserId ? loadedDeletionRef.current.stamp : null;
          if (dataOwnerRef.current === authUserId && !sameDeletionStamp(inMemoryStamp, dataDeletedAt)) {
            dataOwnerRef.current = null;
            setLoaded(false);
            setData(DEFAULT_DATA);
          }
          await honorAccountDataDeletion(authUserId, dataDeletedAt);
          if (!current()) return;
        }
        // What this device has purged for, now that this load has purged what
        // it had to: the records it reads from here on belong to it. Taken
        // here, not at the end, so a purge by another tab while this load runs
        // leaves them fenced instead of adopted.
        const loadedUnder = { owner: authUserId, stamp: lsGet(WIPE_SEEN_KEY, authUserId), fence: localFence(authUserId) };
        // The device copy is read from here on (the id repair first), once the
        // write of the records on screen this load began with has settled. A
        // read taken before it commits misses the last change made before this
        // load, and Protected Identity and the Answer Bank are nowhere else;
        // the id repair would also write that older copy back over it.
        if (begun?.flushed) { await begun.flushed; if (!current()) return; }
        // Records this device saved with an id the cloud can never accept
        // (manual deduction lines were "ded-..."): renamed to real uuids, with
        // their document links, queued writes and private notes, BEFORE the
        // replay and the self-heal push below try to send them again. This
        // read never clears an earlier load's unread mark (the records on
        // screen are still that load's); the repaired file is the stored one
        // it just read, so its save goes through the mark (readToken).
        // A read that could not look marks the copy unread, unless this load is
        // overtaken or the records on screen are the newer copy (readOfflineFile).
        const repairRead = { current, trustMemory: () => memoryIsNewer(authUserId, begun) };
        try {
          await repairStoredIds({
            readCached: () => readCachedData(authUserId, repairRead), saveCached: (blob) => saveData(blob, authUserId, { readToken: repairRead.token }),
            readQueue: () => lsGetJSON(BASE_KEYS.pendingOps, authUserId), writeQueue: (ops) => lsSetJSON(BASE_KEYS.pendingOps, ops, authUserId),
            readVault: () => lsGetJSON(BASE_KEYS.vault, authUserId), writeVault: (vault) => lsSetJSON(BASE_KEYS.vault, vault, authUserId),
            makeId: generateId,
          });
        } catch { /* storage unavailable: the rows stay listed as refused */ }
        if (!current()) return;
        // Replay any writes that never reached the cloud (offline edits and
        // deletes, transient failures) BEFORE reading back, so the snapshot we
        // merge already reflects them. With something queued, the deletion
        // ledger is read first: a queued save of a record deleted since (a
        // patient chart the read flagged, a record deleted on another device)
        // is dropped instead of re-created behind its tombstone. When the
        // ledger cannot be read, the queue waits for the next load.
        // What the replay leaves for want of an answer that allows it (before
        // the page load's first answer: every record save) is noted (owes):
        // that answer sends it.
        let replayed = null;
        if (pendingOpCount(authUserId) > 0) {
          let replayTombstones = null;
          try { replayTombstones = await listTombstones(profile.id); } catch { /* unread: replay waits */ }
          if (!current()) return;
          if (replayTombstones) {
            try {
              replayed = await replayPendingOps(profile.id, authUserId, { tombstones: replayTombstones });
              // Saves kept for want of a membership answer that the answer now refuses (lib/supabase.js accessRefused).
              for (const section of replayed?.refused || []) reportWriteAccess("write_refused", "read_only", section);
            } catch { replayed = null; /* offline */ }
          }
          owes?.noteReplay(replayed, pendingOpCount(authUserId));
        }
        if (!current()) return;
        let sbData;
        try {
          sbData = await loadFromSupabase(authUserId);
          if (!current()) return;
          // Do not hydrate, repair links, or cache an incomplete online read.
          // A fresh browser has no local rows with which to fill those gaps.
          assertCompleteAccountRecords(sbData, profile.id, COLLECTION_KEYS);
          // A PA or NP: the rule data loads while the rest of this load runs.
          // (Guarded: tests run this function alone, without the module's imports.)
          if (typeof preloadAppRules === "function" && needsAppRules(sbData)) preloadAppRules();
        } catch {
          if (!current()) return;
          throw accountRecordsLoadError();
        }
        setRecordsLoadIssue(null);
        if (sbData) {
          const profileId = sbData._userId;
          delete sbData._userId;
          delete sbData._errored;
          userIdRef.current = profileId;

          // Merge with defaults
          let merged = {
            ...DEFAULT_DATA,
            ...sbData,
            settings: { ...DEFAULT_DATA.settings, ...(sbData.settings || {}) },
          };

          // This account's own on-device copy. First load after the
          // namespacing change: decide what happens to the pre-namespace
          // keys (adopted only when this cloud profile already holds data
          // that overlaps the local file; see adoptLegacyStorage). A new
          // account therefore never pushes someone else's cache up.
          // `localRead`: whether this read got through. An earlier load's
          // unread mark stays until these records replace that load's on
          // screen (markOfflineCopyRead below): the debounced save of the
          // records still shown must not write over the copy meanwhile.
          const localRead = { current, trustMemory: () => memoryIsNewer(authUserId, begun) };
          let local = await readCachedData(authUserId, localRead);
          if (!current()) return;
          // Could not look, and the screen holds this account's records from a
          // read that got through: those records stand in for the device copy
          // (as in loadLocalData). Built from nothing instead, the load dropped
          // what only the device copy holds (the local-only settings, a
          // document whose file never uploaded, a record whose push has not
          // landed), and its own save then wrote that over the stored copy.
          // `held`: the screen these records keep is still the one the device
          // copy's last read built (storage.js adoptOfflineCopyRead).
          if (localRead.read !== true && screenStillHeld(authUserId, begun, loadedUnder)) { local = dataRef.current; localRead.held = true; }
          // Run adoption whenever legacy keys still exist, not only when the
          // namespaced slot is empty: an offline first load may have written
          // empty defaults under the new key, and the legacy vault must not
          // become unreachable because of that. Not when this device's copy
          // could not be read (IndexedDB would not open): null then means
          // "could not look", not "nothing there", and an older legacy file
          // must not be put over it. The next load decides.
          if ((!local || hasLegacyStorage()) && localRead.read === true) {
            const cloudIds = new Set();
            for (const key of COLLECTION_KEYS) for (const x of merged[key] || []) if (x?.id) cloudIds.add(x.id);
            const cloudHasData = cloudIds.size > 0 || !!merged.settings?.name;
            try {
              const adopted = adoptLegacyStorage(authUserId, { cloudIds, cloudHasData, hasLocalFile: !!local, readReceipt: localRead });
              local = adopted || local;
            } catch { /* keep local */ }
          }

          // Settings the cloud has no column for (LOCAL_ONLY_SETTINGS in
          // lib/supabase.js) come back from the merge above as undefined,
          // because loadFromSupabase can only rebuild what the profile row
          // holds. setData and saveData below then wrote that gap over the
          // on-device copy as well, so "Vera answers with: Claude Opus"
          // survived exactly until the next online load and then read
          // "Gemini (cheaper, the default)" again with nothing said. Only
          // the named keys are carried, and only where the cloud is silent:
          // merging all of local.settings would resurrect values deleted on
          // another device.
          merged.settings = withLocalOnlySettings(merged.settings, local?.settings);

          // Deletion ledger: anything deleted anywhere stays deleted. A ledger
          // that could not be read stops the load like a failed collection
          // read: without it, a record on this device only is either an
          // unsent save or a delete made elsewhere, and pushing it would undo
          // the delete.
          let tombstones;
          try { tombstones = await listTombstones(profileId); }
          catch { if (!current()) return; throw accountRecordsLoadError(); }
          if (!current()) return;
          // Nothing below waits: what the member changed since this load
          // began is complete here. The self-heal leaves those records to
          // their own writes (a copy of them in the device copy may be older,
          // or deleted since), and they are laid over the read below.
          const sinceStart = changesSinceLoadBegan(authUserId, begun, loadedUnder);
          if (tombstones.size > 0) {
            for (const key of COLLECTION_KEYS) {
              if (merged[key]?.length) merged[key] = merged[key].filter(x => !tombstones.has(x?.id));
            }
          }

          // Deletes and stars this device keeps for want of a membership
          // answer (refused ones included) stay as the member left them: the
          // account still holds the record, or its old star, until they go
          // up, and the merge above put that back on screen although the
          // notice says the change stays on this device. Read after the
          // replay, so only what is still waiting counts. utils/heldChanges.js.
          // So do the saves from an earlier session the replay above left for
          // want of any answer yet (replayed.unanswered): the page load's first
          // answer sends them without reading the account again
          // (settleFirstAnswer), and the screen already shows them as sent.
          const unanswered = new Set(Array.isArray(replayed?.unanswered) ? replayed.unanswered : []);
          if (unanswered.size) owes?.markLaidOver();
          const queued = lsGetJSON(BASE_KEYS.pendingOps, authUserId);
          const heldQueue = applyHeldQueue(merged, unanswered.size && Array.isArray(queued)
            ? queued.map(op => (op && unanswered.has(op.queueId) ? { ...op, awaitingAccess: true } : op)) : queued, COLLECTION_KEYS);
          merged = heldQueue.data;

          // These two unfinished editors have no cloud/restore registration.
          // Keep only this account's cached rows, respecting the deletion
          // ledger, before the merged snapshot replaces its local cache.
          merged = preservePausedApplicationRecords(merged, local, tombstones);

          if (local) {
            // Self-healing sync: any item that exists on this device but not
            // in the cloud gets pushed up on every load — a save whose cloud
            // write failed (offline, stale schema cache, old app version) is
            // retried automatically instead of being stranded on-device.
            // Trade-off: an item deleted in the cloud can be resurrected by a
            // device holding a stale copy; acceptable while data loss is the
            // greater risk.
            let pushed = 0;
            // This device's invoices another device recorded first: never in
            // the cloud, under a number one of the cloud's invoices carries
            // (the server keeps one invoice per number, and that one stands;
            // review of release/goal2). What this device billed onto them
            // follows the account's billing instead:
            //  - a row pushed with such an invoice's id goes up with the cloud
            //    row's invoice id (unbilled when the row is only here); a
            //    stipend marker made only for that invoice is not pushed;
            //  - a row pushed with an invoice id other than the one the
            //    account has it on (an invoice that exists) keeps the
            //    account's: the server refuses that move anyway (23P01);
            //  - a row the cloud has on such an invoice (its edit landed
            //    before the invoice was refused) moves to the account's
            //    invoice that lists it, or is unbilled when none does.
            const invoiceNumberOf = (x) => String(x?.number ?? "").trim().toLowerCase();
            const cloudInvoiceIds = new Set((merged.invoices || []).map(x => x?.id).filter(Boolean));
            const cloudInvoiceNumbers = new Set((merged.invoices || []).map(invoiceNumberOf).filter(Boolean));
            const droppedInvoices = new Set((local.invoices || [])
              .filter(x => x?.id && !cloudInvoiceIds.has(x.id) && cloudInvoiceNumbers.has(invoiceNumberOf(x))).map(x => x.id));
            const BILLED_KEYS = ["dutyDays", "workLog", "travelExpenses"];
            const stipendMarker = (key, x) => key === "workLog" && x?.type === "CallDay" && !x.startTime && !(Number(x.durationMin) > 0);
            const billedAsAccount = (key, x, cloud) => {
              if (!BILLED_KEYS.includes(key) || !x?.invoiceId) return x;
              if (!cloud) return !droppedInvoices.has(x.invoiceId) ? x : stipendMarker(key, x) ? null : { ...x, invoiceId: null };
              const movedOff = cloud.invoiceId && cloud.invoiceId !== x.invoiceId && cloudInvoiceIds.has(cloud.invoiceId);
              return droppedInvoices.has(x.invoiceId) || movedOff ? { ...x, invoiceId: cloud.invoiceId ?? null } : x;
            };
            if (droppedInvoices.size) {
              for (const key of BILLED_KEYS) {
                const repaired = (merged[key] || [])
                  .filter(x => x?.invoiceId && droppedInvoices.has(x.invoiceId) && !stipendMarker(key, x))
                  .map(x => {
                    const listing = (merged.invoices || []).find(inv => Array.isArray(inv?.entryIds) && inv.entryIds.includes(x.id)
                      && (key === "travelExpenses" ? inv.kind === "expenses" : inv.kind !== "expenses"));
                    return { ...x, invoiceId: listing?.id ?? null };
                  });
                if (!repaired.length) continue;
                const byId = new Map(repaired.map(x => [x.id, x]));
                merged[key] = merged[key].map(x => byId.get(x?.id) || x);
                owedSync(owes, notes => bulkSync(profileId, key, repaired, authUserId, notes));
                pushed += repaired.length;
              }
            }
            for (const key of COLLECTION_KEYS) {
              const localItems = local[key] || [];
              if (localItems.length === 0) continue;
              const cloudById = new Map((merged[key] || []).map(x => [x?.id, x]));
              // An invoice this device holds that never reached the cloud,
              // under a number the account's invoices already carry: recorded
              // on another device (the server keeps one invoice per number,
              // migration 20261002030000). The cloud's stands; this copy is
              // dropped, never pushed again (2026-10-02).
              const cloudNumbers = key === "invoices"
                ? new Set((merged[key] || []).map(x => String(x?.number ?? "").trim().toLowerCase()).filter(Boolean))
                : null;
              const toPush = [];
              // A document on this device only whose file never uploaded has
              // no storage path, and documents.storage_path is NOT NULL: no
              // row push can create it. It is kept in the merge, and
              // reconcileDocumentFiles below uploads the file and writes the
              // whole row in one step.
              const keepLocal = [];
              for (const x of localItems) {
                if (!x?.id || tombstones.has(x.id) || heldQueue.deleted.has(x.id) || sinceStart.touches(key, x.id)) continue;
                const cloud = cloudById.get(x.id);
                // An edit queued as what it changed, already laid over the
                // row read back (applyHeldQueue): replay sends it as that.
                // Pushed whole here, it put back every column the desk
                // changed since (review of 9484782c). A file given again
                // ("Upload it again") that has not reached Storage still goes
                // up, under that row: skipped, its bytes were the only copy,
                // and saveData dropped them under the old missing path
                // (review of 43b72a8f).
                if (heldQueue.edited?.has(`${key}:${x.id}`)) {
                  if (cloud && key === "documents" && !x.storagePath && x.data && x.pendingUpload) {
                    keepLocal.push({ ...cloud, data: x.data, type: x.type, size: x.size, storagePath: undefined, fileMissing: undefined, pendingUpload: true });
                  }
                  continue;
                }
                if (!cloud) { // never reached the cloud
                  if (cloudNumbers?.has(String(x.number ?? "").trim().toLowerCase())) continue;
                  if (key === "documents" && !x.storagePath) keepLocal.push(x);
                  else {
                    const row = billedAsAccount(key, x, null);
                    if (row) toPush.push(row);
                  }
                  continue;
                }
                // A local edit whose cloud write failed is newer than the cloud
                // row; push it so the edit isn't silently reverted on next load.
                const localT = x.updatedAt ? Date.parse(x.updatedAt) : 0;
                const cloudT = cloud.updatedAt ? Date.parse(cloud.updatedAt) : 0;
                // A document with bytes here and no storage path, whose row
                // exists. The file upload (it writes the whole row; a row
                // push cannot) takes it only when this copy is newer, or when
                // the bytes are a file given again ("Upload it again") that
                // has not reached Storage: then the row keeps the cloud's
                // details and gets the new file. Any other such copy was saved
                // before this device learned the path (an older version never
                // recorded it): the cloud row, perhaps filed or renamed on
                // another device since, stands, and the bytes are re-attached
                // below. Taken as newer, the stale copy used to replace the row
                // and unfile the document on every device.
                if (key === "documents" && !x.storagePath && x.data) {
                  if (localT && localT > cloudT) keepLocal.push(x);
                  else if (x.pendingUpload) keepLocal.push({ ...cloud, data: x.data, type: x.type, size: x.size, storagePath: undefined, fileMissing: undefined, pendingUpload: true });
                  continue;
                }
                // A document edit keeps the cloud's file location if this copy
                // never learned it.
                if (localT && localT > cloudT) toPush.push(key === "documents" && !x.storagePath ? { ...x, storagePath: cloud.storagePath } : billedAsAccount(key, x, cloud));
              }
              if (toPush.length > 0 || keepLocal.length > 0) {
                // Replace-in-place for rows already present, append the missing.
                const byId = new Map();
                for (const x of (merged[key] || [])) byId.set(x?.id, x);
                for (const x of [...toPush, ...keepLocal]) byId.set(x.id, x);
                merged[key] = [...byId.values()];
              }
              if (toPush.length > 0) {
                owedSync(owes, notes => bulkSync(profileId, key, toPush, authUserId, notes));
                pushed += toPush.length;
              }
            }
            if (!merged.settings.name && local.settings?.name) {
              merged.settings = { ...merged.settings, ...local.settings };
              owedWrite(owes, sbSaveSettings(profileId, merged.settings, authUserId));
            }
            if (pushed > 0) {
              console.log(`CredentialDOMD: pushed ${pushed} local item(s) to cloud`);
            }
          }

          // A save the replay left for want of an answer, of a record neither
          // the read nor this device's copy holds, shows as it will be sent
          // (utils/loadOwes.js layWithheldSaves).
          if (unanswered.size) {
            const takenNumbers = new Set((merged.invoices || []).map(x => String(x?.number ?? "").trim().toLowerCase()).filter(Boolean));
            merged = layWithheldSaves(merged, queued, unanswered, COLLECTION_KEYS, (key, id, item) => tombstones.has(id) || heldQueue.deleted.has(id)
              || (key === "invoices" && takenNumbers.has(String(item?.number ?? "").trim().toLowerCase())));
          }

          // Adds, edits, deletes, stars and settings made on this device since
          // this load began, over what it read: before the link sweep, so a
          // file linked to a record added meanwhile keeps its link.
          merged = rebaseLocalChanges(merged, sinceStart, tombstones);
          // Protected Identity and the Answer Bank when the screen already held
          // this account's records from a read that got through: those on
          // screen when nothing else has written the stored copy since (they
          // are the newer copy: a change whose save landed nowhere is in them,
          // and a read that failed takes nothing away), otherwise the changes
          // on screen laid over what was read (deviceOnlyOnScreen).
          merged = deviceOnlyOnScreen(authUserId, begun, loadedUnder, merged, local, localRead, tombstones);

          // Link sweep: a document pointing at an item that no longer exists
          // becomes unlinked (visible in Files) instead of phantom-linked. It
          // clears only links whose collection this version knows, and puts
          // back links an older version cleared but a custom record still
          // claims. See src/utils/documentLinks.js.
          const linkPass = reconcileDocumentLinks(merged, COLLECTION_KEYS, pausedApplicationLinks(merged));
          merged.documents = linkPass.documents;
          // Partial writes: a failure is queued as a narrow patch, never an
          // upsert that could not insert a row from two columns.
          for (const d of linkPass.cleared) {
            owedWrite(owes, sbUpdate(profileId, "documents", { id: d.id, linkedTo: "" }, d, authUserId, { partial: true }));
          }
          for (const d of linkPass.relinked) {
            owedWrite(owes, sbUpdate(profileId, "documents", { id: d.id, linkedTo: d.linkedTo }, d, authUserId, { partial: true }));
          }

          // A cloud document row carries metadata only (bytes live in Storage).
          // Re-attach any bytes this device still holds locally so the merge
          // can never overwrite the last copy of a file that was never uploaded
          // (or whose Storage object went missing).
          if (local?.documents?.length && merged.documents?.length) {
            const localBytes = new Map(
              local.documents.filter(d => d?.id && d.data).map(d => [d.id, d.data])
            );
            if (localBytes.size) {
              merged.documents = merged.documents.map(d =>
                (!d.data && localBytes.has(d.id)) ? { ...d, data: localBytes.get(d.id) } : d
              );
            }
          }
          // The files already on screen, for a load again of the account on
          // view (the app back in front, the membership answer): the device
          // copy never holds an uploaded file's bytes (saveData drops them
          // once it has a storagePath), so without this every return to the
          // front downloaded every stored file again (link audit, 2026-10-01).
          merged.documents = keepScreenFileBytes(authUserId, begun, loadedUnder, merged.documents);

          dataOwnerRef.current = authUserId;
          loadedDeletionRef.current = loadedUnder;
          adoptLocalFence(authUserId, loadedUnder.fence);
          // The records on screen are built from the file read above: an
          // earlier load's unread mark goes now, and not before. A read that
          // could not look leaves it (and set it).
          markOfflineCopyRead(authUserId, localRead);
          // The stored copy this read found is what these records are based on
          // (storage.js knownOfflineCopy).
          adoptOfflineCopyRead(authUserId, localRead);
          // At once, not at the next render: a change made before then starts
          // from these records, not from the ones they replace.
          dataRef.current = merged;
          setData(merged);
          setLoadedFrom("cloud");
          if (typeof setDeviceCopyBehind === "function") setDeviceCopyBehind(false);
          setLoaded(true);
          // (Guarded: tests run this function alone, without the module's imports.)
          if (typeof clearServerBilled === "function") clearServerBilled(readBegan);

          // Cache on-device under this account's key
          cachedRecordsRef.current = merged;
          // Once it lands, the copy holds what reached the account: a change
          // another page of this device made before this read began and never
          // stored no longer makes it "behind" (storage.js offlineCopyMayBeBehind).
          saveData(merged, authUserId, { loadBegan: readBegan }).catch(() => {});

          // Background: reconcile document FILES with cloud storage.
          //  - file on this device but not in the cloud → upload it
          // A file added while this load ran is uploaded by its own save.
          // A file in the cloud is NOT downloaded here any more: every file
          // of the account held as a data URL took 270 to 700 MB on the
          // owner's iPhone, and iOS discarded the page in Gmail mid-share
          // (2026-10-02). A screen that shows a file asks for its bytes
          // (requestDocumentBytes) and lets them go when it closes.
          owedWrite(owes, reconcileDocumentFiles(profileId, (merged.documents || []).filter(d => !(sinceStart.touches("documents", d?.id) && !d?.storagePath)), authUserId, current, owes));
          owes?.markCloud();
          return;
        }
      }
    } catch (err) {
      if (!current()) return;
      if (quiet) return;
      // No answer from the identity check at all, after its retries: a weak
      // signal at launch, not an identity problem. The account's own device
      // copy opens read-only (the screen says so), and the check is asked
      // again on its own (identity retry below). It used to stop on "Your
      // account identity could not be verified" with no records until a
      // Reload tap, on the owner's iPhone (2026-10-01).
      if (err.code === "continuity_initialization_failed" && err.transient === true && !err.recoveryConflict) {
        const supportReference = profileSupportReference(err);
        accessAuthority.suspendWrites();
        setProfileIssue(null);
        setIdentityWaiting({ accountId: authUserId, supportReference });
        reportUnlessLeaving(`Account load used this device's copy, read-only (${supportReference}).`);
        if (current()) loadLocalData(authUserId, current, begun);
        return;
      }
      if (fromWait && err.code === "account_records_unavailable" && dataOwnerRef.current === authUserId) {
        accessAuthority.suspendWrites();
        setProfileOwner(null);
        setIdentityWaiting({ accountId: authUserId, supportReference: ACCOUNT_RECORDS_SUPPORT_REFERENCE });
        reportUnlessLeaving(`Account records load used this device's copy, read-only (${ACCOUNT_RECORDS_SUPPORT_REFERENCE}).`);
        return;
      }
      setIdentityWaiting(null);
      if (["continuity_initialization_failed", "continuity_retirement_unavailable", "account_records_unavailable"].includes(err.code)) {
        // An unresolved identity or incomplete cloud read must never appear
        // as a fresh empty account. Preserve every existing disk copy.
        accessAuthority.suspendWrites();
        dataOwnerRef.current = null;
        userIdRef.current = null;
        setProfileOwner(null);
        // Not reported when the page is being left: a reload aborts its own
        // reads, and that is the member leaving, not a failure (OPS-008).
        if (err.code === "account_records_unavailable") {
          reportUnlessLeaving(`Account records load stopped (${ACCOUNT_RECORDS_SUPPORT_REFERENCE}).`);
          setRecordsLoadIssue({ accountId: authUserId, supportReference: ACCOUNT_RECORDS_SUPPORT_REFERENCE });
        } else {
          const supportReference = profileSupportReference(err);
          // Report only the allowlisted reference, never the underlying error.
          reportUnlessLeaving(`Account load stopped (${supportReference}).`);
          setProfileIssue({ accountId: authUserId, supportReference, message: (err.recoveryConflict
            ? "An existing device copy needs a recovery review. Your saved data has not been overwritten. Please contact support."
            : "Your account identity could not be verified. Your existing records have not changed. Reload to try again.")
            + ` Support reference: ${supportReference}.` });
        }
        setData(DEFAULT_DATA);
        setLoadedFrom(null);
        setLoaded(true);
        return;
      }
      console.warn("CredentialDOMD: Supabase load failed:", err.message);
      // The app now opens on this device's copy. When the profile never became
      // ready (PROFILE), no membership check can run until a reload, and the
      // page says so with a Reload button. Tell the operator once per session,
      // with fixed vocabulary only (the stage, and an allowlisted error code or
      // browser error name), never the underlying message.
      reportUnlessLeaving(`Account load used this device's copy (${localFallbackReference(loadStage, err)}).`);
    }

    // Fallback to this account's own local copy (offline)
    if (current()) loadLocalData(authUserId, current, begun);
  }

  // The records on screen as a load of `authUserId` begins, and the purge
  // they were loaded under; null when the screen holds none of this
  // account's records (a first load, another account, a purge in progress).
  // The cache write the new generation cancelled is written here, unless this
  // device has purged since those records loaded (the cache effect's checks).
  // It goes through saveData like that write: into IndexedDB under the purge
  // fence and the unread mark, both checked again as it commits. `flushed`
  // settles once it has landed or been refused (null when none was begun).
  //
  // Only a write that is owed: records on screen that were never handed to
  // saveData (cachedRecordsRef). With nothing owed, writing them anyway put
  // this window's older copy over rows another window had saved since, and
  // the load then read that older copy back.
  //
  // `heldFromScreen`: the records on screen were built from a read of the
  // offline copy that got through (not unread), so what they hold of the
  // device-only sections counts (deviceOnlyOnScreen, memoryIsNewer).
  function beginLoadOver(authUserId) {
    const under = dataOwnerRef.current === authUserId && loadedDeletionRef.current?.owner === authUserId ? loadedDeletionRef.current : null;
    if (!under || !dataRef.current) return null;
    const records = dataRef.current;
    const owed = records !== cachedRecordsRef.current;
    const flushed = owed && sameDeletionStamp(under.stamp ?? null, lsGet(WIPE_SEEN_KEY, authUserId))
      && localCopyCurrent(authUserId, under.fence ?? null) ? saveData(records, authUserId).catch(() => false) : null;
    if (flushed) cachedRecordsRef.current = records;
    // Also while Protected Identity or Answer Bank changes are on screen only
    // ("memory": an earlier load whose read failed kept them over the stored
    // copy it could not read, and there was no room to hold them aside): the
    // screen is still based on the copy last read (storage.js knownOfflineCopy),
    // so this load lays those changes over what it reads. Taken for records
    // built without the file, the retry load dropped them and cleared the notice.
    // A load that put records built without the file on screen ends that
    // state (storage.js adoptOfflineCopyRead): it no longer describes them.
    const heldFromScreen = !offlineCopyUnread(authUserId) || deviceOnlyUnsavedState(authUserId) === "memory";
    return { records, under, flushed, heldFromScreen };
  }

  // The records on screen as the load `begun` began are still this account's,
  // under the same purge, and were built from a read that got through.
  function screenStillHeld(authUserId, begun, loadedUnder) {
    if (!begun?.heldFromScreen || dataOwnerRef.current !== authUserId || loadedDeletionRef.current !== begun.under || !dataRef.current) return false;
    if (loadedUnder && (!sameDeletionStamp(begun.under.stamp ?? null, loadedUnder.stamp ?? null)
      || (begun.under.fence ?? null) !== (loadedUnder.fence ?? null))) return false;
    return true;
  }

  // Are the records on screen the newer copy of Protected Identity and the
  // Answer Bank than the stored one? Built from a read that got through, and
  // nothing but this tab has written the stored copy since (storage.js
  // offlineCopyUnchangedSinceKnown). A read of the copy that fails then takes
  // nothing from the screen and marks nothing unread (readOfflineFile).
  function memoryIsNewer(authUserId, begun) {
    return screenStillHeld(authUserId, begun, null) && offlineCopyUnchangedSinceKnown(authUserId);
  }

  // `merged` with the device-only sections a load shows when the screen held
  // this account's records (storage.js deviceOnlyForLoad): the screen's when
  // they are the newer copy, or when this read could not look (they stay on
  // screen, and the changes in them are held aside); otherwise the changes on
  // screen laid over the read. A record in the deletion ledger never returns.
  // Taken after the load's last await, from the records on screen then, so a
  // change made during the load is in them. Unchanged when the screen held
  // nothing of this account's that counts: the read's sections stand.
  function deviceOnlyOnScreen(authUserId, begun, loadedUnder, merged, read, receipt, tombstones = null) {
    if (!screenStillHeld(authUserId, begun, loadedUnder)) return merged;
    const sections = deviceOnlyForLoad(authUserId, dataRef.current, read, receipt?.read === true);
    return sections ? preservePausedApplicationRecords(merged, sections, tombstones || new Set()) : merged;
  }

  // What the member changed on screen since the load `begun` began, for the
  // records it read under `loadedUnder` (utils/loadRebase.js). None when the
  // screen no longer holds those records, or they belong to another purge:
  // this device purged since, and they must not come back.
  function changesSinceLoadBegan(authUserId, begun, loadedUnder) {
    if (!begun || dataOwnerRef.current !== authUserId || loadedDeletionRef.current !== begun.under) return localChangesSince(null, null);
    if (!sameDeletionStamp(begun.under.stamp ?? null, loadedUnder?.stamp ?? null)
      || (begun.under.fence ?? null) !== (loadedUnder?.fence ?? null)) return localChangesSince(null, null);
    return localChangesSince(begun.records, dataRef.current);
  }

  // `docs` with the bytes of the files on screen put back, when the screen
  // holds this account's records under the same purge as this load: matched
  // by id and the same stored file (documentBytes storedFileOf: storagePath,
  // size and MIME type, so a file given again on another device, written to
  // the same path, downloads, and an emailed file just filed does not).
  function keepScreenFileBytes(authUserId, begun, loadedUnder, docs) {
    if (!Array.isArray(docs) || !docs.length || !begun || dataOwnerRef.current !== authUserId || loadedDeletionRef.current !== begun.under) return docs;
    if (!sameDeletionStamp(begun.under.stamp ?? null, loadedUnder?.stamp ?? null)
      || (begun.under.fence ?? null) !== (loadedUnder?.fence ?? null)) return docs;
    const onScreen = new Map((dataRef.current?.documents || [])
      .filter(d => d?.id && d.data && d.storagePath && !d.fileMissing).map(d => [d.id, d]));
    if (!onScreen.size) return docs;
    return docs.map(d => {
      const shown = !d?.data && d?.storagePath ? onScreen.get(d.id) : null;
      return shown && storedFileOf(shown) === storedFileOf(d) ? { ...d, data: shown.data } : d;
    });
  }

  // Files on this device that are not in the cloud yet: each is uploaded
  // with its whole row. A file in the cloud is never downloaded here: a
  // screen that shows it asks for its bytes (requestDocumentBytes,
  // utils/documentBytes.js) and lets them go when it closes.
  async function reconcileDocumentFiles(profileId, docs, authUserId, current, owes = null) {
    for (const doc of docs) {
      if (!current()) return;
      try {
        if (doc.data && !doc.storagePath) {
          // The file AND its whole row, in one step (lib/supabase.js). The
          // path is set here only once both landed: a storagePath makes the
          // cache drop these bytes, which may be the only copy. One kept for
          // want of a membership answer, or refused by it, is owed (owes),
          // and so is one that failed on the network, which nothing else
          // sends again before the next load. One refused as permanent is
          // not: the next load uploads it again and meets the same refusal
          // (review of f06d9276).
          const path = await uploadDocumentFile(doc, authUserId, profileId, { onHeld: () => owes?.held(), onFailed: kind => owes?.unlanded(kind) });
          if (!current()) return;
          if (path) {
            const updated = { ...doc, storagePath: path, pendingUpload: undefined };
            setData(d => current() ? ({ ...d, documents: d.documents.map(x => x.id === doc.id ? updated : x) }) : d);
          }
        }
      } catch (error) { owes?.failed(error); /* per-file best effort, retried on next load */ }
    }
  }

  async function loadLocalData(authUserId, current, begun = null) {
    // As on a cloud load: the device copy is read once the write this load
    // began with has settled (beginLoadOver).
    if (begun?.flushed) { await begun.flushed; if (!current()) return; }
    const loadedUnder = { owner: authUserId || null, stamp: lsGet(WIPE_SEEN_KEY, authUserId), fence: localFence(authUserId) };
    const localRead = { current, trustMemory: () => memoryIsNewer(authUserId, begun) };
    let d = await loadData(authUserId, localRead);
    if (!current()) return;
    // Read as the copy is: a page left before its last save landed (and too
    // large, or blocked, to be put in localStorage then) left it marked.
    // (Guarded: tests run this function alone, without the module's imports.)
    const behind = !!authUserId && typeof offlineCopyMayBeBehind === "function" && offlineCopyMayBeBehind(authUserId);
    if (d._userId) {
      userIdRef.current = d._userId;
      delete d._userId;
    }
    if (localRead.read !== true && screenStillHeld(authUserId, begun, loadedUnder)) {
      // The device copy could not be read, and the screen holds this
      // account's records from one that could: they stay (the fallback here
      // is empty defaults, or an older native copy). Their device-only
      // changes are held aside when another tab has written since.
      deviceOnlyForLoad(authUserId, dataRef.current, null, false);
      d = dataRef.current;
      localRead.held = true;
    } else {
      // Changed on screen while the device copy was read: kept, as on a cloud load.
      d = rebaseLocalChanges(d, changesSinceLoadBegan(authUserId, begun, loadedUnder));
      d = deviceOnlyOnScreen(authUserId, begun, loadedUnder, d, d, localRead);
    }
    dataOwnerRef.current = authUserId || null;
    loadedDeletionRef.current = loadedUnder;
    if (authUserId) adoptLocalFence(authUserId, loadedUnder.fence);
    // As in loadDataForUser: the unread mark goes only as records built from
    // a read that got through go on screen.
    if (authUserId) { markOfflineCopyRead(authUserId, localRead); adoptOfflineCopyRead(authUserId, localRead); }
    dataRef.current = d;
    setData(d);
    setLoadedFrom("local");
    if (typeof setDeviceCopyBehind === "function") setDeviceCopyBehind(behind);
    setLoaded(true);
  }

  // Saves kept on this device for want of a membership answer (queued
  // awaitingAccess, lib/supabase.js) go up as soon as a check answers, not at
  // the next launch. Replay sends each only if that answer allows it. One the
  // answer refuses (the membership is read-only now) is marked, so the notice
  // says it was not saved instead of promising a sync, and it is reported.
  // `all`: every queued save, kept for an answer or not (the page load's first
  // answer, when the load's replay withheld saves for want of one:
  // settleFirstAnswer).
  //
  // Nothing goes up that predates a data deletion. Delete All My Data on
  // another device empties the account AND its deletion ledger, so every save
  // queued here before it would come back as a new record. As on a load
  // (utils/dataDeletion.js), the account's deletion stamp is read first: a
  // new one (or a purge by another tab here) sends nothing and loads the
  // account again, which purges this device's copy before anything is
  // replayed. A stamp that cannot be read sends nothing either; the next
  // answer or the next load asks again. Then the deletion ledger, so nothing
  // deleted since is put back. What the replay still withholds is noted on
  // the latest load's record (owes), for an answer that allows it.
  //
  // Returns null when it did not run (nothing to send, or not this account's
  // records any more), else what happened: the replay's result, or
  // { reloaded } (a deletion: the account loads again), { failed } (the
  // stamp, the ledger or the network), { stale } (a newer load took over).
  // `all` while another replay of this account runs: this one waits for it,
  // then runs on what is left.
  function replayKeptSaves(ownerId, { all = false } = {}) {
    if (!ownerId) return null;
    const running = replayingRef.current;
    if (running?.owner === ownerId) return all ? running.run.then(() => replayKeptSaves(ownerId, { all })) : null;
    const waiting = awaitingAccessOpCount(ownerId);
    if (waiting === 0 && !(all && pendingOpCount(ownerId) > 0)) return null;
    // Every kept save is marked refused already and this answer allows no
    // change: nothing to send and nothing new to mark.
    if (accessRefusedOpCount(ownerId) >= waiting
      && !["credential", "practice"].some(scope => accessAuthority.allows(scope, "write", ownerId))) return null;
    const profileId = userIdRef.current;
    const under = loadedDeletionRef.current?.owner === ownerId ? loadedDeletionRef.current : null;
    const current = () => dataOwnerRef.current === ownerId && getActiveUserId() === ownerId
      && userIdRef.current === profileId && loadedDeletionRef.current === under;
    if (!profileId || !under || !current()) return null;
    // This device purged since these records loaded (another tab honored a
    // deletion, or ran Delete All My Data): no request needed.
    const purgedHere = () => !sameDeletionStamp(under.stamp ?? null, lsGet(WIPE_SEEN_KEY, ownerId))
      || !localCopyCurrent(ownerId, under.fence ?? null);
    const loadAgain = () => { setLoaded(false); void loadDataForUser(ownerId); return { reloaded: true }; };
    const mark = { owner: ownerId, run: null };
    replayingRef.current = mark;
    mark.run = (async () => {
      try {
        if (purgedHere()) return loadAgain();
        const stamp = await readAccountDataDeletion(ownerId);
        if (!current()) return { stale: true };
        if ((stamp && !sameDeletionStamp(under.stamp ?? null, stamp)) || purgedHere()) return loadAgain();
        const tombstones = await listTombstones(profileId);
        if (!current() || purgedHere()) return { stale: true };
        const replayed = (await replayPendingOps(profileId, ownerId, { tombstones })) || { refused: [], withheld: 0, unanswered: [] };
        for (const section of replayed?.refused || []) reportWriteAccess("write_refused", "read_only", section);
        // Only what is still withheld: a debt the load noted (its own replay
        // could not run) stays for the first answer's read (utils/loadOwes.js).
        const owes = loadOwesRef.current;
        if (owes?.owner === ownerId) owes.noteAnswerReplay(replayed);
        return replayed;
      } catch { return { failed: true }; /* the stamp, the ledger or the network: the next answer, or the next load, tries again */ }
      finally { if (replayingRef.current === mark) replayingRef.current = null; }
    })();
    return mark.run;
  }

  // Delete All My Data on another device since the latest load read this
  // account: "same"; "moved" (a newer load is on screen, or the account is
  // not this one's any more); "purge" (the stamp moved, or this device
  // purged: the account loads again behind the loading screen, as a replay
  // that meets a deletion does); "unread" (the stamp cannot be read, or the
  // load noted none: only a read again settles it). One profile read.
  async function deletionSinceLoad(ownerId) {
    const under = loadedDeletionRef.current?.owner === ownerId ? loadedDeletionRef.current : null;
    if (!under) return "unread";
    const purgedHere = () => !sameDeletionStamp(under.stamp ?? null, lsGet(WIPE_SEEN_KEY, ownerId))
      || !localCopyCurrent(ownerId, under.fence ?? null);
    if (purgedHere()) return "purge";
    let stamp;
    try { stamp = await readAccountDataDeletion(ownerId); } catch { return "unread"; }
    if (loadedDeletionRef.current !== under || dataOwnerRef.current !== ownerId) return "moved";
    return (stamp && !sameDeletionStamp(under.stamp ?? null, stamp)) || purgedHere() ? "purge" : "same";
  }

  // The membership check answered and allows changes (the effect below calls
  // this with the scopes it allows as `key`). The page load's first such
  // answer used to read the whole account again, about 37 table reads and a
  // second write of the device copy on every launch (2026-10-02), although
  // the load before it had read everything. It now finishes only what that
  // load left for it (settleFirstAnswer). A later change of the scopes in the
  // same session (read-only to active, Practice added: enrollment finishing
  // after the load) still reads the account again, as it always did.
  function reconcileAccessAnswer(ownerId, key) {
    const earlier = reconciledAccess.current;
    if (earlier === key) return null;
    reconciledAccess.current = key;
    if (typeof earlier === "string" && earlier.startsWith(`${ownerId}:`)) return loadDataForUser(ownerId);
    return settleFirstAnswer(ownerId);
  }

  // The first answer that allows changes, after the latest load of the
  // account and the writes it began have settled (or OWED_WRITES_WAIT_MS has
  // passed: a write still in flight then is decided when it settles). The
  // account is read again when that load held or lost a write (for want of
  // an answer, or on the network), when its replay could not run, when it
  // never finished a cloud read, or when Delete All My Data ran elsewhere
  // since (the stamp is read on every first answer: one profile read; one
  // that cannot be read is a load too). Saves its replay withheld, and
  // anything its writes queued, are sent by a replay (the stamp and the
  // deletion ledger, no table reads). utils/loadOwes.js.
  async function settleFirstAnswer(ownerId) {
    let owes = loadOwesRef.current;
    let timedOut = false;
    while (owes && owes.owner === ownerId) {
      await owes.done;
      let timer = null;
      timedOut = false;
      await Promise.race([owes.settled(), new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, OWED_WRITES_WAIT_MS); })]);
      clearTimeout(timer);
      if (loadOwesRef.current === owes) break;
      owes = loadOwesRef.current;
    }
    const mine = () => dataOwnerRef.current === ownerId && getActiveUserId() === ownerId && window.Clerk?.user?.id === ownerId;
    if (!mine()) return;
    // A write still in flight at the deadline that then did not land: the
    // load it owes, once it is known (the plan below could not see it).
    if (timedOut && owes) {
      void owes.settled().then(() => {
        if (loadOwesRef.current === owes && mine() && (owes.lostWrites || owes.heldWrites) && firstAnswerPlan(owes, ownerId) === "load") void loadDataForUser(ownerId);
      });
    }
    const plan = firstAnswerPlan(owes, ownerId, pendingOpCount(ownerId));
    if (plan === "load") { await loadDataForUser(ownerId); return; }
    if (plan === "replay") {
      const replayed = await replayKeptSaves(ownerId, { all: true });
      if (replayed?.reloaded || replayed?.stale) return;
      // A send that failed and can still land (the network, a membership
      // refusal) is not on screen: read again. One refused as permanent
      // would be refused the same way on the read (utils/loadOwes.js).
      if (replayLeftUnsent(replayed)) { if (loadOwesRef.current === owes && mine()) await loadDataForUser(ownerId); return; }
      if (replayed) {
        if (readAfterReplay(owes, replayed) && loadOwesRef.current === owes && mine()) await loadDataForUser(ownerId);
        return;
      }
      // The replay did not run (nothing left to send): the stamp, as below.
    }
    const since = await deletionSinceLoad(ownerId);
    if ((since !== "purge" && since !== "unread") || loadOwesRef.current !== owes || !mine()) return;
    if (since === "purge") setLoaded(false);
    await loadDataForUser(ownerId);
  }

  // ─── Auth actions (Clerk) ─────────────────────────────────
  const handleSignOut = useCallback(async () => {
    // Shared-AI status is per account; the next user must re-check.
    try { resetSharedAiStatus(); } catch { /* ignore */ }
    const ownerId = user?.id || getActiveUserId();
    // Protected Identity and the Answer Bank exist only in this device's copy
    // of the file (DEVICE_ONLY_SECTIONS), so the purge below erases them for
    // good unless a full JSON backup holds them. Name them before that point.
    // Counted from the disk copies too, not memory alone: the identity-check
    // failure screen and the membership check hold empty defaults while the
    // disk still has the rows, and both offer Sign out.
    const { counts: onDevice, unread: uncounted } = await deviceOnlyRecordCounts(ownerId, dataRef.current);
    const deviceOnly = Object.entries(DEVICE_ONLY_SECTIONS)
      .map(([key, label]) => [label, onDevice[key] || 0])
      .filter(([, count]) => count > 0);
    if (deviceOnly.length && typeof window !== "undefined" && !window.confirm(
      `Signing out erases the ${deviceOnly.map(([label, count]) => `${count} ${label} record${count === 1 ? "" : "s"}`).join(" and ")} kept only on this device. Save a full JSON backup under More, Data & Backup first${onDevice.identityVault ? "; its SSN and date of birth stay encrypted with your lock code" : ""}. Sign out anyway?`
    )) return;
    // The device's offline copy could not be read, by this session's load or
    // by the count just now (its offline storage would not open), so the
    // Protected Identity and Answer Bank rows in it are not in memory and
    // could not be counted above. Sign out is offered before any load has
    // read it (the identity-check and membership screens), so the load's
    // mark alone is not enough. The purge erases them all the same: say so
    // before it does.
    if ((uncounted || offlineCopyUnread(ownerId)) && typeof window !== "undefined" && !window.confirm(
      "This device's offline storage could not be read, so Protected Identity and Answer Bank records kept only on this device could not be counted. Signing out erases them. Reload the app first to see them and save a full JSON backup. Sign out anyway?"
    )) return;
    // The vault is erased with everything else on sign-out and those notes
    // exist nowhere else, so say so once when there is something to lose.
    const n = vaultCount();
    if (n > 0 && typeof window !== "undefined" && !window.confirm(
      `Signing out erases the ${n} private note${n === 1 ? "" : "s"} kept only on this device. Export them first under Data & Backup if you need them. Sign out anyway?`
    )) return;
    // The purge also destroys the unsynced-edits queue, and those edits exist
    // nowhere else yet. Offline, reconnecting first would sync them; online,
    // they are writes the cloud refused and a reload retries them. Say so
    // before the point of no return, on both paths.
    // Every queued op is a change somebody made: the Setup board's own
    // stamps are never kept on the queue (lib/supabase.js saveSettings). A
    // member's edit still waiting on its first membership answer is counted
    // too, since signing out now would discard it.
    const pending = pendingOpCount(ownerId);
    if (pending > 0 && typeof window !== "undefined" && !window.confirm(
      offlineMode
        ? `You have ${pending} change${pending === 1 ? "" : "s"} made offline that have not synced yet. Signing out now discards them permanently. Reconnect first to keep them. Sign out anyway?`
        : `You have ${pending} change${pending === 1 ? "" : "s"} that have not reached the cloud yet. Signing out now discards them permanently. Reload the app first to retry them. Sign out anyway?`
    )) return;
    // A running Work timer is kept only on this device (WorkLog.jsx, under
    // BASE_KEYS.timer), and the purge removes it with its start time, so the
    // time it has run is lost unless Stop & Log saves it as an entry first.
    let timer = null;
    try { timer = lsGetJSON(BASE_KEYS.timer, ownerId); } catch { timer = null; }
    if (timer && typeof timer === "object" && timer.startedAt && typeof window !== "undefined") {
      const started = new Date(timer.startedAt);
      const at = Number.isFinite(started.getTime()) ? ` started at ${started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
      if (!window.confirm(
        `A Work timer${at} is still running on this device. Signing out stops it and its time is not recorded. Tap Stop & Log under Practice, Work first to save it as an entry. Sign out anyway?`
      )) return;
    }
    // Persist retirement before clearing anything. A failure leaves the user
    // signed in with their in-memory data and actionable explanation intact.
    try { retireContinuityRecovery(ownerId); }
    catch (error) { window.alert(error.message); return; }
    // Deliberate: Clerk's session-end listener (here and in other tabs) must
    // purge everything, not keep what it keeps for an expired session. The
    // marker's key names this account; the purge below removes it, and every
    // tab keeps what it noted in memory (storageScope.js SIGNOUT_INTENT_BASE).
    markDeliberateSignOut(ownerId);
    invalidateAccountWrites(ownerId);
    // The membership authority serves nobody from here on. A check still in
    // flight can otherwise land while Clerk still reports this account and
    // write its answer back after the purge; session expiry keeps that key,
    // so the listener's purge would leave it behind.
    accessAuthority.reset(null);
    dataLoadGeneration.current += 1;
    configureSecretContinuity(null);
    // Past the point of no return. Drop the in-memory file and its owner
    // BEFORE the purge, so the debounced cache write cannot put the record
    // set back under this account's key, then purge everything this account
    // kept on the device: the file (license and DEA numbers included), the
    // private vault, the Assistant transcript and archives, the live timer,
    // the offline identity slot, and the device-key slot (AI keys and the
    // portal password lock code). The next person on this device inherits
    // nothing, and the offline fallback can never reopen as this account.
    // The purge runs before Clerk ends the session on purpose: afterSignOutUrl
    // navigates the page away, and what happens after that await must not
    // be what keeps a shared workstation clean.
    userIdRef.current = null;
    dataOwnerRef.current = null;
    setData(DEFAULT_DATA);
    setLoaded(false);
    await clearLocalData(ownerId);
    if (offlineMode) {
      // No Clerk session to end; reload into the normal boot path.
      window.location.reload();
      return;
    }
    try {
      await clerkSignOut();
    } catch (err) {
      console.warn("Sign out failed:", err.message);
    }
  }, [clerkSignOut, user?.id, offlineMode]);

  // Persist the offline copy on change (IndexedDB, with localStorage as the
  // fallback, utils/storage.js saveData), under the key of the account the
  // data was loaded for. The first change after a quiet spell is written on
  // the next turn of the event loop, and changes that follow within 300 ms
  // go out together in one trailing write.
  //
  // A record added and the page reloaded at once (or iOS discarding the app)
  // was missing from the device copy, and a weak-signal launch then showed
  // "No saved records in this section" (lab, release goal2). Two causes:
  // every change waited 300 ms, and a reload inside that window cleared the
  // timer with the page; and a save handed over in time still goes through
  // several IndexedDB steps (the purge check, the open, a read and a put in
  // one transaction) that never run once the page is torn down. An IndexedDB
  // write begun in pagehide never lands either (storageScope.js
  // spillOfflineText, measured in WebKit and Chromium). So when the page is
  // left (beforeunload, pagehide, hidden, a reload the app asks for, below)
  // the trailing write is handed over at once and the save still under way
  // is put into localStorage synchronously, which the next launch reads
  // first. Where that cannot be done (a copy too large for localStorage, or
  // another tab wrote since), the copy stays marked behind and the launch
  // that reads it says so (deviceCopyBehind).
  const saveTimer = useRef(null);
  const cacheWriteGeneration = useRef(0);
  const pendingCacheWrite = useRef(null);
  const lastCacheWriteAt = useRef(0);
  // (Guarded: tests run these effects alone, without the module's imports.)
  const markPending = (owner, pending, how) => { if (typeof setCacheWritePending === "function") setCacheWritePending(owner, pending, how); };
  useEffect(() => {
    if (!loaded) {
      if (pendingCacheWrite.current) markPending(pendingCacheWrite.current.owner, false);
      pendingCacheWrite.current = null;
      return;
    }
    clearTimeout(saveTimer.current);
    const owner = dataOwnerRef.current;
    const generation = dataLoadGeneration.current;
    const cacheGeneration = cacheWriteGeneration.current;
    const before = pendingCacheWrite.current;
    if (before && before.owner !== owner) markPending(before.owner, false);
    // Already handed to saveData (the load that put them on screen saved
    // them): nothing is owed, and the copy is current once that save lands.
    if (data === cachedRecordsRef.current) {
      pendingCacheWrite.current = null;
      if (owner) markPending(owner, false, { current: true });
      return undefined;
    }
    const write = () => {
      if (pendingCacheWrite.current === write) pendingCacheWrite.current = null;
      lastCacheWriteAt.current = Date.now();
      if (owner) markPending(owner, false);
      if (!owner || dataOwnerRef.current !== owner || getActiveUserId() !== owner
        || dataLoadGeneration.current !== generation
        || cacheWriteGeneration.current !== cacheGeneration) return;
      // Already handed to saveData (the load that put them on screen saved them).
      if (data === cachedRecordsRef.current) return;
      // Not over a copy this device purged since these records loaded (a
      // server data deletion honored by another tab, or Delete All My Data
      // run in one): records loaded before it must not be written back for
      // the self-heal push to send up again (src/utils/dataDeletion.js).
      const loadedUnder = loadedDeletionRef.current?.owner === owner ? loadedDeletionRef.current : null;
      if (sameDeletionStamp(loadedUnder?.stamp ?? null, lsGet(WIPE_SEEN_KEY, owner))
        && localCopyCurrent(owner, loadedUnder ? loadedUnder.fence ?? null : undefined)) { cachedRecordsRef.current = data; saveData(data, owner); }
    };
    write.owner = owner;
    // Checked when the write runs, not now: an account switch, a newer load
    // or a purge in between stops it (the guards above).
    const quiet = !before && Date.now() - lastCacheWriteAt.current >= 300;
    pendingCacheWrite.current = write;
    if (owner) markPending(owner, true);
    saveTimer.current = setTimeout(write, quiet ? 0 : 300);
    return () => clearTimeout(saveTimer.current);
  }, [data, loaded]);
  // The page is being left, or put in the background: the trailing write is
  // handed over now, and the save under way is put into localStorage, where
  // it survives the page (storage.js spillOfflineSave). Nothing waits.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const flush = () => {
      const write = pendingCacheWrite.current;
      if (write) { clearTimeout(saveTimer.current); write(); }
      const owner = dataOwnerRef.current;
      if (owner && getActiveUserId() === owner && typeof spillOfflineSave === "function") spillOfflineSave(owner);
    };
    const onVisibility = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") flush(); };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    // A reload the app asks for (utils/pageLeave.js reloadPage) flushes first.
    const offLeave = typeof onPageLeave === "function" ? onPageLeave(flush) : () => {};
    return () => {
      offLeave();
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // ─── Subscription ─────────────────────────────────────────
  const { plan, isPro, isPractice, loading: subLoading, periodEnd, checkout: sbCheckout, manage: sbManage, setMockPlan, isDevMode, hasSubscription, isFreeBeta, isLifetime, limitedLaunch, canWriteCredential, canWritePractice, credentialReadOnly, practiceReadOnly } = useSubscription(user ?? null, { profileReady: !offlineMode && profileOwner === user?.id });
  // Back from Stripe (?billing=complete|canceled): confirm the purchase, or say nothing was charged.
  const billingReturn = useBillingReturn(limitedLaunch, user?.id);
  // A membership that turns active while the app is open (back from Checkout
  // before Stripe's events land, an invitation activated) asks ai-proxy again,
  // so the shared AI it includes is on without a reload (BILL-003).
  const membershipStatus = limitedLaunch.access?.accessStatus ?? null;
  useEffect(() => { noteMembershipStatus(membershipStatus); }, [membershipStatus]);

  // Enrollment may finish after the initial cloud load. When protected write
  // scopes become available, finish what the load left for them
  // (reconcileAccessAnswer: the withheld saves, or the account read again
  // only when the load held or lost a write).
  const reconciledAccess = useRef(null);
  useEffect(() => {
    if (!limitedLaunch.enabled || !loaded || offlineMode || !user?.id || profileOwner !== user.id
      || getActiveUserId() !== user.id || window.Clerk?.user?.id !== user.id
      || limitedLaunch.status !== "ready" || (!canWriteCredential && !canWritePractice)) return;
    void reconcileAccessAnswer(user.id, `${user.id}:${canWriteCredential}:${canWritePractice}`);
  }, [limitedLaunch.enabled, limitedLaunch.status, loaded, offlineMode, user?.id, profileOwner, canWriteCredential, canWritePractice]); // eslint-disable-line react-hooks/exhaustive-deps
  // End protected-access reconciliation.
  accessAuthority.registerRecords(dataOwnerRef.current, data);

  // The PA and NP rule data these records read (utils/appRules.js): until it
  // is in at launch, the screens get the loading state (loaded false, no
  // records), so a rule card never reads "not yet verified" for want of the
  // data. An MD or DO never loads it.
  //
  // Once this account has been on screen, a change that needs the data
  // (another device's profession change, a PA, RN or APRN licence added by a
  // member with no physician degree) never takes the screen back to
  // "Loading...": that unmounted every screen, and a CV scan, Vera's question
  // and what the member was typing went with it (review of e1f4b4c9). The
  // screen shows everything but what needs the data until it is in
  // (withoutAppRuleNeeds), with a line saying so (appRulesWaiting, App.jsx).
  const appRulesNeeded = needsAppRules(data);
  const appRulesOk = useAppRulesReady(appRulesNeeded);
  const appRulesFailedNow = useAppRulesFailed();
  const appRulesShownRef = useRef(null);
  const appRulesKeepScreen = !appRulesOk && loaded && !!user?.id && appRulesShownRef.current?.owner === user.id;
  if (loaded && appRulesOk && user?.id && dataOwnerRef.current === user.id) {
    const degree = data?.settings?.degreeType ?? "";
    if (appRulesShownRef.current?.owner !== user.id || appRulesShownRef.current.degree !== degree) appRulesShownRef.current = { owner: user.id, degree };
  }
  const shownLoaded = loaded && (appRulesOk || appRulesKeepScreen);
  const maskedData = useMemo(() => (appRulesKeepScreen ? withoutAppRuleNeeds(data, appRulesShownRef.current?.degree) : null), [appRulesKeepScreen, data]);
  const shownData = appRulesOk ? data : appRulesKeepScreen ? maskedData : DEFAULT_DATA;
  // A PA or NP profession reads as the one shown before while it waits
  // (withoutAppRuleNeeds), so the rules on screen are that profession's: the
  // line names both (`profession`, `shownProfession`), so they are never
  // taken for hers (review of f06d9276).
  const savedDegree = data?.settings?.degreeType ?? "";
  const shownDegree = maskedData?.settings?.degreeType ?? "";
  const appRulesWaiting = useMemo(() => (appRulesKeepScreen
    ? { failed: appRulesFailedNow, ...(savedDegree !== shownDegree ? { profession: savedDegree, shownProfession: shownDegree } : {}) }
    : null), [appRulesKeepScreen, appRulesFailedNow, savedDegree, shownDegree]);
  // At launch: the loading screen says so when the data cannot be loaded (no
  // connection), and offers to try again (App.jsx).
  const appRulesLaunchFailed = loaded && appRulesNeeded && !appRulesOk && !appRulesKeepScreen && appRulesFailedNow;
  // The next launch of this account on this device starts loading it at once;
  // once it is in, this device keeps it for the next build (public/sw.js).
  useEffect(() => {
    const ownerId = user?.id;
    if (!loaded || !ownerId || dataOwnerRef.current !== ownerId) return;
    if (appRulesNeeded) lsSet(BASE_KEYS.appRulesHint, "1", ownerId);
    else if (lsGet(BASE_KEYS.appRulesHint, ownerId) !== null) lsSet(BASE_KEYS.appRulesHint, "0", ownerId);
  }, [loaded, user?.id, appRulesNeeded]);
  useEffect(() => {
    if (loaded && appRulesNeeded && appRulesOk) rememberAppRulesOnDevice();
  }, [loaded, appRulesNeeded, appRulesOk]);
  const retryAppRules = useCallback(() => { loadAppRules().catch(() => {}); }, []);
  // The records as saved, and the states they track, once the PA and NP rule
  // data they read is in. A screen kept while it loads shows them without
  // what needs it (an earlier profession in place of a PA or NP, a PA, RN or
  // APRN licence off the screen); what acts on them reads them whole: Vera's
  // answer, an NPI import (review of f06d9276: Vera answered a PA as an MD,
  // an import added a hidden licence again, and an MD answer from the
  // registry replaced the PA it could not see). Rejects when the data cannot
  // be loaded.
  const recordsWithAppRules = useCallback(async () => {
    await loadAppRules();
    const d = dataRef.current || DEFAULT_DATA;
    const st = d.settings || {};
    return { data: d, trackedStates: trackedStates(st.primaryState, st.additionalStates, d.licenses, st.degreeType) };
  }, []);

  // Check before replacing local state, so a denied restore never overwrites saved data.
  //
  // A change the membership answer allows now is applied. One that meets an
  // answer that is only old (the app spent a few minutes in Mail or the share
  // sheet, where no check runs) or a check that failed on a bad connection,
  // inside the grace after an active answer, is applied too, and the check it
  // starts decides it (holdForAccess): its cloud write waits for that check
  // (lib/supabase.js) and goes up, or is queued "saved on this device, will
  // sync", or, when the server answers read-only, the change is taken back
  // here. So is one made before this page load's first answer (the member
  // app opens from the loaded profile before it): it waits for that answer,
  // and is kept, counted by the notice, when none comes. Only a real refusal
  // returns false. `section` names the collection
  // for the operator's report; `quiet`: nobody typed it (a "seen" stamp), so
  // taking it back is not announced. `keepOnRefusal`: the change records work
  // already done outside the app (an invoice that went out), so a refusal by
  // that check never takes it back: it stays here, its cloud write is queued
  // marked refused, and the notice says so (lib/supabase.js authorizeOwner).
  //
  // A change to Protected Identity or the Answer Bank is refused whenever no
  // store on this device would keep it (utils/storage.js
  // deviceOnlySaveBlocked): while this session's records were built without
  // the device's offline copy (offlineCopyUnread; nothing is saved over it
  // until a load has read it), and while the latest save of that copy was
  // taken by no store (full, or its storage would not open). Those sections
  // exist only in that copy, so the change would live in memory only and be
  // lost at the next launch. The refused save is made again
  // (retryOfflineSave), so a store that answers again takes the next try.
  // The caller says why (deviceOnlyBlockedMessage).
  const guardedSetData = useCallback((updater, { section = null, quiet = false, keepOnRefusal = false } = {}) => {
    if (!user?.id || dataOwnerRef.current !== user.id || getActiveUserId() !== user.id
      || (!offlineMode && window.Clerk?.user?.id !== user.id)) return false;
    if (!accessAuthority.enabled) {
      const ownerId = user.id;
      if (deviceOnlySaveBlocked(ownerId) && deviceOnlySectionsChanged(dataRef.current,
        typeof updater === "function" ? updater(structuredClone(dataRef.current)) : updater)) { void retryOfflineSave(ownerId); return false; }
      setData(before => {
        if (dataOwnerRef.current !== ownerId || getActiveUserId() !== ownerId
          || (!offlineMode && window.Clerk?.user?.id !== ownerId)) return before;
        const next = typeof updater === "function" ? updater(before) : updater;
        return deviceOnlySaveBlocked(ownerId) && deviceOnlySectionsChanged(before, next) ? before : next;
      });
      return true;
    }
    const before = dataRef.current;
    // An updater receives its own copy: in-place changes cannot alter saved data before authorization.
    const next = typeof updater === "function" ? updater(structuredClone(before)) : updater;
    if (deviceOnlySaveBlocked(user.id) && deviceOnlySectionsChanged(before, next)) { void retryOfflineSave(user.id); return false; }
    const access = dataChangeStatus(before, next);
    if (access.status === "refuse") return false;
    dataRef.current = next;
    accessAuthority.registerRecords(dataOwnerRef.current, next);
    setData(next);
    if (access.status === "verify") {
      const ownerId = user.id;
      const changes = changesBetween(before, next);
      holdForAccess({
        scopes: access.scopes, accountId: ownerId, section: section || access.section, quiet, keep: keepOnRefusal === true, awaitAnswer: access.awaitAnswer === true,
        // Taken back only in this account's records, and only where nothing
        // has changed them since.
        undo: () => {
          if (dataOwnerRef.current !== ownerId || getActiveUserId() !== ownerId) return;
          const restored = revertChanges(dataRef.current, changes);
          if (restored === dataRef.current) return;
          dataRef.current = restored;
          accessAuthority.registerRecords(ownerId, restored);
          setData(restored);
        },
      });
    }
    return true;
  }, [user?.id, offlineMode]);
  // Account deletion is an explicit data-rights operation, independent of membership.
  const beginAccountDeletion = useCallback(() => {
    const accountId = user?.id;
    const profileId = userIdRef.current;
    let generation = dataLoadGeneration.current;
    const isCurrent = () => dataOwnerRef.current === accountId && getActiveUserId() === accountId
      && userIdRef.current === profileId && dataLoadGeneration.current === generation;
    if (!accountId || !isCurrent()) throw new Error("Wait for your account to finish loading before deleting its data.");
    const onStart = () => {
      // Invalidate queued cache callbacks and earlier loads before the purge.
      // Only this already-validated deletion advances with the new generation.
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      cacheWriteGeneration.current += 1;
      generation = ++dataLoadGeneration.current;
    };
    return createDataDeletionContext(accountId, profileId, { offline: offlineMode, isCurrent, onStart });
  }, [user?.id, offlineMode]);
  const resetAfterAccountDeletion = useCallback((next, owner) => {
    if (!isCurrentDataDeletionContext(owner)) return false;
    if (dataOwnerRef.current !== owner.accountId || getActiveUserId() !== owner.accountId) return false;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    cacheWriteGeneration.current += 1;
    // The empty records replacing the old ones come after this device's
    // purge: they, and what the member adds to them, may be written to the
    // local copy again under the fence the deletion moved.
    loadedDeletionRef.current = { owner: owner.accountId, stamp: lsGet(WIPE_SEEN_KEY, owner.accountId), fence: localFence(owner.accountId) };
    adoptLocalFence(owner.accountId, loadedDeletionRef.current.fence);
    dataRef.current = next;
    setData(before => {
      if (!isCurrentDataDeletionContext(owner)) return before;
      return dataOwnerRef.current === owner.accountId && getActiveUserId() === owner.accountId ? next : before;
    });
    return true;
  }, []);
  // The server deletion leaves the account empty and closed until its owner
  // signs in again, when initialize-clerk-profile reopens it (migration
  // 20260930020000). Load it again right away, so this device goes on with
  // an open, empty account instead of one that refuses every write until the
  // next reload. deletedAt is the stamp delete-account answered with and this
  // device has already purged for (honorAccountDataDeletion); the empty
  // records in memory count as loaded after it.
  const reopenAfterAccountDeletion = useCallback((owner, deletedAt) => {
    if (offlineMode || !deletedAt || !isCurrentDataDeletionContext(owner)) return false;
    if (dataOwnerRef.current !== owner.accountId || getActiveUserId() !== owner.accountId) return false;
    loadedDeletionRef.current = { owner: owner.accountId, stamp: deletedAt, fence: localFence(owner.accountId) };
    setLoaded(false);
    void loadDataForUser(owner.accountId);
    return true;
  }, [offlineMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The server step of Delete All My Data did not confirm, and reading the
  // account back found no new deletion stamp either (or could not ask). The
  // server may still finish it: its reply can be lost on a dropped
  // connection while the function runs on. Anything the member added here
  // now would be purged as pre-deletion data by the next load that learns
  // the stamp, so nothing is added: writes stop, the records go, and the app
  // asks for a reload, which reads the account again. This tab keeps its old
  // purge fence, so nothing it still holds reaches the local copy either.
  // `message` (deletionUnconfirmedMessage) is what the stopped screen shows:
  // what may still be on the servers, what to do, and the support reference,
  // which the operator also gets here.
  const holdAfterUnconfirmedDeletion = useCallback((owner, message) => {
    if (!isCurrentDataDeletionContext(owner)) return false;
    if (dataOwnerRef.current !== owner.accountId || getActiveUserId() !== owner.accountId) return false;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    cacheWriteGeneration.current += 1;
    dataLoadGeneration.current += 1;
    accessAuthority.suspendWrites();
    dataOwnerRef.current = null;
    userIdRef.current = null;
    dataRef.current = DEFAULT_DATA;
    setProfileOwner(null);
    setProfileIssue({ accountId: owner.accountId, supportReference: DELETION_SUPPORT_REFERENCE, message });
    setData(DEFAULT_DATA);
    setLoadedFrom(null);
    reportError(`Delete All My Data held: the server step did not confirm (${DELETION_SUPPORT_REFERENCE}).`);
    return true;
  }, []);

  // Billing is a network surface: offline it fails with a clear message
  // instead of a spinner or a half-built Stripe redirect.
  const checkout = useCallback((...args) => {
    if (offlineMode) {
      window.alert("You're offline. Billing needs a connection. Try again once you're back online.");
      return Promise.resolve({ ok: false, error: "offline" });
    }
    return sbCheckout(...args);
  }, [offlineMode, sbCheckout]);
  const manage = useCallback((...args) => {
    if (offlineMode) {
      window.alert("You're offline. Billing needs a connection. Try again once you're back online.");
      return Promise.resolve({ ok: false, error: "offline" });
    }
    return sbManage(...args);
  }, [offlineMode, sbManage]);

  // Theme. An unknown stored theme (e.g. the recycled 'arctic' profile
  // default) is the app's real default, dark, everywhere: what renders, what
  // the indicators say and what the toggle flips from (themeNameOf).
  const themeName = themeNameOf(data.settings.theme);
  const isDark = themeName === "dark";
  const theme = useMemo(() => THEMES[themeName], [themeName]);

  const toggleTheme = useCallback(() => {
    const ownerId = dataOwnerRef.current, profileId = userIdRef.current;
    if (!ownerId || getActiveUserId() !== ownerId) return;
    setData(d => {
      if (getActiveUserId() !== ownerId || dataOwnerRef.current !== ownerId) return d;
      const newTheme = nextThemeName(d.settings.theme);
      sbSaveSettings(profileId, { theme: newTheme }, ownerId).catch(() => {});
      return { ...d, settings: { ...d.settings, theme: newTheme } };
    });
  }, []);

  // Convenience CRUD helpers
  // `keepOnRefusal` (addItem, editItem): see guardedSetData.
  const updateSection = useCallback((key, updater, { keepOnRefusal = false } = {}) => {
    return guardedSetData(d => ({ ...d, [key]: updater(d[key]) }), { section: key, keepOnRefusal });
  }, [guardedSetData]);

  // `automatic`: nobody did this (the Setup board's own stamps). Like a
  // "seen" timestamp, it is never said: no alert, and a refusal is not
  // reported either. A save made before the page load's first membership
  // answer is not refused: it is kept on this device and decided by that
  // answer (settingsStatus "verify"; guardedSetData, saveSettings).
  const updateSettings = useCallback((updates, { automatic = false } = {}) => {
    const quiet = automatic === true || !Object.keys(updates || {}).some(key => !key.endsWith("SeenAt"));
    if (accessAuthority.enabled && accessAuthority.settingsStatus(updates).status === "refuse") {
      if (!quiet) {
        // Refused only because membership is being re-checked: say so. A
        // read-only membership is shown on the page already; it is reported.
        if (accessVerifying(accessAuthority, "credential")) alertWriteRefused({ scope: "credential", section: "settings" });
        else reportWriteAccess("write_refused", writeRefusalReason(accessAuthority, "credential"), "settings");
      }
      return false;
    }
    const previousEmail = dataRef.current?.settings?.email ?? "";
    // What a kept Setup board save was made from (lib/supabase.js setupBase):
    // it goes up later as what it changed, not whole over a newer copy.
    const previous = updates && Object.hasOwn(updates, "setupState") ? { setupState: dataRef.current?.settings?.setupState ?? null } : null;
    if (!guardedSetData(d => ({ ...d, settings: { ...d.settings, ...updates } }), { section: "settings", quiet })) return false;
    sbSaveSettings(userIdRef.current, updates, user?.id, { automatic: automatic === true, previous }).then(result => {
      // An address another account holds is refused and everything else
      // saved (saveSettings). Put back the address the profile still holds,
      // unless something newer was typed meanwhile, and say why.
      if (result?.savedExcept !== "email" || !Object.hasOwn(updates || {}, "email")) return;
      const refused = updates.email;
      const stored = typeof result.email === "string" ? result.email : previousEmail;
      guardedSetData(d => d.settings.email === refused ? { ...d, settings: { ...d.settings, email: stored } } : d);
      setSettingsRefusal({ field: "email", address: refused, accountId: user?.id || null });
    }).catch(() => {});
    return true;
  }, [guardedSetData, user?.id]);
  const clearSettingsRefusal = useCallback(() => setSettingsRefusal(null), []);

  // A device-only section (Protected Identity) is saved to this device's
  // cache and nowhere else: none of the four helpers below calls the cloud
  // for it. src/lib/supabase.js refuses those keys too, as a second wall.
  //
  // A change to one is refused, and the member told why, while no store on
  // this device would keep it (deviceOnlySaveBlocked, see guardedSetData);
  // the refused save of the offline copy is made again meanwhile.
  // Why a change to Protected Identity or the Answer Bank would be saved
  // nowhere now (deviceOnlySaveBlocked), for a caller that changes them in
  // bulk (the JSON restore) and must say so itself; the refused save of the
  // offline copy is made again meanwhile.
  const deviceOnlyBlocked = useCallback(() => {
    const ownerId = dataOwnerRef.current;
    const blocked = ownerId ? deviceOnlySaveBlocked(ownerId) : null;
    if (blocked) void retryOfflineSave(ownerId);
    return blocked;
  }, []);
  const refuseUnsavableDeviceOnly = useCallback((key) => {
    if (!isDeviceOnlySection(key)) return false;
    const ownerId = dataOwnerRef.current;
    const blocked = deviceOnlySaveBlocked(ownerId);
    if (!blocked) return false;
    void retryOfflineSave(ownerId);
    window.alert(deviceOnlyBlockedMessage(blocked));
    return true;
  }, []);
  // Every add and edit is shaped once here (src/utils/recordWrite.js), so no
  // path in (forms, the scanner, Vera, importers) can skip a storage rule.
  // `keepOnRefusal`: the record of work already done outside the app (an
  // invoice that went out, and the entries it billed). A membership check
  // this save waits for that answers read-only no longer takes it back
  // (guardedSetData); a save refused at once still returns false.
  const addItem = useCallback((key, raw, { keepOnRefusal = false } = {}) => {
    // Saved nowhere while no store on this device would keep it (guardedSetData).
    if (refuseUnsavableDeviceOnly(key)) return false;
    const item = prepareRecord(key, raw, dataRef.current?.settings?.name);
    if (!updateSection(key, items => [...(items || []), item], { keepOnRefusal })) { alertWriteRefused({ scope: scopesForWrite(key, item), section: key }); return false; }
    if (isDeviceOnlySection(key)) return true;
    // Sync to Supabase. A document's file and row landed: record where the
    // file lives (SYNC-017, SHARE-003) through updateSection, never editItem
    // (a path is not an edit and must not stamp updatedAt), and only while the
    // same account and profile are signed in. The cached copy then drops the
    // bytes (saveData); kept, four 3 MB uploads filled localStorage and froze
    // the offline copy, and the email sheet called the file still uploading.
    const ownerId = dataOwnerRef.current;
    const profileId = userIdRef.current;
    sbInsert(profileId, key, item, ...(keepOnRefusal ? [{ keepOnRefusal: true }] : [])).then((path) => {
      if (key !== "documents" || !path || !ownerId) return;
      if (dataOwnerRef.current !== ownerId || getActiveUserId() !== ownerId || userIdRef.current !== profileId) return;
      updateSection("documents", docs => withStoragePath(docs, item.id, path));
    }).catch(() => {});
  }, [updateSection, refuseUnsavableDeviceOnly]);

  // Whether addItem would accept this record now, without adding it. For a
  // caller that must do something costly or irreversible first (the Files
  // upload reads a file before storing it, so a patient chart never reaches
  // the server) and must not do it for a save that would be refused.
  const canAddItem = useCallback((key, raw) => {
    if (!user?.id || dataOwnerRef.current !== user.id || getActiveUserId() !== user.id
      || (!offlineMode && window.Clerk?.user?.id !== user.id)) return false;
    if (isDeviceOnlySection(key) && deviceOnlySaveBlocked(user.id)) return false;
    if (!accessAuthority.enabled) return true;
    const before = dataRef.current;
    const item = prepareRecord(key, raw, before?.settings?.name);
    // An answer that is only old does not stop it: the add will be kept on
    // this device while a check decides it, as any save is (guardedSetData).
    return dataChangeStatus(before, { ...before, [key]: [...(before[key] || []), item] }).status !== "refuse";
  }, [user?.id, offlineMode]);

  // canAddItem for work outside the app that cannot be taken back (the AI
  // read of a file: the file leaves the device and the read is paid for). An
  // answer that is only old is settled first (settleWriteAccess), so the work
  // never runs for a save the check then refuses. True: allowed, or kept on
  // this device because the check could not answer. False: refused; the
  // caller says why (alertWriteRefused), as it does for canAddItem.
  const confirmCanAddItem = useCallback(async (key, raw) => {
    if (!canAddItem(key, raw)) return false;
    if (!accessAuthority.enabled) return true;
    const before = dataRef.current;
    const item = prepareRecord(key, raw, before?.settings?.name);
    const access = dataChangeStatus(before, { ...before, [key]: [...(before[key] || []), item] });
    if (access.status !== "verify") return access.status === "allow";
    return settleWriteAccess(access.scopes);
  }, [canAddItem]);

  const editItem = useCallback((key, raw, { keepOnRefusal = false } = {}) => {
    if (refuseUnsavableDeviceOnly(key)) return false;
    const previous = (dataRef.current[key] || []).find(record => record.id === raw?.id);
    const item = prepareRecord(key, raw, dataRef.current?.settings?.name, previous || null);
    // Stamp the edit time so the self-heal pass can tell a newer local edit
    // (whose cloud write may have failed) from an older cloud row.
    const stamped = { ...item, updatedAt: new Date().toISOString() };
    if (!updateSection(key, items => (items || []).map(x => x.id === stamped.id ? stamped : x), { keepOnRefusal })) { alertWriteRefused({ scope: scopesForWrite(key, stamped, previous), section: key }); return false; }
    if (isDeviceOnlySection(key)) return true;
    // Sync to Supabase
    sbUpdate(userIdRef.current, key, stamped, previous, user?.id, ...(keepOnRefusal ? [{ keepOnRefusal: true }] : [])).catch(() => {});
  }, [updateSection, user?.id, refuseUnsavableDeviceOnly]);

  // Star or unstar a record.
  //
  // updatedAt is deliberately left untouched. A star is not an edit, and
  // bumping it would let a star tapped on a stale or offline device win the
  // self-heal comparison against a real edit made elsewhere. The write is
  // column-only for the same reason, so a rejected star cannot take the
  // record's other fields down with it.
  const toggleFavorite = useCallback((key, id) => {
    if (isDeviceOnlySection(key)) return false;
    const current = (dataRef.current[key] || []).find(record => record.id === id);
    if (!current) return false;
    const favorite = !(current.favorite === true);
    const next = { ...current, favorite };
    if (!updateSection(key, items => (items || []).map(x => x.id === id ? next : x))) {
      alertWriteRefused({ scope: scopesForWrite(key, next, current), section: key }); return false;
    }
    sbSetFavorite(userIdRef.current, key, next, favorite, user?.id).catch(() => {});
    return true;
  }, [updateSection, user?.id]);

  const deleteItemFn = useCallback((key, id) => {
    if (refuseUnsavableDeviceOnly(key)) return false;
    const before = dataRef.current;
    const target = (before[key] || []).find(item => item.id === id);
    const linkedDocs = key === "documents" ? [] : (before.documents || []).filter(doc => doc.linkedTo === `${key}:${id}`);
    // The same answer as any save: refused, allowed, or kept on this device
    // while a check decides it (guardedSetData below holds it), the page
    // load's first answer included (awaitAnswer).
    const access = accessAuthority.enabled
      ? accessAuthority.statusFor([...accessAuthority.mutationScopes(key, target || { id }, target),
        ...linkedDocs.flatMap(doc => accessAuthority.mutationScopes("documents", doc, doc))], undefined, { awaitAnswer: true })
      : null;
    if (access?.status === "refuse") {
      alertWriteRefused({ scope: scopesForWrite(key, target || { id }, target), section: key }); return false;
    }
    const next = { ...before, [key]: (before[key] || []).filter(item => item.id !== id) };
    if (linkedDocs.length) next.documents = (before.documents || []).filter(doc => !linkedDocs.includes(doc));
    if (!guardedSetData(next, { section: key })) return false;
    const profileId = userIdRef.current;
    for (const doc of linkedDocs) {
      sbDelete(profileId, "documents", doc.id, doc).catch(() => {});
      recordTombstone(profileId, "documents", doc.id, doc).catch(() => {});
    }
    // Files linked to it are ordinary cloud documents and go above; the
    // record itself never had a cloud row or needs a tombstone.
    if (isDeviceOnlySection(key)) return true;
    sbDelete(profileId, key, id, target).catch(() => {});
    recordTombstone(profileId, key, id, target).catch(() => {});
    return true;
  }, [guardedSetData, refuseUnsavableDeviceOnly]);

  // Tracked states: Settings picks plus every state where the profession's
  // practice licence is held (a medical licence for MD, DO and blank; a PA,
  // APRN or RN licence for a PA or NP; src/utils/compliance.js trackedStates).
  const allTrackedStates = useMemo(
    () => trackedStates(data.settings.primaryState, data.settings.additionalStates, data.licenses, data.settings.degreeType),
    [data.settings.primaryState, data.settings.additionalStates, data.licenses, data.settings.degreeType],
  );
  // The states the screen tracks while it waits for the rule data (above).
  const maskedTrackedStates = useMemo(
    () => (maskedData ? trackedStates(maskedData.settings?.primaryState, maskedData.settings?.additionalStates, maskedData.licenses, maskedData.settings?.degreeType) : NO_STATES),
    [maskedData],
  );

  // record = { sec, id } opens that record's editor after the section renders
  const navigate = useCallback((tab, sub, record) => {
    if (onNavigate) onNavigate(tab, sub || null, record || null);
  }, [onNavigate]);

  // ─── A stored file's bytes, only while a screen shows it ───
  // The screens that show a file (Documents, a record's linked files, an
  // agreement's, a request's attachments) ask for its bytes as they open and
  // let them go as they close: the account's files are no longer all held in
  // memory (2026-10-02, the owner's iPhone). utils/documentBytes.js keeps what
  // is wanted and fetches it, for the account rather than for one load: tied
  // to the load current when the screen asked, a download that landed after
  // the membership answer's second load began was thrown away and never asked
  // for again, and every stored file read "Fetching the file from your
  // account." for good after a reload (QA lab DOCS-008/009). A file with no
  // cloud copy yet (pendingUpload, no storagePath) keeps its bytes: they are
  // the only copy.
  const offlineModeRef = useRef(offlineMode);
  offlineModeRef.current = offlineMode;
  const documentBytesRef = useRef(null);
  if (!documentBytesRef.current) {
    documentBytesRef.current = createDocumentBytes({
      documents: () => dataRef.current?.documents || [],
      // The account whose records are on screen, while it is the signed-in one.
      account: () => {
        const owner = dataOwnerRef.current;
        return owner && getActiveUserId() === owner ? owner : null;
      },
      fetch: documentDataUrl,
      // Bytes on the documents on screen: not a change to any record (no
      // cloud write), put in memory at once so a change made before the next
      // render starts from them, and only while that account's records are
      // the ones on screen.
      update: (fn, account) => {
        const mine = () => !!account && dataOwnerRef.current === account && getActiveUserId() === account;
        if (!mine()) return;
        const apply = (d) => {
          if (!Array.isArray(d?.documents)) return d;
          const documents = fn(d.documents);
          return documents === d.documents ? d : { ...d, documents };
        };
        dataRef.current = apply(dataRef.current);
        setData(d => (mine() ? apply(d) : d));
      },
      // An offline session has no cloud client to ask.
      canFetch: () => !offlineModeRef.current,
      missing: missingDocumentFiles,
    });
  }
  const documentBytes = documentBytesRef.current;
  const requestDocumentBytes = useCallback((ids) => documentBytes.want(ids), [documentBytes]);
  const releaseDocumentBytes = useCallback((ids) => documentBytes.unwant(ids), [documentBytes]);
  // Whatever replaced the documents on screen (a load, an edit, a purge):
  // what a screen wants and has no bytes is asked for again.
  useEffect(() => { documentBytes.pump(); }, [data.documents, documentBytes]);
  // Another account, or none: nothing asked for the last one lands here.
  useEffect(() => { documentBytes.reset(); }, [user?.id, documentBytes]);
  // Back online or back in front: what failed is asked for at once (and,
  // gone offline, the files waiting say so). Hidden (the owner's iPhone in
  // Mail): the bytes no screen shows are let go.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOnline = () => documentBytes.retryNow();
    const onOffline = () => documentBytes.retryNow();
    const onVisible = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") documentBytes.hidden();
      else documentBytes.visible();
    };
    const onPageHide = () => documentBytes.hidden();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener?.("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [documentBytes]);

  const value = useMemo(() => ({
    data: shownData, appRulesWaiting, appRulesLaunchFailed, retryAppRules, recordsWithAppRules, setData: guardedSetData, requestDocumentBytes, releaseDocumentBytes, documentBytes, beginAccountDeletion, resetAfterAccountDeletion, reopenAfterAccountDeletion, holdAfterUnconfirmedDeletion, loaded: shownLoaded, loadedFrom,
    recordsLoadIssue: recordsLoadIssue?.accountId === user?.id ? recordsLoadIssue : null, theme, themeName, isDark, toggleTheme, isDesktop,
    updateSection, updateSettings, addItem, canAddItem, confirmCanAddItem, editItem, deleteItem: deleteItemFn, toggleFavorite,
    settingsRefusal: settingsRefusal?.accountId === user?.id ? settingsRefusal : null, clearSettingsRefusal,
    allTrackedStates: appRulesOk ? allTrackedStates : appRulesKeepScreen ? maskedTrackedStates : NO_STATES, navigate, userIdRef, syncIssues: syncState.issues, pendingWrites: syncState.pending, awaitingAccessWrites: syncState.awaitingAccess, accessRefusedWrites: syncState.accessRefused, offlineCopyStale, deviceOnlyUnsaved, deviceOnlyBlocked, deviceCopyBehind: loadedFrom === "local" && deviceCopyBehind,
    // Auth
    user, authChecked, offlineMode,
    signOut: handleSignOut,
    // Subscription
    plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode, hasSubscription, isFreeBeta,
    isLifetime, limitedLaunch: { ...limitedLaunch, initializationError: profileIssue?.accountId === user?.id ? profileIssue.message : null, identityWaiting: identityWaiting?.accountId === user?.id, billingReturn },
    identityWaiting: identityWaiting?.accountId === user?.id ? identityWaiting : null, canWriteCredential, canWritePractice, credentialReadOnly, practiceReadOnly,
  }), [guardedSetData, requestDocumentBytes, releaseDocumentBytes, documentBytes, beginAccountDeletion, resetAfterAccountDeletion, reopenAfterAccountDeletion, holdAfterUnconfirmedDeletion, profileIssue, identityWaiting, recordsLoadIssue, settingsRefusal, clearSettingsRefusal, isLifetime, limitedLaunch, billingReturn, canWriteCredential, canWritePractice, credentialReadOnly, practiceReadOnly, shownData, shownLoaded, appRulesOk, appRulesKeepScreen, maskedTrackedStates, appRulesWaiting, appRulesLaunchFailed, retryAppRules, recordsWithAppRules, loadedFrom, deviceCopyBehind, theme, themeName, isDark, toggleTheme, isDesktop, updateSection, updateSettings, addItem, canAddItem, confirmCanAddItem, editItem, deleteItemFn, toggleFavorite, allTrackedStates, navigate, syncState, offlineCopyStale, deviceOnlyUnsaved, deviceOnlyBlocked, user, authChecked, offlineMode, handleSignOut, plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode, hasSubscription, isFreeBeta]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

// Notification hook
export function useNotifications() {
  const { data, setData, loaded } = useApp();
  const [browserPermission, setBrowserPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );
  const lastCheckRef = useRef(null);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "denied";
    try {
      const result = await Notification.requestPermission();
      setBrowserPermission(result);
      return result;
    } catch { return "denied"; }
  }, []);

  const checkAndNotify = useCallback(() => {
    if (!loaded) return;
    const s = data.settings;
    const alerts = generateAlerts(data);
    if (!alerts) return;

    const now = new Date();
    const fingerprintChanged = s.alertsFingerprint && s.alertsFingerprint !== alerts.fingerprint;

    if (fingerprintChanged) {
      setData(d => ({
        ...d,
        settings: { ...d.settings, alertsFingerprint: alerts.fingerprint, lastNotified: null, snoozedUntil: null },
      }));
    }

    if (s.snoozedUntil && new Date(s.snoozedUntil) > now && !fingerprintChanged) return;

    const freqMs = alerts.effectiveFreqDays * MS_PER_DAY;
    const lastNotified = s.lastNotified ? new Date(s.lastNotified) : null;
    const isDue = fingerprintChanged || !lastNotified || (now - lastNotified) >= freqMs;
    if (!isDue) return;

    // Avoid re-firing within 5 min in same session
    if (lastCheckRef.current && (now - lastCheckRef.current) < 300000) return;
    lastCheckRef.current = now;

    const msg = buildNotificationMessage(data, alerts);
    if (!msg) return;

    if (browserPermission === "granted" && data.settings.notifyBrowser !== false) {
      fireBrowserNotification("CredentialDOMD Alert", msg.shortText, "credentialdomd-" + now.toDateString());
    }

    return { alerts, msg, isDue: true };
  }, [data, loaded, browserPermission, setData]);

  // Check on load
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => checkAndNotify(), 2000);
    return () => clearTimeout(timer);
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check on visibility change
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") checkAndNotify();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [checkAndNotify]);

  // Periodic check every 30 min
  useEffect(() => {
    if (!loaded) return;
    const interval = setInterval(() => checkAndNotify(), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loaded, checkAndNotify]);

  // External provider health cannot be established by browser no-cors probes:
  // CSP/network rejection is not an outage, and opaque success hides HTTP errors.
  // Keep legacy settings for compatibility, but never notify from those results.

  return { browserPermission, requestPermission, checkAndNotify };
}
