import Modal from "./Modal";
import { useApp } from "../../context/AppContext";

/**
 * "Send as…" — the one decision between tapping Send and the share sheet.
 * PDF is the polished artifact most AP departments want; Word and Excel
 * exist for billing offices that re-key or edit line items.
 */
const FORMATS = [
  { key: "pdf", label: "PDF", sub: "Polished invoice — what most billing departments expect", icon: "📄" },
  { key: "docx", label: "Word", sub: "Editable document (.docx)", icon: "📝" },
  { key: "xlsx", label: "Excel", sub: "Line items as a spreadsheet (.xlsx)", icon: "📊" },
];

export default function InvoiceFormatChooser({ open, onClose, onPick, busy }) {
  const { theme: T } = useApp();
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Send invoice as…">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {FORMATS.map(f => (
          <button key={f.key} disabled={busy} onClick={() => onPick(f.key)} style={{
            display: "flex", alignItems: "center", gap: 12, textAlign: "left",
            padding: "14px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
            backgroundColor: T.card, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
          }}>
            <span style={{ fontSize: 22 }}>{f.icon}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 800, color: T.text }}>{f.label}</span>
              <span style={{ display: "block", fontSize: 12, color: T.textMuted, marginTop: 1 }}>{f.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
