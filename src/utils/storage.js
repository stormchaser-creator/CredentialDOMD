import { DEFAULT_DATA } from "../constants/defaults";
import { BASE_KEYS, scopedKey, purgeForSignOut, localCopyCurrent, hydrateOfflineStores, readOfflineFile, writeOfflineText,
  localWriteGuard, storageRefusalKind, reportStorageRefusal, offlineCopyUnread, getActiveUserId, offlineWriteStamp,
  deviceOnlySectionsOf, sameDeviceOnlySections, rebaseDeviceOnlySections, holdDeviceOnlyChanges, heldDeviceOnlyChanges,
  withHeldDeviceOnlyChanges, releaseHeldDeviceOnlyChanges, setBeforeDeviceOnlyTrim, writeOwnLocalCopy, rewriteLocalCopy,
  saveStopGuard, holdsDeviceOnlyChangesHere, takeReleasedHoldHere } from "./storageScope";
import { loadDeviceKeys, EXPORT_REDACT_FIELDS, sanitizeCachedBlob, stripDeviceFields } from "../lib/supabase";

const ENV_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

function applyDefaults(data) {
  if (!data.settings.apiKey && ENV_API_KEY) {
    data.settings.apiKey = ENV_API_KEY;
  }
  return data;
}

/**
 * Re-hydrate the per-device keys into settings, and ONLY those.
 *
 * AI keys are stripped from the cached blob (see saveData), so the offline load
 * path puts them back from the per-device slot; without this a user offline
 * after the strip would lose their own key from settings state.
 *
 * It used to spread the slot over whatever settings already held, which is a
 * merge, and a merge keeps what it does not overwrite. A blob written by an
 * older build still carries the lock code and the CallSync feed link inside
 * settings, and the slot has no value for the lock code at all (nothing
 * hydrates it any more, by design), so the merge left it standing in the
 * object the app then renders, saves and exports from. Settings are therefore
 * CLEANED of every device-only field first, and then the allowlisted slot
 * values are put on top. loadDeviceKeys already returns nothing but
 * DEVICE_KEY_FIELDS, so this cannot be the path a lock code returns by.
 */
function applyDeviceKeys(data, userId) {
  const keys = loadDeviceKeys(userId);
  const settings = stripDeviceFields(data.settings);
  return { ...data, settings: { ...settings, ...(keys || {}) } };
}

function withDefaults(parsed) {
  return {
    ...DEFAULT_DATA,
    ...parsed,
    settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
  };
}

/**
 * The on-device copy of the file for one user (null when nobody is signed
 * in or nothing is cached). Merged with defaults, and sanitised.
 *
 * Asynchronous: the copy lives in IndexedDB (src/utils/offlineStore.js), and
 * the first read of a session moves a localStorage copy left by an older
 * build into it, freeing the space (storageScope.js hydrateOfflineStores).
 * Where IndexedDB is unavailable the localStorage copy is read as before.
 * When IndexedDB may hold the copy but could not be read (it would not open,
 * twice), this returns null AND the copy is marked unread (storageScope.js
 * readOfflineFile): nothing is saved over it from this tab until a load that
 * read it puts its records on screen (markOfflineCopyRead), because a file
 * built without it has no Protected Identity or Answer Bank, and those exist
 * nowhere else. A read that gets through does not clear the mark: `receipt`
 * (an object, optional) is told whether it did (`read`) and given the token
 * the load passes to markOfflineCopyRead.
 *
 * Sanitised BEFORE it is returned, not only on disk. A blob written by an
 * older build can still hold the lock code and the AI keys inside settings,
 * and this function has callers besides loadData; handing them the raw blob
 * put the secret straight back into the object the app renders, saves and
 * exports from, whatever the disk copy had been rewritten to say. The disk
 * copy is rewritten here too, so the next read has nothing to strip.
 */
