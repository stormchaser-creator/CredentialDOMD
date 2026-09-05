import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useApp } from "../../../context/AppContext";
import {
  buildSetup, firstRenderPatch, normalizeSetupState,
  withTask, withDeclared, withSnooze, withStarted, withTier1Done, withProSnapshot,
  denominatorNarration, proSnapshot, proSnapshotMatches,
  withProgress, boardCounts,
} from "../../../utils/setupTasks";

/**
 * The one reader and the one writer for settings.setupState.
 *
 * updateSettings fires a profile upsert per call with no debounce of its
 * own, and setupState rides that path, so a capture run would be one full
 * profile write per license. Every mutation here lands in a module-level
 * queue, coalesces into a single object, and is written 1200 ms after the
 * last one, flushed on unmount and on visibilitychange.
 *
 * The queue is module-level rather than per-component on purpose: the Home
 * card and the Setup page are both mounted at times, and two independent
 * debouncers writing the same key would clobber each other.
 *
 * Because it is module-level it is also keyed to the account that filled it.
 * updateSettings resolves the profile id at call time, so a queued tap that
 * outlived a user switch would be written against whoever is signed in now.
 * The owner check drains the queue before the account changes hands.
 */

const DEBOUNCE_MS = 1200;

let pending = null;      // the setupState waiting to be written, or null
let writer = null;       // the updateSettings that will write it
let owner = null;        // the user id the pending write belongs to
let timer = null;
const listeners = new Set();
const emit = () => { for (const l of [...listeners]) l(); };

function flushSetupWrites() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending || !writer) return;
  const payload = pending;
  const write = writer;
  pending = null;
  writer = null;
  owner = null;
  write({ setupState: payload });
  emit();
}

function queueSetupWrite(next, updateSettings, userId) {
  // A queued write belongs to one account. If the account changed under it,
  // drain it first rather than folding the two together.
  if (owner && owner !== userId) flushSetupWrites();
  owner = userId || null;
  pending = next;
  writer = updateSettings;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushSetupWrites, DEBOUNCE_MS);
  emit();
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => pending;

