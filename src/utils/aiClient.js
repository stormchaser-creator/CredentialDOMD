/**
 * One door for every AI call the app makes: Gemini for every feature, and
 * Claude Opus for Vera (and the RVU coder when the physician picks it).
 *
 * Gemini, two routes chosen per call:
 *  1. The user's OWN key (settings.apiKey, device-local): straight to
 *     generativelanguage.googleapis.com exactly as before. Their key, their
 *     bill, no shared quota.
 *  2. No own key: the ai-proxy edge function. The shared Gemini key never
 *     leaves the server; the proxy checks the Clerk JWT, the beta gate and a
 *     per-user daily cap, then forwards the same JSON body and returns
 *     Gemini's status + JSON verbatim. From the user's side AI is simply on.
 *
 * Opus, the same two routes:
 *  1. The user's OWN Anthropic key (settings.anthropicApiKey, device-local):
 *     the SDK talks to api.anthropic.com directly, as it always has.
 *  2. No own key: the SDK is pointed at ai-proxy (baseURL), so it posts to
 *     <PROXY_URL>/v1/messages with the Clerk JWT. The shared Anthropic key
 *     stays on the server; the proxy meters Opus on its own daily cap.
 *
 * geminiCall() returns a Response-like { ok, status, json() } so the call
 * sites keep their existing parsing. Proxy-side refusals (quota, key not
 * configured, beta gate, signed out) additionally carry `proxyError` and a
 * ready user-facing `message`, so a util can surface the real reason instead
 * of a generic "error 429". anthropicErrorMessage() does the same job for a
 * failed SDK call.
 *
 * Shared-AI status (are the shared keys on? how many calls used today?) is
 * fetched once per page load after sign-in and cached in module state plus
 * localStorage, so `aiAvailable(settings)` / `anthropicAvailable(settings)`
 * are synchronous for gating.
 *
 * Kept free of app-context/JSX imports: cmeImport.js pulls this in and is
 * unit-tested under plain node. The Anthropic SDK is imported on demand so
 * Gemini-only users never download that chunk.
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
export const quotaMessage = (limit) => `Shared AI quota reached for today (${limit || SHARED_DAILY_LIMIT} calls). Add your own Gemini key in Settings to keep going.`;
export const opusQuotaMessage = (limit) => `Shared Opus quota reached for today (${limit || sharedAiStatus?.anthropicLimit || SHARED_DAILY_LIMIT} calls). Add your own Anthropic key in Settings to keep going.`;
export const AI_MESSAGES = {
  get quota() { return quotaMessage(sharedAiStatus?.limit); },
  get opus_quota() { return opusQuotaMessage(sharedAiStatus?.anthropicLimit); },
  shared_key_not_configured: "AI is not switched on yet: the shared key is not configured.",
  opus_not_enabled: "Opus is not enabled on this account yet.",
  forbidden: "AI is available once your beta access is active.",
  unauthorized: "Sign in to use AI features.",
  offline: "AI is not reachable right now. Check your connection and try again.",
};

/** Thrown by anthropicClientFor() when no Opus route exists before any request is made. */
export class AiProxyError extends Error {
  constructor(status, proxyError, message) {
    super(message);
    this.name = "AiProxyError";
    this.status = status;
    this.proxyError = proxyError;
  }
}

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
      anthropicShared: !!parsed.anthropicShared,
      anthropicUsed: Number(parsed.anthropicUsed) || 0,
      anthropicLimit: Number(parsed.anthropicLimit) || Number(parsed.limit) || SHARED_DAILY_LIMIT,
      unlimited: !!parsed.unlimited,
      checkedAt: Number(parsed.checkedAt) || 0,
    };
  } catch {
    return null;
  }
}

// { shared, used, limit, reason, anthropicShared, anthropicUsed, anthropicLimit, unlimited, checkedAt }
//   shared: the shared Gemini key is configured AND this user may use it
//   reason: why not, when shared is false. "pending" (beta gate),
//     "not_configured", "signed_out", "offline", or null
//   anthropicShared: the shared Anthropic key is configured AND this user may
//     use it (false on a proxy deploy that predates Opus)
//   anthropicUsed / anthropicLimit: Opus calls today vs the Opus daily cap
//   unlimited: admins, no daily cap on either provider
export let sharedAiStatus = readCachedStatus() || {
  shared: false, used: 0, limit: SHARED_DAILY_LIMIT, reason: null,
  anthropicShared: false, anthropicUsed: 0, anthropicLimit: SHARED_DAILY_LIMIT, unlimited: false,
  checkedAt: 0,
};

