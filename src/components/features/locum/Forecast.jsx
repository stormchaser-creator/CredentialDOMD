import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import { generateId, formatDate } from "../../../utils/helpers";
import { iso, actualByDate, contractDayAverage, yearOutlook } from "../../../utils/forecast";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const short = (n) => {
  const v = parseFloat(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`;
};

/**
 * Forecast — the billing calendar. Load contract coverage dates, assign
 * days (day / call) with an expected amount seeded from each contract's
 * real per-day average, project income forward for tax and expense
 * planning, and reconcile every past month: estimated vs billed, over
 * or under.
 */
function Forecast() {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const contracts = data.locumContracts || [];
  const sched = data.scheduleDays || [];
  const today = iso(new Date());

  const [month, setMonth] = useState(() => today.slice(0, 7));
  const actuals = useMemo(() => actualByDate(data), [data]);
  const avgOf = useMemo(() => {
    const m = {};
    for (const c of contracts) m[c.id] = contractDayAverage(data, c.id);
    return m;
  }, [data, contracts]);
  // Rate-structured contracts (EMC/ANMG daily model) price by the day type:
  // day = the day rate, day+call adds the call stipend. Stipend contracts
  // (Good Sam et al) use the historical per-day average instead.
  const suggestFor = (cid, kind) => {
    const c = contracts.find(x => x.id === cid);
    const day = parseFloat(c?.dayRate) || 0;
    const call = parseFloat(c?.callStipend) || 0;
    if (day) {
      if (kind === "day") return Math.round(day);
      if (kind === "call") return Math.round(call || day);
      return Math.round(day + call);
    }
    return avgOf[cid] || 0;
  };
  const year = parseInt(month.slice(0, 4), 10);
  const outlook = useMemo(() => yearOutlook(sched, actuals, year, today), [sched, actuals, year, today]);

  const schedByDate = useMemo(() => {
    const m = {};
    for (const s of sched) (m[s.date] = m[s.date] || []).push(s);
    return m;
  }, [sched]);

  // Calendar grid for the shown month
  const [yy, mm] = month.split("-").map(Number);
  const first = new Date(yy, mm - 1, 1);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const lead = first.getDay(); // Sunday-start
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);

  const nav = (dir) => {
    const d = new Date(yy, mm - 1 + dir, 1);
    setMonth(iso(d).slice(0, 7));
  };

  // Day editor
  const [editDay, setEditDay] = useState(null); // date string
  const [form, setForm] = useState({});
  const openDay = (date) => {
    const existing = (schedByDate[date] || [])[0];
    const cid = existing?.contractId || contracts[0]?.id || "";
    const defKind = (contracts.find(c => c.id === cid)?.payModel === "daily") ? "day" : "call";
    setForm(existing
      ? { ...existing }
      : { date, contractId: cid, kind: defKind, expected: suggestFor(cid, defKind) || "" });
    setEditDay(date);
  };
  const saveDay = () => {
    const entry = {
      ...form,
      id: form.id || generateId(),
      expected: parseFloat(form.expected) || 0,
    };
    if (sched.some(s => s.id === entry.id)) editItem("scheduleDays", entry);
    else addItem("scheduleDays", entry);
    setEditDay(null);
  };
  const removeDay = () => {
    if (form.id && sched.some(s => s.id === form.id)) deleteItem("scheduleDays", form.id);
    setEditDay(null);
  };

  // One tap: every coverage day on every contract becomes a scheduled day
  // (past ones included — that's what makes reconciliation possible).
  const [loadMsg, setLoadMsg] = useState(null);
  const loadContractDates = () => {
    const have = new Set(sched.map(s => `${s.contractId}|${s.date}`));
    let added = 0;
    for (const c of contracts) {
      const periods = c.coveragePeriods?.length
        ? c.coveragePeriods
        : (c.startDate ? [{ start: c.startDate, end: c.endDate || c.startDate }] : []);
      for (const p of periods) {
        if (!p.start) continue;
        const end = p.end || p.start;
        // A multi-year agreement (ANMG) is not a solid block of worked
        // days — skip periods longer than 62 days rather than fabricate.
        const span = Math.round((new Date(end) - new Date(p.start)) / 86400000) + 1;
        if (span > 62 || span < 1) continue;
        const d = new Date(p.start + "T00:00:00");
        for (let i = 0; i < span; i++) {
          const date = iso(d);
          if (!have.has(`${c.id}|${date}`)) {
            addItem("scheduleDays", {
              id: generateId(), date, contractId: c.id,
              kind: c.payModel === "daily" ? "day" : "call",
              expected: avgOf[c.id] || 0,
            });
            added++;
          }
          d.setDate(d.getDate() + 1);
        }
      }
    }
    setLoadMsg(added > 0
      ? `Loaded ${added} coverage day${added === 1 ? "" : "s"} from your agreements — tap any day to adjust the amount.`
      : "All coverage dates are already on the calendar. Multi-year blocks (ANMG) are skipped — tap individual days to add those.");
    setTimeout(() => setLoadMsg(null), 8000);
  };

  const facilityShort = (cid) => {
    const f = contracts.find(c => c.id === cid)?.facility || "?";
    return f.split(" ")[0];
  };

  // Month summary numbers
  const mRow = outlook.months.find(x => x.key === month) || { est: 0, actual: 0 };

  return (
    <div>
      {/* Projection headline */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Projected {year} billing</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.text, margin: "2px 0", fontVariantNumeric: "tabular-nums" }}>{money(outlook.projectedYear)}</div>
        <div style={{ fontSize: 12.5, color: T.textDim }}>
          Actuals through today + your scheduled estimates ahead. Feed this into Finance → Tax Prep set-aside planning.
        </div>
      </div>

      {/* Calendar */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "12px 12px 8px", boxShadow: T.shadow1, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <button onClick={() => nav(-1)} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>‹</button>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>
            {first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </div>
          <button onClick={() => nav(1)} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, cursor: "pointer", fontWeight: 800 }}>›</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 700, color: T.textDim }}>{d}</div>
          ))}
          {cells.map((date, i) => {
            if (!date) return <div key={`b${i}`} />;
            const entries = schedByDate[date] || [];
            const est = entries.reduce((t, s) => t + (parseFloat(s.expected) || 0), 0);
            const act = actuals[date] || 0;
            const isPast = date < today;
            const isToday = date === today;
            return (
              <div key={date} onClick={() => openDay(date)} style={{
                minHeight: 46, borderRadius: 8, padding: "3px 2px", cursor: "pointer", textAlign: "center",
                border: `1px solid ${isToday ? T.accent : entries.length ? (T.accentDim || "rgba(16,185,129,0.35)") : "transparent"}`,
                backgroundColor: entries.length ? (T.accentGlow || "rgba(16,185,129,0.08)") : T.input,
                opacity: isPast && !entries.length && !act ? 0.55 : 1,
              }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: T.text }}>{parseInt(date.slice(8), 10)}</div>
                {entries.length > 0 && (
                  <div style={{ fontSize: 9, fontWeight: 800, color: T.accent, lineHeight: 1.2 }}>
                    {facilityShort(entries[0].contractId)}<br />{short(est)}
                  </div>
                )}
                {/* The green billed figure only earns its row when it differs
                    from the estimate — past days seeded from actuals would
                    otherwise print the same number twice. */}
                {isPast && act > 0 && Math.round(act) !== Math.round(est) && (
                  <div style={{ fontSize: 8.5, fontWeight: 700, color: "#22c55e" }}>{short(act)}</div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 4px 4px", fontSize: 12, color: T.textDim }}>
          <span>est {money(mRow.est)}{mRow.past ? ` · billed ${money(mRow.actual)}` : ""}</span>
          <span style={{ fontSize: 10.5 }}>green = actually billed</span>
        </div>
      </div>

      <button onClick={loadContractDates} style={{
        width: "100%", padding: "12px", borderRadius: 11, border: `1px dashed ${T.accent}`,
        backgroundColor: "transparent", color: T.accent, fontSize: 13.5, fontWeight: 700, cursor: "pointer", marginBottom: 10,
      }}>Load contract coverage dates onto the calendar</button>
      {loadMsg && <div style={{ fontSize: 12.5, fontWeight: 600, color: T.accent, marginBottom: 10 }}>{loadMsg}</div>}

      {/* Reconciliation: month by month, was the estimate right? */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
          Estimated vs billed — {year}
        </div>
        {outlook.months.filter(x => x.hasData).map(x => {
          const name = new Date(year, parseInt(x.key.slice(5), 10) - 1, 1).toLocaleDateString("en-US", { month: "short" });
          const over = x.delta < 0; // billed less than estimated = over-estimated
          return (
            <div key={x.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.border}`, fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: T.text, width: 34 }}>{name}</span>
              <span style={{ color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>est {money(x.est)}</span>
              <span style={{ color: T.text, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{x.past ? `billed ${money(x.actual)}` : "ahead"}</span>
              <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums", color: !x.past ? T.textDim : x.delta === 0 ? T.textDim : over ? "#f97316" : "#22c55e", textAlign: "right", minWidth: 70 }}>
                {x.past && x.est > 0 ? `${x.delta >= 0 ? "+" : "−"}${money(Math.abs(x.delta))}` : ""}
              </span>
            </div>
          );
        })}
        {outlook.months.every(x => !x.hasData) && (
          <div style={{ fontSize: 12.5, color: T.textMuted }}>
            Nothing scheduled yet — load your contract dates above, or tap any calendar day.
          </div>
        )}
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 6 }}>
          Green +$ means you billed more than you estimated (under-estimated); orange −$ means you estimated high.
        </div>
      </div>

      {/* Day editor */}
      <Modal open={!!editDay} onClose={() => setEditDay(null)} title={editDay ? formatDate(editDay) : ""}>
        <Field label="Contract">
          <select value={form.contractId || ""} onChange={e => {
            const cid = e.target.value;
            setForm(f => ({ ...f, contractId: cid, expected: suggestFor(cid, f.kind) || "" }));
          }} style={{ ...iS, appearance: "auto" }}>
            {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
          </select>
        </Field>
        <Field label="Type of day">
          <div style={{ display: "flex", gap: 6 }}>
            {[["call", "Call"], ["day", "Day"], ["day+call", "Day + call"]].map(([k, label]) => (
              <button key={k} onClick={() => setForm(f => ({ ...f, kind: k, expected: suggestFor(f.contractId, k) || f.expected }))} style={{
                flex: 1, padding: "9px", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${form.kind === k ? T.accent : T.border}`,
                backgroundColor: form.kind === k ? (T.accentDim || "rgba(16,185,129,0.14)") : "transparent",
                color: form.kind === k ? T.accent : T.textMuted,
              }}>{label}</button>
            ))}
          </div>
        </Field>
        <Field label="Expected earnings ($)" hint={(() => {
          const c = contracts.find(x => x.id === form.contractId);
          const day = parseFloat(c?.dayRate) || 0;
          const call = parseFloat(c?.callStipend) || 0;
          if (day) return `Contract rates: day ${money(day)} · day + call ${money(day + call)} — the type above sets the price.`;
          return avgOf[form.contractId] ? `This contract has averaged ${money(avgOf[form.contractId])} per worked day.` : "No history yet — contract rate used as the starting point.";
        })()}>
          <input type="number" inputMode="decimal" value={form.expected ?? ""} onChange={e => setForm(f => ({ ...f, expected: e.target.value }))} style={iS} />
        </Field>
        {editDay && actuals[editDay] > 0 && (
          <div style={{ fontSize: 13, fontWeight: 700, color: "#22c55e", marginTop: 4 }}>
            Actually billed this day: {money(actuals[editDay])}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {form.id && sched.some(s => s.id === form.id) && (
            <button onClick={removeDay} style={{ padding: "12px 16px", borderRadius: 10, border: "none", backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Remove</button>
          )}
          <button onClick={saveDay} style={{ flex: 1, padding: "12px 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>Save day</button>
        </div>
      </Modal>
    </div>
  );
}

export default memo(Forecast);
