/**
 * The private vault: patient-identifying scratch notes that must NEVER
 * reach the cloud.
 *
 * A physician billing a two-minute phone call needs to know which patient
 * it was when the agency queries it a month later. That is a real need, and
 * a rule saying "don't write it down" would simply be worked around. So the
 * note is kept here, in this browser's own storage, keyed by the record it
 * belongs to. The synced record carries nothing but the key.
 *
 * The trade, stated plainly in the UI: these notes do not follow you to
 * another device, because the only way to make them follow you is to send
 * them to a server, which is the thing we are declining to do.
 *
 * The vault is namespaced by the signed-in Clerk user (see storageScope):
 * on a shared device each physician's notes sit under their own key, and
 * another account cannot read, count or export them.
 */

import { BASE_KEYS, lsGetJSON, lsSet, lsRemove, scopedKey } from "./storageScope";

function readVault() {
  const v = lsGetJSON(BASE_KEYS.vault);
  return v && typeof v === "object" ? v : {};
}

/**
 * Ask the browser to exempt this origin from storage eviction. iOS clears
 * script-writable storage for sites left idle, and the vault is the one
 * thing here that exists nowhere else — losing it loses the note for good.
 * Fire-and-forget: a refusal is not an error, it just means the physician
 * should keep an exported copy.
 */
let persistAsked = false;
function askPersist() {
  if (persistAsked || typeof navigator === "undefined") return;
  persistAsked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* unsupported */ }
}

function writeVault(v) {
  if (!scopedKey(BASE_KEYS.vault)) return false; // nobody signed in
  if (!lsSet(BASE_KEYS.vault, JSON.stringify(v))) {
    return false; // storage full or blocked; the caller shows the failure
  }
  askPersist();
  return true;
}

/** True when the browser has promised not to evict this origin's storage. */
export async function isPersisted() {
  try { return await navigator.storage?.persisted?.() ?? null; } catch { return null; }
}

/** Read the private note for a record, e.g. getPrivate("workLog", entryId). */
export function getPrivate(section, id) {
  if (!section || !id) return "";
  return readVault()[`${section}:${id}`] || "";
}

/** Save (or clear, with an empty string) a record's private note. */
export function setPrivate(section, id, text) {
  if (!section || !id) return false;
  const v = readVault();
  const k = `${section}:${id}`;
  if (text && text.trim()) v[k] = text.trim();
  else delete v[k];
  return writeVault(v);
}

export function removePrivate(section, id) {
  return setPrivate(section, id, "");
}

/** Everything in the vault, for the export/backup screen. */
export function exportVault() {
  return readVault();
}

/** Merge a previously exported vault back in (restore on a new device). */
export function importVault(obj) {
  if (!obj || typeof obj !== "object") return false;
  return writeVault({ ...readVault(), ...obj });
}

export function clearVault() {
  lsRemove(BASE_KEYS.vault);
  return true;
}

export function vaultCount() {
  return Object.keys(readVault()).length;
}

/**
 * A cheap, deliberately loud check for identifiers heading somewhere they
 * shouldn't. Not a scrubber — it cannot catch everything and does not try.
 * Its job is to make the physician pause before a name reaches the cloud
 * or a third-party model.
 */
export function looksLikePHI(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const hits = [];
  // Medical record numbers: a long digit run, or a letter-prefixed one
  if (/\b[A-Z]{1,3}\d{6,}\b/i.test(s) || /\b\d{7,}\b/.test(s)) hits.push("what looks like a medical record number");
  // Phone numbers
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(s)) hits.push("a phone number");
  // Dates of birth written out
  if (/\b(dob|d\.o\.b\.|born)\b/i.test(s)) hits.push("a date of birth");
  // Two capitalised words that aren't a known clinical phrase — a weak
  // signal on purpose; the warning is advisory, never blocking
  if (/\bMRN\b/i.test(s)) hits.push("an MRN label");
  return hits.length ? hits : null;
}
