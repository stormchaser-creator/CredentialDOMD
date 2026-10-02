/**
 * What was typed into a form not yet saved, kept per account so it outlives
 * iOS discarding the installed app while he is in another one (QA lab, WebKit
 * + the iOS model, 2026-10-01: a license, a health record, a Log past time
 * entry and a lead time were all gone on return, the form closed). The
 * support text drafts (supportTextDrafts.js) already worked this way.
 *
 * In localStorage under the account (BASE_KEYS.formDrafts), so a cold
 * relaunch finds it too, or in this tab's sessionStorage when localStorage
 * is full. One draft per form (`slot`), dropped after a day. Never kept:
 * secrets (a portal password before it is encrypted), file contents (data:
 * URLs), or anything that is not plain text, numbers or booleans. Sign out
 * and Delete All My Data remove them (storageScope.js purgeUserStorage).
 */
// (Imported as ../utils/storageScope so the screen tests' device fixture, which
// stands in for utils/storageScope, stands in here too.)
import { BASE_KEYS, lsGetJSON, lsSetJSON, scopedKey, localCopyCurrent, getActiveUserId } from "../utils/storageScope.js";

export const FORM_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SLOTS = 20;
const MAX_TEXT = 20000;
const SECRET_KEY = /password|passcode|secret|ssn|social.?security|lock.?code|\bpin\b/i;

const tabStore = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
const tabKey = () => { try { return scopedKey(BASE_KEYS.formDrafts) || null; } catch { return null; } };

function readTab() {
  const k = tabKey(), s = tabStore();
  try { const raw = k && s ? s.getItem(k) : null; const v = raw ? JSON.parse(raw) : null; return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function readAll() {
  let local = {};
  try { const v = lsGetJSON(BASE_KEYS.formDrafts); if (v && typeof v === "object") local = v; } catch { /* none */ }
  // The newer of the two for each form.
  const out = { ...local };
  for (const [slot, d] of Object.entries(readTab())) if (!out[slot] || (d?.at || 0) > (out[slot]?.at || 0)) out[slot] = d;
  return out;
}
function writeAll(all) {
  const now = Date.now();
  const kept = Object.entries(all)
    .filter(([, d]) => d && now - (d.at || 0) < FORM_DRAFT_MAX_AGE_MS)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_SLOTS);
  const value = Object.fromEntries(kept);
  let local = false;
  try { local = lsSetJSON(BASE_KEYS.formDrafts, value) !== false; } catch { local = false; }
  const k = tabKey(), s = tabStore();
  if (local) { try { if (k && s) s.removeItem(k); } catch { /* none */ } return true; }
  let current = false;
  try { current = localCopyCurrent(getActiveUserId()); } catch { current = false; }
  if (!current || !k || !s) return false;
  try { s.setItem(k, JSON.stringify(value)); return true; } catch { return false; }
}

/** The plain values of a form worth keeping: no secrets, no files, no objects. */
export function draftableValues(values, { secretKeys = [] } = {}) {
  const out = {};
  for (const [key, v] of Object.entries(values || {})) {
    if (secretKeys.includes(key) || SECRET_KEY.test(key)) continue;
    if (typeof v === "string") { if (!v.startsWith("data:") && v.length <= MAX_TEXT) out[key] = v; }
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (Array.isArray(v) && v.every(x => typeof x === "string" && x.length <= 200)) out[key] = v.slice(0, 50);
  }
  return out;
}

// A value nothing was typed into: an untouched field reads as any of these
// (an Add form starts { topics: [] }, an edit form adds topics: [] to a
// record with none).
const blankValue = (v) => v == null || v === "" || v === false || (Array.isArray(v) && !v.length);
const sameValue = (a, b) => (blankValue(a) && blankValue(b)) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether two forms' plain values (draftableValues) say the same: a form
 * that still says what it opened with has nothing typed in it to keep.
 */
export function sameFormValues(a, b) {
  const x = a || {}, y = b || {};
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => sameValue(x[k], y[k]));
}