const STATUS_KEYS = ["shared", "used", "limit", "reason", "anthropicShared", "anthropicUsed", "anthropicLimit", "unlimited"];

function setSharedAiStatus(next) {
  const merged = { ...sharedAiStatus, ...next };
  const changed = STATUS_KEYS.some(k => merged[k] !== sharedAiStatus[k]);
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
 * GET ai-proxy → { shared, used_today, limit, unlimited, anthropic_shared,
 * anthropic_used_today, anthropic_limit }. The anthropic_* fields arrived
 * with the Opus relay; an older deploy omits them and Opus simply reads as
 * off. Runs once per page load (the first caller after sign-in wins; later
 * callers get the cache) unless `force` is set. Safe to call from anywhere;
 * never throws.
 */
export async function fetchSharedAiStatus({ force = false } = {}) {
  if (statusInflight) return statusInflight;
  if (statusFetchedThisLoad && !force) return sharedAiStatus;
  statusInflight = (async () => {
    if (!PROXY_URL) {
      setSharedAiStatus({ shared: false, anthropicShared: false, reason: "not_configured", checkedAt: Date.now() });
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
      const limit = Number(body?.limit) || SHARED_DAILY_LIMIT;
      setSharedAiStatus({
        shared: !!body?.shared,
        used: Number(body?.used_today ?? body?.used) || 0,
        limit,
        reason: body?.shared ? null : body?.configured === false ? "not_configured" : body?.allowed === false ? "pending" : "not_configured",
        anthropicShared: !!body?.anthropic_shared,
        anthropicUsed: Number(body?.anthropic_used_today) || 0,
        anthropicLimit: Number(body?.anthropic_limit) || limit,
        unlimited: !!body?.unlimited,
        checkedAt: Date.now(),
      });
    } else if (res.status === 403) {
      setSharedAiStatus({ shared: false, anthropicShared: false, reason: "pending", checkedAt: Date.now() });
    } else if (res.status === 401) {
      setSharedAiStatus({ shared: false, anthropicShared: false, reason: "signed_out", checkedAt: Date.now() });
    } else if (res.status === 503) {
      setSharedAiStatus({ shared: false, anthropicShared: false, reason: "not_configured", checkedAt: Date.now() });
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
  setSharedAiStatus({ shared: false, used: 0, reason: null, anthropicShared: false, anthropicUsed: 0, unlimited: false, checkedAt: 0 });
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

// The shared Opus door is open: key loaded, account allowed, and today's cap
// not yet hit (a 429 from the proxy sets used = limit so the next call
// routes to Gemini without a wasted round trip).
function sharedOpusOpen(s = sharedAiStatus) {
  if (!s.anthropicShared) return false;
  if (s.unlimited) return true;
  return !(s.anthropicLimit && s.anthropicUsed >= s.anthropicLimit);
}

/**
 * Is Claude Opus on for this user right now? True with an own Anthropic key
 * (device-local settings.anthropicApiKey) or when the shared Anthropic key
 * is on for their account. Same synchronous contract as aiAvailable().
 */
export function anthropicAvailable(settings) {
  if (settings?.anthropicApiKey) return true;
  if (!statusFetchedThisLoad && !statusInflight) fetchSharedAiStatus();
  return sharedOpusOpen();
}

/** True when an Opus call will ride the shared key (no own Anthropic key). */
export function usesSharedOpus(settings) {
  return !settings?.anthropicApiKey && sharedOpusOpen();
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

/**
 * The Opus counterpart: "Shared Opus: on, 3 of 50 calls used today". Null
 * when the Gemini line already says why AI is off for this account.
 */
export function describeOpusStatus(settings) {
  if (settings?.anthropicApiKey) return "Your own Anthropic key is in use on this device. The shared Opus daily limit does not apply.";
  const s = sharedAiStatus;
  if (s.anthropicShared) {
    if (s.unlimited) return `Shared Opus: on, ${s.anthropicUsed} call${s.anthropicUsed === 1 ? "" : "s"} today (no cap on admin accounts)`;
    if (s.anthropicLimit && s.anthropicUsed >= s.anthropicLimit) return `Shared Opus: daily limit reached (${s.anthropicLimit} calls). Vera answers on Gemini until tomorrow.`;
    return `Shared Opus: on, ${s.anthropicUsed} of ${s.anthropicLimit} calls used today`;
  }
  if (s.shared) return "Shared Opus: not enabled on this account yet. Vera runs on Gemini.";
  return null;
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

/** Live boolean: Claude Opus is on for this user (own Anthropic key or shared key). */
export function useAnthropicAvailable(settings) {
  const status = useSharedAiStatus();
  return !!settings?.anthropicApiKey || sharedOpusOpen(status);
}

// ─── The Gemini call ────────────────────────────────────────
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
    return wrapResponse(res, { proxyError: "quota", message: quotaMessage(Number(parsed.limit) || sharedAiStatus.limit), parsed });
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

// ─── The Opus client ────────────────────────────────────────
// Loaded on demand so Gemini-only users never download the Claude SDK chunk.
let AnthropicSDK = null;
export async function loadAnthropicSdk() {
  if (!AnthropicSDK) AnthropicSDK = (await import("@anthropic-ai/sdk")).default;
  return AnthropicSDK;
}
/** The SDK class once a client has been built (for instanceof checks); null before. */
export const anthropicSdk = () => AnthropicSDK;

// The proxy answers { error: "<string>" } for its own refusals; Anthropic's
// forwarded errors carry { type: "error", error: {…} }. Same rule as Gemini.
function proxyCodeOf(body) {
  return typeof body?.error === "string" ? body.error : null;
}

// The proxy's own refusals, noted in the status cache as they happen so the
// next call routes straight to Gemini and Settings reads true.
function noteOpusRefusal(status, body) {
  const code = proxyCodeOf(body);
  if (!code) return;
  if (status === 429 && code === "quota") {
    setSharedAiStatus({
      anthropicUsed: Number(body.used) || sharedAiStatus.anthropicLimit || SHARED_DAILY_LIMIT,
      anthropicLimit: Number(body.limit) || sharedAiStatus.anthropicLimit,
    });
  } else if (status === 503) {
    setSharedAiStatus({ anthropicShared: false });
  } else if (status === 403) {
    setSharedAiStatus({ shared: false, anthropicShared: false, reason: "pending" });
  }
}

// fetch for the shared route: the SDK does the request; this keeps the local
// Opus counter honest between status refreshes and records refusals.
async function sharedOpusFetch(url, init) {
  const res = await globalThis.fetch(url, init);
  if (res.ok) {
    if (sharedAiStatus.anthropicShared) setSharedAiStatus({ anthropicUsed: sharedAiStatus.anthropicUsed + 1 });
  } else if (res.status === 429 || res.status === 503 || res.status === 403) {
    let body = null;
    try { body = await res.clone().json(); } catch { body = null; }
    noteOpusRefusal(res.status, body);
  }
  return res;
}

/**
 * A configured @anthropic-ai/sdk client for this user.
 *   own key: direct to api.anthropic.com, exactly the construction Vera
 *     has always used.
 *   no key: baseURL = ai-proxy, so the SDK posts to <PROXY_URL>/v1/messages
 *     with the Clerk JWT. The x-api-key placeholder is ignored by the
 *     proxy; the shared key never reaches the browser.
 * Throws AiProxyError (with a user-facing message) when neither route exists.
 * The proxy is the judge of whether the shared key is on: the status cache
 * only decides routing, never blocks a call.
 */
export async function anthropicClientFor(settings) {
  const Anthropic = await loadAnthropicSdk();
  const ownKey = settings?.anthropicApiKey;
  if (ownKey) {
    return new Anthropic({
      apiKey: ownKey,
      dangerouslyAllowBrowser: true, // the key is the user's own, entered by them
      timeout: 120000,
      maxRetries: 1,
    });
  }
  if (!PROXY_URL) throw new AiProxyError(503, "opus_not_enabled", AI_MESSAGES.opus_not_enabled);
  const token = await getClerkToken();
  if (!token) throw new AiProxyError(401, "unauthorized", AI_MESSAGES.unauthorized);
  return new Anthropic({
    baseURL: PROXY_URL,
    apiKey: "shared",
    defaultHeaders: { Authorization: `Bearer ${token}` },
    dangerouslyAllowBrowser: true, // nothing secret in the browser: the proxy holds the key
    maxRetries: 1,
    timeout: 120000,
    fetch: sharedOpusFetch,
  });
}

/**
 * The message to show for a failed Opus call when the proxy (not Anthropic)
 * refused it, or no route existed; null otherwise so the caller's own error
 * handling applies. The SDK keeps the parsed response body on `err.error`.
 */
export function anthropicErrorMessage(err) {
  if (err instanceof AiProxyError) return err.message;
  const status = err?.status;
  const body = err?.error;
  const code = proxyCodeOf(body);
  if (!code) return null;
  if (status === 429 && code === "quota") return opusQuotaMessage(Number(body.limit) || sharedAiStatus.anthropicLimit);
  if (status === 503) return AI_MESSAGES.opus_not_enabled;
  if (status === 403) return AI_MESSAGES.forbidden;
  if (status === 401) return AI_MESSAGES.unauthorized;
  return null;
}
