import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { CME_TOPICS } from "../../constants/cmeTopics";
import { getCMECategories } from "../../constants/credentialTypes";
import { generateId } from "../../utils/helpers";
import {
  IMPORT_ACCEPT, IMPORT_FIELDS, IMPORT_SOURCES,
  readImportFile, findHeaderRow, detectSource, guessMapping, rowsFromTable,
  markDuplicates, toCmeEntry, textToTable, parseTranscriptText,
  looksLikeCeBroker, parseCeBrokerPages, looksLikeCmePassport, parseCmePassportText,
  structureTranscriptWithAI,
} from "../../utils/cmeImport";

/**
 * CMEImport: file picker (or paste) -> parse -> review every row -> add to
 * the CME log. Nothing is saved until the physician approves the batch.
 *
 * Steps: pick -> (text | map) -> review -> done.
 *  - CE Broker CE Report PDFs and ACCME CME Passport transcript PDFs are read
 *    directly from their known layout.
 *  - CSV / XLSX: columns are guessed from the header row and shown for
 *    confirmation (always shown for a generic file).
 *  - Other PDFs / text: with a Gemini key in Settings the model structures
 *    the rows; without one the extracted text is shown and read either as
 *    columns (then mapped) or line by line.
 */

const SRC_CEBROKER = { id: "cebroker-pdf", label: "CE Broker CE Report (PDF)", verified: true, note: "Layout read directly. The CE Report prints no certificate number and no AMA credit category, so every row is set to AMA PRA Category 1 for you to confirm. Course and provider numbers are kept in Notes." };
const SRC_CMEP = { id: "cmepassport-pdf", label: "ACCME CME Passport transcript (PDF)", verified: true, note: "Layout read directly from the ACCME transcript. Board MOC points and credit types are kept in Notes; rows with MOC points but no AMA PRA credits use the points as hours." };
const SRC_AI = { id: "ai", label: "AI-structured transcript", verified: false, note: "Rows were structured by the AI reader from the document text. Check dates and hours against the original before adding." };
const SRC_LINES = { id: "lines", label: "Text, read line by line", verified: false, note: "Each line with a date became a row; hours are the number next to a credit word, the longest remaining text is the title. Check every row." };

