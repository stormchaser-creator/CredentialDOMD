import { useState, useMemo, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import ComplianceBar from "../shared/ComplianceBar";
import { PlusIcon, SendIcon, EditIcon, TrashIcon } from "../shared/Icons";
import { CME_TOPICS } from "../../constants/cmeTopics";
import { getCMECategories } from "../../constants/credentialTypes";
import { AOA_NATIONAL } from "../../constants/boardRequirements";
import { getStateEntry, hasSeparateBoards } from "../../constants/stateRequirements";
import { generateId, formatDate } from "../../utils/helpers";
import { computeCompliance } from "../../utils/compliance";

function CMESection({ onShare }) {
  const { data, setData, theme: T, allTrackedStates, navigate } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [showCompliance, setShowCompliance] = useState(false);

  const deg = data.settings.degreeType;
  const categories = getCMECategories(deg);

  const requiredTopics = useMemo(() =>
    [...new Set(allTrackedStates.flatMap(st =>
      (getStateEntry(st, deg)?.topics || []).filter(t => t.hours > 0).map(t => t.topic)
    ))],
    [allTrackedStates, deg]
  );

  const openAdd = useCallback(() => { setForm({ topics: [] }); setEditItem(null); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item, topics: item.topics || [] }); setEditItem(item); setShowForm(true); }, []);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); }, []);

  const handleSave = useCallback(() => {
    const entry = { ...form, id: editItem ? editItem.id : generateId() };
    if (editItem) setData(d => ({ ...d, cme: d.cme.map(x => x.id === entry.id ? entry : x) }));
    else setData(d => ({ ...d, cme: [...d.cme, entry] }));
    closeForm();
  }, [form, editItem, setData, closeForm]);

  const handleDelete = useCallback((id) => setData(d => ({ ...d, cme: d.cme.filter(x => x.id !== id) })), [setData]);

  const toggleTopic = useCallback((topic) => {
    setForm(f => {
      const tags = f.topics || [];
      return { ...f, topics: tags.includes(topic) ? tags.filter(t => t !== topic) : [...tags, topic] };
    });
  }, []);

  const complianceData = useMemo(() => {
    if (!showCompliance) return [];
    return allTrackedStates.map(st => ({
      state: st,
      compliance: computeCompliance(data.cme, st, deg),
    }));
  }, [showCompliance, allTrackedStates, data.cme, deg]);

  const totalHours = useMemo(() => data.cme.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0), [data.cme]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>CME Credits</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowCompliance(!showCompliance)} style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: showCompliance ? T.accentGlow : "transparent",
            color: showCompliance ? T.accent : T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Compliance</button>
          <button onClick={openAdd} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
            borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
            cursor: "pointer", backgroundColor: T.accent, color: "#fff",
          }}><PlusIcon /> Add</button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: T.textDim, marginBottom: 16 }}>
        {data.cme.length} entries &middot; {totalHours} total hours
      </div>

      {showCompliance && (
        <div style={{ marginBottom: 16 }}>
          {complianceData.map(({ state: st, compliance: comp }) => (
            <div key={st} style={{
              backgroundColor: T.card, border: `1px solid ${comp.fullyCompliant ? T.success : T.border}`,
              borderRadius: 14, padding: "16px 18px", marginBottom: 10, boxShadow: T.shadow1,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{st}</span>
                    {st === data.settings.primaryState && <span style={{ fontSize: 11, color: T.accent }}>(PRIMARY)</span>}
                    {hasSeparateBoards(st) && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, backgroundColor: T.warningDim, color: T.warning, fontWeight: 600 }}>{deg} Board</span>}
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim }}>{comp.noGeneralReq ? "No general hour requirement" : `${comp.cycle}-year cycle`}</div>
                </div>
                <div style={{
                  width: 26, height: 26, borderRadius: 13,
                  backgroundColor: comp.fullyCompliant ? T.successDim : T.dangerDim,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: comp.fullyCompliant ? T.success : T.danger, fontSize: 15, fontWeight: 700,
                }}>{comp.fullyCompliant ? "\u2713" : "\u2717"}</div>
              </div>
              {!comp.noGeneralReq && (
                <>
                  <ComplianceBar label="Total Hours" earned={comp.totalEarned} required={comp.totalRequired} met={comp.totalMet} />
                  {!comp.totalMet && (
                    <button onClick={() => navigate("credentials", "findCme")} style={{
                      padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find CME Courses &rarr;</button>
                  )}
                </>
              )}
              {comp.cat1Required > 0 && (
                <>
                  <ComplianceBar label={deg === "DO" ? "Cat 1-A / AMA Cat 1" : "AMA PRA Cat 1"} earned={comp.cat1Earned} required={comp.cat1Required} met={comp.cat1Met} />
                  {!comp.cat1Met && (
                    <button onClick={() => navigate("credentials", "findCme")} style={{
                      padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find Cat 1 CME &rarr;</button>
                  )}
                </>
              )}
              {comp.topicResults.map(tr => (
                <div key={tr.topic}>
                  <ComplianceBar label={tr.topic} earned={tr.earned} required={tr.required} met={tr.met} note={tr.note} />
                  {!tr.met && (
                    <button onClick={() => navigate("credentials", `findCme:${tr.topic}`)} style={{
                      padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find CME for {tr.topic} &rarr;</button>
                  )}
                </div>
              ))}
            </div>
          ))}

          {deg === "DO" && (
            <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", marginBottom: 10, boxShadow: T.shadow1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>AOA National</div>
              <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>{AOA_NATIONAL.cycle}-year cycle</div>
              <ComplianceBar label="Total" earned={totalHours} required={AOA_NATIONAL.hours} met={totalHours >= AOA_NATIONAL.hours} />
              <ComplianceBar
                label="Cat 1-A minimum"
                earned={data.cme.filter(c => c.category === "AOA Category 1-A").reduce((s, c) => s + (parseFloat(c.hours) || 0), 0)}
                required={AOA_NATIONAL.cat1a}
                met={data.cme.filter(c => c.category === "AOA Category 1-A").reduce((s, c) => s + (parseFloat(c.hours) || 0), 0) >= AOA_NATIONAL.cat1a}
              />
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit CME" : "Add CME"}>
        <Field label="Activity / Title"><input value={form.title || ""} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={iS} placeholder="e.g. Annual Pain Management Conference" /></Field>
        <Field label="Credit Category">
          <select value={form.category || ""} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Select category...</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Hours"><input type="number" step="0.5" value={form.hours || ""} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} style={iS} placeholder="0" /></Field>
          <Field label="Date Completed"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>
        </div>
        <Field label="Provider / Institution"><input value={form.provider || ""} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} style={iS} placeholder="e.g. AMA, hospital name" /></Field>
        <Field label="Certificate #"><input value={form.certificateNumber || ""} onChange={e => setForm(f => ({ ...f, certificateNumber: e.target.value }))} style={iS} /></Field>

        <Field label="Topics Covered" hint="Tag the topics this CME covers. This determines state compliance.">
          {requiredTopics.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 4 }}>Required by your states</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {requiredTopics.map(topic => {
                  const sel = (form.topics || []).includes(topic);
                  return (
                    <button key={topic} type="button" onClick={() => toggleTopic(topic)} style={{
                      padding: "6px 12px", fontSize: 13, fontWeight: 600, borderRadius: 18,
                      border: sel ? "none" : `1px solid ${T.accent}`,
                      backgroundColor: sel ? T.accent : "transparent",
                      color: sel ? "#fff" : T.accent, cursor: "pointer",
                    }}>{sel ? "\u2713 " : ""}{topic}</button>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {CME_TOPICS.filter(t => !requiredTopics.includes(t)).map(topic => {
              const sel = (form.topics || []).includes(topic);
              return (
                <button key={topic} type="button" onClick={() => toggleTopic(topic)} style={{
                  padding: "6px 12px", fontSize: 13, fontWeight: 600, borderRadius: 18,
                  border: sel ? "none" : `1px solid ${T.border}`,
                  backgroundColor: sel ? T.accent : "transparent",
                  color: sel ? "#fff" : T.textMuted, cursor: "pointer",
                }}>{sel ? "\u2713 " : ""}{topic}</button>
              );
            })}
          </div>
        </Field>

        <Field label="Notes"><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 50, resize: "vertical" }} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {/* List */}
      {data.cme.length === 0 ? (
        <EmptyState icon={"\ud83c\udf93"} title="No CME logged" subtitle="Track your continuing education hours and topic compliance." onAction={openAdd} actionLabel="Add CME" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.cme.map(item => (
            <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{item.title || item.category || "CME Activity"}</div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                    {[item.category, item.hours && (item.hours + " hrs"), item.provider, item.date && formatDate(item.date)].filter(Boolean).join(" \u00b7 ")}
                  </div>
                  {item.topics?.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {item.topics.map(t => (
                        <span key={t} style={{
                          padding: "2px 8px", fontSize: 11, fontWeight: 600, borderRadius: 12,
                          backgroundColor: requiredTopics.includes(t) ? T.accentGlow : T.input,
                          color: requiredTopics.includes(t) ? T.accent : T.textDim,
                          border: `1px solid ${requiredTopics.includes(t) ? T.accent : T.inputBorder}`,
                        }}>{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 3, flexShrink: 0, paddingTop: 2 }}>
                  <button onClick={() => onShare(item, "cme")} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
                  <button onClick={() => openEdit(item)} style={{ padding: "5px 7px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                  <button onClick={() => { if (window.confirm("Delete this CME entry? This cannot be undone.")) handleDelete(item.id); }} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(CMESection);
