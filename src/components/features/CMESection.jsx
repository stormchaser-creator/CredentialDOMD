import { useState, useMemo, useCallback, memo } from "react";
import { supabase } from "../../lib/supabase";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import ComplianceBar from "../shared/ComplianceBar";
import Cat1Bucket from "../shared/Cat1Bucket";
import CreditEquivalenceNote from "../shared/CreditEquivalenceNote";
import SmallSpecialtyNote from "../shared/SmallSpecialtyNote";
import CMEImport from "./CMEImport";
import RuleProvenance from "../shared/RuleProvenance";
import TopicProvenance from "../shared/TopicProvenance";
import DeskTable from "../shared/DeskTable";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, FileIcon } from "../shared/Icons";
import { CME_TOPICS } from "../../constants/cmeTopics";
import { getCMECategories } from "../../constants/credentialTypes";
import { BOARD_REQS_META } from "../../constants/boardRequirements";
import { getStateEntry, hasSeparateBoards, STATE_REQS_META } from "../../constants/stateRequirements";
import { STATE_NAMES } from "../../constants/states";
import { generateId, formatDate } from "../../utils/helpers";
import { complianceFor, windowNotes, cycleBucket } from "../../utils/compliance";
import { computeBoardCompliance, boardIdsFromLicenses, aoaNationalEntry } from "../../utils/boardCompliance";
import { stateTranscriptModel, boardTranscriptOptions, boardTranscriptModel, shareTranscriptPdf } from "../../utils/cmeTranscriptPdf";
import { CME_INBOX_ADDRESS } from "../../utils/inboxDocs";

// What one entry is called and where it came from, read by the phone card and
// the desk table alike so the two can never label the same record differently.
const cmeTitle = (item) => item.title || item.category || "CME Activity";
const cmeOrigin = (item) => item.source || item.customFields?.["Imported from"];
const DELETE_CONFIRM = "Delete this CME entry? Its attached certificate (if any) will be deleted too. This cannot be undone.";

// Desk table group order: rows after the cycle window (dated past the license
// expiration) sit above the window, then the window itself, then everything
// before it, then undated rows the engine never counts. Keys are strings
// because DeskTable orders groups by key comparison.
const CYCLE_ORDER = { after: "0", in: "1", before: "2", undated: "3" };

