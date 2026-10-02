import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "../../utils/storageScope";
import { withUnrecorded, withoutUnrecorded, unrecordedStill, onAnyInvoice, repeatOf } from "../../utils/invoiceRecord";
import { serverBilledIn, subscribeServerBilled, noteServerBilled, requestRecordsRefresh } from "../../utils/serverBilling";
import { readInvoiceRecordState } from "../../lib/supabase";
import {
  keepInvoiceNote, forgetInvoiceNote, invoiceDeleted, invoiceNotes, refreshInvoiceNotes, subscribeInvoiceNotes, reportHandoffEvent, handoffTimes, shareInFlight,
} from "../../utils/invoiceHandoff";

// The signed-in account's notes (storageScope keys them by account).
const readKept = () => {
  const kept = lsGetJSON(BASE_KEYS.unrecordedInvoices);
  return Array.isArray(kept) ? kept : [];
};

// The refused-record note for `number` leaves the device's kept list.
function dropKept(number) {
  const kept = readKept();
  const next = withoutUnrecorded(kept, number);
  if (next.length !== kept.length) lsSetJSON(BASE_KEYS.unrecordedInvoices, next);
}

/**
 * The invoice `number` was deleted on this device (the Invoices tab): its
 * handoff note and server stamp go (invoiceHandoff.invoiceDeleted), and so
 * does a refused-record note kept for it here: with the invoice gone it
 * would say the number is not recorded again and offer to record it a
 * second time. A note for an invoice recorded on another device goes as
 * soon as that invoice is seen here (useUnrecordedInvoices), so a delete on
 * any device leaves nothing behind either.
 */
export function invoiceDeletedHere(account, number) {
  const n = String(number ?? "").trim();
  if (!n) return;
  dropKept(n);
  invoiceDeleted(String(account || ""), n);
}

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
 * unrecorded (newest last), `remember(note)` and `forget(number, { unstamp,
 * recordedAs })` (recordedAs: the number it was recorded under, so the
 * server's stamp goes only once that record is there).
 *
 * `records`: the account's data. A note whose items are all billed on other
 * recorded invoices (invoiceRecord.repeatOf; 2026-10-02, INV-C sent for the
 * days INV-A billed) is not in `list`: it is in `repeats` ({ ...note,
 * repeat }), holds nothing, is never reported as unrecorded, and
 * `dismissRepeat(note)` forgets it in one tap. One only partly billed
 * elsewhere stays in `list` with `overlap` (no Yes is offered for it).
 */
export default function useUnrecordedInvoices(invoices, { kind, contractId = null, account: who = "", records = null } = {}) {
  const account = String(who || "");
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const off = subscribeInvoiceNotes(bump);
    const offBilled = subscribeServerBilled(bump);
    refreshInvoiceNotes(account);
    const doc = globalThis.document;
    const win = globalThis.window;
    const onVisible = () => { if (doc?.visibilityState !== "hidden") refreshInvoiceNotes(account); };
    // Back online: the stamps owed to the server go, and its list is read.
    const onOnline = () => refreshInvoiceNotes(account);
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("online", onOnline);
    return () => { off(); offBilled(); doc?.removeEventListener?.("visibilitychange", onVisible); win?.removeEventListener?.("online", onOnline); };
  }, [account]);
  const remember = useCallback((note) => {
    // localStorage refuses it on a full device (lsSet answers false): said,
    // and kept where the handoff notes are, so it is not lost.
    if (lsSetJSON(BASE_KEYS.unrecordedInvoices, withUnrecorded(readKept(), note)) === false) reportHandoffEvent("unrecorded_note_storage_full");
    keepInvoiceNote(account, { ...note, refused: true });
    setVersion(v => v + 1);
  }, [account]);
  const forget = useCallback((number, { unstamp = false, recordedAs = null } = {}) => {
    forgetInvoiceNote(account, number, { unstamp, recordedAs });
    dropKept(number);
    setVersion(v => v + 1);
  }, [account]);
  const notes = allNotes(account);
  // A note this device keeps for a number now on the account's invoices is
  // done with, wherever it was recorded: dropped here, not only hidden. Only
  // hidden, a delete of that invoice on another device brought it back as
  // "not recorded" with Record it a tap away, and the kept list never ages
  // out. Its stamp goes too once that record is on the server (forget's
  // `recordedAs`), after any share stamp still owed for it. Any kind: Home
  // and every screen prune the same notes.
  const recordedKey = notes.filter(n => !n.fromServer && onAnyInvoice(invoices, n.number))
    .map(n => String(n.number).trim()).join("\n");
  useEffect(() => {
    if (!recordedKey) return;
    for (const number of recordedKey.split("\n")) {
      forgetInvoiceNote(account, number, { unstamp: true, recordedAs: number });
      dropKept(number);
    }
    setVersion(v => v + 1);
  }, [account, recordedKey]);
  const still = unrecordedStill(notes, invoices, { kind, contractId });
  const repeats = [];
  const list = [];
  for (const n of still) {
    const rep = records ? repeatOf(n, records, invoices, serverBilledIn) : null;
    if (rep?.full) repeats.push({ ...n, repeat: rep });
    else list.push(rep ? { ...n, overlap: rep } : n);
  }
  // A repeat goes in one tap, without a question. The copy says its items
  // are billed elsewhere; the server is asked first when it can be, as the
  // copy may be older than a delete on another device. Never asked forever:
  // no answer (offline) goes by the copy.
  const dismissing = useRef(new Set());
  const dismissRepeat = useCallback(async (note) => {
    const number = note?.number;
    const rep = note?.repeat;
    if (!number || dismissing.current.has(number)) return;
    dismissing.current.add(number);
    try {
      let call = null;
      try { call = rep?.collection && rep.ids?.length ? readInvoiceRecordState("", rep.collection, rep.ids, null) : null; } catch { call = null; }
      let res = null;
      if (call && typeof call.then === "function") {
        res = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), handoffTimes().listMs);
          t?.unref?.();
          Promise.resolve(call).then((r) => { clearTimeout(t); resolve(r); }, () => { clearTimeout(t); resolve(null); });
        });
      }
      if (res && !res.error && res.data) {
        const billed = (res.data.billedIds || []).map(String).filter(id => rep.ids.includes(id));
        if (billed.length) noteServerBilled(rep.collection, Object.fromEntries(billed.map(id => [id, res.data.billedOn?.[id] || null])));
        if (billed.length < rep.ids.length) {
          // Unbilled on the server since this copy was read (an invoice
          // deleted on another device): not a repeat. The copy is read again.
          requestRecordsRefresh();
          globalThis.window?.alert?.(`${number} is not a repeat any more: some of what it billed is unbilled now (changed on another device). The app is reading your records again; answer ${number} once it shows again.`);
          return;
        }
      }
      forgetInvoiceNote(account, number, { unstamp: true });
      dropKept(number);
      setVersion(v => v + 1);
    } finally { dismissing.current.delete(number); }
  }, [account]);
  const left = useRef(0);
  // One whose share sheet on this page still has the file (Mail open over the
  // app while a cover note is written) is not unrecorded yet: counted only
  // once the sheet answers, or on a page that never saw it answer.
  const count = list.filter(n => !shareInFlight(n.number)).length;
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
  return { list, repeats, remember, forget, dismissRepeat };
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
