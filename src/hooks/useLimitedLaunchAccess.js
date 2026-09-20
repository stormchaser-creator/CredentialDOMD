import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accessAuthority, ACCESS_REFRESH_MS, LIMITED_LAUNCH_ACCESS_ENABLED, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED } from "../utils/limitedLaunchAccess.js";
import { clearLaunchInvitation } from "../utils/launchInvitation.js";
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";

export function useLimitedLaunchAccess(accountId, { profileReady = false } = {}) {
  const owner = useRef(null), generation = useRef(0), enrolled = useRef(null);
  const [result, setResult] = useState({ accountId: null, status: "loading", error: null });
  const [, redraw] = useState(0);
  useEffect(() => {
    if (owner.current && owner.current !== accountId) clearLaunchInvitation();
    owner.current = accountId;
    generation.current++;
    enrolled.current = null;
    accessAuthority.reset(accountId || null);
  }, [accountId]);
  const client = useMemo(() => createLimitedLaunchClient({ accountId }), [accountId]);
  const refresh = useCallback(async () => {
    if (!LIMITED_LAUNCH_ACCESS_ENABLED || !accountId || !profileReady) return;
    const turn = ++generation.current;
    try {
      let enrollmentError = null;
      if (PUBLIC_SELF_SERVICE_SIGNUP_ENABLED && enrolled.current !== accountId) {
        try {
          await client.bootstrap();
          if (generation.current !== turn || owner.current !== accountId) return;
          enrolled.current = accountId;
        } catch (error) { enrollmentError = error.code; }
      }
      if (generation.current !== turn || owner.current !== accountId) return;
      const value = await client.entitlements();
      if (generation.current !== turn || owner.current !== accountId) return;
      if (!accessAuthority.accept(accountId, value)) return;
      setResult({ accountId, status: "ready", error: null, enrollmentError });
    } catch (error) {
      if (generation.current !== turn || owner.current !== accountId) return;
      accessAuthority.suspendWrites();
      setResult({ accountId, status: "error", error: error.message });
    }
  }, [accountId, client, profileReady]);
  useEffect(() => {
    if (!LIMITED_LAUNCH_ACCESS_ENABLED || !accountId || !profileReady) return;
    // Start the asynchronous fetch after mount; cleanup cancels an unstarted request.
    const initial = setTimeout(() => { void refresh(); }, 0);
    const resume = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = setInterval(resume, ACCESS_REFRESH_MS);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    const invalidatePending = () => { generation.current++; };
    return () => {
      // Reject pending results after account changes, lost profile readiness, or unmount.
      invalidatePending();
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [accountId, refresh, profileReady]);
  // Refresh the view at the end of a trial and when a cached write decision expires.
  useEffect(() => {
    if (!LIMITED_LAUNCH_ACCESS_ENABLED || !accountId || !profileReady) return;
    const access = accessAuthority.state(accountId);
    if (!access || access.needsRefresh) return;
    const timer = setTimeout(() => { redraw(n => n + 1); void refresh(); }, access.nextCheckInMs);
    return () => clearTimeout(timer);
  }, [accountId, result, refresh, profileReady]);
  return {
    enabled: LIMITED_LAUNCH_ACCESS_ENABLED,
    access: LIMITED_LAUNCH_ACCESS_ENABLED ? accessAuthority.state(accountId) : null,
    status: result.accountId === accountId ? result.status : "loading",
    error: result.accountId === accountId ? result.error : null,
    profileReady,
    publicSignupEnabled: PUBLIC_SELF_SERVICE_SIGNUP_ENABLED,
    enrollmentError: result.accountId === accountId ? result.enrollmentError : null,
    refresh,
  };
}
