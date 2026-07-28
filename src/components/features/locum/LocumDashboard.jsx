/**
 * LocumDashboard — top-level Locum tier view.
 *
 * Sub-tabs:
 *   1. Work       — call timer + time log
 *   2. Contracts  — facility agreements
 *   3. Deductions — 1099 expense ledger + export
 * (The multi-state license matrix lives under Credentials — it is core
 * multi-license tracking, not locum-specific.)
 *
 * Visible only when subscription tier === "locum". Solo/Free/Practice users
 * who land here get a friendly upsell card.
 */

import { useState } from "react";
import { useApp } from "../../../context/AppContext";
import DeductionMemo from "./DeductionMemo";
import WorkLog from "./WorkLog";
import Contracts from "./Contracts";
import Schedule from "./Schedule";
import Invoices from "./Invoices";
import RVULog from "./RVULog";

const SUBTABS = [
  { id: "work", label: "Work" },
  { id: "rvus", label: "RVUs" },
  { id: "schedule", label: "Sched." },
  { id: "invoices", label: "Invoices" },
  { id: "contracts", label: "Contracts" },
  { id: "deductions", label: "Deduct." },
];

export default function LocumDashboard() {
  const { theme: T, plan, isDevMode } = useApp();
  const [sub, setSub] = useState("work");

  const isLocum = plan === "locum" || isDevMode;

  if (!isLocum) {
    return <UpgradeCard T={T} />;
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: T.text }}>
          Locum
        </h2>
        <p style={{ margin: 0, fontSize: 12, color: T.textMuted }}>
          Tools built for physicians who hold multiple state licenses.
        </p>
      </div>

      {/* Sub-tab nav */}
      <div style={{
        display: "flex", gap: 4, marginBottom: 16,
        backgroundColor: T.input, borderRadius: 10, padding: 3,
      }}>
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            style={{
              flex: 1, minWidth: 0, padding: "8px 2px", borderRadius: 8, border: "none",
              backgroundColor: sub === t.id ? T.card : "transparent",
              color: sub === t.id ? T.text : T.textMuted,
              fontSize: 11.5, fontWeight: 700, cursor: "pointer",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              boxShadow: sub === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
              transition: "all 0.15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "work" && <WorkLog />}
      {sub === "rvus" && <RVULog />}
      {sub === "schedule" && <Schedule />}
      {sub === "invoices" && <Invoices />}
      {sub === "contracts" && <Contracts />}
      {sub === "deductions" && <DeductionMemo />}
    </div>
  );
}

function UpgradeCard({ T }) {
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: T.text }}>
          Locum
        </h2>
      </div>
      <div style={{
        backgroundColor: T.card, border: `2px dashed ${T.accent}`,
        borderRadius: 14, padding: "20px 18px",
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>
          Locum tier required
        </div>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, margin: "0 0 12px" }}>
          The Locum tier ($29/mo) unlocks the multi-state license matrix, hospital
          rotation tracker, and 1099 deduction memo export. Built for physicians
          who hold 2+ state licenses and work locum or rotating assignments.
        </p>
        <button
          onClick={() => window.location.hash = "#pricing"}
          style={{
            padding: "10px 16px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}
        >
          See Locum tier features
        </button>
      </div>
    </div>
  );
}
