/**
 * One door for every Gemini call the app makes.
 *
 * Two routes, chosen per call:
 *  1. The user's OWN key (settings.apiKey, device-local): straight to
 *     generativelanguage.googleapis.com exactly as before. Their key, their
 *     bill, no shared quota.
 *  2. No own key: the ai-proxy edge function. The shared Gemini key never
 *     leaves the server; the proxy checks the Clerk JWT, the beta gate and a
 *     per-user daily cap, then forwards the same JSON body and returns
 *     Gemini's status + JSON verbatim. From the user's side AI is simply on.
 *
 * geminiCall() returns a Response-like { ok, status, json() } so the call
 * sites keep their existing parsing. Proxy-side refusals (quota, key not
 * configured, beta gate, signed out) additionally carry `proxyError` and a
 * ready user-facing `message`, so a util can surface the real reason instead
 * of a generic "error 429".
 *
 * Shared-AI status (is the shared key on? how many calls used today?) is
 * fetched once per page load after sign-in and cached in module state plus
 * localStorage, so `aiAvailable(settings)` is synchronous for gating.
 *
 * Kept free of app-context/JSX imports: cmeImport.js pulls this in and is
 * unit-tested under plain node.
 */

import { useSyncExternalStore } from "react";

const ENV = import.meta.env || {};
const SUPABASE_URL = ENV.VITE_SUPABASE_URL || "";
const PROXY_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/ai-proxy` : null;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";

export const SHARED_AI_STORAGE_KEY = "credentialdomd-ai-shared";
export const SHARED_AI_EVENT = "ai-shared-status";
export const SHARED_DAILY_LIMIT = 200;

// User-facing text for the proxy's own refusals. Physicians read these;
// keep them plain and tell them the one thing that fixes it.
export const AI_MESSAGES = {
  quota: `Shared AI quota reached for today (${SHARED_DAILY_LIMIT} calls). Add your own Gemini key in Settings to keep going.`,
  shared_key_not_configured: "AI is not switched on yet: the shared key is not configured.",
  forbidden: "AI is available once your beta access is active.",
  unauthorized: "Sign in to use AI features.",
  offline: "AI is not reachable right now. Check your connection and try again.",
};

// ─── Clerk token ────────────────────────────────────────────
// Same "supabase" JWT template the data layer uses (src/lib/supabase.js keeps
// its helper private, so this mirrors it). The proxy verifies the signature
// against Clerk's JWKS and resolves the user from the `sub` claim.
async function getClerkToken() {
  if (typeof window === "undefined") return null;
  const session = window.Clerk?.session;
  if (!session) return null;
  try {
    return await session.getToken({ template: "supabase" });
  } catch {
    return null;
  }
}

// ─── Shared-AI status (module cache + localStorage) ─────────
function readCachedStatus() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SHARED_AI_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      shared: !!parsed.shared,
      used: Number(parsed.used) || 0,
      limit: Number(parsed.limit) || SHARED_DAILY_LIMIT,
      reason: parsed.reason || null,
      checkedAt: Number(parsed.checkedAt) || 0,
    };
  } catch {
    return null;
  }
}

// { shared, used, limit, reason, checkedAt }
//   shared   — the shared key is configured AND this user may use it
//   reason   — why not, when shared is false: "pending" (beta gate),
//              "not_configured", "signed_out", "offline", or null
export let sharedAiStatus = readCachedStatus() || {
  shared: false, used: 0, limit: SHARED_DAILY_LIMIT, reason: null, checkedAt: 0,
};

function setSharedAiStatus(next) {
  const merged = { ...sharedAiStatus, ...next };
  const changed = ["shared", "used", "limit", "reason"].some(k => merged[k] !== sharedAiStatus[k]);
  if (!changed) { sharedAiStatus.checkedAt = merged.checkedAt; return; } // same snapshot reference for React
  sharedAiStatus = merged;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SHARED_AI_STORAGE_KEY, JSON.stringify(merged));
  } catch { /* storage full or blocked: memory copy still works */ }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try { window.dispatchEvent(new CustomEvent(SHARED_AI_EVENT, { detail: merged })); } catch { /* ignore */ }
  }
}

let statusFetchedThisLoad = false;
let statusInflight = null;
let statusRetryTimer = null;
let statusRetries = 0;

/**
 * GET ai-proxy → { shared, used_today, limit }. Runs once per page load (the
 * first caller after sign-in wins; later callers get the cache) unless
 * `force` is set. Safe to call from anywhere; never throws.
 */
export async function fetchSharedAiStatus({ force = false } = {}) {
  if (statusInflight) return statusInflight;
  if (statusFetchedThisLoad && !force) return sharedAiStatus;
  statusInflight = (async () => {
    if (!PROXY_URL) {
      setSharedAiStatus({ shared: false, reason: "not_configured", checkedAt: Date.now() });
      statusFetchedThisLoad = true;
      return sharedAiStatus;
    }
    const token = await getClerkToken();
    if (!token) {
      // Not signed in yet (Clerk still booting, or the sign-in page). Leave
      // the cache alone and try again shortly; the sign-in race is the
      // common case on a cold load.
      scheduleStatusRetry();
      return sharedAiStatus;
    }
    let res;
    try {
      res = await fetch(PROXY_URL, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      setSharedAiStatus({ reason: sharedAiStatus.shared ? sharedAiStatus.reason : "offline", checkedAt: Date.now() });
      scheduleStatusRetry(15000);
      return sharedAiStatus;
    }
    statusFetchedThisLoad = true;
    statusRetries = 0;
    if (res.ok) {
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      setSharedAiStatus({
        shared: !!body?.shared,
        used: Number(body?.used_today ?? body?.used) || 0,
        limit: Number(body?.limit) || SHARED_DAILY_LIMIT,
        reason: body?.shared ? null : "not_configured",
        checkedAt: Date.now(),
      });
    } else if (res.status === 403) {
      setSharedAiStatus({ shared: false, reason: "pending", checkedAt: Date.now() });
    } else if (res.status === 401) {
      setSharedAiStatus({ shared: false, reason: "signed_out", checkedAt: Date.now() });
    } else if (res.status === 503) {
      setSharedAiStatus({ shared: false, reason: "not_configured", checkedAt: Date.now() });
    } else {
      // Unknown server trouble (404 = function not deployed yet): keep whatever
      // we last knew rather than flipping features off on a hiccup.
      setSharedAiStatus({ checkedAt: Date.now() });
    }
    return sharedAiStatus;
  })().finally(() => { statusInflight = null; });
  return statusInflight;
}

// Waiting for Clerk to produce a session is a no-network check, so polling
// is cheap; still back off so a signed-out tab is not busy for nothing.
function scheduleStatusRetry(delay = 2500) {
  if (statusRetryTimer || typeof window === "undefined") return;
  const wait = Math.min(delay * Math.max(1, statusRetries), 15000);
  statusRetries += 1;
  statusRetryTimer = setTimeout(() => {
    statusRetryTimer = null;
    if (!statusFetchedThisLoad) fetchSharedAiStatus();
  }, wait);
}

/** Forget the fetched status (call on sign-out so the next user re-checks). */
export function resetSharedAiStatus() {
  statusFetchedThisLoad = false;
  statusRetries = 0;
  setSharedAiStatus({ shared: false, used: 0, reason: null, checkedAt: 0 });
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(SHARED_AI_STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Is AI on for this user right now? True with an own key (device-local
 * settings.apiKey) or when the shared key is on for their account.
 * Synchronous on purpose so render-time gates stay simple; kicks off the
 * status fetch as a side effect if it has not run yet this load.
 */
export function aiAvailable(settings) {
  if (settings?.apiKey) return true;
  if (!statusFetchedThisLoad && !statusInflight) fetchSharedAiStatus();
  return !!sharedAiStatus.shared;
}

/** True when the call will ride the shared key (no own key). */
export function usesSharedAi(settings) {
  return !settings?.apiKey && !!sharedAiStatus.shared;
}

/**
 * Plain-language one-liner for the AI status area in Settings and gates.
 * "Shared AI: on, 12 of 200 calls used today" and friends.
 */
export function describeAiStatus(settings) {
  if (settings?.apiKey) return "Your own Gemini key is in use on this device. The shared daily limit does not apply.";
  const s = sharedAiStatus;
  if (s.shared) return `Shared AI: on, ${s.used} of ${s.limit} calls used today`;
  if (s.reason === "pending") return "Shared AI: available once your beta access is active.";
  if (s.reason === "not_configured") return "Shared AI: not switched on yet (the shared key is not configured).";
  if (s.reason === "signed_out") return "Shared AI: sign in to use it.";
  if (s.reason === "offline") return "Shared AI: could not be reached. Check your connection.";
  return "Shared AI: checking...";
}

// ─── React hooks ────────────────────────────────────────────
// The module cache is the external store; setSharedAiStatus swaps in a new
// object only when something changed, so the snapshot reference is stable.
function subscribeSharedAi(onChange) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SHARED_AI_EVENT, onChange);
  fetchSharedAiStatus();
  return () => window.removeEventListener(SHARED_AI_EVENT, onChange);
}
const getSharedAiSnapshot = () => sharedAiStatus;

/** Live shared-AI status; re-renders when the cached status changes. */
export function useSharedAiStatus() {
  return useSyncExternalStore(subscribeSharedAi, getSharedAiSnapshot, getSharedAiSnapshot);
}

/** Live boolean: AI is on for this user (own key or shared key). */
export function useAiAvailable(settings) {
  const status = useSharedAiStatus();
  return !!settings?.apiKey || !!status.shared;
}

// ─── The call ───────────────────────────────────────────────
function wrapResponse(res, { proxyError = null, message = null, parsed } = {}) {
  let cached = parsed !== undefined ? Promise.resolve(parsed) : null;
  return {
    ok: res.ok,
    status: res.status,
    json: () => (cached ??= res.json()),
    proxyError,
    message,
  };
}

function syntheticResponse(status, proxyError) {
  return {
    ok: false,
    status,
    json: async () => ({ error: proxyError }),
    proxyError,
    message: AI_MESSAGES[proxyError] || AI_MESSAGES.offline,
  };
}

/**
 * POST a Gemini request.
 *   path   — "models/gemini-2.5-flash:generateContent" (no leading slash)
 *   body   — the Gemini request JSON (object; stringified here)
 *   apiKey — the user's own key, or falsy to use the shared key via the proxy
 *   opts   — { signal } for AbortController
 * Resolves to { ok, status, json(), proxyError, message }. Network failures
 * reject exactly like fetch() so existing retry loops keep working.
 */
export async function geminiCall(path, body, apiKey, { signal } = {}) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  if (apiKey) {
    const res = await fetch(`${GEMINI_BASE}${cleanPath}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal,
    });
    return wrapResponse(res);
  }

  if (!PROXY_URL) return syntheticResponse(503, "shared_key_not_configured");
  const token = await getClerkToken();
  if (!token) return syntheticResponse(401, "unauthorized");

  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: cleanPath, body: typeof body === "string" ? JSON.parse(body) : body }),
    signal,
  });

  if (res.ok) {
    // Keep the local counter honest between status refreshes.
    if (sharedAiStatus.shared) setSharedAiStatus({ used: sharedAiStatus.used + 1 });
    return wrapResponse(res);
  }

  // Sort the proxy's own refusals from Gemini errors forwarded verbatim.
  // The proxy answers { error: "<string>" }; Gemini answers { error: {…} }.
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  const code = typeof parsed?.error === "string" ? parsed.error : null;
  const fromGemini = !!(parsed && parsed.error && typeof parsed.error === "object");

  if (res.status === 429 && code === "quota") {
    setSharedAiStatus({
      used: Number(parsed.used) || sharedAiStatus.limit,
      limit: Number(parsed.limit) || sharedAiStatus.limit,
    });
    return wrapResponse(res, { proxyError: "quota", message: AI_MESSAGES.quota, parsed });
  }
  if (res.status === 503 && !fromGemini) {
    setSharedAiStatus({ shared: false, reason: "not_configured" });
    return wrapResponse(res, { proxyError: "shared_key_not_configured", message: AI_MESSAGES.shared_key_not_configured, parsed });
  }
  if (res.status === 403 && !fromGemini) {
    setSharedAiStatus({ shared: false, reason: "pending" });
    return wrapResponse(res, { proxyError: "forbidden", message: AI_MESSAGES.forbidden, parsed });
  }
  if (res.status === 401 && !fromGemini) {
    return wrapResponse(res, { proxyError: "unauthorized", message: AI_MESSAGES.unauthorized, parsed });
  }
  // Gemini's own error, forwarded: let the caller's status handling run.
  return wrapResponse(res, { parsed });
}

/**
 * The message to show for a failed geminiCall() when the proxy (not Gemini)
 * refused it; null otherwise so the caller's own status mapping applies.
 */
export function proxyErrorMessage(res) {
  return res?.proxyError ? (res.message || AI_MESSAGES[res.proxyError] || null) : null;
}
