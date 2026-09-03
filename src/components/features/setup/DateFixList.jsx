import { useRef, useState, useCallback } from "react";
import { useApp } from "../../../context/AppContext";
import { CameraIcon } from "../../shared/Icons";
import { generateId } from "../../../utils/helpers";
import { dateless } from "../../../utils/setupTasks";
import { analyzeDocument, analyzePDF } from "../../../utils/documentScanner";
import { useAiAvailable, describeAiStatus } from "../../../utils/aiClient";
import { mergeExtracted, findDuplicateDoc, attachExistingDoc } from "../../../utils/docPrefill";
import { checkStorageQuota } from "../../../utils/storageQuota";

/**
 * The date strip: one row per license the app cannot warn about, with a
 * native date field and a camera button, in place. No modal, no navigation,
 * no returning to a list to choose the next one.
 *
 * This is also what the registry import drops the physician into: an import
 * creates dateless records, so the count going backwards has to be answered
 * in the same drawer that caused it.
 *
 * Photographing the card fills the expiration date, the issue date and the
 * number at once, and stores the photo linked to the record it proves, in
 * one action. With AI off the file still attaches and links; only the
 * auto-fill is skipped, so no row here can ever become uncompletable.
 *
 * Fields the scanner is allowed to touch are limited to the three printed on
 * the card. mergeExtracted fills blanks only, so nothing typed is ever
 * overwritten, and the record keeps the type and state it already has.
 */

const SCANNED_FIELDS = ["expirationDate", "issuedDate", "licenseNumber"];

/**
 * Why the camera works with nothing configured. Lives here so every surface
 * that renders a camera control says it the same way, and says it once,
 * directly under the first one on the screen.
 */
export const SHARED_KEY_NOTE = "Scanning runs on a shared key with no setup. Add your own free Gemini key in Settings to lift the daily limit.";

