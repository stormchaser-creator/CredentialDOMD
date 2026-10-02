import Field from "./Field";
import { TAP_MIN } from "./actionButton";
import RevealOnShow from "./RevealOnShow";
import { recordRefusedNotice, unrecordedBanner, forgetUnrecordedQuestion, shareAskTitle, shareAskNotice, SHARE_ASK_YES, SHARE_ASK_NO, SHARE_ASK_CHECKING, otherAgreementNoteLine, repeatTitle, repeatLine, partialRepeatLine, REPEAT_OK } from "../../utils/invoiceRecord";

/**
 * The part of an invoice preview that makes sure an invoice that went out is
 * on the Invoices tab (utils/invoiceRecord.js). Three states, in this order:
 *
 *  - `pending`: the invoice went out and its record was refused. A banner
 *    says so and "Record as sent" saves it, under the number it went out with.
 *    Each refused tap is said in the banner (`pending.tries`, `pending.why`),
 *    not left to addItem's alert, which stays quiet for a few seconds.
 *  - `ask` ({ number, text }): this preview's file went to the share sheet and the
 *    sheet has not reported a send (it answered a cancel, which iOS also
 *    answers after Mail or Gmail sent it, or the page is back in front and
 *    it has not answered). "Did it go out?" with "Yes, it was sent", which
 *    records exactly this preview's invoice in one tap (`onYes`), and "No, it
 *    did not go out" (`onNo`), which records nothing. `ask.checking`: Yes is
 *    checking that the invoice is still unrecorded (seconds on a slow
 *    network): it says so and waits; No stays, and answered then, it is the
 *    answer (the screen drops the Yes). `ask.text`: the question's own words
 *    when it was not a share sheet (an email that could not be confirmed).
 *  - `note`: what the last send attempt came to when it recorded nothing
 *    (the share sheet closed without reporting a send, or the file could not
 *    be built), said in the preview instead of nowhere.
 *  - Mark as sent: always offered while nothing is recorded. For an invoice
 *    that went out another way, or earlier: the number and the date on the
 *    copy that was sent, recorded without sending anything. It opens with
 *    `start` ({ number, day, from, at }): this preview's own number only when
 *    this preview's file went to a share sheet, a remembered invoice that went
 *    out unrecorded (`from` says so; `at` is the moment it went, kept while
 *    its number and day are), or an empty number to type. Never a new
 *    number, which no agency holds.
 *
 * `onCancel`: what the form's Cancel does instead of closing the form (a
 * preview that only records closes).
 *
 * Stateless: the preview holds `form` ({ number, day, from, at, problem, tries }
 * or null) and passes the handlers. Called as a function from the preview, so
 * its buttons sit in the preview's own element tree.
 */
