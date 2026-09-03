import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useApp } from "../../../context/AppContext";
import {
  buildSetup, firstRenderPatch, normalizeSetupState,
  withTask, withDeclared, withSnooze, withStarted, withTier1Done,
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
  const { data, updateSettings, isPro, loaded, user } = useApp();
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
      { isPro }
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.licenses, data.documents, settings, effective, isPro]
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

  // First render for an account that has never seen the board. Gated on
  // `loaded` so an account that IS already set up is stamped complete rather
  // than being told to start setting up during the empty first paint.
  useEffect(() => {
    if (!loaded) return;
    const patch = firstRenderPatch(setup);
    if (!patch) return;
    commit((st) => {
      const started = withStarted(st, patch.startedAt, pruneArgs);
      return patch.tier1DoneAt ? withTier1Done(started, patch.tier1DoneAt, pruneArgs) : started;
    });
  }, [loaded, setup, commit, pruneArgs]);

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
    if (!doneKey.split(",").some((id) => id && !had.has(id))) return;
    commit((st) => ({ ...st, lastTouched: new Date().toISOString() }));
  }, [loaded, doneKey, commit]);

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

  return { setup, skip, markNa, restore, declare, snooze, stampTier1Done, flush: flushSetupWrites };
}
