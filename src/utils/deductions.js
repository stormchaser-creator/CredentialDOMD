/**
 * Deduction aggregation shared by the Finance ledger and the tax estimator.
 * Auto items are derived from data the app already holds: license renewal
 * costs, DEA fees, malpractice premiums, CME costs, society dues. Manual +
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
