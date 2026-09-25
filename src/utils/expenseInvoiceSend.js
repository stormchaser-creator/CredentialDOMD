import { invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail, expenseReceiptLines } from "./invoiceCover.js";

/**
 * Sending an expense invoice with its receipts: the share-sheet attempts and
 * what each piece of text may claim. Browser objects are passed in (`nav`,
 * `pdfFor`, `download`) so this runs under node with fakes
 * (scripts/share-format.test.mjs), including the share sheet refusing the
 * bundle and the clipboard refusing a write.
 *
 * The rule it enforces: nothing written BEFORE the share knows whether the
 * receipts will go, so nothing written before the share claims them.
 *  - The clipboard letter never carries a receipt count. It is written before
 *    the share, and after a failed share Safari refuses clipboard writes
 *    (the tap is spent), so a count could not be taken back when the OS then
 *    refuses the bundle and the invoice goes alone.
 *  - The share text is built per attempt and counts only the receipts in that
 *    attempt.
 *  - The PDF says "receipt attached" only on lines whose receipts are in that
 *    attempt (expenseReceiptLines); the invoice-alone retry is rebuilt with
 *    every line "on file".
 */

/** The long cover letter on the clipboard, count-free. true when it landed. */
export async function copyInvoiceCover(inv, clipboard) {
  try {
    await clipboard.writeText(invoiceCoverEmail({ ...inv, receipts: 0 }));
    return true;
  } catch {
    return false;
  }
}

/**
 * One share-sheet attempt. `receipts` is how many receipt files ride in
 * `files` beside the invoice. Returns "share", "abort" (the physician closed
 * the sheet) or null (the OS refused or the share failed).
 */
export async function shareInvoiceFiles(inv, files, receipts, nav) {
  if (!(nav?.canShare && nav.canShare({ files }))) return null;
  try {
    await nav.share({ title: invoiceSubject(inv), text: invoiceCoverBlurb({ ...inv, receipts }), files });
    return "share";
  } catch (err) {
    return err?.name === "AbortError" ? "abort" : null;
  }
}

/**
 * Send a new expense invoice. `files` are the receipt files resolved before
 * the tap; `attachedExpenseIds` names the expenses whose receipts are ALL in
 * `files`. Order: the invoice with every receipt; if the OS refuses that, the
 * invoice alone (rebuilt so no line claims a receipt); if files cannot be
 * shared at all, a download of everything.
 *
 * Returns null when the physician cancelled (record nothing), otherwise
 * { how: "share" | "download", coverCopied, droppedForSize, lines } where
 * `lines` are the lines of the PDF that actually went, for the invoice record.
 */
export async function sendExpenseInvoiceFiles({ inv, files = [], attachedExpenseIds = new Set(), nav, pdfFor, download }) {
  const coverCopied = await copyInvoiceCover(inv, nav?.clipboard);
  const withReceipts = { ...inv, lines: expenseReceiptLines(inv.lines, attachedExpenseIds) };
  const pdf = pdfFor(withReceipts);
  const first = await shareInvoiceFiles(withReceipts, [pdf, ...files], files.length, nav);
  if (first === "abort") return null;
  if (first) return { how: "share", coverCopied, droppedForSize: 0, lines: withReceipts.lines };
  if (files.length) {
    // The invoice itself is never held hostage by its receipts.
    const alone = { ...inv, lines: expenseReceiptLines(inv.lines) };
    const second = await shareInvoiceFiles(alone, [pdfFor(alone)], 0, nav);
    if (second === "abort") return null;
    if (second) return { how: "share", coverCopied, droppedForSize: files.length, lines: alone.lines };
  }
  // Every file lands on the device together, so the receipts the PDF calls
  // attached are the ones beside it.
  download([pdf, ...files]);
  return { how: "download", coverCopied, droppedForSize: 0, lines: withReceipts.lines };
}
