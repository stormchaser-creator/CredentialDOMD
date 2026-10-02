import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { COLLECTION_KEYS, downloadDocumentFile } from "../../lib/supabase";
import { downloadBlob } from "../../utils/credentialExport";
import { invoicePdfFile, invoiceTextPdfFile } from "../../utils/invoicePdf";
import { callDayStartHour } from "../../utils/billing";
import { sentDay } from "../../utils/helpers";
import { archiveSenderFields } from "../../utils/invoiceArgs";
import { archiveSections, documentDetail, documentLabel } from "../../utils/readOnlyArchive.js";
import { actionButtonStyle, inlineLinkTap } from "../shared/actionButton.js";
import { credentialOnlyMembership, lastAnswer, renewalPaymentFailed } from "../../utils/limitedLaunchAccess.js";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy.js";

/**
 * An expiry never removes the physician's file, attachments, or invoice
 * downloads. Shown only when the server's answer keeps this scope read-only;
 * a membership check in progress keeps the normal screens (ticket fe321c16).
 */
export default function ReadOnlyRecords({ scope }) {
  const { data, theme: T, navigate, isDesktop, limitedLaunch, manage, loadedFrom, deviceCopyBehind } = useApp();
  const [message, setMessage] = useState(null);
  // Every array in data used to be listed, Protected Identity included: its
  // legal names and notes printed in full, and "Download saved records"
  // wrote them to a file. Identity records, and files linked to them, are
  // never part of this view (archiveSections).
  const { sections, saved } = archiveSections(data, scope, COLLECTION_KEYS);
  const button = primary => actionButtonStyle(T, { primary, isDesktop });
  // A Credential-only member (the Practice trial over, or never included):
  // their membership is active, Practice is simply not part of it. Founding
  // Credential, the bundle and lifetime include Practice and never land here
  // this way; a lapsed beta keeps the expiry sentence below.
  const access = limitedLaunch?.access;
  const credentialOnly = scope === "practice" && credentialOnlyMembership(access);
  const trialEnded = credentialOnly && access.practiceTrial?.state === "expired" && access.practiceTrial.endsAt
    ? new Date(access.practiceTrial.endsAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null;
  const small = { ...button(false), minHeight: 40, padding: "8px 14px" };
  // No membership answer at all, this session or remembered (a weak signal at
  // launch, offline, a first check not back yet): the scope is read-only
  // because nothing can be confirmed, not because a membership ended. The
  // notice above says why (IdentityWaitingNotice, OfflineBanner,
  // LaunchAccessNotice); a sentence here about membership expiry contradicted it.
  const answered = lastAnswer(access, scope, limitedLaunch?.remembered) !== null;
  // The records are this device's copy (the account could not be read): an
  // empty section here is only empty on this device, and a change made just
  // before the app closed may not have reached the copy (deviceCopyBehind).
  const deviceCopy = loadedFrom === "local";
  const emptyLine = !deviceCopy ? "No saved records in this section."
    : deviceCopyBehind ? "Your latest changes may not be in this device's copy yet. Your records show here once your account connects."
      : "This device has no saved copy of records in this section. Your records show here once your account connects.";
  const exportRecords = () => {
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
        number: record.number, ...archiveSenderFields(data.settings || {}), npi: data.settings.npi, email: data.settings.email,
        facility: contract.facility, agency: contract.agency, location: contract.location, billTo: contract.billTo,
        periodStart: record.periodStart, periodEnd: record.periodEnd, terms: record.terms, lines: record.lines,
        totalMin: record.totalMinutes, total, paid, balance: Math.max(0, total - paid), issuedDate: sentDay(record.sentAt) || undefined,
        // The call-day window its day blocks print: lines saved before the
        // day layout do not carry it, so it comes from the agreement, as on
        // every resend (invoiceDocumentArgs).
        ...(contract.id ? { dayStartHour: callDayStartHour(contract) } : {}),
      };
      const file = record.lines?.length ? invoicePdfFile(args) : invoiceTextPdfFile(args, record.text || "");
      downloadBlob(file, file.name);
    } catch { setMessage("This invoice could not render. You can still download the saved records."); }
  };
  const card = { border: `1px solid ${T.border}`, borderRadius: 14, background: T.card, marginBottom: 8, overflowWrap: "anywhere" };
  const fileRow = (doc, index) => <li key={doc.id || index} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 0", borderTop: index ? `1px solid ${T.border}` : "none" }}>
    <div style={{ flex: "1 1 180px", minWidth: 0 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{documentLabel(doc, data)}</div>
      <div style={{ fontSize: 13, color: T.textDim || T.textMuted, marginTop: 2 }}>{documentDetail(doc)}</div>
    </div>
    <button type="button" style={small} onClick={() => downloadDocument(doc)}>Download attachment</button>
  </li>;
  return <section className="cmd-archive" style={{ color: T.text }}>
    <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>{scope === "practice" ? "Practice" : "Credential"} saved records</h2>
    {credentialOnly ? <div style={{ margin: "0 0 12px" }}>
      <p style={{ color: T.textMuted, lineHeight: 1.6, margin: "0 0 8px", fontSize: 14 }}>
        {trialEnded && `Your Practice trial ended on ${trialEnded}. `}Your Credential membership continues. Practice is not part of it, so these Practice records are read-only. You can view and download them.
      </p>
      <p style={{ color: T.textMuted, lineHeight: 1.6, margin: "0 0 8px", fontSize: 14 }}>
        <a href="mailto:support@credentialdomd.com" style={{ color: T.accent, ...inlineLinkTap }}>Contact support about adding Practice</a>. {MEMBERSHIP_COPY.practiceSupportReview}
      </p>
      <button type="button" style={button(false)} onClick={() => navigate("more", "settings")}>Profile &amp; settings</button>
    </div>
      : <p style={{ color: T.textMuted, lineHeight: 1.6, margin: "0 0 12px", fontSize: 14 }}>These records are read-only. You can view and download them.{answered && " Membership expiry does not delete your data."}</p>}
    {renewalPaymentFailed(limitedLaunch?.access) && <div role="status" style={{ margin: "0 0 12px" }}>
      <p style={{ color: T.text, lineHeight: 1.6, margin: "0 0 8px", fontSize: 14 }}>{MEMBERSHIP_COPY.renewalPaymentFailed}</p>
      <button type="button" style={button(true)} onClick={() => manage?.()}>Update payment method</button>
    </div>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button type="button" style={button(true)} onClick={exportRecords}>Download saved records</button>
      <button type="button" style={button(false)} onClick={() => navigate("more", "export")}>All export options</button>
    </div>
    {message && <p role="status" style={{ color: T.danger || T.text, fontSize: 14, lineHeight: 1.5 }}>{message}</p>}
    {!sections.length && <p style={{ color: T.textMuted }}>{emptyLine}</p>}
    {sections.map(section => <section key={section.key} style={{ marginTop: 22 }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: T.textMuted, margin: "0 0 8px" }}>{section.label} ({section.records.length || section.files.length})</h3>
      {section.records.map((entry, index) => <details key={entry.record.id || index} style={card}>
        <summary style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", minHeight: 44, cursor: "pointer" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{entry.title}</div>
            {entry.subtitle && <div style={{ fontSize: 13, color: T.textDim || T.textMuted, marginTop: 2 }}>{entry.subtitle}</div>}
          </div>
          {entry.files.length > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{entry.files.length} {entry.files.length === 1 ? "file" : "files"}</span>}
          <span aria-hidden="true" className="cmd-archive-chevron" style={{ color: T.textDim || T.textMuted, fontSize: 18 }}>{"\u{203A}"}</span>
        </summary>
        <div style={{ padding: "0 16px 12px" }}>
          {entry.details.length > 0 && <dl style={{ fontSize: 14, margin: 0, display: "grid", gridTemplateColumns: "minmax(96px, 36%) 1fr", columnGap: 12, rowGap: 6 }}>
            {entry.details.map((row, at) => [
              <dt key={`label-${at}`} style={{ color: T.textMuted }}>{row.label}</dt>,
              <dd key={`value-${at}`} style={{ margin: 0, whiteSpace: "pre-wrap" }}>{row.value}</dd>,
            ])}
          </dl>}
          {entry.files.length > 0 && <>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, margin: "12px 0 0", paddingBottom: 2, borderBottom: `1px solid ${T.border}` }}>Files</div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{entry.files.map(fileRow)}</ul>
          </>}
          {entry.key === "invoices" && <button type="button" style={{ ...small, marginTop: 12 }} onClick={() => downloadInvoice(entry.record)}>Download invoice PDF</button>}
        </div>
      </details>)}
      {section.files?.length > 0 && <ul style={{ ...card, listStyle: "none", padding: "0 16px" }}>{section.files.map(fileRow)}</ul>}
    </section>)}
  </section>;
}