// The copy each read that got through took (its write stamp and device-only
// sections), by the read's token: what a save of that text rewritten
// (readToken) is based on (saveText).
const readCopies = new WeakMap();
export async function readCachedData(userId, receipt = null) {
  const key = scopedKey(BASE_KEYS.data, userId);
  const read = receipt && typeof receipt === "object" ? receipt : {};
  read.read = false; read.token = null;
  if (!key) return null;
  try { await hydrateOfflineStores(userId); } catch { /* the stores stay where they are */ }
  try {
    const found = await readOfflineFile(userId, read);
    // That read gives a failed IndexedDB open a second try. When it opened,
    // the transcript and archives the hydration above could not read are
    // read now, before anything renders (a no-op once they all were).
    if (read.read) { try { await hydrateOfflineStores(userId); } catch { /* next call */ } }
    if (!found) {
      storedText.delete(key);
      read.sections = deviceOnlySectionsOf(null);
      // Device-only changes held aside (a save that landed nowhere) are all
      // there is of those sections: the file is gone or was never written.
      const held = heldDeviceOnlyChanges(userId);
      if (!held || sameDeviceOnlySections(withHeldDeviceOnlyChanges(userId, read.sections), read.sections)) return null;
      return withDefaults({ ...withHeldDeviceOnlyChanges(userId, read.sections) });
    }
    // Trusted: this is the key scoped to THIS user, so a lock code in it is
    // this account's own and may be recovered into the device slot before it
    // is deleted. That recovery is what keeps the encrypted portal passwords
    // readable.
    const { blob, changed } = sanitizeCachedBlob(JSON.parse(found.text), userId, { trusted: true });
    // The device-only sections as stored: what a load that shows this read
    // adopts as the copy its records are based on (adoptOfflineCopyRead).
    read.sections = deviceOnlySectionsOf(blob);
    if (read.read && read.token) readCopies.set(read.token, { stamp: read.stamp ?? null, sections: read.sections });
    if (!changed) storedText.set(key, { text: found.text, current: localWriteGuard(userId, { adopted: false }) });
    if (changed) {
      const text = JSON.stringify(blob);
      if (found.where === "local") {
        // Put back where it was read, as this build's own copy: it holds
        // what the IndexedDB copy held too (storageScope.js readOfflineText).
        writeOwnLocalCopy(key, text);
      } else {
        // The stored copy itself, cleaned: written even while an earlier
        // load's unread mark stands (readToken).
        try { await writeOfflineText(key, text, localWriteGuard(userId, { adopted: false }), { readToken: read.token }); } catch { /* unavailable */ }
      }
    }
    // Protected Identity and Answer Bank changes a save could not store (a
    // session that ended, a store that would not open), laid over the read:
    // shown and saved with the rest by the load that reads them.
    const withHeld = withHeldDeviceOnlyChanges(userId, read.sections);
    if (!sameDeviceOnlySections(withHeld, read.sections)) return withDefaults({ ...blob, ...withHeld });
    return withDefaults(blob);
  } catch { /* corrupt or unavailable */ }
  return null;
}

// ─── What this tab knows of the stored copy ──────────────────
// Per key: the write stamp of the copy this tab last read (and a load put on
// screen) or wrote (storageScope.js OFFLINE_WRITTEN_BASE), the device-only
// sections the records in memory are based on (`base`), and whether the
// stored copy holds rows those records lack (`divergent`: a write that kept
// another tab's rows the screen does not show). With the stamp unchanged and
// nothing divergent, the records in memory hold at least what is stored of
// Protected Identity and the Answer Bank; otherwise another tab has written
// since, and a save keeps what it wrote (saveText's merge).
const knownCopies = new Map();

/** What this tab knows of `userId`'s stored copy ({ stamp, base, divergent }), or null. */
export function knownOfflineCopy(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  return key ? knownCopies.get(key) || null : null;
}

