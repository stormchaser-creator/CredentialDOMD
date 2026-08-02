import { useState, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import { generateId } from "../../../utils/helpers";

/**
 * The interrupted-work list. A call comes in mid-case: capture it in one
 * line and move on. The moment of capture is kept, because that is often
 * the billable clock start — the call at 6:47pm is the work, even if the
 * note gets finished at 9. Completing a task hands its text and its times
 * straight to the Work tab as a prefilled entry.
 */

const fmtClock = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
const fmtDay = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));

function TaskNotes({ onBill }) {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);

  const tasks = data.taskNotes || [];
  const { open, done } = useMemo(() => ({
    open: tasks.filter(t => !t.completedAt).sort((a, b) => String(b.capturedAt || "").localeCompare(String(a.capturedAt || ""))),
    done: tasks.filter(t => t.completedAt).sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || ""))),
  }), [tasks]);

  const contracts = data.locumContracts || [];
  const defaultContract = contracts.length === 1 ? contracts[0].id : null;

  const capture = () => {
    const t = text.trim();
    if (!t) return;
    addItem("taskNotes", {
      id: generateId(),
      text: t,
      contractId: defaultContract,
      capturedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    setText("");
  };

  const startWork = (task) => editItem("taskNotes", { ...task, startedAt: new Date().toISOString() });

  // Finish it and hand the Work tab a prefilled entry. Which clock is right
  // depends on the job: a phone call bills from when it came in, a task he
  // sat down to later bills from when he started it.
  const complete = (task, from) => {
    const end = new Date().toISOString();
    const start = from === "captured" ? task.capturedAt : (task.startedAt || task.capturedAt);
    editItem("taskNotes", { ...task, completedAt: end });
    onBill?.({
      description: task.text,
      contractId: task.contractId || defaultContract,
      startIso: start,
      endIso: end,
    });
  };

  const dismiss = (task) => editItem("taskNotes", { ...task, completedAt: new Date().toISOString(), notes: "closed without billing" });

  const Row = ({ t, isDone }) => {
    const elapsed = t.startedAt ? minutesBetween(t.startedAt, new Date().toISOString()) : null;
    return (
      <div style={{ backgroundColor: T.card, border: `1px solid ${t.startedAt && !isDone ? T.accent : T.border}`, borderRadius: 12, padding: "11px 13px", boxShadow: T.shadow1 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: T.text, lineHeight: 1.4, textDecoration: isDone ? "line-through" : "none", opacity: isDone ? 0.6 : 1 }}>
          {t.text}
        </div>
        <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 3 }}>
          Came in {fmtDay(t.capturedAt)} at {fmtClock(t.capturedAt)}
          {t.startedAt && !isDone && <span style={{ color: T.accent, fontWeight: 700 }}> · working {elapsed}m</span>}
          {isDone && t.notes === "closed without billing" && " · closed, not billed"}
          {isDone && t.notes !== "closed without billing" && " · billed"}
        </div>
        {!isDone && (
          <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
            {!t.startedAt && (
              <button onClick={() => startWork(t)} style={{
                padding: "8px 12px", borderRadius: 9, border: `1px solid ${T.accent}`,
                backgroundColor: "transparent", color: T.accent, fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              }}>Start now</button>
            )}
            <button onClick={() => complete(t, "captured")} style={{
              padding: "8px 12px", borderRadius: 9, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
            }}>Bill from {fmtClock(t.capturedAt)}</button>
            {t.startedAt && (
              <button onClick={() => complete(t, "started")} style={{
                padding: "8px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              }}>Bill from {fmtClock(t.startedAt)}</button>
            )}
            <button onClick={() => dismiss(t)} style={{
              padding: "8px 11px", borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            }}>Done, no charge</button>
          </div>
        )}
        {isDone && (
          <button onClick={() => { if (window.confirm("Delete this note?")) deleteItem("taskNotes", t.id); }} style={{
            marginTop: 6, padding: "5px 9px", borderRadius: 8, border: "none",
            backgroundColor: T.dangerDim, color: T.danger, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
          }}>Delete</button>
        )}
      </div>
    );
  };

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: "0 0 3px", fontSize: 17, fontWeight: 800, color: T.text }}>To do</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          Catch it now, finish it later. The time it came in is kept, so it can still be billed from then.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") capture(); }}
          placeholder="e.g. call back Dr. Nguyen about the ICU consult"
          style={{ ...iS, flex: 1 }} />
        <button onClick={capture} disabled={!text.trim()} style={{
          padding: "12px 18px", borderRadius: 12, border: "none",
          backgroundColor: text.trim() ? T.accent : T.border, color: "#fff",
          fontSize: 15, fontWeight: 800, cursor: text.trim() ? "pointer" : "default",
        }}>Add</button>
      </div>

      {open.length === 0 && done.length === 0 && (
        <div style={{ textAlign: "center", padding: "26px 18px", backgroundColor: T.card, borderRadius: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>{"✓"}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>Nothing waiting</div>
          <div style={{ fontSize: 13.5, color: T.textMuted }}>Add a note when a call comes in and you can&rsquo;t deal with it yet.</div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {open.map(t => <Row key={t.id} t={t} isDone={false} />)}
      </div>

      {done.length > 0 && (
        <>
          <button onClick={() => setShowDone(v => !v)} style={{
            marginTop: 14, padding: "8px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
          }}>{showDone ? "Hide" : "Show"} finished ({done.length})</button>
          {showDone && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {done.slice(0, 40).map(t => <Row key={t.id} t={t} isDone />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default memo(TaskNotes);
