import { useState, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import { Modal, Field } from "../../shared";
import SmartTimeField from "../../shared/SmartTimeField";
import { generateId } from "../../../utils/helpers";
import { selectableContracts } from "../../../utils/contractsForDate";

/**
 * The interrupted-work list. A call comes in mid-case: capture it in one
 * line and move on. When he comes back and finishes it, THAT is when the
 * entry gets made — he types the begin and end times himself, adjusts the
 * note, and it becomes a work entry. The capture time is only a reminder
 * of when it came in; it never decides what gets billed.
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
  const [finishing, setFinishing] = useState(null); // the task being completed
  const [form, setForm] = useState({});
  const [editTask, setEditTask] = useState(null); // open item being reworded
  const [editText, setEditText] = useState("");

  const tasks = data.taskNotes || [];
  const { open, done } = useMemo(() => ({
    open: tasks.filter(t => !t.completedAt).sort((a, b) => String(b.capturedAt || "").localeCompare(String(a.capturedAt || ""))),
    done: tasks.filter(t => t.completedAt).sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || ""))),
  }), [tasks]);

  // A finished to-do bills TIME, so only time-priced contracts can take it —
  // the day-rate agreement logs days and call periods, not begin/end times.
  const contracts = (data.locumContracts || []).filter(c => c.payModel !== "daily");
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

  // Finishing is where the real entry happens: he opens it, types the
  // begin and end times, adjusts the note, and it becomes a work entry.
  // The capture time is only a reminder of when it came in.
  const openFinish = (task) => {
    const now = new Date();
    const dayKey = (d) => {
      const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      return p.toISOString().slice(0, 10);
    };
    setFinishing(task);
    setForm({
      date: dayKey(now),
      type: "Call",
      start: "",
      end: "",
      description: task.text || "",
      privateNote: "",
      // A stale task may point at a non-billable contract — drop to default
      contractId: contracts.some(c => c.id === task.contractId) ? task.contractId : defaultContract,
    });
  };

  const submitFinish = () => {
    if (!finishing) return;
    if (!form.start || !form.end) return; // the button is disabled until both exist
    editItem("taskNotes", { ...finishing, completedAt: new Date().toISOString() });
    onBill?.({
      date: form.date,
      type: form.type,
      start: form.start,
      end: form.end,
      description: form.description,
      privateNote: form.privateNote,
      contractId: form.contractId,
    });
    setFinishing(null);
    setForm({});
  };

  const dismiss = (task) => editItem("taskNotes", { ...task, completedAt: new Date().toISOString(), notes: "closed without billing" });

  const Row = ({ t, isDone }) => {
    const elapsed = t.startedAt ? minutesBetween(t.startedAt, new Date().toISOString()) : null;
    return (
      <div style={{ backgroundColor: T.card, border: `1px solid ${t.startedAt && !isDone ? T.accent : T.border}`, borderRadius: 12, padding: "11px 13px", boxShadow: T.shadow1 }}>
        {/* Tap the words to fix the words — every note stays editable */}
        <div
          role={isDone ? undefined : "button"}
          tabIndex={isDone ? undefined : 0}
          onClick={isDone ? undefined : () => { setEditTask(t); setEditText(t.text || ""); }}
          onKeyDown={isDone ? undefined : (e) => { if (e.key === "Enter") { setEditTask(t); setEditText(t.text || ""); } }}
          style={{ fontSize: 14.5, fontWeight: 600, color: T.text, lineHeight: 1.4, textDecoration: isDone ? "line-through" : "none", opacity: isDone ? 0.6 : 1, cursor: isDone ? "default" : "pointer" }}>
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
            {!t.startedAt && contracts.length > 0 && (
              <button onClick={() => startWork(t)} style={{
                padding: "8px 12px", borderRadius: 9, border: `1px solid ${T.accent}`,
                backgroundColor: "transparent", color: T.accent, fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              }}>Start timing</button>
            )}
            {/* Billing time needs a time-priced contract to land in — with
                none on file the only honest close is "done, no charge" */}
            {contracts.length > 0 && (
              <button onClick={() => openFinish(t)} style={{
                padding: "8px 12px", borderRadius: 9, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
              }}>Finish &amp; log time</button>
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
          Catch it now, finish it later — you enter the times when you close it out.
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

      <Modal open={!!editTask} onClose={() => setEditTask(null)} title="Edit note">
        {editTask && (
          <>
            <textarea value={editText} onChange={e => setEditText(e.target.value)} autoFocus
              style={{ ...iS, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                onClick={() => { const v = editText.trim(); if (v) editItem("taskNotes", { ...editTask, text: v }); setEditTask(null); }}
                disabled={!editText.trim()}
                style={{
                  flex: 1, padding: "13px", borderRadius: 12, border: "none",
                  background: editText.trim() ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
                  color: "#fff", fontSize: 15, fontWeight: 800, cursor: editText.trim() ? "pointer" : "default",
                }}>Save</button>
              <button onClick={() => { if (window.confirm("Delete this note?")) { deleteItem("taskNotes", editTask.id); setEditTask(null); } }} style={{
                padding: "13px 16px", borderRadius: 12, border: "none",
                backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Delete</button>
              <button onClick={() => setEditTask(null)} style={{
                padding: "13px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!finishing} onClose={() => { setFinishing(null); setForm({}); }} title="Finish and log the time">
        {finishing && (
          <>
            <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 10 }}>
              Noted {fmtDay(finishing.capturedAt)} at {fmtClock(finishing.capturedAt)}
              {finishing.startedAt && ` · timing started ${fmtClock(finishing.startedAt)}`}
            </div>

            <Field label="What you did"><input value={form.description || ""} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} style={iS} /></Field>

            <Field label="Type">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["Call", "Transfer call", "Consult", "Rounding", "Procedure", "Charting", "Family talk"].map(t2 => (
                  <button key={t2} onClick={() => setForm(f => ({ ...f, type: t2 }))} style={{
                    padding: "8px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                    border: `1px solid ${form.type === t2 ? T.accent : T.border}`,
                    backgroundColor: form.type === t2 ? T.accent : "transparent",
                    color: form.type === t2 ? "#fff" : T.textMuted,
                  }}>{t2}</button>
                ))}
              </div>
            </Field>

            <Field label="Date"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>

            <SmartTimeField label="Begin" value={form.start || ""} iS={iS} T={T}
              onCommit={(v) => setForm(f => ({ ...f, start: v || "" }))} />
            <SmartTimeField label="End" value={form.end || ""} iS={iS} T={T}
              onCommit={(v) => setForm(f => ({ ...f, end: v || "" }))} />

            {contracts.length > 1 && (
              <Field label="Contract">
                <select value={form.contractId || ""} onChange={e => setForm(f => ({ ...f, contractId: e.target.value || null }))} style={{ ...iS, appearance: "auto" }}>
                  <option value="">— none —</option>
                  {selectableContracts(contracts, form.contractId).map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
                </select>
              </Field>
            )}

            <Field label="Notes (for the invoice)"><textarea value={form.privateNote || ""} onChange={e => setForm(f => ({ ...f, privateNote: e.target.value }))} style={{ ...iS, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} placeholder="Anything worth recording about this one" /></Field>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={submitFinish} disabled={!form.start || !form.end} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                background: form.start && form.end ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
                color: "#fff", fontSize: 15, fontWeight: 800,
                cursor: form.start && form.end ? "pointer" : "default",
              }}>Log it to the Work tab</button>
              <button onClick={() => { setFinishing(null); setForm({}); }} style={{
                padding: "13px 18px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </>
        )}
      </Modal>

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