/**
 * Nothing but this tab has written `userId`'s offline file since this tab
 * last read or wrote it, and the stored copy holds no device-only row the
 * records in memory lack: those records are the newer copy of Protected
 * Identity and the Answer Bank.
 */
export function offlineCopyUnchangedSinceKnown(userId) {
  const known = knownOfflineCopy(userId);
  return !!known && !known.divergent && offlineWriteStamp(userId) === known.stamp;
}

/**
 * A load put on screen records built from the read `receipt` came from
 * (readCachedData): the stored copy's device-only sections as read are what
 * those records are based on. A read that could not look changes nothing.
 */
export function adoptOfflineCopyRead(userId, receipt) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key && receipt && receipt.read !== true && !receipt.held) {
    // The records now on screen were built without the stored copy (its read
    // failed, and the screen held nothing of it): device-only changes kept
    // "memory" only, and the copy the old screen was based on, describe a
    // screen that is gone. Kept, a later load took these records for that
    // screen and wrote their empty Protected Identity and Answer Bank over
    // the only copy (AppContext beginLoadOver).
    knownCopies.delete(key);
    if (deviceOnlyUnsaved.get(userId) === "memory") setDeviceOnlyUnsaved(userId, null);
    return false;
  }
  if (!key || receipt?.read !== true || !receipt.sections) return false;
  knownCopies.set(key, { stamp: receipt.stamp ?? null, base: receipt.sections, divergent: false });
  return true;
}

/**
 * The device-only sections a load shows when the screen already held this
 * account's records from a read that got through (AppContext): `screen`'s
 * when nothing else has written the stored copy since (they are the newer
 * copy, whether or not this read got through); otherwise what changed on
 * screen since the copy they are based on, laid over `read`'s sections.
 * null when neither applies (the read's sections stand).
 */
export function deviceOnlyForLoad(userId, screen, read, readOk) {
  adoptReleasedHold(userId);
  if (offlineCopyUnchangedSinceKnown(userId)) return deviceOnlySectionsOf(screen);
  if (!readOk) {
    // Another tab wrote since, and this read could not look: the copy stays
    // unread and nothing is saved over it, so the changes on screen since
    // the copy they are based on are held aside until a read gets through.
    const key = scopedKey(BASE_KEYS.data, userId);
    holdUnsavedDeviceOnly(userId, key ? knownCopies.get(key) || null : null, deviceOnlySectionsOf(screen));
    return deviceOnlySectionsOf(screen);
  }
  const known = knownOfflineCopy(userId);
  return known ? rebaseDeviceOnlySections(read, known.base, screen) : null;
}

/**
 * Sweep BOTH on-device stores: migrate this account's own device fields into
 * the device slot, then scrub them out of the stored copies.
 *
 * Two things were wrong before this existed, and each loses something real.
 *
 * ORDER. readCachedData scrubbed, and loadDeviceKeys' one-time adoption then
 * found an already-cleaned blob, so an account whose keys lived only in a
 * pre-slot cache lost all four device fields. sanitizeCachedBlob now migrates
 * a TRUSTED blob before it strips it, which is why the sweep can run first.
 *
 * REACH. The scrub only ever rewrote localStorage. On a native build the
 * Capacitor copy is the one that survives a browser-storage clear, and a
 * localStorage-first load returned early and never looked at it, so the old
 * lock code and keys sat there until some later save happened to overwrite
 * them. Both stores are swept here, on every load, whichever one answers
 * first.
 */
