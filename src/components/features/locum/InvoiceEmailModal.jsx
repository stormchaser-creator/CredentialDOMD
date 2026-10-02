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
import { RECONNECTING_MESSAGE } from "../../../utils/limitedLaunchAccess.js";
import { invoicePdfFile, invoiceTextPdfFile } from "../../../utils/invoicePdf";
import { invoiceDocumentArgs } from "../../../utils/invoiceArgs";
import { againRequestId } from "../../../utils/invoiceEmailDraft";
import { billedReceiptDocs } from "../../../utils/receiptFiles";
import { INVOICE_EMAIL_FROM_ADDRESS, isEmailAddress, normalizeAddress, recipientProblem } from "../../../utils/invoiceEmail";
import {
  invoiceEmailDocuments, invoiceEmailDraft, invoiceEmailSendBody, callInvoiceEmail, afterRefusal, fileToBase64, sentWhen,
  unconfirmedAttempt, unconfirmedAttemptText,
} from "../../../utils/invoiceEmailSend";

/**
 * Email an invoice from docs@credentialdomd.com through send-invoice-email,
 * so it arrives with its paragraphs intact (tickets e8cc2a02, 821d2f76; the
 * share sheet flattens them). The physician sees the message exactly as it
 * will arrive (who it is from, who gets it and a copy, the subject, the
 * letter, every attachment) and nothing goes until they tap Send.
 *
 * The server is asked first which receipts it can attach. A receipt it cannot
 * is named here BEFORE the tap, and the letter and PDF never claim it. So is
 * a receipt this device holds that the server cannot see yet (an upload or
 * an expense link still queued).
 *
 * One request id per opening of this screen, reused by every retry of Send,
 * so a tap retried on a slow network is answered "already sent" instead of
 * mailing the billing office twice. A reopening after a send that could not
 * be confirmed shows that attempt and sends again only once the physician
 * says so (the server enforces the same rule).
 *
 * To is pre-filled from the agreement's invoice email, else from the server's
 * suggestion (this invoice's last recipient, else the last recipient of an
 * invoice billed to the same party), never from this device's copy of the
 * invoice, which can be stale.
 *
 * `invoke` is injectable for tests; the app uses the Supabase client.
 *
 * `invoiceDraft`: an invoice not recorded yet ("Email it for me" in the Work log,
 * Days & call and Expenses previews; utils/invoiceEmailDraft.js). `invoice`
 * is then { id, number } (the id it will be recorded under), `docArgs` the
 * arguments of exactly the preview's PDF, `localReceipts` the receipts this
 * device holds for it, `prefillTo` the agreement's address (else To starts
 * empty: no guess from history), and `invoiceDraft` { requestId, body }: the
 * request id is the invoice number's, so a retry on a weak network is a
 * replay. The server decides membership for the send itself, so a check
 * still running here does not hold Send. The screen records the invoice:
 * `onSendStart()` as the request goes, then exactly one of `onSent` (a 2xx
 * with the provider's id), `onUnconfirmed` (it may have gone) or `onFailed`
 * (nothing went), except "still being sent" (the same request in flight),
 * which leaves things as they are.
 */
// The page the email preview sits on, per app theme (a mail app's own plain
// light or dark page).
const PREVIEW_LIGHT = "#ffffff";
const PREVIEW_DARK = "#1c1c1e";

