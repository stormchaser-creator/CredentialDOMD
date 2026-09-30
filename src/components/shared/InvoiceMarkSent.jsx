import Field from "./Field";
import { recordRefusedNotice, unrecordedBanner, forgetUnrecordedQuestion } from "../../utils/invoiceRecord";

/**
 * The part of an invoice preview that makes sure an invoice that went out is
 * on the Invoices tab (utils/invoiceRecord.js). Three states, in this order:
 *
 *  - `pending`: the invoice went out and its record was refused. A banner
 *    says so and "Record as sent" saves it, under the number it went out with.
 *    Each refused tap is said in the banner (`pending.tries`, `pending.why`),
 *    not left to addItem's alert, which stays quiet for a few seconds.
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
 * Stateless: the preview holds `form` ({ number, day, from, at, problem, tries }
 * or null) and passes the handlers. Called as a function from the preview, so
 * its buttons sit in the preview's own element tree.
 */
export default function InvoiceMarkSent({
  T, iS, pending, note, form, setForm, start, today, waiting,
  onRecordPending, onRecordMarked, unbilled = "these entries",
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
            <button onClick={() => setForm(null)} style={{
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
 * was left behind (the preview closed, the page reloaded): what it was and
 * how to record it, and a way to forget it. Called as a function.
 */
export function UnrecordedNotes({ T, list, what, onForget }) {
  if (!list?.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {list.map(n => (
        <div key={n.number} role="status" style={{
          padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{n.number} is not recorded</div>
          <div style={{ color: T.textMuted, marginBottom: 8 }}>{unrecordedBanner(n, what)}</div>
          <button onClick={() => { if (globalThis.window?.confirm?.(forgetUnrecordedQuestion(n.number))) onForget(n.number); }} style={{
            padding: "7px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          }}>Forget it</button>
        </div>
      ))}
    </div>
  );
}
