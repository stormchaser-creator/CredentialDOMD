// Restoring a JSON backup (Data & Backup > Restore from Backup), as data.
//
// Three things were wrong when this lived inline in DataExport.jsx:
//  - the file REPLACED each collection whole, so a record added after the
//    export vanished from the screen (and came back from the cloud on the
//    next load), while a record deleted since came back and was pushed up
//    under a tombstone that still hid it: "Data imported successfully!" for a
//    result that matched neither the file nor the account;
//  - every string was cut to 5,000 characters, which corrupted the base64
//    bytes of every restored document (and a document that was only on this
//    device then uploaded the broken bytes);
//  - the settings allowlist was hand-kept and had drifted behind what the
//    profile syncs (tax prep, the monthly backup switch, the setup board...).
//
// Pure: plain node tests import it.

import { DEVICE_ONLY_SECTIONS, deviceOnlySectionsChanged, deviceOnlyBlockedMessage } from "./pausedApplicationRecords.js";

export const MAX_STR_LEN = 5000;
// A career case log or a multi-year work log runs to many thousands of rows;
// a large bound only blunts a hostile deeply-repeated array.
export const MAX_ARRAY_LEN = 100000;

// data:<type>/<subtype>[;param=value]*;base64,<body>, the body whole.
const DATA_URL_RE = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * A complete, well-formed base64 data URL. A cut one is not: its body is not
 * whole base64, or (when the file's byte size is known) it decodes to fewer
 * bytes than the file had.
 */
export function isCompleteDataUrl(value, size) {
  if (typeof value !== "string") return false;
  const m = value.match(DATA_URL_RE);
  if (!m || m[1].length === 0 || m[1].length % 4 !== 0) return false;
  if (Number.isFinite(size) && size > 0) {
    const padding = m[1].endsWith("==") ? 2 : m[1].endsWith("=") ? 1 : 0;
    const bytes = (m[1].length / 4) * 3 - padding;
    if (Math.abs(bytes - size) > 2) return false;
  }
  return true;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Switches that send something on the physician's behalf or to them: the
 * automatic acknowledgement docs@ emails to a requester, the monthly backup
 * email, reminder emails and texts, and this device's alerts. A restore never
 * changes them (lib/supabase.js leaves them out of RESTORABLE_SETTINGS): the
 * file holds whatever they were when it was saved, and a physician who turned
 * acknowledgements off since, then restored the file to recover one deleted
 * licence, had them switched back on with nothing on screen saying so.
 */
export const MESSAGE_SWITCHES = Object.freeze(["ackRequests", "backupMonthly", "notifyEmail", "notifyText", "notifyBrowser"]);

// Taken from the file only when this account has none: the setup board's
// skips, declared negatives, snooze and completion stamps describe where the
// physician is now, and an older file's would bring back tasks since settled.
const FILL_ONLY_SETTINGS = new Set(["setupState"]);
const isUnset = (v) => v === undefined || v === null;

/** Strip prototype keys and cap strings and arrays, recursively. */
export function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STR_LEN ? value.slice(0, MAX_STR_LEN) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LEN).map(sanitize);
  if (typeof value === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      clean[k] = sanitize(v);
    }
    return clean;
  }
  return undefined;
}

/**
 * One document from the file. Its bytes are never cut: a document the cloud
 * holds (storagePath) is restored without them and downloads fresh; one that
 * is not in the cloud keeps them only when they are a complete data URL.
 */
function sanitizeDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return sanitize(doc);
  const { data, ...rest } = doc;
  const clean = sanitize(rest);
  if (!clean.storagePath && isCompleteDataUrl(data, Number(doc.size))) clean.data = data;
  return clean;
}

const stamp = (r) => {
  const t = Date.parse(r?.updatedAt || "");
  return Number.isFinite(t) ? t : 0;
};

/** Whether `raw` is shaped like a CredentialDOMD export at all. */
export function isBackupFile(raw) {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && !!raw.settings && !!(raw.licenses || raw.cme);
}