async function sweepStores(userId, key) {
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), userId, { trusted: true });
      if (changed) rewriteLocalCopy(key, raw, JSON.stringify(blob));
    }
  } catch { /* corrupt, or storage unavailable */ }

  try {
    if (window.storage?.get) {
      const r = await window.storage.get(key);
      if (r?.value) {
        const { blob, changed } = sanitizeCachedBlob(JSON.parse(r.value), userId, { trusted: true });
        if (changed) await window.storage.set(key, JSON.stringify(blob));
      }
    }
  } catch { /* unavailable */ }

  // The un-namespaced pre-namespace blob, stripped and NEVER trusted. On a
  // shared device it can belong to whoever used the machine before, so nothing
  // in it is adopted; it is cleaned so the material stops sitting on the disk.
  // This used to happen only as a side effect of loadDeviceKeys, which
  // loadData does not reach when this account has no cache of its own, so a
  // colleague's old keys could sit there untouched through every load.
  try {
    const raw = localStorage.getItem(BASE_KEYS.data);
    if (raw) {
      const { blob, changed } = sanitizeCachedBlob(JSON.parse(raw), userId, { trusted: false });
      if (changed) localStorage.setItem(BASE_KEYS.data, JSON.stringify(blob));
    }
  } catch { /* corrupt, or storage unavailable */ }
}

// loadData only loads from the device (IndexedDB, localStorage, Capacitor:
// the offline fallback), always under the signed-in user's own key. Supabase
// loading is handled in AppContext after auth resolves. `receipt`: as for
// readCachedData, for the load to pass to markOfflineCopyRead.
export async function loadData(userId, receipt = null) {
  // First, and on every load: the sweep is what migrates a legacy cache into
  // the device slot, and it has to happen before anything reads either store.
  await sweepStores(userId, scopedKey(BASE_KEYS.data, userId));

  const read = receipt && typeof receipt === "object" ? receipt : {};
  const local = await readCachedData(userId, read);
  if (local) return applyDefaults(applyDeviceKeys(local, userId));

  // Fallback to Capacitor storage. sweepStores above has already migrated and
  // scrubbed this copy, so what comes back here is clean; it is sanitised
  // again on the way through because this function must not depend on the
  // sweep having succeeded to be safe.
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key) {
    try {
      if (window.storage?.get) {
        const r = await window.storage.get(key);
        if (r?.value) {
          const { blob, changed } = sanitizeCachedBlob(JSON.parse(r.value), userId, { trusted: true });
          const text = changed ? JSON.stringify(blob) : r.value;
          // Into IndexedDB only when the read above found nothing there
          // (readToken). When it could not look, the unread mark refuses it:
          // the native copy may be older than the one it could not read.
          try { await writeOfflineText(key, text, localWriteGuard(userId, { adopted: false }), { readToken: read.token }); } catch { /* unavailable */ }
          if (changed) {
            try { await window.storage.set(key, text); } catch { /* unavailable */ }
          }
          return applyDefaults(applyDeviceKeys(withDefaults(blob), userId));
        }
      }
    } catch { /* unavailable */ }
  }

  return { ...DEFAULT_DATA };
}

// Whether this device's offline copy is older than what is on screen, and
// why: "full" (IndexedDB refused the last cache write for want of space),
// "unavailable" (IndexedDB would not open or lost its connection, and
// localStorage could not take the file either), or "unread" (this load could
// not read the stored copy, so nothing is saved over it). A physician who
// opens the app offline would see the older copy without being told;
// AppContext shows it (SyncIssuesNotice). null when the copy is current.
//
// "Really stale" only: a refused write whose text the stored copy already
// holds (the load's own save of an unchanged file) leaves nothing stale, and
// the latest write decides, so an older write refused after a newer one
// landed never raises it.
let cacheStale = null;
let cacheStaleOwner = null;        // the account whose copy cacheStale is about
const cacheListeners = new Set();
/** `listener(reason)` whenever the reason changes (null once current again). */
export function onCacheFullChange(listener) {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}
/** Why the offline copy is older than the screen, or null. */
export function cacheStaleReason() { return cacheStale; }
/** The offline copy is stale because the device is out of space. */
export function isCacheFull() { return cacheStale === "full"; }
function setCacheStale(next, owner = null) {
  cacheStaleOwner = next ? owner : null;
  if (cacheStale === next) return;
  cacheStale = next;
  for (const listener of cacheListeners) { try { listener(next); } catch { /* a listener must not stop a save */ } }
}

