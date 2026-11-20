// One step, pay first sign-up (owner decision 2026-11-20): Sign up opens
// Stripe Checkout at once, and the account is made from the email paid with
// (supabase/functions/_shared/payFirstSignup.mjs). Off unless this build has
// VITE_PAY_FIRST_SIGNUP_ENABLED and the database has pay_first_signup_enabled;
// with either off the sign-in screen is login first, exactly as before (a
// refused start turns it back at once).

export const PAY_FIRST_SIGNUP_ENABLED = import.meta.env?.VITE_PAY_FIRST_SIGNUP_ENABLED === "true";

const START_PATH = "/functions/v1/public-signup-checkout";
const STATUS_PATH = "/functions/v1/public-signup-status";
// The secret only this browser holds for a Checkout it started: its sha256
// goes to the server at start, the secret itself only with the status ask.
const NONCE_PREFIX = "credentialdomd.payFirst.";
const LATEST_KEY = "credentialdomd.payFirst.latest";

/** How long the return screen waits before offering Log in (about 60 s). */
export const PAY_FIRST_RETURN_DELAYS_MS = Object.freeze([0, 1000, 2000, 3000, 5000, 8000, 13000, 13000, 15000]);

export const PAY_FIRST_COPY = Object.freeze({
  signUp: "Sign up",
  logIn: "Log in",
  alreadyMember: "Already a member?",
  justPaid: "Just paid? Log in with the email you used at checkout.",
  starting: "Opening secure checkout...",
  settingUp: "Setting up your account...",
  stillSettingUp: "Still setting up. We'll keep trying. You can log in with the email you used at checkout.",
  logInWithCheckoutEmail: "Log in with the email you used at checkout.",
  alreadyHaveMembership: "You already have a membership. Log in.",
  // The existing "temporarily full" status line (public/membership-offer.js), first sentence.
  full: "Founding checkout is temporarily unavailable.",
  unavailable: "Sign up did not open. Try again in a minute.",
});

/** The Checkout a return names (/app/?signup=cs_...), or null. */
export function readSignupReturn(search) {
  try {
    const value = new URLSearchParams(typeof search === "string" ? search : "").get("signup");
    return typeof value === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(value) ? value : null;
  } catch { return null; }
}

/** /app/?start=signup: a home page Sign up that goes straight to Checkout. */
export function readStartSignup(search) {
  try { return new URLSearchParams(typeof search === "string" ? search : "").get("start") === "signup"; } catch { return false; }
}

/**
 * The address after a pay-first return: the signup parameter becomes
 * billing=complete, so the existing notice confirms the membership
 * (billingReturn.js). Everything else stays.
 */
export function afterSignupReturn({ pathname = "/", search = "", hash = "" } = {}) {
  const params = new URLSearchParams(search);
  params.delete("signup");
  params.delete("start");
  params.set("billing", "complete");
  return `${pathname}?${params.toString()}${hash || ""}`;
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function makeNonce(cryptoImpl = globalThis.crypto) {
  return base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
}
export async function nonceDigest(nonce, cryptoImpl = globalThis.crypto) {
  const buf = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function keep(storage, signupId, nonce) {
  try {
    storage.setItem(`${NONCE_PREFIX}${signupId}`, nonce);
    storage.setItem(LATEST_KEY, signupId);
  } catch { /* Without it, the payer logs in with the email code instead. */ }
}
/** The nonce for the Checkout this browser started last, or null. */
export function keptNonce(storage = globalThis.localStorage) {
  try {
    const id = storage?.getItem(LATEST_KEY);
    return id ? storage.getItem(`${NONCE_PREFIX}${id}`) : null;
  } catch { return null; }
}
export function forgetNonce(storage = globalThis.localStorage) {
  try {
    const id = storage?.getItem(LATEST_KEY);
    if (id) storage.removeItem(`${NONCE_PREFIX}${id}`);
    storage?.removeItem(LATEST_KEY);
  } catch { /* Nothing kept. */ }
}

async function post(url, body, fetchImpl, timeoutMs = 15000) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller?.signal });
    let data = null;
    try { data = await response.json(); } catch { /* Not JSON. */ }
    return { status: response.status, data };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Sign up: hold a place and open Checkout. { url } to go to, or { error }:
 * "disabled" (turn back to login first), "full", or "unavailable".
 */
export async function startSignup({ supabaseUrl, fetchImpl = globalThis.fetch, storage = globalThis.localStorage, cryptoImpl = globalThis.crypto } = {}) {
  try {
    if (!supabaseUrl) return { error: "disabled" };
    const nonce = makeNonce(cryptoImpl);
    const { status, data } = await post(new URL(START_PATH, supabaseUrl).href, { nonceDigest: await nonceDigest(nonce, cryptoImpl) }, fetchImpl);
    if (status === 200 && typeof data?.url === "string" && /^https:\/\/checkout\.stripe\.com\//.test(data.url) && /^[0-9a-f-]{36}$/.test(data.signupId || "")) {
      keep(storage, data.signupId, nonce);
      return { url: data.url };
    }
    if (data?.error === "signup_disabled") return { error: "disabled" };
    if (data?.error === "founding_full") return { error: "full" };
    return { error: "unavailable" };
  } catch { return { error: "unavailable" }; }
}

/**
 * The paying browser's question after Checkout: { state } of ready (with a
 * one-use ticket), setting_up, login, already_member, delayed, or unknown.
 */
export async function signupStatus({ supabaseUrl, sessionId, nonce, fetchImpl = globalThis.fetch } = {}) {
  try {
    if (!supabaseUrl || !sessionId || !nonce) return { state: "login" };
    const { status, data } = await post(new URL(STATUS_PATH, supabaseUrl).href, { sessionId, nonce }, fetchImpl);
    if (status === 200 && data?.state === "ready" && typeof data.ticket === "string" && data.ticket) return { state: "ready", ticket: data.ticket };
    if ([200, 202].includes(status) && ["setting_up", "login", "already_member", "delayed"].includes(data?.state)) return { state: data.state };
    // Not this browser's Checkout, or none: the email code is the way in.
    if ([403, 404].includes(status)) return { state: "login" };
    return { state: "setting_up" };
  } catch { return { state: "setting_up" }; }
}

/** Sign in with the one-use ticket (Clerk Core 2: signIn.create, then setActive). True when signed in. */
export async function signInWithTicket({ signIn, setActive, ticket }) {
  try {
    const attempt = await signIn.create({ strategy: "ticket", ticket });
    if (attempt?.status !== "complete" || !attempt.createdSessionId) return false;
    await setActive({ session: attempt.createdSessionId });
    return true;
  } catch { return false; }
}

const PROVED_KEY = "credentialdomd.payFirst.proved.";
/**
 * After any sign-in: lets the server turn docs@ on for an account made from a
 * Checkout email once this is not the instant sign-in (the server decides).
 * Once per session; best effort.
 */
export async function proveEmailOnce({ supabaseUrl, sessionId, getToken, fetchImpl = globalThis.fetch, storage = globalThis.sessionStorage } = {}) {
  try {
    if (!PAY_FIRST_SIGNUP_ENABLED || !supabaseUrl || !sessionId || storage?.getItem(`${PROVED_KEY}${sessionId}`)) return null;
    const token = await getToken();
    if (!token) return null;
    const response = await fetchImpl(new URL(STATUS_PATH, supabaseUrl).href, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "prove" }) });
    const data = await response.json().catch(() => null);
    if (response.ok) storage?.setItem(`${PROVED_KEY}${sessionId}`, "1");
    return data?.state ?? null;
  } catch { return null; }
}