function CMEImport({ open, onClose }) {
  const { data, addItem, theme: T } = useApp();
  const deg = data.settings.degreeType;
  const apiKey = data.settings.apiKey;
  const categories = useMemo(() => getCMECategories(deg), [deg]);
  const fileRef = useRef(null);

  const [step, setStep] = useState("pick");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [showSources, setShowSources] = useState(false);

  // text step
  const [text, setText] = useState("");
  const [textWhy, setTextWhy] = useState("");
  const [pdfDataUrl, setPdfDataUrl] = useState(null);

  // map step
  const [table, setTable] = useState(null);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [mapping, setMapping] = useState({});
  const [source, setSource] = useState(null);

  // review step
  const [rows, setRows] = useState([]);
  const [rowSource, setRowSource] = useState(null);
  const [done, setDone] = useState(null);

  const reset = useCallback(() => {
    setStep("pick"); setBusy(false); setBusyLabel(""); setError(""); setPasteOpen(false); setPasteText("");
    setText(""); setTextWhy(""); setPdfDataUrl(null); setTable(null); setHeaderIndex(0); setMapping({}); setSource(null);
    setRows([]); setRowSource(null); setDone(null); setShowSources(false);
  }, []);
  const close = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const toReview = useCallback((parsed, src) => {
    const marked = markDuplicates(parsed, data.cme);
    if (!marked.length) {
      setError("No completed activities were found in that file. Try the paste option, or map the columns by hand.");
      return false;
    }
    setRows(marked); setRowSource(src); setStep("review"); setError("");
    return true;
  }, [data.cme]);

  const runAI = useCallback(async ({ text: t, pdfDataUrl: p }) => {
    setBusyLabel("Reading transcript with AI");
    const parsed = await structureTranscriptWithAI({ text: t, pdfDataUrl: p }, deg, apiKey);
    return toReview(parsed, SRC_AI);
  }, [apiKey, deg, toReview]);

  const showText = useCallback((t, why, dataUrl) => {
    setText(t || ""); setTextWhy(why || ""); setPdfDataUrl(dataUrl || null); setStep("text"); setError("");
  }, []);

  const handleTable = useCallback((tbl) => {
    if (!tbl || !tbl.length) { setError("That file is empty."); return; }
    const hi = findHeaderRow(tbl);
    const headers = hi >= 0 ? tbl[hi] : [];
    const src = hi >= 0 ? detectSource(headers) : { id: "generic", label: "Generic CSV", verified: false, note: "No header row was recognised. Pick which column holds each field; a row needs at least a date or a title." };
    const map = hi >= 0 ? guessMapping(headers) : Object.fromEntries(IMPORT_FIELDS.map(f => [f.key, null]));
    setTable(tbl); setHeaderIndex(hi); setSource(src); setMapping(map);
    const complete = map.date != null && map.hours != null && (map.title != null || src.id === "pars-batch");
    if (src.id !== "generic" && complete) {
      toReview(rowsFromTable(tbl, map, { deg, headerIndex: hi, source: src }), src);
    } else {
      setStep("map"); setError("");
    }
  }, [deg, toReview]);

  const handleText = useCallback(async (t, why, dataUrl) => {
    if (apiKey) {
      try { if (await runAI({ text: t })) return; }
      catch (e) { showText(t, `${why} The AI reader could not structure it (${e.message}). Read it as columns or line by line below.`, dataUrl); return; }
    }
    showText(t, why, dataUrl);
  }, [apiKey, runAI, showText]);

  const handleFile = useCallback(async (file) => {
    setError(""); setBusy(true); setBusyLabel("Reading file");
    try {
      const r = await readImportFile(file);
      if (r.kind === "table") { handleTable(r.table); return; }
      if (r.kind === "text") { await handleText(r.text, "Text file loaded."); return; }
      // PDF
      if (r.error && !r.text) {
        if (apiKey && r.dataUrl) { await runAI({ pdfDataUrl: r.dataUrl }); return; }
        throw new Error(r.error);
      }
      if (looksLikeCeBroker(r.text)) {
        if (toReview(parseCeBrokerPages(r.pages, { deg }), SRC_CEBROKER)) return;
        showText(r.text, "This looks like a CE Broker CE Report but no course rows were found in the table. The extracted text is below.", r.dataUrl);
        return;
      }
      if (looksLikeCmePassport(r.text)) {
        if (toReview(parseCmePassportText(r.text, { deg }), SRC_CMEP)) return;
        showText(r.text, "This looks like an ACCME CME Passport transcript but no activity rows were found. The extracted text is below.", r.dataUrl);
        return;
      }
      if (r.unreadable || !r.text.trim()) {
        if (apiKey && r.dataUrl) { await runAI({ pdfDataUrl: r.dataUrl }); return; }
        throw new Error("This PDF has no readable text layer (it is probably a scan). Add a Gemini API key in Settings to have AI read it, or paste the text.");
      }
      await handleText(r.text, "PDF text extracted. This is not a CE Broker or ACCME layout, so it is treated as a generic transcript.", r.dataUrl);
    } catch (e) {
      setError(e.message || "Could not read that file.");
    } finally {
      setBusy(false); setBusyLabel("");
    }
  }, [apiKey, deg, handleTable, handleText, runAI, showText, toReview]);

  const handlePaste = useCallback(async () => {
    const t = pasteText.trim();
    if (!t) return;
    setBusy(true); setError("");
    try {
      if (looksLikeCmePassport(t) && toReview(parseCmePassportText(t, { deg }), SRC_CMEP)) return;
      const tt = textToTable(t);
      if (tt && findHeaderRow(tt) >= 0) { handleTable(tt); return; }
      await handleText(t, "Pasted text.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, [pasteText, deg, toReview, handleTable, handleText]);

  // Text step actions
  const textAsColumns = useCallback(() => {
    const tt = textToTable(text);
    if (!tt) { setError("The text does not split into columns. Try line by line."); return; }
    handleTable(tt);
  }, [text, handleTable]);
  const textAsLines = useCallback(() => {
    toReview(parseTranscriptText(text, { deg }), SRC_LINES) || setError("No lines with a date were found.");
  }, [text, deg, toReview]);
  const textWithAI = useCallback(async () => {
    setBusy(true); setError("");
    try { await runAI(text.trim() ? { text } : { pdfDataUrl }); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); setBusyLabel(""); }
  }, [runAI, text, pdfDataUrl]);

  // Map step
  const headers = useMemo(() => (table && headerIndex >= 0 ? table[headerIndex] : []) || [], [table, headerIndex]);
  const columnCount = useMemo(() => (table || []).reduce((m, r) => Math.max(m, r.length), 0), [table]);
  const sampleRow = useMemo(() => (table || []).slice(headerIndex + 1).find(r => r.some(v => String(v ?? "").trim())) || [], [table, headerIndex]);
  const applyMapping = useCallback(() => {
    if (mapping.date == null && mapping.title == null) { setError("Map at least the date or the title column."); return; }
    toReview(rowsFromTable(table, mapping, { deg, headerIndex, source }), source);
  }, [mapping, table, deg, headerIndex, source, toReview]);

  // Review step
  const setRow = useCallback((key, patch) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r)), []);
  const included = rows.filter(r => r.include);
  const includedHours = included.reduce((s, r) => s + (parseFloat(r.hours) || 0), 0);
  const dupCount = rows.filter(r => r.duplicate).length;
  const assumedCount = included.filter(r => r.categoryAssumed).length;

  const saveBatch = useCallback(() => {
    let count = 0;
    for (const r of included) {
      addItem("cme", { id: generateId(), ...toCmeEntry(r) });
      count++;
    }
    setDone({ count, skipped: rows.length - count });
    setStep("done");
  }, [included, rows.length, addItem]);

  const small = { fontSize: 12.5, padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.inputBorder}`, backgroundColor: T.card, color: T.text, boxSizing: "border-box", width: "100%" };
  const badge = (txt, color, bg) => <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", color, backgroundColor: bg, padding: "2px 6px", borderRadius: 6, whiteSpace: "nowrap" }}>{txt}</span>;
  const secondaryBtn = { padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" };
  const primaryBtn = (enabled = true) => ({ padding: "12px 16px", borderRadius: 10, border: "none", backgroundColor: enabled ? T.accent : T.border, color: "#fff", fontSize: 14, fontWeight: 800, cursor: enabled ? "pointer" : "default", opacity: busy ? 0.6 : 1 });

  const sourceBanner = (src) => src && (
    <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 10, padding: "8px 10px", borderRadius: 10, backgroundColor: src.verified ? T.successDim : T.warningDim, border: `1px solid ${src.verified ? T.success : T.warning}`, lineHeight: 1.45 }}>
      <span style={{ fontWeight: 700, color: T.text }}>{src.label}</span>
      {" "}{badge(src.verified ? "layout verified" : "generic, check mapping", src.verified ? T.success : T.warning, "transparent")}
      <div style={{ marginTop: 2 }}>{src.note}</div>
    </div>
  );

  return (
    <Modal open={open} onClose={close} title="Import CME transcript" width={640}>
      {/* ── pick ── */}
      {step === "pick" && (
        <>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Bring credits in without retyping. Upload a CE Broker CE Report PDF, an ACCME CME Passport transcript PDF, an ACCME PARS Excel file, or any CSV or Excel export. Every row lands in a review list first, rows already in your log are unticked as duplicates, and nothing is saved until you add the batch.
            {!apiKey && " Other PDF layouts are read on-device as text; add a Gemini API key in Settings to have AI structure them."}
          </div>
          <input type="file" ref={fileRef} accept={IMPORT_ACCEPT} style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
            {busy ? `${busyLabel || "Reading"}...` : "Choose transcript file (PDF, CSV, XLSX)"}
          </button>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => setPasteOpen(p => !p)} style={{ ...secondaryBtn, flex: 1 }}>{pasteOpen ? "Hide paste box" : "Paste text instead"}</button>
            <button onClick={() => setShowSources(s => !s)} style={{ ...secondaryBtn, flex: 1 }}>{showSources ? "Hide formats" : "Which formats, which columns?"}</button>
          </div>
          {pasteOpen && (
            <div style={{ marginTop: 10 }}>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder={"Paste rows copied from a course history or transcript, one activity per line, for example:\n3/11/2024   Prevention of Medical Errors   Florida Medical Association   2 credits"}
                style={{ ...small, minHeight: 120, fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
              <button onClick={handlePaste} disabled={busy || !pasteText.trim()} style={{ ...primaryBtn(!!pasteText.trim()), width: "100%", marginTop: 6 }}>Read pasted text</button>
            </div>
          )}
          {showSources && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {IMPORT_SOURCES.map(s => (
                <div key={s.id} style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 12, color: T.textMuted, lineHeight: 1.45 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{s.label}</span>
                    {badge(s.verified ? "layout verified" : "generic CSV", s.verified ? T.success : T.warning, s.verified ? T.successDim : T.warningDim)}
                  </div>
                  <div><span style={{ color: T.textDim }}>Where: </span>{s.how}</div>
                  <div><span style={{ color: T.textDim }}>Columns: </span>{s.columns}</div>
                  <div>{s.status}</div>
                </div>
              ))}
            </div>
          )}
          {error && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 12, lineHeight: 1.45 }}>{error}</div>}
        </>
      )}

      {/* ── text (extracted or pasted, no known layout) ── */}
      {step === "text" && (
        <>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 8, lineHeight: 1.5 }}>
            {textWhy} Edit the text if needed, then choose how to read it: as columns (when each line has the same fields separated by tabs or wide gaps, you map them next) or line by line (any line with a date becomes a row).
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} style={{ ...small, minHeight: 220, fontSize: 12.5, resize: "vertical", fontFamily: "ui-monospace, Menlo, monospace", whiteSpace: "pre", overflowX: "auto" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button onClick={() => { setStep("pick"); setError(""); }} style={secondaryBtn}>Back</button>
            <button onClick={textAsColumns} disabled={busy} style={{ ...primaryBtn(), flex: 1 }}>Read as columns</button>
            <button onClick={textAsLines} disabled={busy} style={{ ...primaryBtn(), flex: 1 }}>Read line by line</button>
            {apiKey && <button onClick={textWithAI} disabled={busy} style={{ ...secondaryBtn, flex: 1 }}>{busy ? "AI reading..." : "Have AI read it"}</button>}
          </div>
          {error && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{error}</div>}
        </>
      )}

      {/* ── map columns ── */}
      {step === "map" && table && (
        <>
          {sourceBanner(source)}
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
            {headerIndex >= 0 ? `Header row found (row ${headerIndex + 1} of the file). ` : "No header row found; columns are numbered. "}
            Pick which column feeds each field. Sample values are from the first data row.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {IMPORT_FIELDS.map(f => (
              <label key={f.key} style={{ fontSize: 12, color: T.textMuted }}>
                <div style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{f.label}</div>
                <select value={mapping[f.key] == null ? "" : String(mapping[f.key])} onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value === "" ? null : Number(e.target.value) }))} style={{ ...small, appearance: "auto" }}>
                  <option value="">Not in file</option>
                  {Array.from({ length: columnCount }, (_, i) => (
                    <option key={i} value={i}>{(headers[i] || `Column ${i + 1}`)}{sampleRow[i] ? ` (${String(sampleRow[i]).slice(0, 28)})` : ""}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 8 }}>
            {(table.length - (headerIndex + 1))} data row{table.length - (headerIndex + 1) === 1 ? "" : "s"}. Credit types are mapped to your degree's categories ({deg === "DO" ? "AOA and AMA" : "AMA PRA and MOC"}); topics are guessed from the title and subject text and shown for you to adjust.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { setStep("pick"); setError(""); }} style={secondaryBtn}>Back</button>
            <button onClick={applyMapping} disabled={busy} style={{ ...primaryBtn(), flex: 1 }}>Continue to review</button>
          </div>
          {error && <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{error}</div>}
        </>
      )}

      {/* ── review ── */}
      {step === "review" && (
        <>
          {sourceBanner(rowSource)}
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>
            {included.length} of {rows.length} row{rows.length === 1 ? "" : "s"} selected &middot; {includedHours} hours
          </div>
          <div style={{ fontSize: 12, color: T.textDim, marginBottom: 8, lineHeight: 1.45 }}>
            {dupCount > 0 && `${dupCount} already in your log (same date, title and hours) and unticked. `}
            {assumedCount > 0 && `${assumedCount} selected row${assumedCount === 1 ? " has" : "s have"} a credit type the source did not state; set to AMA PRA Category 1, change if needed. `}
            Edit any field before adding.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "52vh", overflowY: "auto", paddingRight: 2 }}>
            {rows.map(r => (
              <div key={r.key} style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${r.duplicate ? T.warning : T.border}`, backgroundColor: r.include ? T.input : "transparent", opacity: r.include ? 1 : 0.6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={r.include} onChange={e => setRow(r.key, { include: e.target.checked })} style={{ width: 17, height: 17, flexShrink: 0 }} />
                  <input value={r.title} onChange={e => setRow(r.key, { title: e.target.value })} placeholder="Activity title" style={{ ...small, fontWeight: 700, flex: 1 }} />
                  <input type="number" step="0.25" min="0" value={r.hours == null ? "" : r.hours} onChange={e => setRow(r.key, { hours: e.target.value === "" ? null : parseFloat(e.target.value) })} placeholder="hrs" style={{ ...small, width: 72, textAlign: "right", fontVariantNumeric: "tabular-nums" }} />
                </div>
                {r.include && (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6, marginTop: 6 }}>
                      <input type="date" value={r.date} onChange={e => setRow(r.key, { date: e.target.value })} style={small} />
                      <input value={r.provider} onChange={e => setRow(r.key, { provider: e.target.value })} placeholder="Provider" style={small} />
                      <select value={r.category} onChange={e => setRow(r.key, { category: e.target.value, categoryAssumed: false })} style={{ ...small, appearance: "auto", borderColor: r.categoryAssumed ? T.warning : T.inputBorder }}>
                        <option value="">Credit type...</option>
                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        {r.category && !categories.includes(r.category) && <option value={r.category}>{r.category}</option>}
                      </select>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {(r.topics || []).map(t => (
                        <button key={t} type="button" onClick={() => setRow(r.key, { topics: r.topics.filter(x => x !== t) })} title="Remove topic" style={{ padding: "3px 8px", fontSize: 11, fontWeight: 600, borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff", cursor: "pointer" }}>{t} &times;</button>
                      ))}
                      <select value="" onChange={e => { const t = e.target.value; if (t && !(r.topics || []).includes(t)) setRow(r.key, { topics: [...(r.topics || []), t] }); }} style={{ ...small, width: "auto", fontSize: 11.5, padding: "3px 6px", appearance: "auto" }}>
                        <option value="">+ topic</option>
                        {CME_TOPICS.filter(t => !(r.topics || []).includes(t)).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input value={r.certificateNumber} onChange={e => setRow(r.key, { certificateNumber: e.target.value })} placeholder="Certificate #" style={{ ...small, width: 140, fontSize: 11.5, padding: "3px 8px", marginLeft: "auto" }} />
                    </div>
                  </>
                )}
                {(() => {
                  const missing = [!r.date && "no date", !r.title && "no title", r.hours == null && "no hours"].filter(Boolean);
                  if (!(r.duplicate || missing.length || (r.include && r.categoryAssumed) || r.notes)) return null;
                  return (
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {r.duplicate && badge("already in your log", T.warning, T.warningDim)}
                    {missing.map(w => <span key={w}>{badge(w, T.danger, T.dangerDim)}</span>)}
                    {r.include && r.categoryAssumed && badge("credit type assumed", T.warning, T.warningDim)}
                    {r.notes && <span style={{ fontSize: 11, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={r.notes}>{r.notes}</span>}
                  </div>
                  );
                })()}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { setStep(table ? "map" : "pick"); setError(""); }} style={secondaryBtn}>{table ? "Columns" : "Back"}</button>
            <button onClick={saveBatch} disabled={!included.length} style={{ ...primaryBtn(included.length > 0), flex: 1 }}>
              Add {included.length} to CME log{includedHours ? `, ${includedHours} hours` : ""}
            </button>
          </div>
        </>
      )}

      {/* ── done ── */}
      {step === "done" && done && (
        <>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.success, marginBottom: 6 }}>
            Added {done.count} CME entr{done.count === 1 ? "y" : "ies"} to your log.
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
            {done.skipped > 0 && `${done.skipped} unticked row${done.skipped === 1 ? " was" : "s were"} left out. `}
            Compliance bars and transcripts update now. Certificates can be linked to entries from the Documents tab.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={reset} style={{ ...secondaryBtn, flex: 1 }}>Import another</button>
            <button onClick={close} style={{ ...primaryBtn(), flex: 1 }}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default memo(CMEImport);