export function useSetupState() {
  const { data, updateSettings, isPro, isFreeBeta, hasSubscription, subLoading, loaded, loadedFrom, user } = useApp();
  const userId = user?.id || null;
  // The optimistic overlay: a tap must move the board now, not in a second.
  const queued = useSyncExternalStore(subscribe, snapshot, snapshot);

  const settings = data.settings;
  const stored = settings?.setupState;
  const effective = queued || stored;

  // buildSetup walks most of the record file, so it memoizes on the same
  // narrow dependency list Home already uses for its own derived cards.
  const setup = useMemo(
    () => buildSetup(
      { ...data, settings: { ...settings, setupState: effective } },
      { isPro, isFreeBeta, hasSubscription }
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      data.licenses, data.documents, data.cme, data.education, data.workHistory,
      data.travelDocs, data.professionalPhotos, data.privileges, data.insurance,
      data.peerReferences, settings, effective, isPro, isFreeBeta, hasSubscription,
    ]
  );

  const pruneArgs = useMemo(() => ({
    knownIds: setup.tasks.map((t) => t.id),
    doneIds: setup.tasks.filter((t) => t.status === "done" || t.status === "documented").map((t) => t.id),
  }), [setup]);

  const commit = useCallback((mutate) => {
    const base = pending || normalizeSetupState(effective);
    queueSetupWrite(mutate(base), updateSettings, userId);
  }, [effective, updateSettings, userId]);

  const skip = useCallback((id) => commit((st) => withTask(st, id, "skipped", {}, pruneArgs)), [commit, pruneArgs]);
  const markNa = useCallback((id, why = "") => commit((st) => withTask(st, id, "na", { why }, pruneArgs)), [commit, pruneArgs]);
  const restore = useCallback((id) => commit((st) => withTask(st, id, null, {}, pruneArgs)), [commit, pruneArgs]);
  const declare = useCallback((key, value) => commit((st) => withDeclared(st, key, value, pruneArgs)), [commit, pruneArgs]);
  const snooze = useCallback((days) => commit((st) =>
    withSnooze(st, new Date(Date.now() + days * 86400000).toISOString(), pruneArgs)), [commit, pruneArgs]);
  const stampTier1Done = useCallback(() => commit((st) =>
    st.tier1DoneAt ? st : withTier1Done(st, new Date().toISOString(), pruneArgs)), [commit, pruneArgs]);

  // First render for an account that has never seen the board. Gated on a
  // real cloud load: `loaded` alone also goes true for the local offline
  // fallback, and a degraded file there reads as a brand-new account. Left
  // ungated, the next real load stamps tier1DoneAt and congratulates an
  // established physician for finishing a setup they never ran.
  useEffect(() => {
    if (!loaded || loadedFrom !== "cloud") return;
    const patch = firstRenderPatch(setup);
    if (!patch) return;
    commit((st) => {
      const started = withStarted(st, patch.startedAt, pruneArgs);
      return patch.tier1DoneAt ? withTier1Done(started, patch.tier1DoneAt, pruneArgs) : started;
    });
  }, [loaded, loadedFrom, setup, commit, pruneArgs]);

  // The board's own score, stamped so somebody who cannot read this
  // physician's records can still see how far they got. Written only when the
  // numbers actually move, and the same debounced queue carries it, so it
  // costs no extra round trip.
  const board = boardCounts(setup);
  const t1c = setup.counts.tier1, t2c = setup.counts.tier2;
  // Both halves, because the Setup page shows one at a time and never the sum.
  const scoreKey = `${t1c.done}/${t1c.total}:${t2c.done}/${t2c.total}`;
  const scoreRef = useRef(null);
  useEffect(() => {
    if (!loaded || loadedFrom !== "cloud") return;
    const was = normalizeSetupState(effective).progress;
    const same = was && was.t1 && was.t2
      && was.t1.done === t1c.done && was.t1.total === t1c.total
      && was.t2.done === t2c.done && was.t2.total === t2c.total;
    if (same || scoreRef.current === scoreKey) return;
    scoreRef.current = scoreKey;
    commit((st) => withProgress(st, {
      done: board.done, total: board.total,
      t1: { done: t1c.done, total: t1c.total },
      t2: { done: t2c.done, total: t2c.total },
    }, new Date().toISOString(), pruneArgs));
  }, [loaded, loadedFrom, scoreKey, board.done, board.total, t1c.done, t1c.total, t2c.done, t2c.total, effective, commit, pruneArgs]);

  // lastTouched: the last time any task actually closed. The card's copy
  // reads it ("You added 4 licenses on Monday"), so it must not move when
  // the page is merely opened.
  const doneKeyRef = useRef(null);
  const doneKey = pruneArgs.doneIds.join(",");
  useEffect(() => {
    if (!loaded) return;
    const prev = doneKeyRef.current;
    doneKeyRef.current = doneKey;
    // Only a task that newly closed counts. A task that un-completes (a
    // record deleted) must not stamp progress.
    if (prev === null) return;
    const had = new Set(prev ? prev.split(",") : []);
    const closed = doneKey.split(",").filter((id) => id && !had.has(id));
    if (!closed.length) return;
    // Which one closed is stored too: the ladder's continuity line names it
    // back to the physician a few days later.
    commit((st) => ({ ...st, lastTouched: new Date().toISOString(), lastDone: closed[0] }));
  }, [loaded, doneKey, commit]);

  /* ─── The Pro denominator ─────────────────────────────────────────
   * The total is the one number on the board a physician is asked to trust,
   * so it never moves silently. When it has not moved, the current shape is
   * recorded quietly; when it has, the sentence is handed to the page and
   * only recorded once the physician has seen it.
   */
  // useSubscription starts every cold load at the free tier and resolves the
  // real one over the network, so a paying account reads proLive === 0 on the
  // first paint. Narrating that would tell a subscriber they lost items they
  // still have, and snapshotting it would record a total they never saw.
  // Nothing here is produced from a tier that has not resolved.
  const narration = useMemo(
    () => (subLoading ? null : denominatorNarration(setup, { isFreeBeta })),
    [setup, isFreeBeta, subLoading]
  );
  const matches = proSnapshotMatches(setup, { isFreeBeta });
  const ackNarration = useCallback(
    () => commit((st) => withProSnapshot(st, proSnapshot(setup, { isFreeBeta }), pruneArgs)),
    [commit, setup, isFreeBeta, pruneArgs]
  );
  useEffect(() => {
    if (!loaded || subLoading || narration || matches) return;
    ackNarration();
  }, [loaded, subLoading, narration, matches, ackNarration]);

  // Flush on unmount and whenever the app is backgrounded: a skip tapped on
  // the way out of the app must still be a skip when it comes back.
  // A user switch that does not unmount this hook still has to end the old
  // account's queue before anything new lands in it. Only a CHANGE counts:
  // flushing on mount would cancel a debounce the other consumer started.
  const userIdRef = useRef(userId);
  useEffect(() => {
    if (userIdRef.current === userId) return;
    userIdRef.current = userId;
    flushSetupWrites();
  }, [userId]);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushSetupWrites(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushSetupWrites);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushSetupWrites);
      flushSetupWrites();
    };
  }, []);

  return {
    setup, skip, markNa, restore, declare, snooze, stampTier1Done,
    narration, ackNarration, flush: flushSetupWrites,
  };
}
