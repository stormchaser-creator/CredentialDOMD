import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accessAuthority, ACCESS_REFRESH_MS, LIMITED_LAUNCH_ACCESS_ENABLED, PUBLIC_SELF_SERVICE_SIGNUP_ENABLED } from "../utils/limitedLaunchAccess.js";
import { clearLaunchInvitation } from "../utils/launchInvitation.js";
import { createLimitedLaunchClient } from "../utils/limitedLaunchClient.js";
import { createAccessRefreshReporter, describeAccessRefreshFailure } from "../utils/accessRefreshFailure.js";
import { reportUnlessLeaving } from "../lib/errorReport.js";

// A phone resumed from the background often fails its first check (Clerk's
// token and the network are still waking up), so a failed check is tried again
// soon, then less often, until one succeeds (ticket fe321c16).
export const ACCESS_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000, 20000, 60000]);
// The reconnecting notice waits for this many failures over at least this long.
export const RECONNECT_NOTICE_FAILURES = 3;
export const RECONNECT_NOTICE_MS = 30000;
// A visible session asks again this long before its answer would go stale,
// so a save is never refused for a round trip every five minutes.
export const ACCESS_REFRESH_LEAD_MS = 60000;
// Failures no retry can fix: this build cannot read the server's answer
// ("invalid") or was built without the service settings ("config").
const PERMANENT_PHASES = new Set(["invalid", "config"]);

