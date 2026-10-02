// A stored file's bytes, fetched while a screen shows it.
//
// WHY. A load no longer downloads every stored file (24ac86c7: the account's
// files held as data URLs took hundreds of MB on the owner's iPhone, and iOS
// discarded the page in Mail mid-share). A screen that shows a file asks for
// its bytes (components/shared/useDocumentBytes.js) and lets them go when it
// closes. The first version tied each download to the load that was current
// when the screen asked. The membership answer starts a second load a moment
// after the first (AppContext reconciledAccess); a download that landed after
// it began was thrown away, and since the screen's list of files had not
// changed it never asked again. Every stored file then read "Fetching the
// file from your account." for good after a reload or a cold start (QA lab
// DOCS-008 and DOCS-009, 2026-10-02: Storage answered 200 each time). Any
// load did the same: the app back in front, back online, the identity retry.
//
// HOW. This keeps what the screens want (counted: a file two screens show
// stays until both let go) and sees that each wanted file gets its bytes:
//  - A download belongs to the account, not to a load. What lands goes on
//    the document on screen now with the same id and the same stored file
//    (path, size and type), whatever loads ran meanwhile.
//  - Whatever replaces the records (a load, an edit), the app coming back to
//    the front and the connection coming back all look again (pump) for a
//    wanted file with no bytes, so none waits on a download nobody makes.
//  - Two at a time, the most recently wanted first: on a weak link what was
//    just opened comes first. A download a screen let go of goes on (a
//    record closed and opened again finds its file, as it did before), but
//    gives its place up to a file a screen shows.
//  - A download that fails, or stalls (no bytes for STALL_MS), is tried again
//    later (RETRY_MS, then every minute) and at once when the connection or
//    the app comes back. Offline nothing is asked and the file says so.
//
// MEMORY. Bytes no screen shows are kept only up to KEEP_CHARS (the least
// recently shown go first) and none while the page is hidden (the owner's
// iPhone in Mail; downloads no screen wants stop too), so a return to the
// screen is instant without holding the whole account. A file not yet in the
// account (no storagePath, or a pendingUpload) is never let go: its bytes are
// the only copy.
//
// Pure: plain node tests drive it with their own clock, timers and downloads.

/** Data URL characters kept for files no screen shows (about 9 MB of files). */
export const KEEP_CHARS = 12 * 1024 * 1024;
/** Downloads running at once. */
export const AT_ONCE = 2;
/** Waits before a failed download is tried again; the last repeats. */
export const RETRY_MS = Object.freeze([2000, 5000, 15000, 30000, 60000]);
/** A download with no bytes arriving for this long is stopped and tried again. */
export const STALL_MS = 20000;

const idOf = (id) => String(id);
// The file's MIME type, from the row alone (never from bytes it holds). An
// emailed document's `type` is its inbox marker until it is filed, when
// leaveInbox writes the MIME type (its `mimeType`) into `type`: the same file,
// so the same identity, and a download in flight is not started over nor a
// file another device shows downloaded again (review of release/goal2,
// 2026-10-02).
const fileTypeOf = (doc) => (doc?.type && String(doc.type).includes("/") ? doc.type : doc?.mimeType) || "";
// The stored file a document row names. A file given again (on another
// device, or "Upload it again") under the same path has another size or type.
export const storedFileOf = (doc) => `${doc?.storagePath || ""}\u0000${doc?.size ?? ""}\u0000${fileTypeOf(doc)}`;
// What the missing list notes: the stored file and when the row last changed.
// "Upload it again" writes the new file to the same path (<account>/<doc id>),
// often the very same file (same size and type), and stamps the row; noted by
// path alone, the file given again read "Missing from your account" once its
// bytes were let go, for the rest of the session, here and on every other
// device that had found it missing (review of release/goal2, 2026-10-02).
export const missingKeyOf = (doc) => `${storedFileOf(doc)}\u0000${doc?.updatedAt || ""}`;
// Bytes that can be fetched again: the account holds the file.
const releasable = (doc) => !!(doc?.id && typeof doc.data === "string" && doc.data && doc.storagePath && !doc.pendingUpload);
const unique = (ids) => [...new Set((ids || []).filter((id) => id != null && id !== "").map(idOf))];
const withoutKey = (doc, key) => { const out = { ...doc }; delete out[key]; return out; };

