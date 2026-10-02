/**
 * Where the Work tab's running timer is kept on this device.
 *
 * The timer lived only in localStorage, and a save refused for want of space
 * was ignored: on a phone with localStorage nearly full, a call timed while
 * the Phone app was in front was gone when iOS discarded the page, with no
 * word at any point (QA lab, WebKit + the iOS model, 2026-10-01). Now a
 * refused save is kept in this tab's sessionStorage, which has its own quota
 * and survives the page being discarded and reloaded, and the caller is told
 * (`saveRunningTimer` answers where it went) so the screen can say so as the
 * timer starts. Sign out and Delete All My Data remove both copies
 * (storageScope.js purgeUserStorage).
 */
// (Imported as ../utils/storageScope so the screen tests' device fixture, which
// stands in for utils/storageScope, stands in here too.)
import { BASE_KEYS, lsGetJSON, lsSetJSON, lsRemove, scopedKey, localCopyCurrent, getActiveUserId } from "../utils/storageScope.js";

const tabStore = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
const tabKey = () => { try { return scopedKey(BASE_KEYS.timer) || null; } catch { return null; } };

function dropTabCopy() {
  const k = tabKey(), s = tabStore();
  try { if (k && s) s.removeItem(k); } catch { /* unavailable */ }
}

function readTabCopy() {
  const k = tabKey(), s = tabStore();
  try { const raw = k && s ? s.getItem(k) : null; return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/**
 * The running timer: this tab's copy when there is one, else this device's.
 * A tab copy is written only when the device refused a save, and every save
 * the device takes removes it, so it is the newer of the two. The device copy
 * read first won with the timer as it was before the device filled up: the
 * billing and private notes typed during the call after that were lost
 * (review of 9484782c).
 */
export function loadRunningTimer() {
  const tab = readTabCopy();
  if (tab) return tab;
  try { return lsGetJSON(BASE_KEYS.timer) || null; } catch { return null; }
}

/** True when this device's copy holds the same timer (its start time) as `t`. */
export function timerStartKept(t) {
  try { return !!t?.startedAt && lsGetJSON(BASE_KEYS.timer)?.startedAt === t.startedAt; } catch { return false; }
}

/**
 * Keep `t` (or remove it, for null). "device" when localStorage took it,
 * "tab" when only this tab's sessionStorage could, false when neither did
 * (or this tab's records predate a purge, which keeps nothing).
 */
export function saveRunningTimer(t) {
  if (!t) {
    try { lsRemove(BASE_KEYS.timer); } catch { /* unavailable */ }
    dropTabCopy();
    return "device";
  }
  let kept = false;
  try { kept = lsSetJSON(BASE_KEYS.timer, t) !== false; } catch { kept = false; }
  if (kept) { dropTabCopy(); return "device"; }
  let current = false;
  try { current = localCopyCurrent(getActiveUserId()); } catch { current = false; }
  if (!current) return false;
  const k = tabKey(), s = tabStore();
  try { if (k && s) { s.setItem(k, JSON.stringify(t)); return "tab"; } } catch { /* full too */ }
  return false;
}

/**
 * What the Work tab says when the timer could not be kept on the device.
 * `startKept`: the device still holds this timer as it started (a later save,
 * with notes, was the one refused): the start time is safe, the notes are not.
 */
export function timerNotKeptNotice(where, startedAt, { startKept = false } = {}) {
  const at = (() => { try { return new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; } })();
  const start = at ? ` It started at ${at}.` : "";
  // What is true and what he can do: the app's own storage refused the save
  // (the phone itself may have plenty of room), and nothing under More frees
  // it, so neither is said (2026-10-02).
  if (where === "tab" && startKept) {
    return `The app could not save the notes on this timer on this phone, so they are kept only while the app stays open in this window. Its start time is saved.${start}`;
  }
  return where === "tab"
    ? `The app could not save this timer on this phone, so it is kept only while the app stays open in this window. If iOS closes the app, use Log past time with the start time.${start}`
    : `The app could not save this timer on this phone. Note the start time and use Log past time when the call ends.${start}`;
}
