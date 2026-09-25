/**
 * secretBox: client-side encryption for small secrets (portal passwords on
 * hospital privileges). Ciphertext syncs with the record so it follows the
 * physician across devices; the LOCK CODE never leaves the device (kept in
 * the same per-user localStorage slot as the AI keys) and is entered once
 * per device. Nobody reading the database, including the operator, can
 * read the secret without the code.
 *
 * Format: "enc1:" + base64(salt[16] + iv[12] + ciphertext). AES-GCM 256,
 * key = PBKDF2-SHA256(lockCode + ":" + userId, salt, 150k iterations).
 */
import { DEVICE_KEYS_BASE } from "./storageScope.js";
import { continuityBindingSubject, continuitySourceSubject } from "./continuityRecovery.js";

const PREFIX = "enc1:";
const slot = (uid) => `${DEVICE_KEYS_BASE}:${uid}`;
let activeUid = null;
let continuityBinding = null;

export function setSecretUser(uid) {
  activeUid = uid || null;
  if (continuityBinding) {
    try { if (continuityBindingSubject(continuityBinding) !== activeUid) continuityBinding = null; }
    catch { continuityBinding = null; }
  }
}
/** Configure only a branded binding from successful authenticated bootstrap. */
export function configureSecretContinuity(binding = null) {
  if (binding) continuityBindingSubject(binding);
  continuityBinding = binding;
}
export function isEncrypted(v) { return typeof v === "string" && v.startsWith(PREFIX); }

export function getLockCode(uid = activeUid) {
  try { return JSON.parse(localStorage.getItem(slot(uid)) || "{}").lockCode || null; } catch { return null; }
}
export function hasLockCode(uid = activeUid) { return !!getLockCode(uid); }
export function saveLockCode(code, uid = activeUid) {
  if (!uid) return;
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem(slot(uid)) || "{}") || {}; } catch { /* ignore */ }
  if (code) cur.lockCode = code; else delete cur.lockCode;
  localStorage.setItem(slot(uid), JSON.stringify(cur));
}

/**
 * Protected Identity (an SSN, a full date of birth) needs a longer code than
 * a portal password. A 4-character code is guessable offline in minutes if a
 * backup holding the ciphertext ever leaks.
 *
 * The saved-password lock code keeps working for passwords whatever its
 * length. When it is at least IDENTITY_LOCK_MIN long it opens Protected
 * Identity too; when it is shorter, Protected Identity has its own code in
 * the same device slot, set the first time an SSN or date of birth is saved
 * or revealed. Neither code ever leaves the device.
 */
export const IDENTITY_LOCK_MIN = 8;

function readSlot(uid) {
  try { return JSON.parse(localStorage.getItem(slot(uid)) || "{}") || {}; } catch { return {}; }
}

/** The code that opens Protected Identity on this device, or null. */
export function getIdentityLockCode(uid = activeUid) {
  const cur = readSlot(uid);
  if (typeof cur.identityLockCode === "string" && cur.identityLockCode.length >= IDENTITY_LOCK_MIN) return cur.identityLockCode;
  if (typeof cur.lockCode === "string" && cur.lockCode.length >= IDENTITY_LOCK_MIN) return cur.lockCode;
  return null;
}

/** The saved-password code when it is too short for Protected Identity. */
export function getShortLockCode(uid = activeUid) {
  const code = readSlot(uid).lockCode;
  return typeof code === "string" && code && code.length < IDENTITY_LOCK_MIN ? code : null;
}

/**
 * Remember a code for Protected Identity. Refuses one shorter than
 * IDENTITY_LOCK_MIN. A device with no lock code at all takes it as its lock
 * code (long enough for both); a device whose lock code is shorter keeps that
 * one for passwords and holds this one beside it.
 */
export function saveIdentityLockCode(code, uid = activeUid) {
  if (!uid || typeof code !== "string" || code.length < IDENTITY_LOCK_MIN) return false;
  const cur = readSlot(uid);
  if (!cur.lockCode) { cur.lockCode = code; delete cur.identityLockCode; }
  else if (cur.lockCode !== code) cur.identityLockCode = code;
  else delete cur.identityLockCode;
  try { localStorage.setItem(slot(uid), JSON.stringify(cur)); } catch { return false; }
  return true;
}

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(code, uid, salt) {
  const base = await crypto.subtle.importKey("raw", te.encode(`${code}:${uid}`), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain, code = getLockCode(), uid = activeUid) {
  if (!plain) return "";
  if (isEncrypted(plain)) return plain;
  if (!code || !uid) throw new Error("no-lock-code");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(code, uid, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plain)));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return PREFIX + b64(out);
}

export async function decryptSecret(value, code = getLockCode(), uid = activeUid) {
  if (!isEncrypted(value)) return value || "";
  if (!code || !uid) throw new Error("no-lock-code");
  const raw = unb64(value.slice(PREFIX.length));
  const salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
  const key = await deriveKey(code, uid, salt);
  try {
    return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  } catch {
    if (continuityBinding) {
      const binding = continuityBinding;
      let legacySubject;
      try { legacySubject = continuitySourceSubject(binding, uid); } catch { throw new Error("wrong-lock-code"); }
      const legacyKey = await deriveKey(code, legacySubject, salt);
      // Both awaits can outlive a session/account change. Check before using
      // legacy derivation and again before returning any decrypted plaintext.
      try {
        continuitySourceSubject(binding, uid);
        if (continuityBinding !== binding) throw new Error("stale-continuity");
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, legacyKey, ct);
        continuitySourceSubject(binding, uid);
        if (continuityBinding !== binding) throw new Error("stale-continuity");
        return td.decode(plain);
      } catch { throw new Error("wrong-lock-code"); }
    }
    throw new Error("wrong-lock-code");
  }
}