export function DateRow({ rec, onCaptured, onOpenRecord }) {
  const { data, editItem, addItem, theme: T } = useApp();
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState(false);
  const aiOn = useAiAvailable(data.settings);

  const label = [rec.state, rec.licenseNumber].filter(Boolean).join(" · ")
    || rec.name || rec.type || "License";

  const setDate = (value) => {
    editItem("licenses", { ...rec, expirationDate: value });
    if (value) onCaptured?.(rec);
  };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setBusy(true); setMsg(""); setErr(false);
    try {
      const quota = checkStorageQuota(data.documents, [file]);
      if (!quota.ok) {
        setErr(true);
        setMsg(`${quota.message} The run is paused here. Your finished records are saved.`);
        return;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = (e) => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });

      // Read the card first: that is what the photograph was for.
      let extracted = null;
      if (aiOn) {
        try {
          const result = file.type === "application/pdf"
            ? await analyzePDF(dataUrl, data.settings.degreeType, data.settings.apiKey)
            : await analyzeDocument(dataUrl, data.settings.degreeType, data.settings.apiKey);
          extracted = result?.extracted || null;
        } catch { /* the file still attaches; the fields are typed instead */ }
      }

      const picked = {};
      for (const k of SCANNED_FIELDS) if (extracted && extracted[k]) picked[k] = extracted[k];
      const merged = mergeExtracted(rec, picked);
      if (SCANNED_FIELDS.some((k) => merged[k] !== rec[k])) editItem("licenses", merged);

      // A file already in Files is linked, never stored a second time. A
      // duplicate that is already linked to a DIFFERENT record is left
      // alone, so the message below must not claim a link that never got
      // written.
      let linked = true;
      const dup = findDuplicateDoc(data.documents, file, dataUrl);
      const linkedTo = `licenses:${rec.id}`;
      if (dup) {
        const relink = attachExistingDoc(dup, linkedTo);
        if (relink) editItem("documents", relink);
        else linked = false;
      } else {
        addItem("documents", {
          id: generateId(), name: file.name, type: file.type, size: file.size,
          data: dataUrl, uploadedAt: new Date().toISOString(), linkedTo,
        });
      }

      if (merged.expirationDate) {
        setMsg(linked
          ? "Dated, and the copy is linked to this record."
          : "Dated. That file is already on file and linked to another record, so nothing was attached here.");
        onCaptured?.(merged);
      } else if (!aiOn) {
        setMsg(`Attached. ${describeAiStatus(data.settings)} Type the two fields and this row closes.`);
      } else {
        setMsg("Attached, but no date could be read from it. Type it and this row closes.");
      }
    } catch {
      setErr(true);
      setMsg("That file could not be read. Type the date instead.");
    } finally {
      setBusy(false);
    }
  }, [aiOn, data.documents, data.settings, rec, editItem, addItem, onCaptured]);

  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
          {rec.npiImported && (
            <div style={{ fontSize: 11.5, color: T.textDim }}>Imported from the registry, which does not carry dates.</div>
          )}
        </div>
        <input
          type="date"
          value={rec.expirationDate || ""}
          onChange={(e) => setDate(e.target.value)}
          aria-label={`Expiration date for ${label}`}
          style={{
            padding: "9px 10px", borderRadius: 10, border: `1px solid ${T.inputBorder}`,
            backgroundColor: T.input, color: T.text, fontSize: 16, outline: "none",
            width: 150, flexShrink: 0, boxSizing: "border-box",
          }}
        />
        <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handleFile(f); }} />
        <input type="file" ref={fileRef} accept="image/*,application/pdf" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handleFile(f); }} />
        <button
          onClick={() => cameraRef.current?.click()}
          disabled={busy}
          title="Photograph the card"
          aria-label={`Photograph the card for ${label}`}
          style={{
            width: 42, height: 42, borderRadius: 10, flexShrink: 0,
            border: `1px solid ${T.accent}`, backgroundColor: T.accentDim, color: T.accent,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        ><CameraIcon /></button>
      </div>
      {busy && <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>Reading the card...</div>}
      {msg && <div style={{ fontSize: 12.5, color: err ? T.danger : T.success, fontWeight: 600, marginTop: 4, lineHeight: 1.45 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 14, paddingTop: 4 }}>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
          border: "none", background: "transparent", padding: 0, color: T.textDim,
          fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>Choose a file instead</button>
        {onOpenRecord && (
          <button onClick={() => onOpenRecord(rec.id)} style={{
            border: "none", background: "transparent", padding: 0, color: T.textDim,
            fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>Open the full record {"\u203a"}</button>
        )}
      </div>
    </div>
  );
}

export default function DateFixList({ importedNote = null, onCaptured, onOpenRecord }) {
  const { data, theme: T } = useApp();
  const rows = dateless(data);

  if (!rows.length) {
    return <div style={{ fontSize: 13.5, color: T.textMuted }}>Every license on file carries a date. Nothing here can lapse unseen.</div>;
  }

  const fromRegistry = rows.filter((r) => r.npiImported === true).length;

  return (
    <div>
      {importedNote && (
        <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.5, marginBottom: 10 }}>
          <b>{importedNote.count} license{importedNote.count === 1 ? "" : "s"} imported{importedNote.states?.length ? `: ${importedNote.states.join(", ")}` : ""}.</b>{" "}
          The registry does not carry expiration dates, so those are the next {importedNote.count === 1 ? "tap" : `${importedNote.count} taps`}.
          {rows[0]?.state ? ` Start with ${rows[0].state}.` : ""}
        </div>
      )}
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
        {fromRegistry === rows.length ? "The registry gave you these. Finish them." : `${rows.length} to date`}
      </div>
      <div style={{ fontSize: 12, color: T.textDim, margin: "4px 0 2px", lineHeight: 1.5 }}>
        {SHARED_KEY_NOTE}
      </div>
      {rows.map((rec) => <DateRow key={rec.id} rec={rec} onCaptured={onCaptured} onOpenRecord={onOpenRecord} />)}
    </div>
  );
}
