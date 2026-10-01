// The Setup board's stored state (settings.setupState): its shape, and any
// copy on file (or none) read back as that shape.
//
// Pure, with no imports, so utils/syncRules.js can compare two copies by
// their shape (rebaseSetupState) without pulling in the task board, and plain
// node tests can import it. utils/setupTasks.js re-exports all of it.

export const SETUP_STATE_VERSION = 1;

export const EMPTY_SETUP_STATE = Object.freeze({
  v: SETUP_STATE_VERSION,
  startedAt: null,
  tier1DoneAt: null,
  tier2DoneAt: null,
  lastTouched: null,
  lastDone: null,
  hiddenUntil: null,
  proCounted: null,
  betaCounted: null,
  cvImportedAt: null,
  declared: {},
  tasks: {},
});

/** One half of the board as stored, or null. */
export function half(v) {
  return v && typeof v === "object" && typeof v.done === "number" && typeof v.total === "number"
    ? { done: v.done, total: v.total }
    : null;
}

/** Anything on file (or nothing at all) read back as the full shape. */
export function normalizeSetupState(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const declared = r.declared && typeof r.declared === "object" && !Array.isArray(r.declared) ? r.declared : {};
  const tasks = r.tasks && typeof r.tasks === "object" && !Array.isArray(r.tasks) ? r.tasks : {};
  return {
    v: SETUP_STATE_VERSION,
    startedAt: r.startedAt || null,
    tier1DoneAt: r.tier1DoneAt || null,
    tier2DoneAt: r.tier2DoneAt || null,
    lastTouched: r.lastTouched || null,
    lastDone: r.lastDone || null,
    hiddenUntil: r.hiddenUntil || null,
    // How many Pro rows were in the denominator the last time the board was
    // read, and whether the free beta was what put them there. Both are null
    // until the first read, and a null never narrates: the fraction is only
    // explained when it actually changes under someone.
    proCounted: typeof r.proCounted === "number" ? r.proCounted : null,
    betaCounted: typeof r.betaCounted === "boolean" ? r.betaCounted : null,
    // The board's own score, stamped by the physician's device each time it
    // moves. The board is derived from their records and nobody else can read
    // those, so without this an admin can say a physician started and not how
    // far they got. { done, total, at } or null before the first read.
    progress: r.progress && typeof r.progress === "object"
      && typeof r.progress.done === "number" && typeof r.progress.total === "number"
      ? {
        done: r.progress.done, total: r.progress.total, at: r.progress.at || null,
        // Both halves, because the Setup page never shows the sum: it shows
        // the first six until they are finished, then the packet's ten.
        t1: half(r.progress.t1), t2: half(r.progress.t2),
      }
      : null,
    // When a CV import first saved something. A positive fact, so it does
    // not live in `declared`, which holds only declared negatives (noCv,
    // noDea) and which the admin summary counts as "not applicable".
    cvImportedAt: typeof r.cvImportedAt === "string" && r.cvImportedAt ? r.cvImportedAt : null,
    declared: { ...declared },
    tasks: { ...tasks },
  };
}
