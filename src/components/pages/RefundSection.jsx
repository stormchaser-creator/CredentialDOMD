import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { createLimitedLaunchClient } from "../../utils/limitedLaunchClient.js";
import { REFUND_COPY, keepUntilSentence, refundButton, refundIssued, refundIssuedSentence, refundMessage, refundSentence, refundedSentence } from "../../content/refundCopy.js";

/**
 * Cancel and get a refund (owner request 2026-09-30), on the membership card
 * (More > Profile & settings) and on More > Cancel Subscription.
 *
 * `paid`: the account's current membership was paid (not lifetime, a gift,
 * a free beta or a scheduled purchase with no payment yet); the button shows.
 * Without it, the section shows only a refund already on record: done, needing
 * support, or unfinished (with the button that finishes it).
 *
 * The server decides everything: it quotes the most recent annual payment,
 * the member confirms exactly that, and it cancels, ends access and refunds
 * once (supabase/functions/limited-refund). Cancelling at the end of the paid
 * period without a refund stays in the billing portal.
 *
 * `carry`: a ref the page holding the section keeps (useRef(null)). A press
 * ends the paid membership, so the membership answer that follows moves the
 * page to its unpaid branch, which renders a NEW section: without the carry
 * it started empty and, until its own status read came back (or for good, when
 * that read failed), the card showed a purchase offer and nothing about the
 * refund just pressed (QA lab BILL-005, 2026-10-01). The new section starts
 * from what the last one showed.
 */