/**
 * What restoring `raw` onto `current` does.
 *
 * Returns { invalid } for a file that is not a CredentialDOMD export, else
 * { merged, changed, restoredIds, keptNewer, settings, switchesKept,
 *   documentsWithoutFile }:
 *  - merged: current plus the file, merged BY ID. A record only in the file
 *    is added; one on both sides keeps whichever copy was edited later
 *    (updatedAt); one only on this device is kept.
 *  - changed: per collection, the records the restore added or replaced,
 *    which is all that needs sending to the cloud. One brought back from a
 *    delete (the ledger holds it, or, unread, it is missing here) is stamped
 *    updatedAt = `now`: sent with the file's old stamp, it lost the self-heal
 *    comparison to any device still holding a copy edited before the delete,
 *    which pushed that copy back over the restore. Every other record keeps
 *    its own stamp, so a newer edit made on another device still wins there
 *    on its next load. Stamped `now`, the file's older copy beat that edit and
 *    the other device took it over its own, losing the edit for good.
 *  - restoredIds: per collection, the ids whose deletion marker the caller
 *    clears before sending them, or they stay hidden on every load: every id
 *    the file brings back that was not on this device (it may have been
 *    deleted here, and its delete may still be queued), plus, when
 *    `tombstones` (the account's deletion ledger, a Set of ids) was read,
 *    every id of the file the ledger holds. A record still on this device
 *    but deleted on another since this device last loaded is one of those:
 *    it is sent again too, or the restore said it was back and the next load
 *    hid it.
 *  - keptNewer: how many records here were newer than the file's copy.
 *  - switchesKept: whether the file's message switches (MESSAGE_SWITCHES)
 *    differ from this account's, which stay as they are.
 *  - documentsWithoutFile: documents in the file with no file anywhere (not
 *    in the cloud when it was saved, and no whole bytes in it). Left out: an
 *    entry with no file could never reach the account.
 *
 * Every document restored carries a storage path or its bytes.
 */
export function planRestore(current, raw, { collectionKeys, restorableSettings, tombstones = null, now = new Date().toISOString() }) {
  if (!isBackupFile(raw)) return { invalid: true };
  const merged = { ...current };
  const changed = {};
  const restoredIds = {};
  const ledgerRead = typeof tombstones?.has === "function";
  const deleted = (id) => ledgerRead && tombstones.has(id);
  // Brought back from a delete, so stamped with the restore time.
  const undeleted = (r) => ({ ...r, updatedAt: now });
  let keptNewer = 0;
  let documentsWithoutFile = 0;
  for (const key of collectionKeys) {
    if (!Array.isArray(raw[key])) continue;
    const incoming = raw[key].slice(0, MAX_ARRAY_LEN).map(key === "documents" ? sanitizeDocument : sanitize);
    const here = Array.isArray(current?.[key]) ? current[key] : [];
    const byId = new Map(here.map((r) => [r?.id, r]));
    const out = [...here];
    const index = new Map(here.map((r, i) => [r?.id, i]));
    // When each copy here was edited, compared before the restore's own
    // stamp: a file listing one id twice is not "newer here" the second time.
    const editedAt = new Map(here.map((r) => [r?.id, stamp(r)]));
    // A file listing one id twice sends it once, as its last copy.
    const sent = new Map();
    const write = (next, at, edited) => {
      if (at === undefined) {
        out.push(next);
        index.set(next.id, out.length - 1);
      } else {
        out[at] = next;
      }
      byId.set(next.id, next);
      editedAt.set(next.id, edited);
      const list = (changed[key] ||= []);
      if (sent.has(next.id)) list[sent.get(next.id)] = next;
      else { sent.set(next.id, list.length); list.push(next); }
    };
    const cleared = new Set();
    const undelete = (id) => { if (!cleared.has(id)) { cleared.add(id); (restoredIds[key] ||= []).push(id); } };
    for (const item of incoming) {
      if (!item || typeof item !== "object" || !item.id) continue;
      const mine = byId.get(item.id);
      if (!mine) {
        if (key === "documents" && !item.storagePath && !item.data) { documentsWithoutFile += 1; continue; }
        // Its marker is cleared: it may have been deleted here, and its
        // delete may still be queued. Stamped only when the account's ledger
        // holds it or could not be read: one the ledger does not hold was
        // never deleted in the account (added on another device after this
        // one loaded, say), and an edit made to it there must still win.
        write(!ledgerRead || deleted(item.id) ? undeleted(item) : item, undefined, stamp(item));
        undelete(item.id);
        continue;
      }
      const theirs = stamp(item), ours = editedAt.get(item.id) || 0;
      if (theirs > ours) {
        // The file's copy is newer. A document keeps the bytes already here,
        // and the storage path this device knows when the file was saved
        // before its upload landed. It keeps the file's own stamp unless it
        // comes back from a delete: this device may have loaded long before
        // another device edited the record again, and that later edit must
        // still beat this older copy there.
        const copy = key === "documents"
          ? { ...item, data: item.data || mine.data, storagePath: item.storagePath || mine.storagePath }
          : item;
        const next = deleted(item.id) ? undeleted(copy) : copy;
        if (key === "documents" && next.data === undefined) delete next.data;
        if (key === "documents" && next.storagePath === undefined) delete next.storagePath;
        write(next, index.get(item.id), theirs);
        if (deleted(item.id)) undelete(item.id);
        continue;
      }
      if (ours > theirs) keptNewer += 1;
      // Still on this device but deleted on another since this device last
      // loaded: the copy here is what comes back, sent again with its marker
      // cleared, like any record the file brings back.
      if (deleted(item.id) && !cleared.has(item.id)) {
        write(undeleted(mine), index.get(item.id), ours);
        undelete(item.id);
      }
    }
    merged[key] = out;
  }
  const settings = {};
  const incomingSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const currentSettings = current?.settings || {};
  for (const k of restorableSettings) {
    if (!(k in incomingSettings) || FORBIDDEN_KEYS.has(k) || MESSAGE_SWITCHES.includes(k)) continue;
    if (FILL_ONLY_SETTINGS.has(k) && !isUnset(currentSettings[k])) continue;
    if (k === "profilePhoto") {
      // A photo is a data URL far longer than the string cap: restored whole
      // when it is a complete image, never cut.
      if (isCompleteDataUrl(incomingSettings[k]) && incomingSettings[k].startsWith("data:image/")) settings[k] = incomingSettings[k];
      continue;
    }
    settings[k] = sanitize(incomingSettings[k]);
  }
  merged.settings = { ...currentSettings, ...settings };
  // Blank reads as on for every one of them (utils/reminderPreferences.js).
  const on = (v) => v !== false;
  const switchesKept = MESSAGE_SWITCHES.some((k) => k in incomingSettings && on(incomingSettings[k]) !== on(currentSettings[k]));
  return { merged, changed, restoredIds, keptNewer, settings, switchesKept, documentsWithoutFile };
}


