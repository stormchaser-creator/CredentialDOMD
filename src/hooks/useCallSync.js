/**
 * CallSync sync, wired to the app: fetch the feed through the callsync-feed
 * edge function (the feed has no CORS headers), plan with utils/callsync.js,
 * apply through the normal addItem / editItem / deleteItem paths so every
 * change syncs to the cloud and queues offline like any other edit.
 *
 * Bookkeeping (last attempt, last good sync, last result) lives in the
 * per-user credentialdomd-callsync slot, purged on sign-out. The feed link
 * and the agreement it lands on are device-local settings
 * (settings.callsyncFeedUrl / callsyncContractId, see DEVICE_KEY_FIELDS).
 *
 * One module-level store so the Sched. panel and the once-a-day runner in
 * App.jsx see the same status, and a run in flight is never doubled.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useApp } from "../context/AppContext";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "../utils/storageScope";
import { generateId } from "../utils/helpers";
import {
  parseFeedUrl, shiftsFromICS, planSync, detectContract, expectedForShift,
  syncWindow, isDueForAutoSync, iso,
} from "../utils/callsync";

const ENV = import.meta.env || {};
const SUPABASE_URL = ENV.VITE_SUPABASE_URL || "";
const FEED_FN = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/callsync-feed` : null;

// ─── Store ────────────────────────────────────────────────────
// record: { lastAttemptAt, lastOkAt, ok, added, updated, removed, total, error, message, trigger }
let state = { running: false, record: null, owner: null };
const listeners = new Set();
const emit = () => { for (const l of listeners) l(); };
const setState = (patch) => { state = { ...state, ...patch }; emit(); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getSnapshot = () => state;

function readRecord() { return lsGetJSON(BASE_KEYS.callsync) || null; }
function writeRecord(rec) { lsSetJSON(BASE_KEYS.callsync, rec); setState({ record: rec }); }

// The slot is per user: re-read it whenever a different account is active.
function ensureOwner(userId) {
  if (state.owner === (userId || null)) return;
  setState({ owner: userId || null, record: userId ? readRecord() : null });
}

// ─── Feed fetch ───────────────────────────────────────────────
class CallSyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function getClerkToken() {
  if (typeof window === "undefined") return null;
  const session = window.Clerk?.session;
  if (!session) return null;
  try { return await session.getToken({ template: "supabase" }); } catch { return null; }
}

const MESSAGES = {
  no_link: "Paste your CallSync calendar link first.",
  bad_url: "That is not a CallSync calendar link. In CallSync, open Dashboard, then Calendar Subscription, and tap Copy URL.",
  no_contract: "Add your ANMG agreement on the Contracts tab first, then sync.",
  signed_out: "Sign in again to sync CallSync.",
  not_configured: "CallSync sync is not switched on for this build.",
  not_deployed: "CallSync sync is not switched on yet on the server.",
  invalid_token: "CallSync did not accept this link. In CallSync, open Dashboard, then Calendar Subscription, and copy the URL again.",
  upstream: "CallSync did not answer. Try again in a few minutes.",
  offline: "You're offline. CallSync will be checked when you reconnect.",
};

async function fetchFeed(url) {
  if (!FEED_FN) throw new CallSyncError("not_configured", MESSAGES.not_configured);
  const token = await getClerkToken();
  if (!token) throw new CallSyncError("signed_out", MESSAGES.signed_out);
  let res;
  try {
    res = await fetch(FEED_FN, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new CallSyncError("offline", MESSAGES.offline);
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok && typeof body?.ics === "string") return body.ics;
  if (res.status === 401) throw new CallSyncError("signed_out", MESSAGES.signed_out);
  if (res.status === 403) throw new CallSyncError("invalid_token", MESSAGES.invalid_token);
  if (res.status === 400) throw new CallSyncError("bad_url", MESSAGES.bad_url);
  if (res.status === 404) throw new CallSyncError("not_deployed", MESSAGES.not_deployed);
  throw new CallSyncError("upstream", MESSAGES.upstream);
}

// ─── The run ──────────────────────────────────────────────────
async function runSync({ data, addItem, editItem, deleteItem, trigger }) {
  if (state.running) return state.record;
  const s = data?.settings || {};
  const url = parseFeedUrl(s.callsyncFeedUrl);
  const contracts = data?.locumContracts || [];
  const contract = contracts.find(c => c.id === s.callsyncContractId) || detectContract(contracts);
  const prev = state.record || {};
  const startedAt = new Date().toISOString();

  const fail = (code, message) => {
    const rec = { ...prev, lastAttemptAt: startedAt, ok: false, error: code, message, trigger };
    writeRecord(rec);
    setState({ running: false });
    return rec;
  };

  if (!url) return fail(s.callsyncFeedUrl ? "bad_url" : "no_link", s.callsyncFeedUrl ? MESSAGES.bad_url : MESSAGES.no_link);
  if (!contract) return fail("no_contract", MESSAGES.no_contract);

  setState({ running: true });
  try {
    const ics = await fetchFeed(url);
    const shifts = shiftsFromICS(ics);
    const now = new Date();
    const plan = planSync({
      shifts,
      scheduleDays: data.scheduleDays || [],
      contractId: contract.id,
      expectedFor: (shift) => expectedForShift(contract, shift),
      dayRate: Number(contract.dayRate) || 0,
      today: iso(now),
      window: syncWindow(now),
      makeId: generateId,
    });
    for (const e of plan.adds) addItem("scheduleDays", e);
    for (const e of plan.updates) editItem("scheduleDays", e);
    for (const e of plan.removals) deleteItem("scheduleDays", e.id);
    const rec = {
      lastAttemptAt: startedAt, lastOkAt: startedAt, ok: true, trigger,
      total: shifts.length, added: plan.adds.length, updated: plan.updates.length, removed: plan.removals.length,
      error: null, message: null,
    };
    writeRecord(rec);
    setState({ running: false });
    return rec;
  } catch (err) {
    return fail(err?.code || "error", err?.message || MESSAGES.upstream);
  }
}

// ─── Hooks ────────────────────────────────────────────────────

/** Status + a manual trigger for the Sched. panel. */
export function useCallSync() {
  const { data, addItem, editItem, deleteItem, user } = useApp();
  useEffect(() => { ensureOwner(user?.id); }, [user?.id]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const syncNow = useCallback(
    () => runSync({ data: dataRef.current, addItem, editItem, deleteItem, trigger: "manual" }),
    [addItem, editItem, deleteItem]
  );
  return { running: snap.running, record: snap.record, syncNow };
}

/**
 * The once-a-day check: after the data loads (and again when the app comes
 * back to the foreground), if a link is saved and the last good sync is a
 * day old, sync. A failed attempt waits fifteen minutes before retrying.
 */
export function useCallSyncAutoRun() {
  const { data, loaded, offlineMode, user, addItem, editItem, deleteItem } = useApp();
  useEffect(() => { ensureOwner(user?.id); }, [user?.id]);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const feedUrl = data.settings?.callsyncFeedUrl || "";

  useEffect(() => {
    if (!loaded || offlineMode || !user?.id || !parseFeedUrl(feedUrl)) return;
    ensureOwner(user.id);
    const check = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (!isDueForAutoSync(state.record)) return;
      runSync({ data: dataRef.current, addItem, editItem, deleteItem, trigger: "auto" }).catch(() => {});
    };
    // Let the first render settle before the calendar starts changing.
    const timer = setTimeout(check, 3000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [loaded, offlineMode, user?.id, feedUrl]); // eslint-disable-line react-hooks/exhaustive-deps
}
