import { memo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import DeductionMemo from "./DeductionMemo";
import TaxPrep from "./TaxPrep";

/**
 * Finance — two views of the same money: what's deductible (the ledger
 * the CPA gets) and what's owed (the multistate tax estimate + payment
 * tracker built on top of it).
 */
function FinanceSection() {
  const { theme: T } = useApp();
  const [tab, setTab] = useState("tax");
  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{
      flex: 1, padding: "10px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
      border: `1px solid ${tab === id ? T.accent : T.border}`,
      backgroundColor: tab === id ? (T.accentDim || "rgba(16,185,129,0.14)") : "transparent",
      color: tab === id ? T.accent : T.textMuted,
    }}>{label}</button>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <TabBtn id="tax" label="Tax Prep" />
        <TabBtn id="deductions" label="Deductions" />
      </div>
      {tab === "tax" ? <TaxPrep /> : <DeductionMemo />}
    </div>
  );
}

export default memo(FinanceSection);
