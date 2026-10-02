import { useEffect } from "react";

const signature = (held) => (held ? [...held].map(([k, n]) => `${k}\u0000${n}`).sort().join("\u0001") : "");

/**
 * An open picker's held items (invoiceRecord heldByNotes: what an invoice
 * that went out unrecorded may bill) kept current as notes arrive.
 *
 * `live` is the map worked out from the notes as they are on this render
 * (null while no picker is open, or one opened for a note's Record it);
 * `seen` the map the picker last took in. When they differ, `take(live,
 * fresh)` runs once after the render, `fresh` being the keys held now that
 * were not before: the picker unchecks those and keeps `live` as seen. The
 * marks, the notice and the question before a build read `live` itself, so
 * a tap in the same moment never misses one.
 *
 * 2026-10-01 review: the held map was taken once, as the picker opened. A
 * note that reached the Mac from the server (or this device's IndexedDB) a
 * second later left those days checked, unmarked and unasked, and a second
 * invoice billed them again.
 */
export default function useHeldSync(live, seen, take) {
  const now = signature(live);
  const before = signature(seen);
  useEffect(() => {
    if (!live || now === before) return;
    take(live, [...live.keys()].filter(k => !seen?.has(k)));
  }, [now, before]); // eslint-disable-line react-hooks/exhaustive-deps
}