export default function InvoiceMarkSent({
  T, iS, pending, note, form, setForm, start, today, waiting,
  onRecordPending, onRecordMarked, unbilled = "these entries",
  ask = null, onYes = null, onNo = null, onCancel = null,
}) {
  if (pending) {
    return (
      <div role="alert" style={{
        marginTop: 12, padding: "11px 13px", borderRadius: 12, fontSize: 13, lineHeight: 1.45,
        backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
      }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>{pending.number} went out but is not recorded yet</div>
        <div style={{ color: T.textMuted, marginBottom: 10 }}>
          It is not on the Invoices tab and {unbilled} are still unbilled. Record it now; if it is refused again, wait a moment for the connection and tap again.
        </div>
        {pending.tries > 0 && (
          <div role="alert" style={{ fontWeight: 700, color: T.danger, marginBottom: 10 }}>
            {recordRefusedNotice(pending.tries, pending.why)}
          </div>
        )}
        <button onClick={() => onRecordPending()} style={{
          width: "100%", padding: "12px", borderRadius: 10, border: "none",
          background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          fontSize: 14.5, fontWeight: 800, cursor: "pointer",
        }}>Record as sent</button>
      </div>
    );
  }
  const open = () => setForm({
    number: start?.number || "", day: start?.day || today, from: start?.from || null, at: start?.at || null, problem: null, tries: 0,
  });
  return (
    <div style={{ marginTop: 12 }}>
      {/* Scrolled into view with Yes and No when it appears: it sits at the
          foot of the preview, below the fold of a phone (RevealOnShow). */}
      {ask && (
        <RevealOnShow revealKey={ask.number || "ask"} role="alert" data-share-ask="" style={{
          marginBottom: 10, padding: "11px 13px", borderRadius: 12, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, fontSize: 14.5, marginBottom: 4 }}>{shareAskTitle(ask.number)}</div>
          <div style={{ color: T.textMuted, marginBottom: 10 }}>{ask.text || shareAskNotice(ask.number, unbilled)}</div>
          <button disabled={!!ask.checking} aria-busy={ask.checking ? "true" : undefined} onClick={() => { if (!ask.checking) onYes?.(); }} style={{
            width: "100%", minHeight: TAP_MIN, padding: "12px", borderRadius: 10, border: "none", marginBottom: 8,
            background: ask.checking ? T.border : "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
            fontSize: 14.5, fontWeight: 800, cursor: ask.checking ? "wait" : "pointer",
          }}>{ask.checking ? SHARE_ASK_CHECKING : SHARE_ASK_YES}</button>
          <button onClick={() => onNo?.()} style={{
            width: "100%", minHeight: TAP_MIN, padding: "10px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
          }}>{SHARE_ASK_NO}</button>
        </RevealOnShow>
      )}
      {note && (
        <div role="status" style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginBottom: 8, textAlign: "center" }}>
          {note}
        </div>
      )}
      {!form ? (
        <button onClick={open} style={{
          width: "100%", padding: "10px", borderRadius: 10, border: `1px dashed ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>Sent it already? Mark as sent</button>
      ) : (
        <div style={{ padding: "12px 13px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: T.card }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 4 }}>Mark as sent</div>
          <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginBottom: 12 }}>
            For an invoice you already sent some other way. It goes on the Invoices tab as sent and {unbilled} are marked billed. Nothing is sent.
          </div>
          <Field label="Invoice number" hint={form.from || "As printed on the invoice you sent"}>
            <input value={form.number ?? ""}
              onChange={e => setForm(f => ({ ...f, number: e.target.value, from: null, at: null, problem: null }))}
              style={{ ...iS, width: "100%", boxSizing: "border-box" }} />
          </Field>
          <Field label="Date sent">
            <input type="date" value={form.day || ""} max={today} onChange={e => setForm(f => ({ ...f, day: e.target.value, problem: null }))}
              style={{ ...iS, width: "100%", boxSizing: "border-box" }} />
          </Field>
          {form.problem && (
            <div role="alert" style={{ fontSize: 12.5, fontWeight: 700, color: T.danger, marginTop: -4, marginBottom: 10 }}>{form.problem}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!!waiting} onClick={() => onRecordMarked()} style={{
              flex: 2, padding: "12px", borderRadius: 10, border: "none",
              background: waiting ? T.border : "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
              fontSize: 14.5, fontWeight: 800, cursor: waiting ? "default" : "pointer",
            }}>Record as sent</button>
            <button onClick={() => (typeof onCancel === "function" ? onCancel() : setForm(null))} style={{
              flex: 1, padding: "12px", borderRadius: 10, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
            }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The screen's reminder of each invoice that went out from it unrecorded and
 * was left behind (the preview closed, the page reloaded, or its share sheet
 * never answered): what it was and how to record it, and a way to forget
 * it. With `onRecord(note)`, Record it builds its invoice again with Mark as
 * sent filled in. With `onConfirm(note)`, a note this device handed to the
 * share sheet asks whether it went out instead: "Yes, it was sent" records
 * it (in one tap when its items are all still unbilled; the screen decides),
 * "No, it did not go out" forgets it. `checking`: the number whose Yes is
 * checking that it is still unrecorded; its Yes says so and waits, and its
 * No, answered then, is the answer. `repeats` (with `onDismissRepeat`):
 * notes another recorded invoice repeats, each with one OK. `items` names
 * what an invoice bills here ("days", "entries", "expenses"). Called as a
 * function.
 */
export function UnrecordedNotes({ T, isDesktop = false, list, what, onForget, onRecord = null, onConfirm = null, checking = null, repeats = [], onDismissRepeat = null, items = "days" }) {
  if (!list?.length && !repeats?.length) return null;
  const firstAsking = onConfirm
    ? (list || []).find(n => !n.overlap && n.handed && !n.refused && !n.fromServer)?.number || null
    : null;
  return (
    <div style={{ marginBottom: 12 }}>
      {/* A note whose items another recorded invoice bills (useUnrecordedInvoices):
          said once, plainly, and gone in one tap. Nothing to record or answer. */}
      {(repeats || []).map(n => (
        <div key={`repeat-${n.number}`} role="status" style={{
          padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{repeatTitle(n, n.repeat)}</div>
          <div style={{ color: T.textMuted, marginBottom: 8 }}>{repeatLine(n, n.repeat, items)}</div>
          <button onClick={() => onDismissRepeat?.(n)} style={{
            padding: "7px 18px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
            background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          }}>{REPEAT_OK}</button>
        </div>
      ))}
      {(list || []).map(n => {
        // Some of its items are on another recorded invoice: said so, and
        // nothing to record (Forget it only).
        if (n.overlap) {
          return (
            <div key={n.number} role="status" style={{
              padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
              backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
            }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>{n.number} is not recorded</div>
              <div style={{ color: T.textMuted, marginBottom: 8 }}>{partialRepeatLine(n, n.overlap, items)}</div>
              <button onClick={() => { if (globalThis.window?.confirm?.(forgetUnrecordedQuestion(n.number))) onForget(n.number, { unstamp: true }); }} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              }}>Forget it</button>
            </div>
          );
        }
        // Handed to the share sheet from this device and never answered: the
        // physician knows whether it went, so the banner asks.
        const asks = !!onConfirm && n.handed && !n.refused && !n.fromServer;
        // The first that asks comes into view with its buttons (RevealOnShow);
        // revealing more would scroll the first out again.
        return (
        <RevealOnShow key={n.number} revealKey={asks && n.number === firstAsking ? n.number : null} margins="page" role="status" style={{
          padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{n.number} is not recorded{asks ? ". Did it go out?" : ""}</div>
          <div style={{ color: T.textMuted, marginBottom: 8 }}>{unrecordedBanner(n, what, { record: !!onRecord, confirm: asks })}</div>
          {asks ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={checking === n.number} aria-busy={checking === n.number ? "true" : undefined} onClick={() => { if (checking !== n.number) onConfirm(n); }} style={{
              padding: "7px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
              background: checking === n.number ? T.border : "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: checking === n.number ? "wait" : "pointer",
            }}>{checking === n.number ? SHARE_ASK_CHECKING : SHARE_ASK_YES}</button>
            {/* An answer, not a dismissal: nothing to confirm. */}
            <button onClick={() => onForget(n.number, { unstamp: true })} style={{
              padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            }}>{SHARE_ASK_NO}</button>
          </div>
          ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onRecord && (
              <button onClick={() => onRecord(n)} style={{
                padding: "7px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              }}>Record it</button>
            )}
            <button onClick={() => { if (globalThis.window?.confirm?.(forgetUnrecordedQuestion(n.number))) onForget(n.number, { unstamp: true }); }} style={{
              padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            }}>Forget it</button>
          </div>
          )}
        </RevealOnShow>
        );
      })}
    </div>
  );
}

/**
 * Work log's line for each note from another agreement than the one on
 * screen (its own reminder shows only that agreement's): after a relaunch it
 * can open on today's scheduled agreement while the invoice went out from
 * another. `onShow(contractId)` switches to that agreement, where the note
 * asks "Did it go out?". A note whose agreement is gone offers Forget it
 * (`onForget(number, { unstamp })`). Called as a function.
 */
export function OtherAgreementNotes({ T, isDesktop = false, list, contracts = [], onShow, onForget = null }) {
  if (!list?.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {list.map(n => {
        const c = contracts.find(x => x.id === n.contractId) || null;
        return (
          <div key={n.number} role="status" style={{
            padding: "10px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
            backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
          }}>
            <div style={{ color: T.text, marginBottom: 8 }}>{otherAgreementNoteLine(n, c?.facility || "")}</div>
            {c ? (
              <button onClick={() => onShow(c.id)} style={{
                padding: "7px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              }}>Show {c.facility}</button>
            ) : onForget && (
              <button onClick={() => { if (globalThis.window?.confirm?.(forgetUnrecordedQuestion(n.number))) onForget(n.number, { unstamp: true }); }} style={{
                padding: "7px 12px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              }}>Forget it</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