// A check the page aborts as it is being left (a reload) is not a failure and
// is not reported (OPS-008); reportUnlessLeaving drops it, and the reporter
// then forgets the code, so the next real failure with it is still reported.
const reportRefreshFailure = createAccessRefreshReporter(reportUnlessLeaving);
// An enrollment failure used to vanish into enrollmentError; it is reported
// once per session per code, under its own name.
const reportEnrollmentFailure = createAccessRefreshReporter(reportUnlessLeaving, { label: "Membership enrollment failed", event: "access_enrollment_failed" });
// An answer that arrives while Clerk reports another account, or none, is not
// taken. That is a failed check like any other: retried on the schedule and
// reported, never a silent return that leaves the first answer missing.
const notAccepted = () => Object.assign(new Error("Membership information could not load. Your saved records have not changed."),
  { code: "access_answer_not_accepted", phase: "session", httpStatus: null });
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
    // Sign out resets the authority to nobody before it purges the device, so
    // a check still in flight then is dropped: no write-back, no failure.
    const current = () => generation.current === turn && owner.current === accountId && accessAuthority.serves?.(accountId) !== false;
    if (!current()) return;
    try {
      let enrollmentError = null;
      if (PUBLIC_SELF_SERVICE_SIGNUP_ENABLED && enrolled.current !== accountId) {
        try {
          await client.bootstrap();
          if (!current()) return;
          enrolled.current = accountId;
        } catch (error) {
          if (!current()) return;
          enrollmentError = error.code;
          reportEnrollmentFailure(error);
        }
      }
      if (!current()) return;
      const value = await client.entitlements();
      if (!current()) return;
      if (!accessAuthority.accept(accountId, value)) throw notAccepted();
      backoff.current = 0;
      failures.current = freshFailures();
      setResult({ accountId, status: "ready", error: null, enrollmentError, reconnecting: false, answered: true });
    } catch (error) {
      if (!current()) return;
      // Retrying cannot fix a build that cannot read the answer: no backoff,
      // and the page asks for a reload instead of saying it is reconnecting.
      const outdated = PERMANENT_PHASES.has(describeAccessRefreshFailure(error).phase);
      // Only a failed check: a save inside the grace is kept on the device.
      accessAuthority.suspendWrites({ outdated, checkFailed: true });
      const run = failures.current, now = clock();
      if (run.count === 0) run.since = now;
      run.count += 1;
      run.shown = run.shown || (run.count >= RECONNECT_NOTICE_FAILURES && now - run.since >= RECONNECT_NOTICE_MS);
      reportRefreshFailure(error);
      // A failure after an answer this session does not undo that answer.
      setResult(previous => ({ accountId, status: "error", error: error.message, reconnecting: run.shown && !outdated, outdated,
        answered: previous.accountId === accountId && previous.answered === true }));
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
    // The five-minute tick is a backstop for the timer below; it does not ask
    // again while the current answer has more than the lead time left.
    const tick = () => {
      if (hidden()) return;
      const answer = accessAuthority.state(accountId);
      if (answer && !answer.needsRefresh && answer.freshForMs > ACCESS_REFRESH_LEAD_MS) return;
      void check();
    };
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
  }, [active, accountId, check]);
  // A refused save asks for an answer now (alertWriteRefused), whatever the
  // retry schedule had reached, so "try again in a moment" holds. A save kept
  // on the device while the answer is old waits on this same check
  // (accessAuthority.verify), so it gets the check's promise.
  useEffect(() => {
    if (!active) return;
    return accessAuthority.setRecheck(() => { backoff.current = 0; return check(); });
  }, [active, check]);
  // A failed check is retried with backoff until one succeeds. Each failure
  // sets a new result, which schedules the next try; success, an account
  // change or unmount clears it. A hidden page waits for its resume instead.
  // An out-of-date build is not retried on a schedule.
  useEffect(() => {
    if (!active || result.accountId !== accountId || result.status !== "error" || result.outdated) return;
    const delay = ACCESS_RETRY_DELAYS_MS[Math.min(backoff.current, ACCESS_RETRY_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      if (hidden()) return;
      backoff.current += 1;
      void check();
    }, delay);
    return () => clearTimeout(timer);
  }, [active, accountId, result, check]);
  // Refresh the view at the end of a trial, and ask again a minute before the
  // answer would go stale, so a fresh one replaces it first.
  useEffect(() => {
    if (!active) return;
    const access = accessAuthority.state(accountId);
    if (!access || access.needsRefresh) return;
    const early = Math.max(1, (access.freshForMs ?? access.nextCheckInMs) - ACCESS_REFRESH_LEAD_MS);
    const timer = setTimeout(() => { redraw(n => n + 1); void check(); }, Math.min(access.nextCheckInMs, early));
    return () => clearTimeout(timer);
  }, [active, accountId, result, check]);
  const access = LIMITED_LAUNCH_ACCESS_ENABLED ? accessAuthority.state(accountId) : null;
  const remembered = LIMITED_LAUNCH_ACCESS_ENABLED && accountId ? accessAuthority.remembered(accountId) : null;
  // With no ready profile (an offline session, or an account load that fell
  // back to this device's copy) no check runs, so no write can be authorized
  // this session. The remembered answer may then keep a scope read-only, but
  // never opens its editing screens: the archive shows, as before any answer.
  const shown = remembered && !profileReady
    ? Object.fromEntries(Object.entries(remembered).map(([scope, value]) => [scope, value === false ? false : null]))
    : remembered;
  const mine = result.accountId === accountId;
  const outdated = mine && result.status === "error" && result.outdated === true;
  // Signed in, but no check can run and no fresh answer is left: the profile
  // is not ready (an offline session, or an account load that fell back to
  // this device's copy). Nothing will answer until it is, so this is never
  // "Checking membership".
  const unreachable = LIMITED_LAUNCH_ACCESS_ENABLED && !!accountId && !profileReady && (!access || access.needsRefresh === true);
  // Otherwise only sustained failure makes the page say it is reconnecting.
  const reconnecting = unreachable || (mine && result.status === "error" && result.reconnecting === true);
  return {
    enabled: LIMITED_LAUNCH_ACCESS_ENABLED,
    access,
    status: mine ? result.status : "loading",
    error: mine ? result.error : null,
    // Membership is being checked again: no answer yet, an old one, or a
    // failed check. The normal screens stay; writes wait for a fresh answer.
    verifying: LIMITED_LAUNCH_ACCESS_ENABLED && !!accountId && (!access || access.needsRefresh === true),
    // The last answer this device remembered for the account, which decides
    // the archives until this session's first answer arrives. Without a ready
    // profile only its denials count (see `shown`).
    remembered: shown,
    // No answer at all yet, this session or remembered, while a check can
    // run: the archives show with a neutral "Checking membership" line until
    // the first answer arrives. Sustained failure turns it into the
    // reconnecting note instead; it never stays for good.
    checking: LIMITED_LAUNCH_ACCESS_ENABLED && !!accountId && profileReady && !access && !remembered
      && !(mine && result.answered === true) && !outdated && !reconnecting,
    reconnecting,
    // This build cannot read the answer; only a reload helps.
    outdated,
    profileReady,
    publicSignupEnabled: PUBLIC_SELF_SERVICE_SIGNUP_ENABLED,
    enrollmentError: mine ? result.enrollmentError : null,
    refresh,
  };
}
