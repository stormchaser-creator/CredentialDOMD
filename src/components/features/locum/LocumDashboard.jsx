/**
 * LocumDashboard — top-level Locum tier view.
 *
 * Work, RVUs, schedule, invoices, contracts, expenses and to-do tools.
 * The multi-state license matrix lives under Credentials.
 * useSubscription grants the locum tier during the invite-only beta.
 * Other tiers see the planned offer; this page never starts checkout.
 */

import ReadOnlyRecords from "../ReadOnlyRecords.jsx";
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
import { loadRunningTimer } from "../../../utils/runningTimerStore.js";

const SUBTABS = [
  { id: "work", label: "Work" },
  { id: "rvus", label: "RVUs" },
  { id: "schedule", label: "Sched." },
  { id: "invoices", label: "Invoices" },
  { id: "contracts", label: "Contracts" },
  { id: "expenses", label: "Exp." },
  { id: "todo", label: "To do" },
];

const LAST_SUB_KEY = "credentialdomd.last-practice-sub";
const lastPracticeSub = () => {
  try { const v = globalThis.sessionStorage?.getItem(LAST_SUB_KEY); return SUBTABS.some(t => t.id === v) ? v : null; } catch { return null; }
};

export default function LocumDashboard({ initialSub, focusId, openContract = null, onFocusConsumed }) {
  const { theme: T, plan, isDevMode, limitedLaunch, practiceReadOnly } = useApp();
  // Home search, a sync issue, Vera or a filed receipt ("Open Expenses") can
  // land here on a specific sub-view. App passes whatever sub-page the
  // navigation named; anything that is not one of these tabs opens Work.
  const start = SUBTABS.some(t => t.id === initialSub) ? initialSub : undefined;
  // Otherwise Work while a timer runs (iOS discarded the app during a call:
  // the timer is the screen he needs), else the sub-view last on view in
  // this tab, else Work.
  const [sub, setSub] = useState(() => start || (loadRunningTimer() ? "work" : lastPracticeSub()) || "work");
  useEffect(() => {
    try { globalThis.sessionStorage?.setItem(LAST_SUB_KEY, sub); } catch { /* the next visit opens on Work */ }
  }, [sub]);
  // Invoices' "Needs invoicing" opens Work on that one contract, even on a
  // day the schedule shows another (WorkLog's openContractId). Any other way
  // into a sub-view carries no contract, so Work opens on its own default.
  // The open is also written as the contract last used (a bare id, as it
  // always was); a contract picked for today has its own slot
  // (BASE_KEYS.contractPick), which this never touches, so the next visit to
  // Work still opens on that pick.
  // Home's "not recorded" card opens Work on the agreement an invoice went
  // out from (`openContract`), the same way.
  const [openContractId, setOpenContractId] = useState(openContract || null);
  const showSub = (id) => { setOpenContractId(null); setSub(id); };
  const [openedSeed, setOpenedSeed] = useState(openContract || null);
  if ((openContract || null) !== openedSeed) {
    setOpenedSeed(openContract || null);
    if (openContract) { setOpenContractId(openContract); setSub("work"); }
  }
  useEffect(() => { if (openContract) lsSet(BASE_KEYS.lastContract, openContract); }, [openContract]);
  // A later navigation to another sub-view, while Practice stays on screen.
  const [landedOn, setLandedOn] = useState(start);
  if (start !== landedOn) { setLandedOn(start); if (start) showSub(start); }
  useEffect(() => { if (focusId || openContract) onFocusConsumed?.(); }, [focusId, openContract]); // eslint-disable-line react-hooks/exhaustive-deps
  const [billDraft, setBillDraft] = useState(null);

  const isLocum = plan === "locum" || isDevMode;

  // The archive is for a membership the server says cannot change Practice,
  // never for an old snapshot or a check still in progress (ticket fe321c16).
  if (limitedLaunch.enabled && practiceReadOnly) return <ReadOnlyRecords scope="practice" />;

  if (!isLocum) {
    return <UpgradeCard T={T} />;
  }

  return (
    <div>
      {/* Sub-tab nav. Equal widths where they fit (a desk), but never
          narrower than a label: with min-width 0 and an ellipsis every tab
          got 45 px on a 375 px phone and "Invoices" and "Contracts" read
          "Invoi..." and "Cont...". A flex item's own minimum is its label
          now, so the long two take what they need and the rest share the
          remainder; on a screen too narrow for all seven the strip scrolls
          sideways instead of cutting a word. */}
      <div style={{
        display: "flex", gap: 4, marginBottom: 16,
        backgroundColor: T.input, borderRadius: 10, padding: 3,
        overflowX: "auto", scrollbarWidth: "none",
      }}>
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            aria-pressed={sub === t.id}
            onClick={() => showSub(t.id)}
            style={{
              flex: 1, minHeight: 32, padding: "8px 2px", borderRadius: 8, border: "none",
              backgroundColor: sub === t.id ? T.card : "transparent",
              color: sub === t.id ? T.text : T.textMuted,
              fontSize: 11.5, fontWeight: 700, cursor: "pointer",
              whiteSpace: "nowrap",
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
      {sub === "work" && <WorkLog billDraft={billDraft} onBillDraftDone={() => setBillDraft(null)} openContractId={openContractId} />}
      {sub === "rvus" && <RVULog />}
      {sub === "schedule" && <Schedule />}
      {sub === "invoices" && (
        <Invoices
          onOpenContract={(contractId) => { if (contractId) lsSet(BASE_KEYS.lastContract, contractId); setOpenContractId(contractId); setSub("work"); }}
          onOpenExpenses={() => showSub("expenses")}
        />
      )}
      {sub === "contracts" && <Contracts />}
      {sub === "expenses" && <Expenses />}
      {sub === "todo" && <TaskNotes onBill={(d) => { setBillDraft(d); showSub("work"); }} />}
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
