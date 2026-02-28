import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DEFAULT_DATA } from "../constants/defaults";
import { THEMES } from "../constants/themes";
import { loadData, saveData } from "../utils/storage";
import { generateAlerts, fireBrowserNotification, buildNotificationMessage } from "../utils/notifications";
import { shouldRunVerification, verifyCMEProviders, getVerificationSummary } from "../utils/cmeVerification";
import { MS_PER_DAY } from "../utils/helpers";
import {
  supabase,
  signIn as sbSignIn,
  signUp as sbSignUp,
  signOut as sbSignOut,
  resetPassword as sbResetPassword,
  ensureProfile,
  loadFromSupabase,
  insertItem as sbInsert,
  updateItem as sbUpdate,
  deleteItem as sbDelete,
  saveSettings as sbSaveSettings,
  bulkSync,
} from "../lib/supabase";

const AppContext = createContext(null);

export function AppProvider({ children, onNavigate }) {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);
  const [user, setUser] = useState(undefined); // undefined = checking, null = not logged in, object = logged in
  const [authChecked, setAuthChecked] = useState(false);
  const userIdRef = useRef(null);

  // ─── Auth: check session on mount + subscribe to changes ───
  useEffect(() => {
    if (!supabase) {
      // No Supabase configured — skip auth, run in local-only mode
      setUser(null);
      setAuthChecked(true);
      return;
    }

    // Check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthChecked(true);
    });

    // Listen for auth changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // ─── Load data when user changes (sign in / sign out) ─────
  useEffect(() => {
    // Still checking auth — wait
    if (!authChecked) return;

    if (user) {
      // Authenticated — load from Supabase using auth user id
      loadDataForUser(user.id);
    } else if (user === null) {
      // Not authenticated (or no Supabase) — load from localStorage
      loadLocalData();
    }
  }, [user, authChecked]); // eslint-disable-line react-hooks/exhaustive-deps

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
          ];
          let local = null;
          try {
            const raw = localStorage.getItem("credentialdomd-data");
            if (raw) local = JSON.parse(raw);
          } catch { /* ignore */ }

          if (local) {
            let migrated = false;
            for (const key of COLLECTION_KEYS) {
              if (local[key]?.length > 0 && (!merged[key] || merged[key].length === 0)) {
                merged[key] = local[key];
                bulkSync(profileId, key, local[key]).catch(() => {});
                migrated = true;
              }
            }
            if (!merged.settings.name && local.settings?.name) {
              merged.settings = { ...merged.settings, ...local.settings };
              sbSaveSettings(profileId, merged.settings).catch(() => {});
              migrated = true;
            }
            if (migrated) {
              console.log("CredentialDOMD: Migrated localStorage data to Supabase");
            }
          }

          setData(merged);
          setLoaded(true);

          // Cache to localStorage
          try {
            localStorage.setItem("credentialdomd-data", JSON.stringify(merged));
          } catch { /* quota */ }
          return;
        }
      }
    } catch (err) {
      console.warn("CredentialDOMD: Supabase load failed:", err.message);
    }

    // Fallback to local
    loadLocalData();
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

  // ─── Auth actions ─────────────────────────────────────────
  const handleSignIn = useCallback(async (email, password) => {
    return sbSignIn(email, password);
  }, []);

  const handleSignUp = useCallback(async (email, password) => {
    return sbSignUp(email, password);
  }, []);

  const handleSignOut = useCallback(async () => {
    await sbSignOut();
    // Reset state
    userIdRef.current = null;
    setData(DEFAULT_DATA);
    setLoaded(false);
    setUser(null);
  }, []);

  const handleResetPassword = useCallback(async (email) => {
    return sbResetPassword(email);
  }, []);

  // Persist to localStorage on change (debounced backup)
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveData(data), 300);
    return () => clearTimeout(saveTimer.current);
  }, [data, loaded]);

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
    updateSection(key, items => items.filter(x => x.id !== id));
    // Sync to Supabase
    sbDelete(userIdRef.current, key, id).catch(() => {});
  }, [updateSection]);

  // Tracked states (memoized)
  const allTrackedStates = useMemo(
    () => [data.settings.primaryState, ...(data.settings.additionalStates || [])].filter(Boolean),
    [data.settings.primaryState, data.settings.additionalStates]
  );

  const navigate = useCallback((tab, sub) => {
    if (onNavigate) onNavigate(tab, sub || null);
  }, [onNavigate]);

  const value = useMemo(() => ({
    data, setData, loaded, theme, toggleTheme,
    updateSection, updateSettings, addItem, editItem, deleteItem: deleteItemFn,
    allTrackedStates, navigate, userIdRef,
    // Auth
    user, authChecked,
    signIn: handleSignIn, signUp: handleSignUp, signOut: handleSignOut, resetPassword: handleResetPassword,
  }), [data, loaded, theme, toggleTheme, updateSection, updateSettings, addItem, editItem, deleteItemFn, allTrackedStates, navigate, user, authChecked, handleSignIn, handleSignUp, handleSignOut, handleResetPassword]);

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

    if (browserPermission === "granted") {
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
        if (summary.failing > 0 && browserPermission === "granted") {
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