/** The draft kept for `slot`, or null. */
export function readFormDraft(slot) {
  if (!slot) return null;
  const d = readAll()[slot];
  if (!d || typeof d !== "object" || Date.now() - (d.at || 0) >= FORM_DRAFT_MAX_AGE_MS) return null;
  return d.value ?? null;
}

/** Keep `value` (plain JSON) as `slot`'s draft. True when some store took it. */
export function saveFormDraft(slot, value) {
  if (!slot) return false;
  const all = readAll();
  all[slot] = { value, at: Date.now() };
  return writeAll(all);
}

/** The form was saved, or cancelled: its draft goes. */
export function clearFormDraft(slot) {
  if (!slot) return;
  const all = readAll();
  if (!(slot in all)) return;
  delete all[slot];
  writeAll(all);
}

/** Every draft whose slot starts with `prefix`, newest first: [{ slot, value, at }]. */
export function listFormDrafts(prefix) {
  if (!prefix) return [];
  const now = Date.now();
  return Object.entries(readAll())
    .filter(([slot, d]) => slot.startsWith(prefix) && d && typeof d === "object" && now - (d.at || 0) < FORM_DRAFT_MAX_AGE_MS)
    .map(([slot, d]) => ({ slot, value: d.value ?? null, at: d.at || 0 }))
    .sort((a, b) => b.at - a.at);
}

// ─── Which page wrote a draft ───────────────────────────────────────────
// The owner keeps the app open in two desktop tabs at once, and a draft is
// in localStorage, which every tab of the account shares: a second tab that
// opened Licenses opened the first tab's unsaved Add form as "restored",
// though nothing had closed, and saving in both made two licenses (review of
// 9484782c). A draft names the page that wrote it (formDraftTab, kept in this
// tab's sessionStorage, so a reload is the same page), and a page asks
// whether the page that wrote one is still open (formDraftTabsAlive) before
// opening it. A page iOS discarded is not, so its draft opens on the next
// launch as before.
//
// Open is told by a Web Lock each page holds under its id while it lives
// (released when the page is closed or discarded, kept by a tab the browser
// froze), and where there are no Web Locks by a BroadcastChannel ping. Only
// the ping, a background tab Chrome froze answered nothing in 250 ms, and its
// open form was opened here too. A duplicated tab copies sessionStorage, so it
// started with the first tab's id and took that tab's open form for its own
// (review of 5cb89c90): a page whose stored id another open page holds takes a
// new one (formDraftTabReady) before it reads a draft.
const TAB_ID_KEY = "credentialdomd-tab-id";
const CHANNEL = "credentialdomd-form-drafts";
const LOCK_PREFIX = "credentialdomd-page:";
const PAGE = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const newTabId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
let thisTab = null;
let answering = null;
let claimed = null;
let settled = null;
const webLocks = () => { try { const l = globalThis.navigator?.locks; return l && typeof l.request === "function" ? l : null; } catch { return null; } };
function answerPings() {
  if (answering || typeof globalThis.BroadcastChannel !== "function") return;
  try {
    answering = new globalThis.BroadcastChannel(CHANNEL);
    answering.onmessage = (event) => {
      const ask = event?.data?.ask;
      if (!ask || ask !== thisTab || event.data.from === PAGE) return;
      try { answering.postMessage({ alive: thisTab, page: PAGE }); } catch { /* closed */ }
    };
    answering.unref?.();
  } catch { answering = null; }
}
/** This page's id, the one its drafts carry. */
export function formDraftTab() {
  if (!thisTab) {
    const s = tabStore();
    try { thisTab = s?.getItem(TAB_ID_KEY) || null; } catch { thisTab = null; }
    if (!thisTab) {
      thisTab = newTabId();
      try { s?.setItem(TAB_ID_KEY, thisTab); } catch { /* this page's memory only */ }
    }
  }
  answerPings();
  formDraftTabReady();
  return thisTab;
}
function takeNewTabId() {
  thisTab = newTabId();
  try { tabStore()?.setItem(TAB_ID_KEY, thisTab); } catch { /* this page's memory only */ }
}
// Hold `id`'s lock while this page lives. True when held, false when another
// open page holds it, null when it cannot be told.
function holdTabLock(id) {
  const locks = webLocks();
  if (!locks) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      locks.request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise(() => {}); // until the page goes
      }).catch(() => resolve(null));
    } catch { resolve(null); }
  });
}
// Another open page answering the ping for `id` (no Web Locks here).
function pingedOpen(id, waitMs) {
  if (typeof globalThis.BroadcastChannel !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    let channel = null, timer = null;
    const done = (open) => { clearTimeout(timer); try { channel?.close(); } catch { /* closed */ } resolve(open); };
    try {
      channel = new globalThis.BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => { if (event?.data?.alive === id && event.data.page !== PAGE) done(true); };
      channel.postMessage({ ask: id, from: PAGE });
    } catch { done(false); return; }
    timer = setTimeout(() => done(false), waitMs);
  });
}
/**
 * This page's id once no other open page holds it: a duplicated tab (which
 * copied this one's sessionStorage) takes a new one. Resolves to the id.
 */
