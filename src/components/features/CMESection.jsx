import { useState, useMemo, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import ComplianceBar from "../shared/ComplianceBar";
import RuleProvenance from "../shared/RuleProvenance";
import { PlusIcon, SendIcon, EditIcon, TrashIcon } from "../shared/Icons";
import { CME_TOPICS } from "../../constants/cmeTopics";
import { getCMECategories } from "../../constants/credentialTypes";
import { AOA_NATIONAL, BOARD_REQS_META } from "../../constants/boardRequirements";
import { getStateEntry, hasSeparateBoards, STATE_REQS_META } from "../../constants/stateRequirements";
import { STATE_NAMES } from "../../constants/states";
import { generateId, formatDate } from "../../utils/helpers";
import { complianceFor } from "../../utils/compliance";
import { computeBoardCompliance, boardIdsFromLicenses } from "../../utils/boardCompliance";
import { stateTranscriptModel, boardTranscriptOptions, boardTranscriptModel, shareTranscriptPdf } from "../../utils/cmeTranscriptPdf";

function CMESection({ onShare }) {
  const { data, addItem, editItem: editItemCtx, deleteItem, theme: T, allTrackedStates, navigate } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [showCompliance, setShowCompliance] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [note, setNote] = useState("");

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
    if (editItem) editItemCtx("cme", entry);
    else addItem("cme", entry);
    closeForm();
  }, [form, editItem, editItemCtx, addItem, closeForm]);

  const handleDelete = useCallback((id) => deleteItem("cme", id), [deleteItem]);

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
      compliance: complianceFor(data, st),
    }));
  }, [showCompliance, allTrackedStates, data.cme, deg]);

  const totalHours = useMemo(() => data.cme.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0), [data.cme]);

  // ── Transcript PDF: one per state (or board), built from the same
  //    compliance engine the cards use, with linked certificates embedded.
  const flash = useCallback((msg) => { setNote(msg); setTimeout(() => setNote(""), 6000); }, []);

  const transcriptOptions = useMemo(() => {
    if (!showTranscript) return { states: [], boards: [] };
    return {
      states: allTrackedStates.map(st => ({ st, model: stateTranscriptModel(data, st) })),
      boards: boardTranscriptOptions(data).map(b => ({ board: b, model: boardTranscriptModel(data, b) })),
    };
  }, [showTranscript, allTrackedStates, data]);

  const runTranscript = useCallback(async (model) => {
    if (!model || model.error) { flash(model?.error || "Nothing to put in a transcript yet."); return; }
    setTranscriptBusy(true);
    try {
      const result = await shareTranscriptPdf(model);
      if (result === "download") flash(`${model.fileName} downloaded.`);
      else if (result === "share") flash("Transcript PDF is in the share sheet.");
      if (result) setShowTranscript(false);
    } catch (err) {
      flash(`Couldn't build the transcript: ${err.message}`);
    } finally {
      setTranscriptBusy(false);
    }
  }, [flash]);

  const openTranscript = useCallback(() => {
    const boards = boardTranscriptOptions(data);
    if (allTrackedStates.length === 0 && boards.length === 0) {
      flash("Add a state medical license or set your primary state in Settings, then come back for a transcript.");
      return;
    }
    // One state, no boards: no picker needed, go straight to the PDF.
    if (allTrackedStates.length === 1 && boards.length === 0) {
      runTranscript(stateTranscriptModel(data, allTrackedStates[0]));
      return;
    }
    setShowTranscript(true);
  }, [data, allTrackedStates, flash, runTranscript]);

  const optionSummary = (model) => {
    if (model.error) return model.error;
    const certs = model.certs.length;
    const embeddable = model.certs.filter(c => c.mode === "image" || c.mode === "convert").length;
    return `${model.rows.length} entr${model.rows.length === 1 ? "y" : "ies"} in window, ${certs} certificate${certs === 1 ? "" : "s"}${certs && embeddable < certs ? ` (${certs - embeddable} listed, not embedded)` : ""}`;
  };

  const optionButton = (key, title, model, meta) => (
    <button key={key} onClick={() => runTranscript(model)} disabled={transcriptBusy} style={{
      display: "block", width: "100%", textAlign: "left", padding: "10px 12px", marginBottom: 6,
      borderRadius: 10, border: `1px solid ${model.error ? T.border : T.accent}`,
      backgroundColor: model.error ? "transparent" : T.accentGlow, cursor: transcriptBusy ? "wait" : "pointer",
      opacity: transcriptBusy ? 0.6 : 1,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: model.error ? T.textMuted : T.text }}>{title}</div>
      {meta && <div style={{ fontSize: 12, color: T.textDim, marginTop: 1 }}>{meta}</div>}
      <div style={{ fontSize: 12, color: model.error ? T.warning : T.textDim, marginTop: 2 }}>{optionSummary(model)}</div>
    </button>
  );
  // Board MOC standing: boards picked in Settings plus any board implied by
  // a "Board Certification" license record (matched by code or name), run
  // through the same cycle-windowed engine Home uses.
  const boardComps = useMemo(() => {
    if (!showCompliance) return [];
    const fromLicenses = boardIdsFromLicenses(data.licenses);
    const specialties = [...new Set([...(data.settings.specialties || []), ...fromLicenses])];
    if (specialties.length === 0) return [];
    return computeBoardCompliance({ ...data, settings: { ...data.settings, specialties } });
  }, [showCompliance, data]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>CME Credits</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={openTranscript} disabled={transcriptBusy} title="Board-ready CME transcript PDF for a state renewal or board" style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600,
            cursor: transcriptBusy ? "wait" : "pointer", opacity: transcriptBusy ? 0.6 : 1,
          }}>{transcriptBusy ? "Building PDF" : "Transcript PDF"}</button>
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

      <div style={{ fontSize: 13, color: T.textDim, marginBottom: note ? 6 : 16 }}>
        {data.cme.length} entries &middot; {totalHours} total hours
      </div>
      {note && (
        <div style={{ fontSize: 13, color: T.accent, marginBottom: 12, padding: "8px 12px", borderRadius: 10, backgroundColor: T.accentGlow }}>{note}</div>
      )}

      {/* Transcript picker: which state renewal or board the PDF is for */}
      <Modal open={showTranscript} onClose={() => setShowTranscript(false)} title="Transcript PDF" width={460}>
        <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
          One PDF per renewal: physician and license details, the cycle window, each requirement with hours earned, every CME entry in the window, and the linked certificates as pages. Boards audit renewals; hospital reappointment asks for the same summary.
        </div>
        {transcriptOptions.states.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 6 }}>State renewal</div>
            {transcriptOptions.states.map(({ st, model }) => optionButton(
              `state:${st}`,
              `${STATE_NAMES[st] || st} (${st})${st === data.settings.primaryState ? ", primary" : ""}`,
              model,
              model.error ? null : `${formatDate(model.window.start)} to ${formatDate(model.window.end)}`,
            ))}
          </div>
        )}
        {transcriptOptions.boards.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 6 }}>Board continuing certification</div>
            {transcriptOptions.boards.map(({ board, model }) => optionButton(
              `board:${board.id}`,
              String(board.label || board.name).replace(/\s*—\s*/g, ", "),
              model,
              model.error ? null : `${formatDate(board.from)} to ${formatDate(board.to)}`,
            ))}
          </div>
        )}
      </Modal>

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
                    {hasSeparateBoards(st) && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, backgroundColor: T.warningDim, color: T.warning, fontWeight: 600 }}>{deg ? `${deg} Board` : "MD or DO board? Set your degree in Settings"}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim }}>{comp.noGeneralReq ? "No general hour requirement" : `${comp.cycle}-year cycle`}</div>
                  {comp.degreeUnknown && (
                    <div style={{ fontSize: 12, color: T.warning, marginTop: 2 }}>
                      Shown with MD rules until you set your degree in Settings.
                    </div>
                  )}
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
              <RuleProvenance
                reportKey={st}
                subject={`${st}${hasSeparateBoards(st) ? ` (${deg || "MD"})` : ""}`}
                citation={comp.source}
                meta={STATE_REQS_META}
                verified={comp.verified}
              />
            </div>
          ))}

          {/* Board MOC: the matched board's continuing-certification CME,
              from Settings → Board Specialties or a Board Certification
              license record. Same window logic as the Home card. */}
          {boardComps.length > 0 && (
            <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", marginBottom: 10, boxShadow: T.shadow1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>Board MOC</div>
              <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>Continuing certification CME for your board{boardComps.filter(b => !b.followsParent).length > 1 ? "s" : ""}</div>
              {boardComps.filter(b => !b.followsParent).map(b => (
                <div key={b.id} style={{ marginBottom: 12 }}>
                  <ComplianceBar label={b.label} earned={b.earned} required={b.required} met={b.met}
                    note={`${b.unit} \u00b7 ${b.windowLabel}${b.daysLeft != null ? ` \u00b7 ${b.daysLeft} days left` : ""}`} />
                  {b.cat1aRequired > 0 && (
                    <ComplianceBar label="AOA Cat 1-A minimum" earned={b.cat1aEarned} required={b.cat1aRequired} met={b.cat1aEarned >= b.cat1aRequired} />
                  )}
                  {b.assessment && (
                    <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.4 }}>Also required: {b.assessment}</div>
                  )}
                  {b.notes && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 3 }}>{b.notes}</div>}
                  <RuleProvenance
                    reportKey={`board:${b.code}`}
                    subject={b.label}
                    citation={b.citation}
                    meta={BOARD_REQS_META}
                    verified={b.verified}
                    compact
                  />
                </div>
              ))}
              {boardComps.filter(b => b.followsParent).map(b => (
                <div key={b.id} style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>
                  {b.label}: CME follows the primary board above
                </div>
              ))}
            </div>
          )}

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
                  {/* Sub-line only carries what the title doesn't already say */}
                  {(() => {
                    const cardTitle = item.title || item.category || "CME Activity";
                    const inTitle = (v) => v != null && cardTitle.toLowerCase().includes(String(v).toLowerCase());
                    return (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{cardTitle}</div>
                        <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                          {[item.category, item.hours && (item.hours + " hrs"), item.provider, item.date && formatDate(item.date)]
                            .filter(Boolean).filter(v => !inTitle(v)).join(" \u00b7 ")}
                        </div>
                      </>
                    );
                  })()}
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
                  <button onClick={() => { if (window.confirm("Delete this CME entry? Its attached certificate (if any) will be deleted too. This cannot be undone.")) handleDelete(item.id); }} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
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
