import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import { useInputStyle } from "../../shared/useInputStyle";
import { supabase } from "../../../lib/supabase";
import { invokeFn } from "../../../utils/edgeError";
import { generateId } from "../../../utils/helpers";
import { fmtBytes } from "../../../utils/docLabel";
import { money } from "../../../utils/invoiceCover";
import { invoicePdfFile, invoiceTextPdfFile } from "../../../utils/invoicePdf";
import { invoiceDocumentArgs } from "../../../utils/invoiceArgs";
import { INVOICE_EMAIL_FROM_ADDRESS, isEmailAddress, recipientProblem } from "../../../utils/invoiceEmail";
import {
  invoiceEmailDocuments, invoiceEmailDraft, invoiceEmailSendBody, callInvoiceEmail, afterRefusal, fileToBase64, sentWhen,
} from "../../../utils/invoiceEmailSend";

/**
 * Email an invoice from docs@credentialdomd.com through send-invoice-email,
 * so it arrives with its paragraphs intact (tickets e8cc2a02, 821d2f76; the
 * share sheet flattens them). The physician sees the message exactly as it
 * will arrive (who it is from, who gets it and a copy, the subject, the
 * letter, every attachment) and nothing goes until they tap Send.
 *
 * The server is asked first which receipts it can attach. A receipt it cannot
 * is named here BEFORE the tap, and the letter and PDF never claim it.
 *
 * One request id per opening of this screen, reused by every retry of Send,
 * so a tap retried on a slow network is answered "already sent" instead of
 * mailing the billing office twice.
 *
 * `invoke` is injectable for tests; the app uses the Supabase client.
 */
