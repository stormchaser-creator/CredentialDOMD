// Unit checks for src/utils/formLayout.js, the desk-width two-across form
// flow. Phone never calls it; these pin the pairing rules against
// realistic CrudSection field configs.
// Run: node scripts/form-layout.test.mjs
import { formRows, isShortField } from "../src/utils/formLayout.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL: ${name}${extra ? " :: " + extra : ""}`); }
};
const shape = (rows) => rows.map(r => r.map(f => f.key).join("+")).join(" | ");

// isShortField
ok("a date is short", isShortField({ key: "issuedDate", type: "date" }));
ok("a currency is short", isShortField({ key: "cost", type: "currency" }));
ok("a number is short", isShortField({ key: "hours", type: "number" }));
ok("the state select is short", isShortField({ key: "state", type: "select", options: ["CA", "CO"] }));
ok("a yes/no select is short", isShortField({ key: "active", type: "select", options: ["Yes", "No"] }));
ok("a long-option select is wide", !isShortField({ key: "category", type: "select", options: ["Craniotomy - Tumor", "Spinal Fusion"] }));
ok("a plain text field is wide", !isShortField({ key: "name", type: "text" }));
ok("a hint forces the full measure", !isShortField({ key: "cost", type: "currency", hint: "What the board charges to renew." }));
ok("an explicit short flag wins", isShortField({ key: "notes", type: "textarea", short: true }));
ok("an explicit short:false wins", !isShortField({ key: "issuedDate", type: "date", short: false }));
ok("undefined is not short", !isShortField(undefined));

// formRows
{
  const fields = [
    { key: "type", type: "text" },
    { key: "issuedDate", type: "date" },
    { key: "expirationDate", type: "date" },
    { key: "state", type: "select", options: ["CA", "CO"] },
    { key: "cost", type: "currency" },
    { key: "notes", type: "textarea" },
  ];
  const rows = formRows(fields);
  ok("a license config pairs its two dates and state+cost",
    shape(rows) === "type | issuedDate+expirationDate | state+cost | notes", shape(rows));
  ok("every field survives the flow", rows.flat().length === fields.length);
  ok("order is preserved", rows.flat().map(f => f.key).join(",") === fields.map(f => f.key).join(","));
}
{
  const rows = formRows([{ key: "name", type: "text" }, { key: "date", type: "date" }, { key: "notes", type: "textarea" }]);
  ok("a lone short field keeps its own row", shape(rows) === "name | date | notes", shape(rows));
}
{
  const rows = formRows([{ key: "a", type: "date" }, { key: "b", type: "date" }, { key: "c", type: "date" }]);
  ok("three shorts pair then leave a single", shape(rows) === "a+b | c", shape(rows));
}
{
  const rows = formRows([{ key: "a", type: "date" }, { key: "wide", type: "text" }, { key: "b", type: "date" }]);
  ok("a wide field breaks a pair", shape(rows) === "a | wide | b", shape(rows));
}
ok("no fields gives no rows", formRows([]).length === 0);
ok("undefined gives no rows", formRows(undefined).length === 0);
ok("a hint field never pairs",
  shape(formRows([{ key: "cost", type: "currency", hint: "board fee" }, { key: "date", type: "date" }])) === "cost | date");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
