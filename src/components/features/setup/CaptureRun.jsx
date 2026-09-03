import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import { CameraIcon } from "../../shared/Icons";
import { generateId } from "../../../utils/helpers";
import { analyzeDocument, analyzePDF } from "../../../utils/documentScanner";
import { useAiAvailable, describeAiStatus } from "../../../utils/aiClient";
import { mergeExtracted, findDuplicateDoc, attachExistingDoc } from "../../../utils/docPrefill";
import { checkStorageQuota } from "../../../utils/storageQuota";
import { screenDocument, phiWarningText } from "../../../utils/phiGuard";
import { SHARED_KEY_NOTE } from "./DateFixList";

/**
 * The run: one record at a time, photographed, read, saved, and the next one
 * already on screen. Eight licenses is eight taps, not eight trips back to a
 * list to choose which one to do next.
 *
 * Three rules hold the whole thing together:
 *
 *  1. The record and the document it proves are written together, with the
 *     exact linkedTo the rest of the app uses, so the proof dot lights in the
 *     same tick the record closes.
 *  2. Nothing here is ever uncompletable because of AI state. With scanning
 *     off, or the shared daily cap reached, the file still attaches and links
 *     and the fields are typed instead. describeAiStatus says why, in the
 *     words Settings already uses.
 *  3. A failure pauses in place. The storage guard, an unreadable file and a
 *     stopped run all keep the position and keep the finished records; the
 *     queue is never dropped and the work already done is never lost.
 *
 * It composes the existing writers (editItem, addItem) and the existing read
 * chain. It never writes a record field on its own.
 */

const SCAN_FIELDS = {
  licenses: ["expirationDate", "issuedDate", "licenseNumber"],
  privileges: ["expirationDate"],
  insurance: ["expirationDate"],
  travelDocs: ["expirationDate", "number"],
  // A diploma and a residency certificate do not expire. The run asks for
  // the copy and writes nothing onto the record.
  education: [],
};
const fieldsFor = (sec) => SCAN_FIELDS[sec] || ["expirationDate"];

const FIELD_LABEL = {
  expirationDate: "Expires",
  issuedDate: "Issued",
  licenseNumber: "Number",
  number: "Number",
};

/** What this record is called on screen, in the physician's own words first. */
function recordLabel(rec, sec) {
  if (!rec) return "";
  if (sec === "licenses") {
    const parts = [rec.state, rec.licenseNumber].filter(Boolean).join(" · ");
    return parts || rec.name || rec.type || "License";
  }
  return rec.name || rec.facility || rec.hospital || rec.type || "Record";
}

/** The short name used mid-sentence: "California is ready. Next: Nevada." */
const shortName = (rec, sec) => (sec === "licenses" && rec?.state) || rec?.name || rec?.facility || recordLabel(rec, sec);

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = (e) => resolve(e.target.result);
  r.onerror = reject;
  r.readAsDataURL(file);
});

