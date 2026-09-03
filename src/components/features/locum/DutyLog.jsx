import { useState, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import { useInputStyle } from "../../shared/useInputStyle";
import { Modal, Field } from "../../shared";
import InvoiceDayPicker from "../../shared/InvoiceDayPicker";
import { generateId, formatDate, copyToClipboard, nextInvoiceNumber } from "../../../utils/helpers";
import { checkPlacement } from "../../../utils/scheduleGuard";
import { exportInvoice } from "../../../utils/invoiceExport";
import { invoiceSubject } from "../../../utils/invoicePdf";
import { TEXT_RULE, money } from "../../../utils/invoiceCover";
import InvoiceFormatChooser from "../../shared/InvoiceFormatChooser";
import {
  dutyDayPay, dutyLabel, summarizeDuties, hospitalsFor, callPeriodsOf,
  monthKey, monthLabel,
} from "../../../utils/dutyPay";

/**
 * Day-rate logging, for a contract that pays per day worked and per accepted
 * 24-hour call period rather than by the hour. One row per date: was it a
 * clinical day, was call taken and where, was teaching logged. The invoice
 * unit is the month, so that is what the header totals.
 */
function DutyLog({ contract }) {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [placement, setPlacement] = useState(null); // schedule warning awaiting confirmation
  const [invoicePick, setInvoicePick] = useState(null); // { days, selected: Set }
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [sent, setSent] = useState(false);

  const todayKey = (() => {
    const d = new Date();
    const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return p.toISOString().slice(0, 10);
  })();

  const duties = useMemo(
    () => (data.dutyDays || [])
      .filter(d => d.contractId === contract?.id)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [data.dutyDays, contract?.id]
  );

  const months = useMemo(() => {
    const by = new Map();
    for (const d of duties) {
      const k = monthKey(d.date);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(d);
    }
    return [...by.entries()];
  }, [duties]);

  const hospitals = hospitalsFor(contract);

  // ── Invoicing: pick the days, build the itemised invoice, stamp them ──
  // Same picker and PDF as the time engine; the lines are duty lines
  // (day rate + call periods at grid rates) instead of clock time.
  // Every unbilled row with actual duty on it — INCLUDING one that suddenly
  // prices $0 (a retitled grid row, say). A day that vanished from this list
  // could never be invoiced or questioned; a visible $0.00 day can.
  const unbilledDuties = useMemo(
    () => duties.filter(d => !d.invoiceId && (d.workedDay || callPeriodsOf(d).length > 0)),
    [duties]
  );
  const outstandingTotal = useMemo(
    () => Math.round(unbilledDuties.reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100,
    [unbilledDuties, contract]
  );

  const openInvoicePicker = () => {
    // Two rows can share a date — aggregate so a day is picked once
    const byDay = new Map();
    for (const d of unbilledDuties) {
      const cur = byDay.get(d.date) || { amount: 0, labels: [] };
      cur.amount += dutyDayPay(contract, d).total;
      cur.labels.push(dutyLabel(d));
      byDay.set(d.date, cur);
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({ key, amount: Math.round(v.amount * 100) / 100, note: v.labels.join(" · ") }));
    if (!days.length) return;
    // Future-dated days list but start unchecked — invoicing a day that
    // hasn't happened should be deliberate.
    setInvoicePick({ days, selected: new Set(days.filter(d => d.key <= todayKey).map(d => d.key)) });
  };

  const pickTotal = invoicePick
    ? Math.round(unbilledDuties
        .filter(d => invoicePick.selected.has(d.date))
        .reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100
    : 0;

  const buildDutyInvoice = (sel) => {
    const chosen = unbilledDuties
      .filter(d => sel.has(d.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!chosen.length) return;
    // A call period pricing $0 means its hospital no longer matches the
    // contract's rate grid — an invoice must never go out short silently.
    const zeroCalls = chosen.reduce((n, d) =>
      n + dutyDayPay(contract, d).lines.filter(l => l.label.startsWith("On call") && !l.amount).length, 0);
    if (zeroCalls > 0 && !window.confirm(
      `${zeroCalls} call period${zeroCalls === 1 ? "" : "s"} price at $0 — the hospital on the logged day doesn't match the contract's rate grid anymore. Fix the day or the contract first, or build the invoice anyway?`
    )) return;
    const s = data.settings || {};
    const physician = s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician";
    const num = nextInvoiceNumber(data.invoices);
    const lines = [];
    let total = 0;
    for (const d of chosen) {
      const pay = dutyDayPay(contract, d);
      pay.lines.forEach((l, i) => {
        lines.push({ date: d.date, label: l.label, detail: i === 0 && d.notes ? d.notes : "", amount: l.amount });
      });
      total += pay.total;
    }
    total = Math.round(total * 100) / 100;
    const dayRate = Number(contract.dayRate)
      || (Number(contract.clinicalDayRate) || 0) + (Number(contract.scholarlyRate) || 0);
    const terms = `${money(dayRate)} all-in day rate per day worked; 24-hour call periods per the agreement's coverage-rate grid (per hospital and role)`;
    const dates = chosen.map(d => d.date);
    const div = TEXT_RULE;
    const textLines = [
      "INVOICE " + num, div,
      `From: ${physician}${s.npi ? " · NPI " + s.npi : ""}`,
      ...(s.email ? [`Email: ${s.email}`] : []),
      `To: ${contract.facility}${contract.agency ? " (via " + contract.agency + ")" : ""}`,
      `Period: ${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}`,
      `Terms: ${terms}`, div,
      ...lines.flatMap(l => [`${formatDate(l.date)}  ${l.label}`, `   ${l.detail ? l.detail + " = " : ""}${money(l.amount)}`]),
      div, `TOTAL DUE: ${money(total)}`, "",
      `Generated by CredentialDOMD · ${new Date().toLocaleDateString()}`,
    ];
    setSent(false); // a fresh preview must never inherit a stale ✓
    setInvoicePreview({
      number: num, lines, total, terms,
      dutyIds: chosen.map(d => d.id),
      periodStart: dates[0], periodEnd: dates[dates.length - 1],
      text: textLines.join("\n"),
    });
  };

  const markDutyBilled = (method) => {
    if (!invoicePreview) return;
    const invId = generateId();
    for (const id of invoicePreview.dutyIds) {
      const d = (data.dutyDays || []).find(x => x.id === id);
      if (d) editItem("dutyDays", { ...d, invoiceId: invId });
    }
    addItem("invoices", {
      id: invId,
      number: invoicePreview.number,
      contractId: contract.id,
      periodStart: invoicePreview.periodStart,
      periodEnd: invoicePreview.periodEnd,
      entryIds: invoicePreview.dutyIds,
      totalMinutes: 0,
      totalAmount: invoicePreview.total,
      dayOverMin: {},
      method,
      sentAt: new Date().toISOString(),
      paidAt: null,
      text: invoicePreview.text,
      lines: invoicePreview.lines,
      terms: invoicePreview.terms,
    });
    setSent(true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
  };

  const [fmtOpen, setFmtOpen] = useState(false);
  const sendDutyInvoice = async (format) => {
    const s = data.settings || {};
    const args = {
      number: invoicePreview.number,
      physician: s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician",
      npi: s.npi, email: s.email,
      facility: contract.facility, agency: contract.agency,
      location: contract.location, billTo: contract.billTo,
      periodStart: invoicePreview.periodStart, periodEnd: invoicePreview.periodEnd,
      terms: invoicePreview.terms, lines: invoicePreview.lines,
      totalMin: 0, total: invoicePreview.total,
    };
    const how = await exportInvoice(args, format, invoiceSubject(args), invoicePreview.text);
    if (how === null) return; // share sheet cancelled
    markDutyBilled(`${how.startsWith("share") ? "share" : "download"}-${format}`);
  };

  const openNew = () => {
    setEditing("new");
    setForm({
      date: todayKey,
      workedDay: true,
      callPeriods: [],
      notes: "",
    });
  };
  const openEdit = (d) => { setEditing(d.id); setForm({ ...d, callPeriods: callPeriodsOf(d) }); };
  useDeskAddShortcut(openNew);

  // The schedule is checked before the day is written, not after. A warning
  // is never a block — the physician knows where he was — but it has to be
  // confirmed, and the confirmation is recorded on the day.
  const save = (confirmed = false) => {
    if (!form.date) return;
    // A billed day backs a sent invoice — editing changes the records but
    // never the document that went out; make that explicit before saving.
    // (Skipped on the placement re-entry so it can't ask twice per save.)
    if (!confirmed && editing !== "new" && form.invoiceId && !window.confirm(
      "This day is already on a sent invoice. Editing updates your records but NOT the invoice that went out — to change the invoice too, delete it on the Invoices tab (days become unbilled) and generate it again. Edit anyway?"
    )) return;
    if (!confirmed && !form.placementOk) {
      const warn = checkPlacement(data.locumContracts || [], contract, form.date);
      if (warn) { setPlacement(warn); return; }
    }
    const clean = {
      contractId: contract.id,
      date: form.date,
      workedDay: !!form.workedDay,
      callPeriods: (form.callPeriods || []).filter(p => p && p.hospital),
      // Legacy columns kept in step so an older client still reads the day
      callHospital: (form.callPeriods || [])[0]?.hospital || null,
      callRole: (form.callPeriods || [])[0]?.role || null,
      notes: form.notes || "",
      placementOk: confirmed || !!form.placementOk,
    };
    clean.amount = dutyDayPay(contract, clean).total;
    if (editing === "new") addItem("dutyDays", { id: generateId(), createdAt: new Date().toISOString(), ...clean });
    else editItem("dutyDays", { ...form, ...clean });
    setEditing(null);
    setForm({});
  };

  const preview = dutyDayPay(contract, form);

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: "0 0 3px", fontSize: 17, fontWeight: 800, color: T.text }}>Days &amp; call</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          This contract pays per day worked and per accepted 24-hour call period. Log the day; the rate comes from the agreement.
        </div>
      </div>

      <button onClick={openNew} style={{
        width: "100%", padding: "13px", borderRadius: 12, border: "none", marginBottom: 8,
        background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
        fontSize: 15, fontWeight: 800, cursor: "pointer",
      }}>+ Log a day</button>

      {/* Invoice CTA — same pick-the-days flow as the time engine. Counts
          DAYS (two rows on one date are still one day) to match the picker. */}
      {unbilledDuties.length > 0 && (() => {
        const nDays = new Set(unbilledDuties.map(d => d.date)).size;
        return (
          <button onClick={openInvoicePicker} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 16px", borderRadius: 14, border: `2px solid ${T.accent}`,
            backgroundColor: T.card, cursor: "pointer", marginBottom: 14, boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
              {"🧾"} Invoice {nDays} unbilled day{nDays === 1 ? "" : "s"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.accent }}>{money(outstandingTotal)}</span>
          </button>
        );
      })()}

      {months.length === 0 && (
        <div style={{ textAlign: "center", padding: "26px 18px", backgroundColor: T.card, borderRadius: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>{"📅"}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>No days logged</div>
          <div style={{ fontSize: 13.5, color: T.textMuted }}>Log each weekday you work and each call period you accept.</div>
        </div>
      )}

      {months.map(([mk, list]) => {
        const sum = summarizeDuties(contract, list);
        return (
          <div key={mk} style={{ marginBottom: 16 }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "10px 12px", borderRadius: 12, marginBottom: 6,
              backgroundColor: T.card, border: `2px solid ${T.accent}`,
            }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{monthLabel(mk)}</div>
                <div style={{ fontSize: 11.5, color: T.textDim }}>
                  {sum.workedDays} day{sum.workedDays === 1 ? "" : "s"} worked · {sum.callPeriods} call period{sum.callPeriods === 1 ? "" : "s"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>
                  ${sum.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ fontSize: 10.5, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
                  day work ${sum.dayWork.toLocaleString("en-US", { maximumFractionDigits: 0 })} · call ${sum.callPay.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              </div>
            </div>

            {/* Call pay varies fourfold across the grid — show where it came from */}
            {sum.byHospital.length > 0 && (
              <div style={{ padding: "8px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, marginBottom: 6 }}>
                {sum.byHospital.map((h, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: T.textMuted, padding: "2px 0" }}>
                    <span>{h.hospital.replace(/\s*\(.*\)$/, "")} — {h.role} × {h.periods}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>${h.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {list.map(d => {
                const pay = dutyDayPay(contract, d);
                return (
                  <div key={d.id} role="button" tabIndex={0}
                    onClick={() => openEdit(d)}
                    onKeyDown={(e) => { if (e.key === "Enter") openEdit(d); }}
                    style={{
                      backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                      padding: "10px 12px", boxShadow: T.shadow1, cursor: "pointer",
                      display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center",
                    }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                        {new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                        {dutyLabel(d)}{callPeriodsOf(d).length ? ` · ${callPeriodsOf(d).map(p => p.hospital.replace(/\s*\(.*\)$/, "")).join(", ")}` : ""}
                        {d.invoiceId && <span style={{ fontWeight: 800, color: T.textDim }}> · billed</span>}
                      </div>
                      {d.notes && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2 }}>{d.notes}</div>}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#22c55e", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      ${pay.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <Modal open={!!invoicePick} onClose={() => setInvoicePick(null)} title="Which days go on this invoice?">
        {invoicePick && (
          <>
            <InvoiceDayPicker
              T={T}
              days={invoicePick.days}
              selected={invoicePick.selected}
              onChange={(s2) => setInvoicePick(p => ({ ...p, selected: s2 }))}
            />
            <button
              onClick={() => { const s2 = new Set(invoicePick.selected); setInvoicePick(null); buildDutyInvoice(s2); }}
              disabled={invoicePick.selected.size === 0}
              style={{
                width: "100%", padding: "14px", borderRadius: 12, border: "none", marginTop: 4,
                background: invoicePick.selected.size ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
                color: "#fff", fontSize: 15, fontWeight: 800, cursor: invoicePick.selected.size ? "pointer" : "default",
              }}>
              Invoice {invoicePick.selected.size} day{invoicePick.selected.size === 1 ? "" : "s"} — {money(pickTotal)}
            </button>
          </>
        )}
      </Modal>

      <Modal open={!!invoicePreview} onClose={() => { setInvoicePreview(null); setSent(false); }} title="Invoice preview">
        {invoicePreview && (
          <>
            <div style={{
              backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 12,
              padding: 12, marginBottom: 14, maxHeight: 300, overflow: "auto",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{invoicePreview.number}</span>
                <span style={{ fontSize: 12, color: T.textMuted }}>
                  {formatDate(invoicePreview.periodStart)}{invoicePreview.periodEnd !== invoicePreview.periodStart ? ` – ${formatDate(invoicePreview.periodEnd)}` : ""}
                </span>
              </div>
              {invoicePreview.lines.map((l, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: T.textMuted, padding: "3px 0" }}>
                  <span style={{ minWidth: 0 }}>{formatDate(l.date)} · {l.label}{l.detail ? ` — ${l.detail}` : ""}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, flexShrink: 0 }}>{money(l.amount)}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: T.text, borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
                <span>TOTAL DUE</span>
                <span style={{ color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>{money(invoicePreview.total)}</span>
              </div>
            </div>
            {sent ? (
              <div style={{ textAlign: "center", padding: "12px", fontSize: 15, fontWeight: 800, color: "#22c55e" }}>
                ✓ Marked sent — it's on the Invoices tab
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button onClick={() => setFmtOpen(true)} style={{
                  width: "100%", padding: "14px", borderRadius: 12, border: "none",
                  background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                  fontSize: 15, fontWeight: 800, cursor: "pointer",
                }}>Send invoice…</button>
                <InvoiceFormatChooser open={fmtOpen} onClose={() => setFmtOpen(false)}
                  onPick={(f) => { setFmtOpen(false); sendDutyInvoice(f); }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { copyToClipboard(invoicePreview.text); markDutyBilled("copy"); }} style={{
                    flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                  }}>Copy text &amp; mark sent</button>
                  <button onClick={() => setInvoicePreview(null)} style={{
                    padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.textMuted, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal open={!!editing} onClose={() => { setEditing(null); setForm({}); }} title={editing === "new" ? "Log a day" : "Edit day"}>
        {editing && (
          <>
            <Field label="Date"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>

            <Field label="Day worked" hint="Surgery, clinic, rounding, or other daytime services — pays the all-in day rate">
              <button onClick={() => setForm(f => ({ ...f, workedDay: !f.workedDay }))} style={{
                width: "100%", padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer",
                border: `1px solid ${form.workedDay ? T.accent : T.border}`,
                backgroundColor: form.workedDay ? T.accent : "transparent",
                color: form.workedDay ? "#fff" : T.textMuted,
              }}>{form.workedDay ? "Yes — day worked" : "No clinical day"}</button>
            </Field>

            <Field label="On call" hint="Each hospital covered pays its own grid rate — add one row per hospital">
              {(form.callPeriods || []).map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                  <select value={p.hospital} onChange={e => setForm(f => ({
                    ...f, callPeriods: f.callPeriods.map((x, j) => j === i ? { ...x, hospital: e.target.value } : x),
                  }))} style={{ ...iS, appearance: "auto", flex: 1, minWidth: 0 }}>
                    {hospitals.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <button onClick={() => setForm(f => ({
                    ...f, callPeriods: f.callPeriods.map((x, j) => j === i ? { ...x, role: x.role === "backup" ? "primary" : "backup" } : x),
                  }))} style={{
                    padding: "11px 13px", borderRadius: 10, fontSize: 12.5, fontWeight: 800, cursor: "pointer", flexShrink: 0,
                    border: `1px solid ${p.role === "backup" ? T.border : T.accent}`,
                    backgroundColor: p.role === "backup" ? "transparent" : T.accent,
                    color: p.role === "backup" ? T.textMuted : "#fff",
                  }}>{p.role === "backup" ? "Backup" : "Primary"}</button>
                  <button onClick={() => setForm(f => ({ ...f, callPeriods: f.callPeriods.filter((_, j) => j !== i) }))} style={{
                    padding: "11px 12px", borderRadius: 10, border: "none", flexShrink: 0,
                    backgroundColor: T.dangerDim, color: T.danger, fontSize: 13, fontWeight: 800, cursor: "pointer",
                  }}>×</button>
                </div>
              ))}
              <button onClick={() => setForm(f => ({
                ...f, callPeriods: [...(f.callPeriods || []), { hospital: hospitals[0] || "", role: "primary" }],
              }))} style={{
                width: "100%", padding: "11px", borderRadius: 10, cursor: "pointer",
                border: `1px dashed ${T.accent}`, backgroundColor: "transparent",
                color: T.accent, fontSize: 13, fontWeight: 800,
              }}>+ Add a call period</button>
            </Field>

            <Field label="Notes"><input value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={iS} placeholder="optional" /></Field>

            {/* The arithmetic, itemised, so the invoice is never a mystery */}
            <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
              {preview.lines.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>Nothing logged for this day — it invoices $0.</div>}
              {preview.lines.map((l, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted, padding: "3px 0" }}>
                  <span>{l.label}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>${l.amount.toFixed(2)}</span>
                </div>
              ))}
              {preview.lines.length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: T.text, borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
                  <span>This day invoices</span>
                  <span style={{ color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>${preview.total.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => save(false)} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
              }}>Save</button>
              {editing !== "new" && !form.invoiceId && (
                <button onClick={() => { if (window.confirm("Delete this day?")) { deleteItem("dutyDays", editing); setEditing(null); } }} style={{
                  padding: "13px 16px", borderRadius: 12, border: "none",
                  backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>Delete</button>
              )}
              <button onClick={() => { setEditing(null); setForm({}); }} style={{
                padding: "13px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </>
        )}
      </Modal>

      {/* Schedule warning — rendered LAST so it stacks ON TOP of the form
          that triggered it, never hidden behind it. */}
      <Modal open={!!placement} onClose={() => setPlacement(null)} title={placement?.title || "Check the date"}>
        {placement && (
          <>
            <div style={{ fontSize: 14, color: T.text, lineHeight: 1.55 }}>{placement.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setPlacement(null); save(true); }} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
              }}>Yes, log it here</button>
              <button onClick={() => setPlacement(null)} style={{
                padding: "13px 18px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Go back</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export default memo(DutyLog);
