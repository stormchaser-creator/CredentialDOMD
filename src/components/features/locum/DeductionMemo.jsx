/**
 * DeductionMemo — Locum tier.
 *
 * 1099 physicians can deduct credentialing-related expenses on Schedule C.
 * This view auto-aggregates known deductibles from existing app data:
 *   - State license fees (from licenses[].cost or licenses[].renewalFee)
 *   - DEA renewal fee (from licenses[] where type matches DEA)
 *   - Malpractice premiums (from insurance[])
 *   - CME course costs (from cme[].cost)
 *   - CredentialDoMD subscription itself ($228/yr Solo, $348/yr Locum)
 *
 * Plus user-entered manual line items (data.deductibles[]) for things the
 * app doesn't know about (license application fees, board exam fees, etc.)
 *
 * Export: CSV (for spreadsheet/accountant) or PDF-print (for paper records).
 */

import { useState, useMemo } from "react";
import { useApp } from "../../../context/AppContext";

function makeId() {
  return `ded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const CATEGORIES = [
  "License renewal fee",
  "License application fee",
  "DEA registration",
  "Controlled substance permit",
  "Board certification / MOC",
  "Malpractice premium",
  "Professional liability tail coverage",
  "CME course",
  "CME conference travel",
  "Medical journal subscription",
  "Software / SaaS (CredentialDoMD, Doximity, etc.)",
  "Hospital privileging fees",
  "Credentialing service fees",
  "Other deductible expense",
];

const BLANK_FORM = {
  date: new Date().toISOString().slice(0, 10),
  category: CATEGORIES[0],
  description: "",
  amount: "",
  taxYear: new Date().getFullYear().toString(),
};

export default function DeductionMemo() {
  const { data, setData, theme: T, plan } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [yearFilter, setYearFilter] = useState(new Date().getFullYear().toString());

  // Auto-derived deductibles from existing app data
  const auto = useMemo(() => {
    const items = [];

    // CredentialDoMD subscription itself
    const subAmount = plan === "locum" ? 348 : plan === "solo" ? 228 : 0;
    if (subAmount > 0) {
      items.push({
        source: "auto",
        date: `${yearFilter}-01-01`,
        category: "Software / SaaS (CredentialDoMD, Doximity, etc.)",
        description: `CredentialDoMD ${plan === "locum" ? "Locum" : "Solo"} annual subscription`,
        amount: subAmount,
        taxYear: yearFilter,
      });
    }

    // License renewals (if cost field present)
    (data.licenses || []).forEach((l) => {
      const cost = parseFloat(l.cost || l.renewalFee || 0);
      if (cost > 0 && l.expirationDate?.startsWith(yearFilter)) {
        const isDea = /dea/i.test(l.type || l.name || "");
        items.push({
          source: "auto",
          date: l.expirationDate,
          category: isDea ? "DEA registration" : "License renewal fee",
          description: `${l.type || l.name || "License"}${l.state ? ` - ${l.state}` : ""}${l.licenseNumber ? ` #${l.licenseNumber}` : ""}`,
          amount: cost,
          taxYear: yearFilter,
        });
      }
    });

    // Malpractice premiums
    (data.insurance || []).forEach((ins) => {
      const cost = parseFloat(ins.premium || ins.cost || 0);
      if (cost > 0 && (ins.expirationDate?.startsWith(yearFilter) || ins.policyYear === yearFilter)) {
        items.push({
          source: "auto",
          date: ins.expirationDate || `${yearFilter}-12-31`,
          category: "Malpractice premium",
          description: `${ins.name || ins.type || "Malpractice"}${ins.provider ? ` - ${ins.provider}` : ""}`,
          amount: cost,
          taxYear: yearFilter,
        });
      }
    });

    // CME courses with cost
    (data.cme || []).forEach((c) => {
      const cost = parseFloat(c.cost || 0);
      if (cost > 0 && (c.completionDate?.startsWith(yearFilter) || c.date?.startsWith(yearFilter))) {
        items.push({
          source: "auto",
          date: c.completionDate || c.date,
          category: "CME course",
          description: c.title || c.name || "CME activity",
          amount: cost,
          taxYear: yearFilter,
        });
      }
    });

    return items;
  }, [data, plan, yearFilter]);

  // Manual deductibles for the selected year
  const manual = (data.deductibles || []).filter((d) => d.taxYear === yearFilter);

  const all = [...auto, ...manual.map((m) => ({ ...m, source: "manual" }))]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const total = all.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

  const byCategory = all.reduce((acc, i) => {
    acc[i.category] = (acc[i.category] || 0) + (parseFloat(i.amount) || 0);
    return acc;
  }, {});

  const save = () => {
    if (!form.amount || !form.description) return;
    setData((d) => ({
      ...d,
      deductibles: [
        ...(d.deductibles || []),
        { id: makeId(), ...form, amount: parseFloat(form.amount) || 0 },
      ],
    }));
    setForm(BLANK_FORM);
    setShowForm(false);
  };

  const removeManual = (id) => {
    if (!window.confirm("Remove this deduction line?")) return;
    setData((d) => ({
      ...d,
      deductibles: (d.deductibles || []).filter((x) => x.id !== id),
    }));
  };

  const exportCSV = () => {
    const headers = ["Date", "Category", "Description", "Amount", "Source"];
    const rows = all.map((i) => [
      i.date || "",
      i.category || "",
      `"${(i.description || "").replace(/"/g, '""')}"`,
      i.amount,
      i.source,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `credentialdomd-deductions-${yearFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPDF = () => {
    window.print();
  };

  const taxYears = [...new Set([yearFilter, ...(data.deductibles || []).map((d) => d.taxYear)])].sort().reverse();

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-start", marginBottom: 12, gap: 8,
      }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 2px" }}>
            1099 Deduction Memo
          </h3>
          <p style={{ fontSize: 12, color: T.textMuted, margin: 0 }}>
            Itemized credentialing-related deductibles for Schedule C.
          </p>
        </div>
        <select
          value={yearFilter}
          onChange={(e) => setYearFilter(e.target.value)}
          style={{
            padding: "6px 10px", borderRadius: 8,
            backgroundColor: T.input, border: `1px solid ${T.border}`,
            color: T.text, fontSize: 13, fontWeight: 600,
          }}
        >
          {taxYears.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {/* Summary card */}
      <div style={{
        backgroundColor: T.card, border: `2px solid ${T.accent}`,
        borderRadius: 12, padding: "14px 16px", marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
          Tax year {yearFilter} total
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, color: T.accent }}>
          ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
          {all.length} line item{all.length === 1 ? "" : "s"} ·{" "}
          At a 32% effective rate (federal + state + SE), this saves ~${(total * 0.32).toFixed(0)}.
        </div>
      </div>

      {/* By category */}
      {Object.keys(byCategory).length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            By category
          </div>
          {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
            <div key={cat} style={{
              display: "flex", justifyContent: "space-between",
              padding: "6px 10px", borderBottom: `1px solid ${T.borderSubtle || T.border}`,
              fontSize: 13,
            }}>
              <span style={{ color: T.text }}>{cat}</span>
              <span style={{ color: T.text, fontWeight: 600 }}>${amt.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button
          onClick={() => setShowForm(true)}
          style={{
            flex: 1, padding: "10px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}
        >
          + Add line item
        </button>
        <button
          onClick={exportCSV}
          disabled={all.length === 0}
          style={{
            padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text,
            fontSize: 13, fontWeight: 600, cursor: all.length ? "pointer" : "not-allowed",
            opacity: all.length ? 1 : 0.5,
          }}
        >
          Export CSV
        </button>
        <button
          onClick={printPDF}
          disabled={all.length === 0}
          style={{
            padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text,
            fontSize: 13, fontWeight: 600, cursor: all.length ? "pointer" : "not-allowed",
            opacity: all.length ? 1 : 0.5,
          }}
        >
          Print
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <DeductionForm
          form={form}
          setForm={setForm}
          onSave={save}
          onCancel={() => { setForm(BLANK_FORM); setShowForm(false); }}
          T={T}
        />
      )}

      {/* Items */}
      <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Line items ({all.length})
      </div>
      {all.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "30px 20px",
          color: T.textMuted, fontSize: 13,
          backgroundColor: T.card, borderRadius: 12, border: `1px dashed ${T.border}`,
        }}>
          No deductible expenses logged for {yearFilter} yet. Auto-import pulls from your licenses, insurance,
          and CME entries that have a cost recorded.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {all.map((i, idx) => (
            <div
              key={i.id || `auto-${idx}`}
              style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "10px 12px",
                display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{i.description}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  {i.category} · {i.date}
                  {i.source === "auto" && (
                    <span style={{
                      marginLeft: 6, fontSize: 10, padding: "1px 6px",
                      borderRadius: 6, backgroundColor: T.input, color: T.textMuted,
                    }}>auto</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                  ${parseFloat(i.amount).toFixed(2)}
                </span>
                {i.source === "manual" && i.id && (
                  <button
                    onClick={() => removeManual(i.id)}
                    style={{
                      padding: "2px 8px", borderRadius: 6, border: "none",
                      backgroundColor: T.input, color: "#ef4444",
                      fontSize: 11, fontWeight: 600, cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Disclaimer */}
      <div style={{
        marginTop: 16, padding: "10px 12px",
        backgroundColor: T.input, borderRadius: 8,
        fontSize: 11, color: T.textMuted, lineHeight: 1.5,
      }}>
        Not tax advice. Confirm with your CPA. Auto-imported items pull from records where you logged a
        <code style={{ padding: "0 4px" }}>cost</code> field. Items without an amount aren't included.
      </div>
    </div>
  );
}

function DeductionForm({ form, setForm, onSave, onCancel, T }) {
  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const inputStyle = {
    width: "100%", padding: "8px 10px",
    backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
    borderRadius: 8, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box",
  };
  return (
    <div style={{
      backgroundColor: T.card, border: `1px solid ${T.accent}`,
      borderRadius: 12, padding: 14, marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>
        New deduction line
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <select style={inputStyle} value={form.category} onChange={update("category")}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input style={inputStyle} placeholder="Description (e.g., Texas medical license app fee)" value={form.description} onChange={update("description")} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px", gap: 8 }}>
          <input style={inputStyle} type="date" value={form.date} onChange={update("date")} />
          <input style={inputStyle} type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={update("amount")} />
          <input style={inputStyle} placeholder="Year" maxLength={4} value={form.taxYear} onChange={update("taxYear")} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={onSave}
          disabled={!form.amount || !form.description}
          style={{
            flex: 1, padding: "10px", borderRadius: 8, border: "none",
            backgroundColor: form.amount && form.description ? T.accent : T.textDim,
            color: "#fff", fontSize: 13, fontWeight: 700,
            cursor: form.amount && form.description ? "pointer" : "not-allowed",
          }}
        >
          Add
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: "10px 16px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text,
            fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