/**
 * io:
 *  - documents(): the documents on screen now
 *  - account(): the account whose records are on screen, or null
 *  - fetch(storagePath, { signal, onProgress, doc }): { dataUrl } | { missing: true } | { failed: true }
 *    (`doc`: the document row, for the type the data URL carries)
 *  - update(fn, account): replace the documents on screen with fn(documents),
 *    only while `account`'s records are the ones on screen
 *  - online(), canFetch(): whether a download can be asked for now
 *  - missing: { has(key), add(key), delete(key) }: Storage has no file for
 *    that row as it was (missingKeyOf), this session
 *  - now, setTimer, clearTimer, defer: the clock and the timers
 */
export function createDocumentBytes(io) {
  const {
    documents, account, fetch: fetchFile, update,
    online = () => typeof navigator === "undefined" || navigator.onLine !== false,
    canFetch = () => true,
    missing = { has: () => false, add: () => {}, delete: () => {} },
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
    defer = (fn) => Promise.resolve().then(fn),
    keepChars = KEEP_CHARS, atOnce = AT_ONCE, retryMs = RETRY_MS, stallMs = STALL_MS,
  } = io;

  const wants = new Map();     // id -> how many screens show it
  const shownAt = new Map();   // id -> the order a screen last showed it in (higher is later)
  let shownSeq = 0;
  const inflight = new Map();  // id -> { file, path, account, controller, stall, stopped }
  const failures = new Map();  // id -> { file, attempts, retryAt }
  const listeners = new Set();
  let retryTimer = null, retryAt = null;
  let pumpQueued = false, sweepQueued = false;
  let pageHidden = false;
  let version = 0;

  const notify = () => {
    version += 1;
    for (const fn of [...listeners]) { try { fn(); } catch { /* a screen's listener */ } }
  };
  const byId = () => new Map((documents() || []).filter((d) => d?.id != null).map((d) => [idOf(d.id), d]));
  const isMissing = (d) => !!(d?.storagePath && missing.has(missingKeyOf(d)));
  const needsBytes = (d) => !!(d && d.storagePath && !d.data && !d.fileMissing && !isMissing(d));
  // A row whose bytes are here and whose file the account holds (a file
  // given again, uploaded): whatever was noted missing for it is not so now.
  const forgetGiven = (docs) => {
    for (const d of docs) if (releasable(d) && isMissing(d)) { try { missing.delete?.(missingKeyOf(d)); } catch { /* a store without delete */ } }
  };
  const reachable = () => canFetch() && online();

  function schedule(at) {
    if (at === retryAt) return;
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null; retryAt = null;
    if (at == null || !Number.isFinite(at)) return;
    retryAt = at;
    retryTimer = setTimer(() => { retryTimer = null; retryAt = null; pump(); }, Math.max(0, at - now()));
  }

  function fail(id, file) {
    const was = failures.get(id);
    const attempts = was && was.file === file ? was.attempts + 1 : 1;
    failures.set(id, { file, attempts, retryAt: now() + retryMs[Math.min(attempts - 1, retryMs.length - 1)] });
  }

  // Stops a download in flight. `why`: "stalled" counts as a failure (tried
  // again later); "stale" (the file changed or went), "unwanted" (no screen
  // shows it, and a file one does needs its place, or the page is hidden) and
  // "reset" (another account) do not.
  function stop(id, why) {
    const entry = inflight.get(id);
    if (!entry) return;
    entry.stopped = why;
    if (entry.stall) clearTimer(entry.stall);
    inflight.delete(id);
    try { entry.controller?.abort(); } catch { /* already settled */ }
    if (why === "stalled") fail(id, entry.file);
    pumpSoon();
    notify();
  }

  function start(id, doc, owner) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const entry = { file: storedFileOf(doc), missingKey: missingKeyOf(doc), path: doc.storagePath, account: owner, controller, stall: null, stopped: null };
    inflight.set(id, entry);
    // Restarted as each part of the file arrives: a large scan on a weak link
    // goes on as long as bytes come; only one that has stopped is let go.
    const arm = () => {
      if (entry.stopped) return;
      if (entry.stall) clearTimer(entry.stall);
      entry.stall = setTimer(() => stop(id, "stalled"), stallMs);
    };
    arm();
    let result = null;
    Promise.resolve()
      .then(() => fetchFile(entry.path, { signal: controller?.signal, onProgress: arm, doc }))
      .then((r) => { result = r; }, () => { result = { failed: true }; })
      .then(() => land(id, entry, result));
  }

  function land(id, entry, result) {
    if (entry.stall) clearTimer(entry.stall);
    if (entry.stopped) return;
    if (inflight.get(id) === entry) inflight.delete(id);
    if (entry.account === account()) {
      if (result?.dataUrl) {
        failures.delete(id);
        update((docs) => {
          let changed = false;
          const next = docs.map((x) => {
            if (idOf(x?.id) !== id || x.data || storedFileOf(x) !== entry.file) return x;
            changed = true;
            return { ...withoutKey(x, "fileMissing"), data: result.dataUrl };
          });
          return changed ? next : docs;
        }, entry.account);
      } else if (result?.missing) {
        // Storage has no file for this row: said on the document (in state
        // only, never an edit), and not asked for again this session.
        failures.delete(id);
        missing.add(entry.missingKey);
        update((docs) => {
          let changed = false;
          const next = docs.map((x) => {
            if (idOf(x?.id) !== id || x.data || missingKeyOf(x) !== entry.missingKey || x.fileMissing) return x;
            changed = true;
            return { ...x, fileMissing: true };
          });
          return changed ? next : docs;
        }, entry.account);
      } else {
        fail(id, entry.file);
      }
    }
    notify();
    pumpSoon();
    sweepSoon();
  }

  /** Starts what is wanted, has no bytes and may be asked for now. */
  function pump() {
    pumpQueued = false;
    const owner = account();
    const docs = byId();
    forgetGiven(docs.values());
    for (const [id, entry] of [...inflight]) {
      const d = docs.get(id);
      if (entry.account !== owner || !d || d.data || storedFileOf(d) !== entry.file) stop(id, "stale");
    }
    if (!owner) { schedule(null); return; }
    const order = [...wants.keys()].sort((a, b) => (shownAt.get(b) || 0) - (shownAt.get(a) || 0));
    // A file Storage was found not to have this session, on a row a load put
    // back on screen without the note: said again, never asked for again.
    const unmarked = order.filter((id) => {
      const d = docs.get(id);
      return d?.storagePath && !d.data && !d.fileMissing && isMissing(d);
    });
    if (unmarked.length) {
      update((list) => {
        let changed = false;
        const next = list.map((x) => {
          if (!unmarked.includes(idOf(x?.id)) || x.data || x.fileMissing || !isMissing(x)) return x;
          changed = true;
          return { ...x, fileMissing: true };
        });
        return changed ? next : list;
      }, owner);
    }
    if (!reachable()) { schedule(null); return; }
    const t = now();
    let next = null;
    for (const id of order) {
      if (inflight.has(id)) continue;
      const d = docs.get(id);
      if (!needsBytes(d)) continue;
      const failed = failures.get(id);
      if (failed && failed.file !== storedFileOf(d)) failures.delete(id);
      else if (failed && failed.retryAt > t) { next = Math.min(next ?? Infinity, failed.retryAt); continue; }
      if (inflight.size >= atOnce) {
        // A download no screen wants any more gives its place up.
        const idle = [...inflight.keys()].find((other) => !wants.has(other));
        if (idle == null) break;
        stop(idle, "unwanted");
      }
      start(id, d, owner);
    }
    schedule(next);
  }
  function pumpSoon() {
    if (pumpQueued) return;
    pumpQueued = true;
    defer(pump);
  }

  // Lets go of what no screen wants: the bytes of the files no screen shows
  // are kept only up to `keep` characters, the most recently shown first
  // (none while the page is hidden, when downloads no screen wants stop too).
  // Decided when it runs, after the screens that changed in one pass have let
  // go and asked again.
  function sweep({ keep = pageHidden ? 0 : keepChars } = {}) {
    sweepQueued = false;
    if (pageHidden) for (const id of [...inflight.keys()]) if (!wants.has(id)) stop(id, "unwanted");
    const owner = account();
    forgetGiven(documents() || []);
    const held = (documents() || []).filter((d) => releasable(d) && !wants.has(idOf(d.id)))
      .sort((a, b) => (shownAt.get(idOf(b.id)) || 0) - (shownAt.get(idOf(a.id)) || 0));
    let total = 0;
    const drop = new Set();
    for (const d of held) {
      total += d.data.length;
      if (total > keep) drop.add(idOf(d.id));
    }
    for (const id of [...shownAt.keys()]) if (!wants.has(id) && !held.some((d) => idOf(d.id) === id)) shownAt.delete(id);
    if (drop.size && owner) {
      update((docs) => {
        let changed = false;
        const next = docs.map((x) => {
          if (!drop.has(idOf(x?.id)) || wants.has(idOf(x.id)) || !releasable(x)) return x;
          changed = true;
          return withoutKey(x, "data");
        });
        return changed ? next : docs;
      }, owner);
    }
    pumpSoon();
  }
  function sweepSoon() {
    if (sweepQueued) return;
    sweepQueued = true;
    defer(() => { if (sweepQueued) sweep(); });
  }
  function retryNow() {
    for (const f of failures.values()) f.retryAt = 0;
    pump();
    notify();
  }

  return {
    /** A screen shows these documents (ids): their bytes are fetched. */
    want(ids) {
      const t = ++shownSeq;
      for (const id of unique(ids)) { wants.set(id, (wants.get(id) || 0) + 1); shownAt.set(id, t); }
      pump();
      notify();
    },
    /** A screen no longer shows them: let go once nothing else shows them. */
    unwant(ids) {
      const t = ++shownSeq;
      for (const id of unique(ids)) {
        const n = (wants.get(id) || 0) - 1;
        if (n > 0) wants.set(id, n);
        else { wants.delete(id); shownAt.set(id, t); }
      }
      sweepSoon();
    },
    /** The records on screen changed (a load, an edit): look again. */
    pump,
    /** Back online (or offline): what failed is asked for now, and files say where they stand. */
    retryNow,
    /** The page is hidden: keep no bytes, and fetch nothing, no screen wants. */
    hidden() { pageHidden = true; sweep(); },
    /** The page is back in front: as retryNow, and bytes are kept again. */
    visible() { pageHidden = false; retryNow(); },
    /** Another account (or none): forget what was asked for this one. */
    reset() {
      for (const id of [...inflight.keys()]) stop(id, "reset");
      failures.clear();
      schedule(null);
      notify();
    },
    /**
     * Where a document's file stands on this device: null when its bytes
     * are here (or it has none to fetch, or Storage has none), otherwise
     * "loading", "failed" (tried again on its own) or "offline".
     */
    status(doc) {
      if (!doc || doc.data || !doc.storagePath || doc.fileMissing) return null;
      if (!reachable()) return "offline";
      const id = idOf(doc.id);
      const f = failures.get(id);
      if (f && f.file === storedFileOf(doc) && !inflight.has(id)) return "failed";
      return "loading";
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    version: () => version,
    // Tests and reports.
    wanted: () => new Map(wants),
    inFlight: () => [...inflight.keys()],
  };
}

/** A stored file with no bytes here, without the app's byte store: on its way. */
export function statusWithoutStore(doc) {
  return doc && !doc.data && doc.storagePath && !doc.fileMissing ? "loading" : null;
}

/**
 * What a document card says while its file is not on this device, by its
 * status (createDocumentBytes status). `unlinked`: Documents offers File with
 * AI once the file is here.
 */
export function fileWaitText(status, { unlinked = false } = {}) {
  if (status === "offline") return "You are offline. The file opens here once you are back online.";
  if (status === "failed") return "The file could not be fetched from your account yet. Trying again.";
  return unlinked ? "Fetching the file from your account. File with AI appears when it is here." : "Fetching the file from your account.";
}

/** The same, as one line naming the file (a record's details). */
export function fileWaitLine(name, status) {
  const file = name || "The file";
  if (status === "offline") return `${file}: you are offline. It opens here once you are back online.`;
  if (status === "failed") return `${file} could not be fetched from your account yet. Trying again.`;
  return `${file} is downloading from the cloud; check back shortly`;
}

/** The same, as the short tag beside a file in an edit form. */
export function fileWaitTag(status) {
  if (status === "offline") return "offline";
  if (status === "failed") return "retrying";
  return "syncing…";
}
