import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useUser, useClerk } from "@clerk/clerk-react";
import { DEFAULT_DATA } from "../constants/defaults";
import { THEMES } from "../constants/themes";
import { useSubscription } from "../hooks/useSubscription";
import { loadData, saveData, readCachedData, clearLocalData } from "../utils/storage";
import { setActiveUserId, getActiveUserId, purgeUserStorage, adoptLegacyStorage, hasLegacyStorage, lsGet, lsSet, WIPE_SEEN_KEY, pendingOpCount } from "../utils/storageScope";
import { recordLastIdentity } from "../utils/offlineSession";
import { resetSharedAiStatus } from "../utils/aiClient";
import { vaultCount } from "../utils/privateVault";
import { generateAlerts, fireBrowserNotification, buildNotificationMessage } from "../utils/notifications";
import { shouldRunVerification, verifyCMEProviders, getVerificationSummary } from "../utils/cmeVerification";
import { MS_PER_DAY } from "../utils/helpers";
import {
  supabase,
  ensureProfile,
  loadFromSupabase,
  insertItem as sbInsert,
  updateItem as sbUpdate,
  deleteItem as sbDelete,
  saveSettings as sbSaveSettings,
  bulkSync,
  uploadDocumentFile,
  downloadDocumentFile,
  recordTombstone,
  listTombstones,
  replayPendingOps,
  COLLECTION_KEYS,
} from "../lib/supabase";

