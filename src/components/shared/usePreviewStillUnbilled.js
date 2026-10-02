import { useEffect, useRef } from "react";

/**
 * An invoice preview kept open while another device bills what it bills
 * (review of release/goal2, 2026-10-01): its server check ran once, as it
 * opened, and Send invoice… and Copy trusted that answer for as long as it
 * stayed open. Built on the Mac, then the same days emailed from the iPhone:
 * back on the Mac the page's copy showed them billed, and the preview still
 * shared them under a new number and recorded it, a second invoice to the
 * agency for the same work.
 *
 * Now, for the preview of Work log or Days & call:
 *  - the moment any of its items is billed in this page's copy, or the
 *    server has said so (serverBilling.js), `onBilled(billedOn, held)` runs
 *    (again whenever `held` changes): the screen closes the preview and says
 *    where they are, or, while something of it is under way (`held`: its
 *    file with the share sheet, its question asked, its email on the way),
 *    stops it sending again and lets that finish;
 *  - when the page comes back to the front or online, `onResume()` runs:
 *    the screen asks the server again before Send and Copy are offered.
 *
 * `billedOn`: the itemsBilledSince answer for the open preview (null when
 * there is none, or it records only).
 */
export default function usePreviewStillUnbilled({ open, billedOn, held, onBilled, onResume }) {
  // The screen's latest handlers, taken after each render (before the
  // effects below run), so an event listener never acts on an old preview.
  const latest = useRef({ onBilled, onResume });
  useEffect(() => { latest.current = { onBilled, onResume }; });
  const key = billedOn && Object.keys(billedOn).length ? JSON.stringify(billedOn) : "";
  useEffect(() => {
    if (key) latest.current.onBilled?.(JSON.parse(key), !!held);
  }, [key, held]);
  useEffect(() => {
    if (!open) return undefined;
    const doc = typeof document === "undefined" ? null : document;
    const win = typeof window === "undefined" ? null : window;
    const fire = () => {
      if (doc?.visibilityState === "hidden") return;
      try { latest.current.onResume?.(); } catch { /* the next resume asks */ }
    };
    doc?.addEventListener?.("visibilitychange", fire);
    win?.addEventListener?.("pageshow", fire);
    win?.addEventListener?.("online", fire);
    win?.addEventListener?.("focus", fire);
    return () => {
      doc?.removeEventListener?.("visibilitychange", fire);
      win?.removeEventListener?.("pageshow", fire);
      win?.removeEventListener?.("online", fire);
      win?.removeEventListener?.("focus", fire);
    };
  }, [open]);
}

/**
 * Of `ids` (what a preview bills), those billed now: on an invoice in this
 * page's copy (`items` with an invoiceId, named from `invoices`), or on one
 * the server named since (`elsewhere`, serverBilledIn). { id: number|null }.
 */
export function itemsBilledSince(ids, items, invoices, elsewhere) {
  const want = new Set((ids || []).filter(Boolean).map(String));
  const out = {};
  if (!want.size) return out;
  for (const x of items || []) {
    if (!x || !want.has(String(x.id)) || !x.invoiceId) continue;
    out[String(x.id)] = (invoices || []).find(i => i?.id === x.invoiceId)?.number || null;
  }
  for (const id of want) {
    if (!Object.hasOwn(out, id) && elsewhere?.has?.(id)) out[id] = elsewhere.get(id) || null;
  }
  return out;
}
