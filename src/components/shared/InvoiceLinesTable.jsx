import { Fragment } from "react";
import { useApp } from "../../context/AppContext";
import { formatDate } from "../../utils/helpers";
import { money } from "../../utils/invoiceCover";
import { invoiceLayout, sortInvoiceLines } from "../../utils/invoiceLayout";

/**
 * An invoice's line items on screen, as the PDF prints them: one block per
 * day, the stipend and the callback beyond it each with its own amount, the
 * work under them (what sat inside the stipend says so, in dollars), and a
 * total for every day (utils/invoiceLayout.js). An invoice whose day totals
 * cannot be shown adding up keeps the old Date | Item | Amount table, the
 * same fallback every exported format uses; when a rate that bills fractions
 * of a cent is the reason, the physician is told so here (never on the
 * invoice itself).
 *
 * `inv` needs { lines, total | totalAmount, dayStartHour? }.
 */
export default function InvoiceLinesTable({ inv }) {
  const { theme: T } = useApp();
  const layout = invoiceLayout(inv);
  const total = inv?.total ?? inv?.totalAmount;
  const cellBase = { padding: "6px 6px", borderBottom: `1px solid ${T.border}`, verticalAlign: "top" };
  const headStyle = (right) => ({
    textAlign: right ? "right" : "left", padding: "6px 6px",
    borderBottom: `2px solid ${T.accent}`, color: T.textMuted,
    fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
  });
  const totalRow = (
    <tr>
      <td colSpan={layout.mode === "days" ? 1 : 2} style={{ padding: "8px 6px", fontWeight: 800, color: T.text }}>TOTAL DUE</td>
      <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 800, fontSize: 14, color: T.accent }}>{money(total)}</td>
    </tr>
  );

  if (layout.mode === "flat") {
    return (
      <>
      {layout.fractionalCents && (
        <div role="note" style={{ fontSize: 11.5, lineHeight: 1.45, color: T.textMuted, backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 9px", marginBottom: 8 }}>
          No day totals on this invoice: this agreement bills fractions of a cent (one line comes to {layout.fractionalCents}), so day totals rounded to the cent would not add up to the total due. It prints as one list, as invoices did before day totals.
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{["Date", "Item", "Amount"].map((h, i) => <th key={h} style={headStyle(i === 2)}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {sortInvoiceLines(inv?.lines || []).map((l, i) => (
            <tr key={i}>
              <td style={{ ...cellBase, color: T.textDim, whiteSpace: "nowrap" }}>{l.date ? formatDate(l.date) : ""}</td>
              <td style={{ ...cellBase, color: T.text }}>
                <div style={{ fontWeight: l.amount == null ? 500 : 700, paddingLeft: l.amount == null ? 10 : 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l.label}</div>
                {l.detail && <div style={{ fontSize: 11, color: T.textMuted, whiteSpace: "pre-line", paddingLeft: l.amount == null ? 10 : 0 }}>{l.detail}</div>}
              </td>
              <td style={{ ...cellBase, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", color: l.amount ? T.text : l.flag === "included" ? (T.success || T.accent) : T.textDim, fontSize: l.amount == null ? 11 : undefined }}>
                {l.amount == null ? (l.flag || "") : money(l.amount)}
              </td>
            </tr>
          ))}
          {totalRow}
        </tbody>
      </table>
      </>
    );
  }

  const toneColor = (r) => (r.tone === "included" ? (T.success || T.accent) : r.tone === "quiet" ? T.textDim : r.level ? T.textMuted : T.text);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr><th style={headStyle(false)}>Item</th><th style={headStyle(true)}>Amount</th></tr>
      </thead>
      <tbody>
        {layout.days.map((day) => (
          <Fragment key={day.date ?? "other"}>
            <tr>
              <td colSpan={2} style={{ padding: "7px 6px", backgroundColor: T.accentDim, color: T.text, fontWeight: 700 }}>
                {day.title}
                {day.window && <span style={{ fontWeight: 500, color: T.textMuted }}>{` \u{b7} ${day.window}`}</span>}
              </td>
            </tr>
            {day.rows.map((r, i) => {
              const words = r.detail != null ? r.detail : [r.time, r.note, r.hours].filter(Boolean).join(" \u{b7} ");
              return (
                <tr key={i}>
                  <td style={{ ...cellBase, paddingLeft: r.level ? 18 : 6 }}>
                    <div style={{ fontWeight: r.level ? 500 : 700, color: r.level ? T.textMuted : T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.item}</div>
                    {words && <div style={{ fontSize: 11, color: T.textDim, whiteSpace: "pre-line" }}>{words}</div>}
                  </td>
                  <td style={{ ...cellBase, textAlign: "right", fontWeight: r.level ? 600 : 700, color: toneColor(r), fontSize: r.level ? 11 : undefined, fontVariantNumeric: "tabular-nums" }}>
                    {r.amountText}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td style={{ padding: "7px 6px 12px", borderTop: `1.5px solid ${T.text}`, textAlign: "right", fontWeight: 800, color: T.text }}>{day.totalLabel}</td>
              <td style={{ padding: "7px 6px 12px", borderTop: `1.5px solid ${T.text}`, textAlign: "right", fontWeight: 800, color: T.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{money(day.total)}</td>
            </tr>
          </Fragment>
        ))}
        {totalRow}
      </tbody>
    </table>
  );
}