export function formDraftTabReady({ waitMs = 250 } = {}) {
  if (claimed) return claimed;
  if (!thisTab) { formDraftTab(); return claimed; }
  claimed = (async () => {
    const held = await holdTabLock(thisTab);
    if (held === false) {
      takeNewTabId();
      await holdTabLock(thisTab);
    } else if (held === null && await pingedOpen(thisTab, waitMs)) {
      takeNewTabId();
    }
    settled = thisTab;
    return thisTab;
  })().catch(() => { settled = thisTab; return thisTab; });
  return claimed;
}
/** This page's id when formDraftTabReady has settled it, else null. */
export function formDraftTabSettled() { return settled; }
/** Of `tabs`, the ones another open page holds (or answers for within `waitMs`). */
export async function formDraftTabsAlive(tabs, { waitMs = 250 } = {}) {
  const mine = await formDraftTabReady({ waitMs });
  const asked = [...new Set((tabs || []).filter(tab => tab && tab !== mine))];
  if (!asked.length) return new Set();
  const locks = webLocks();
  if (locks && typeof locks.query === "function") {
    try {
      const state = await locks.query();
      const open = new Set((state?.held || []).map(one => one?.name).filter(name => typeof name === "string" && name.startsWith(LOCK_PREFIX)).map(name => name.slice(LOCK_PREFIX.length)));
      return new Set(asked.filter(tab => open.has(tab)));
    } catch { /* the ping below */ }
  }
  if (typeof globalThis.BroadcastChannel !== "function") return new Set();
  return new Promise((resolve) => {
    const alive = new Set();
    let channel = null, timer = null;
    const done = () => { clearTimeout(timer); try { channel?.close(); } catch { /* closed */ } resolve(alive); };
    try {
      channel = new globalThis.BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        const tab = event?.data?.alive;
        if (tab && event.data.page !== PAGE && asked.includes(tab)) { alive.add(tab); if (alive.size === asked.length) done(); }
      };
      for (const tab of asked) channel.postMessage({ ask: tab, from: PAGE });
    } catch { done(); return; }
    timer = setTimeout(done, waitMs);
  });
}

