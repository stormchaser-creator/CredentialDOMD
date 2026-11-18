import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { boardTasksFor, applyBoardTaskMark, notRequiredMark, newBoardRecord } from "../../utils/boardTasks";
import { FIRST_CYCLE_FIELD } from "../../utils/boardCompliance";
import { localToday } from "../../utils/dateDays";
import { generateId } from "../../utils/helpers";
import { TAP_MIN, inlineLinkTap } from "./actionButton";

const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** One plain line for where a task stands. */
function taskStatusText(t) {
  if (t.status === "done") return `Done ${dayLabel(t.doneOn)}`;
  if (t.status === "not-required") return `Not required for me this ${t.periodWord}`;
  if (t.status === "not-yet") return t.startsWhy === "newIssue"
    ? `Starts in ${t.startsYear}, after your first full year certified`
    : `Starts in ${t.startsYear}, the year your certificate expires`;
  if (t.status === "unconfirmed") return `Due ${dayLabel(t.due)}. Done it? Mark it done`;
  if (t.status === "upcoming") return `Opens ${dayLabel(t.opens)}, due ${dayLabel(t.due)}`;
  if (!t.due && t.dueRule) return t.dueRule;
  if (!t.due) return `Due in ${t.period}. The board has not posted the date yet`;
  if (t.askFirst) return `Due ${dayLabel(t.due)}. Already done? Mark it done`;
  return `Due ${dayLabel(t.due)}${t.daysLeft != null ? ` (${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"})` : ""}`;
}

/**
 * A board card's dated tasks (src/utils/boardTasks.js): each with its due
 * date, "Mark done" (date defaults to today and can be changed), "Not
 * required for me this year" (or "this cycle") and Undo. The physician
 * chooses; nothing is marked for them. A first mark with no Board
 * Certification record on file creates that record and stores the mark on
 * it (settings.boardTaskMarks is not synced). A step whose date passed with
 * no mark, or one in the first period the app tracks it (askFirst: asked,
 * never alerted), says where to check and who to ask. A step with no period
 * the app can place offers no mark: it would never reset. Also the board's facts that
 * change how the card reads: the AOA "valid thru" date (explained, and asked
 * for calmly when none is on file), and a first-cycle proration applied only
 * once the physician says the issued date is their first certification.
 */
export default function BoardTasks({ board }) {
  const { data, addItem, editItem, updateSettings, theme: T } = useApp();
  const [marking, setMarking] = useState(null);
  const [day, setDay] = useState("");
  const [validDay, setValidDay] = useState("");
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
  // The valid-thru date the physician typed becomes the certificate's date,
  // on its record (made now when none is on file).
  const saveValidThru = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validDay)) return;
    const rec = info?.recordId && (data.licenses || []).find(l => l.id === info.recordId);
    if (rec) editItem("licenses", { ...rec, expirationDate: validDay, ...(rec.noExpiration === true ? { noExpiration: false } : {}) });
    else addItem("licenses", { ...newBoardRecord(board.id, generateId), expirationDate: validDay, notes: "", customFields: {} });
    setValidDay("");
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
  const color = s => s === "done" ? T.success : s === "not-required" ? T.textMuted : s === "unconfirmed" ? T.warning : s === "not-yet" ? T.textDim : T.warning;
  const link = { fontWeight: 700, color: T.accent, ...inlineLinkTap };
  const vt = info?.validThru;

  return (
    <div onClick={stop} style={{ marginTop: 8 }}>
      {vt && (
        <div style={{ ...small, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>
          {vt.date
            ? <>Valid thru {dayLabel(vt.date)}: the end of your current OCC cycle. The AOA moves it forward as you meet these steps; update it here when your portal shows a new one.</>
            : <>Your AOA certificate shows a valid thru date, the end of your current OCC cycle, which moves forward as you meet these steps. Add the date your AOA Physician Portal shows.
                <div style={{ marginTop: 4 }}>
                  Valid thru <input type="date" value={validDay} onChange={e => setValidDay(e.target.value)} aria-label="Valid thru date from the AOA Physician Portal" style={{ fontSize: 16, padding: "2px 6px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text }} />
                  <button style={btn(true)} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(validDay)} onClick={saveValidThru}>Save</button>
                </div></>}
          {" "}<a href={vt.url} target="_blank" rel="noopener noreferrer" style={link}>AOA Physician Portal &rarr;</a>
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
          {(t.status === "unconfirmed" || t.askFirst) && (
            <div style={{ ...small, marginTop: 4 }}>
              {info.whereToCheck
                ? <>Check in the <a href={info.whereToCheck.url} target="_blank" rel="noopener noreferrer" style={link}>{info.whereToCheck.label}</a>.</>
                : <>Check on the <a href={info.sourceUrl} target="_blank" rel="noopener noreferrer" style={link}>board&rsquo;s page</a>.</>}
              {info.contact && <> Or ask {info.contact.name}: <a href={`tel:${info.contact.phone.replace(/[^\d+]/g, "")}`} style={link}>{info.contact.phone}</a>, <a href={`mailto:${info.contact.email}`} style={link}>{info.contact.email}</a>.</>}
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            {t.doneOn || t.notRequiredOn
              ? <button style={btn(false)} onClick={() => save(t, null)}>Undo</button>
              : !t.markable
                ? null
                : marking === t.field
                ? <span style={small}>
                    Done on <input type="date" value={day} max={localToday()} onChange={e => setDay(e.target.value)} aria-label={`Date ${t.label} was done`} style={{ fontSize: 16, padding: "2px 6px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text }} />
                    <button style={btn(true)} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(day)} onClick={() => save(t, day)}>Save</button>
                    <button style={btn(false)} onClick={() => setMarking(null)}>Cancel</button>
                  </span>
                : <>
                    <button style={btn(false)} onClick={() => { setDay(localToday()); setMarking(t.field); }}>Mark done</button>
                    <button style={btn(false)} onClick={() => save(t, notRequiredMark(localToday()))}>Not required for me this {t.periodWord}</button>
                  </>}
          </div>
        </div>
      ))}
      {info?.whereToCheck && (
        <a href={info.whereToCheck.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: T.accent, padding: "9px 0", minHeight: TAP_MIN, boxSizing: "border-box", marginRight: 16 }}>Where to check: {info.whereToCheck.label} &rarr;</a>
      )}
      {info?.sourceUrl && (
        <a href={info.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: T.accent, padding: "9px 0", minHeight: TAP_MIN, boxSizing: "border-box" }}>Board rules &rarr;</a>
      )}
    </div>
  );
}
