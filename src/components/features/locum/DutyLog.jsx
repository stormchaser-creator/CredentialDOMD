import { useState, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import { Modal, Field } from "../../shared";
import { generateId } from "../../../utils/helpers";
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

  const openNew = () => {
    setEditing("new");
    setForm({
      date: todayKey,
      workedDay: true,
      scholarly: false,
      callPeriods: [],
      notes: "",
    });
  };
  const openEdit = (d) => { setEditing(d.id); setForm({ ...d, callPeriods: callPeriodsOf(d) }); };

  const save = () => {
    if (!form.date) return;
    const clean = {
      contractId: contract.id,
      date: form.date,
      workedDay: !!form.workedDay,
      scholarly: !!form.scholarly,
      callPeriods: (form.callPeriods || []).filter(p => p && p.hospital),
      // Legacy columns kept in step so an older client still reads the day
      callHospital: (form.callPeriods || [])[0]?.hospital || null,
      callRole: (form.callPeriods || [])[0]?.role || null,
      notes: form.notes || "",
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
        width: "100%", padding: "13px", borderRadius: 12, border: "none", marginBottom: 14,
        background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
        fontSize: 15, fontWeight: 800, cursor: "pointer",
      }}>+ Log a day</button>

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
                        {d.scholarly ? " · teaching logged" : ""}
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

      <Modal open={!!editing} onClose={() => { setEditing(null); setForm({}); }} title={editing === "new" ? "Log a day" : "Edit day"}>
        {editing && (
          <>
            <Field label="Date"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>

            <Field label="Clinical day worked" hint="Surgery, clinic, rounding, or other daytime services">
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

            {form.workedDay && (
            <Field label="Teaching logged" hint="Paid on worked weekdays only, and contingent on the monthly teaching log">
              <button onClick={() => setForm(f => ({ ...f, scholarly: !f.scholarly }))} style={{
                width: "100%", padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer",
                border: `1px solid ${form.scholarly ? T.accent : T.border}`,
                backgroundColor: form.scholarly ? T.accent : "transparent",
                color: form.scholarly ? "#fff" : T.textMuted,
              }}>{form.scholarly ? "Yes — teaching documented" : "No teaching this day"}</button>
            </Field>
            )}
            {!form.workedDay && (form.callPeriods || []).length > 0 && (
              <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 6 }}>
                A call period without a worked weekday pays the grid rate alone — the scholarly fee is a worked-weekday component under V4.
              </div>
            )}

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
              <button onClick={save} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
              }}>Save</button>
              {editing !== "new" && (
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
    </div>
  );
}

export default memo(DutyLog);
