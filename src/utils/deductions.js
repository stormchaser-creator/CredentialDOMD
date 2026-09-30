/**
 * Deduction aggregation shared by the Finance ledger and the tax estimator.
 * Auto items are derived from data the app already holds: license renewal
 * costs, DEA fees, malpractice premiums, CME costs, society dues, and the
 * unreimbursed share of travel expenses billed to an agency. Manual +
 * imported items live in data.deductibles. Nothing is invented: software
 * subscriptions (this app included) are entered by the user once actually
 * paid.
 */

export function autoDeductions(data, year) {
  const items = [];
  const y = String(year);

  (data.licenses || []).forEach((l) => {
    const cost = parseFloat(l.renewalCost || l.cost || l.renewalFee || 0);
    if (cost > 0 && l.expirationDate?.startsWith(y)) {
      const isDea = /dea/i.test(l.type || l.name || "");
      items.push({
        source: "auto", date: l.expirationDate,
        category: isDea ? "DEA registration" : "License renewal fee",
        description: `${l.type || l.name || "License"}${l.state ? ` - ${l.state}` : ""}${l.licenseNumber ? ` #${l.licenseNumber}` : ""}`,
        amount: cost, taxYear: y,
      });
    }
  });

  (data.memberships || []).forEach((m) => {
    const cost = parseFloat(m.cost || 0);
    // Dues recur annually while the membership is current
    const active = !m.endDate || m.endDate >= `${y}-01-01`;
    if (cost > 0 && active) {
      items.push({
        source: "auto", date: m.expirationDate?.startsWith(y) ? m.expirationDate : `${y}-12-31`,
        category: "Professional society dues",
        description: `${m.organization || "Society"} annual dues`,
        amount: cost, taxYear: y,
      });
    }
  });

  (data.insurance || []).forEach((ins) => {
    const cost = parseFloat(ins.premium || ins.cost || 0);
    if (cost > 0 && (ins.expirationDate?.startsWith(y) || ins.policyYear === y)) {
      items.push({
        source: "auto", date: ins.expirationDate || `${y}-12-31`,
        category: "Malpractice premium",
        description: `${ins.name || ins.type || "Malpractice"}${ins.provider ? ` - ${ins.provider}` : ""}`,
        amount: cost, taxYear: y,
      });
    }
  });

  (data.cme || []).forEach((c) => {
    const cost = parseFloat(c.cost || 0);
    if (cost > 0 && (c.completionDate?.startsWith(y) || c.date?.startsWith(y))) {
      items.push({
        source: "auto", date: c.completionDate || c.date,
        category: "CME course",
        description: c.title || c.name || "CME activity",
        amount: cost, taxYear: y,
      });
    }
  });

  // Unreimbursed travel expenses: real cash out of pocket, but only the
  // portion the agency didn't pay back. Nothing counts until the linked
  // invoice has settled in some way (a payment landed or it was written
  // off) — an invoice still fully open might still be paid in full, so
  // there's nothing to deduct yet. A payment is apportioned across the
  // invoice's expense lines by each line's share of the invoice total,
  // since the ledger tracks payments per invoice, not per line.
  (data.travelExpenses || []).forEach((exp) => {
    const cost = parseFloat(exp.amount) || 0;
    if (cost <= 0 || !exp.date?.startsWith(y) || !exp.invoiceId) return;
    const inv = (data.invoices || []).find((i) => i.id === exp.invoiceId);
    if (!inv) return;
    const total = parseFloat(inv.totalAmount) || 0;
    const ledgerPaid = (inv.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const paid = ledgerPaid > 0 ? ledgerPaid : (inv.paidAt ? total : 0);
    if (!inv.writeOffAt && paid <= 0) return; // still open — may yet be paid in full
    const reimbursed = total > 0 ? Math.min(cost, paid * (cost / total)) : 0;
    const unreimbursed = Math.max(0, cost - reimbursed);
    if (unreimbursed <= 0.005) return;
    items.push({
      source: "auto", date: exp.date,
      category: /meals/i.test(exp.category || "") ? "Meals (50% deductible, travel)" : "Unreimbursed travel expense",
      description: `${exp.category || "Expense"}${exp.vendor ? `, ${exp.vendor}` : ""}${inv.number ? ` (${inv.number})` : ""}`,
      amount: unreimbursed, taxYear: y,
    });
  });

  return items;
}

/** Auto + manual/imported for a year, newest first. */
export function allDeductions(data, year) {
  const y = String(year);
  const manual = (data.deductibles || [])
    .filter((d) => d.taxYear === y)
    .map((m) => ({ ...m, source: m.source || "manual" }));
  return [...autoDeductions(data, y), ...manual]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// One CSV cell, always quoted with inner quotes doubled, so a comma in a
// category ("Equipment (computer, capitalize or Section 179)") or a
// description never shifts the columns a CPA reads. A text cell that starts
// like a formula (=, +, -, @) is prefixed with ' so a spreadsheet shows it
// instead of running it: descriptions come from imported statements. Numbers
// are left as numbers, so a negative amount stays -12.5.
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The deduction ledger as a CSV file's text: Date, Category, Description,
 * Amount, Source. `label` turns a stored category into its shown name. The
 * byte-order mark lets Excel read the dashes in the travel categories.
 */
export function deductionsCsv(items, label = (c) => c) {
  const headers = ["Date", "Category", "Description", "Amount", "Source"];
  const rows = (items || []).map(i => [
    i.date || "",
    label(i.category) || "",
    i.description || "",
    Number.isFinite(parseFloat(i.amount)) ? parseFloat(i.amount) : "",
    i.source || "",
  ]);
  return "﻿" + [headers, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