/** Said when a restore is refused because the membership is read-only. */
export const RESTORE_READ_ONLY_MESSAGE = "Restore is unavailable while records are read-only. Your saved records and exports have not changed.";

/**
 * Why a restore that would change `before` into `next` is refused now, or
 * null when nothing refuses it here. `deviceOnlyBlocked`: why this device
 * would keep no change to Protected Identity or the Answer Bank now
 * (utils/storage.js deviceOnlySaveBlocked: its offline copy is unread, or
 * the last save of it landed in no store), or null. A backup that brings
 * Protected Identity back is refused for that reason, and says so; it used
 * to be refused with the read-only membership message, which pointed the
 * member away from the reload that fixes it.
 */
export function restoreRefusal(before, next, deviceOnlyBlocked = null) {
  if (deviceOnlyBlocked && deviceOnlySectionsChanged(before, next)) return deviceOnlyBlockedMessage(deviceOnlyBlocked);
  return null;
}

/**
 * `next` with Protected Identity and the Answer Bank exactly as `before`
 * holds them: a restore applied while this device would keep no change to
 * those sections (restoreRefusal) restores the rest of the file, the synced
 * records and settings, and leaves them as they are.
 */
export function keepDeviceOnlySections(before, next) {
  const out = { ...next };
  for (const section of Object.keys(DEVICE_ONLY_SECTIONS)) {
    if (before && Object.hasOwn(before, section)) out[section] = before[section];
    else delete out[section];
  }
  return out;
}

/** Said with such a restore: what was left out, and why (restoreRefusal's message). */
export function deviceOnlyNotRestoredNote(reason) {
  return `Protected Identity and Answer Bank records in the file were not restored. ${reason} Then restore the file again to add them.`;
}

/** The message for a restore the records' own guard refused (setData returned false). */
export function restoreRefusedMessage(before, next, deviceOnlyBlocked = null) {
  return restoreRefusal(before, next, deviceOnlyBlocked) || RESTORE_READ_ONLY_MESSAGE;
}
