// What the app keeps on the device, read the way the app reads it. The
// offline copy of the file, the Assistant transcript and its archives live in
// IndexedDB (database "credentialdomd-offline", store "kv", keyed by the same
// scoped key localStorage used), and a landed IndexedDB write removes the
// localStorage copy. A journey that reads `localStorage` alone finds nothing
// there and fails for a copy that is fine, or scans nothing and passes. These
// helpers read localStorage first and IndexedDB behind it, as
// src/utils/storageScope.js readOfflineText does.
//
// The *InPage functions run inside the page (page.evaluate): each one is
// self-contained, with no closure over this module. Synthetic data only.

/** In the page: the stored text for `key` (localStorage first, then IndexedDB), or null. */
export async function readDeviceTextInPage(key) {
  const local = localStorage.getItem(key);
  if (local != null) return local;
  if (typeof indexedDB === 'undefined' || !indexedDB) return null;
  const db = await new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('credentialdomd-offline', 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch { /* exists */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains('kv')) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get(key);
      tx.oncomplete = () => resolve(typeof get.result === 'string' ? get.result : null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } finally { try { db.close(); } catch { /* closed */ } }
}

/**
 * In the page: store `text` under `key` where the app keeps it (IndexedDB,
 * with its home record, and no localStorage copy standing over it). Lab setup
 * only: the app is reloaded after.
 */
export async function writeDeviceTextInPage([key, text]) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('credentialdomd-offline', 1);
    req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch { /* exists */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB would not open'));
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(text, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
  } finally { try { db.close(); } catch { /* closed */ } }
  const owner = key.slice(key.indexOf(':') + 1);
  localStorage.setItem(`credentialdomd-offline-home:${owner}`, '1');
  localStorage.removeItem(key);
  return true;
}

/**
 * In the page: every stored entry whose value contains one of `needles`:
 * localStorage keys as they are, IndexedDB keys as "indexeddb:<key>".
 */
export async function scanDeviceInPage(needles) {
  const hits = (value) => typeof value === 'string' && needles.some((n) => value.includes(n));
  const found = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k != null && hits(localStorage.getItem(k))) found.push(k);
  }
  if (typeof indexedDB === 'undefined' || !indexedDB) return found;
  const db = await new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('credentialdomd-offline', 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch { /* exists */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return found;
  try {
    if (!db.objectStoreNames.contains('kv')) return found;
    const entries = await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const keys = store.getAllKeys();
      const values = store.getAll();
      tx.oncomplete = () => resolve((keys.result || []).map((k, i) => [k, (values.result || [])[i]]));
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    });
    return [...found, ...entries.filter(([, v]) => hits(v)).map(([k]) => `indexeddb:${k}`)];
  } finally { try { db.close(); } catch { /* closed */ } }
}

/** In the page: the keys in the app's IndexedDB store that name `id`. */
export async function deviceStoreKeysInPage(id) {
  if (typeof indexedDB === 'undefined' || !indexedDB) return [];
  const db = await new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('credentialdomd-offline', 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('kv'); } catch { /* exists */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains('kv')) return [];
    const keys = await new Promise((resolve) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').getAllKeys();
      tx.oncomplete = () => resolve(req.result || []);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    });
    return keys.map(String).filter((k) => k.includes(id));
  } finally { try { db.close(); } catch { /* closed */ } }
}

/** The stored text for `key` on this page's device (localStorage first, then IndexedDB). */
export const readDeviceText = (page, key) => page.evaluate(readDeviceTextInPage, key);
/** The stored file for `key`, parsed ({} when there is none or it does not parse), and its size in chars. */
export async function readDeviceJSON(page, key) {
  const text = await readDeviceText(page, key);
  try { return { value: JSON.parse(text || '{}'), size: (text || '').length }; } catch { return { value: {}, size: (text || '').length }; }
}
/** Lab setup: put `text` under `key` where the app keeps it. */
export const writeDeviceText = (page, key, text) => page.evaluate(writeDeviceTextInPage, [key, text]);
/** Keys (localStorage, and "indexeddb:<key>") whose value holds any of `needles`. */
export const scanDevice = (page, needles) => page.evaluate(scanDeviceInPage, needles);
/** The app's IndexedDB keys that name account `id`. */
export const deviceStoreKeys = (page, id) => page.evaluate(deviceStoreKeysInPage, id);
