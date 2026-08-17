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
const PREFIX = "enc1:";
const slot = (uid) => `credentialdomd-keys:${uid}`;
let activeUid = null;

export function setSecretUser(uid) { activeUid = uid || null; }
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
    throw new Error("wrong-lock-code");
  }
}
