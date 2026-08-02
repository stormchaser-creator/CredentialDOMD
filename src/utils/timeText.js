/**
 * Fast exact-time entry parsing, shared by the Work tab and the To do
 * list. Accepts "808", "8:08", "8:08p", "808p", or 24-hour "2008"; a typed
 * a/p suffix wins over the AM/PM chips and hours above 12 are read as
 * 24-hour. Never guesses a meridiem.
 */

export function parseTimeText(raw, ap) {
  const t = String(raw || "").toLowerCase().replace(/[^0-9ap]/g, "");
  const m = t.match(/^(\d{1,4})(a|p)?$/);
  if (!m) return null;
  const d = m[1];
  const suf = m[2] || null;
  let h, min;
  if (d.length <= 2) { h = +d; min = 0; }
  else { h = +d.slice(0, -2); min = +d.slice(-2); }
  if (h > 23 || min > 59) return null;
  if (h <= 12) {
    const mer = suf || ap;
    if (!mer) return null; // ambiguous without AM/PM
    if (mer === "p" && h < 12) h += 12;
    if (mer === "a" && h === 12) h = 0;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
export function fmt12(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

