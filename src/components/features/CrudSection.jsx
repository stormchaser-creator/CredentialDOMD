import { useState, useRef, useEffect, memo, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, UploadIcon, CameraIcon } from "../shared/Icons";
import { generateId, getStatusColor, getStatusLabel, describeItem } from "../../utils/helpers";
import { analyzeDocument, analyzePDF } from "../../utils/documentScanner";
import CPTCodePicker from "./CPTCodePicker";

function CrudSection({ title, sectionKey, items, fields, onAdd, onEdit, onDelete, onShare, renderExtra, emptyIcon, emptyTitle, emptySub, autoOpen, onAutoOpenDone, autoEditId, onAutoEditDone }) {
  const { data, setData, addItem, theme: T } = useApp();
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
  // Deep-link: open a specific record's edit form (e.g. from the Home
  // missing-expiration card).
  useEffect(() => {
    if (!autoEditId) return;
    const it = items.find(x => x.id === autoEditId);
    if (it) {
      openEdit(it);
      onAutoEditDone?.();
    }
  }, [autoEditId, items, openEdit, onAutoEditDone]);

  useEffect(() => {
    if (autoOpen) {
      openAdd();
      onAutoOpenDone?.();
    }
  }, [autoOpen, openAdd, onAutoOpenDone]);
  const closeForm = useCallback(() => {
    setRequiredError(null);
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

  const requireApiKey = useCallback(() => {
    if (data.settings.apiKey) return true;
    setScanIsError(true);
    setScanMsg("Add your AI key first (Settings \u2192 API key) so documents can be read and auto-filled.");
    return false;
  }, [data.settings.apiKey]);

  const handleUpload = useCallback(async (files) => {
    const apiKey = data.settings.apiKey;
    const deg = data.settings.degreeType;
    if (!apiKey) { requireApiKey(); return; }

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

  const [requiredError, setRequiredError] = useState(null);

  // Tap-anywhere detail view + full-screen picture viewer
  const [viewItem, setViewItem] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  // Escape must close the lightbox, not the modal underneath it — capture
  // phase so this runs before Modal's own document-level Escape handler
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [lightbox]);

  const linkedDocs = useCallback(
    (item) => (data.documents || []).filter(d => d.linkedTo === `${sectionKey}:${item.id}`),
    [data.documents, sectionKey]
  );

  // Data URLs don't open directly in iOS Safari — convert to a blob URL
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: doc.type || "application/pdf" }));
    window.open(url, "_blank");
  }, []);

  const handleSave = useCallback(() => {
    // The whole point is knowing when things expire — expiring record
    // types can't be saved without their dates.
    const missing = fields.filter(f => f.required && !form[f.key]);
    if (missing.length > 0) {
      setRequiredError(`Required: ${missing.map(f => f.label).join(", ")}. Expiration dates are how the app warns you before anything lapses.`);
      return;
    }
    setRequiredError(null);
    const itemId = editItem ? editItem.id : generateId();
    if (editItem) onEdit({ ...editItem, ...form });
    else onAdd({ ...form, id: itemId });

    // Save attached documents and link them — addItem syncs each to cloud
    for (const doc of attachedDocs) {
      addItem("documents", {
        id: generateId(),
        name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(),
        linkedTo: `${sectionKey}:${itemId}`,
      });
    }
    closeForm();
  }, [editItem, form, onEdit, onAdd, closeForm, attachedDocs, sectionKey, addItem, fields]);

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
          <Field key={f.key} label={f.label + (f.required ? " *" : "")}>
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
            <button onClick={() => requireApiKey() && uploadRef.current?.click()} style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
              borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
              cursor: "pointer", backgroundColor: T.accent, color: "#fff",
            }}>
              <UploadIcon /> Upload
            </button>
            <button onClick={() => requireApiKey() && openModalCamera()} style={{
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
          {/* Documents already linked to this record — tap to view */}
          {editItem && linkedDocs(editItem).length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {linkedDocs(editItem).map(doc => (
                <div key={doc.id}
                  onClick={() => { if (!doc.data) return; if (doc.type?.startsWith("image/")) setLightbox(doc); else openPdfDoc(doc); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, backgroundColor: T.card, border: `1px solid ${T.border}`, cursor: doc.data ? "pointer" : "default" }}>
                  {doc.type?.startsWith("image/") && doc.data
                    ? <img src={doc.data} alt={doc.name} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
                    : <span style={{ fontSize: 20 }}>{doc.data ? "📕" : "⏳"}</span>}
                  <span style={{ fontSize: 12, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
                  <span style={{ fontSize: 11, color: T.textDim, marginLeft: "auto", flexShrink: 0 }}>{doc.data ? "attached" : "syncing…"}</span>
                </div>
              ))}
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
        {requiredError && (
          <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{requiredError}</div>
        )}

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

      {/* Read-only detail view — opened by tapping anywhere on a card */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} title={viewItem ? describeItem(viewItem, data.settings.name) : "Details"}>
        {viewItem && (
          <>
            {fields.filter(f => viewItem[f.key]).map(f => (
              <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{f.label}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {(() => {
                    const v = viewItem[f.key];
                    if (f.type !== "date") return String(v);
                    const d = new Date(v + "T00:00:00");
                    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  })()}
                </span>
              </div>
            ))}
            {linkedDocs(viewItem).length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>Documents</div>
                {linkedDocs(viewItem).map(doc => (
                  !doc.data ? (
                    <div key={doc.id} style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 12px",
                      borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: T.input,
                      color: T.textMuted, fontSize: 13, fontWeight: 600, marginBottom: 8,
                    }}>
                      <span style={{ fontSize: 16 }}>{"⏳"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name} — downloading from cloud, check back shortly</span>
                    </div>
                  ) : doc.type?.startsWith("image/") ? (
                    <img key={doc.id} src={doc.data} alt={doc.name} onClick={() => setLightbox(doc)}
                      style={{ width: "100%", borderRadius: 12, border: `1px solid ${T.border}`, marginBottom: 8, cursor: "zoom-in", display: "block" }} />
                  ) : (
                    <button key={doc.id} onClick={() => openPdfDoc(doc)} style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 12px",
                      borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input,
                      color: T.text, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 8, textAlign: "left",
                    }}>
                      <span style={{ fontSize: 16 }}>📕</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
                    </button>
                  )
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => { const it = viewItem; setViewItem(null); onShare(it, sectionKey); }} style={{
                padding: "12px 18px", borderRadius: 10, border: "none",
                backgroundColor: T.shareGlow, color: T.share, fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}>Send</button>
              <button onClick={() => { const it = viewItem; setViewItem(null); openEdit(it); }} style={{
                padding: "12px 18px", borderRadius: 10, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}>Edit</button>
            </div>
          </>
        )}
      </Modal>

      {/* Full-screen picture viewer */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
        }}>
          <img src={lightbox.data} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} subtitle={emptySub} onAction={openAdd} actionLabel="Add" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(item => {
            const color = getStatusColor(item.expirationDate);
            const needsReview = item.npiImported && !item.expirationDate;
            return (
              <div key={item.id} onClick={() => setViewItem(item)} style={{
                backgroundColor: T.card, border: `1px solid ${needsReview ? T.danger : T.border}`,
                borderRadius: 14, padding: "14px 16px",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                boxShadow: T.shadow1, cursor: "pointer",
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
                      {describeItem(item, data.settings.name) || "Untitled"}
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
                    {renderExtra && <div onClick={(e) => e.stopPropagation()}>{renderExtra(item)}</div>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                  <button onClick={(e) => { e.stopPropagation(); onShare(item, sectionKey); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
                  <button onClick={(e) => { e.stopPropagation(); openEdit(item); }} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this item? This cannot be undone.")) onDelete(item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
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
