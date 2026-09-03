import { useState, useRef, useCallback, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import EmptyState from "../shared/EmptyState";
import { UploadIcon, CameraIcon, TrashIcon } from "../shared/Icons";
import { SECTION_META } from "../../constants/credentialTypes";
import { generateId, downscalePhoto } from "../../utils/helpers";
import { analyzeDocument, analyzePDF, analyzeDocText } from "../../utils/documentScanner";
import { useAiAvailable, describeAiStatus } from "../../utils/aiClient";
import { isOfficeFile, extractOfficeText, UPLOAD_ACCEPT } from "../../utils/officeText";
import { screenDocument, phiWarningText } from "../../utils/phiGuard";
import ScanReviewCard from "./ScanReviewCard";
import { CME_INBOX_ADDRESS, isInboxDoc, docMime, leaveInbox } from "../../utils/inboxDocs";

function DocumentsSection() {
  const { data, setData, addItem, editItem, deleteItem: deleteItemCtx, updateSettings, theme: T, navigate } = useApp();
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
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bundleMsg, setBundleMsg] = useState(null);

  const toggleSelected = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Bundle-send: one share sheet carrying ALL selected files, with a cover
  // note listing the contents — instead of sharing documents one by one.
  const sendBundle = useCallback(async () => {
    const docs = data.documents.filter(d => selectedIds.has(d.id));
    if (docs.length === 0) return;
    const missing = docs.filter(d => !d.data);
    if (missing.length > 0) {
      setBundleMsg(`${missing.length} file(s) haven't downloaded to this device yet — try again in a moment.`);
      return;
    }
    const files = docs.map(doc => {
      try {
        const [head, b64] = doc.data.split(",");
        const mime = docMime(doc) || head.match(/data:(.*?)[;,]/)?.[1] || "application/octet-stream";
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new File([arr], doc.name || "document", { type: mime });
      } catch { return null; }
    }).filter(Boolean);

    const sName = data.settings?.name ? `${data.settings.name}${data.settings.degreeType ? `, ${data.settings.degreeType}` : ""}` : "Physician";
    const text = [
      "To whom it may concern,",
      "",
      `Please find attached the credential document packet for ${sName}${data.settings?.npi ? " (NPI " + data.settings.npi + ")" : ""}:`,
      "",
      ...docs.map((d, i) => `  ${i + 1}. ${d.name}`),
      "",
      `Sent via CredentialDOMD · ${new Date().toLocaleDateString()}`,
    ].join("\n");
    const title = `Credential packet — ${sName} (${docs.length} documents)`;
    // iOS Mail promotes the first text line to the subject and strips
    // newlines — share a flowing blurb, formatted letter to the clipboard.
    const blurb = `Credential packet for ${sName}${data.settings?.npi ? " (NPI " + data.settings.npi + ")" : ""}, ${docs.length} document${docs.length === 1 ? "" : "s"} attached: ${docs.map((d, i) => `${i + 1}. ${d.name}`).join("; ")}. A formatted cover letter is on the sender's clipboard for pasting. Sent via CredentialDOMD.`;
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }

    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files, title, text: blurb });
      } catch (err) {
        if (err?.name === "AbortError") return;
        setBundleMsg("Sharing failed — try fewer or smaller files.");
        return;
      }
    } else {
      setBundleMsg("This browser can't attach files to a share. Use the app on your phone, or send documents individually.");
      return;
    }
    addItem("shareLog", {
      id: generateId(),
      itemId: null,
      itemName: `Packet (${docs.length} documents)`,
      section: "documents", method: "share", recipient: "",
      sentAt: new Date().toISOString(),
    });
    setBundleMsg(`Sent ${docs.length} documents as one packet.`);
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [data.documents, data.settings, selectedIds, addItem]);

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
  // The user's own Gemini key (device-local) when they have one; otherwise
  // the analyzers ride the shared key through ai-proxy.
  const apiKey = data.settings.apiKey;
  // AI is on with either key. Uploads are blocked while it is off (a document
  // that can't be read just sits unprocessed), so check up front.
  const aiOn = useAiAvailable(data.settings);

  const requireApiKey = useCallback(() => {
    if (aiOn) return true;
    setScanError(`${describeAiStatus(data.settings)} Documents are read and filed automatically when uploaded, which needs AI.`);
    return false;
  }, [aiOn, data.settings]);
  // Upload is this screen's Add control; at desk width `n` opens the same
  // file picker the button opens, behind the same AI gate.
  useDeskAddShortcut(() => { if (requireApiKey()) fileRef.current?.click(); });

  const linkables = [
    ...data.licenses.map(l => ({ value: `licenses:${l.id}`, label: `License: ${l.name || l.type}` })),
    ...data.privileges.map(p => ({ value: `privileges:${p.id}`, label: `Privilege: ${p.name || p.type} - ${p.facility}` })),
    ...data.insurance.map(i => ({ value: `insurance:${i.id}`, label: `Insurance: ${i.name || i.type}` })),
    ...data.cme.map(c => ({ value: `cme:${c.id}`, label: `CME: ${c.title || c.category}` })),
    ...(data.healthRecords || []).map(h => ({ value: `healthRecords:${h.id}`, label: `Health: ${h.name || h.type || h.category}` })),
    ...(data.education || []).map(e => ({ value: `education:${e.id}`, label: `Education: ${e.name || e.type || e.institution}` })),
    ...(data.locumContracts || []).map(c => ({ value: `locumContracts:${c.id}`, label: `Agreement: ${c.facility || "Contract"}` })),
  ];

  const handleFiles = useCallback(async (files) => {
    if (!requireApiKey()) return;
    setScanError(null);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
    const MAX_BATCH = 10;
    // Everything the picker offers must actually be accepted — this list
    // had drifted behind UPLOAD_ACCEPT and silently rejected Word and Excel.
    // Extension is the fallback: iOS and Windows often hand over an empty or
    // generic MIME type for Office files.
    const ALLOWED_TYPES = new Set([
      "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
      "image/heic", "image/heif", "image/tiff", "image/bmp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv", "application/csv", "text/plain",
      "application/rtf", "text/rtf",
      "application/octet-stream", // some browsers send this for .docx/.xlsx
    ]);
    const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|pdf|docx?|xlsx?|csv|txt|rtf)$/i;
    const fileList = Array.from(files).slice(0, MAX_BATCH);
    if (files.length > MAX_BATCH) {
      setScanError(`Only the first ${MAX_BATCH} files will be processed.`);
    }
    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        setScanError(`"${file.name}" exceeds the 10 MB size limit.`);
        continue;
      }
      if (!ALLOWED_TYPES.has(file.type) && !ALLOWED_EXT.test(file.name || "")) {
        setScanError(`"${file.name}" isn't a file type this app reads (${file.type || "unknown type"}). Photos, PDFs, Word, Excel, CSV and text work.`);
        continue;
      }
      // Anything we can read before storing gets screened first — a patient
      // chart must never reach the server, so refusing beats deleting.
      if (isOfficeFile(file)) {
        try {
          const preview = await extractOfficeText({ name: file.name, type: file.type, file });
          const screen = screenDocument(`${file.name}\n${preview}`);
          if (screen?.level === "clinical") {
            setScanError(`"${file.name}" was not uploaded. ${phiWarningText(screen)}`);
            continue;
          }
          if (screen) setScanError(phiWarningText(screen));
        } catch { /* unreadable — the normal path will report it */ }
      }

      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const docId = generateId();
      const dup = (data.documents || []).find(d =>
        (d.data && d.data.length === dataUrl.length && d.data === dataUrl) ||
        (d.name === file.name && d.size === file.size)
      );
      if (dup) {
        setScanError(`"${file.name}" is already uploaded${dup.linkedTo ? " (and linked)" : " — find it below and use File with AI"}. Skipped duplicate.`);
        continue;
      }
      addItem("documents", {
        id: docId, name: file.name, type: file.type, size: file.size,
        data: dataUrl, uploadedAt: new Date().toISOString(), linkedTo: "",
      });

      const scannable = file.type.startsWith("image/") || file.type === "application/pdf" || isOfficeFile(file);
      if (scannable && aiOn) {
        setScanning(true);
        try {
          const result = isOfficeFile(file)
            ? await analyzeDocText(await extractOfficeText({ name: file.name, type: file.type, file }), deg, apiKey)
            : file.type === "application/pdf"
              ? await analyzePDF(dataUrl, deg, apiKey)
              : await analyzeDocument(dataUrl, deg, apiKey);
          // An image or PDF can only be judged once it has been read. If it
          // turns out to be a patient record, remove it again immediately
          // rather than leaving it on the server.
          const screen = screenDocument(`${file.name}\n${JSON.stringify(result)}`);
          if (screen?.level === "clinical") {
            deleteItemCtx("documents", docId);
            setScanError(`"${file.name}" was removed. ${phiWarningText(screen)}`);
            setScanning(false);
            continue;
          }
          if (screen) setScanError(phiWarningText(screen));
          setScanQueue(q => [...q, { result, imageData: dataUrl, fileName: file.name, docId }]);
        } catch (err) {
          setScanError(err.message || "Analysis failed. Document has been saved to your files.");
        }
        setScanning(false);
      } else if (!aiOn && scannable) {
        setScanError(`Document saved but could not be analyzed. ${describeAiStatus(data.settings)}`);
      }
    }
  }, [apiKey, aiOn, deg, addItem, deleteItemCtx, data.documents, data.settings, requireApiKey]);

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
    if (!section) {
      setScanError(`Cannot file "${docType}" — this app version doesn't know that category. Update the app (reload) and re-scan.`);
      return;
    }
    const entry = { ...fields, id };
    if (section === "cme" && !entry.topics) entry.topics = [];
    if (section === "locumContracts") {
      // Contract terms drive billing math — coerce to numbers with defaults.
      for (const k of ["hourlyRate", "callHourlyRate", "callStipend", "stipendHours", "overageHourlyRate", "orientationFee", "orientationHourlyRate"]) {
        entry[k] = parseFloat(entry[k]) || 0;
      }
      entry.incrementMinutes = parseInt(entry.incrementMinutes, 10) || 15;
      entry.minCallMinutes = parseInt(entry.minCallMinutes, 10) || 15;
    }

    // Add the credential entry
    addItem(section, entry);
    // Link the document to it (an emailed certificate leaves the inbox here)
    const doc = data.documents.find(d => d.id === docId);
    if (doc) editItem("documents", { ...doc, ...leaveInbox(doc), linkedTo: `${section}:${id}` });

    setScanQueue(q => q.filter(item => item.docId !== docId));
  };

  const handleDiscard = (docId) => setScanQueue(q => q.filter(item => item.docId !== docId));

  // Re-run AI filing on an ALREADY-STORED document — recovery path for
  // uploads whose review step was lost (stale build, refresh, killed PWA).
  const rescanDoc = useCallback(async (doc) => {
    if (!requireApiKey()) return;
    if (!doc.data) {
      setScanError("This file's contents haven't downloaded to this device yet. Give sync a moment and try again.");
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const mime = docMime(doc);
      const isPdf = mime === "application/pdf" || doc.data.startsWith("data:application/pdf");
      const result = isOfficeFile(doc)
        ? await analyzeDocText(await extractOfficeText({ name: doc.name, type: mime, dataUrl: doc.data }), deg, apiKey)
        : isPdf
          ? await analyzePDF(doc.data, deg, apiKey)
          : await analyzeDocument(doc.data, deg, apiKey);
      setScanQueue(q => q.some(i => i.docId === doc.id) ? q : [...q, { result, imageData: doc.data, fileName: doc.name, docId: doc.id }]);
    } catch (err) {
      setScanError(err.message || "Could not read this document.");
    }
    setScanning(false);
  }, [apiKey, deg, requireApiKey]);
  // Full-screen viewing: images get a lightbox, PDFs open in a viewer sheet
  const [lightbox, setLightbox] = useState(null);
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/pdf" }));
    window.open(url, "_blank");
  }, []);

  const deleteDoc = (id) => { if (window.confirm("Delete this document? This cannot be undone.")) deleteItemCtx("documents", id); };
  const linkDoc = (id, val) => {
    const doc = data.documents.find(d => d.id === id);
    if (doc) editItem("documents", { ...doc, ...(val ? leaveInbox(doc) : {}), linkedTo: val });
  };

  // Emailed certificates first, everything else after.
  const inboxDocs = data.documents.filter(isInboxDoc);
  const storedDocs = data.documents.filter(d => !isInboxDoc(d));

  // One document card. Shared by the inbox group and the stored list.
  const renderDoc = (doc) => {
    const sectionKey = doc.linkedTo?.split(":")[0];
    const metaKey = sectionKey === "licenses" ? "license" : sectionKey === "cme" ? "cme" : sectionKey === "privileges" ? "privilege" : sectionKey === "insurance" ? "insurance" : sectionKey === "healthRecords" ? "healthRecord" : sectionKey === "education" ? "education" : sectionKey === "locumContracts" ? "agreement" : "unknown";
    const linkedMeta = doc.linkedTo ? SECTION_META[metaKey] : null;

    const isSelected = selectedIds.has(doc.id);
    const mime = docMime(doc);
    return (
      <div key={doc.id}
        onClick={selectMode ? () => toggleSelected(doc.id) : undefined}
        style={{
          backgroundColor: T.card,
          border: `1px solid ${selectMode && isSelected ? T.accent : T.border}`,
          borderRadius: 14, padding: "12px 16px", boxShadow: T.shadow1,
          cursor: selectMode ? "pointer" : "default",
        }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
            {selectMode && (
              <div style={{
                width: 22, height: 22, borderRadius: 11, flexShrink: 0,
                border: `2px solid ${isSelected ? T.accent : T.border}`,
                backgroundColor: isSelected ? T.accent : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 13, fontWeight: 800,
              }}>{isSelected ? "✓" : ""}</div>
            )}
            <span style={{ fontSize: 20 }}>{mime.includes("pdf") ? "\ud83d\udcd5" : mime.includes("image") ? "\ud83d\uddbc" : "\ud83d\udcc4"}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 13, color: T.textDim }}>{(doc.size / 1024).toFixed(0)} KB &middot; {new Date(doc.uploadedAt).toLocaleDateString()}</span>
                {linkedMeta && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 6, backgroundColor: linkedMeta.color + "20", color: linkedMeta.color, fontWeight: 600 }}>{linkedMeta.icon} Linked</span>}
              </div>
            </div>
          </div>
          {!selectMode && (
            <button onClick={() => deleteDoc(doc.id)} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
          )}
        </div>
        {!doc.linkedTo && !doc.data && doc.storagePath && (
          <div style={{ marginTop: 6, fontSize: 12, color: T.textDim }}>Fetching the file from your account. File with AI appears when it is here.</div>
        )}
        {!doc.linkedTo && (
          <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            {doc.data && (mime.startsWith("image/") || mime === "application/pdf") && (
              <button onClick={() => rescanDoc(doc)} disabled={scanning} style={{
                flexShrink: 0, padding: "7px 12px", borderRadius: 8, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>
                {scanning ? "Reading…" : "File with AI"}
              </button>
            )}
            <select value={doc.linkedTo || ""} onChange={e => linkDoc(doc.id, e.target.value)} style={{ ...iS, fontSize: 14, padding: "6px 10px", appearance: "auto", flex: 1, minWidth: 0 }}>
              <option value="">Link to credential...</option>
              {linkables.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
        )}
        {mime.includes("image") && doc.data && (
          <div style={{ marginTop: 8 }}>
            <img src={doc.data} alt={doc.name} onClick={() => setLightbox(doc)}
              style={{ maxWidth: "100%", maxHeight: 140, borderRadius: 8, objectFit: "contain", cursor: "zoom-in" }} />
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>Tap image to enlarge</div>
          </div>
        )}
        {mime.includes("pdf") && doc.data && (
          <button onClick={() => openPdfDoc(doc)} style={{
            marginTop: 8, padding: "7px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: T.input, color: T.text, fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>📕 View PDF</button>
        )}
      </div>
    );
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

      {!aiOn && (
        <div style={{ padding: "18px", borderRadius: 14, backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>AI is not on yet</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Document scanning uses AI to read your credentials and automatically file them. {describeAiStatus(data.settings)} You can also add your own Gemini key in Settings.
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
        <input type="file" ref={fileRef} multiple accept={UPLOAD_ACCEPT} style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
        <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => requireApiKey() && fileRef.current?.click()} style={btnStyle}><UploadIcon /> Upload</button>
        <button onClick={() => requireApiKey() && openCamera()} style={btnStyle}><CameraIcon /> Camera</button>
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

      {inboxDocs.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, textTransform: "uppercase", marginBottom: 4 }}>
            From your inbox, not filed yet ({inboxDocs.length})
          </div>
          <div style={{ fontSize: 13, color: T.textDim, marginBottom: 10, lineHeight: 1.45 }}>
            Certificates you forwarded to {CME_INBOX_ADDRESS}. Use File with AI, or link one to a CME entry, so it counts.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inboxDocs.map(doc => renderDoc(doc))}
          </div>
        </div>
      )}

      {data.documents.length === 0 && scanQueue.length === 0 ? (
        <EmptyState icon={"\ud83d\udcc1"} title="No documents" subtitle={`Upload, scan, or photograph your credentials. AI will read and file them automatically. CME certificates can also be forwarded to ${CME_INBOX_ADDRESS}.`} />
      ) : storedDocs.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>
              Stored Documents ({storedDocs.length})
            </div>
            <button onClick={() => { setSelectMode(m => !m); setSelectedIds(new Set()); setBundleMsg(null); }} style={{
              padding: "6px 14px", borderRadius: 16, fontSize: 13, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${selectMode ? T.accent : T.border}`,
              backgroundColor: selectMode ? T.accent : "transparent",
              color: selectMode ? "#fff" : T.textMuted,
            }}>
              {selectMode ? "Cancel" : "Select to send"}
            </button>
          </div>
          {bundleMsg && (
            <div style={{ fontSize: 13, fontWeight: 600, color: T.accent, marginBottom: 10 }}>{bundleMsg}</div>
          )}
          {selectMode && (
            <button onClick={sendBundle} disabled={selectedIds.size === 0} style={{
              width: "100%", padding: "14px", borderRadius: 12, border: "none", marginBottom: 10,
              background: selectedIds.size === 0 ? T.border : "linear-gradient(135deg, #10b981, #059669)",
              color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
            }}>
              Send {selectedIds.size || ""} document{selectedIds.size === 1 ? "" : "s"} as one packet
            </button>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {storedDocs.map(doc => renderDoc(doc))}
          </div>
        </div>
      )}
      {/* Full-screen picture viewer */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 12, gap: 12,
        }}>
          <img src={lightbox.data} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "85%", objectFit: "contain" }} />
          <button onClick={async (ev) => {
            ev.stopPropagation();
            const small = await downscalePhoto(lightbox.data);
            updateSettings({ profilePhoto: small });
            setLightbox(null);
          }} style={{
            padding: "12px 20px", borderRadius: 12, border: "none",
            backgroundColor: "#10b981", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer",
          }}>Set as my profile photo</button>
        </div>
      )}
    </div>
  );
}

export default memo(DocumentsSection);
