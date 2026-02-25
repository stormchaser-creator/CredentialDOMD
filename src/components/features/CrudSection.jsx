import { useState, useRef, useEffect, memo, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, UploadIcon, CameraIcon } from "../shared/Icons";
import { generateId, getStatusColor, getStatusLabel } from "../../utils/helpers";
import { analyzeDocument, analyzePDF } from "../../utils/documentScanner";
import CPTCodePicker from "./CPTCodePicker";

function CrudSection({ title, sectionKey, items, fields, onAdd, onEdit, onDelete, onShare, renderExtra, emptyIcon, emptyTitle, emptySub, autoOpen, onAutoOpenDone }) {
  const { data, setData, theme: T } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [scanningDoc, setScanningDoc] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const [scanIsError, setScanIsError] = useState(false);
  const [modalCameraOpen, setModalCameraOpen] = useState(false);
  const uploadRef = useRef(null);
  const modalCameraRef = useRef(null);
  const modalVideoRef = useRef(null);
  const modalCanvasRef = useRef(null);
  const modalStreamRef = useRef(null);

  const openAdd = useCallback(() => { setForm({}); setEditItem(null); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item }); setEditItem(item); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false); setShowForm(true); }, []);

  // Auto-open add form when triggered from outside (e.g., home page "Add Your License" card)
  useEffect(() => {
    if (autoOpen) {
      openAdd();
      onAutoOpenDone?.();
    }
  }, [autoOpen, openAdd, onAutoOpenDone]);
  const closeForm = useCallback(() => {
    if (modalStreamRef.current) { modalStreamRef.current.getTracks().forEach(t => t.stop()); modalStreamRef.current = null; }
    setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false);
  }, []);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (modalStreamRef.current) { modalStreamRef.current.getTracks().forEach(t => t.stop()); modalStreamRef.current = null; }
    };
  }, []);

  const openModalCamera = useCallback(async () => {
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
      modalCameraRef.current?.click();
      return;
    }
    setModalCameraOpen(true);
    try {
      if (modalStreamRef.current) {
        modalStreamRef.current.getTracks().forEach(t => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      modalStreamRef.current = stream;
      if (modalVideoRef.current) {
        modalVideoRef.current.srcObject = stream;
        modalVideoRef.current.play();
      }
    } catch {
      setScanMsg("Could not access camera. Check browser permissions.");
      setScanIsError(true);
      setModalCameraOpen(false);
    }
  }, []);

  const closeModalCamera = useCallback(() => {
    if (modalStreamRef.current) { modalStreamRef.current.getTracks().forEach(t => t.stop()); modalStreamRef.current = null; }
    setModalCameraOpen(false);
  }, []);

  const handleUpload = useCallback(async (files) => {
    const apiKey = data.settings.apiKey;
    const deg = data.settings.degreeType;

    for (const file of Array.from(files)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setAttachedDocs(prev => [...prev, { name: file.name, type: file.type, size: file.size, data: dataUrl }]);

      // Run AI scan to auto-fill form fields
      if (apiKey && (file.type.startsWith("image/") || file.type === "application/pdf")) {
        setScanningDoc(true);
        setScanMsg(null);
        try {
          const result = file.type === "application/pdf"
            ? await analyzePDF(dataUrl, deg, apiKey)
            : await analyzeDocument(dataUrl, deg, apiKey);

          const extracted = result?.extracted || result?.fields;
          if (extracted && typeof extracted === "object") {
            // Auto-fill form with extracted fields (don't overwrite existing values)
            setForm(prev => {
              const merged = { ...prev };
              for (const [key, value] of Object.entries(extracted)) {
                if (value != null && value !== "" && !merged[key]) {
                  // Handle arrays (like topics) properly
                  merged[key] = Array.isArray(value) ? value : String(value);
                }
              }
              return merged;
            });
            const fieldCount = Object.keys(extracted).filter(k => extracted[k] != null && extracted[k] !== "").length;
            setScanMsg(`${fieldCount} field${fieldCount !== 1 ? "s" : ""} extracted and auto-filled.`);
            setScanIsError(false);
          } else {
            setScanMsg("Document scanned but no fields could be extracted.");
            setScanIsError(true);
          }
        } catch (err) {
          setScanMsg("Could not extract fields: " + (err.message || "Analysis failed"));
          setScanIsError(true);
        }
        setScanningDoc(false);
      }
    }
  }, [data.settings.apiKey, data.settings.degreeType]);

  const captureModalPhoto = useCallback(() => {
    const video = modalVideoRef.current;
    const canvas = modalCanvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    closeModalCamera();
    const byteStr = atob(dataUrl.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/jpeg" });
    const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
    handleUpload([file]);
  }, [closeModalCamera, handleUpload]);

  const handleSave = useCallback(() => {
    const itemId = editItem ? editItem.id : generateId();
    if (editItem) onEdit({ ...editItem, ...form });
    else onAdd({ ...form, id: itemId });

    // Save attached documents and link them
    if (attachedDocs.length > 0) {
      setData(d => ({
        ...d,
        documents: [
          ...d.documents,
          ...attachedDocs.map(doc => ({
            id: generateId(),
            name: doc.name,
            type: doc.type,
            size: doc.size,
            data: doc.data,
            uploadedAt: new Date().toISOString(),
            linkedTo: `${sectionKey}:${itemId}`,
          })),
        ],
      }));
    }
    closeForm();
  }, [editItem, form, onEdit, onAdd, closeForm, attachedDocs, sectionKey, setData]);

  const setField = useCallback((key, value) => {
    setForm(p => ({ ...p, [key]: value }));
  }, []);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>{title}</h2>
        <button onClick={openAdd} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px",
          borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}>
          <PlusIcon /> Add
        </button>
      </div>

      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit" : "Add"}>
        {fields.map(f => (
          <Field key={f.key} label={f.label}>
            {f.type === "select" ? (
              <select
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                style={{ ...iS, appearance: "auto" }}
              >
                <option value="">Select...</option>
                {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "datalist" ? (
              <>
                <input
                  list={`dl-${f.key}`}
                  value={form[f.key] || ""}
                  onChange={e => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  style={iS}
                />
                <datalist id={`dl-${f.key}`}>
                  {(f.options || []).map(o => <option key={o} value={o} />)}
                </datalist>
              </>
            ) : f.type === "cptPicker" ? (
              <CPTCodePicker
                value={form[f.key] || ""}
                onChange={val => setField(f.key, val)}
              />
            ) : f.type === "textarea" ? (
              <textarea
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                style={{ ...iS, minHeight: 60, resize: "vertical" }}
              />
            ) : (
              <input
                type={f.type || "text"}
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                style={iS}
              />
            )}
          </Field>
        ))}
        {/* Upload / Camera document */}
        <div style={{ marginTop: 14, padding: "14px", borderRadius: 12, border: `1px dashed ${T.border}`, backgroundColor: T.input }}>
          <input type="file" ref={uploadRef} multiple accept="image/*,.pdf,.doc,.docx" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleUpload(e.target.files); e.target.value = ""; }} />
          <input type="file" ref={modalCameraRef} accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleUpload(e.target.files); e.target.value = ""; }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => uploadRef.current?.click()} style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
              borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
              cursor: "pointer", backgroundColor: T.accent, color: "#fff",
            }}>
              <UploadIcon /> Upload
            </button>
            <button onClick={openModalCamera} style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
              borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
              cursor: "pointer", backgroundColor: T.accent, color: "#fff",
            }}>
              <CameraIcon /> Camera
            </button>
          </div>
          {/* Webcam viewfinder inside modal */}
          {modalCameraOpen && (
            <div style={{ marginTop: 8, borderRadius: 10, overflow: "hidden", border: `2px solid ${T.accent}`, position: "relative", backgroundColor: "#000" }}>
              <video ref={modalVideoRef} autoPlay playsInline muted style={{ width: "100%", display: "block", borderRadius: 8 }} />
              <canvas ref={modalCanvasRef} style={{ display: "none" }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "10px", display: "flex", justifyContent: "center", gap: 10, background: "linear-gradient(transparent, rgba(0,0,0,0.7))" }}>
                <button onClick={closeModalCamera} style={{ padding: "8px 18px", borderRadius: 20, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", backgroundColor: "rgba(255,255,255,0.2)", color: "#fff" }}>Cancel</button>
                <button onClick={captureModalPhoto} style={{ padding: "8px 22px", borderRadius: 20, border: "2px solid #fff", fontSize: 13, fontWeight: 700, cursor: "pointer", backgroundColor: T.accent, color: "#fff" }}>Take Photo</button>
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: T.textDim, marginTop: 8 }}>
            {scanningDoc ? "Analyzing document and extracting fields..." : "Upload or photograph — AI will auto-fill the form"}
          </div>
          {scanningDoc && (
            <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, backgroundColor: T.accentGlow || "rgba(59,130,246,0.1)", border: `1px solid ${T.accent}`, fontSize: 14, color: T.accent, fontWeight: 600, textAlign: "center" }}>
              Scanning document...
            </div>
          )}
          {scanMsg && !scanningDoc && (
            <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 10, backgroundColor: scanIsError ? T.warningDim : (T.successDim || "rgba(34,197,94,0.1)"), fontSize: 13, fontWeight: 600, color: scanIsError ? T.warning : (T.success || "#22c55e") }}>
              {scanMsg}
            </div>
          )}
          {attachedDocs.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {attachedDocs.map((doc, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, backgroundColor: T.card, border: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 14 }}>{doc.type?.includes("pdf") ? "\ud83d\udcd5" : "\ud83d\uddbc"}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
                    <span style={{ fontSize: 10, color: T.textDim, flexShrink: 0 }}>{(doc.size / 1024).toFixed(0)} KB</span>
                  </div>
                  <button onClick={() => setAttachedDocs(prev => prev.filter((_, j) => j !== i))} style={{ padding: "2px 6px", borderRadius: 4, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{
            padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer",
          }}>Cancel</button>
          <button onClick={handleSave} disabled={scanningDoc} style={{
            padding: "12px 18px", borderRadius: 10, border: "none",
            backgroundColor: scanningDoc ? T.border : T.accent, color: scanningDoc ? T.textDim : "#fff", fontSize: 15, fontWeight: 600, cursor: scanningDoc ? "not-allowed" : "pointer",
          }}>{scanningDoc ? "Scanning..." : editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {items.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} subtitle={emptySub} onAction={openAdd} actionLabel="Add" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(item => {
            const color = getStatusColor(item.expirationDate);
            const needsReview = item.npiImported && !item.expirationDate;
            return (
              <div key={item.id} style={{
                backgroundColor: T.card, border: `1px solid ${needsReview ? T.danger : T.border}`,
                borderRadius: 14, padding: "14px 16px",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                boxShadow: T.shadow1,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                  {needsReview ? <StatusDot color="red" /> : item.expirationDate ? <StatusDot color={color} /> : null}
                  <div style={{ minWidth: 0 }}>
                    {item.type && (
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 1 }}>
                        {item.type}
                      </div>
                    )}
                    <div style={{
                      fontSize: 15, fontWeight: 600, color: T.text,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {item.name || item.title || item.category || item.type || "Untitled"}
                    </div>
                    <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                      {[item.state, item.facility, item.provider, item.institution, item.licenseNumber, item.policyNumber].filter(Boolean).join(" \u00b7 ")}
                      {item.graduationDate && !item.expirationDate && (" \u00b7 Graduated " + new Date(item.graduationDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }))}
                      {item.expirationDate && (" \u00b7 " + getStatusLabel(item.expirationDate))}
                    </div>
                    {needsReview && (
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.danger, marginTop: 3 }}>
                        Needs review — tap edit to add expiration date, issued date, and verify details
                      </div>
                    )}
                    {renderExtra?.(item)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                  <button onClick={() => onShare(item, sectionKey)} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
                  <button onClick={() => openEdit(item)} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                  <button onClick={() => { if (window.confirm("Delete this item? This cannot be undone.")) onDelete(item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(CrudSection);
