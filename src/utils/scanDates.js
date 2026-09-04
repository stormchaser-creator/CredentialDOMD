// Every date field a scan can return. A certificate written 07/25/26 is the
// commonest way a reader goes wrong: the model either keeps the two-digit
// year or invents the century. This repairs the result rather than trusting
// the prompt, and leaves anything already sane untouched.
const DATE_FIELDS = [
  "date", "issuedDate", "expirationDate", "appointmentDate", "effectiveDate",
  "dateAdministered", "graduationDate", "startDate", "endDate",
];

export function normalizeScanDate(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t) return v;
  // YYYY-MM-DD with a plausible year: leave it alone.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1900 && y <= 2100) return t;
    // A year the model mangled from two digits, e.g. 0026-07-25.
    const two = y % 100;
    const full = two <= 79 ? 2000 + two : 1900 + two;
    return `${String(full).padStart(4, "0")}-${m[2]}-${m[3]}`;
  }
  // MM/DD/YY or MM/DD/YYYY straight off the certificate.
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const mo = String(Number(m[1])).padStart(2, "0");
    const da = String(Number(m[2])).padStart(2, "0");
    let y = Number(m[3]);
    if (m[3].length === 2) y = y <= 79 ? 2000 + y : 1900 + y;
    if (Number(mo) < 1 || Number(mo) > 12 || Number(da) < 1 || Number(da) > 31) return v;
    return `${y}-${mo}-${da}`;
  }
  return v;
}

export function normalizeScanDates(extracted) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const out = { ...extracted };
  for (const f of DATE_FIELDS) if (f in out) out[f] = normalizeScanDate(out[f]);
  if (Array.isArray(out.doses)) {
    out.doses = out.doses.map((d) => (d && typeof d === "object" ? { ...d, date: normalizeScanDate(d.date) } : d));
  }
  return out;
}

