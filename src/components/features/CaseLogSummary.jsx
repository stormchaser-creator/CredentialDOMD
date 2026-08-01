import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { summarizeByYear, buildCaseLogCsv, buildCaseLogPdf, shareCaseLogFile, academicYearOf } from "../../utils/caseLogReport";

/**
 * The career ledger above the case list: one row per academic year
 * (Jul 1 – Jun 30) with case count and wRVU total, tap to filter the list
 * below, and one-tap reports (PDF or CSV) for the selected year or the
 * whole career.
 */
function CaseLogSummary({ cases, year, onYear }) {
  const { data, theme: T } = useApp();
  const [note, setNote] = useState("");
  const years = summarizeByYear(cases);
  const grand = years.reduce((s, t) => ({ cases: s.cases + t.cases, wRVU: s.wRVU + t.wRVU }), { cases: 0, wRVU: 0 });
  const flash = (m) => { setNote(m); setTimeout(() => setNote(""), 2500); };

  const selected = year === "all" ? cases : cases.filter(c => academicYearOf(c.date) === year);
  const physician = data.settings.name ? `${data.settings.name}, ${data.settings.degreeType || "MD"}` : "Physician";

  const report = async (kind) => {
    if (selected.length === 0) { flash("No cases in that range."); return; }
    try {
      if (kind === "pdf") {
        const file = buildCaseLogPdf(selected, { physician, year: year === "all" ? null : year });
        const r = await shareCaseLogFile(file);
        if (r) flash(r === "download" ? "PDF downloaded." : "PDF in the share sheet.");
      } else {
        const csv = buildCaseLogCsv(selected);
        const file = new File([csv], `Case Log — ${physician}${year === "all" ? "" : " " + year}.csv`, { type: "text/csv" });
        const r = await shareCaseLogFile(file);
        if (r) flash(r === "download" ? "CSV downloaded." : "CSV in the share sheet.");
      }
    } catch (err) {
      flash(`Report failed: ${err.message}`);
    }
  };

  if (cases.length === 0) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Career headline */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "12px 14px", boxShadow: T.shadow1, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>Career</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>
            {grand.cases} cases · {grand.wRVU.toFixed(2)} wRVU
          </div>
        </div>
        {/* Year rows */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          <button onClick={() => onYear("all")} style={{
            padding: "8px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            border: `1px solid ${year === "all" ? T.accent : T.border}`,
            backgroundColor: year === "all" ? T.accent : "transparent",
            color: year === "all" ? "#fff" : T.textMuted,
          }}>All</button>
          {years.map(y => (
            <button key={y.year} onClick={() => onYear(y.year)} style={{
              padding: "8px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              fontVariantNumeric: "tabular-nums",
              border: `1px solid ${year === y.year ? T.accent : T.border}`,
              backgroundColor: year === y.year ? T.accent : "transparent",
              color: year === y.year ? "#fff" : T.textMuted,
            }}>{y.year} · {y.cases} · {y.wRVU.toFixed(0)}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={() => report("pdf")} style={{
            flex: 1, padding: "10px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
          }}>Report PDF{year === "all" ? " — career" : ` — ${year}`}</button>
          <button onClick={() => report("csv")} style={{
            padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>CSV</button>
        </div>
        {note && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{note}</div>}
      </div>
    </div>
  );
}

export default memo(CaseLogSummary);
