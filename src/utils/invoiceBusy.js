// Whether an invoice is open on screen (a preview, its send, the expense
// invoice sheet). While one is, the app never reloads itself for an update
// (components/shared/UpdatePrompt.jsx shows "tap to update" instead): the
// reload that came as the physician returned from Mail threw away an invoice
// that had just gone to the agency, before anything recorded it (ticket
// "Invoicce", 2026-09-30). Module state, one per tab. Its one import has
// none, so the update watcher stays light.

import { notePageState } from "./pageDiscard.js";

const open = new Set();

/** `where` ("worklog", "dutylog", "expenses") has an invoice open, or not. */
export function markInvoiceBusy(where, busy) {
  if (busy) open.add(where); else open.delete(where);
  // For the report of a page iOS discards (utils/pageDiscard.js).
  notePageState({ previewOpen: open.size > 0 });
}

/** True while any screen has an invoice open. */
export function invoiceBusy() {
  return open.size > 0;
}
