// Tax prep at desk width renders the same numbers the phone cards show.
// src/components/features/locum/TaxPrep.jsx is bundled through the project's
// own esbuild with useApp and StatementImport stubbed, rendered twice from
// one fixture (scripts/fixtures/tax-prep-fixture.mjs) with isDesktop false
// and true, and every figure asserted in both markups comes from the app's
// own engine (utils/taxEngine + utils/taxLedger), never typed by hand. The
// ledger helper is checked directly as well, so a drift between what the
// phone card and the desk table compute fails here before it reaches a screen.
// Run: node scripts/tax-prep-desk.test.mjs   (pure node, no test runner)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixture, theme } from "./fixtures/tax-prep-fixture.mjs";
import { incomeByState, deductionTotal, estimate } from "../src/utils/taxEngine.js";
import { autoDeductions, allDeductions } from "../src/utils/deductions.js";
import { paymentsForYear, collectedByState, jurisdictionRows, incomeTableRows, ledgerTotals } from "../src/utils/taxLedger.js";
import { TAX_YEAR } from "../src/utils/taxConstants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "components", "features", "locum", "TaxPrep.jsx");
const tmpPath = path.join(here, ".tax-prep-desk.tmp.mjs");

// Same formatting the component uses, so the assertions match its strings.
const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const seq = (html, needles) => { let pos = 0; for (const n of needles) { const i = html.indexOf(n, pos); if (i < 0) return `missing ${n}`; pos = i + n.length; } return true; };
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// Cell text of every row of every <table> in the markup.
const tables = (html) => html.split("<table").slice(1).map(t =>
  t.split("<tr").slice(1).map(tr => [...tr.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(m => text(m[1]).trim()))
);

const stub = {
  name: "stub",
  setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: "app", namespace: "stub" }));
    b.onResolve({ filter: /\/StatementImport$/ }, () => ({ path: "si", namespace: "stub" }));
    b.onLoad({ filter: /^app$/, namespace: "stub" }, () => ({ contents: "export const useApp = () => globalThis.__taxPrepApp;", loader: "js" }));
    b.onLoad({ filter: /^si$/, namespace: "stub" }, () => ({ contents: "export default function StatementImport() { return null; }", loader: "js" }));
  },
};
const bundled = await build({
  entryPoints: [srcPath], bundle: true, write: false, format: "esm", platform: "node",
  jsx: "automatic", external: ["react", "react-dom", "react/jsx-runtime"], plugins: [stub], logLevel: "silent",
});
fs.writeFileSync(tmpPath, bundled.outputFiles[0].text);

