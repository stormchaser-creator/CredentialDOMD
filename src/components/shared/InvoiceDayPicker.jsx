/**
 * The day-selection list an invoice is built from, grouped into Sun–Sat
 * weeks with one-tap week toggles. Agencies differ — one wants weekly
 * Sun–Sat invoices, another biweekly — so the window is picked fresh for
 * every invoice, never configured per contract.
 *
 * Presentation only: the caller owns the selection Set and the confirm
 * button. Used by both billing engines (time log and days-and-call), so
 * the interaction stays identical everywhere.
 *
 *   days     [{ key: "YYYY-MM-DD", amount: number, note: string }]
 *   selected Set of selected day keys
 *   onChange (nextSet) => void
 *   T        theme object
 */

const money = (n) =>
  "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const localKey = (d) => {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 10);
};

const sundayOf = (key) => {
  const d = new Date(key + "T12:00");
  d.setDate(d.getDate() - d.getDay());
  return localKey(d);
};

const weekLabel = (wk) => {
  const start = new Date(wk + "T12:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const f = (dt) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Sun ${f(start)} – Sat ${f(end)}`;
};

const dayLabel = (k) =>
  new Date(k + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export default function InvoiceDayPicker({ days, selected, onChange, T }) {
  const weeks = new Map();
  for (const d of days) {
    const wk = sundayOf(d.key);
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push(d);
  }

  const toggleDay = (k) => {
    const s2 = new Set(selected);
    if (s2.has(k)) s2.delete(k); else s2.add(k);
    onChange(s2);
  };
  const toggleWeek = (wk) => {
    const dayKeys = weeks.get(wk).map(d => d.key);
    const s2 = new Set(selected);
    const allOn = dayKeys.every(k => s2.has(k));
    for (const k of dayKeys) { if (allOn) s2.delete(k); else s2.add(k); }
    onChange(s2);
  };

  const check = (on) => ({
    width: 22, height: 22, borderRadius: 6, flexShrink: 0,
    border: `2px solid ${on ? T.accent : T.border}`,
    backgroundColor: on ? T.accent : "transparent",
    color: "#fff", fontSize: 14, fontWeight: 800,
    display: "flex", alignItems: "center", justifyContent: "center",
  });

  return (
    <>
      <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginBottom: 10 }}>
        Pick the days this invoice covers — tap a week to take the whole Sun–Sat block,
        or tap single days. Anything unpicked stays for the next invoice.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button onClick={() => onChange(new Set(days.map(d => d.key)))} style={{
          padding: "7px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>All days</button>
        <button onClick={() => onChange(new Set())} style={{
          padding: "7px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>None</button>
      </div>
      {[...weeks.entries()].map(([wk, dayList]) => {
        const allOn = dayList.every(d => selected.has(d.key));
        const someOn = dayList.some(d => selected.has(d.key));
        return (
          <div key={wk} style={{ marginBottom: 10, borderRadius: 12, border: `1px solid ${someOn ? T.accent : T.border}`, overflow: "hidden" }}>
            <div role="button" tabIndex={0} onClick={() => toggleWeek(wk)}
              onKeyDown={(ev) => { if (ev.key === "Enter") toggleWeek(wk); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                backgroundColor: T.input, cursor: "pointer",
              }}>
              <div style={check(allOn)}>{allOn ? "✓" : someOn ? "–" : ""}</div>
              <div style={{ flex: 1, fontSize: 13.5, fontWeight: 800, color: T.text }}>{weekLabel(wk)}</div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
                {money(dayList.reduce((s2, d) => s2 + d.amount, 0))}
              </div>
            </div>
            {dayList.map(d => {
              const on = selected.has(d.key);
              return (
                <div key={d.key} role="button" tabIndex={0} onClick={() => toggleDay(d.key)}
                  onKeyDown={(ev) => { if (ev.key === "Enter") toggleDay(d.key); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px 9px 22px",
                    borderTop: `1px solid ${T.border}`, cursor: "pointer",
                    opacity: on ? 1 : 0.55,
                  }}>
                  <div style={check(on)}>{on ? "✓" : ""}</div>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>
                    {dayLabel(d.key)}
                    <span style={{ color: T.textDim, fontWeight: 500 }}>{" · "}{d.note}</span>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums" }}>
                    {money(d.amount)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
