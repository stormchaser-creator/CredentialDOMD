// True when the PA and NP rule data these records need is in (or they need
// none); while it is not, starts loading it, and tries again on a backoff,
// when the device comes back online, and when the app comes back to the
// front (utils/appRules.js).
import { useEffect, useSyncExternalStore } from "react";
import { appRulesFailed, appRulesReady, loadAppRules, onAppRules } from "../utils/appRules.js";

const RETRY_MS = [1000, 3000, 10000, 30000];

export function useAppRulesReady(needed) {
  const installed = useSyncExternalStore(onAppRules, appRulesReady, appRulesReady);
  const ready = !needed || installed;
  useEffect(() => {
    if (ready) return undefined;
    let stopped = false, attempt = 0, timer = null;
    const tryLoad = () => {
      clearTimeout(timer);
      loadAppRules().catch(() => {
        if (stopped) return;
        timer = setTimeout(tryLoad, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
        attempt += 1;
      });
    };
    tryLoad();
    const onWake = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") tryLoad(); };
    globalThis.window?.addEventListener?.("online", onWake);
    globalThis.document?.addEventListener?.("visibilitychange", onWake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      globalThis.window?.removeEventListener?.("online", onWake);
      globalThis.document?.removeEventListener?.("visibilitychange", onWake);
    };
  }, [ready]);
  return ready;
}

/** True while the last load of the data failed (no connection) and it is not in. */
export function useAppRulesFailed() {
  return useSyncExternalStore(onAppRules, appRulesFailed, appRulesFailed);
}
