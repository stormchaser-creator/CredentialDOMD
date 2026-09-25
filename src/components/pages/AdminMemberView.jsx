import { useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import MemberViewer from "../features/MemberViewer.jsx";
import { createMemberViewClient, formatWhen, reasonCheck } from "../../utils/memberViewClient.js";

/**
 * Admin > Accounts > View as member (ticket d45e857c, phase 2).
 *
 * Only offered while the member has allowed support access in their Settings.
 * The administrator types why; the reason goes into the member's log with
 * every view and file opened. admin-member-view checks the administrator,
 * the member's grant and the reason again, and returns a read-only snapshot
 * that MemberViewer shows in its own layer, never in this app's records.
 */
export default function AdminMemberView({ target, grant, onClose }) {
  const { user, theme: T, isDesktop } = useApp();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(null);
  const [closedNote, setClosedNote] = useState("");
  const inFlight = useRef(false);
  const client = useMemo(() => createMemberViewClient({ accountId: user?.id }), [user?.id]);
  // Counted and checked exactly as the server stores it (normalizeReason).
  const { text: cleanReason, length: reasonLength, ok: reasonOk } = reasonCheck(reason);
  const name = target?.name || target?.email || "this member";

  const start = async () => {
    if (inFlight.current || !reasonOk || !target?.id) return;
    inFlight.current = true; setBusy(true); setError(""); setClosedNote("");
    try { setOpened(await client.start({ profileId: target.id, reason: cleanReason })); }
    catch (failure) { setError(failure?.message || "The support view could not be opened."); }
    finally { inFlight.current = false; setBusy(false); }
  };

  if (opened) {
    return <MemberViewer opened={opened} client={client} T={T} isDesktop={isDesktop} fallbackName={target?.email || ""}
      onClose={note => { setOpened(null); setClosedNote(note || "Support view closed."); }} />;
  }

  const label = { display: "block", fontWeight: 700, marginBottom: 6 };
  return <Modal open onClose={onClose} title="View as member" width={560}>
    <div style={{ color: T.text, fontSize: 14, lineHeight: 1.6 }}>
      <p style={{ marginTop: 0 }}>
        Open a read-only view of <strong>{name}</strong>&apos;s account. Nothing can be added, changed, deleted, sent or shared.
      </p>
      <ul style={{ paddingLeft: 18, margin: "0 0 12px", color: T.textMuted }}>
        <li>{grant?.expiresAt ? `The member allowed support access until ${formatWhen(grant.expiresAt)}.` : "The member has to allow support access in their Settings first."}</li>
        <li>The view lasts at most 15 minutes and closes early if the member ends access.</li>
        <li>Your reason is shown to the member in their log, with every file you open.</li>
        <li>Passport and travel IDs, taxes, invoices, expenses, deductions, contract rates and terms, and Protected Identity are never shown. Text the app&apos;s identifier check flags (patient identifiers, Social Security and tax IDs) is withheld.</li>
      </ul>
      {closedNote && <p role="status" style={{ background: T.input, padding: 10, borderRadius: 8 }}>{closedNote}</p>}
      <label htmlFor="member-view-reason" style={label}>Reason for this view</label>
      <textarea id="member-view-reason" value={reason} maxLength={500} rows={3} onChange={event => setReason(event.target.value)}
        placeholder="For example: ticket about CME hours not adding up on Home"
        style={{ width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 8, border: `1px solid ${T.border}`, background: T.input, color: T.text, fontSize: 16, fontFamily: "inherit" }} />
      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{reasonLength} of 500 characters, at least 10.</div>
      {error && <p role="alert" style={{ color: T.danger || "#ef4444" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={start} disabled={!reasonOk || busy || !grant} style={{
          minHeight: 44, padding: "10px 16px", borderRadius: 10, border: "none", fontWeight: 800, fontSize: 15,
          background: reasonOk && grant && !busy ? T.accent : T.textDim, color: "#fff", cursor: reasonOk && grant && !busy ? "pointer" : "not-allowed",
        }}>{busy ? "Opening..." : "Open read-only view"}</button>
        <button type="button" onClick={onClose} style={{ minHeight: 44, padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.border}`, background: "transparent", color: T.text, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  </Modal>;
}
