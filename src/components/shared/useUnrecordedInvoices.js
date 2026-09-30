import { useCallback, useEffect, useState } from "react";
import { BASE_KEYS, lsGetJSON, lsSetJSON } from "../../utils/storageScope";
import { withUnrecorded, withoutUnrecorded, unrecordedStill } from "../../utils/invoiceRecord";

// The signed-in account's notes (storageScope keys them by account).
const readKept = () => {
  const kept = lsGetJSON(BASE_KEYS.unrecordedInvoices);
  return Array.isArray(kept) ? kept : [];
};

/**
 * The invoices that went out from this screen with their record refused, kept
 * on the device per account until they are on the Invoices tab
 * (utils/invoiceRecord.js). `invoices` is the account's list; `kind` "INV"
 * with `contractId`, or "EXP". Returns the notes still unrecorded (newest
 * last), `remember(note)` and `forget(number)`.
 */
export default function useUnrecordedInvoices(invoices, { kind, contractId = null } = {}) {
  const [, setVersion] = useState(0);
  const remember = useCallback((note) => {
    lsSetJSON(BASE_KEYS.unrecordedInvoices, withUnrecorded(readKept(), note));
    setVersion(v => v + 1);
  }, []);
  const forget = useCallback((number) => {
    const kept = readKept();
    const next = withoutUnrecorded(kept, number);
    if (next.length === kept.length) return;
    lsSetJSON(BASE_KEYS.unrecordedInvoices, next);
    setVersion(v => v + 1);
  }, []);
  return { list: unrecordedStill(readKept(), invoices, { kind, contractId }), remember, forget };
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
