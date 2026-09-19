/**
 * LocumDashboard — top-level Locum tier view.
 *
 * Work, RVUs, schedule, invoices, contracts, expenses and to-do tools.
 * The multi-state license matrix lives under Credentials.
 * useSubscription grants the locum tier during the invite-only beta.
 * Other tiers see the planned offer; this page never starts checkout.
 */

import { useEffect, useState } from "react";
import { useApp } from "../../../context/AppContext";
import TaskNotes from "./TaskNotes";
import WorkLog from "./WorkLog";
import Contracts from "./Contracts";
import Expenses from "./Expenses";
import Schedule from "./Schedule";
import Invoices from "./Invoices";
import RVULog from "./RVULog";
import { BASE_KEYS, lsSet } from "../../../utils/storageScope";
import { MEMBERSHIP_COPY } from "../../../content/membershipCopy";

const SUBTABS = [
  { id: "work", label: "Work" },
  { id: "rvus", label: "RVUs" },
  { id: "schedule", label: "Sched." },
  { id: "invoices", label: "Invoices" },
  { id: "contracts", label: "Contracts" },
  { id: "expenses", label: "Exp." },
  { id: "todo", label: "To do" },
];

export default function LocumDashboard({ initialSub, focusId, onFocusConsumed }) {
  const { theme: T, plan, isDevMode } = useApp();
  const [sub, setSub] = useState(initialSub || "work");
  // Home search can land here on a specific sub-view (contracts, invoices...).
  useEffect(() => { if (initialSub) setSub(initialSub); }, [initialSub]);
  useEffect(() => { if (focusId) onFocusConsumed?.(); }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [billDraft, setBillDraft] = useState(null);

  const isLocum = plan === "locum" || isDevMode;

  if (!isLocum) {
    return <UpgradeCard T={T} />;
  }

  return (
    <div>
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

      {/* WorkLog owns the contract picker and swaps its engine per contract:
          time-priced agreements get the timer/time log, the day-rate
          agreement gets days-and-call logging (DutyLog). */}
      {sub === "work" && <WorkLog billDraft={billDraft} onBillDraftDone={() => setBillDraft(null)} />}
      {sub === "rvus" && <RVULog />}
      {sub === "schedule" && <Schedule />}
      {sub === "invoices" && (
        <Invoices onOpenContract={(contractId) => { lsSet(BASE_KEYS.lastContract, contractId); setSub("work"); }} />
      )}
      {sub === "contracts" && <Contracts />}
      {sub === "expenses" && <Expenses />}
      {sub === "todo" && <TaskNotes onBill={(d) => { setBillDraft(d); setSub("work"); }} />}
    </div>
  );
}

function UpgradeCard({ T }) {
  return (
    <div>
      <div style={{
        backgroundColor: T.card, border: `2px dashed ${T.accent}`,
        borderRadius: 14, padding: "20px 18px",
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>
          Practice tools
        </div>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, margin: "0 0 12px" }}>
          {MEMBERSHIP_COPY.fullPackage} Practice includes contracts, work logs, invoices,
          payment tracking and expenses. {MEMBERSHIP_COPY.practiceTrial}
        </p>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, margin: "0 0 12px" }}>
          Billing is off. Invited beta accounts have access; if these tools are missing
          from your beta account, use Get help.
        </p>
        <a
          href="/locums"
          style={{
            padding: "10px 16px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff",
            fontSize: 12, fontWeight: 700, cursor: "pointer", display: "inline-block", textDecoration: "none",
          }}
        >
          See the locum workflow
        </a>
      </div>
    </div>
  );
}