/**
 * Why a change to Protected Identity or the Answer Bank (DEVICE_ONLY_SECTIONS)
 * made now would be saved nowhere, or null when it would be saved. Those
 * sections have no cloud copy: a change the offline copy does not take exists
 * only in memory and is gone at the next launch. "unread": this session's
 * records were built without the stored copy (offlineCopyUnread). "full" or
 * "unavailable": the latest save of this account's copy was taken by no store
 * (cacheStaleReason). AppContext refuses the change and says why, and asks for
 * the refused save to be made again (retryOfflineSave), so a store that
 * answers again takes the next try. A save refused only for the unread mark
 * blocks nothing once a load has read the copy and cleared it.
 */
export function deviceOnlySaveBlocked(userId) {
  if (!userId) return null;
  if (offlineCopyUnread(userId)) return "unread";
  const stale = cacheStale && cacheStaleOwner === userId ? cacheStale : null;
  return stale === "unread" ? null : stale;
}

// The text each key's stored copy holds, as far as this tab knows (what the
// load read, or this tab's last landed write), for as long as no purge has
// touched the copy since. Compared only when a write is refused: the same
// text means nothing on screen is missing offline.
const storedText = new Map();
function storedCopyIs(key, text) {
  const known = storedText.get(key);
  return !!known && known.current() && known.text === text;
}
const latestSave = new Map();
let saveCounter = 0;
// The latest save of each key that no store took (saveData), with the guard
// it was made under: retryOfflineSave makes it again.
const refusedSaves = new Map();    // key -> { payload, guard, seq, userId }

// Save the offline copy (Supabase writes happen per-operation in AppContext).
// IndexedDB first, localStorage when IndexedDB is unavailable or refuses, and
// the Capacitor store on a native build. `userId` is the Clerk id the data
// belongs to; with none there is nowhere safe to put it, so nothing is
// written.
export async function saveData(data, userId, how = {}) {
  const key = scopedKey(BASE_KEYS.data, userId);
  if (!key) return false;
  // Records this tab loaded before this device purged the account's copy (a
  // data deletion) never go back into the cache: the next load's self-heal
  // push would send them up again. See LOCAL_FENCE_KEY in storageScope.js.
  // Checked again immediately before each store commits (localWriteGuard).
  if (!localCopyCurrent(userId)) return false;
  // Keep the cached blob small and secret-free:
  //  - document bytes are re-fetched from Storage on demand, so drop them once
  //    a doc is safely uploaded (a doc with no storagePath still holds its only
  //    copy in `data`, so that one is kept — never evict the last copy);
  //  - device-only material never goes in this blob at all: the AI keys and the
  //    CallSync feed token, because a stray copy here could be adopted
  //    cross-account off a shared device, AND the lock code that opens the
  //    encrypted portal passwords, which used to be cached beside the very
  //    ciphertext it decrypts. One list (EXPORT_REDACT_FIELDS in
  //    src/lib/supabase.js) decides all of it, for the cache and the export
  //    alike; this used to strip DEVICE_KEY_FIELDS only, which is that list
  //    minus the lock code.
  const slimSettings = { ...(data.settings || {}) };
  for (const f of EXPORT_REDACT_FIELDS) delete slimSettings[f];
  const slim = {
    ...data,
    settings: slimSettings,
    documents: (data.documents || []).map((d) =>
      d && d.data && d.storagePath ? { ...d, data: undefined } : d
    ),
  };
  const json = JSON.stringify(slim, cacheReplacer);
  return saveText(key, userId, { json, slim, mine: deviceOnlySectionsOf(slim) }, localWriteGuard(userId), how);
}

// Don't cache internal userId.
function cacheReplacer(k, value) { return k === "_userId" ? undefined : value; }

