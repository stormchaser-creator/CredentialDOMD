// Render-level checks for src/components/shared/DeskTable.jsx, the shared
// desk-width table: flat sorting, and the grouping added for the work log
// (groupBy / groupDir / groupKeys / subtotal). The component is transpiled
// through the project's own esbuild with useApp stubbed, rendered with
// react-dom/server, and asserted on the markup order, so a change to row
// order, subtotal placement, or the sticky-header offset fails here before
// it reaches a screen.
// Run: node scripts/desk-table.test.mjs   (pure node, no test runner)
import { transformSync } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "components", "shared", "DeskTable.jsx");
const tmpPath = path.join(here, ".desk-table.tmp.mjs");

// The theme stub carries only the tokens DeskTable reads.
const themeStub = "data:text/javascript," + encodeURIComponent(
  'export const useApp = () => ({ theme: { card: "#fff", border: "#ddd", textDim: "#666", text: "#111", accent: "#10b981", input: "#f0fdf8", shadow1: "none" } });'
);
const src = fs.readFileSync(srcPath, "utf8").replace('"../../context/AppContext"', JSON.stringify(themeStub));
fs.writeFileSync(tmpPath, transformSync(src, { loader: "jsx", jsx: "automatic", format: "esm" }).code);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
// True when every needle appears in the html in the given order.
const seq = (html, needles) => { let pos = 0; for (const n of needles) { const i = html.indexOf(n, pos); if (i < 0) return `missing ${n}`; pos = i + n.length; } return true; };
const cellText = (html) => [...html.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(m => m[1].replace(/<[^>]+>/g, "")).filter(Boolean);

try {
  const { default: DeskTable } = await import(tmpPath);

  const items = [
    { id: "a", day: "2026-08-28", startTime: "2026-08-28T08:00:00", type: "Call", amount: 10 },
    { id: "b", day: "2026-08-28", startTime: "2026-08-28T10:00:00", type: "Rounding", amount: 20 },
    { id: "c", day: "2026-08-27", startTime: "2026-08-27T09:00:00", type: "Consult", amount: 30 },
    { id: "d", day: "2026-08-27", startTime: null, type: "Consult", amount: 5 },
  ];
  const columns = [
    { key: "startTime", label: "Date", type: "date", render: it => it.id },
    { key: "type", label: "Type" },
    { key: "amount", label: "Amount", type: "number", align: "right" },
  ];
  const grouped = (props) => renderToStaticMarkup(React.createElement(DeskTable, {
    columns, items, actions: () => "act",
    groupBy: it => it.day, groupDir: "desc", groupKeys: ["2026-08-26"],
    subtotal: (key, list) => ({ label: `Total ${key}`, cells: { amount: list.length * 100 } }),
    ...props,
  }));

  // ── Grouping ──
  const asc = grouped({ defaultSort: { key: "startTime", dir: "asc" } });
  ok("header sticks at the shell's --desk-sticky-top (56px fallback)", asc.includes("top:var(--desk-sticky-top, 56px)"));
  ok("groups order by key desc; rows in clock order; subtotal after each group; empty group renders its subtotal alone",
    seq(asc, [">a<", ">b<", "Total 2026-08-28", "200", ">c<", ">d<", "Total 2026-08-27", "200", "Total 2026-08-26", ">0<"]) === true,
    JSON.stringify(cellText(asc)));
  ok("a row missing the sorted value sinks within its own group", seq(asc, [">c<", ">d<"]) === true);
  ok("subtotal label spans the leading columns up to the first subtotal cell", (asc.match(/colSpan="2"/g) || []).length === 3, String(asc.match(/colSpan="\d"/g)));
  ok("one subtotal row per group, including the empty one", (asc.match(/cmd-desk-subtotal/g) || []).length === 3);
  ok("data rows keep the hover class", (asc.match(/cmd-desk-row/g) || []).length === 4);
  ok("subtotal cells are bold", (asc.match(/font-weight:800/g) || []).length >= 3);
  ok("subtotal rows carry an empty actions cell", (asc.match(/act</g) || []).length === 4);

  const desc = grouped({ defaultSort: { key: "startTime", dir: "desc" } });
  ok("column sort reorders rows within each group only; group order is fixed",
    seq(desc, [">b<", ">a<", "Total 2026-08-28", ">c<", ">d<", "Total 2026-08-27", "Total 2026-08-26"]) === true, JSON.stringify(cellText(desc)));

  const noSub = grouped({ subtotal: undefined });
  ok("groupBy without a subtotal renderer draws groups with no subtotal rows",
    !noSub.includes("cmd-desk-subtotal") && seq(noSub, [">a<", ">b<", ">c<", ">d<"]) === true);

  const nullSub = grouped({ subtotal: (key) => (key === "2026-08-27" ? null : { label: key }) });
  ok("a null subtotal skips that group's row", (nullSub.match(/cmd-desk-subtotal/g) || []).length === 2);

  // ── Flat table (Licenses, Invoices) unchanged ──
  const flat = (sort) => renderToStaticMarkup(React.createElement(DeskTable, { columns, items, defaultSort: sort }));
  ok("no groupBy: no subtotal rows", !flat({ key: "amount", dir: "desc" }).includes("cmd-desk-subtotal"));
  ok("no groupBy: sorts by amount desc", seq(flat({ key: "amount", dir: "desc" }), [">c<", ">b<", ">a<", ">d<"]) === true);
  ok("no groupBy: missing sort value sinks in both directions",
    seq(flat({ key: "startTime", dir: "asc" }), [">c<", ">a<", ">b<", ">d<"]) === true
    && seq(flat({ key: "startTime", dir: "desc" }), [">b<", ">a<", ">c<", ">d<"]) === true);
  ok("no groupBy: first data row has no top border", flat({ key: "amount", dir: "asc" }).indexOf("border-top:none") < flat({ key: "amount", dir: "asc" }).indexOf(">d<"));
} finally {
  fs.rmSync(tmpPath, { force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