function InvoiceEmailModal({
  open, invoice, contract, billName, onClose, onSent, invoke: invokeProp,
  invoiceDraft = null, docArgs = null, localReceipts = null, prefillTo = "", toHint = "", records = "",
  onSendStart = null, onUnconfirmed = null, onFailed = null,
}) {
  const { data, theme: T, isDark, limitedLaunch, canWritePractice, practiceReadOnly } = useApp();
  const iS = useInputStyle();
  const [phase, setPhase] = useState("idle"); // idle | checking | ready | sending | error
  const [check, setCheck] = useState(null);
  const [documents, setDocuments] = useState(null);
  const [pdfBase64, setPdfBase64] = useState("");
  const [to, setTo] = useState("");
  const [save, setSave] = useState(true);
  const [message, setMessage] = useState("");
  const [stopped, setStopped] = useState(false);
  // Which unconfirmed earlier attempt the physician chose to send over ("" = none).
  const [confirmedAttempt, setConfirmedAttempt] = useState("");
  const requestIdRef = useRef("");
  const runRef = useRef(0);
  // Set once the physician types in To: a server suggestion never replaces it.
  const toEditedRef = useRef(false);
  // A Send on its way: a second tap before the screen redraws sends nothing.
  const sendingRef = useRef(false);
  // An invoice not recorded yet whose last Send got no answer from the
  // server (the connection dropped, or the same request was still on its
  // way): it may have gone. Send again is safe (the same request id); closing
  // instead tells the screen it may have gone (onUnconfirmed).
  const uncertainRef = useRef(null);

  // Read-only is the server's answer for this membership. A check still in
  // progress is not: the letter is prepared, and Send waits for the answer.
  const readOnly = !!limitedLaunch?.enabled && !!practiceReadOnly;
  // An invoice not recorded yet: the server's access answer decides the send,
  // and the record that follows is kept on the device while a check runs.
  const reconnecting = !invoiceDraft && !!limitedLaunch?.enabled && !readOnly && !canWritePractice;
  const invoke = invokeProp || ((name, options) => invokeFn(supabase, name, options));
  const settings = data?.settings;
  const args = useMemo(
    () => (invoiceDraft ? docArgs : invoice ? invoiceDocumentArgs(invoice, contract, settings || {}, billName || "") : null),
    [invoiceDraft, docArgs, invoice, contract, settings, billName],
  );
  const legacyText = invoice
    ? invoice.text || `Invoice ${invoice.number} for ${billName || "the facility"}: ${money(invoice.totalAmount)}.`
    : "";
  const pdfFor = (a) => (invoiceDraft || invoice?.lines?.length ? invoicePdfFile(a) : invoiceTextPdfFile(a, legacyText));

  const contractBillTo = String(invoiceDraft ? prefillTo || contract?.billTo || "" : contract?.billTo || "").trim();
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
      const r = await callInvoiceEmail(invoke, {
        action: "check", invoiceId: invoice.id, pdfBytes: provisional.size, ...(invoiceDraft ? { draft: invoiceDraft.body } : {}),
      });
      if (token !== runRef.current) return;
      if (!r.ok) { setMessage(r.message); setPhase("error"); return; }
      const held = invoiceDraft ? localReceipts || [] : billedReceiptDocs(invoice, data?.travelExpenses, data?.documents);
      const docs = invoiceEmailDocuments({ args, check: r.data, pdfFor, localReceipts: held });
      const b64 = await fileToBase64(docs.pdf);
      if (token !== runRef.current) return;
      setCheck(r.data);
      setDocuments(docs);
      setPdfBase64(b64);
      const suggested = normalizeAddress(r.data?.suggestedTo);
      // An invoice not recorded yet takes the agreement's address or none:
      // To is never filled from another invoice's history.
      if (!invoiceDraft && !toEditedRef.current && !isEmailAddress(contractBillTo) && isEmailAddress(suggested)) setTo(suggested);
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
    // An invoice not recorded yet: the invoice number's own key, so a Send
    // retried after a lost answer, or from a reopened screen, is a replay.
    requestIdRef.current = invoiceDraft?.requestId || generateId();
    sendingRef.current = false;
    uncertainRef.current = null;
    setCheck(null);
    setDocuments(null);
    setPdfBase64("");
    setStopped(false);
    setSave(true);
    setConfirmedAttempt("");
    toEditedRef.current = false;
    // The agreement's invoice email now; otherwise the server's suggestion
    // once the check answers (prepare), not this device's lastEmailedTo.
    setTo(isEmailAddress(contractBillTo) ? contractBillTo : "");
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
  // An earlier send that may already have arrived: Send waits for an explicit
  // "send it again anyway" tied to that very attempt.
  const attempt = unconfirmedAttempt(check);
  const attemptKey = attempt ? `${attempt.status}|${attempt.at}|${attempt.to}` : "";
  const attemptConfirmed = !attempt || confirmedAttempt === attemptKey;
  const canSend = phase === "ready" && !!draft && !!pdfBase64 && !problem && !stopped && !readOnly && !reconnecting && attemptConfirmed;
  // The physician's own mailbox (a test send to themselves) is never saved as
  // the agreement's invoice email: every later invoice would print it under
  // BILL TO and pre-fill it here.
  const ownAddresses = new Set([check?.sender?.replyTo, check?.sender?.cc, settings?.email].map(normalizeAddress).filter(Boolean));
  const saveShown = saveOffered && !ownAddresses.has(normalizeAddress(to));

  const send = async () => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    setPhase("sending");
    setMessage("");
    const resend = !!attempt && attemptConfirmed;
    // A deliberate new send over an unconfirmed one gets its own key (the
    // same on every retry of it); otherwise the screen's.
    const requestId = invoiceDraft && resend ? againRequestId(invoiceDraft.requestId, attempt.at) : requestIdRef.current;
    const body = invoiceEmailSendBody({
      invoiceId: invoice.id, requestId, draft, pdfBase64, confirmResend: resend, invoiceDraft: invoiceDraft?.body || null,
    });
    try { onSendStart?.(); } catch { /* the screen's note never stops the send */ }
    let r;
    try { r = await callInvoiceEmail(invoke, body); } finally { sendingRef.current = false; }
    const sent = {
      invoice, at: r.data?.sentAt, to: r.data?.to || draft.email.to, cc: r.data?.cc || draft.email.cc || "",
      replay: !!r.data?.replay, emailId: r.data?.emailId || null, docArgs: draft.docArgs || args,
    };
    uncertainRef.current = null;
    if (r.ok && (!invoiceDraft || sent.emailId)) {
      setPhase("ready");
      onSent?.({ ...sent, saveBillTo: saveShown && save && !r.data.replay ? draft.email.to : null });
      return;
    }
    // The provider took it without an id, or did not answer: it may have
    // gone. Nothing more from this screen; the preview asks whether it did.
    if (invoiceDraft && (r.ok || r.code === "send_unconfirmed")) {
      setStopped(true);
      setMessage(r.ok
        ? `The email service did not confirm this send, so it may have gone. Check your copy${sent.cc ? ` at ${sent.cc}` : ""} before sending again.`
        : r.message);
      setPhase("ready");
      onUnconfirmed?.(sent);
      return;
    }
    // No answer from the function (the connection dropped, a gateway error),
    // or the same request still on its way: nothing is known yet. Send again
    // is answered from the server's ledger; closing says it may have gone.
    if (invoiceDraft && (r.code === "send_in_progress" || r.code === "network" || /^http_5/.test(r.code))) {
      uncertainRef.current = sent;
      setMessage(r.code === "send_in_progress" ? r.message
        : "The connection dropped before the answer came back, so this email may have gone. Tap Send again: if it went, it is not sent twice.");
      setPhase("ready");
      return;
    }
    if (invoiceDraft) onFailed?.({ ...sent, code: r.code, message: r.message });
    const next = afterRefusal(r.code);
    if (next === "recheck") { await prepare(r.message); return; }
    if (next === "stop") setStopped(true);
    setMessage(r.message);
    setPhase("ready");
  };

  // Closed after a Send that got no answer: the screen is told it may have gone.
  const close = () => {
    const unsure = invoiceDraft ? uncertainRef.current : null;
    uncertainRef.current = null;
    if (unsure) onUnconfirmed?.(unsure);
    onClose?.();
  };

  if (!open || !invoice) return null;

  const muted = { fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 };
  const label = { fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 };
  // The server's answer once it is in; this device's copy only until then.
  const last = check ? (check.lastSend?.at ? check.lastSend : null)
    : invoice.lastEmailedAt ? { at: invoice.lastEmailedAt, to: invoice.lastEmailedTo } : null;
  const email = draft?.email;

  return (
    <Modal open={open} onClose={phase === "sending" ? () => {} : close} title={`Email invoice ${invoice.number || ""}`.trim()}>
      <div style={{ ...muted, marginBottom: 12 }}>
        Sent for you from {INVOICE_EMAIL_FROM_ADDRESS}, so the letter arrives with its paragraphs intact.
        {check?.sender && <> Replies go to <b style={{ color: T.text }}>{check.sender.replyTo}</b>.</>}
        {invoiceDraft && <> Once it is sent, {invoice.number} goes on the Invoices tab as emailed{records ? ` and ${records} are billed` : ""}. If it does not go, nothing is recorded.</>}
      </div>

      {last && (
        <div style={{ ...muted, marginBottom: 12 }}>
          Last emailed {sentWhen(last.at)}{last.to ? ` to ${last.to}` : ""}.
        </div>
      )}

      {attempt && (
        <div data-invoice-email-attempt="" style={{ marginBottom: 14 }}>
          <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: T.warning, lineHeight: 1.45, marginBottom: 6 }}>
            {unconfirmedAttemptText(attempt)}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: T.text, cursor: "pointer" }}>
            <input type="checkbox" data-confirm-resend="" checked={attemptConfirmed}
              onChange={(e) => setConfirmedAttempt(e.target.checked ? attemptKey : "")} disabled={phase === "sending"} />
            I checked. Send it again anyway.
          </label>
        </div>
      )}

      <Field label="To" hint={contractBillTo && !isEmailAddress(contractBillTo)
        ? `The agreement's invoice recipient (${contractBillTo}) is not an email address, so type one here.`
        : invoiceDraft && !contractBillTo && !to.trim() ? toHint || "No invoice email is saved for this agreement. Type the billing office's address." : undefined}>
        <input type="email" value={to} onChange={(e) => { toEditedRef.current = true; setTo(e.target.value); }} style={iS}
          placeholder="billing@hospital.org" autoCapitalize="off" autoCorrect="off" disabled={phase === "sending"} />
      </Field>
      {saveShown && (
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
          {/* The HTML part exactly as it is sent, in a sandboxed frame (no
              script, no same origin): what the billing office's mail app
              shows. The text part is the same letter, line for line.
              The frame carries the app's theme as its color scheme and an
              opaque page of that scheme: the email declares "light dark"
              and sets no text colour, so a frame left at the default light
              scheme drew black text on the dark theme's navy card whenever
              the phone itself was in light mode. */}
          <iframe data-invoice-email-body="" title="Email preview" sandbox="" srcDoc={email.html} style={{
            display: "block", width: "100%", height: 380, marginTop: 10, borderRadius: 10,
            border: `1px solid ${T.border}`,
            colorScheme: isDark ? "dark" : "light", backgroundColor: isDark ? PREVIEW_DARK : PREVIEW_LIGHT,
          }} />
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
      {reconnecting && phase === "ready" && !stopped && <div role="status" style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, lineHeight: 1.45, marginBottom: 12 }}>{RECONNECTING_MESSAGE}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {phase === "error" && !readOnly && (
          <button onClick={() => prepare()} style={{
            padding: "12px 16px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
          }}>Try again</button>
        )}
        <button onClick={close} disabled={phase === "sending"} style={{
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
