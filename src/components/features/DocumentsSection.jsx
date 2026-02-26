import { useState, useRef, useCallback, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import EmptyState from "../shared/EmptyState";
import { UploadIcon, CameraIcon, TrashIcon } from "../shared/Icons";
import { SECTION_META } from "../../constants/credentialTypes";
import { generateId } from "../../utils/helpers";
import { analyzeDocument, analyzePDF } from "../../utils/documentScanner";
import ScanReviewCard from "./ScanReviewCard";

function DocumentsSection() {
  const { data, setData, addItem, editItem, deleteItem: deleteItemCtx, theme: T, navigate } = useApp();
  const iS = useInputStyle();
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [scanQueue, setScanQueue] = useState([]);
  const [scanError, setScanError] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  const openCamera = useCallback(async () => {
    // On mobile, use native camera capture
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
      cameraRef.current?.click();
      return;
    }
    setCameraError(null);
    setCameraOpen(true);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      setCameraError("Could not access camera. Check browser permissions.");
      setCameraOpen(false);
    }
  }, []);

  const closeCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
    setCameraError(null);
  }, []);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    };
  }, []);

  const deg = data.settings.degreeType;
  const apiKey = data.settings.apiKey;

  const linkables = [
    ...data.licenses.map(l => ({ value: `licenses:${l.id}`, label: `License: ${l.name || l.type}` })),
    ...data.privileges.map(p => ({ value: `privileges:${p.id}`, label: `Privilege: ${p.name || p.type} - ${p.facility}` })),
    ...data.insurance.map(i => ({ value: `insurance:${i.id}`, label: `Insurance: ${i.name || i.type}` })),
    ...data.cme.map(c => ({ value: `cme:${c.id}`, label: `CME: ${c.title || c.category}` })),
    ...(data.healthRecords || []).map(h => ({ value: `healthRecords:${h.id}`, label: `Health: ${h.name || h.type || h.category}` })),
    ...(data.education || []).map(e => ({ value: `education:${e.id}`, label: `Education: ${e.name || e.type || e.institution}` })),
  ];

  const handleFiles = useCallback(async (files) => {
    setScanError(null);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
    const MAX_BATCH = 10;
    const ALLOWED_TYPES = new Set([
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "application/pdf",
    ]);
    const fileList = Array.from(files).slice(0, MAX_BATCH);
    if (files.length > MAX_BATCH) {
      setScanError(`Only the first ${MAX_BATCH} files will be processed.`);
    }
    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        setScanError(`"${file.name}" exceeds the 10 MB size limit.`);
        continue;
      }
      if (file.type && !ALLOWED_TYPES.has(file.type)) {
        setScanError(`"${file.name}" has an unsupported file type (${file.type}).`);
        continue;
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const docId = generateId();
      addItem("documents", {
        id: docId, name: file.name, type: file.type, size: file.size,
        data: dataUrl, uploadedAt: new Date().toISOString(), linkedTo: "",
      });

      if ((file.type.startsWith("image/") || file.type === "application/pdf") && apiKey) {
        setScanning(true);
        try {
          const result = file.type === "application/pdf"
            ? await analyzePDF(dataUrl, deg, apiKey)
            : await analyzeDocument(dataUrl, deg, apiKey);
          setScanQueue(q => [...q, { result, imageData: dataUrl, fileName: file.name, docId }]);
        } catch (err) {
          setScanError(err.message || "Analysis failed. Document has been saved to your files.");
        }
        setScanning(false);
      } else if (!apiKey && (file.type.startsWith("image/") || file.type === "application/pdf")) {
        setScanError("Document saved but could not be analyzed. Add your API key in Settings to enable AI scanning.");
      }
    }
  }, [apiKey, deg, addItem]);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    closeCamera();
    // Convert to file-like and process
    const byteStr = atob(dataUrl.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const blob = new Blob([arr], { type: "image/jpeg" });
    const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
    handleFiles([file]);
  }, [closeCamera, handleFiles]);

  const handleSave = (docType, fields, _imageData, _fileName, docId) => {
    const id = generateId();
    const section = SECTION_META[docType]?.section;
    if (!section) return;
    const entry = { ...fields, id };
    if (section === "cme" && !entry.topics) entry.topics = [];

    // Add the credential entry
    addItem(section, entry);
    // Link the document to it
    const doc = data.documents.find(d => d.id === docId);
    if (doc) editItem("documents", { ...doc, linkedTo: `${section}:${id}` });

    setScanQueue(q => q.filter(item => item.docId !== docId));
  };

  const handleDiscard = (docId) => setScanQueue(q => q.filter(item => item.docId !== docId));
  const deleteDoc = (id) => { if (window.confirm("Delete this document? This cannot be undone.")) deleteItemCtx("documents", id); };
  const linkDoc = (id, val) => {
    const doc = data.documents.find(d => d.id === id);
    if (doc) editItem("documents", { ...doc, linkedTo: val });
  };

  const btnStyle = {
    display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px",
    borderRadius: 26, border: "none", fontSize: 15, fontWeight: 600,
    cursor: "pointer", backgroundColor: T.accent, color: "#fff",
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>Smart Scan</h2>
      <div style={{ fontSize: 14, color: T.textDim, marginBottom: 16, lineHeight: 1.5 }}>
        Upload, scan, or photograph any credential document. AI will identify the document type, extract all fields, and file it to the correct section.
      </div>

      {!apiKey && (
        <div style={{ padding: "18px", borderRadius: 14, backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>API Key Required</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Document scanning uses AI to read your credentials and automatically file them. Add your Gemini API key in Settings to get started.
          </div>
          <button onClick={() => navigate("more", "settings")} style={{
            padding: "10px 22px", borderRadius: 22, border: "none", fontSize: 14,
            fontWeight: 600, cursor: "pointer", backgroundColor: T.accent, color: "#fff",
          }}>
            Go to Settings
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input type="file" ref={fileRef} multiple accept="image/jpeg,image/png,image/gif,image/webp,.pdf" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
        <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} style={btnStyle}><UploadIcon /> Upload</button>
        <button onClick={openCamera} style={btnStyle}><CameraIcon /> Camera</button>
      </div>

      {/* Live camera viewfinder */}
      {cameraOpen && (
        <div style={{ marginBottom: 16, borderRadius: 12, overflow: "hidden", border: `2px solid ${T.accent}`, position: "relative", backgroundColor: "#000" }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", display: "block", borderRadius: 10 }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "12px", display: "flex", justifyContent: "center", gap: 12, background: "linear-gradient(transparent, rgba(0,0,0,0.7))" }}>
            <button onClick={closeCamera} style={{ padding: "10px 22px", borderRadius: 24, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", backgroundColor: "rgba(255,255,255,0.2)", color: "#fff" }}>Cancel</button>
            <button onClick={capturePhoto} style={{ padding: "10px 28px", borderRadius: 24, border: "3px solid #fff", fontSize: 14, fontWeight: 700, cursor: "pointer", backgroundColor: T.accent, color: "#fff" }}>Take Photo</button>
          </div>
        </div>
      )}

      {cameraError && (
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, marginBottom: 14 }}>
          {cameraError}
          <button onClick={() => setCameraError(null)} style={{ marginLeft: 8, border: "none", background: "none", color: T.danger, fontWeight: 700, cursor: "pointer" }}>&times;</button>
        </div>
      )}

      {!cameraOpen && (
        <div
          onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
          onDragOver={e => e.preventDefault()}
          style={{ border: `2px dashed ${T.border}`, borderRadius: 14, padding: "30px 18px", textAlign: "center", marginBottom: 16, color: T.textDim, fontSize: 15 }}
        >
          Drop files here or use the buttons above
        </div>
      )}

      {scanning && (
        <div style={{ padding: "18px", borderRadius: 14, backgroundColor: T.accentGlow, border: `1px solid ${T.accent}`, marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.accent }}>Analyzing document...</div>
          <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>AI is reading and classifying your credential</div>
        </div>
      )}

      {scanError && (
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.warningDim, color: T.warning, fontSize: 14, marginBottom: 14 }}>
          {scanError}
          <button onClick={() => setScanError(null)} style={{ marginLeft: 8, border: "none", background: "none", color: T.warning, fontWeight: 700, cursor: "pointer" }}>&times;</button>
        </div>
      )}

      {scanQueue.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 10 }}>
            {scanQueue.length} document{scanQueue.length > 1 ? "s" : ""} ready for review
          </div>
          {scanQueue.map(item => (
            <ScanReviewCard
              key={item.docId}
              result={item.result}
              imageData={item.imageData}
              fileName={item.fileName}
              onSave={(docType, fields, img, fn) => handleSave(docType, fields, img, fn, item.docId)}
              onDiscard={() => handleDiscard(item.docId)}
            />
          ))}
        </div>
      )}

      {data.documents.length === 0 && scanQueue.length === 0 ? (
        <EmptyState icon={"\ud83d\udcc1"} title="No documents" subtitle="Upload, scan, or photograph your credentials. AI will read and file them automatically." />
      ) : data.documents.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", marginBottom: 10 }}>
            Stored Documents ({data.documents.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.documents.map(doc => {
              const sectionKey = doc.linkedTo?.split(":")[0];
              const metaKey = sectionKey === "licenses" ? "license" : sectionKey === "cme" ? "cme" : sectionKey === "privileges" ? "privilege" : sectionKey === "insurance" ? "insurance" : sectionKey === "healthRecords" ? "healthRecord" : sectionKey === "education" ? "education" : "unknown";
              const linkedMeta = doc.linkedTo ? SECTION_META[metaKey] : null;

              return (
                <div key={doc.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "12px 16px", boxShadow: T.shadow1 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 20 }}>{doc.type?.includes("pdf") ? "\ud83d\udcd5" : doc.type?.includes("image") ? "\ud83d\uddbc" : "\ud83d\udcc4"}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.name}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 13, color: T.textDim }}>{(doc.size / 1024).toFixed(0)} KB &middot; {new Date(doc.uploadedAt).toLocaleDateString()}</span>
                          {linkedMeta && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, backgroundColor: linkedMeta.color + "20", color: linkedMeta.color, fontWeight: 600 }}>{linkedMeta.icon} Linked</span>}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => deleteDoc(doc.id)} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                  </div>
                  {!doc.linkedTo && (
                    <div style={{ marginTop: 6 }}>
                      <select value={doc.linkedTo || ""} onChange={e => linkDoc(doc.id, e.target.value)} style={{ ...iS, fontSize: 14, padding: "6px 10px", appearance: "auto" }}>
                        <option value="">Link to credential...</option>
                        {linkables.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </select>
                    </div>
                  )}
                  {doc.type?.includes("image") && doc.data && (
                    <div style={{ marginTop: 8 }}>
                      <img src={doc.data} alt={doc.name} style={{ maxWidth: "100%", maxHeight: 140, borderRadius: 8, objectFit: "contain" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(DocumentsSection);
