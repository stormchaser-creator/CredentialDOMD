import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DEFAULT_DATA } from "../constants/defaults";
import { THEMES } from "../constants/themes";
import { loadData, saveData } from "../utils/storage";
import { generateAlerts, fireBrowserNotification, buildNotificationMessage } from "../utils/notifications";
import { shouldRunVerification, verifyCMEProviders, getVerificationSummary } from "../utils/cmeVerification";
import { MS_PER_DAY } from "../utils/helpers";

const AppContext = createContext(null);

export function AppProvider({ children, onNavigate }) {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);

  // Load data on mount
  useEffect(() => {
    loadData().then(d => { setData(d); setLoaded(true); });
  }, []);

  // Persist on change (debounced)
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
    setData(d => ({
      ...d,
      settings: { ...d.settings, theme: d.settings.theme === "dark" ? "light" : "dark" },
    }));
  }, []);

  // Convenience CRUD helpers
  const updateSection = useCallback((key, updater) => {
    setData(d => ({ ...d, [key]: updater(d[key]) }));
  }, []);

  const updateSettings = useCallback((updates) => {
    setData(d => ({ ...d, settings: { ...d.settings, ...updates } }));
  }, []);

  const addItem = useCallback((key, item) => {
    updateSection(key, items => [...items, item]);
  }, [updateSection]);

  const editItem = useCallback((key, item) => {
    updateSection(key, items => items.map(x => x.id === item.id ? item : x));
  }, [updateSection]);

  const deleteItem = useCallback((key, id) => {
    updateSection(key, items => items.filter(x => x.id !== id));
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
    updateSection, updateSettings, addItem, editItem, deleteItem,
    allTrackedStates, navigate,
  }), [data, loaded, theme, toggleTheme, updateSection, updateSettings, addItem, editItem, deleteItem, allTrackedStates, navigate]);

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
