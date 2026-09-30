// A synthetic call-stipend invoice (four call days, Oct 16 to 19, 2026),
// shaped like the kind of invoice the day layout was designed against: an
// orientation day, two long weekend days of callbacks, and a last day with
// no work. Every date, time, note and amount here is invented.
//
// northfieldEntries() rebuilds the work-log entries those lines were billed
// from (America/Chicago), so the same invoice can be priced again
// by the live engine and compared with what was stored.
import { readFileSync } from "node:fs";

export const NORTHFIELD = JSON.parse(readFileSync(new URL("./northfield-invoice-lines.json", import.meta.url), "utf8"));

export const NORTHFIELD_CONTRACT = Object.freeze({
  id: "c-northfield", facility: "Synthetic Medical Center", agency: "Synthetic Locums", payModel: "stipend",
  callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, orientationHourlyRate: 250,
  hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [{ start: "2026-10-16", end: "2026-10-19" }],
});

const localDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The entries behind NORTHFIELD.lines: one per timed line, stamped with its call day. Call TZ must be America/Chicago. */
export function northfieldEntries(contractId = NORTHFIELD_CONTRACT.id) {
  const out = [];
  for (const l of NORTHFIELD.lines) {
    const [callDay, , start] = l._sort.split("~");
    if (!start) continue; // a day's money line, not an entry
    const label = l.label.startsWith("\u{b7} ") ? l.label.slice(2) : l.label;
    const at = label.indexOf(": ");
    const type = at < 0 ? label : label.slice(0, at);
    const description = at < 0 ? "" : label.slice(at + 2);
    const billedMin = Number(l.detail.match(/(\d+) min/)[1]);
    const startMs = new Date(start).getTime();
    // A call is a minute or two on the clock and bills its 15-minute minimum.
    const durationMin = type === "Call" ? 2 : billedMin;
    out.push({
      id: `northfield-${String(out.length + 1).padStart(2, "0")}`, createdAt: `2026-10-19T12:00:${String(out.length).padStart(2, "0")}Z`,
      contractId, type, date: localDay(start), callDay, startTime: start,
      endTime: new Date(startMs + durationMin * 60000).toISOString(), durationMin, billedMin,
      description, privateNote: "", invoiceId: null,
    });
  }
  return out;
}
