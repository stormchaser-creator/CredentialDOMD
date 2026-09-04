// snapToOption, plus the guard that started it: the document scanner is told
// which values to return, and those strings must exist verbatim in the form
// that receives them. They drifted by one apostrophe and a physician ended up
// with two "Driver's License" entries that were different types.
// Run: node scripts/snap-option.test.mjs
import fs from "fs";
import { snapToOption, snapFields } from "../src/utils/snapOption.js";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) pass++; else { fail++; console.log(`FAIL ${n} ${x}`); } };
const OPTS = ["Driver’s License", "Passport", "Known Traveler (TSA PreCheck)", "Global Entry", "Other"];

ok("an exact value is untouched", snapToOption("Passport", OPTS) === "Passport");
ok("a straight apostrophe snaps to the curly option",
  snapToOption("Driver's License", OPTS) === "Driver’s License", snapToOption("Driver's License", OPTS));
ok("case alone snaps", snapToOption("passport", OPTS) === "Passport");
ok("shouting snaps", snapToOption("DRIVER’S LICENSE", OPTS) === "Driver’s License");
ok("surrounding space snaps", snapToOption("  Passport ", OPTS) === "Passport");
ok("a value the list does not have is returned untouched",
  snapToOption("REAL ID", OPTS) === "REAL ID");
ok("an empty value is untouched", snapToOption("", OPTS) === "");
ok("a null value is untouched", snapToOption(null, OPTS) === null);
ok("no options means no change", snapToOption("Passport", []) === "Passport");
ok("a non-string is untouched", snapToOption(7, OPTS) === 7);
ok("snapFields only touches the keys it is given",
  JSON.stringify(snapFields({ type: "passport", name: "keep me" }, { type: OPTS }))
    === JSON.stringify({ type: "Passport", name: "keep me" }));

// The guard. Every value the scanner is told to return must appear verbatim
// in a form select, or the scan can never match the list.
{
  const scan = fs.readFileSync("src/utils/documentScanner.js", "utf8");
  const app = fs.readFileSync("src/App.jsx", "utf8");
  const unescape = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const formValues = new Set();
  for (const m of app.matchAll(/type: "select", options: \[([^\]]*)\]/g)) {
    for (const o of m[1].matchAll(/"([^"]+)"/g)) formValues.add(unescape(o[1]));
  }
  ok("the form select vocabularies were found at all", formValues.size > 10, `${formValues.size}`);
  const missing = [];
  for (const m of scan.matchAll(/\(MUST be one of: ([^)]*)\)/g)) {
    for (const o of m[1].matchAll(/"([^"]+)"/g)) {
      const v = unescape(o[1]);
      if (!formValues.has(v)) missing.push(v);
    }
  }
  ok("every value the scanner is told to return exists verbatim in a form select",
    missing.length === 0, missing.join(" | "));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
