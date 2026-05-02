/**
 * HospitalRotations — Locum tier.
 *
 * Track which hospital you're working at on which dates. For locum physicians
 * who rotate across multiple facilities, knowing "I'm at St. Mary's this week,
 * General next week" matters for credential prep, mileage tracking, and tax purposes.
 *
 * Stored at data.rotations[]: { id, hospital, city, state, startDate, endDate, role, notes, agency }
 */

import { useState } from "react";
import { useApp } from "../../../context/AppContext";

function makeId() {
  return `rot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatRange(start, end) {
  if (!start) return "—";
  const s = new Date(start);
  const sStr = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (!end) return `${sStr} → ongoing`;
  const e = new Date(end);
  const eStr = e.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${sStr} → ${eStr}`;
}

function isCurrent(start, end) {
  const now = Date.now();
  const s = start ? new Date(start).getTime() : -Infinity;
  const e = end ? new Date(end).getTime() : Infinity;
  return s <= now && now <= e;
}

function isUpcoming(start) {
  if (!start) return false;
  return new Date(start).getTime() > Date.now();
}

const BLANK_FORM = {
  hospital: "",
  city: "",
  state: "",
  startDate: "",
  endDate: "",
  role: "",
  agency: "",
  notes: "",
};

export default function HospitalRotations() {
  const { data, setData, theme: T } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);

  const rotations = data.rotations || [];

  const sorted = [...rotations].sort((a, b) => {
    const aT = a.startDate ? new Date(a.startDate).getTime() : 0;
    const bT = b.startDate ? new Date(b.startDate).getTime() : 0;
    return bT - aT;
  });

  const current = sorted.filter((r) => isCurrent(r.startDate, r.endDate));
  const upcoming = sorted.filter((r) => isUpcoming(r.startDate));
  const past = sorted.filter((r) => !isCurrent(r.startDate, r.endDate) && !isUpcoming(r.startDate));

  const startEdit = (r) => {
    setEditId(r.id);
    setForm({
      hospital: r.hospital || "",
      city: r.city || "",
      state: r.state || "",
      startDate: r.startDate || "",
      endDate: r.endDate || "",
      role: r.role || "",
      agency: r.agency || "",
      notes: r.notes || "",
    });
    setShowForm(true);
  };

  const cancelEdit = () => {
    setEditId(null);
    setForm(BLANK_FORM);
    setShowForm(false);
  };

  const save = () => {
    if (!form.hospital.trim()) return;
    if (editId) {
      setData((d) => ({
        ...d,
        rotations: (d.rotations || []).map((r) =>
          r.id === editId ? { ...r, ...form } : r
        ),
      }));
    } else {
      setData((d) => ({
        ...d,
        rotations: [...(d.rotations || []), { id: makeId(), ...form }],
      }));
    }
    cancelEdit();
  };

  const remove = (id) => {
    if (!window.confirm("Remove this rotation?")) return;
    setData((d) => ({
      ...d,
      rotations: (d.rotations || []).filter((r) => r.id !== id),
    }));
  };

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 12,
      }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 2px" }}>
            Hospital Rotations
          </h3>
          <p style={{ fontSize: 12, color: T.textMuted, margin: 0 }}>
            Track where you are working, when, and for which agency.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          style={{
            padding: "8px 14px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}
        >
          + Add
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <RotationForm form={form} setForm={setForm} onSave={save} onCancel={cancelEdit} editId={editId} T={T} />
      )}

      {/* Sections */}
      {current.length > 0 && (
        <Section title="Current" rows={current} T={T} onEdit={startEdit} onRemove={remove} accent={T.success || "#10b981"} />
      )}
      {upcoming.length > 0 && (
        <Section title="Upcoming" rows={upcoming} T={T} onEdit={startEdit} onRemove={remove} accent="#0ea5e9" />
      )}
      {past.length > 0 && (
        <Section title="Past" rows={past} T={T} onEdit={startEdit} onRemove={remove} accent={T.textMuted} />
      )}

      {rotations.length === 0 && !showForm && (
        <div style={{
          textAlign: "center", padding: "40px 20px",
          color: T.textMuted, fontSize: 14,
          backgroundColor: T.card, borderRadius: 12, border: `1px dashed ${T.border}`,
        }}>
          No rotations yet. Add your current assignment to get started.
        </div>
      )}
    </div>
  );
}

function Section({ title, rows, T, onEdit, onRemove, accent }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: accent,
        textTransform: "uppercase", letterSpacing: 0.8,
        marginBottom: 6,
      }}>
        {title} ({rows.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => (
          <div
            key={r.id}
            style={{
              backgroundColor: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              padding: "10px 12px",
            }}
          >
            <div style={{
              display: "flex", justifyContent: "space-between",
              alignItems: "flex-start", gap: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                  {r.hospital}
                </div>
                {(r.city || r.state) && (
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>
                    {[r.city, r.state].filter(Boolean).join(", ")}
                    {r.role && ` · ${r.role}`}
                  </div>
                )}
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 3 }}>
                  {formatRange(r.startDate, r.endDate)}
                  {r.agency && ` · via ${r.agency}`}
                </div>
                {r.notes && (
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, fontStyle: "italic" }}>
                    {r.notes}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button
                  onClick={() => onEdit(r)}
                  style={{
                    padding: "4px 8px", borderRadius: 6, border: "none",
                    backgroundColor: T.input, color: T.text,
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => onRemove(r.id)}
                  style={{
                    padding: "4px 8px", borderRadius: 6, border: "none",
                    backgroundColor: T.input, color: "#ef4444",
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RotationForm({ form, setForm, onSave, onCancel, editId, T }) {
  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const inputStyle = {
    width: "100%", padding: "8px 10px",
    backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
    borderRadius: 8, color: T.text, fontSize: 13, outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{
      backgroundColor: T.card, border: `1px solid ${T.accent}`,
      borderRadius: 12, padding: 14, marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>
        {editId ? "Edit Rotation" : "New Rotation"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input style={inputStyle} placeholder="Hospital name *" value={form.hospital} onChange={update("hospital")} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
          <input style={inputStyle} placeholder="City" value={form.city} onChange={update("city")} />
          <input style={inputStyle} placeholder="State" maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input style={inputStyle} type="date" value={form.startDate} onChange={update("startDate")} />
          <input style={inputStyle} type="date" value={form.endDate} onChange={update("endDate")} placeholder="End (optional)" />
        </div>
        <input style={inputStyle} placeholder="Role / specialty (e.g. Hospitalist, GenSurg call)" value={form.role} onChange={update("role")} />
        <input style={inputStyle} placeholder="Agency (e.g. Weatherby, CompHealth)" value={form.agency} onChange={update("agency")} />
        <textarea
          style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical", minHeight: 50 }}
          placeholder="Notes (optional)"
          value={form.notes}
          onChange={update("notes")}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={onSave}
          disabled={!form.hospital.trim()}
          style={{
            flex: 1, padding: "10px", borderRadius: 8, border: "none",
            backgroundColor: form.hospital.trim() ? T.accent : T.textDim,
            color: "#fff", fontSize: 13, fontWeight: 700,
            cursor: form.hospital.trim() ? "pointer" : "not-allowed",
          }}
        >
          {editId ? "Save changes" : "Add rotation"}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: "10px 16px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text,
            fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
