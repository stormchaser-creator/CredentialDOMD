import { useState, useMemo, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { generateId } from "../../utils/helpers";
import { useAiAvailable, describeAiStatus } from "../../utils/aiClient";
import { analyzeCvPdf, analyzeCvImage, analyzeCvText } from "../../utils/cvScan";
import { cvFindings, defaultSelectedCvIds, selectableIdsIn } from "../../utils/cvImport";
import {
  markAlreadyOnFile, markPlanLocks, groupFindings, isSelectable, countSelected,
  countPreviewHidden, buildSavePlan, savedSummary, leadNote, needsLabel,
  planLockNote, replacesLine, joinWords, PREVIEW_ROWS,
} from "../../utils/publicRecord";
import { UPLOAD_ACCEPT, isOfficeFile, extractOfficeText } from "../../utils/officeText";
import { checkStorageQuota } from "../../utils/storageQuota";
import { screenDocument, phiWarningText } from "../../utils/phiGuard";
import { isReadableDoc } from "../../utils/docPrefill";
import { CV_FILENAME_RE } from "../../utils/cvImport";

/**
 * Start from your CV.
 *
 * The physician's CV already holds the degree, the training, the positions,
 * the licenses, the papers and the societies. This reads it once and shows
 * every fact back as a row to tick, because a model reading prose is a
 * proposal and never a record.
 *
 * The review half is the public-record screen's, deliberately: same row, same
 * chips, same fold, same footer arithmetic, same buildSavePlan. Anything that
 * screen learned about not saving what the physician did not see is inherited
 * here rather than written a second time.
 *
 * One thing it adds: a "tick all" per group. Thirty rows is thirty taps
 * otherwise, and that is how a physician gives up halfway and ends with half
 * a record.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function CvImportReview({ source = null, onSaved, onClose }) {
  const { data, addItem, updateSettings, theme: T, isDesktop, isPro } = useApp();
  const aiOn = useAiAvailable(data.settings);
  const apiKey = data.settings.apiKey;
  const deg = data.settings.degreeType;
  const s = useMemo(() => data.settings || {}, [data.settings]);

  const [phase, setPhase] = useState("start"); // start | reading | review | saved
  const [raw, setRaw] = useState(null);
  const [fileName, setFileName] = useState(source?.fileName || "");
  const [selected, setSelected] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [saved, setSaved] = useState(null);

  const findings = useMemo(
    () => markPlanLocks(markAlreadyOnFile(raw ? cvFindings(raw, { data, settings: s }) : [], data, s), { isPro }),
    [raw, data, s, isPro],
  );
  const groups = useMemo(() => groupFindings(findings), [findings]);
  const selectedCount = countSelected(findings, selected);
  const previewHidden = countPreviewHidden(groups, selected, expanded);
  const pickable = findings.filter(isSelectable).length;

  // Documents already on file that could be the CV, so a physician who
  // emailed it to themselves does not have to find the file again.
  const onFileCandidates = useMemo(
    () => (data.documents || []).filter((d) => isReadableDoc(d) && CV_FILENAME_RE.test(d.name || "")),
    [data.documents],
  );

  const read = useCallback(async ({ dataUrl, name, mime, file }) => {
    setPhase("reading");
    setError("");
    setWarning("");
    setFileName(name || "");
    try {
      const office = isOfficeFile(file || { name, type: mime });
      let reply;
      if (office) {
        const text = await extractOfficeText(file ? { name, type: mime, file } : { name, type: mime, dataUrl });
        const screen = screenDocument(text);
        if (screen?.level === "clinical") {
          setError(`That file was not read. ${phiWarningText(screen)}`);
          setPhase("start");
          return;
        }
        if (screen) setWarning(phiWarningText(screen));
        reply = await analyzeCvText(text, deg, apiKey);
      } else if (mime === "application/pdf" || String(dataUrl).startsWith("data:application/pdf")) {
        reply = await analyzeCvPdf(dataUrl, deg, apiKey);
      } else {
        reply = await analyzeCvImage(dataUrl, deg, apiKey);
      }
      const screen = screenDocument(`${name}\n${JSON.stringify(reply)}`);
      if (screen?.level === "clinical") {
        setError(`That file was not read. ${phiWarningText(screen)}`);
        setPhase("start");
        return;
      }
      if (screen) setWarning(phiWarningText(screen));
      setRaw(reply);
      setSelected(defaultSelectedCvIds());
      setPhase("review");
    } catch (err) {
      setError(err?.message || "The CV could not be read. Try again.");
      setPhase("start");
    }
  }, [deg, apiKey]);


  const pickFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is larger than 10 MB. Save it smaller, or export the CV as a PDF.`);
      return;
    }
    const quota = checkStorageQuota(data.documents || [], [file]);
    if (!quota.ok) { setError(quota.message); return; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    read({ dataUrl, name: file.name, mime: file.type, file });
  }, [data.documents, read]);

  const toggle = useCallback((id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const tickGroup = useCallback((g, on) => {
    const ids = selectableIdsIn(g);
    setSelected((prev) => (on
      ? [...new Set([...prev, ...ids])]
      : prev.filter((x) => !ids.includes(x))));
  }, []);

  const save = useCallback(() => {
    const plan = buildSavePlan(findings, selected, generateId);
    if (!plan.count) return;
    if (Object.keys(plan.settings).length) updateSettings(plan.settings);
    for (const { section, item } of plan.items) addItem(section, item);
    setSaved(plan);
    setPhase("saved");
    onSaved?.(plan.count);
  }, [findings, selected, updateSettings, addItem, onSaved]);

  // ── styles, matching PublicRecordReview so the two screens read as one ────
  const card = {
    backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
    padding: "14px 16px", boxShadow: T.cardGlow,
  };
  const primaryBtn = (on = true) => ({
    padding: "12px 16px", borderRadius: 12, border: "none",
    backgroundColor: on ? T.accent : T.neutralDim, color: on ? "#fff" : T.textDim,
    fontSize: 15, fontWeight: 800, cursor: on ? "pointer" : "not-allowed",
  });
  const secondaryBtn = {
    padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
    backgroundColor: "transparent", color: T.text, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
  };
  const heading = {
    fontSize: 12, fontWeight: 800, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  const gridStyle = isDesktop
    ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }
    : { display: "flex", flexDirection: "column", gap: 12 };
  const chip = (label, color, bg) => (
    <span style={{
      fontSize: 10.5, fontWeight: 800, color, backgroundColor: bg,
      padding: "2px 7px", borderRadius: 8, whiteSpace: "nowrap",
    }}>{label}</span>
  );
  const errorBox = (text) => (
    <div style={{
      fontSize: 13, color: T.danger, backgroundColor: T.dangerDim,
      borderRadius: 10, padding: "10px 12px", lineHeight: 1.45,
    }}>{text}</div>
  );

  // ── one row ───────────────────────────────────────────────────────────────
  const row = (f) => {
    const on = selected.includes(f.id);
    const locked = !isSelectable(f);
    const planNote = planLockNote(f);
    const note = leadNote(f);
    const needs = needsLabel(f.needs);
    const replaces = replacesLine(f, s);
    return (
      <div key={f.id}
        onClick={() => { if (!locked) toggle(f.id); }}
        style={{
          display: "flex", gap: 10, alignItems: "flex-start",
          padding: "10px 12px", borderRadius: 12,
          border: `1px solid ${locked ? T.border : (on ? T.accent : T.border)}`,
          backgroundColor: locked ? "transparent" : (on ? T.accentDim : T.input),
          opacity: locked ? 0.55 : 1,
          cursor: locked ? "default" : "pointer",
        }}>
        <input
          type="checkbox"
          checked={on && !locked}
          disabled={locked}
          aria-label={f.label}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggle(f.id)}
          style={{ width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.35 }}>{f.label}</div>
          {planNote && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 4 }}>{planNote}</div>
          )}
          {!locked && replaces && (
            <div style={{ fontSize: 12.5, color: T.warning, fontWeight: 600, lineHeight: 1.45, marginTop: 4 }}>{replaces}</div>
          )}
          {f.detail && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 3 }}>{f.detail}</div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
            {f.alreadyOnFile && chip("already on file", T.textDim, T.neutralDim)}
            {f.planLocked && chip("not on your plan", T.textDim, T.neutralDim)}
            {!locked && replaces && chip("replaces what you have", T.warning, T.warningDim)}
            {!locked && needs && chip(`you add the ${needs}`, T.info, T.infoDim)}
          </div>
          {!locked && note && (
            <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.4, marginTop: 5 }}>{note}</div>
          )}
        </div>
      </div>
    );
  };

  const groupBlock = (g) => {
    const showAll = expanded[g.section] || g.findings.length <= PREVIEW_ROWS;
    const shown = showAll ? g.findings : g.findings.slice(0, PREVIEW_ROWS);
    const hiddenInGroup = showAll ? 0 : countSelected(g.findings.slice(PREVIEW_ROWS), selected);
    const ids = selectableIdsIn(g);
    const allOn = ids.length > 0 && ids.every((id) => selected.includes(id));
    const groupPickable = g.findings.filter(isSelectable).length;
    const onFile = g.findings.filter((f) => f.alreadyOnFile).length;
    const shut = g.findings.filter((f) => f.planLocked).length;
    return (
      <div key={g.section} style={{ ...card, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <div style={heading}>{g.title}</div>
          <div style={{ fontSize: 11.5, color: T.textDim, fontWeight: 700 }}>
            {joinWords([
              `${groupPickable} to review`,
              onFile ? `${onFile} on file` : "",
              shut ? `${shut} not on your plan` : "",
            ].filter(Boolean))}
          </div>
        </div>
        {ids.length > 1 && (
          <button onClick={() => tickGroup(g, !allOn)}
            style={{ ...secondaryBtn, width: "100%", marginBottom: 8, padding: "8px 12px", fontSize: 13 }}>
            {allOn ? `Untick all ${ids.length} here` : `Tick all ${ids.length} here`}
          </button>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map(row)}
        </div>
        {!showAll && (
          <button onClick={() => setExpanded((e) => ({ ...e, [g.section]: true }))}
            style={{ ...secondaryBtn, width: "100%", marginTop: 8 }}>
            Show the other {g.findings.length - PREVIEW_ROWS}
            {hiddenInGroup ? ` (${hiddenInGroup} already ticked)` : ""}
          </button>
        )}
      </div>
    );
  };

  // ── AI off ────────────────────────────────────────────────────────────────
  if (!aiOn) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 6 }}>Start from your CV</div>
          <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5 }}>
            Reading a CV needs the AI reader, which is off right now. {describeAiStatus(data.settings)}
          </div>
        </div>
        {onClose && <button onClick={onClose} style={secondaryBtn}>Close</button>}
      </div>
    );
  }

  // ── start / reading ───────────────────────────────────────────────────────
  if (phase === "start" || phase === "reading") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 6 }}>Start from your CV</div>
          <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
            Your CV already states your degree, your training, where you have worked, your
            licenses, your papers and your societies. Upload it once and every line comes back
            here as something to tick. Nothing is saved until you do.
          </div>
          {phase === "reading" ? (
            <div style={{ fontSize: 14, fontWeight: 700, color: T.accent }}>
              Reading {fileName || "your CV"}. This takes a few seconds.
            </div>
          ) : (
            <>
              {/* Opened from the "this looks like your CV" offer, the file is
                  already in Files, so the first button reads that one rather
                  than asking the physician to find it a second time. */}
              {source && (
                <button
                  onClick={() => read({ dataUrl: source.dataUrl, name: source.fileName, mime: source.mime || "" })}
                  style={{ ...primaryBtn(true), width: "100%", marginBottom: 8 }}>
                  Read {source.fileName || "this file"}
                </button>
              )}
              <label style={{ ...primaryBtn(!source), display: "inline-block", textAlign: "center", cursor: "pointer", ...(source ? { backgroundColor: "transparent", color: T.text, border: `1px solid ${T.border}`, fontSize: 13.5, fontWeight: 700, padding: "10px 14px", borderRadius: 10, cursor: "pointer" } : {}) }}>
                {source ? "Choose a different file" : "Choose your CV"}
                <input type="file" accept={UPLOAD_ACCEPT} onChange={pickFile} style={{ display: "none" }} />
              </label>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 8, lineHeight: 1.45 }}>
                PDF, .docx, or a photo. An old .doc cannot be read; save it as .docx or PDF first.
                Up to 10 MB.
              </div>
              {onFileCandidates.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...heading, marginBottom: 6 }}>Already in your files</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {onFileCandidates.slice(0, 5).map((d) => (
                      <button key={d.id}
                        onClick={() => read({ dataUrl: d.data, name: d.name, mime: d.type || "" })}
                        style={{ ...secondaryBtn, textAlign: "left" }}>
                        {d.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {error && errorBox(error)}
        {onClose && phase === "start" && <button onClick={onClose} style={secondaryBtn}>Close</button>}
      </div>
    );
  }

  // ── saved ─────────────────────────────────────────────────────────────────
  if (phase === "saved") {
    const summary = savedSummary(saved);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.success, marginBottom: 6 }}>
            Saved {saved?.count} {saved?.count === 1 ? "item" : "items"} from your CV.
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
            {summary.map((g) => `${g.findings.length} ${g.title.toLowerCase()}`).join(", ")}.
            Anything with a date missing is waiting for you in its own section.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => { setPhase("review"); }} style={secondaryBtn}>Back to the list</button>
          {onClose && <button onClick={onClose} style={primaryBtn(true)}>Done</button>}
        </div>
      </div>
    );
  }

  // ── review ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 4 }}>
          {pickable} {pickable === 1 ? "line" : "lines"} read from {fileName || "your CV"}
        </div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
          Nothing starts ticked, because this was read by AI off a document rather than taken
          from a register. Tick what is right, leave what is not, and check the dates: a CV
          that says a year gets that year, never a day it did not print.
        </div>
      </div>

      {warning && (
        <div style={{
          fontSize: 12.5, color: T.warning, backgroundColor: T.warningDim,
          borderRadius: 10, padding: "9px 12px", lineHeight: 1.45,
        }}>{warning}</div>
      )}
      {error && errorBox(error)}

      {pickable === 0 ? (
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>
            Nothing new in this one.
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
            Everything it states is already on file, or is in a section your plan does not open.
          </div>
        </div>
      ) : (
        <div style={gridStyle}>{groups.map(groupBlock)}</div>
      )}

      {pickable > 0 && (
        <div style={{
          ...card, position: "sticky", bottom: 0, zIndex: 2,
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{selectedCount} selected</div>
            <div style={{ fontSize: 12, color: T.textDim }}>
              {selectedCount === 0 ? "Tick what you want to keep." : "Only these get saved."}
            </div>
            {previewHidden > 0 && (
              <div style={{ fontSize: 12, color: T.warning, fontWeight: 700 }}>
                {previewHidden} {previewHidden === 1 ? "is" : "are"} below a "Show the other" button.
              </div>
            )}
          </div>
          <button onClick={() => setSelected([])} disabled={selectedCount === 0}
            style={{ ...secondaryBtn, opacity: selectedCount === 0 ? 0.5 : 1 }}>Clear</button>
          <button onClick={save} disabled={selectedCount === 0} style={primaryBtn(selectedCount > 0)}>
            Save {selectedCount || ""}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => { setRaw(null); setSelected([]); setPhase("start"); }} style={secondaryBtn}>
          Read a different file
        </button>
        {onClose && <button onClick={onClose} style={secondaryBtn}>Close</button>}
      </div>
    </div>
  );
}

export default memo(CvImportReview);