// One save of the offline copy's text (saveData, retryOfflineSave). `guard`:
// the write guard the text was first saved under, so a purge since then
// stops a save made again. `payload`: { json, slim, mine } (the text, the
// records it was made from, and their device-only sections).
//
// When another tab has written the stored copy since this tab last read or
// wrote it (the write stamp moved), or the stored copy holds device-only rows
// the records here lack, the write reads the stored copy and keeps them in
// the same transaction: what changed here since the copy these records are
// based on is laid over it (a row the other tab added stays, a row deleted
// here stays deleted). Whole-file last-writer-wins used to drop a Protected
// Identity row another window had saved.
//
// One at a time per key in this window: a save begins once the one before it
// has settled, and takes the copy its records are based on from there. Begun
// while the one before was still committing, it took that save's own write
// for another writer's and merged with it, so a row deleted (or an edit
// undone) meanwhile was written back and stayed.
const saveQueue = new Map();       // key -> the last save begun, settled
//
// What a save waiting its turn needs of the moment it was made is taken then,
// with its guard: the purge generation (a save stopped by another account's
// purge is made again only when nothing but that purge came between), and,
// for the stored copy rewritten (readToken), the copy its text was read from.
// Taken when the save began running, a purge while it waited looked like none
// and the stopped save was dropped; and a screen save that landed after the
// read looked like the copy the text was based on, so the older text was
// written over it.
function saveText(key, userId, payload, guard, how = {}) {
  const seq = beginSave(key, userId, payload);
  const stopSnapshot = saveStopGuard(userId);
  const readFrom = how.readToken ? readCopies.get(how.readToken) || null : null;
  const before = saveQueue.get(key);
  const now = () => saveTextNow(key, userId, payload, guard, how, seq, stopSnapshot, readFrom);
  const run = before ? before.then(now) : now();
  const settled = run.then(() => {}, () => {});
  saveQueue.set(key, settled);
  settled.then(() => { if (saveQueue.get(key) === settled) saveQueue.delete(key); });
  return run;
}
function beginSave(key, userId, payload) {
  const seq = ++saveCounter;
  latestSave.set(key, seq);
  inFlightSaves.set(key, { payload, seq, userId });
  return seq;
}
async function saveTextNow(key, userId, payload, guard, how, seq, stopSnapshot, readFrom = null) {
  const { json, slim, mine } = payload;
  adoptReleasedHold(userId);
  const prior = knownCopies.get(key) || null;
  const fromStored = !!how.readToken;
  // The copy the text is based on: for the stored copy rewritten, the read it
  // came from; otherwise the copy the records in memory are based on. Any
  // write since that read, this window's own saves included (writtenSince
  // passes over those), is merged with: the text predates it.
  const basis = fromStored && readFrom
    ? { stamp: readFrom.stamp, base: readFrom.sections, divergent: offlineWriteStamp(userId) !== readFrom.stamp }
    : prior;
  let mergedSections = null;
  // Made only when another tab has written since (the stamp moved from the
  // one `prior` holds) or the copy is divergent, decided as the write's
  // transaction is created (storageScope.js putOffline), never here: a save
  // that began before another window's commit and was created after it
  // wrote over the rows that window had just stored.
  const merge = basis && slim
    ? (theirsText) => {
      let theirs;
      try { theirs = JSON.parse(theirsText); } catch { return undefined; }
      const sections = rebaseDeviceOnlySections(theirs, basis.base, mine);
      if (sameDeviceOnlySections(sections, mine)) return undefined;
      mergedSections = sections;
      return JSON.stringify({ ...slim, ...sections }, cacheReplacer);
    }
    : null;
  let result;
  try { result = await writeOfflineText(key, json, guard, { readToken: how.readToken, merge, knownStamp: basis?.stamp ?? null, mergeAlways: !!basis?.divergent }); }
  finally { if (inFlightSaves.get(key)?.seq === seq) inFlightSaves.delete(key); }
  let saved = result.saved;
  if (result.stopped) {
    // Stopped only because another account on this device was purged (the
    // purge generation is one for the device): nothing of this account
    // changed, so the save is made again under a fresh guard. Never after a
    // purge of this account, here or in another tab.
    if (!how.again && latestSave.get(key) === seq && stopSnapshot.otherAccountOnly()) {
      return saveTextNow(key, userId, payload, localWriteGuard(userId), { ...how, again: true }, beginSave(key, userId, payload), saveStopGuard(userId), readFrom);
    }
    if (latestSave.get(key) === seq) refusedSaves.delete(key);
    return false;
  }
  // Built without the stored copy it could not read: not written over the
  // native copy either.
  const unread = result.refused.includes("indexeddb_unread");
  try {
    if (!unread && window.storage?.set && guard()) {
      await window.storage.set(key, json);
      saved = true;
    }
  } catch { /* unavailable */ }
  const kind = result.refused.length ? storageRefusalKind(result.refused) : null;
  if (kind === "full" || (!result.saved && kind)) {
    console.warn(`CredentialDOMD: the offline copy was not updated (${result.refused.join(",")}).`);
    reportStorageRefusal({ store: "cache", reason: result.refused.join(","), chars: result.chars });
  }
  if (result.saved) {
    const final = mergedSections && result.text !== json ? mergedSections : mine;
    storedText.set(key, { text: result.text ?? json, current: localWriteGuard(userId, { adopted: false }) });
    // The copy just written. From the records in memory (saveData): they are
    // its base, unless it kept rows they lack (the merge). The stored copy
    // itself, rewritten (readToken): the records in memory are still based on
    // what they were, and the copy may hold more.
    const base = fromStored ? (prior ? prior.base : final) : (final === mine ? mine : prior?.base ?? mine);
    const divergent = fromStored ? (prior ? prior.divergent || !sameDeviceOnlySections(final, prior.base) : false) : final !== mine;
    knownCopies.set(key, { stamp: result.stamp ?? null, base, divergent });
    if (releaseHeldDeviceOnlyChanges(userId, final)) setDeviceOnlyUnsaved(userId, null);
  }
  if (latestSave.get(key) === seq) {
    const stale = !saved && kind && !storedCopyIs(key, json) ? kind : null;
    if (stale && stale !== "unread") refusedSaves.set(key, { payload, guard, seq, userId });
    else refusedSaves.delete(key);
    setCacheStale(stale, userId);
    // A Protected Identity or Answer Bank change that is in no store now is
    // held aside, per account, in localStorage (storageScope.js
    // DEVICE_ONLY_PENDING_BASE): small where the file is not, and read back
    // over the file by every load until a write that holds it lands.
    // Not for a save refused because the copy is unread: records built
    // without the file are no change to it (a load that keeps what was on
    // screen over a read that failed holds its changes itself,
    // deviceOnlyForLoad).
    if (stale && stale !== "unread" && !fromStored) holdUnsavedDeviceOnly(userId, prior, mine);
  }
  return saved;
}

