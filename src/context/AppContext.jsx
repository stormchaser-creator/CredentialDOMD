import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useUser, useClerk } from "@clerk/clerk-react";
import { DEFAULT_DATA } from "../constants/defaults";
import { THEMES } from "../constants/themes";
import { useSubscription } from "../hooks/useSubscription";
import { loadData, saveData, clearLocalData } from "../utils/storage";
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

export function AppProvider({ children, onNavigate }) {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);
  const userIdRef = useRef(null);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // ─── Auth: read from Clerk ────────────────────────────────
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const { signOut: clerkSignOut } = useClerk();

  const user = useMemo(() => normalizeClerkUser(isSignedIn ? clerkUser : null), [isSignedIn, clerkUser]);
  const authChecked = clerkLoaded;

  // ─── Load data when user changes (sign in / sign out) ─────
  useEffect(() => {
    if (!authChecked) return;

    if (user) {
      loadDataForUser(user.id);
    } else {
      // Not authenticated — load from localStorage (offline / pre-signin)
      loadLocalData();
    }
  }, [user?.id, authChecked]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDataForUser(authUserId) {
    try {
      // Ensure profile exists for this auth user
      const profile = await ensureProfile(authUserId);
      if (profile) {
        const sbData = await loadFromSupabase(authUserId);
        if (sbData) {
          const profileId = sbData._userId;
          delete sbData._userId;
          userIdRef.current = profileId;

          // Merge with defaults
          const merged = {
            ...DEFAULT_DATA,
            ...sbData,
            settings: { ...DEFAULT_DATA.settings, ...(sbData.settings || {}) },
          };

          // Check if localStorage has data not yet in Supabase (first-time migration)
          const COLLECTION_KEYS = [
            "licenses", "cme", "privileges", "insurance", "healthRecords",
            "education", "caseLogs", "workHistory", "peerReferences",
            "malpracticeHistory", "documents", "shareLog", "notificationLog",
            "rotations", "deductibles", "locumContracts", "workLog", "invoices",
            "encounters", "screenings", "alertAcks", "professionalPhotos",
            "publications", "memberships", "taskNotes", "dutyDays", "travelDocs", "travelExpenses", "taxPayments",
          ];
          let local = null;
          try {
            const raw = localStorage.getItem("credentialdomd-data");
            if (raw) local = JSON.parse(raw);
          } catch { /* ignore */ }

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
              const localItems = local[key] || [];
              if (localItems.length === 0) continue;
              const cloudIds = new Set((merged[key] || []).map(x => x?.id));
              const missing = localItems.filter(x => x?.id && !cloudIds.has(x.id) && !tombstones.has(x.id));
              if (missing.length > 0) {
                merged[key] = [...(merged[key] || []), ...missing];
                bulkSync(profileId, key, missing).catch(() => {});
                pushed += missing.length;
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

          setData(merged);
          setLoaded(true);

          // Cache to localStorage
          try {
            localStorage.setItem("credentialdomd-data", JSON.stringify(merged));
          } catch { /* quota */ }

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

    // Fallback to local
    loadLocalData();
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

  async function loadLocalData() {
    const d = await loadData();
    if (d._userId) {
      userIdRef.current = d._userId;
      delete d._userId;
    }
    setData(d);
    setLoaded(true);
  }

  // ─── Auth actions (Clerk) ─────────────────────────────────
  const handleSignOut = useCallback(async () => {
    try {
      await clerkSignOut();
    } catch (err) {
      console.warn("Sign out failed:", err.message);
    }
    userIdRef.current = null;
    setData(DEFAULT_DATA);
    setLoaded(false);
    // Purge the on-device cache: it holds the whole file, patient
    // identifiers included, and the next account on this device must
    // never inherit it.
    await clearLocalData();
  }, [clerkSignOut]);

  // Persist to localStorage on change (debounced backup)
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveData(data), 300);
    return () => clearTimeout(saveTimer.current);
  }, [data, loaded]);

  // ─── Subscription ─────────────────────────────────────────
  const { plan, isPro, isPractice, loading: subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode } = useSubscription(user ?? null);

  // Theme
  const theme = useMemo(() => THEMES[data.settings.theme] || THEMES.light, [data.settings.theme]);

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
    updateSection(key, items => [...items, item]);
    // Sync to Supabase
    sbInsert(userIdRef.current, key, item).catch(() => {});
  }, [updateSection]);

  const editItem = useCallback((key, item) => {
    updateSection(key, items => items.map(x => x.id === item.id ? item : x));
    // Sync to Supabase
    sbUpdate(userIdRef.current, key, item).catch(() => {});
  }, [updateSection]);

  const deleteItemFn = useCallback((key, id) => {
    const profileId = userIdRef.current;
    // Cascade: documents attached to this item are deleted with it —
    // row, cloud file, and tombstone — so nothing orphans.
    if (key !== "documents") {
      const linkedDocs = (dataRef.current.documents || []).filter(d => d.linkedTo === `${key}:${id}`);
      for (const doc of linkedDocs) {
        updateSection("documents", items => items.filter(x => x.id !== doc.id));
        sbDelete(profileId, "documents", doc.id).catch(() => {});
        recordTombstone(profileId, "documents", doc.id).catch(() => {});
      }
    }
    updateSection(key, items => items.filter(x => x.id !== id));
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

  const navigate = useCallback((tab, sub) => {
    if (onNavigate) onNavigate(tab, sub || null);
  }, [onNavigate]);

  const value = useMemo(() => ({
    data, setData, loaded, theme, toggleTheme,
    updateSection, updateSettings, addItem, editItem, deleteItem: deleteItemFn,
    allTrackedStates, navigate, userIdRef,
    // Auth
    user, authChecked,
    signOut: handleSignOut,
    // Subscription
    plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode,
  }), [data, loaded, theme, toggleTheme, updateSection, updateSettings, addItem, editItem, deleteItemFn, allTrackedStates, navigate, user, authChecked, handleSignOut, plan, isPro, isPractice, subLoading, periodEnd, checkout, manage, setMockPlan, isDevMode]);

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
