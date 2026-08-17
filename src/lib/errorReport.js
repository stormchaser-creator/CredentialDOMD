/**
 * Client-side error reporting.
 *
 * Catches window 'error', 'unhandledrejection', and React render crashes
 * (via the exported ErrorBoundary) and POSTs a small scrubbed payload to the
 * report-error edge function, which writes public.client_errors. Without
 * this a beta user's white screen is invisible to the operator.
 *
 * Deliberately dependency-free (no supabase-js, no Clerk imports): it has to
 * work when either of those is the thing that broke. Identity is opt-in via
 * setErrorUser(clerkUserId) from wherever the app knows it.
 *
 * Written without JSX so it stays a plain .js module.
 */

/* global __APP_BUILD_ID__ */
import { Component, createElement } from "react";

const ENDPOINT = import.meta.env.VITE_SUPABASE_URL
  ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/report-error`
  : null;

const BUILD =
  typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : "dev";

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_REPORTS_PER_SESSION = 25;

// Anything credential-shaped is replaced before it leaves the browser.
// The function scrubs again server-side.
const SECRET_RE =
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}|\bsk-[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{20,}|\bre_[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"?(?:apikey|authorization|x-api-key)"?\s*[:=]\s*"?[^",\s}]{6,}/gi;

let currentUserId = null;
let installed = false;
let sent = 0;
const seen = new Set();

/** Set (or clear) the Clerk user id to attach to reports. Safe to call often. */
export function setErrorUser(id) {
  currentUserId = typeof id === "string" && id ? id : null;
}

function scrub(s) {
  return String(s).replace(SECRET_RE, "[redacted]");
}

function clip(s, max) {
  if (s == null) return null;
  const t = String(s);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function describe(err) {
  if (err instanceof Error) {
    return { message: err.message || err.name || "Error", stack: err.stack || null };
  }
  if (err && typeof err === "object") {
    let text;
    try { text = JSON.stringify(err); } catch { text = String(err); }
    return { message: text, stack: null };
  }
  return { message: String(err), stack: null };
}

// Noise that is not an app bug and would only burn the rate cap.
function ignorable(message) {
  return (
    /ResizeObserver loop/i.test(message) ||
    /Script error\.?$/i.test(message) ||
    /Load failed|Failed to fetch|NetworkError|The network connection was lost/i.test(message) ||
    /AbortError|The operation was aborted/i.test(message)
  );
}

function post(payload) {
  if (!ENDPOINT) return;
  const body = JSON.stringify(payload);
  // sendBeacon survives page unload and, with a plain string body, needs no
  // CORS preflight. Fall back to a keepalive fetch.
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      if (navigator.sendBeacon(ENDPOINT, body)) return;
    }
  } catch { /* fall through */ }
  try {
    fetch(ENDPOINT, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
    }).catch(() => {});
  } catch { /* nothing left to try */ }
}

/**
 * Report an error. `kind` is 'error' | 'unhandledrejection' | 'react'.
 * De-dupes identical kind+message within the session and caps volume.
 */
export function reportError(err, kind = "error", extra = undefined) {
  try {
    const { message: rawMessage, stack: rawStack } = describe(err);
    if (!rawMessage || ignorable(rawMessage)) return;
    const message = scrub(clip(rawMessage, MAX_MESSAGE));
    const key = `${kind}|${message}`;
    if (seen.has(key)) return;
    if (sent >= MAX_REPORTS_PER_SESSION) return;
    seen.add(key);
    sent += 1;

    const payload = {
      kind,
      message,
      stack: rawStack ? scrub(clip(rawStack, MAX_STACK)) : null,
      url: scrub(clip(typeof location !== "undefined" ? location.href : "", 500)),
      user_agent: clip(typeof navigator !== "undefined" ? navigator.userAgent : "", 300),
      build: BUILD,
      auth_user_id: currentUserId,
      extra: extra && typeof extra === "object" ? extra : {},
    };
    if (import.meta.env.DEV) {
      // Visible in dev, but do not spam the live table from localhost.
      console.warn("[errorReport] would send:", payload);
      return;
    }
    post(payload);
  } catch { /* reporting must never throw */ }
}

/** Install global listeners once. Call from main.jsx before rendering. */
export function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Resource load failures (img/script) fire 'error' too but have no .error;
    // those are noise for this sink.
    if (!event.error && !event.message) return;
    const err = event.error || new Error(event.message);
    reportError(err, "error", {
      source: event.filename ? clip(event.filename, 300) : undefined,
      line: event.lineno || undefined,
      col: event.colno || undefined,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason ?? "Unhandled promise rejection", "unhandledrejection");
  });
}

/**
 * Top-level boundary. Plain inline styles on purpose: if the crash was in
 * CSS loading or the design system, this still renders.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    console.error("CredentialDOMD crashed:", error, info);
    reportError(error, "react", {
      componentStack: info && info.componentStack ? clip(info.componentStack, 1500) : undefined,
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return createElement(
      "div",
      {
        style: {
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#f8f9fa",
          color: "#1a1a2e",
        },
      },
      createElement(
        "div",
        {
          role: "alert",
          style: {
            maxWidth: 360,
            width: "100%",
            background: "#fff",
            border: "1px solid #e9ecef",
            borderRadius: 12,
            padding: "20px 22px",
            textAlign: "center",
          },
        },
        createElement("p", { style: { fontSize: 15, lineHeight: 1.5, margin: "0 0 16px" } },
          "Something broke on this screen. Reload."),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => window.location.reload(),
            style: {
              padding: "10px 22px",
              borderRadius: 10,
              border: "none",
              background: "#6366f1",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            },
          },
          "Reload"
        )
      )
    );
  }
}

export default { install, reportError, setErrorUser, ErrorBoundary };