export default function RefundSection({ paid = false, carry = null }) {
  const { user, limitedLaunch, theme: T, isDesktop, navigate } = useApp();
  const accountId = user?.id;
  // The refund makes several provider calls in a row: a longer wait than a quote.
  const client = useMemo(() => createLimitedLaunchClient({ accountId, timeoutMs: 30000 }), [accountId]);
  // The server's last answer: a quote (available, resume) or an outcome.
  const [view, setViewState] = useState(() => carry?.current?.view ?? null);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessageState] = useState(() => carry?.current?.message ?? null);
  const setView = next => { setViewState(next); if (carry) carry.current = { ...carry.current, view: next }; };
  const setMessage = next => { setMessageState(next); if (carry) carry.current = { ...carry.current, message: next }; };
  const turn = useRef(0);
  useEffect(() => () => { turn.current++; }, []);
  const lookForRecord = !paid && !!accountId && limitedLaunch?.enabled === true && limitedLaunch.access?.accessStatus === "active";
  useEffect(() => {
    if (!lookForRecord) return undefined;
    let current = true;
    client.refundStatus().then(answer => {
      if (!current || answer.state === "none") return;
      setViewState(answer);
      if (carry) carry.current = { ...carry.current, view: answer };
    }).catch(() => { /* Nothing on record to show. */ });
    return () => { current = false; };
  }, [lookForRecord, client, carry]);

  const mine = at => turn.current === at;
  const review = async () => {
    if (busy) return;
    const at = ++turn.current;
    setBusy(true); setMessage(null); setConfirmed(false);
    try {
      const answer = await client.refundQuote();
      if (!mine(at)) return;
      setView(answer);
      setOpen(answer.state === "available" || answer.state === "resume");
    } catch (error) { if (mine(at)) setMessage(refundMessage(error)); }
    finally { if (mine(at)) setBusy(false); }
  };
  const refund = async () => {
    if (busy || !confirmed || !view) return;
    const at = ++turn.current;
    setBusy(true); setMessage(null);
    try {
      const answer = await client.refund({ paymentId: view.paymentId, amountCents: view.amountCents, confirm: true });
      if (!mine(at)) return;
      setView(answer); setOpen(false); setConfirmed(false);
    } catch (error) {
      if (!mine(at)) return;
      setMessage(refundMessage(error, { acted: true })); setConfirmed(false);
      // Where it stands now, from the record: finished meanwhile, or to finish.
      try { const answer = await client.refundStatus(); if (mine(at) && answer.state !== "none") { setView(answer); setOpen(false); } } catch { /* The message above stands. */ }
    } finally {
      if (mine(at)) setBusy(false);
      // The membership answer follows the cancellation; ask for it either way.
      try { await limitedLaunch?.refresh?.(); } catch { /* The access hook reports its own failures. */ }
    }
  };

  if (!limitedLaunch?.enabled || (!paid && !view && !message)) return null;
  const size = isDesktop ? 14 : 16;
  const button = { border: `1px solid ${T.border}`, background: T.card, color: T.text, borderRadius: 9, padding: "11px 14px", cursor: busy ? "wait" : "pointer", fontSize: size, minHeight: 44, fontFamily: "inherit" };
  const danger = confirmed ? { ...button, border: "none", background: T.danger, color: "#fff", fontWeight: 700 } : { ...button, background: T.neutralDim, color: T.textDim, cursor: "not-allowed" };
  const box = { marginTop: 16, padding: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 12 };
  const status = message && <p role="alert" style={{ margin: "10px 0 0", padding: "8px 12px", borderLeft: `3px solid ${T.danger}`, background: T.dangerDim, color: T.text, fontSize: size }}>{message}</p>;

  // Whether the record says the membership was cancelled: the only source
  // for saying so (a request can stop before its cancellation).
  const cancelled = view?.subscriptionCanceled === true;
  // A support ticket was opened for the member: the owner finishes it.
  const ticket = view?.supportTicket === true;
  // A person looks first and nothing is promised (a disputed charge, say).
  const reviewOnly = view?.reviewOnly === true;
  if (view?.state === "refunded" || view?.state === "needs_support") {
    return <section aria-label="Refund" style={box} data-refund-outcome={view.state}>
      <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>{view.state === "refunded" ? "Your refund" : "Your refund needs support"}</h3>
      {view.state === "refunded" ? <>
        <p role="status">{refundedSentence(view)}</p>
        <p>{view.refundStatus === "succeeded" ? REFUND_COPY.issued : REFUND_COPY.onItsWay}</p>
      </> : <p role="status">{ticket
        ? (cancelled ? (reviewOnly ? REFUND_COPY.needsSupportReview : REFUND_COPY.needsSupport) : REFUND_COPY.needsSupportOpen)
        : (cancelled ? (reviewOnly ? REFUND_COPY.needsSupportReviewNoTicket : REFUND_COPY.needsSupportNoTicket) : REFUND_COPY.needsSupportOpenNoTicket)}</p>}
    </section>;
  }
  // Resuming a request that was cancelled finishes its refund; one that
  // stopped before its cancellation still ends the membership now.
  const resumeCancelled = view?.state === "resume" && cancelled;
  // Its payment was refunded already (support, in the dashboard): never
  // "we will refund" or "nothing has been refunded".
  const issued = refundIssued(view);
  const resumeLine = issued ? (cancelled ? REFUND_COPY.issuedCancelled : REFUND_COPY.issuedNotCancelled)
    : resumeCancelled ? (ticket ? REFUND_COPY.unfinishedTicket : REFUND_COPY.unfinished) : REFUND_COPY.notStarted;

  if (open && view && (view.state === "available" || view.state === "resume")) {
    return <section aria-label={REFUND_COPY.heading} style={box} data-refund-review="">
      <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>{REFUND_COPY.heading}</h3>
      <p><strong>{issued ? refundIssuedSentence(view) : refundSentence(view)}</strong></p>
      <p>{issued ? resumeLine : resumeCancelled ? (ticket ? REFUND_COPY.unfinishedTicket : REFUND_COPY.unfinished) : REFUND_COPY.endsNow}</p>
      {issued && !cancelled && <p>{REFUND_COPY.endsNow}</p>}
      <p>{REFUND_COPY.recordsKept}</p>
      <button type="button" style={button} onClick={() => navigate?.("more", "export")}>{REFUND_COPY.exportFirst}</button>
      <p>{REFUND_COPY.rejoin}</p>
      {!resumeCancelled && !issued && view.periodEnd && <p style={{ color: T.textMuted }}>{keepUntilSentence(view.periodEnd)}</p>}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 8 }}>
        <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
        <span>{REFUND_COPY.confirm}</span>
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        <button type="button" style={danger} disabled={busy || !confirmed} onClick={refund}>{busy ? "Refunding…" : view.state === "resume" ? REFUND_COPY.finish : refundButton(view)}</button>
        <button type="button" style={button} disabled={busy} onClick={() => { setOpen(false); setConfirmed(false); setMessage(null); }}>{REFUND_COPY.keep}</button>
      </div>
      {status}
    </section>;
  }

  return <div style={{ marginTop: 12 }}>
    {view?.state === "resume" && <p role="status">{resumeLine}</p>}
    {(paid || view?.state === "resume") && <button type="button" style={button} disabled={busy} onClick={review}>{busy ? "Checking…" : view?.state === "resume" ? REFUND_COPY.finish : REFUND_COPY.action}</button>}
    {status}
  </div>;
}