try {
  const { default: TaxPrep } = await import(tmpPath);
  const render = (data, isDesktop) => {
    globalThis.__taxPrepApp = { data, theme, isDesktop, updateSettings() {}, addItem() {}, editItem() {}, deleteItem() {} };
    return renderToStaticMarkup(React.createElement(TaxPrep));
  };

  // ── The engine's own figures for the fixture ──
  const year = TAX_YEAR;
  const tp = fixture.settings.taxPrep;
  const income = incomeByState(fixture.invoices, fixture.locumContracts, year);
  const est = estimate({ income, deductions: deductionTotal(allDeductions(fixture, year)), tp });
  const payments = paymentsForYear(fixture.taxPayments, year);
  const rows = jurisdictionRows({ est, income, isScorp: true, payments });
  const totals = ledgerTotals({ est, income, payments });

  // ── Helper: the ledger rows carry the phone card's numbers ──
  ok("profile is complete so estimates show", est.ready);
  ok("rows: federal, resident, each work state, CA franchise, then the orphan payment state",
    rows.map(r => r.id).join() === "federal,CA,CO,TX,CA-franchise,ND", rows.map(r => r.id).join());
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  ok("federal row owes the engine's federal total and paid sums this year's federal payments",
    byId.federal.owed === est.fedTotal && byId.federal.paid === 60000 && byId.federal.remaining === Math.max(0, est.fedTotal - 60000));
  ok("resident row owes personal total plus SDI, as the phone's resident card shows",
    byId.CA.owed === est.resident.owed + est.sdi && byId.CA.paid === 12000);
  ok("nonresident rows owe the engine's ratio-method figure", byId.CO.owed === est.nonresident.find(n => n.state === "CO").owed && byId.CO.paid === 2500);
  ok("a no-income-tax work state estimates $0 and remains $0", byId.TX.owed === 0 && byId.TX.hasEst && byId.TX.remaining === 0);
  ok("CA franchise row owes the engine's franchise figure", byId["CA-franchise"].owed === est.franchise);
  ok("orphan payment jurisdiction stays listed with no estimate", byId.ND.hasEst === false && byId.ND.paid === 400 && byId.ND.remaining === null && byId.ND.label === "North Dakota");
  ok("last year's payment is not in this year's ledger", payments.every(p => p.id !== "p-old") && totals.paid === 74900);
  ok("income per row is the collected-by-state figure with its share", byId.CA.income === 240000 && byId.CA.pct === "48" && byId.federal.income === income.total);
  ok("federal + state totals are the headline total", Math.abs(totals.fed + totals.state - est.totalAll) < 1e-6);
  ok("headline remaining is total minus everything paid", totals.remaining === Math.max(0, est.totalAll - 74900));
  const incomeRows = incomeTableRows(rows, income);
  ok("income table appends the no-work-state row last", incomeRows.length === rows.length + 1 && incomeRows.at(-1).kind === "unassigned" && incomeRows.at(-1).income === 20000);
  ok("collected-by-state is largest first", collectedByState(income).map(r => r.state).join() === "CA,CO,TX,Unassigned");

  // ── Aug 26 unreimbursed-travel deduction: the only deduction in the fixture ──
  const auto = autoDeductions(fixture, year);
  ok("the settled travel expense yields one unreimbursed-travel auto deduction",
    auto.length === 1 && auto[0].category === "Unreimbursed travel expense" && Math.abs(auto[0].amount - 160) < 1e-9, JSON.stringify(auto));
  ok("the engine's deduction total is that share", Math.abs(est.deductions - 160) < 1e-9);

  // ── Both shapes from the same fixture ──
  const phone = render(fixture, false);
  const desk = render(fixture, true);
  ok("phone has no table; desk has exactly two", !phone.includes("<table") && (desk.match(/<table/g) || []).length === 2);

  const [t1, t2] = tables(desk);
  ok("table 1 columns are the spec's, in order", t1[0].join("|") === "Jurisdiction|Income|Est. federal|Est. state|Paid|Remaining|Actions", t1[0].join("|"));
  ok("table 2 columns are the spec's, in order, sorted by Date descending",
    t2[0].join("|") === "Date ▼|Jurisdiction|Amount|Note|Actions", t2[0].join("|"));

  // Every jurisdiction row: label, estimate, paid and remaining are the same
  // strings on the phone ledger card and in the desk table.
  for (const r of rows) {
    const deskRow = t1.find(c => c[0] === r.label);
    ok(`desk row for ${r.id} exists`, !!deskRow);
    if (!deskRow) continue;
    const phoneLine = r.hasEst
      ? `est ${money(r.owed)} · paid ${money(r.paid)} · <b style="color:${r.remaining > 0 ? theme.warning : theme.success}">${money(r.remaining)} left</b>`
      : `paid ${money(r.paid)} · no estimate (state model not loaded)`;
    ok(`phone ledger shows ${r.id}`, seq(phone, [r.label, phoneLine]) === true, phoneLine);
    const estCol = r.kind === "federal" ? 2 : 3;
    ok(`desk ${r.id}: estimate under the ${r.kind === "federal" ? "federal" : "state"} column`,
      deskRow[estCol] === (r.hasEst ? money(r.owed) : "no estimate") && deskRow[estCol === 2 ? 3 : 2] === "—", deskRow.join("|"));
    ok(`desk ${r.id}: paid and remaining match the phone`,
      deskRow[4] === money(r.paid) && deskRow[5] === (r.hasEst ? money(r.remaining) : "—"), deskRow.join("|"));
    ok(`desk ${r.id}: income is the collected figure`,
      r.income == null ? deskRow[1] === "—" : deskRow[1].startsWith(money2(r.income)), deskRow.join("|"));
    ok(`desk ${r.id}: Record action`, deskRow[6] === "Record");
  }
  // Collected income by state: the phone's mini-card lines and the desk cells.
  for (const r of collectedByState(income)) {
    const label = r.state === "Unassigned" ? "No work state on contract" : `${r.state}, ${r.state}`;
    ok(`phone lists ${r.state} collected with its share`, phone.includes(`${money2(r.amount)} (${r.pct}%)`), label);
    const deskRow = t1.find(c => c[1].startsWith(money2(r.amount)));
    ok(`desk lists ${r.state} collected with the same share`, !!deskRow && deskRow[1].includes(`${r.pct}% of gross`), deskRow?.join("|"));
  }
  const unassigned = t1.find(c => c[0] === "No work state on contract");
  ok("no-work-state row: income only, nothing estimated, no Record action",
    !!unassigned && unassigned.slice(2, 7).join("|") === "—|—|—|—|", unassigned?.join("|"));
  ok("the unassigned-invoice warning stays on both shapes",
    phone.includes("Set a work state on the contract for: INV-004") && desk.includes("Set a work state on the contract for: INV-004"));

  // Totals row carries the headline figures the phone shows.
  const total = t1.find(c => c[0] === "Total");
  ok("totals row: gross collected, federal, state, paid, remaining",
    !!total && total.slice(1, 6).join("|") === [money2(totals.income), money(totals.fed), money(totals.state), money(totals.paid), money(totals.remaining)].join("|"), total?.join("|"));
  ok("totals row is the last row of table 1", t1.at(-1)[0] === "Total");
  ok("phone headline shows the same total, paid and remaining",
    seq(phone, [money(est.totalAll), `${money(totals.paid)} paid`, `${money(totals.remaining)} remaining`]) === true);
  ok("desk headline is unchanged", seq(desk, [money(est.totalAll), `${money(totals.paid)} paid`, `${money(totals.remaining)} remaining`]) === true);
  ok("gross collected and net profit appear on both", ["Gross collected", money2(income.total), "Net business profit", money2(est.profit)].every(s => phone.includes(s) && desk.includes(s)));
  ok("the deduction line, with the unreimbursed travel share, appears on both",
    phone.includes(`− ${money2(est.deductions)}`) && desk.includes(`− ${money2(est.deductions)}`));
  ok("the federal and state breakdown cards render on both",
    ["Federal total", "CA SDI on salary", "Credit for tax paid to work states", "CO-source income", "TX-source income"].every(s => phone.includes(s) && desk.includes(s)));

  // Table 2: every payment this year, newest first, labelled by jurisdiction.
  const ledger = t2.slice(1);
  ok("table 2 has one row per payment this year", ledger.length === payments.length && !desk.includes("must not appear"));
  const dates = ledger.map(c => c[0]);
  ok("table 2 rows run newest first", dates.join("|") === "Jun 15, 2026|Jun 15, 2026|Apr 15, 2026|Apr 15, 2026|Jan 15, 2026", dates.join("|"));
  for (const p of payments) {
    const row = ledger.find(c => c[1] === byId[p.jurisdiction].label && c[2] === money2(p.amount) && c[3] === (p.note || "—"));
    ok(`table 2 row for ${p.id}: jurisdiction label, amount, note`, !!row, JSON.stringify(ledger));
    ok(`phone ledger lists ${p.id}`, phone.includes(`${money2(p.amount)}`) && (!p.note || phone.includes(` · ${p.note}`)));
  }
  ok("table 2 actions are edit and delete", (desk.match(/aria-label="Edit payment"/g) || []).length === payments.length && (desk.match(/aria-label="Delete payment"/g) || []).length === payments.length);
  ok("copy around the tables is unchanged", ["Planning estimate.", "the unreimbursed share of a settled travel expense is deducted instead", "Filing profile", "Assumptions"].every(s => desk.includes(s)));

  // ── No filing profile: nothing is estimated on either shape ──
  const blank = { ...fixture, settings: { taxPrep: {} } };
  const phone0 = render(blank, false);
  const desk0 = render(blank, true);
  ok("no profile: both shapes ask for it", [phone0, desk0].every(h => h.includes("Set your resident state and filing status to see estimates.")));
  const [b1] = tables(desk0);
  ok("no profile: estimate and remaining cells are dashes, paid still shows",
    b1.slice(1).every(c => c[2] === "—" && c[3] === "—" && c[5] === "—") && b1.find(c => c[0] === "Federal (IRS)")[4] === "$60,000", JSON.stringify(b1));
  ok("no profile: phone ledger shows paid only", phone0.includes("paid $60,000</div>") && !phone0.includes("no estimate"));

  // ── No payments yet: the ledger table gives way to a note ──
  const desk1 = render({ ...fixture, taxPayments: [] }, true);
  ok("no payments: one table and the empty note", (desk1.match(/<table/g) || []).length === 1 && desk1.includes(`No estimated payments recorded for ${year} yet.`));
} finally {
  fs.rmSync(tmpPath, { force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
