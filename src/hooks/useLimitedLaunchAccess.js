import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accessAuthority, ACCESS_REFRESH_MS, LIMITED_LAUNCH_ACCESS_ENABLED, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED } from "../utils/limitedLaunchAccess.js";
import { clearLaunchInvitation } from "../utils/launchInvitation.js";
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";
import { createAccessRefreshReporter } from "../utils/accessRefreshFailure.js";
import { reportError } from "../lib/errorReport.js";

// A phone resumed from the background often fails its first check (Clerk's
// token and the network are still waking up), so a failed check is tried again
// soon, then less often, until one succeeds (ticket fe321c16).
export const ACCESS_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000, 20000, 60000]);
// The reconnecting notice waits for this many failures over at least this long.
export const RECONNECT_NOTICE_FAILURES = 3;
export const RECONNECT_NOTICE_MS = 30000;

const reportRefreshFailure = createAccessRefreshReporter(reportError);
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const hidden = () => globalThis.document?.visibilityState === "hidden";
const freshFailures = () => ({ count: 0, since: 0, shown: false });

export function useLimitedLaunchAccess(accountId, { profileReady = false } = {}) {
  const owner = useRef(null), generation = useRef(0), enrolled = useRef(null);
  // One check in flight per account, where the retry schedule stands, and the
  // run of failures the reconnecting notice waits on.
  const flight = useRef(null), backoff = useRef(0), failures = useRef(freshFailures());
  const [result, setResult] = useState({ accountId: null, status: "loading", error: null });
  const [, redraw] = useState(0);
  useEffect(() => {
    if (owner.current && owner.current !== accountId) clearLaunchInvitation();
    owner.current = accountId;
    generation.current++;
    enrolled.current = null;
    flight.current = null;
    backoff.current = 0;
    failures.current = freshFailures();
    accessAuthority.reset(accountId || null);
  }, [accountId]);
  const client = useMemo(() => createLimitedLaunchClient({ accountId }), [accountId]);
  const active = LIMITED_LAUNCH_ACCESS_ENABLED && !!accountId && profileReady;
  const attempt = useCallback(async turn => {
    const current = () => generation.current === turn && owner.current === accountId;
    if (!current()) return;
    try {
      let enrollmentError = null;
      if (PUBLIC_SELF_SERVICE_SIGNUP_ENABLED && enrolled.current !== accountId) {
        try {
          await client.bootstrap();
          if (!current()) return;
          enrolled.current = accountId;
        } catch (error) { enrollmentError = error.code; }
      }
      if (!current()) return;
      const value = await client.entitlements();
      if (!current()) return;
      if (!accessAuthority.accept(accountId, value)) return;
      backoff.current = 0;
      failures.current = freshFailures();
      setResult({ accountId, status: "ready", error: null, enrollmentError, reconnecting: false });
    } catch (error) {
      if (!current()) return;
      accessAuthority.suspendWrites();
      const run = failures.current, now = clock();
      if (run.count === 0) run.since = now;
      run.count += 1;
      run.shown = run.shown || (run.count >= RECONNECT_NOTICE_FAILURES && now - run.since >= RECONNECT_NOTICE_MS);
      reportRefreshFailure(error);
      setResult({ accountId, status: "error", error: error.message, reconnecting: run.shown });
    }
  }, [accountId, client]);
  // Automatic checks (mount, resume, the timer, a retry) share the one in flight.
  const check = useCallback(() => {
    if (!active) return Promise.resolve();
    const turn = generation.current;
    if (flight.current?.turn === turn) return flight.current.promise;
    const entry = { turn, promise: null, again: null };
    entry.promise = attempt(turn).finally(() => { if (flight.current === entry) flight.current = null; });
    flight.current = entry;
    return entry.promise;
  }, [active, attempt]);
  // A tap or a finished activation asks for an answer given after it, so one
  // arriving during a check waits for that check, then starts one more.
  const refresh = useCallback(() => {
    if (!active) return Promise.resolve();
    const entry = flight.current;
    if (!entry || entry.turn !== generation.current) return check();
    entry.again ??= entry.promise.then(() => (generation.current === entry.turn ? check() : undefined));
    return entry.again;
  }, [active, check]);
  useEffect(() => {
    if (!active) return;
    // Start the asynchronous fetch after mount; cleanup cancels an unstarted request.
    const initial = setTimeout(() => { void check(); }, 0);
    // Coming back to the app checks at once and restarts the retry schedule.
    // A real resume also restarts the count the notice waits on, unless the
    // notice is already showing.
    const resume = event => {
      if (hidden()) return;
      backoff.current = 0;
      if ((event?.type === "visibilitychange" || event?.type === "pageshow") && !failures.current.shown) failures.current = freshFailures();
      void check();
    };
    const tick = () => { if (!hidden()) void check(); };
    const invalidatePending = () => { generation.current++; flight.current = null; };
    const timer = setInterval(tick, ACCESS_REFRESH_MS);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      // Reject pending results after account changes, lost profile readiness, or unmount.
      invalidatePending();
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, check]);
  // A failed check is retried with backoff until one succeeds. Each failure
  // sets a new result, which schedules the next try; success, an account
  // change or unmount clears it. A hidden page waits for its resume instead.
  useEffect(() => {
    if (!active || result.accountId !== accountId || result.status !== "error") return;
    const delay = ACCESS_RETRY_DELAYS_MS[Math.min(backoff.current, ACCESS_RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      if (hidden()) return;
      backoff.current += 1;
      void check();
    }, delay);
    return () => clearTimeout(timer);
  }, [active, accountId, result, check]);
  // Refresh the view at the end of a trial and when a cached write decision expires.
  useEffect(() => {
    if (!active) return;
    const access = accessAuthority.state(accountId);
    if (!access || access.needsRefresh) return;
    const timer = setTimeout(() => { redraw(n => n + 1); void check(); }, access.nextCheckInMs);
    return () => clearTimeout(timer);
  }, [active, accountId, result, check]);
  const access = LIMITED_LAUNCH_ACCESS_ENABLED ? accessAuthority.state(accountId) : null;
  const mine = result.accountId === accountId;
  return {
    enabled: LIMITED_LAUNCH_ACCESS_ENABLED,
    access,
    status: mine ? result.status : "loading",
    error: mine ? result.error : null,
    // Membership is being checked again: no answer yet, an old one, or a
    // failed check. The normal screens stay; writes wait for a fresh answer.
    verifying: LIMITED_LAUNCH_ACCESS_ENABLED && !!accountId && (!access || access.needsRefresh === true),
    // Only after sustained failure does the page say it is reconnecting.
    reconnecting: mine && result.status === "error" && result.reconnecting === true,
    profileReady,
    publicSignupEnabled: PUBLIC_SELF_SERVICE_SIGNUP_ENABLED,
    enrollmentError: mine ? result.enrollmentError : null,
    refresh,
  };
}