// Saves of the file begun and not finished, per key: what a session-end
// trim holds aside before it cancels them (setBeforeDeviceOnlyTrim).
const inFlightSaves = new Map();
function holdUnsavedDeviceOnly(userId, prior, mine) {
  if (adoptReleasedHold(userId)) prior = knownCopies.get(scopedKey(BASE_KEYS.data, userId)) || prior;
  if (!prior || !mine) return;
  // No change from the copy these records are based on: nothing to hold,
  // but a change this window held earlier and has undone since goes.
  if (sameDeviceOnlySections(prior.base, mine)) {
    if (holdsDeviceOnlyChangesHere(userId) && holdDeviceOnlyChanges(userId, prior.base, mine) && !holdsDeviceOnlyChangesHere(userId)) {
      setDeviceOnlyUnsaved(userId, null);
    }
    return;
  }
  setDeviceOnlyUnsaved(userId, holdDeviceOnlyChanges(userId, prior.base, mine) ? "held" : "memory");
}
setBeforeDeviceOnlyTrim((userId) => {
  const key = scopedKey(BASE_KEYS.data, userId);
  const pending = key ? (inFlightSaves.get(key) || refusedSaves.get(key)) : null;
  if (pending?.payload) holdUnsavedDeviceOnly(userId, knownCopies.get(key) || null, pending.payload.mine);
});