export default function CaptureRun({
  section = "licenses",
  records = [],
  fields: fieldsProp,
  intro,
  startLabel,
  onExit,
}) {
  const { data, editItem, addItem, theme: T } = useApp();
  // The queue is frozen at the moment the run mounts. evidenceQueue is
  // recomputed by the drawer on every render and a saved record leaves it
  // immediately, so reading the live array by an incrementing index would
  // shift the remaining records out from under the run and finish early.
  const [run] = useState(() => (records || []).filter(Boolean));
  const aiOn = useAiAvailable(data.settings);
  const cameraRef = useRef(null);
  const fileRef = useRef(null);

  const [stage, setStage] = useState("intro"); // intro | pick | reading | confirm | saved | paused | done
  const [idx, setIdx] = useState(0);
  const [draft, setDraft] = useState(null);
  const [staged, setStaged] = useState(null); // { file, dataUrl } waiting to be written
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");

  const fields = fieldsProp || fieldsFor(section);
  const rec = run[idx] || null;
  const nextRec = run[idx + 1] || null;

  const advance = useCallback(() => {
    setDraft(null); setStaged(null); setNote(""); setProblem("");
    setIdx((i) => {
      const n = i + 1;
      setStage(n >= run.length ? "done" : "pick");
      return n;
    });
  }, [run.length]);

  // Auto-advance: the tick is shown, then the next record is already on
  // screen. Leaving the run mid-tick cancels the timer, never the work.
  useEffect(() => {
    if (stage !== "saved") return undefined;
    const t = setTimeout(advance, 1100);
    return () => clearTimeout(t);
  }, [stage, advance]);

  const handleFile = useCallback(async (file) => {
    if (!file || !rec) return;
    setProblem(""); setNote(""); setStage("reading");
    try {
      // The guard runs before anything is read, and a refusal pauses the run
      // at this record rather than dropping the queue.
      const quota = checkStorageQuota(data.documents, [file]);
      if (!quota.ok) {
        setProblem(`${quota.message} The run is paused here. Your finished records are saved.`);
        setStage("paused");
        return;
      }
      const dataUrl = await readAsDataUrl(file);

      let extracted = null;
      let read = null;
      if (aiOn) {
        try {
          read = file.type === "application/pdf"
            ? await analyzePDF(dataUrl, data.settings.degreeType, data.settings.apiKey)
            : await analyzeDocument(dataUrl, data.settings.degreeType, data.settings.apiKey);
          extracted = read?.extracted || null;
        } catch { /* the file still attaches; the fields are typed instead */ }
      }

      // Nothing is written until save(), so a chart caught here never reaches
      // the bucket at all. Same screen and same words the Files upload uses.
      const screen = screenDocument(read ? `${file.name}\n${JSON.stringify(read)}` : file.name);
      if (screen?.level === "clinical") {
        setProblem(`${phiWarningText(screen)} The run is paused here. Your finished records are saved.`);
        setStage("paused");
        return;
      }

      const picked = {};
      for (const k of fields) if (extracted && extracted[k]) picked[k] = extracted[k];
      // mergeExtracted fills blanks only, so nothing already on the record is
      // overwritten by what the camera thought it saw.
      setDraft(mergeExtracted(rec, picked));
      setStaged({ file, dataUrl });
      // A "maybe" hit is advisory: it rides above the confirm card rather than
      // stopping a run over one stray phrase on a real certificate.
      const advisory = screen ? phiWarningText(screen) : "";
      const readNote = !fields.length || Object.keys(picked).length
        ? ""
        : aiOn
          ? "Nothing could be read off that one. Type what it says and it still saves with the copy attached."
          : `${describeAiStatus(data.settings)} Attached. Type the fields and this record closes.`;
      setNote([advisory, readNote].filter(Boolean).join(" "));
      setStage("confirm");
    } catch {
      setProblem("That file could not be read. Choose another, or skip this one.");
      setStage("paused");
    }
  }, [rec, aiOn, data.documents, data.settings, fields]);

  const save = useCallback(() => {
    if (!rec || !draft) return;
    if (fields.some((k) => draft[k] !== rec[k])) editItem(section, draft);

    let attached = true;
    if (staged) {
      const linkedTo = `${section}:${rec.id}`;
      // A file already in Files is linked, never stored twice. One already
      // linked to a different record is left where it is, so the message
      // below must not claim an attachment that was never written.
      const dup = findDuplicateDoc(data.documents, staged.file, staged.dataUrl);
      if (dup) {
        const relink = attachExistingDoc(dup, linkedTo);
        if (relink) editItem("documents", relink);
        else attached = false;
      } else {
        addItem("documents", {
          id: generateId(),
          name: staged.file.name,
          type: staged.file.type,
          size: staged.file.size,
          data: staged.dataUrl,
          uploadedAt: new Date().toISOString(),
          linkedTo,
        });
      }
    }

    const done = shortName(rec, section);
    setNote(
      attached
        ? nextRec ? `${done} is ready. Next: ${shortName(nextRec, section)}.` : `${done} is ready.`
        : "That file is already on file and linked to another record, so nothing was attached here."
    );
    setStage("saved");
  }, [rec, draft, staged, section, fields, editItem, addItem, data.documents, nextRec]);

  /* ─── Chrome ─────────────────────────────────────────────────── */

  const btn = (label, onClick, kind = "ghost", extra = {}) => {
    const primary = kind === "primary";
    return (
      <button onClick={onClick} style={{
        padding: primary ? "12px 16px" : "10px 14px",
        borderRadius: 12,
        border: primary ? "none" : `1px solid ${T.border}`,
        backgroundColor: primary ? T.accent : "transparent",
        color: primary ? "#fff" : T.textMuted,
        fontSize: primary ? 15 : 13.5, fontWeight: primary ? 800 : 700,
        cursor: "pointer", fontFamily: "inherit", ...extra,
      }}>{label}</button>
    );
  };

  const stopRow = (
    <div style={{ display: "flex", gap: 14, marginTop: 12 }}>
      <button onClick={advance} style={{
        border: "none", background: "transparent", padding: 0, color: T.textDim,
        fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit",
      }}>Skip this one</button>
      <button onClick={() => onExit?.()} style={{
        border: "none", background: "transparent", padding: 0, color: T.textDim,
        fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit",
      }}>Stop the run</button>
    </div>
  );

  const pickers = (
    <>
      <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handleFile(f); }} />
      <input type="file" ref={fileRef} accept="image/*,application/pdf" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handleFile(f); }} />
    </>
  );

  const progress = run.length > 1 ? (
    <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, fontVariantNumeric: "tabular-nums", marginBottom: 4 }}>
      {Math.min(idx + 1, run.length)} of {run.length}
    </div>
  ) : null;

  if (!run.length) {
    return <div style={{ fontSize: 13.5, color: T.textMuted }}>Every record here already has its copy attached.</div>;
  }

  if (stage === "intro") {
    const first = shortName(run[0], section);
    return (
      <div>
        <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.55, marginBottom: 10 }}>{intro}</div>
        <div style={{ fontSize: 12, color: T.textDim, lineHeight: 1.5, marginBottom: 12 }}>{SHARED_KEY_NOTE}</div>
        {btn(startLabel || (first ? `Start with ${first}` : "Start the run"), () => setStage("pick"), "primary", { width: "100%" })}
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div>
        <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.55, marginBottom: 12 }}>
          The run is finished. Anything you skipped is still on the list.
        </div>
        {btn("Back to the list", () => onExit?.(), "primary", { width: "100%" })}
      </div>
    );
  }

  return (
    <div>
      {pickers}
      {progress}
      <div style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 2 }}>{recordLabel(rec, section)}</div>

      {stage === "pick" && (
        <div>
          <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
            {fields.length
              ? "Photograph it and the app reads the dates and the number off the page."
              : "Photograph it and the copy attaches to this record."}
          </div>
          <button onClick={() => cameraRef.current?.click()} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            width: "100%", padding: "13px 16px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800,
            cursor: "pointer", fontFamily: "inherit",
          }}><CameraIcon /> Photograph the card</button>
          <button onClick={() => fileRef.current?.click()} style={{
            marginTop: 8, width: "100%", padding: "11px 16px", borderRadius: 12,
            border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>Choose a file instead</button>
          {stopRow}
        </div>
      )}

      {stage === "reading" && (
        <div style={{ fontSize: 13.5, color: T.textMuted, padding: "14px 0" }}>Reading the card...</div>
      )}

      {stage === "confirm" && draft && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginTop: 8, marginBottom: 6 }}>
            {fields.length ? "What it read" : "Ready to attach"}
          </div>
          {!fields.length && (
            <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
              This record takes no date. Saving files the copy against it.
            </div>
          )}
          {fields.map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <div style={{ width: 76, flexShrink: 0, fontSize: 12.5, color: T.textMuted, fontWeight: 700 }}>{FIELD_LABEL[k] || k}</div>
              <input
                type={/date/i.test(k) ? "date" : "text"}
                value={draft[k] || ""}
                onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                aria-label={`${FIELD_LABEL[k] || k} for ${recordLabel(rec, section)}`}
                style={{
                  flex: 1, minWidth: 0, padding: "9px 10px", borderRadius: 10,
                  border: `1px solid ${T.inputBorder}`, backgroundColor: T.input,
                  color: T.text, fontSize: 16, outline: "none", boxSizing: "border-box",
                }}
              />
            </div>
          ))}
          {note && <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginTop: 6 }}>{note}</div>}
          <div style={{ marginTop: 12 }}>
            {btn(nextRec ? "Save and next" : "Save", save, "primary", { width: "100%" })}
          </div>
          {stopRow}
        </div>
      )}

      {stage === "saved" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
            <span style={{
              width: 20, height: 20, borderRadius: 10, backgroundColor: T.accent, color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800,
            }}>{"✓"}</span>
            <span style={{ fontSize: 13.5, color: T.text, fontWeight: 700 }}>{note}</span>
          </div>
          {btn(nextRec ? "Next" : "Finish", advance)}
        </div>
      )}

      {stage === "paused" && (
        <div>
          <div style={{ fontSize: 13, color: T.danger, lineHeight: 1.5, margin: "8px 0 12px", fontWeight: 600 }}>{problem}</div>
          {btn("Try another file", () => { setProblem(""); setStage("pick"); }, "primary", { width: "100%" })}
          {stopRow}
        </div>
      )}
    </div>
  );
}