const AppContext = createContext(null);

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
    // Every address on the account — the admin gate matches any of them,
    // so which one happens to be "primary" in Clerk doesn't matter.
    emails: (clerkUser.emailAddresses || [])
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
  const [loadedFrom, setLoadedFrom] = useState(null); // "cloud" | "local"
  const userIdRef = useRef(null);
  // Clerk id the in-memory `data` was loaded for. The on-device cache is
  // written under this id only, so a stale timer can never file one
  // account's data under another's key.
  const dataOwnerRef = useRef(null);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // ─── Desktop breakpoint (>=1024px) ────────────────────────
  // One flag for the whole app: components branch on layout here instead of
  // each keeping its own resize listener. Below 1024 nothing branches and
  // the phone renders exactly as before. SSR-safe: no window means phone.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1024
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
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
  useEffect(() => {
    if (offlineMode || !user?.id) return;
    try { recordLastIdentity(user); } catch { /* storage unavailable */ }
  }, [offlineMode, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every on-device key (file, vault, chat, timers) is namespaced by the
  // Clerk user id. Set synchronously during render so children mounting in
  // this same pass (their useState initializers read storage) see the
  // right namespace. Idempotent, so StrictMode double-render is harmless.
  if (getActiveUserId() !== (user?.id || null)) setActiveUserId(user?.id || null);

  // ─── Load data when user changes (sign in / sign out) ─────
  useEffect(() => {
    if (!authChecked) return;

    // A different account (or none): drop what is in memory before loading
    // so nothing of the previous account renders or gets cached under the
    // new key. Also cancels the debounced cache write via its effect cleanup.
    if (dataOwnerRef.current !== (user?.id || null)) {
      dataOwnerRef.current = null;
      userIdRef.current = null;
      setLoaded(false);
      setData(DEFAULT_DATA);
    }

    if (user) {
      loadDataForUser(user.id);
    } else {
      // Not authenticated: nothing to load. There is no namespace without a
      // user, so the local cache is not read (or written) at all.
      setData(DEFAULT_DATA);
      setLoaded(true);
    }
  }, [user?.id, authChecked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Involuntary sign-out (session expiry, revocation from the Clerk
  // dashboard, "sign out of all devices"): the provider unmounts, but the
  // Clerk listener fires first, so purge this account's on-device keys
  // right there. The vault is kept: those patient notes exist nowhere else
  // and a token timing out must not destroy them; the namespaced key is
  // unreadable to any other account. The Sign out button purges it too.
  useEffect(() => {
    if (offlineMode || !clerkLoaded || !user?.id || typeof clerk?.addListener !== "function") return;
    const ownerId = user.id;
    const unsub = clerk.addListener((e) => {
      if ((e?.user?.id || null) !== ownerId) {
        purgeUserStorage(ownerId, { keepVault: true }).catch(() => {});
      }
    });
    return () => { try { unsub?.(); } catch { /* already gone */ } };
  }, [clerkLoaded, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDataForUser(authUserId) {
    // Offline session: straight to this identity's own local cache — the
    // same read path the normal load falls back to when the cloud is
    // unreachable. No profile fetch, no Clerk token, no cloud reads.
    if (offlineMode) return loadLocalData(authUserId);
    try {
      // Ensure profile exists for this auth user
      const profile = await ensureProfile(authUserId);
      if (profile) {
        // The server wiped this account (Delete All My Data on another
        // device, or the deletion 7 days after a cancellation) and took the
        // tombstone ledger with it. A device that has not yet purged for THIS
        // wipe still holds a copy that predates it: drop it BEFORE the
        // pending-op replay and the self-heal push below can send it back up.
        // The stamp is per device, so a second device with a stale cache
        // purges too, however many sign-ins the first one has done since.
        // The private vault stays; it exists nowhere else and never touched
        // the server.
        if (profile.deleted_at && lsGet(WIPE_SEEN_KEY, authUserId) !== profile.deleted_at) {
          try { await purgeUserStorage(authUserId, { keepVault: true }); } catch { /* best effort */ }
          lsSet(WIPE_SEEN_KEY, profile.deleted_at, authUserId);
        }
        // Replay any writes that never reached the cloud (offline edits and
        // deletes, transient failures) BEFORE reading back, so the snapshot we
        // merge already reflects them.
        try { await replayPendingOps(profile.id, authUserId); } catch { /* offline */ }
        const sbData = await loadFromSupabase(authUserId);
        if (sbData) {
          const profileId = sbData._userId;
          delete sbData._userId;
          // Collections whose read FAILED (not empty) — never overwrite their
          // last-known-good with an empty set, and never push stale local rows
          // over cloud data we couldn't see.
          const erroredKeys = sbData._errored || new Set();
          delete sbData._errored;
          userIdRef.current = profileId;

          // Merge with defaults
          const merged = {
            ...DEFAULT_DATA,
            ...sbData,
            settings: { ...DEFAULT_DATA.settings, ...(sbData.settings || {}) },
          };

          // This account's own on-device copy. First load after the
          // namespacing change: decide what happens to the pre-namespace
          // keys (adopted only when this cloud profile already holds data
          // that overlaps the local file; see adoptLegacyStorage). A new
          // account therefore never pushes someone else's cache up.
          let local = readCachedData(authUserId);
          // Run adoption whenever legacy keys still exist, not only when the
          // namespaced slot is empty: an offline first load may have written
          // empty defaults under the new key, and the legacy vault must not
          // become unreachable because of that.
          if (!local || hasLegacyStorage()) {
            const cloudIds = new Set();
            for (const key of COLLECTION_KEYS) for (const x of merged[key] || []) if (x?.id) cloudIds.add(x.id);
            const cloudHasData = cloudIds.size > 0 || !!merged.settings?.name;
            try {
              const adopted = adoptLegacyStorage(authUserId, { cloudIds, cloudHasData });
              local = adopted || local;
            } catch { /* keep local */ }
          }

          // A collection we failed to READ keeps this device's last-known-good
          // copy rather than the empty set the merge would otherwise show — and
          // is excluded from the self-heal push below.
          if (erroredKeys.size && local) {
            for (const key of erroredKeys) {
              if (local[key]) merged[key] = local[key];
            }
          }

          // Deletion ledger: anything deleted anywhere stays deleted.
          let tombstones = new Set();
          try { tombstones = await listTombstones(profileId); } catch { /* offline */ }
          if (tombstones.size > 0) {
            for (const key of COLLECTION_KEYS) {
              if (merged[key]?.length) merged[key] = merged[key].filter(x => !tombstones.has(x?.id));
            }
          }

          if (local) {
            // Self-healing sync: any item that exists on this device but not
            // in the cloud gets pushed up on every load — a save whose cloud
            // write failed (offline, stale schema cache, old app version) is
            // retried automatically instead of being stranded on-device.
            // Trade-off: an item deleted in the cloud can be resurrected by a
            // device holding a stale copy; acceptable while data loss is the
            // greater risk.
            let pushed = 0;
            for (const key of COLLECTION_KEYS) {
              // A collection whose read failed has an unknown cloud state —
              // pushing local rows could clobber newer cloud data. Skip it.
              if (erroredKeys.has(key)) continue;
              const localItems = local[key] || [];
              if (localItems.length === 0) continue;
              const cloudById = new Map((merged[key] || []).map(x => [x?.id, x]));
              const toPush = [];
              for (const x of localItems) {
                if (!x?.id || tombstones.has(x.id)) continue;
                const cloud = cloudById.get(x.id);
                if (!cloud) { toPush.push(x); continue; } // never reached the cloud
                // A local edit whose cloud write failed is newer than the cloud
                // row; push it so the edit isn't silently reverted on next load.
                const localT = x.updatedAt ? Date.parse(x.updatedAt) : 0;
                const cloudT = cloud.updatedAt ? Date.parse(cloud.updatedAt) : 0;
                if (localT && localT > cloudT) toPush.push(x);
              }
              if (toPush.length > 0) {
                // Replace-in-place for rows already present, append the missing.
                const byId = new Map();
                for (const x of (merged[key] || [])) byId.set(x?.id, x);
                for (const x of toPush) byId.set(x.id, x);
                merged[key] = [...byId.values()];
                bulkSync(profileId, key, toPush).catch(() => {});
                pushed += toPush.length;
              }
            }
            if (!merged.settings.name && local.settings?.name) {
              merged.settings = { ...merged.settings, ...local.settings };
              sbSaveSettings(profileId, merged.settings).catch(() => {});
            }
            if (pushed > 0) {
              console.log(`CredentialDOMD: pushed ${pushed} local item(s) to cloud`);
            }
          }

          // Link sweep: a document pointing at an item that no longer exists
          // becomes unlinked (visible in Files) instead of phantom-linked.
          const liveIds = new Set();
          for (const key of COLLECTION_KEYS) {
            if (key === "documents") continue;
            for (const x of merged[key] || []) if (x?.id) liveIds.add(`${key}:${x.id}`);
          }
          merged.documents = (merged.documents || []).map(d => {
            if (d.linkedTo && !liveIds.has(d.linkedTo)) {
              sbUpdate(profileId, "documents", { id: d.id, linkedTo: "" }).catch(() => {});
              return { ...d, linkedTo: "" };
            }
            return d;
          });

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

          dataOwnerRef.current = authUserId;
          setData(merged);
          setLoadedFrom("cloud");
          setLoaded(true);

          // Cache on-device under this account's key
          saveData(merged, authUserId).catch(() => {});

          // Background: reconcile document FILES with cloud storage.
          //  - file on this device but not in the cloud → upload it
          //  - metadata synced from another device without bytes → download
          reconcileDocumentFiles(profileId, merged.documents || []);
          return;
        }
      }
    } catch (err) {
      console.warn("CredentialDOMD: Supabase load failed:", err.message);
    }

    // Fallback to this account's own local copy (offline)
    loadLocalData(authUserId);
  }

  async function reconcileDocumentFiles(profileId, docs) {
    for (const doc of docs) {
      try {
        if (doc.data && !doc.storagePath) {
          const path = await uploadDocumentFile(doc);
          if (path) {
            const updated = { ...doc, storagePath: path };
            setData(d => ({ ...d, documents: d.documents.map(x => x.id === doc.id ? updated : x) }));
            sbUpdate(profileId, "documents", { id: doc.id, storagePath: path }).catch(() => {});
          }
        } else if (!doc.data && doc.storagePath) {
          const dataUrl = await downloadDocumentFile(doc.storagePath);
          if (dataUrl) {
            setData(d => ({ ...d, documents: d.documents.map(x => x.id === doc.id ? { ...x, data: dataUrl } : x) }));
          }
        }
      } catch { /* per-file best effort — retried on next load */ }
    }
  }

  async function loadLocalData(authUserId) {
    const d = await loadData(authUserId);
    if (d._userId) {
      userIdRef.current = d._userId;
      delete d._userId;
    }
    dataOwnerRef.current = authUserId || null;
    setData(d);
    setLoadedFrom("local");
    setLoaded(true);
  }

  // ─── Auth actions (Clerk) ─────────────────────────────────
  const handleSignOut = useCallback(async () => {
    // Shared-AI status is per account; the next user must re-check.
    try { resetSharedAiStatus(); } catch { /* ignore */ }
    const ownerId = user?.id || getActiveUserId();
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
    const pending = pendingOpCount(ownerId);
    if (pending > 0 && typeof window !== "undefined" && !window.confirm(
      offlineMode
        ? `You have ${pending} change${pending === 1 ? "" : "s"} made offline that have not synced yet. Signing out now discards them permanently. Reconnect first to keep them. Sign out anyway?`
        : `You have ${pending} change${pending === 1 ? "" : "s"} that have not reached the cloud yet. Signing out now discards them permanently. Reload the app first to retry them. Sign out anyway?`
    )) return;
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

  // Persist to localStorage on change (debounced backup), under the key of
  // the account the data was loaded for.
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const owner = dataOwnerRef.current;
      if (owner) saveData(data, owner);
    }, 300);
    return () => clearTimeout(saveTimer.current);
  }, [data, loaded]);

  // ─── Subscription ─────────────────────────────────────────
  const { plan, isPro, isPractice, loading: subLoading, periodEnd, checkout: sbCheckout, manage: sbManage, setMockPlan, isDevMode, hasSubscription, isFreeBeta } = useSubscription(user ?? null);

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
  // default) falls back to the app's real default, dark — not light.
  const theme = useMemo(() => THEMES[data.settings.theme] || THEMES.dark || THEMES.light, [data.settings.theme]);

  const toggleTheme = useCallback(() => {
    setData(d => {
      const newTheme = d.settings.theme === "dark" ? "light" : "dark";
      sbSaveSettings(userIdRef.current, { theme: newTheme }).catch(() => {});
      return { ...d, settings: { ...d.settings, theme: newTheme } };
    });
  }, []);

  // Convenience CRUD helpers
  const updateSection = useCallback((key, updater) => {
    setData(d => ({ ...d, [key]: updater(d[key]) }));
  }, []);

  const updateSettings = useCallback((updates) => {
    setData(d => {
      const newSettings = { ...d.settings, ...updates };
      // Sync to Supabase in background
      sbSaveSettings(userIdRef.current, updates).catch(() => {});
      return { ...d, settings: newSettings };
    });
  }, []);

  const addItem = useCallback((key, item) => {
    updateSection(key, items => [...(items || []), item]);
    // Sync to Supabase
    sbInsert(userIdRef.current, key, item).catch(() => {});
  }, [updateSection]);

  const editItem = useCallback((key, item) => {
    // Stamp the edit time so the self-heal pass can tell a newer local edit
    // (whose cloud write may have failed) from an older cloud row.
    const stamped = { ...item, updatedAt: new Date().toISOString() };
    updateSection(key, items => (items || []).map(x => x.id === stamped.id ? stamped : x));
    // Sync to Supabase
    sbUpdate(userIdRef.current, key, stamped).catch(() => {});
  }, [updateSection]);

  const deleteItemFn = useCallback((key, id) => {
    const profileId = userIdRef.current;
    // Cascade: documents attached to this item are deleted with it —
    // row, cloud file, and tombstone — so nothing orphans.
    if (key !== "documents") {
      const linkedDocs = (dataRef.current.documents || []).filter(d => d.linkedTo === `${key}:${id}`);
      for (const doc of linkedDocs) {
        updateSection("documents", items => (items || []).filter(x => x.id !== doc.id));
        sbDelete(profileId, "documents", doc.id).catch(() => {});
        recordTombstone(profileId, "documents", doc.id).catch(() => {});
      }
    }
    updateSection(key, items => (items || []).filter(x => x.id !== id));
    sbDelete(profileId, key, id).catch(() => {});
    // The tombstone makes this delete final across every device.
    recordTombstone(profileId, key, id).catch(() => {});
  }, [updateSection]);

  // Tracked states: Settings picks plus every state where a medical license
  // actually exists — adding a license auto-tracks its state's CME.
  const allTrackedStates = useMemo(() => {
    const states = new Set(
      [data.settings.primaryState, ...(data.settings.additionalStates || [])].filter(Boolean)
    );
    for (const l of data.licenses || []) {
      if (l.state && /medical license/i.test(l.type || "")) states.add(l.state);
    }
    return [...states];
  }, [data.settings.primaryState, data.settings.additionalStates, data.licenses]);

  // record = { sec, id } opens that record's editor after the section renders
  const navigate = useCallback((tab, sub, record) => {
    if (onNavigate) onNavigate(tab, sub || null, record || null);
  }, [onNavigate]);

  const value = useMemo(() => ({
    data, setData, loaded, loadedFrom, theme, toggleTheme, isDesktop,
    updateSection, updateSettings, addItem, editItem, deleteItem: deleteItemFn,
    allTrackedStates, navigate, userIdRef,
    // Auth
    user, authChecked, offlineMode,
    signOut: handleSignOut,
    // Subscription
    plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode, hasSubscription, isFreeBeta,
  }), [data, loaded, loadedFrom, theme, toggleTheme, isDesktop, updateSection, updateSettings, addItem, editItem, deleteItemFn, allTrackedStates, navigate, user, authChecked, offlineMode, handleSignOut, plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode, hasSubscription, isFreeBeta]);

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

  // Monthly CME provider link verification
  const verifyRef = useRef(false);
  useEffect(() => {
    if (!loaded || verifyRef.current) return;
    if (!shouldRunVerification(data.settings)) return;
    verifyRef.current = true;
    (async () => {
      try {
        const newResults = await verifyCMEProviders(data.settings.cmeVerificationResults || {});
        const summary = getVerificationSummary(newResults);
        setData(d => ({
          ...d,
          settings: {
            ...d.settings,
            lastCmeVerification: new Date().toISOString(),
            cmeVerificationResults: newResults,
            cmeVerificationAlerted: summary.failing > 0,
          },
        }));
        if (summary.failing > 0 && browserPermission === "granted" && data.settings.notifyBrowser !== false) {
          fireBrowserNotification(
            "CredentialDOMD: CME Link Check",
            `${summary.failing} CME provider link(s) may be down. Open Find CME to review.`,
            "cme-verify-" + new Date().toDateString()
          );
        }
      } catch { /* verification is best-effort */ }
    })();
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  return { browserPermission, requestPermission, checkAndNotify };
}