function CMESection({ onShare }) {
  const { data, addItem, editItem: editItemCtx, deleteItem, theme: T, allTrackedStates, navigate, isDesktop } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  // The compliance cards are the top of the desk layout (spec 2.3), so they
  // open by default there; on phone they stay behind the toggle as before.
  const [showCompliance, setShowCompliance] = useState(() => !!isDesktop);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [note, setNote] = useState("");

  const deg = data.settings.degreeType;
  const categories = getCMECategories(deg);

  // Every topic a tracked state mandates, including zero-hour checklist
  // items: those are met only when an entry carries the tag, and several
  // (e.g. MI opioid awareness, TX Life of the Mother Act) are not in the
  // general CME_TOPICS list, so this is the only place they can be tagged.
  const requiredTopics = useMemo(() =>
    [...new Set(allTrackedStates.flatMap(st =>
      (getStateEntry(st, deg)?.topics || []).map(t => t.topic)
    ))],
    [allTrackedStates, deg]
  );

  const openAdd = useCallback(() => { setForm({ topics: [] }); setEditItem(null); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item, topics: item.topics || [] }); setEditItem(item); setShowForm(true); }, []);
  useDeskAddShortcut(openAdd);
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

  // Newest first by when it was added, so a transcript imported today sits at
  // the top even when its activities are years old.
  const cmeNewestFirst = useMemo(() => {
    const when = (c) => c.createdAt || c.created_at || c.uploadedAt || c.date || "";
    return [...(data.cme || [])].sort((a, b) => String(when(b)).localeCompare(String(when(a))));
  }, [data.cme]);

  // The certificate or transcript this entry came from.
  const sourceDoc = useCallback(
    (item) => (data.documents || []).find(d => d.linkedTo === `cme:${item.id}`) || null,
    [data.documents]
  );
  const [docBusy, setDocBusy] = useState(null);
  const openSourceDoc = useCallback(async (doc) => {
    if (!doc) return;
    setDocBusy(doc.id);
    try {
      let blob = null;
      if (doc.data) {
        const b64 = String(doc.data).split(",")[1] || "";
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr], { type: doc.type || doc.mimeType || "application/pdf" });
      } else if (doc.storagePath && supabase) {
        // Not on this device: pull the bytes from the account's storage.
        const { data: file, error } = await supabase.storage.from("documents").download(doc.storagePath);
        if (error) throw error;
        blob = file;
      }
      if (!blob) { window.alert("That file has not finished syncing to this device yet. Open Files once and try again."); return; }
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      window.alert(`Could not open that document: ${e.message || e}`);
    } finally { setDocBusy(null); }
  }, []);

  // ── Desk width: the renewal cycle the entries table is grouped by ──
  // One of the tracked states, the primary state by default, switchable
  // when more than one is tracked. The window comes from the same
  // complianceFor() call the state's compliance card is built from, and rows
  // are bucketed by the engine's own cycleBucket(), so the in-window subtotal
  // is the card's Total Hours figure by construction. Null on phone: nothing
  // here runs below desk width.
  const [auditPick, setAuditPick] = useState(null);
  const auditState = isDesktop
    ? (allTrackedStates.includes(auditPick) ? auditPick
      : allTrackedStates.includes(data.settings.primaryState) ? data.settings.primaryState
        : allTrackedStates[0] || null)
    : null;
  const auditCycle = useMemo(() => {
    if (!auditState) return null;
    const comp = complianceFor(data, auditState);
    return { state: auditState, comp, start: comp.windowStart, end: comp.windowEnd };
  }, [auditState, data.cme, data.licenses, deg]); // eslint-disable-line react-hooks/exhaustive-deps

  const deskMain = { overflow: "hidden", textOverflow: "ellipsis" };
  const deskSub = { fontSize: 11, color: T.textDim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" };
  const deskBtn = {
    width: 26, height: 26, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const deskGhostBtn = { ...deskBtn, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted };
  const round2 = (n) => Math.round(n * 100) / 100;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>CME Credits</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setShowImport(true)} title="Import a CE Broker, ACCME CME Passport, PARS, or any CSV/Excel transcript" style={{
            padding: "8px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>Import transcript</button>
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

      <div style={{ fontSize: 13, color: T.textDim, marginBottom: 4 }}>
        {data.cme.length} entries &middot; {totalHours} total hours
      </div>
      {/* Certificate intake by email: the email-inbound function matches the
          sender to profiles.email, so the hint names the address that works. */}
      <div style={{ fontSize: 13, color: T.textDim, marginBottom: note ? 6 : 16, lineHeight: 1.45 }}>
        Forward certificate emails to <span style={{ fontWeight: 600, color: T.text }}>{CME_INBOX_ADDRESS}</span> from {data.settings.email
          ? <span style={{ fontWeight: 600, color: T.text }}>{data.settings.email}</span>
          : <span>the email on your account (<span onClick={() => navigate("more", "settings")} style={{ color: T.accent, cursor: "pointer", fontWeight: 600 }}>add it in Settings</span>)</span>}
      </div>
      {note && (
        <div style={{ fontSize: 13, color: T.accent, marginBottom: 12, padding: "8px 12px", borderRadius: 10, backgroundColor: T.accentGlow }}>{note}</div>
      )}

      {/* Transcript import: CE Broker / ACCME / PARS / CSV -> review -> addItem("cme") */}
      <CMEImport open={showImport} onClose={() => setShowImport(false)} requiredTopics={requiredTopics} />

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

      {showCompliance && (() => {
        // Every card is the same JSX at every width. Desk lays the set out
        // two across (the cards are dense: window notes, bars, topic
        // provenance) and the grid gap replaces the stacking margin.
        const cardStyle = (borderColor) => ({
          backgroundColor: T.card, border: `1px solid ${borderColor}`,
          borderRadius: 14, padding: "16px 18px", marginBottom: isDesktop ? 0 : 10, boxShadow: T.shadow1,
        });
        const stateCards = complianceData.map(({ state: st, compliance: comp }) => (
            <div key={st} style={cardStyle(comp.fullyCompliant ? T.success : T.border)}>
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
              {/* The counting window, in plain text. It used to be invisible,
                  so a physician had to guess which of their entries counted
                  toward this renewal. */}
              <div style={{
                fontSize: 12.5, color: T.textMuted, lineHeight: 1.5,
                backgroundColor: T.input, borderRadius: 8, padding: "8px 10px", marginBottom: 12,
              }}>
                <span style={{ fontWeight: 700, color: T.text }}>{comp.windowLabel}.</span>
                {windowNotes(comp).map((n, i) => (
                  <div key={i} style={{ marginTop: 3, color: comp.cycleStartIgnored && i === 1 ? T.warning : T.textDim }}>{n}</div>
                ))}
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
              {/* The Category 1 minimum is its own requirement, not a second
                  bar under the total. Label and accepted-type list both come
                  from the engine's `cat1Keywords`, so the words match the math.
                  The hours that did NOT count are itemised there too. */}
              <Cat1Bucket
                comp={comp}
                entries={data.cme}
                degreeType={deg}
                onFindCme={() => navigate("credentials", "findCme")}
              />
              {/* Every mandated topic carries its own periodicity and its own
                  link to the rule, because the rule set's single sourceUrl
                  cannot tell a physician where any one of these lines came
                  from, or whether it is owed once or every renewal. */}
              {comp.topicResults.map(tr => (
                <div key={tr.topic}>
                  <ComplianceBar label={tr.topic} earned={tr.earned} required={tr.required} met={tr.met} note={tr.note} />
                  <TopicProvenance
                    periodLabel={tr.periodLabel}
                    cite={tr.cite}
                    url={tr.url}
                    sourceInherited={tr.sourceInherited}
                    citeInherited={tr.citeInherited}
                  />
                  {!tr.met && (
                    <button onClick={() => navigate("credentials", `findCme:${tr.topic}`)} style={{
                      padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none",
                      backgroundColor: T.accentGlow, color: T.accent, cursor: "pointer", marginTop: 2, marginBottom: 4, marginLeft: 2,
                    }}>Find CME for {tr.topic} &rarr;</button>
                  )}
                </div>
              ))}
              {/* Board/MOC exemption: surfaced (not auto-applied) when a Board
                  Certification record is on file and the state names one, so
                  the physician can claim it rather than the app silently
                  dropping the requirement. */}
              {(() => {
                const hasBoardCert = (data.licenses || []).some(l => /board certification/i.test(l.type || ""));
                const moc = (getStateEntry(st, deg)?.moc || "").trim();
                if (!hasBoardCert || !moc || /^no$/i.test(moc)) return null;
                return (
                  <div style={{ fontSize: 12, color: T.textMuted, backgroundColor: T.accentGlow, borderRadius: 8, padding: "7px 10px", marginTop: 6, marginBottom: 2, lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 700, color: T.accent }}>You may be exempt.</span> {moc}. Not applied automatically; confirm with the board and claim it on your renewal if it applies.
                  </div>
                );
              })()}
              <RuleProvenance
                reportKey={st}
                subject={`${st}${hasSeparateBoards(st) ? ` (${deg || "MD"})` : ""}`}
                citation={comp.source}
                meta={STATE_REQS_META}
                verified={comp.verified}
                sourceUrl={comp.sourceUrl}
                upcoming={comp.upcoming}
              />
            </div>
          ));

          // Board MOC: the matched board's continuing-certification CME,
          // from Settings → Board Specialties or a Board Certification
          // license record. Same window logic as the Home card.
          const boardCard = boardComps.length > 0 && (
            <div style={cardStyle(T.border)}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>Board MOC</div>
              <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>Continuing certification CME for your board{boardComps.filter(b => !b.followsParent).length > 1 ? "s" : ""}</div>
              {boardComps.filter(b => !b.followsParent).map(b => (
                <div key={b.id} style={{ marginBottom: 12 }}>
                  <ComplianceBar label={b.label} earned={b.earned} required={b.required} met={b.met}
                    note={`${b.unit} \u00b7 ${b.windowLabel}${b.daysLeft != null ? ` \u00b7 ${b.daysLeft} days left` : ""}`} />
                  {b.cat1aRequired > 0 && (
                    <>
                      <ComplianceBar label="AOA Cat 1-A minimum" earned={b.cat1aEarned} required={b.cat1aRequired} met={b.cat1aEarned >= b.cat1aRequired} />
                      {/* The small-specialty exception operates inside AOA
                          board and membership accounting, which is exactly
                          here. It is not offered on state cards, where it does
                          not reach. */}
                      {b.cat1aEarned < b.cat1aRequired && <SmallSpecialtyNote degreeType={deg} />}
                    </>
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
          );

          // AOA National 120/3-yr requirement, cycle-windowed via the same
          // engine the transcript and Home use (the old block compared a
          // LIFETIME hour sum to a 3-year requirement). Suppressed when an
          // AOA board card is already shown, matching Home's logic.
          const aoaCard = deg === "DO" && !boardComps.some(b => b.source === "AOA" && !b.followsParent) && (() => {
            const aoa = aoaNationalEntry(data);
            return (
              <div style={cardStyle(T.border)}>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 2 }}>AOA National</div>
                <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>{aoa.windowLabel}{aoa.daysLeft != null ? ` · ${aoa.daysLeft} days left` : ""}</div>
                <ComplianceBar label="Total" earned={aoa.earned} required={aoa.required} met={aoa.met} />
                <ComplianceBar label="Cat 1-A minimum" earned={aoa.cat1aEarned} required={aoa.cat1aRequired} met={aoa.cat1aEarned >= aoa.cat1aRequired} />
                <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, marginTop: -4 }}>
                  Only an AOA-accredited Category 1 sponsor produces 1-A. AMA PRA Category 1 posts here as AOA Category 2 and counts toward the total above, never toward this line.
                </div>
                {aoa.cat1aEarned < aoa.cat1aRequired && <SmallSpecialtyNote degreeType={deg} />}
              </div>
            );
          })();

          return isDesktop
            ? <div className="cmd-responsive-grid-2" style={{ marginBottom: 16 }}>{stateCards}{boardCard}{aoaCard}</div>
            : <div style={{ marginBottom: 16 }}>{stateCards}{boardCard}{aoaCard}</div>;
      })()}

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit CME" : "Add CME"}>
        <Field label="Activity / Title"><input value={form.title || ""} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={iS} placeholder="e.g. Annual Pain Management Conference" /></Field>
        <Field label="Credit Category" hint={deg === "DO" ? "Dually accredited activity (AOA 1-A and AMA PRA 1)? File it as AOA Category 1-A: for a DO it counts toward AOA, osteopathic boards, and AMA-rule states alike." : undefined}>
          <select value={form.category || ""} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Select category...</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {/* What the selected category actually counts as for a DO, at the
            moment of logging. The case this closes: OpenEvidence CME is
            accredited through AKH Inc. (ACCME) and awards AMA PRA Category 1,
            which for a DO is AOA Category 2 and can never satisfy California's
            20-hour AOA Category 1-A/1-B minimum. */}
        <CreditEquivalenceNote category={form.category} degreeType={deg} />
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
      ) : isDesktop ? (
        /* Desk width: the same entries as one table, grouped by the chosen
           state's renewal cycle window so the rows audit against the math
           the compliance card above shows: the in-window subtotal is that
           card's Total Hours figure, from the same complianceFor() window
           and the engine's own cycleBucket(). Newest first within a group.
           The window's subtotal row renders even when nothing falls in it
           (groupKeys): an empty cycle is the finding, not an absence of one.
           Row click opens the existing edit modal (there is no CME view
           modal); the action cell is the card's own share, edit, delete.
           Phone (the branch below) is untouched. */
        <>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10, fontSize: 12.5, color: T.textMuted, lineHeight: 1.45 }}>
            {auditCycle ? (
              <>
                <span>
                  <span style={{ fontWeight: 700, color: T.text }}>Grouped by the {STATE_NAMES[auditCycle.state] || auditCycle.state} renewal cycle.</span>
                  {" "}{auditCycle.comp.windowLabel}.
                </span>
                {allTrackedStates.length > 1 && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>Cycle</span>
                    {allTrackedStates.map(st => {
                      const sel = st === auditCycle.state;
                      return (
                        <button key={st} onClick={() => setAuditPick(st)} title={`Group entries by the ${STATE_NAMES[st] || st} renewal cycle`} style={{
                          padding: "3px 10px", fontSize: 12, fontWeight: 700, borderRadius: 14,
                          border: `1px solid ${sel ? T.accent : T.border}`,
                          backgroundColor: sel ? T.accent : "transparent",
                          color: sel ? "#fff" : T.textMuted, cursor: "pointer",
                        }}>{st}</button>
                      );
                    })}
                  </span>
                )}
              </>
            ) : (
              <span>Add a state medical license or set your primary state in Settings to group entries by renewal cycle.</span>
            )}
          </div>
          <DeskTable
            items={data.cme}
            defaultSort={{ key: "date", dir: "desc" }}
            onRowClick={(item) => openEdit(item)}
            actionsWidth={110}
            groupBy={auditCycle ? (item) => CYCLE_ORDER[cycleBucket(item, auditCycle.start, auditCycle.end)] : undefined}
            groupDir="asc"
            groupKeys={auditCycle ? [CYCLE_ORDER.in] : undefined}
            subtotal={auditCycle ? (key, list) => {
              const { state: st, comp, start, end } = auditCycle;
              const total = round2(list.reduce((s, c) => s + (parseFloat(c.hours) || 0), 0));
              const count = `${list.length} entr${list.length === 1 ? "y" : "ies"}`;
              const label = (text, note) => (
                <span>
                  {text}
                  <span style={{ fontWeight: 500, color: T.textDim }}>{" \u00b7 "}{count}{note ? ` \u00b7 ${note}` : ""}</span>
                </span>
              );
              if (key === CYCLE_ORDER.in) {
                return {
                  label: label(`In the ${st} cycle window`, `${formatDate(start)} to ${formatDate(end)}`),
                  cells: {
                    hours: (
                      <>
                        <div style={{ color: comp.noGeneralReq ? T.text : comp.totalMet ? T.success : T.danger }}>{total}</div>
                        <div style={deskSub}>{comp.noGeneralReq ? "no hour requirement" : `of ${comp.totalRequired} required`}</div>
                      </>
                    ),
                  },
                };
              }
              if (key === CYCLE_ORDER.undated) {
                return {
                  label: label("No date", "never counted; add a date to each"),
                  cells: { hours: <><div>{total}</div><div style={deskSub}>not counted</div></> },
                };
              }
              return {
                label: label(`${key === CYCLE_ORDER.after ? "After" : "Before"} the ${st} cycle window`),
                cells: { hours: <><div>{total}</div><div style={deskSub}>outside this renewal</div></> },
              };
            } : undefined}
            columns={[
              // Widths are percentages (see Invoices): the CME pane sits
              // beside the 240px Credentials rail, so pixel minimums would
              // push the Actions cell out of the wrapper at a 1024px window.
              // Title takes the remainder and ellipsizes.
              { key: "date", label: "Date", type: "date", width: "11%",
                render: c => (c.date ? formatDate(c.date) : "\u2014") },
              { key: "title", label: "Title", value: c => cmeTitle(c),
                render: c => <div style={{ ...deskMain, fontWeight: 700 }} title={cmeTitle(c)}>{cmeTitle(c)}</div> },
              { key: "category", label: "Category", width: "15%",
                render: c => (c.category ? <span title={c.category}>{c.category}</span> : "\u2014") },
              { key: "hours", label: "Hours", type: "number", width: "7%", align: "right",
                render: c => (c.hours != null && c.hours !== "" ? String(c.hours) : "\u2014") },
              { key: "provider", label: "Provider", width: "14%",
                render: c => (c.provider ? <span title={c.provider}>{c.provider}</span> : "\u2014") },
              { key: "topics", label: "Topics", width: "17%",
                value: c => ((c.topics || []).join(", ") || null),
                // The card's chips as a comma list so the cell ellipsizes;
                // topics a tracked state mandates keep the accent.
                render: c => {
                  const list = c.topics || [];
                  if (!list.length) return "\u2014";
                  return (
                    <span title={list.join(", ")}>
                      {list.map((t, i) => (
                        <span key={i}>
                          {i > 0 && ", "}
                          <span style={requiredTopics.includes(t) ? { color: T.accent, fontWeight: 600 } : undefined}>{t}</span>
                        </span>
                      ))}
                    </span>
                  );
                } },
              { key: "certificate", label: "Certificate", type: "number", width: "10%",
                // Sorts linked files first, then bare certificate numbers.
                value: c => (sourceDoc(c) ? 2 : c.certificateNumber ? 1 : 0),
                render: c => {
                  const doc = sourceDoc(c);
                  if (doc) {
                    return (
                      <button title={docBusy === doc.id ? "Opening..." : `Open ${doc.name || "certificate"}`} aria-label="Open certificate"
                        onClick={(ev) => { ev.stopPropagation(); openSourceDoc(doc); }}
                        style={{ ...deskBtn, backgroundColor: T.accentGlow, color: T.accent, opacity: docBusy === doc.id ? 0.5 : 1 }}>
                        <FileIcon />
                      </button>
                    );
                  }
                  if (c.certificateNumber) {
                    return <span title={`Certificate #${c.certificateNumber}, no file attached`} style={{ color: T.textMuted }}>#{c.certificateNumber}</span>;
                  }
                  const from = cmeOrigin(c);
                  return <span title={from ? `From ${from}, no certificate attached` : "Added by hand, no certificate attached"} style={{ color: T.textDim }}>{"\u2014"}</span>;
                } },
            ]}
            actions={(c) => (
              <div style={{ display: "inline-flex", gap: 3 }}>
                <button title="Share" aria-label="Share entry" onClick={(ev) => { ev.stopPropagation(); onShare(c, "cme"); }} style={{ ...deskBtn, backgroundColor: T.shareGlow, color: T.share }}><SendIcon /></button>
                <button title="Edit" aria-label="Edit entry" onClick={(ev) => { ev.stopPropagation(); openEdit(c); }} style={deskGhostBtn}><EditIcon /></button>
                <button title="Delete" aria-label="Delete entry" onClick={(ev) => { ev.stopPropagation(); if (window.confirm(DELETE_CONFIRM)) handleDelete(c.id); }} style={{ ...deskBtn, backgroundColor: T.dangerDim, color: T.danger }}><TrashIcon /></button>
              </div>
            )}
          />
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cmeNewestFirst.map(item => (
            <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {/* Sub-line only carries what the title doesn't already say */}
                  {(() => {
                    const cardTitle = cmeTitle(item);
                    const inTitle = (v) => v != null && cardTitle.toLowerCase().includes(String(v).toLowerCase());
                    return (
                      <>
                        <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{cardTitle}</div>
                        <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                          {[item.category, item.hours && (item.hours + " hrs"), item.provider, item.date && formatDate(item.date)]
                            .filter(Boolean).filter(v => !inTitle(v)).join(" \u00b7 ")}
                        </div>
                        {(() => {
                          const doc = sourceDoc(item);
                          if (doc) {
                            return (
                              <button onClick={(ev) => { ev.stopPropagation(); openSourceDoc(doc); }} style={{
                                marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%",
                                padding: "5px 10px", borderRadius: 9, border: `1px solid ${T.border}`,
                                backgroundColor: T.input, color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer",
                              }}>
                                <span>{"\ud83d\udcc4"}</span>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {docBusy === doc.id ? "Opening..." : doc.name || "Source document"}
                                </span>
                              </button>
                            );
                          }
                          const from = cmeOrigin(item);
                          return (
                            <div style={{ marginTop: 5, fontSize: 11.5, color: T.textDim }}>
                              {from ? `From ${from}` : "Added by hand, no certificate attached"}
                            </div>
                          );
                        })()}
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
                  <button onClick={() => { if (window.confirm(DELETE_CONFIRM)) handleDelete(item.id); }} style={{ padding: "5px 7px", borderRadius: 6, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
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