function InvoiceEmailModal({ open, invoice, contract, billName, onClose, onSent, invoke: invokeProp }) {
  const { data, theme: T, limitedLaunch, canWritePractice } = useApp();
  const iS = useInputStyle();
  const [phase, setPhase] = useState("idle"); // idle | checking | ready | sending | error
  const [check, setCheck] = useState(null);
  const [documents, setDocuments] = useState(null);
  const [pdfBase64, setPdfBase64] = useState("");
  const [to, setTo] = useState("");
  const [save, setSave] = useState(true);
  const [message, setMessage] = useState("");
  const [stopped, setStopped] = useState(false);
  const requestIdRef = useRef("");
  const runRef = useRef(0);

  const readOnly = !!limitedLaunch?.enabled && !canWritePractice;
  const invoke = invokeProp || ((name, options) => invokeFn(supabase, name, options));
  const settings = data?.settings;
  const args = useMemo(
    () => (invoice ? invoiceDocumentArgs(invoice, contract, settings || {}, billName || "") : null),
    [invoice, contract, settings, billName],
  );
  const legacyText = invoice
    ? invoice.text || `Invoice ${invoice.number} for ${billName || "the facility"}: ${money(invoice.totalAmount)}.`
    : "";
  const pdfFor = (a) => (invoice?.lines?.length ? invoicePdfFile(a) : invoiceTextPdfFile(a, legacyText));

  const contractBillTo = String(contract?.billTo || "").trim();
  // Offer to save the typed address only where the agreement has none: an
  // existing entry is the physician's own and is changed in Contracts.
  const saveOffered = !!contract && !contractBillTo;

  // Ask the server what can ride, then build the letter and PDF from its
  // answer. Rerun after a refusal that says the preview is out of date.
  const prepare = async (note = "") => {
    const token = ++runRef.current;
    setPhase("checking");
    setMessage(note);
    try {
      const provisional = pdfFor(args);
      const r = await callInvoiceEmail(invoke, { action: "check", invoiceId: invoice.id, pdfBytes: provisional.size });
      if (token !== runRef.current) return;
      if (!r.ok) { setMessage(r.message); setPhase("error"); return; }
      const docs = invoiceEmailDocuments({ args, check: r.data, pdfFor });
      const b64 = await fileToBase64(docs.pdf);
      if (token !== runRef.current) return;
      setCheck(r.data);
      setDocuments(docs);
      setPdfBase64(b64);
      setPhase("ready");
    } catch {
      if (token !== runRef.current) return;
      setMessage("The invoice could not be prepared. Try again.");
      setPhase("error");
    }
  };

  // Every opening starts clean, with a new request id.
  useEffect(() => {
    if (!open || !invoice) return undefined;
    requestIdRef.current = generateId();
    setCheck(null);
    setDocuments(null);
    setPdfBase64("");
    setStopped(false);
    setSave(true);
    const lastTo = String(invoice.lastEmailedTo || "").trim();
    setTo(isEmailAddress(contractBillTo) ? contractBillTo : isEmailAddress(lastTo) ? lastTo : "");
    if (readOnly) {
      setMessage("Sending invoices needs Practice access. Your invoices are still readable.");
      setPhase("error");
    } else {
      prepare();
    }
    // Closing (or switching invoice) orphans any check still in flight.
    const runs = runRef;
    return () => { runs.current += 1; };
    // Deliberately keyed on the invoice: a re-render must not restart the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.id]);

  const draft = useMemo(
    () => (documents && check?.sender ? invoiceEmailDraft({ documents, sender: check.sender, to }) : null),
    [documents, check, to],
  );
  const problem = to.trim() ? recipientProblem(to) : "Enter the billing office's email address.";
  const canSend = phase === "ready" && !!draft && !!pdfBase64 && !problem && !stopped && !readOnly;

  const send = async () => {
    if (!canSend) return;
    setPhase("sending");
    setMessage("");
    const r = await callInvoiceEmail(invoke, invoiceEmailSendBody({
      invoiceId: invoice.id, requestId: requestIdRef.current, draft, pdfBase64,
    }));
    if (r.ok) {
      setPhase("ready");
      onSent?.({
        invoice, at: r.data.sentAt, to: r.data.to, cc: r.data.cc || "", replay: !!r.data.replay,
        saveBillTo: saveOffered && save && !r.data.replay ? draft.email.to : null,
      });
      return;
    }
    const next = afterRefusal(r.code);
    if (next === "recheck") { await prepare(r.message); return; }
    if (next === "stop") setStopped(true);
    setMessage(r.message);
    setPhase("ready");
  };

  if (!open || !invoice) return null;

  const muted = { fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 };
  const label = { fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 };
  const last = check?.lastSend?.at ? check.lastSend : invoice.lastEmailedAt ? { at: invoice.lastEmailedAt, to: invoice.lastEmailedTo } : null;
  const email = draft?.email;

  return (
    <Modal open={open} onClose={phase === "sending" ? () => {} : onClose} title={`Email invoice ${invoice.number || ""}`.trim()}>
      <div style={{ ...muted, marginBottom: 12 }}>
        Sent for you from {INVOICE_EMAIL_FROM_ADDRESS}, so the letter arrives with its paragraphs intact.
        {check?.sender && <> Replies go to <b style={{ color: T.text }}>{check.sender.replyTo}</b>.</>}
      </div>

      {last && (
        <div style={{ ...muted, marginBottom: 12 }}>
          Last emailed {sentWhen(last.at)}{last.to ? ` to ${last.to}` : ""}.
        </div>
      )}

      <Field label="To" hint={contractBillTo && !isEmailAddress(contractBillTo)
        ? `The agreement's invoice recipient (${contractBillTo}) is not an email address, so type one here.`
        : undefined}>
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)} style={iS}
          placeholder="billing@hospital.org" autoCapitalize="off" autoCorrect="off" disabled={phase === "sending"} />
      </Field>
      {saveOffered && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: T.text, marginTop: -6, marginBottom: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save as the invoice email for {contract.facility || "this agreement"}
        </label>
      )}

      {phase === "checking" && <div role="status" style={{ ...muted, margin: "8px 0 12px" }}>Checking the invoice and its receipts.</div>}

      {email && (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 12, backgroundColor: T.input }}>
          <div style={label}>Preview</div>
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.55 }}>
            <div><b>From:</b> {email.fromName} &lt;{INVOICE_EMAIL_FROM_ADDRESS}&gt;</div>
            <div><b>To:</b> {email.to || "(type an address above)"}</div>
            <div><b>Copy to you:</b> {email.cc || "no separate copy (you are the recipient)"}</div>
            <div><b>Replies go to:</b> {email.replyTo}</div>
            <div><b>Subject:</b> {email.subject}</div>
          </div>
          <div data-invoice-email-body="" style={{
            marginTop: 10, padding: "10px 12px", borderRadius: 10, backgroundColor: T.card, border: `1px solid ${T.border}`,
            fontSize: 13, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5,
          }}>{email.text}</div>
          <div style={{ ...label, marginTop: 12 }}>Attachments</div>
          {email.attachments.map((name, i) => (
            <div key={`${i}-${name}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: T.text, padding: "2px 0" }}>
              <span style={{ overflowWrap: "anywhere" }}>{name}</span>
              <span style={{ color: T.textMuted, flexShrink: 0 }}>{fmtBytes(draft.attachments[i]?.size)}</span>
            </div>
          ))}
        </div>
      )}

      {draft?.missingText && (
        <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: T.warning, lineHeight: 1.45, marginBottom: 12 }}>
          {draft.missingText} {draft.missing.length === 1
            ? "It is not in this email: the letter does not count it and the invoice lists it as on file."
            : "They are not in this email: the letter does not count them and the invoice lists them as on file."}
        </div>
      )}

      {message && <div role="status" style={{ fontSize: 13, fontWeight: 600, color: T.danger, lineHeight: 1.45, marginBottom: 12 }}>{message}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {phase === "error" && !readOnly && (
          <button onClick={() => prepare()} style={{
            padding: "12px 16px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
          }}>Try again</button>
        )}
        <button onClick={onClose} disabled={phase === "sending"} style={{
          padding: "12px 16px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.textMuted, fontSize: 14, fontWeight: 700, cursor: phase === "sending" ? "default" : "pointer",
        }}>{stopped ? "Close" : "Cancel"}</button>
        {!stopped && (
          <button onClick={send} disabled={!canSend} style={{
            padding: "12px 18px", borderRadius: 10, border: "none",
            backgroundColor: canSend ? T.accent : T.border, color: "#fff", fontSize: 14, fontWeight: 800,
            cursor: canSend ? "pointer" : "default",
          }}>{phase === "sending" ? "Sending" : email?.to && !problem ? `Send to ${email.to}` : "Send"}</button>
        )}
      </div>
      {phase === "ready" && problem && to.trim() && <div style={{ ...muted, color: T.warning, marginTop: 8 }}>{problem}</div>}
    </Modal>
  );
}

export default memo(InvoiceEmailModal);
