import { useRef, useState, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { UploadIcon, CameraIcon, FileIcon, TrashIcon } from "../shared/Icons";
import { analyzeDocument, analyzePDF, analyzeDocText } from "../../utils/documentScanner";
import { isOfficeFile, extractOfficeText, UPLOAD_ACCEPT } from "../../utils/officeText";
import { screenDocument, phiWarningText } from "../../utils/phiGuard";

/**
 * DocAttach — the ONE way to attach + scan documents from inside any
 * credential form. Upload or photograph a document; the AI reads it,
 * auto-fills the surrounding form (never overwriting fields the user
 * already typed), and the file is linked to the credential on save.
 *
 * Used by CrudSection-style forms and HealthRecordsSection alike so every
 * section behaves identically. The Files tab remains the "classify
 * anything" entry point (upload there → AI decides which section it is).
 *
 * Props:
 *  - setForm(fn): form state setter — extracted fields are merged in
 *  - attachedDocs / setAttachedDocs: pending files, saved+linked by the parent
 */
function DocAttach({ setForm, attachedDocs, setAttachedDocs, analyzer, textAnalyzer }) {
  const { data, theme: T } = useApp();
  const uploadRef = useRef(null);
  const cameraRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [isError, setIsError] = useState(false);

  const requireApiKey = useCallback(() => {
    if (data.settings.apiKey) return true;
    setIsError(true);
    setMsg("Add your AI key first (Settings → API key) so documents can be read and auto-filled.");
    return false;
  }, [data.settings.apiKey]);

  const handleFiles = useCallback(async (files) => {
    const apiKey = data.settings.apiKey;
    const deg = data.settings.degreeType;

    for (const file of Array.from(files)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const dup = (data.documents || []).find(d =>
        (d.data && d.data.length === dataUrl.length && d.data === dataUrl) ||
        (d.name === file.name && d.size === file.size)
      );
      if (dup) {
        setIsError(true);
        setMsg(`"${file.name}" is already uploaded${dup.linkedTo ? " and linked to a credential" : ""}. Skipped duplicate.`);
        continue;
      }
      // A patient chart attached to a credential is still a patient chart —
      // screen anything readable before it is staged for upload.
      if (isOfficeFile(file)) {
        try {
          const preview = await extractOfficeText({ name: file.name, type: file.type, file });
          const screen = screenDocument(`${file.name}\n${preview}`);
          if (screen?.level === "clinical") {
            setIsError(true);
            setMsg(`"${file.name}" was not attached. ${phiWarningText(screen)}`);
            continue;
          }
        } catch { /* unreadable — normal path reports it */ }
      }
      setAttachedDocs((prev) => [...prev, { name: file.name, type: file.type, size: file.size, data: dataUrl }]);

      // No AI key? The file is attached and linked all the same; only the
      // auto-fill is skipped.
      if (!apiKey) {
        setIsError(false);
        setMsg(`"${file.name}" attached. Add an AI key in Settings to have it read automatically.`);
        continue;
      }
      if (file.type.startsWith("image/") || file.type === "application/pdf" || isOfficeFile(file)) {
        setScanning(true);
        setMsg(null);
        setIsError(false);
        try {
          const result = isOfficeFile(file)
            ? await (async () => {
                const text = await extractOfficeText({ name: file.name, type: file.type, file });
                return textAnalyzer ? textAnalyzer(text, apiKey) : analyzeDocText(text, deg, apiKey);
              })()
            : analyzer
              ? await analyzer(dataUrl, apiKey)
              : file.type === "application/pdf"
                ? await analyzePDF(dataUrl, deg, apiKey)
                : await analyzeDocument(dataUrl, deg, apiKey);
          const extracted = result?.extracted || result?.fields;
          if (extracted && typeof extracted === "object") {
            setForm((prev) => {
              const merged = { ...prev };
              for (const [k, v] of Object.entries(extracted)) {
                if (v != null && v !== "" && (merged[k] == null || merged[k] === "")) merged[k] = v;
              }
              return merged;
            });
            setMsg("Document read — fields auto-filled. Review before saving.");
          } else {
            setIsError(true);
            setMsg("Attached, but no fields could be read from this document.");
          }
        } catch (err) {
          setIsError(true);
          setMsg(err.message || "Attached, but the document could not be read.");
        }
        setScanning(false);
      }
    }
  }, [data.settings.apiKey, data.settings.degreeType, data.documents, requireApiKey, setAttachedDocs, setForm, analyzer, textAnalyzer]);

  return (
    <div style={{ marginTop: 14, padding: 14, borderRadius: 12, border: `1px dashed ${T.border}`, backgroundColor: T.input }}>
      <input type="file" ref={uploadRef} multiple accept={UPLOAD_ACCEPT} style={{ display: "none" }}
        onChange={(e) => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
      <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => uploadRef.current?.click()} style={{
          display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
          borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}><UploadIcon /> Upload</button>
        <button onClick={() => cameraRef.current?.click()} style={{
          display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
          borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}><CameraIcon /> Camera</button>
      </div>
      <div style={{ fontSize: 13, color: T.textDim, marginTop: 8 }}>
        {scanning ? "Reading document…" : "Upload or photograph — AI will auto-fill the form"}
      </div>
      {msg && (
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, color: isError ? T.danger : T.success }}>{msg}</div>
      )}
      {attachedDocs.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {attachedDocs.map((doc, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
              border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, color: T.text,
            }}>
              <FileIcon />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
              <button onClick={() => setAttachedDocs((prev) => prev.filter((_, j) => j !== i))} style={{
                border: "none", backgroundColor: "transparent", color: T.danger, cursor: "pointer", display: "flex", padding: 2,
              }}><TrashIcon /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(DocAttach);