// ─── Which draft a records form opens with ──────────────────────────────
/**
 * The kept draft a screen's records form opens with, when the screen mounts
 * plainly: CrudSection, and the Credentials sections with a form of their own
 * (Health Records, Screenings, CME), which kept none until 2026-10-02 (QA lab
 * CRED-021: a health record half typed was gone after iOS discarded the app,
 * in both engines). Drafts are kept under `${base}|${target}|${page}`.
 *
 *  - `slotFor(editId)`: this page's slot for an Add (null) or an edit.
 *  - `records`: what the form edits; an edit draft opens on its own record.
 *  - `held`: the whole collection. A draft whose record is out of view stays
 *    for the screen that shows it; only one whose record is gone is dropped,
 *    and only once `recordsRead` (the cloud, or a device copy that was read):
 *    a launch on empty fallback records must not delete it.
 *  - `stillWanted()`: false once the screen opened something meanwhile (the
 *    checks for another open page wait).
 * A draft another open page is still typing in is never opened here.
 *
 * Answers { restore: { editing, changed } } (`changed`: what the draft
 * changed from the record it opened from, or the whole form for an Add),
 * { waiting: true } (a draft for a record not on screen yet: ask again when
 * the records come from a real read), { none: true } or { stopped: true }.
 * At once when no other page has to be asked (the form opens on the first
 * render, as it always did), otherwise as a promise.
 */
export function pickFormDraft(options) {
  const { base, stillWanted = () => true } = options;
  let mine = formDraftTab();
  const tabOf = (slot) => (slot.split("|")[2] || null);
  let drafts = (listFormDrafts(`${base}|`) || []).map(d => ({ ...d, tab: tabOf(d.slot) }));
  const legacy = readFormDraft(base);
  if (legacy) drafts.push({ slot: base, value: legacy, tab: null });
  drafts = drafts.filter(d => d.value && d.value.form && typeof d.value.form === "object" && Object.keys(d.value.form).length);
  if (!drafts.length) return { none: true };
  const othersThan = (id) => [...new Set(drafts.map(d => d.tab).filter(tab => tab && tab !== id))];
  // A draft under this page's id before the id is known to be this page's
  // alone: a duplicated tab starts with the first tab's id, and took its open
  // form for its own (formDraftTabReady).
  const claim = formDraftTabSettled() !== mine && drafts.some(d => d.tab === mine);
  if (!claim && !othersThan(mine).length) return chooseFormDraft(drafts, options);
  return (async () => {
    if (claim) {
      try { mine = await formDraftTabReady(); } catch { /* the id it had */ }
      if (!stillWanted()) return { stopped: true };
    }
    const others = othersThan(mine);
    if (others.length) {
      let alive;
      try { alive = (await formDraftTabsAlive(others)) || new Set(); } catch { alive = new Set(); }
      // Another open page's form: never opened here.
      drafts = drafts.filter(d => !d.tab || d.tab === mine || !alive.has(d.tab));
      if (!stillWanted()) return { stopped: true };
    }
    return chooseFormDraft(drafts, options);
  })();
}

function chooseFormDraft(drafts, { slotFor, records = [], held = records, recordsRead = false }) {
  let waiting = false;
  for (const d of drafts) {
    const draft = d.value;
    const editing = draft.editId ? (records || []).find(x => x?.id === draft.editId) : null;
    if (draft.editId && !editing) {
      if (!(held || []).some(x => x?.id === draft.editId)) {
        if (recordsRead) clearFormDraft(d.slot); else waiting = true;
      }
      continue;
    }
    // Now this page's draft: the page that wrote it is gone.
    if (d.slot !== slotFor(draft.editId)) clearFormDraft(d.slot);
    const opened = draft.base && typeof draft.base === "object" ? draft.base : null;
    // What the draft changed from the record it opened from; a draft with no
    // base (an Add, or an earlier build's edit) is laid over whole.
    const changed = opened
      ? Object.fromEntries(Object.entries(draft.form).filter(([k, v]) => !sameValue(v, opened[k])))
      : draft.form;
    // Nothing typed (a record opened to read it, an Add left untouched): not
    // opened again saying "Restored what you were typing" (review of
    // release/goal2, 2026-10-02: CME has no details view, so reading an entry
    // opens its Edit form).
    const untouched = opened ? !Object.keys(changed).length : Object.values(changed).every(blankValue);
    if (untouched) {
      clearFormDraft(d.slot);
      continue;
    }
    return { restore: { editing: editing || null, changed } };
  }
  return waiting ? { waiting: true } : { none: true };
}
