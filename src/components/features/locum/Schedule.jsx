import { memo, useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import EmptyState from "../../shared/EmptyState";
import { formatDate } from "../../../utils/helpers";

const localDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/**
 * Schedule — every contracted coverage block across all agreements, in
 * date order: where you're going, when, and under which contract.
 */
function Schedule() {
  const { data, theme: T } = useApp();
  const contracts = data.locumContracts || [];
  const today = localDate(new Date());

  const blocks = useMemo(() => {
    const out = [];
    for (const c of contracts) {
      const periods = c.coveragePeriods?.length
        ? c.coveragePeriods
        : (c.startDate ? [{ start: c.startDate, end: c.endDate || c.startDate }] : []);
      for (const p of periods) {
        if (!p.start) continue;
        const end = p.end || p.start;
        const days = Math.round((new Date(end) - new Date(p.start)) / 86400000) + 1;
        const status = today > end ? "past" : today >= p.start ? "active" : "upcoming";
        const daysUntil = Math.ceil((new Date(p.start) - new Date(today)) / 86400000);
        out.push({ c, start: p.start, end, days, status, daysUntil });
      }
    }
    // Active first, then upcoming by soonest, past at the bottom (recent first)
    const rank = { active: 0, upcoming: 1, past: 2 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === "past" ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)));
  }, [contracts, today]);

  if (blocks.length === 0) {
    return (
      <EmptyState icon={"🗓️"} title="No scheduled coverage"
        subtitle="Add coverage dates to your agreements (Contracts tab) — every scheduled block shows up here." />
    );
  }

  const statusChip = (b) => {
    if (b.status === "active") return { label: "NOW", bg: T.success, fg: "#fff" };
    if (b.status === "upcoming") return { label: b.daysUntil <= 1 ? "tomorrow" : `in ${b.daysUntil}d`, bg: T.accentGlow || "rgba(16,185,129,0.15)", fg: T.accent };
    return { label: "done", bg: T.input, fg: T.textDim };
  };

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>Schedule</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>Every contracted coverage block, soonest first.</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((b, i) => {
          const chip = statusChip(b);
          return (
            <div key={i} style={{
              backgroundColor: T.card, borderRadius: 14, padding: "13px 15px", boxShadow: T.shadow1,
              border: `1px solid ${b.status === "active" ? T.success : T.border}`,
              opacity: b.status === "past" ? 0.55 : 1,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>
                    {b.c.facility || "Facility"}
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {[b.c.location, b.c.agency].filter(Boolean).join(" · ")}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginTop: 4 }}>
                    {formatDate(b.start)}{b.end !== b.start ? ` – ${formatDate(b.end)}` : ""}
                    <span style={{ color: T.textDim, fontWeight: 500 }}> · {b.days} day{b.days > 1 ? "s" : ""}</span>
                  </div>
                  {(b.c.callStipend || 0) > 0 && (
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                      ${b.c.callStipend}/call day (first {b.c.stipendHours || 0}h){b.c.overageHourlyRate ? ` · then $${b.c.overageHourlyRate}/hr` : ""}
                    </div>
                  )}
                </div>
                <span style={{
                  flexShrink: 0, padding: "4px 10px", borderRadius: 10, fontSize: 11, fontWeight: 800,
                  backgroundColor: chip.bg, color: chip.fg, textTransform: "uppercase", letterSpacing: 0.5,
                }}>{chip.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(Schedule);
