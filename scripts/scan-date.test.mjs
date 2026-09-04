// Dates coming back from a document scan. A CME certificate printed
// "Date of Completion: 07/25/26" is the commonest way the reader goes wrong:
// the year is two digits and the model either keeps it or invents a century.
// Run: node scripts/scan-date.test.mjs
import { normalizeScanDate } from "../src/utils/scanDates.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); } };

eq("a good ISO date is untouched", normalizeScanDate("2026-07-25"), "2026-07-25");
eq("the certificate's own format", normalizeScanDate("07/25/26"), "2026-07-25");
eq("single digit month and day", normalizeScanDate("7/5/26"), "2026-07-05");
eq("a four digit year in slashes", normalizeScanDate("07/25/2026"), "2026-07-25");
eq("dashes instead of slashes", normalizeScanDate("07-25-26"), "2026-07-25");
eq("a century the model invented", normalizeScanDate("0026-07-25"), "2026-07-25");
eq("the 1980s pivot", normalizeScanDate("06/01/85"), "1985-06-01");
eq("the 2079 boundary stays this century", normalizeScanDate("01/01/79"), "2079-01-01");
eq("80 goes to the last century", normalizeScanDate("01/01/80"), "1980-01-01");
eq("an impossible month is left alone", normalizeScanDate("13/25/26"), "13/25/26");
eq("an impossible day is left alone", normalizeScanDate("07/45/26"), "07/45/26");
eq("free text is left alone", normalizeScanDate("June 24-25, 2026"), "June 24-25, 2026");
eq("an empty string is left alone", normalizeScanDate(""), "");
eq("a non-string is left alone", normalizeScanDate(null), null);
eq("whitespace is tolerated", normalizeScanDate("  07/25/26 "), "2026-07-25");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
