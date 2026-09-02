import { useRef, useState, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { UploadIcon, CameraIcon, FileIcon, TrashIcon } from "../shared/Icons";
import { analyzeDocument, analyzePDF, analyzeDocText } from "../../utils/documentScanner";
import { useAiAvailable, describeAiStatus } from "../../utils/aiClient";
import { isOfficeFile, extractOfficeText, UPLOAD_ACCEPT } from "../../utils/officeText";
import { screenDocument, phiWarningText } from "../../utils/phiGuard";
import { mergeExtracted, findDuplicateDoc } from "../../utils/docPrefill";
import { docMime } from "../../utils/inboxDocs";
import { docAttachedLabel, fmtBytes, docBytes } from "../../utils/docLabel";

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
 * A file that is already in Files is never stored twice, but it is still
 * read so the form fills. It is staged with `existingId`, and the parent
 * links the stored copy on save (attachExistingDoc) instead of inserting
 * another row.
 *
 * Props:
 *  - setForm(fn): form state setter — extracted fields are merged in
 *  - attachedDocs / setAttachedDocs: pending files, saved+linked by the parent
 *  - analyzer / textAnalyzer: section-specific analyzers (default: classify)
 *  - existingDocs (optional): [{ doc, ready }] from Files the user may pick
 *    instead of uploading again; same analyzer, same fill, linked on save
 */
function DocAttach({ setForm, attachedDocs, setAttachedDocs, analyzer, textAnalyzer, existingDocs }) {
  const { data, theme: T } = useApp();
  const uploadRef = useRef(null);
  const cameraRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [isError, setIsError] = useState(false);
  const [showExisting, setShowExisting] = useState(false);

  // AI is on with the user's own key or the shared key (via ai-proxy). With
  // AI off a file still attaches; only the auto-fill is skipped.
  const aiOn = useAiAvailable(data.settings);

  // One analysis path for a fresh file and a stored document alike: pick the
  // analyzer by kind, then fill only the blanks in the form.
  // src: { name, type (MIME), dataUrl, file? }
  const readIntoForm = useCallback(async (src, note = "") => {
    const apiKey = data.settings.apiKey; // own key, or undefined for the shared key
    const deg = data.settings.degreeType;
    const mime = src.type || "";
    const office = isOfficeFile(src);
    if (!aiOn) {
      setIsError(false);
      setMsg(`"${src.name}" attached.${note} ${describeAiStatus(data.settings)}`);
      return;
    }
    if (!(mime.startsWith("image/") || mime === "application/pdf" || office)) {
      setIsError(false);
      setMsg(`"${src.name}" attached.${note}`);
      return;
    }
    setScanning(true);
    setMsg(null);
    setIsError(false);
    try {
      const result = office
        ? await (async () => {
            const text = await extractOfficeText(src);
            return textAnalyzer ? textAnalyzer(text, apiKey) : analyzeDocText(text, deg, apiKey);
          })()
        : analyzer
          ? await analyzer(src.dataUrl, apiKey)
          : mime === "application/pdf"
            ? await analyzePDF(src.dataUrl, deg, apiKey)
            : await analyzeDocument(src.dataUrl, deg, apiKey);
      const extracted = result?.extracted || result?.fields;
      if (extracted && typeof extracted === "object") {
        setForm((prev) => mergeExtracted(prev, extracted));
        setMsg(`Document read, fields auto-filled. Review before saving.${note}`);
      } else {
        setIsError(true);
        setMsg(`Attached, but no fields could be read from this document.${note}`);
      }
    } catch (err) {
      setIsError(true);
      setMsg(err.message || "Attached, but the document could not be read.");
    }
    setScanning(false);
  }, [aiOn, data.settings, setForm, analyzer, textAnalyzer]);

  const handleFiles = useCallback(async (files) => {
    for (const file of Array.from(files)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
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
      // Already in Files? Stage the stored copy for linking, never a second
      // upload. The read still happens: that is what the upload was for.
      const dup = findDuplicateDoc(data.documents, file, dataUrl);
      if (dup) {
        setAttachedDocs((prev) => prev.some((d) => d.existingId === dup.id)
          ? prev
          : [...prev, { name: dup.name || file.name, type: file.type, size: file.size, data: dataUrl, existingId: dup.id }]);
      } else {
        setAttachedDocs((prev) => [...prev, { name: file.name, type: file.type, size: file.size, data: dataUrl }]);
      }
      await readIntoForm(
        { name: file.name, type: file.type, dataUrl, file },
        dup ? " This file was already in Files, so it is linked here instead of uploaded again." : ""
      );
    }
  }, [data.documents, setAttachedDocs, readIntoForm]);

  // Pick a document that is already in Files: same read, same fill, and the
  // stored file is linked to this record on save.
  const pickExisting = useCallback(async ({ doc }) => {
    setShowExisting(false);
    if (!doc?.data) {
      setIsError(true);
      setMsg(`"${doc?.name || "That file"}" has not downloaded to this device yet. Give sync a moment and try again.`);
      return;
    }
    const mime = docMime(doc);
    setAttachedDocs((prev) => prev.some((d) => d.existingId === doc.id)
      ? prev
      : [...prev, { name: doc.name, type: mime, size: docBytes(doc), data: doc.data, existingId: doc.id }]);
    await readIntoForm({ name: doc.name, type: mime, dataUrl: doc.data }, " Linked from Files, nothing uploaded again.");
  }, [setAttachedDocs, readIntoForm]);

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
        {scanning ? "Reading document…" : "Upload or photograph and AI fills the form"}
      </div>
      {existingDocs && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowExisting((s) => !s)} disabled={scanning} style={{
            border: "none", backgroundColor: "transparent", padding: 0,
            color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>
            {showExisting ? "Hide documents in Files" : "Use a document already uploaded"}
          </button>
          {showExisting && (
            existingDocs.length === 0 ? (
              <div style={{ fontSize: 13, color: T.textDim, marginTop: 6 }}>
                No PDFs, photos, or Word files in Files yet. Upload the agreement above.
              </div>
            ) : (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {existingDocs.map(({ doc, ready }) => {
                  const sub = !ready
                    ? "Still downloading to this device"
                    : docAttachedLabel(doc, data)
                      || `${fmtBytes(docBytes(doc))}${doc.uploadedAt ? " · " + new Date(doc.uploadedAt).toLocaleDateString() : ""}`;
                  return (
                    <button key={doc.id} onClick={() => pickExisting({ doc })} disabled={!ready || scanning} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", textAlign: "left",
                      border: `1px solid ${T.border}`, borderRadius: 8, backgroundColor: T.card,
                      color: T.text, cursor: ready ? "pointer" : "default", opacity: ready ? 1 : 0.6,
                    }}>
                      <FileIcon />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
                        <span style={{ display: "block", fontSize: 12, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}
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
              {doc.existingId && <span style={{ fontSize: 11, color: T.textDim, flexShrink: 0 }}>in Files</span>}
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
