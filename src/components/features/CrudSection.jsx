import { useState, useRef, useEffect, memo, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import { CPT_DESCS } from "../../constants/cptDescs";
import { CPT_BY_CODE } from "../../constants/cpt";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import DeskTable from "../shared/DeskTable";
import { formRows } from "../../utils/formLayout";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { pushModal, popModal } from "../../utils/deskKeys";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, UploadIcon, CameraIcon } from "../shared/Icons";
import { generateId, getStatusColor, getStatusLabel, describeItem, isNonExpiring, shortFacility, formatDate } from "../../utils/helpers";
import { analyzeDocument, analyzePDF, analyzeDocText } from "../../utils/documentScanner";
import { useAiAvailable, describeAiStatus } from "../../utils/aiClient";
import { isOfficeFile, extractOfficeText, UPLOAD_ACCEPT } from "../../utils/officeText";
import { isContactPickerSupported, pickContact, parseVCard } from "../../utils/contactImport";
import { STATE_NAMES } from "../../constants/states";
import CPTCodePicker from "./CPTCodePicker";
import { isEncrypted, hasLockCode, saveLockCode, encryptSecret, decryptSecret, setSecretUser } from "../../utils/secretBox";
import { checkStorageQuota } from "../../utils/storageQuota";

// Every billed code, spelled out — number, what it entails, units, value.
// Structured detail from the import wins; a hand-typed code string still
// resolves through the description catalogs.
function billedCodes(item) {
  const detail = item.customFields?.cptDetail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(c => ({
      code: c.code, units: c.units || 1, mod: c.mod || null,
      desc: c.desc || CPT_DESCS[c.code]?.d || CPT_BY_CODE[c.code]?.shortDesc || "",
      wRVU: c.wRVU ?? CPT_DESCS[c.code]?.w ?? CPT_BY_CODE[c.code]?.wRVU ?? 0,
      inferred: !!c.inferred,
    }));
  }
  if (!item.cptCodes) return [];
  return String(item.cptCodes).split(",").map(t => t.trim()).filter(Boolean).map(tok => {
    const m = tok.match(/^(\w+?)(?:-(\d\d))?(?:\s*x(\d+))?$/i) || [];
    const code = m[1] || tok;
    return {
      code, units: m[3] ? parseInt(m[3], 10) : 1, mod: m[2] || null,
      desc: CPT_DESCS[code]?.d || CPT_BY_CODE[code]?.shortDesc || "",
      wRVU: CPT_DESCS[code]?.w ?? CPT_BY_CODE[code]?.wRVU ?? 0,
      inferred: false,
    };
  });
}

const HIDDEN_CUSTOM_KEYS = new Set(["cptDetail", "componentAudit", "sourceRow", "sourceDoc", "patient"]);

// AI-scanned text for a select field (e.g. a DEA card's "Florida" instead of
// "FL") won't exact-match its dropdown options, which breaks state-keyed
// lookups elsewhere (RenewalInfo, MultiStateMatrix). Snap it to the matching
// option when one exists; otherwise leave the raw text so the "(from
// document)" fallback below can still show and preserve it for review.
function canonicalizeSelectValue(fieldDef, raw) {
  if (!fieldDef || fieldDef.type !== "select" || typeof raw !== "string") return raw;
  const options = fieldDef.groups ? fieldDef.groups.flatMap(g => g.options) : (fieldDef.options || []);
  const trimmed = raw.trim();
  const ciMatch = options.find(o => o.toLowerCase() === trimmed.toLowerCase());
  if (ciMatch) return ciMatch;
  if (fieldDef.key === "state") {
    const byName = Object.entries(STATE_NAMES).find(([, name]) => name.toLowerCase() === trimmed.toLowerCase());
    if (byName && options.includes(byName[0])) return byName[0];
  }
  return raw;
}

// label/placeholder can vary by the record being edited (e.g. Certification
// asks a different question than a license does) — same function-of-form
// pattern already used for `required`.
function resolveFieldProp(f, key, form) {
  const v = f[key];
  return typeof v === "function" ? v(form) : v;
}

// A field may declare `show(form)` to appear only for some record types (the
// licenses form is shared by medical licenses, DEA registrations and
// certifications). Hidden fields are skipped by the form AND by required-field
// validation, so a hidden field can never block a save.
function isShown(f, form) {
  return typeof f.show === "function" ? !!f.show(form) : true;
}

