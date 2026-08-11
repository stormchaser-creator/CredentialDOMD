import { memo, useMemo } from "react";
import { useApp } from "../../../context/AppContext";
import Modal from "../../shared/Modal";
import { formatDate } from "../../../utils/helpers";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Case logs don't carry a contractId — they link back through the RVU entry
// that created them, or by facility name. Facility strings drift between
// sources ("Intermountain Good Samaritan Hospital" vs "… (Rightsourcing)"),
// so match on the normalized core name.
const normFacility = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
const facilityMatches = (a, b) => {
  const x = normFacility(a), y = normFacility(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/**
 * ContractSummary — everything one agreement produced, in one place:
 * what was billed and collected, the days and hours on the ground, the
 * RVUs logged, and the cases done while there.
 */
function ContractSummary({ contract, onClose, docs = [], onOpenDoc }) {
  const { data, theme: T } = useApp();

  const s = useMemo(() => {
    if (!contract) return null;
    const cid = contract.id;

    const invoices = (data.invoices || [])
      .filter(i => i.contractId === cid)
      .sort((a, b) => String(b.periodStart || "").localeCompare(String(a.periodStart || "")));
    const paidOf = (inv) => {
      const led = (inv.payments || []).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
      return led > 0 ? led : (inv.paidAt ? (parseFloat(inv.totalAmount) || 0) : 0);
    };
    const billed = invoices.reduce((t, i) => t + (parseFloat(i.totalAmount) || 0), 0);
    const collected = invoices.reduce((t, i) => t + paidOf(i), 0);

    const work = (data.workLog || []).filter(w => w.contractId === cid);
    const workDays = new Set(work.map(w => w.callDay || w.date).filter(Boolean));
    const minutes = work.reduce((t, w) => t + (parseFloat(w.billedMin ?? w.durationMin) || 0), 0);

    const duty = (data.dutyDays || []).filter(d => d.contractId === cid);
    const dutyEarned = duty.reduce((t, d) => t + (parseFloat(d.amount) || 0), 0);
    for (const d of duty) if (d.date) workDays.add(d.date);

    const encounters = (data.encounters || [])
      .filter(e => e.contractId === cid)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const encRvu = (e) => (e.codes || []).reduce((t, c) => t + (c.wRVU || 0) * (c.units || 1), 0);
    const totalRvu = encounters.reduce((t, e) => t + encRvu(e), 0);
    const encIds = new Set(encounters.map(e => e.id));

    const cases = (data.caseLogs || [])
      .filter(c => encIds.has(c.customFields?.["From RVU entry"]) || facilityMatches(c.facility, contract.facility))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

    return { invoices, paidOf, billed, collected, workDays, minutes, duty, dutyEarned, encounters, encRvu, totalRvu, cases };
  }, [contract, data.invoices, data.workLog, data.dutyDays, data.encounters, data.caseLogs]);

  if (!contract || !s) return null;

  const stat = (label, value, accent) => (
    <div style={{ backgroundColor: T.input, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: accent || T.text, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
  const heading = (text) => (
    <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, margin: "16px 0 6px" }}>{text}</div>
  );
  const hrs = s.minutes / 60;
  const outstanding = s.billed - s.collected;
  const periods = contract.coveragePeriods?.length
    ? contract.coveragePeriods.map(p => `${formatDate(p.start)}${p.end && p.end !== p.start ? " – " + formatDate(p.end) : ""}`).join(", ")
    : (contract.startDate ? `${formatDate(contract.startDate)}${contract.endDate ? " – " + formatDate(contract.endDate) : ""}` : "");

  return (
    <Modal open={!!contract} onClose={onClose} title={contract.facility || "Contract"}>
      <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>
        {[contract.agency, contract.location, periods].filter(Boolean).join(" · ")}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {stat("Billed", money(s.billed))}
        {stat("Collected", money(s.collected), "#22c55e")}
        {outstanding > 0.005 ? stat("Outstanding", money(outstanding), "#f97316") : stat("Outstanding", "$0.00")}
        {stat("Days worked", s.workDays.size)}
        {stat("Hours logged", hrs > 0 ? hrs.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "0")}
        {stat("Total wRVU", s.totalRvu.toLocaleString(undefined, { maximumFractionDigits: 2 }))}
      </div>

      {s.duty.length > 0 && (
        <div style={{ fontSize: 13, color: T.textDim, marginTop: 8 }}>
          {s.duty.length} duty day{s.duty.length === 1 ? "" : "s"} logged · {money(s.dutyEarned)} earned
        </div>
      )}

      {heading("Terms")}
      <div style={{ fontSize: 13, color: T.text, lineHeight: 1.7 }}>
        {[
          contract.dayRate ? `$${contract.dayRate}/day worked` : null,
          contract.callStipend ? (contract.stipendHours ? `$${contract.callStipend}/call day (first ${contract.stipendHours}h)` : `$${contract.callStipend}/call period`) : null,
          contract.overageHourlyRate ? `then $${contract.overageHourlyRate}/hr` : null,
          contract.hourlyRate ? `$${contract.hourlyRate}/hr` : null,
          !contract.callStipend && contract.callHourlyRate ? `call $${contract.callHourlyRate}/hr` : null,
          contract.orientationHourlyRate ? `orientation $${contract.orientationHourlyRate}/hr` : null,
          contract.orientationFee ? `orientation $${contract.orientationFee}` : null,
          `${contract.incrementMinutes || 15}-min increments`,
        ].filter(Boolean).join(" · ")}
      </div>
      {contract.notes && (
        <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 6, whiteSpace: "pre-wrap" }}>{contract.notes}</div>
      )}

      {docs.length > 0 && (
        <>
          {heading(`Agreement documents (${docs.length})`)}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {docs.map(doc => (
              <button key={doc.id} onClick={() => onOpenDoc && onOpenDoc(doc)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                  borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input,
                  color: T.text, fontSize: 12, fontWeight: 600, cursor: doc.data ? "pointer" : "default", textAlign: "left",
                }}>
                {doc.type?.startsWith("image/") && doc.data
                  ? <img src={doc.data} alt={doc.name} style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 5, flexShrink: 0 }} />
                  : <span style={{ fontSize: 16 }}>{doc.data ? "📕" : "⏳"}</span>}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{doc.name}</span>
                <span style={{ fontSize: 11, color: T.accent, flexShrink: 0 }}>{doc.data ? "view" : "syncing…"}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {s.invoices.length > 0 && (
        <>
          {heading(`Invoices (${s.invoices.length})`)}
          {s.invoices.map(inv => {
            const paid = s.paidOf(inv);
            const total = parseFloat(inv.totalAmount) || 0;
            const status = paid >= total - 0.005 ? { t: "PAID", c: "#22c55e" }
              : paid > 0.005 ? { t: `PARTIAL — ${money(total - paid)} due`, c: "#f97316" }
              : { t: "UNPAID", c: "#ef4444" };
            return (
              <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{inv.number}</div>
                  <div style={{ fontSize: 12, color: T.textDim }}>
                    {inv.periodStart ? `${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? " – " + formatDate(inv.periodEnd) : ""}` : ""}
                    <span style={{ color: status.c, fontWeight: 700 }}> · {status.t}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{money(inv.totalAmount)}</div>
              </div>
            );
          })}
        </>
      )}

      {s.cases.length > 0 && (
        <>
          {heading(`Cases (${s.cases.length})`)}
          {s.cases.map(c => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>{c.title || c.category || "Case"}</div>
                <div style={{ fontSize: 12, color: T.textDim }}>
                  {[c.date && formatDate(c.date), c.role, c.cptCodes].filter(Boolean).join(" · ")}
                </div>
              </div>
              {parseFloat(c.wRvu) > 0 && (
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#22c55e", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {parseFloat(c.wRvu).toFixed(2)} wRVU
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {s.encounters.length > 0 && (
        <>
          {heading(`RVU entries (${s.encounters.length})`)}
          {s.encounters.map(e => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: T.textDim }}>{e.date ? formatDate(e.date) : ""}</div>
                <div style={{ fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {(e.codes || []).map(c => `${c.code}${(c.units || 1) > 1 ? ` ×${c.units}` : ""}`).join(", ") || "No codes"}
                </div>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#22c55e", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                {s.encRvu(e).toFixed(2)} wRVU
              </div>
            </div>
          ))}
        </>
      )}

      {s.invoices.length === 0 && s.cases.length === 0 && s.encounters.length === 0 && s.workDays.size === 0 && (
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 12 }}>
          Nothing logged against this agreement yet — work log entries, RVU entries, and invoices will all roll up here.
        </div>
      )}
    </Modal>
  );
}

export default memo(ContractSummary);
