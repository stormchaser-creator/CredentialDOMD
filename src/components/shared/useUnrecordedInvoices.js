import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "../../utils/storageScope";
import { withUnrecorded, withoutUnrecorded, unrecordedStill } from "../../utils/invoiceRecord";
import {
  keepInvoiceNote, forgetInvoiceNote, invoiceNotes, refreshInvoiceNotes, subscribeInvoiceNotes, reportHandoffEvent, handoffTimes,
} from "../../utils/invoiceHandoff";

// The signed-in account's notes (storageScope keys them by account).
const readKept = () => {
  const kept = lsGetJSON(BASE_KEYS.unrecordedInvoices);
  return Array.isArray(kept) ? kept : [];
};

// Every note for the account, oldest first: the refused-record ones win a
// number both hold (they carry the moment it went out).
function allNotes(account) {
  const kept = readKept();
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const handed = invoiceNotes(account).filter(n => !kept.some(x => same(x?.number, n.number)));
  return [...kept, ...handed].sort((a, b) => String(a?.sentAt || "").localeCompare(String(b?.sentAt || "")));
}


/**
 * The invoices that went out from this screen and are not recorded, kept
 * until they are on the Invoices tab (utils/invoiceRecord.js): one whose
 * record was refused, and one handed to the share sheet whose sheet never
 * answered (utils/invoiceHandoff.js: kept in IndexedDB too, and on the
 * server, so a full device, a reload or another device still shows it).
 * `invoices` is the account's list; `kind` "INV" with `contractId`, or
 * "EXP"; `account` the signed-in Clerk user id (user.id: the same offline
 * and online, and the id Sign out purges by). Returns the notes still
 * unrecorded (newest last), `remember(note)` and `forget(number, { unstamp })`.
 */
export default function useUnrecordedInvoices(invoices, { kind, contractId = null, account: who = "" } = {}) {
  const account = String(who || "");
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const off = subscribeInvoiceNotes(bump);
    refreshInvoiceNotes(account);
    const doc = globalThis.document;
    const win = globalThis.window;
    const onVisible = () => { if (doc?.visibilityState !== "hidden") refreshInvoiceNotes(account); };
    // Back online: the stamps owed to the server go, and its list is read.
    const onOnline = () => refreshInvoiceNotes(account);
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("online", onOnline);
    return () => { off(); doc?.removeEventListener?.("visibilitychange", onVisible); win?.removeEventListener?.("online", onOnline); };
  }, [account]);
  const remember = useCallback((note) => {
    // localStorage refuses it on a full device (lsSet answers false): said,
    // and kept where the handoff notes are, so it is not lost.
    if (lsSetJSON(BASE_KEYS.unrecordedInvoices, withUnrecorded(readKept(), note)) === false) reportHandoffEvent("unrecorded_note_storage_full");
    keepInvoiceNote(account, { ...note, refused: true });
    setVersion(v => v + 1);
  }, [account]);
  const forget = useCallback((number, { unstamp = false } = {}) => {
    forgetInvoiceNote(account, number, { unstamp });
    const kept = readKept();
    const next = withoutUnrecorded(kept, number);
    if (next.length !== kept.length) lsSetJSON(BASE_KEYS.unrecordedInvoices, next);
    setVersion(v => v + 1);
  }, [account]);
  const list = unrecordedStill(allNotes(account), invoices, { kind, contractId });
  const left = useRef(0);
  const count = list.length;
  useEffect(() => { left.current = count; });
  const any = count > 0;
  // A note that never became an invoice is reported (the event and a count)
  // once the page has had time to load the account's invoices.
  useEffect(() => {
    if (!any) return undefined;
    const t = setTimeout(() => { if (left.current > 0) reportHandoffEvent("invoice_handoff_unrecorded", { count: left.current }); }, handoffTimes().reportMs);
    t?.unref?.();
    return () => clearTimeout(t);
  }, [any]);
  return { list, remember, forget };
}

/**
 * While a preview holds an invoice that went out unrecorded, leaving the page
 * (reload, close) asks first. The note above survives it; this is the belt.
 */
export function useUnloadWarning(active) {
  useEffect(() => {
    const w = globalThis.window;
    if (!active || typeof w?.addEventListener !== "function") return undefined;
    const warn = (e) => { e.preventDefault?.(); e.returnValue = ""; return ""; };
    w.addEventListener("beforeunload", warn);
    return () => w.removeEventListener?.("beforeunload", warn);
  }, [active]);
}