function CrudSection({ title, sectionKey, items, fields, onAdd, onEdit, onDelete, onShare, renderExtra, emptyIcon, emptyTitle, emptySub, autoOpen, onAutoOpenDone, autoEditId, onAutoEditDone, onAutoEditClosed, autoFocusField, autoViewId, onAutoViewDone, filterTabs, prefillItem, onPrefillDone, contactImport, deskColumns, deskDefaultSort }) {
  const { data, setData, addItem, theme: T , user, isDesktop } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [scanningDoc, setScanningDoc] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const [scanIsError, setScanIsError] = useState(false);
  const [modalCameraOpen, setModalCameraOpen] = useState(false);
  const [contactMsg, setContactMsg] = useState(null);
  const [contactMsgError, setContactMsgError] = useState(false);
  const uploadRef = useRef(null);
  const modalCameraRef = useRef(null);
  const modalVideoRef = useRef(null);
  const modalCanvasRef = useRef(null);
  const modalStreamRef = useRef(null);
  // True while an edit form that a deep link opened is still on screen.
  const arrivedByLink = useRef(false);

  const openAdd = useCallback(() => { setForm({}); setEditItem(null); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false); setContactMsg(null); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item }); setEditItem(item); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false); setContactMsg(null); setShowForm(true); }, []);
  // Desk width: `n` opens the same Add form the header button opens.
  useDeskAddShortcut(openAdd);

  // Follow-ups are logged from the Home dashboard's "Action Required" cards,
  // but this is the item's own screen — wherever you land (view or edit),
  // that history needs to be visible or it reads as untracked.
  const followUpHistory = (item) => (data.followUps || [])
    .filter(f => f.itemId === item?.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const renderFollowUps = (item) => {
    const history = followUpHistory(item);
    if (!history.length) return null;
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
          Follow-up history
        </div>
        {history.map(f => (
          <div key={f.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px dashed ${T.border}`, marginBottom: 6 }}>
            <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
              {f.emailed ? "Emailed" : "Note"}{f.recipient ? ` · ${f.recipient}` : ""} · {formatDate(f.createdAt)}
            </div>
            {f.note && <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>{f.note}</div>}
          </div>
        ))}
      </div>
    );
  };

  // Auto-open add form when triggered from outside (e.g., home page "Add Your License" card)
  // Deep-link: open a specific record's edit form (e.g. from the Home
  // missing-expiration card).
  useEffect(() => {
    if (!autoEditId) return;
    const it = items.find(x => x.id === autoEditId);
    if (it) {
      arrivedByLink.current = true;
      openEdit(it);
      onAutoEditDone?.();
      // "Add the expiration date" cards land the user INSIDE a long form —
      // put the cursor on the exact field they came for.
      if (autoFocusField) {
        setTimeout(() => {
          const el = document.querySelector(`[data-fkey="${autoFocusField}"]`);
          try { el?.focus(); el?.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* older browser */ }
        }, 400);
      }
    }
  }, [autoEditId, items, openEdit, onAutoEditDone, autoFocusField]);

  useEffect(() => {
    if (prefillItem) {
      // A dictated/AI-built draft: open the add form already filled — the
      // physician reviews and saves; nothing writes without their tap.
      openAdd();
      setForm(prefillItem);
      onPrefillDone?.();
    }
    if (autoOpen) {
      // Same flag the edit deep link sets: a form opened from somewhere else
      // owes the physician a trip back when it closes.
      arrivedByLink.current = true;
      openAdd();
      onAutoOpenDone?.();
    }
  }, [autoOpen, openAdd, onAutoOpenDone, prefillItem, onPrefillDone]);
  const closeForm = useCallback(() => {
    setRequiredError(null);
    if (modalStreamRef.current) { modalStreamRef.current.getTracks().forEach(t => t.stop()); modalStreamRef.current = null; }
    setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); setScanMsg(null); setScanIsError(false); setModalCameraOpen(false); setContactMsg(null);
    // A deep link that opened this form is finished only now. onAutoEditDone
    // fires the moment the form OPENS (it has to, or the effect reopens it),
    // so anything that wants the physician taken back where they came from
    // has to hang off the close instead.
    if (arrivedByLink.current) { arrivedByLink.current = false; onAutoEditClosed?.(); }
  }, [onAutoEditClosed]);

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

  // AI is on with the user's own key or the shared key (via ai-proxy).
  const aiOn = useAiAvailable(data.settings);
  const requireApiKey = useCallback(() => {
    if (aiOn) return true;
    setScanIsError(true);
    setScanMsg(`${describeAiStatus(data.settings)} Documents are read and auto-filled by AI.`);
    return false;
  }, [aiOn, data.settings]);

  const handleUpload = useCallback(async (files) => {
    const apiKey = data.settings.apiKey; // own key, or undefined for the shared key
    const deg = data.settings.degreeType;
    // The account's 2 GB line, counting files already staged on this form.
    const quota = checkStorageQuota(data.documents, [...attachedDocs, ...Array.from(files)]);
    if (!quota.ok) { setScanIsError(true); setScanMsg(quota.message); return; }

    for (const file of Array.from(files)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setAttachedDocs(prev => [...prev, { name: file.name, type: file.type, size: file.size, data: dataUrl }]);

      // Run AI scan to auto-fill form fields
      if (aiOn && (file.type.startsWith("image/") || file.type === "application/pdf" || isOfficeFile(file))) {
        setScanningDoc(true);
        setScanMsg(null);
        try {
          const result = isOfficeFile(file)
            ? await analyzeDocText(await extractOfficeText({ name: file.name, type: file.type, file }), deg, apiKey)
            : file.type === "application/pdf"
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
                  const strValue = Array.isArray(value) ? value : String(value);
                  const fieldDef = fields.find(f => f.key === key);
                  merged[key] = canonicalizeSelectValue(fieldDef, strValue);
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
  }, [aiOn, data.settings.apiKey, data.settings.degreeType, fields, data.documents, attachedDocs]);

  const handleImportContact = useCallback(async () => {
    setContactMsg(null);
    setContactMsgError(false);
    try {
      const contact = await pickContact();
      if (!contact) return; // user backed out of the native picker
      setForm(prev => ({
        ...prev,
        name: contact.name || prev.name,
        email: contact.email || prev.email,
        phone: contact.phone || prev.phone,
      }));
      setContactMsg("Imported from contacts — review before saving.");
    } catch (err) {
      setContactMsg("Could not read contact: " + (err.message || "permission denied"));
      setContactMsgError(true);
    }
  }, []);

  // iPhone path — no picker API there, but Contacts shares any card as a
  // .vcf file. Read it, prefill the same fields.
  const vcfRef = useRef(null);
  const handleVcfFile = useCallback(async (file) => {
    setContactMsg(null);
    setContactMsgError(false);
    try {
      const contact = parseVCard(await file.text());
      if (!contact) {
        setContactMsg("That file doesn't look like a contact card (.vcf).");
        setContactMsgError(true);
        return;
      }
      setForm(prev => ({
        ...prev,
        name: contact.name || prev.name,
        email: contact.email || prev.email,
        phone: contact.phone || prev.phone,
        institution: prev.institution || contact.institution || "",
      }));
      setContactMsg("Imported from the contact card — review before saving.");
    } catch (err) {
      setContactMsg("Could not read the contact card: " + (err.message || "unreadable file"));
      setContactMsgError(true);
    }
  }, []);

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
  // Opening one record from somewhere else (the dashboard list, search, Vera)
  // shows its details, the same thing tapping the card does.
  useEffect(() => {
    if (!autoViewId) return;
    const it = items.find(x => x.id === autoViewId);
    if (it) { setViewItem(it); onAutoViewDone?.(); }
  }, [autoViewId, items, onAutoViewDone]);
  // Secret fields (portal passwords): masked, encrypted on save with a
  // device-held lock code, revealed on demand in the detail view.
  const [showSecret, setShowSecret] = useState({});
  const [lockCodeDraft, setLockCodeDraft] = useState("");
  const [lockMsg, setLockMsg] = useState("");
  const [revealed, setRevealed] = useState({});
  useEffect(() => { setSecretUser(user?.id || null); }, [user?.id]);
  const hasSecretFields = fields.some(f => f.type === "secret");
  const needsLockCode = hasSecretFields && !hasLockCode() && fields.some(f => f.type === "secret" && form[f.key] && !isEncrypted(form[f.key]));
  const revealSecret = async (f) => {
    const v = viewItem?.[f.key];
    if (!v) return;
    let code = hasLockCode() ? null : window.prompt("Enter the lock code you set for saved passwords (it is remembered on this device):");
    if (!hasLockCode() && !code) return;
    try {
      const plain = await decryptSecret(v, code || undefined);
      if (code) saveLockCode(code);
      setRevealed(r => ({ ...r, [f.key]: plain }));
    } catch (e) {
      window.alert(e.message === "wrong-lock-code" ? "That lock code did not open this password." : "Could not read this password on this device.");
    }
  };
  const [lightbox, setLightbox] = useState(null);
  // Optional category tabs (e.g. Licenses: Medical / DEA / Board / Life
  // Support) — mixed record types in one flat list are unreadable.
  const [catFilter, setCatFilter] = useState("all");
  const categorize = (item) => {
    if (!filterTabs) return "all";
    const hit = filterTabs.find(t => t.match(item));
    return hit ? hit.key : "other";
  };
  const filteredItems = !filterTabs || catFilter === "all"
    ? items
    : items.filter(i => categorize(i) === catFilter);

  // Records that need a look (missing required fields, expired, or expiring
  // soon) float to the top and stay grouped there — burying the one problem
  // record at the bottom of an otherwise-fine list made it easy to miss.
  const statusRank = (item) => {
    const nonExpiring = isNonExpiring(item, sectionKey);
    const color = nonExpiring ? "green" : getStatusColor(item.expirationDate);
    const missingRequired = fields.filter(f => {
      const req = typeof f.required === "function" ? f.required(item) : f.required;
      return req && !item[f.key];
    });
    const needsReview = (item.npiImported && !item.expirationDate && !nonExpiring) || missingRequired.length > 0;
    if (needsReview) return 0;
    if (color === "red") return 1;
    if (color === "orange") return 2;
    if (color === "amber") return 3;
    return 4;
  };
  const shownItems = [...filteredItems].sort((a, b) => statusRank(a) - statusRank(b));
  const flaggedCount = shownItems.filter(i => statusRank(i) < 4).length;

  // Escape must close the lightbox, not the modal underneath it — capture
  // phase so this runs before Modal's own document-level Escape handler
  // The lightbox is a modal layer too, so it joins the stack while up and
  // the desk keys stay quiet beneath it.
  useEffect(() => {
    if (!lightbox) return;
    const layer = {};
    pushModal(layer);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); popModal(layer); };
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
    const isRequired = (f) => typeof f.required === "function" ? f.required(form) : f.required;
    const missing = fields.filter(f => isShown(f, form) && isRequired(f) && !form[f.key]);
    if (missing.length > 0) {
      setRequiredError(`Required: ${missing.map(f => resolveFieldProp(f, "label", form)).join(", ")}. Expiration dates are how the app warns you before anything lapses.`);
      return;
    }
    setRequiredError(null);
    const itemId = editItem ? editItem.id : generateId();
    const secretFields = fields.filter(f => f.type === "secret" && form[f.key] && !isEncrypted(form[f.key]));
    if (secretFields.length) {
      if (!hasLockCode()) {
        if (lockCodeDraft.trim().length < 4) { setLockMsg("Set a lock code of at least 4 characters to save a password. It stays on this device only."); return; }
        saveLockCode(lockCodeDraft.trim());
        setLockCodeDraft("");
      }
      // Encrypt, then persist; async because WebCrypto is.
      (async () => {
        const enc = { ...form };
        for (const f of secretFields) enc[f.key] = await encryptSecret(form[f.key]);
        if (editItem) onEdit({ ...editItem, ...enc });
        else onAdd({ ...enc, id: itemId });
      })();
    } else if (editItem) onEdit({ ...editItem, ...form });
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
        {contactImport && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {isContactPickerSupported() && (
                <button onClick={handleImportContact} style={{
                  display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px",
                  borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", backgroundColor: T.accentDim, color: T.accent,
                }}>
                  {"📇"} Import from Contacts
                </button>
              )}
              <button onClick={() => vcfRef.current?.click()} style={{
                display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 16px",
                borderRadius: 10, border: `1px solid ${T.accent}`, fontSize: 13, fontWeight: 600,
                cursor: "pointer", backgroundColor: "transparent", color: T.accent,
              }}>
                {"📇"} Import a contact card (.vcf)
              </button>
              <input ref={vcfRef} type="file" accept=".vcf,text/vcard,text/x-vcard" style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleVcfFile(f); e.target.value = ""; }} />
            </div>
            {!isContactPickerSupported() && (
              <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 5, lineHeight: 1.4 }}>
                On iPhone: open Contacts → the person → Share Contact → Save to Files, then pick that file here.
              </div>
            )}
            {contactMsg && (
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, color: contactMsgError ? T.danger : T.success }}>
                {contactMsg}
              </div>
            )}
          </div>
        )}
        {editItem && renderFollowUps(editItem)}
        {(() => {
          // One renderer for every field at every width. Phone maps it over
          // the shown fields exactly as before; desk width (below) flows
          // short related fields two across.
          const renderField = (f) => (
          <Field
            key={f.key}
            label={resolveFieldProp(f, "label", form) + ((typeof f.required === "function" ? f.required(form) : f.required) ? " *" : "")}
            hint={f.type === "secret" ? undefined : resolveFieldProp(f, "hint", form)}
          >
            {f.type === "select" ? (
              <select
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                style={{ ...iS, appearance: "auto" }}
              >
                <option value="">Select...</option>
                {/* A scanned document can store a value the list doesn't
                    have (e.g. "Provisional Temporary Medical License").
                    It must still SHOW here — a select displaying blank
                    made the record look uneditable and drove help tickets.
                    Listing it lets the user see the truth and switch. */}
                {form[f.key] && !(f.options || []).includes(form[f.key]) && (
                  <option value={form[f.key]}>{form[f.key]} (from document)</option>
                )}
                {f.groups
                  ? f.groups.map(g => (
                    <optgroup key={g.header} label={g.header}>
                      {g.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </optgroup>
                  ))
                  : (f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "datalist" ? (
              <>
                <input
                  list={`dl-${f.key}`}
                  value={form[f.key] || ""}
                  onChange={e => setField(f.key, e.target.value)}
                  placeholder={resolveFieldProp(f, "placeholder", form)}
                  style={iS}
                />
                <datalist id={`dl-${f.key}`}>
                  {(f.options || []).map(o => <option key={o} value={o} />)}
                </datalist>
              </>
            ) : f.type === "checkbox" ? (
              // A boolean the record carries, e.g. "this certificate does not
              // expire". isNonExpiring has read item.noExpiration since it was
              // written; until now nothing in the app could set it, so a
              // lifetime diplomate had no way to say so anywhere.
              <label style={{
                display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
                borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input, cursor: "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={form[f.key] === true}
                  onChange={e => setField(f.key, e.target.checked)}
                  style={{ width: 18, height: 18, flexShrink: 0 }}
                />
                <span style={{ fontSize: 14, color: T.text, lineHeight: 1.4 }}>
                  {resolveFieldProp(f, "checkboxLabel", form) || resolveFieldProp(f, "label", form)}
                </span>
              </label>
            ) : f.type === "cptPicker" ? (
              <CPTCodePicker
                value={form[f.key] || ""}
                onChange={val => setField(f.key, val)}
              />
            ) : f.type === "secret" ? (
              <div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    data-fkey={f.key}
                    type={showSecret[f.key] ? "text" : "password"}
                    autoComplete="off"
                    value={isEncrypted(form[f.key]) ? "" : (form[f.key] || "")}
                    onChange={e => setField(f.key, e.target.value)}
                    placeholder={isEncrypted(form[f.key]) ? "Saved (encrypted). Type to replace." : (resolveFieldProp(f, "placeholder", form) || "")}
                    style={{ ...iS, flex: 1 }}
                  />
                  <button type="button" onClick={() => setShowSecret(v => ({ ...v, [f.key]: !v[f.key] }))} style={{ padding: "0 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{showSecret[f.key] ? "Hide" : "Show"}</button>
                </div>
                {needsLockCode && (
                  <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, backgroundColor: T.accentDim, border: `1px solid ${T.accent}` }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.text }}>Set a lock code for saved passwords</div>
                    <div style={{ fontSize: 12, color: T.textMuted, margin: "2px 0 8px" }}>Passwords are encrypted with it before they sync. The code stays on this device; enter it once on any other device. Nobody, including us, can read them without it.</div>
                    <input type="password" autoComplete="new-password" value={lockCodeDraft} onChange={e => { setLockCodeDraft(e.target.value); setLockMsg(""); }} placeholder="Lock code (4+ characters)" style={iS} />
                    {lockMsg && <div style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{lockMsg}</div>}
                  </div>
                )}
                {!needsLockCode && f.hint && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 4 }}>{f.hint}</div>}
              </div>
            ) : f.type === "textarea" ? (
              <textarea
                data-fkey={f.key}
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={resolveFieldProp(f, "placeholder", form)}
                style={{ ...iS, minHeight: 60, resize: "vertical" }}
              />
            ) : (
              <input
                data-fkey={f.key}
                type={f.type === "currency" ? "number" : f.type || "text"}
                inputMode={f.type === "currency" ? "decimal" : undefined}
                step={f.type === "currency" ? "0.01" : undefined}
                min={f.type === "currency" ? "0" : undefined}
                value={form[f.key] || ""}
                onChange={e => setField(f.key, e.target.value)}
                placeholder={resolveFieldProp(f, "placeholder", form)}
                style={iS}
              />
            )}
          </Field>
          );
          const shown = fields.filter(f => isShown(f, form));
          if (!isDesktop) return shown.map(renderField);
          // Desk width: dates, state, cost, yes/no sit two across when they
          // are neighbors; everything else keeps the full measure. Same
          // Field, same inputs, same validation as the phone column.
          return formRows(shown).map(row => row.length === 1 ? renderField(row[0]) : (
            <div key={`pair:${row[0].key}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 14, alignItems: "start" }}>
              {row.map(renderField)}
            </div>
          ));
        })()}
        {/* Upload / Camera document */}
        <div style={{ marginTop: 14, padding: "14px", borderRadius: 12, border: `1px dashed ${T.border}`, backgroundColor: T.input }}>
          <input type="file" ref={uploadRef} multiple accept={UPLOAD_ACCEPT} style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleUpload(e.target.files); e.target.value = ""; }} />
          <input type="file" ref={modalCameraRef} accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files.length) handleUpload(e.target.files); e.target.value = ""; }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => uploadRef.current?.click()} style={{
              display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
              borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
              cursor: "pointer", backgroundColor: T.accent, color: "#fff",
            }}>
              <UploadIcon /> Upload
            </button>
            <button onClick={() => openModalCamera()} style={{
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
      <Modal open={!!viewItem} onClose={() => { setViewItem(null); setRevealed({}); }} title={viewItem ? describeItem(viewItem, data.settings.name, sectionKey) : "Details"}>
        {viewItem && (
          <>
            {renderFollowUps(viewItem)}
            {fields.filter(f => viewItem[f.key]).map(f => (
              <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{resolveFieldProp(f, "label", viewItem)}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {(() => {
                    const v = viewItem[f.key];
                    // Only a ticked box reaches here at all (the filter above
                    // drops falsy values), so it reads as the claim it is.
                    if (f.type === "checkbox") return resolveFieldProp(f, "checkboxLabel", viewItem) || "Yes";
                    if (f.type === "secret") {
                      const open = revealed[f.key];
                      return (
                        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontFamily: open ? "ui-monospace, monospace" : "inherit", userSelect: "all" }}>{open ? open : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}</span>
                          <button onClick={(e) => { e.stopPropagation(); if (open) setRevealed(r => ({ ...r, [f.key]: null })); else revealSecret(f); }} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.accent, cursor: "pointer" }}>{open ? "Hide" : "Show"}</button>
                          {open && <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(open); }} style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.textMuted, cursor: "pointer" }}>Copy</button>}
                        </span>
                      );
                    }
                    if (f.type === "url") {
                      const href = /^https?:\/\//i.test(v) ? v : `https://${v}`;
                      return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: T.accent }}>{String(v).replace(/^https?:\/\//i, "")}</a>;
                    }
                    if (f.type === "currency") {
                      const n = parseFloat(v);
                      return isNaN(n) ? String(v) : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    }
                    if (f.type === "month") {
                      // "2018-08" → "Aug 2018 · 8 years" — the derived count
                      // stays current forever, which is the point of the field.
                      const d = new Date(v + "-01T00:00:00");
                      if (isNaN(d.getTime())) return String(v);
                      const label = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
                      const yrs = Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
                      return yrs > 0 ? `${label} · ${yrs} year${yrs === 1 ? "" : "s"}` : label;
                    }
                    if (f.type !== "date") return String(v);
                    const d = new Date(v + "T00:00:00");
                    return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  })()}
                </span>
              </div>
            ))}
            {billedCodes(viewItem).length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 2px" }}>
                  What was billed
                </div>
                {billedCodes(viewItem).map((c, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 13.5, fontWeight: 800, fontFamily: "monospace", color: T.accent, flexShrink: 0, minWidth: 52 }}>
                      {c.code}{c.mod ? `-${c.mod}` : ""}{c.units > 1 ? ` ×${c.units}` : ""}
                    </span>
                    <span style={{ fontSize: 13, color: T.text, flex: 1, minWidth: 0 }}>
                      {c.desc || "—"}
                      {c.inferred && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "#a78bfa", textTransform: "uppercase", letterSpacing: 0.5 }}>implied</span>}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "#22c55e", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {c.wRVU ? (c.wRVU * c.units).toFixed(2) : "—"}
                    </span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", fontSize: 13.5, fontWeight: 800 }}>
                  <span style={{ color: T.textMuted }}>Case total</span>
                  <span style={{ color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>
                    {billedCodes(viewItem).reduce((t, c) => t + (c.wRVU || 0) * c.units, 0).toFixed(2)} wRVU
                  </span>
                </div>
                {viewItem.customFields?.componentAudit?.rationale && (
                  <div style={{ fontSize: 11.5, color: T.textDim, padding: "6px 0" }}>
                    Construct check: {viewItem.customFields.componentAudit.rationale}
                  </div>
                )}
              </>
            )}
            {viewItem.customFields && Object.keys(viewItem.customFields).filter(k => !HIDDEN_CUSTOM_KEYS.has(k)).length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 2px" }}>
                  Additional details
                </div>
                {viewItem.customFields.patient && (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>Case reference</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", fontFamily: "monospace" }}>
                      {[viewItem.customFields.patient.caseRef, viewItem.customFields.patient.dob && `DOB ${viewItem.customFields.patient.dob}`].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                )}
                {Object.entries(viewItem.customFields).filter(([k]) => !HIDDEN_CUSTOM_KEYS.has(k)).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{k}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(v)}</span>
                  </div>
                ))}
              </>
            )}
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

      {filterTabs && items.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {[{ key: "all", label: "All" }, ...filterTabs, { key: "other", label: "Other" }].map(t => {
            const count = t.key === "all" ? items.length : items.filter(i => categorize(i) === t.key).length;
            if (t.key === "other" && count === 0) return null;
            return (
              <button key={t.key} onClick={() => setCatFilter(t.key)} style={{
                padding: "6px 14px", fontSize: 13, borderRadius: 22,
                border: `1px solid ${catFilter === t.key ? T.accent : T.border}`,
                backgroundColor: catFilter === t.key ? T.accent : "transparent",
                color: catFilter === t.key ? "#fff" : T.textMuted,
                cursor: "pointer", fontWeight: 600,
              }}>{t.label}{count > 0 ? ` (${count})` : ""}</button>
            );
          })}
        </div>
      )}

      {shownItems.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} subtitle={emptySub} onAction={openAdd} actionLabel="Add" />
      ) : isDesktop && deskColumns ? (
        /* Desk width: the same records as a sortable table. Row click opens
           the existing view modal; the quick actions are the card buttons'
           own handlers. Phone (the branch below) is untouched. */
        <DeskTable
          columns={deskColumns}
          items={filteredItems}
          defaultSort={deskDefaultSort}
          onRowClick={(item) => setViewItem(item)}
          status={(item) => {
            const nonExpiring = isNonExpiring(item, sectionKey);
            const color = nonExpiring ? "green" : getStatusColor(item.expirationDate);
            const missingRequired = fields.filter(f => {
              const req = typeof f.required === "function" ? f.required(item) : f.required;
              return req && !item[f.key];
            });
            const needsReview = (item.npiImported && !item.expirationDate && !nonExpiring) || missingRequired.length > 0;
            if (needsReview) return <StatusDot color="red" />;
            if (item.expirationDate) return <StatusDot color={color} />;
            return null;
          }}
          actions={(item) => (
            <div style={{ display: "inline-flex", gap: 3 }}>
              <button onClick={(e) => { e.stopPropagation(); onShare(item, sectionKey); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
              <button onClick={(e) => { e.stopPropagation(); openEdit(item); }} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
              <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this item? This cannot be undone.")) onDelete(item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
            </div>
          )}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {flaggedCount > 0 && (
            <div style={{ fontSize: 11, fontWeight: 700, color: T.danger, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: -2 }}>
              Needs attention ({flaggedCount})
            </div>
          )}
          {shownItems.map((item, idx) => {
            const nonExpiring = isNonExpiring(item, sectionKey);
            const color = nonExpiring ? "green" : getStatusColor(item.expirationDate);
            // A field required today (e.g. State on a license/DEA entry) can still be
            // blank on an older record saved before that rule existed — flag it the
            // same way an unreviewed NPI import gets flagged, instead of letting it
            // silently render differently from its siblings forever.
            const missingRequired = fields.filter(f => {
              const req = typeof f.required === "function" ? f.required(item) : f.required;
              return req && !item[f.key];
            });
            const needsReview = (item.npiImported && !item.expirationDate && !nonExpiring) || missingRequired.length > 0;
            const showAllDivider = idx === flaggedCount && flaggedCount > 0 && flaggedCount < shownItems.length;
            return (
              <div key={item.id}>
              {showAllDivider && (
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.6, margin: "8px 0 -2px" }}>
                  All records
                </div>
              )}
              <div onClick={() => setViewItem(item)} style={{
                backgroundColor: T.card, border: `1px solid ${needsReview ? T.danger : T.border}`,
                borderRadius: 14, padding: "14px 16px",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                boxShadow: T.shadow1, cursor: "pointer",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                  {needsReview ? <StatusDot color="red" /> : item.expirationDate ? <StatusDot color={color} /> : null}
                  <div style={{ minWidth: 0 }}>
                    {/* The green TYPE always leads \u2014 it is the card's header.
                        The white line beneath carries only the specifics (the
                        canonical title minus its type prefix), and the dim
                        sub-line only what neither line already said. */}
                    {(() => {
                      const cardTitle = describeItem(item, data.settings.name, sectionKey) || "Untitled";
                      let mainLine = cardTitle;
                      if (item.type && cardTitle.toLowerCase().startsWith(String(item.type).toLowerCase())) {
                        mainLine = cardTitle.slice(String(item.type).length).replace(/^\s*\u2014\s*/, "");
                      }
                      const said = (v) => v != null && (
                        cardTitle.toLowerCase().includes(String(v).toLowerCase())
                        || String(item.type || "").toLowerCase() === String(v).toLowerCase()
                      );
                      return (
                        <>
                          {item.type && (
                            <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 1 }}>
                              {item.type}
                            </div>
                          )}
                          {mainLine && (
                            <div style={{
                              fontSize: 15, fontWeight: 600, color: T.text,
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                              {mainLine}
                            </div>
                          )}
                          <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                            {(() => {
                              const fmtMoney = (n) => `$${parseFloat(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                              return [
                                ...[item.state, shortFacility(item.facility, data.locumContracts), item.provider, item.institution, item.licenseNumber, item.policyNumber, item.number]
                                  .filter(Boolean).filter(v => !said(v)),
                                parseFloat(item.cost) > 0 && `${fmtMoney(item.cost)}/yr`,
                                parseFloat(item.renewalCost) > 0 && `${fmtMoney(item.renewalCost)} renewal`,
                                item.graduationDate && !item.expirationDate && ("Graduated " + new Date(item.graduationDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" })),
                                item.expirationDate && getStatusLabel(item.expirationDate),
                                nonExpiring && "Does not expire",
                              ].filter(Boolean).join(" \u00b7 ");
                            })()}
                          </div>
                        </>
                      );
                    })()}
                    {needsReview && (
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.danger, marginTop: 3 }}>
                        {missingRequired.length > 0
                          ? `Needs review — tap edit to add ${missingRequired.map(f => resolveFieldProp(f, "label", item)).join(", ")}`
                          : "Needs review — tap edit to add expiration date, issued date, and verify details"}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(CrudSection);