// This window's hold, carried into the file by another window's write since
// (storageScope.js takeReleasedHoldHere): the copy this window's records are
// based on holds it now. Left on the older copy, the next save or hold here
// replayed the held change over the file, and a row the member deleted (or
// restored) in the other window since came back (or went again).
function adoptReleasedHold(userId) {
  const hold = takeReleasedHoldHere(userId);
  const key = scopedKey(BASE_KEYS.data, userId);
  const known = key ? knownCopies.get(key) : null;
  if (!hold || !known) return false;
  knownCopies.set(key, { ...known, base: rebaseDeviceOnlySections(known.base, hold.base, hold.mine) });
  if (deviceOnlyUnsaved.get(userId) === "held" && !holdsDeviceOnlyChangesHere(userId)) setDeviceOnlyUnsaved(userId, null);
  return true;
}

// Device-only changes that are in no copy of the file: "held" (kept aside in
// localStorage until a write takes them), "memory" (not even that: they are
// on screen only). Per account, for SyncIssuesNotice.
const deviceOnlyUnsaved = new Map();
const deviceOnlyListeners = new Set();
function setDeviceOnlyUnsaved(userId, state) {
  if (!userId) return;
  if (state) deviceOnlyUnsaved.set(userId, state); else deviceOnlyUnsaved.delete(userId);
  for (const listener of deviceOnlyListeners) { try { listener(userId, state ?? null); } catch { /* a listener must not stop a save */ } }
}
/** "held", "memory" or null: device-only changes of `userId` that are in no copy of the file. */
export function deviceOnlyUnsavedState(userId) {
  if (!userId) return null;
  return deviceOnlyUnsaved.get(userId) ?? (heldDeviceOnlyChanges(userId) ? "held" : null);
}
/** `listener(userId, state)` whenever deviceOnlyUnsavedState changes. */
export function onDeviceOnlyUnsavedChange(listener) {
  deviceOnlyListeners.add(listener);
  return () => deviceOnlyListeners.delete(listener);
}

/**
 * Make the latest refused save of `userId`'s offline copy again, when no
 * newer save has begun since, no purge has touched the copy since (the guard
 * it was made under), and the copy is not unread. Resolves whether it landed.
 * A device-only change refused because the last save did not land
 * (deviceOnlySaveBlocked) asks for this, so a store that answers again (an
 * IndexedDB open that failed at launch) takes the copy, and the change can be
 * made on the next try.
 */
export async function retryOfflineSave(userId) {
  const key = scopedKey(BASE_KEYS.data, userId);
  const last = key ? refusedSaves.get(key) : null;
  if (!last || last.userId !== userId || latestSave.get(key) !== last.seq) return false;
  if (getActiveUserId() !== userId || offlineCopyUnread(userId) || !last.guard()) return false;
  return saveText(key, userId, last.payload, last.guard);
}

/**
 * Sign-out purge. Everything this user kept on the device (the file, the
 * private vault, the Assistant transcript and archives, the live timer, the
 * offline identity slot, the AI keys and lock code) goes, so the next person
 * to sign in on a shared device inherits nothing.
 */
export async function clearLocalData(userId) {
  await purgeForSignOut(userId);
  const key = scopedKey(BASE_KEYS.data, userId);
  if (key) { storedText.delete(key); latestSave.delete(key); refusedSaves.delete(key); knownCopies.delete(key); inFlightSaves.delete(key); }
  setDeviceOnlyUnsaved(userId, null);
  setCacheStale(null);
}
