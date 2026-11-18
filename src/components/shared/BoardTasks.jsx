import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { boardTasksFor, applyBoardTaskMark } from "../../utils/boardTasks";
import { FIRST_CYCLE_FIELD } from "../../utils/boardCompliance";
import { localToday } from "../../utils/dateDays";
import { generateId } from "../../utils/helpers";
import { TAP_MIN } from "./actionButton";

const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** One plain line for where a task stands. */
function taskStatusText(t) {
  if (t.status === "done") return `Done ${dayLabel(t.doneOn)}`;
  if (t.status === "not-yet") return `Starts in ${t.startsYear}, the year your certificate expires`;
  if (t.status === "unconfirmed") return `Due ${dayLabel(t.due)}. Done it? Mark it done`;
  if (t.status === "upcoming") return `Opens ${dayLabel(t.opens)}, due ${dayLabel(t.due)}`;
  if (!t.due) return `Due in ${t.period}. The board has not posted the date yet`;
  return `Due ${dayLabel(t.due)}${t.daysLeft != null ? ` (${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"})` : ""}`;
}

/**
 * A board card's dated tasks (src/utils/boardTasks.js): each with its due
 * date, "Mark done" (date defaults to today and can be changed) and Undo. The
 * physician marks; nothing is marked for them. A first mark with no Board
 * Certification record on file creates that record and stores the mark on
 * it (settings.boardTaskMarks is not synced). Also the board's facts that
 * change how the card reads: a certificate with no expiration date, and a
 * first-cycle proration applied only once the physician says the issued
 * date is their first certification.
 */
export default function BoardTasks({ board }) {
  const { data, addItem, editItem, updateSettings, theme: T } = useApp();
  const [marking, setMarking] = useState(null);
  const [day, setDay] = useState("");
  const info = boardTasksFor(data, board);
  const fc = board.firstCycle;
  if (!info && !fc) return null;

  const save = (t, date) => {
    const out = applyBoardTaskMark(data, board.id, t.field, date, { alsoFields: t.alsoFields, makeId: generateId });
    if (out.create) addItem("licenses", out.create);
    for (const rec of out.records) editItem("licenses", rec);
    if (out.settings) updateSettings(out.settings);
    setMarking(null);
  };
  // "Yes": the issued date is the first certification, so the chart's share applies. "No": full hours.
  const setFirstCycle = (answer) => {
    const rec = (data.licenses || []).find(l => l.id === fc.recordId);
    if (!rec) return;
    editItem("licenses", { ...rec, customFields: { ...(rec.customFields || {}), [FIRST_CYCLE_FIELD]: answer } });
  };
  const owedText = (f) => f.hours === 0
    ? `no CME hours this cycle; the board's hours start with the ${f.nextCycle} cycle`
    : `${f.hours} of ${f.fullHours} hours this cycle${f.minShareUsed ? " (the smallest share the board's chart lists)" : ""}`;
  const stop = e => e.stopPropagation();
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginLeft: 4,
  });
  const small = { fontSize: 12, color: T.textMuted, lineHeight: 1.45 };
  const color = s => s === "done" ? T.success : s === "unconfirmed" ? T.warning : s === "not-yet" ? T.textDim : T.warning;

  return (
    <div onClick={stop} style={{ marginTop: 8 }}>
      {info?.noExpiration && (
        <div style={{ ...small, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>
          <span style={{ fontWeight: 700, color: T.accent }}>No expiration date:</span> stays active while you meet these yearly steps.
          {info.noExpiration.typedExpiration && ` The date on your record (${dayLabel(info.noExpiration.typedExpiration)}) is not when it ends.`}
        </div>
      )}
      {fc && (
        <div style={{ ...small, marginBottom: 8 }}>
          {fc.pending
            ? <>Is {dayLabel(fc.issued)} your first certification date?<button style={btn(false)} onClick={() => setFirstCycle("Yes")}>Yes</button><button style={btn(false)} onClick={() => setFirstCycle("No")}>No</button>
                <div>Counting the full {fc.fullHours} hours for now. If this is your first certificate, you may owe {fc.hours === 0 ? "no hours this cycle" : fc.hours}: confirm.</div></>
            : fc.off
              ? <>Using the full {fc.fullHours} hours this cycle.<button style={btn(false)} onClick={() => setFirstCycle("Yes")}>Use first-cycle hours</button></>
              : <>First cycle: certified {dayLabel(fc.issued)}, so you owe {owedText(fc)}.<button style={btn(false)} onClick={() => setFirstCycle("No")}>Not my first certificate</button></>}
        </div>
      )}
      {info?.tasks.map(t => (
        <div key={t.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>{t.label}{t.cost ? ` ($${t.cost})` : ""}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: color(t.status) }}>{taskStatusText(t)}</span>
          </div>
          {t.detail && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2, lineHeight: 1.4 }}>{t.detail}</div>}
          <div style={{ marginTop: 4 }}>
            {t.doneOn
              ? <button style={btn(false)} onClick={() => save(t, null)}>Undo</button>
              : marking === t.field
                ? <span style={small}>
                    Done on <input type="date" value={day} max={localToday()} onChange={e => setDay(e.target.value)} aria-label={`Date ${t.label} was done`} style={{ fontSize: 16, padding: "2px 6px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text }} />
                    <button style={btn(true)} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(day)} onClick={() => save(t, day)}>Save</button>
                    <button style={btn(false)} onClick={() => setMarking(null)}>Cancel</button>
                  </span>
                : <button style={btn(false)} onClick={() => { setDay(localToday()); setMarking(t.field); }}>Mark done</button>}
          </div>
        </div>
      ))}
      {info?.sourceUrl && (
        <a href={info.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: T.accent, padding: "9px 0", minHeight: TAP_MIN, boxSizing: "border-box" }}>Board rules &rarr;</a>
      )}
    </div>
  );
}
