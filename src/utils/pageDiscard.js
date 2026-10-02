/**
 * Whether iOS threw this page away (2026-10-02, the owner's iPhone: the
 * installed app's page was discarded while he was in Gmail, between the
 * share and the answer, and nothing anywhere said so).
 *
 * A marker in this tab's sessionStorage says the page is alive, with what it
 * held: an invoice with the share sheet, an invoice open on screen. A page
 * that leaves normally (a reload, an update, a navigation) fires pagehide
 * and removes it; a page iOS discards does not. So a page that finds the
 * marker at boot follows one that was discarded, and says so once to
 * client_errors (`page_discarded`, with share_in_flight and preview_open:
 * flags only, never a number). A relaunch of the whole app clears
 * sessionStorage and says nothing. No imports.
 */

export const PAGE_ALIVE_KEY = "credentialdomd-page-alive-v1";

const state = { shareInFlight: false, previewOpen: false };
let store = null;
let started = false;

function write() {
  if (!started || !store) return;
  try { store.setItem(PAGE_ALIVE_KEY, JSON.stringify({ at: Date.now(), ...state })); } catch { /* full or blocked: nothing to report next time */ }
}

/**
 * At boot: reports a discarded predecessor through `report(message, extra)`
 * and marks this page alive. Returns what it found (null when the last page
 * left normally, or none ran in this tab).
 */
export function startPageDiscardWatch({ report, storage = globalThis.sessionStorage, win = globalThis.window } = {}) {
  store = storage || null;
  let found = null;
  try { const raw = store?.getItem(PAGE_ALIVE_KEY); found = raw ? JSON.parse(raw) : null; } catch { found = null; }
  if (found && typeof report === "function") {
    try {
      report("Page discarded by the browser (the last page in this tab never left normally)", {
        event: "page_discarded", share_in_flight: !!found.shareInFlight, preview_open: !!found.previewOpen,
      });
    } catch { /* reporting never blocks */ }
  }
  started = true;
  write();
  try {
    win?.addEventListener?.("pagehide", () => { try { store?.removeItem(PAGE_ALIVE_KEY); } catch { /* gone */ } });
    // Back from the back-forward cache: alive again.
    win?.addEventListener?.("pageshow", () => write());
  } catch { /* no window */ }
  return found;
}

/** What the page holds now: { shareInFlight, previewOpen } (either). */
export function notePageState(patch = {}) {
  let changed = false;
  for (const k of ["shareInFlight", "previewOpen"]) {
    if (k in patch && state[k] !== !!patch[k]) { state[k] = !!patch[k]; changed = true; }
  }
  if (changed) write();
}

/** Tests only. */
export function _resetPageDiscardWatch() {
  started = false; store = null; state.shareInFlight = false; state.previewOpen = false;
}
