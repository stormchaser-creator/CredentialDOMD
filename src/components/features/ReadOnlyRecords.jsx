import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { COLLECTION_KEYS, downloadDocumentFile } from "../../lib/supabase";
import { scopeForCollection } from "../../utils/limitedLaunchAccess.js";
import { downloadBlob } from "../../utils/credentialExport";
import { invoicePdfFile, invoiceTextPdfFile } from "../../utils/invoicePdf";

const label = value => String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, ch => ch.toUpperCase());
const title = record => record.name || record.title || record.number || record.facility || record.type || record.date || "Saved record";
const fields = record => Object.entries(record).filter(([key]) => !["id", "userId", "data", "storagePath", "favorite"].includes(key));

/** An expiry never removes the physician's file, attachments, or invoice downloads. */
export default function ReadOnlyRecords({ scope }) {
  const { data, theme: T, navigate } = useApp();
  const [message, setMessage] = useState(null);
  const groups = [...new Set([...COLLECTION_KEYS, ...Object.keys(data).filter(key => Array.isArray(data[key]))])].map(key => [key, (data[key] || []).filter(record => scopeForCollection(key, record) === scope)])
    .filter(([, records]) => records.length);
  const button = { border: `1px solid ${T.border}`, borderRadius: 8, background: T.card, color: T.text, padding: "9px 12px", cursor: "pointer" };
  const exportRecords = () => {
    const saved = Object.fromEntries(groups);
    downloadBlob(new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" }), `credentialdomd-${scope}-records.json`);
  };
  const downloadDocument = async record => {
    try {
      const content = record.data || await downloadDocumentFile(record.storagePath);
      if (!content || !/^data:[^,]*;base64,/.test(content)) throw Error();
      const bytes = Uint8Array.from(atob(content.slice(content.indexOf(",") + 1)), char => char.charCodeAt(0));
      downloadBlob(new Blob([bytes], { type: record.type || "application/octet-stream" }), record.name || "document");
    } catch { setMessage("This attachment could not download. Your saved record has not changed; reconnect and try again."); }
  };
  const downloadInvoice = record => {
    try {
      const contract = (data.locumContracts || []).find(item => item.id === record.contractId) || {};
      const total = Number(record.totalAmount) || 0;
      const ledger = (record.payments || []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      const paid = ledger > 0 ? ledger : record.paidAt ? total : 0;
      const args = {
        number: record.number, physician: data.settings.name || "Physician", npi: data.settings.npi, email: data.settings.email,
        facility: contract.facility, agency: contract.agency, location: contract.location, billTo: contract.billTo,
        periodStart: record.periodStart, periodEnd: record.periodEnd, terms: record.terms, lines: record.lines,
        totalMin: record.totalMinutes, total, paid, balance: record.writeOffAt ? 0 : Math.max(0, total - paid), issuedDate: record.sentAt?.slice(0, 10),
      };
      const file = record.lines?.length ? invoicePdfFile(args) : invoiceTextPdfFile(args, record.text || "");
      downloadBlob(file, file.name);
    } catch { setMessage("This invoice could not render. You can still download the saved records."); }
  };
  return <section style={{ color: T.text }}>
    <h2 style={{ fontSize: 20 }}>{scope === "practice" ? "Practice" : "Credential"} saved records</h2>
    <p style={{ color: T.textMuted, lineHeight: 1.6 }}>These records are read-only. You can view and download them. Membership expiry does not delete your data.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button style={button} onClick={exportRecords}>Download saved records</button>
      <button style={button} onClick={() => navigate("more", "export")}>All export options</button>
    </div>
    {message && <p role="status">{message}</p>}
    {!groups.length && <p>No saved records in this section.</p>}
    {groups.map(([key, records]) => <section key={key} style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 16 }}>{label(key)} ({records.length})</h3>
      {records.map((record, index) => <details key={record.id || index} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 8, overflowWrap: "anywhere" }}>
        <summary style={{ cursor: "pointer" }}>{title(record)}</summary>
        <dl style={{ fontSize: 13 }}>{fields(record).map(([name, value]) => <div key={name} style={{ marginTop: 8 }}>
          <dt style={{ color: T.textMuted }}>{label(name)}</dt>
          <dd style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}>{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "")}</dd>
        </div>)}</dl>
        {key === "documents" && <button style={button} onClick={() => downloadDocument(record)}>Download attachment</button>}
        {key === "invoices" && <button style={button} onClick={() => downloadInvoice(record)}>Download invoice PDF</button>}
      </details>)}
    </section>)}
  </section>;
}
