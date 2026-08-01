import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { summarizeByYear, buildCaseLogCsv, buildCaseLogPdf, shareCaseLogFile, academicYearOf, pgyLabelOf } from "../../utils/caseLogReport";

/**
 * The career ledger above the case list. The medicine year runs
 * Jul 1 - Jun 30; each training year gets its PGY chip (PGY 1 began
 * Jul 2018). Selecting a chip puts that year's summary — cases and
 * wRVU — at the top, with the case list below and one-tap reports.
 */
function CaseLogSummary({ cases, year, onYear }) {
  const { data, theme: T } = useApp();
  const [note, setNote] = useState("");
  const years = summarizeByYear(cases);
  const grand = years.reduce((s, t) => ({ cases: s.cases + t.cases, wRVU: s.wRVU + t.wRVU }), { cases: 0, wRVU: 0 });
  const flash = (m) => { setNote(m); setTimeout(() => setNote(""), 2500); };

  const isAll = year === "all";
  const selected = isAll ? cases : cases.filter(c => academicYearOf(c.date) === year);
  const selSummary = isAll
    ? { label: "Career", detail: "Jul 2018 - present", ...grand }
    : { label: pgyLabelOf(year), detail: `Jul 1 ${String(year).slice(0, 4)} - Jun 30 ${parseInt(String(year).slice(0, 4), 10) + 1}`,
        ...(years.find(y => y.year === year) || { cases: 0, wRVU: 0 }) };
  const physician = data.settings.name ? `${data.settings.name}, ${data.settings.degreeType || "MD"}` : "Physician";

  const report = async (kind) => {
    if (selected.length === 0) { flash("No cases in that range."); return; }
    try {
      if (kind === "pdf") {
        const file = buildCaseLogPdf(selected, { physician, year: isAll ? null : `${pgyLabelOf(year)} (${year})` });
        const r = await shareCaseLogFile(file);
        if (r) flash(r === "download" ? "PDF downloaded." : "PDF in the share sheet.");
      } else {
        const csv = buildCaseLogCsv(selected);
        const file = new File([csv], `Case Log - ${physician}${isAll ? "" : " " + pgyLabelOf(year)}.csv`, { type: "text/csv" });
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
      {/* Selected-scope headline: the summary he reads first */}
      <div style={{ backgroundColor: T.card, border: `2px solid ${T.accent}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{selSummary.label}</div>
            <div style={{ fontSize: 11.5, color: T.textDim }}>{selSummary.detail}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>{selSummary.cases} cases</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>{selSummary.wRVU.toFixed(2)} wRVU</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={() => report("pdf")} style={{
            flex: 1, padding: "10px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
          }}>Report PDF</button>
          <button onClick={() => report("csv")} style={{
            padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>CSV</button>
        </div>
        {note && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{note}</div>}
      </div>

      {/* Year switcher: PGY chips, newest first, career last */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {years.map(y => (
          <button key={y.year} onClick={() => onYear(y.year)} style={{
            padding: "8px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            border: `1px solid ${year === y.year ? T.accent : T.border}`,
            backgroundColor: year === y.year ? T.accent : "transparent",
            color: year === y.year ? "#fff" : T.textMuted,
          }}>{pgyLabelOf(y.year)}</button>
        ))}
        <button onClick={() => onYear("all")} style={{
          padding: "8px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          border: `1px solid ${year === "all" ? T.accent : T.border}`,
          backgroundColor: year === "all" ? T.accent : "transparent",
          color: year === "all" ? "#fff" : T.textMuted,
        }}>Career</button>
      </div>
    </div>
  );
}

export default memo(CaseLogSummary);
