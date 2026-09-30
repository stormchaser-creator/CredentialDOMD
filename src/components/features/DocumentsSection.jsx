import { useMemo, useState, useRef, useCallback, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { pushModal, popModal } from "../../utils/deskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import EmptyState from "../shared/EmptyState";
import { UploadIcon, CameraIcon, TrashIcon } from "../shared/Icons";
import { SECTION_META } from "../../constants/credentialTypes";
import { generateId, downscalePhoto, copyToClipboard, plainLabel } from "../../utils/helpers";
import { bundleShareText } from "../../utils/shareText";
import { canonicalState } from "../../utils/snapOption";
import { analyzeDocument, analyzePDF, analyzeDocText, CV_DOC_TYPE, OTHER_DOC_TYPE } from "../../utils/documentScanner";
import { liveCategories, findCategory, buildCategory, packRecord, categoryLabelFor } from "../../utils/customCategories";
import { useAiAvailable, describeAiStatus } from "../../utils/aiClient";
import { isOfficeFile, extractOfficeText, mimeFromName, UPLOAD_ACCEPT } from "../../utils/officeText";
import { screenDocument, phiWarningText } from "../../utils/phiGuard";
import ScanReviewCard from "./ScanReviewCard";
import CvImportReview from "./CvImportReview";
import Modal from "../shared/Modal";
import { dismissButtonStyle } from "../shared/actionButton";
import { CME_INBOX_ADDRESS, DOCS_INBOX_ADDRESS, isInboxDoc, docMime, leaveInbox } from "../../utils/inboxDocs";
import { isReadableDoc, contractFromScan } from "../../utils/docPrefill";
import { docAttachedLabel } from "../../utils/docLabel";
import { SECTIONS } from "./HomeSearch";
import { RECEIPT_DOC_TYPE, normalizeReceipt, receiptToExpense, receiptToDeduction } from "../../utils/receiptScan";
import { checkStorageQuota } from "../../utils/storageQuota";
import { spreadsheetGuard, withRefusals } from "../../utils/spreadsheetGuard";
import { isIdentityLink } from "../../utils/pausedApplicationRecords.js";
import { isArchived } from "../../utils/contractsForDate";
import { deviceZone } from "../../utils/coverageBlocks";
import { supabase, uploadDocumentFile } from "../../lib/supabase";
import { relinkCorrection, keepCorrection, recordCorrection } from "../../utils/intakeCorrections";
import { alertWriteRefused, scopesForWrite } from "../../utils/limitedLaunchAccess.js";
import { documentMime } from "../../utils/syncRules.js";

// Section a linked document belongs to -> the scan category that styles its
// "Linked" badge. Receipts link to the money row they became.
const LINKED_META_KEY = {
  licenses: "license", cme: "cme", privileges: "privilege", insurance: "insurance",
  healthRecords: "healthRecord", education: "education", locumContracts: "agreement",
  travelDocs: "travel", travelExpenses: RECEIPT_DOC_TYPE, deductibles: RECEIPT_DOC_TYPE,
  customRecords: "other",
};

// ─── The gate every stored file passes (Upload, Camera, "Upload it again") ──
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
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
]);
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|pdf|docx?|xlsx?|csv|txt|rtf)$/i;

/**
 * What a file must pass before it is read into memory or stored: the size
 * limit, a type this app reads, a spreadsheet naming a patient identifier,
 * and an Office file whose own words read as a patient record. Returns
 * { refused } with what to say, or { warning, type }: the warning (null when
 * there is nothing to say) and the MIME type the file is stored and read as.
 *
 * A picker that hands over no type, or application/octet-stream (some
 * browsers do for .docx/.xlsx, Android and Drive for anything), says nothing:
 * the name decides, and the file is stored and read as what its name says. A
 * .zip or .bin labelled that way used to be stored silently, unread. The type
 * is never blank either: the cloud row's mime_type is NOT NULL.
 */
async function checkBeforeRead(file) {
  if (file.size > MAX_FILE_SIZE) return { refused: `"${file.name}" exceeds the 10 MB size limit.` };
  const generic = !file.type || file.type === "application/octet-stream";
  if (generic ? !ALLOWED_EXT.test(file.name || "") : (!ALLOWED_TYPES.has(file.type) && !ALLOWED_EXT.test(file.name || ""))) {
    return { refused: `"${file.name}" isn't a file type this app reads (${file.type || "unknown type"}). Photos, PDFs, Word, Excel, CSV and text work.` };
  }
  const type = generic ? (mimeFromName(file.name) || documentMime(file)) : file.type;
  // A spreadsheet whose header row names a patient identifier (MRN,
  // patient name, DOB, SSN...) is refused here, before it is read or
  // stored, with the column named (utils/spreadsheetGuard.js).
  const sheetRefusal = await spreadsheetGuard(file);
  if (sheetRefusal) return { refused: `"${file.name}" was not uploaded. ${sheetRefusal}` };
  // Anything we can read before storing gets screened first — a patient
  // chart must never reach the server, so refusing beats deleting.
  if (isOfficeFile(file)) {
    try {
      const preview = await extractOfficeText({ name: file.name, type: file.type, file });
      const screen = screenDocument(`${file.name}\n${preview}`);
      if (screen?.level === "clinical") return { refused: `"${file.name}" was not uploaded. ${phiWarningText(screen)}` };
      if (screen) return { warning: phiWarningText(screen), type };
    } catch { /* unreadable — the normal path will report it */ }
  }
  return { warning: null, type };
}

// The file's bytes as a data URL carrying `type` (checkBeforeRead), so the
// scanner, the viewer and the upload all see a PDF as a PDF.
function readAsDataUrl(file, type = file.type) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const read = String(e.target.result);
      resolve(type && type !== file.type ? read.replace(/^data:[^;,]*/, `data:${type}`) : read);
    };
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

const isScannable = (file, type = file.type) => type.startsWith("image/") || type === "application/pdf" || isOfficeFile(file);

// The AI read of a file already in memory. An Office file's own words ride
// along with its scan: an agreement's coverage times the model left out are
// filled from them at save.
async function readScan(file, dataUrl, type, deg, apiKey, scanHints) {
  const text = isOfficeFile(file) ? await extractOfficeText({ name: file.name, type: file.type, file }) : "";
  const result = isOfficeFile(file)
    ? await analyzeDocText(text, deg, apiKey, scanHints)
    : type === "application/pdf"
      ? await analyzePDF(dataUrl, deg, apiKey, scanHints)
      : await analyzeDocument(dataUrl, deg, apiKey, scanHints);
  return { result, text };
}

// What the read found, judged before the file is stored.
function screenScan(file, result) {
  const screen = result ? screenDocument(`${file.name}\n${JSON.stringify(result)}`) : null;
  if (screen?.level === "clinical") return { refused: `"${file.name}" was not uploaded. ${phiWarningText(screen)}` };
  return { warning: screen ? phiWarningText(screen) : null };
}

function DocumentsSection() {
  const { data, setData, addItem, canAddItem, confirmCanAddItem, editItem, updateSection, deleteItem: deleteItemCtx, updateSettings, theme: T, navigate, userIdRef, user } = useApp();
  // A document that came by email and is filed, moved or kept plain here is
  // the physician correcting what email intake did with it; the next reading
  // of their mail learns from it (utils/intakeCorrections.js). Fire and
  // forget: nothing here waits on it or fails because of it.
  const noteIntakeCorrection = (row) => { if (row) recordCorrection(supabase, userIdRef?.current, row); };
  const iS = useInputStyle();
  // The physician's own category names, so the scanner files a second badge
  // where the first went instead of inventing a near-duplicate.
  const scanHints = useMemo(() => ({ categories: liveCategories({ customCategories: data.customCategories }).map(c => c.name) }), [data.customCategories]);
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
  // "Saved to Practice > Expenses" style confirmation with a button to open the
  // destination: a receipt files somewhere other than the Credentials tab.
  const [filed, setFiled] = useState(null);
  // A CV is not one credential, so it never joins the scan queue. It is
  // offered to the CV import instead: {docId, dataUrl, fileName, mime}.
  const [cvOffer, setCvOffer] = useState(null);
  const [cvOpen, setCvOpen] = useState(false);

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
    // A file linked to Protected Identity never goes out in a bundle.
    const docs = data.documents.filter(d => selectedIds.has(d.id) && !isIdentityLink(d.linkedTo));
    if (docs.length === 0) return;
    const missing = docs.filter(d => !d.data);
    if (missing.length > 0) {
      setBundleMsg(`${missing.length} file(s) haven't downloaded to this device yet. Try again in a moment.`);
      return;
    }
    const built = docs.map(doc => {
      try {
        const [head, b64] = doc.data.split(",");
        const mime = docMime(doc) || head.match(/data:(.*?)[;,]/)?.[1] || "application/octet-stream";
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new File([arr], doc.name || "document", { type: mime });
      } catch { return null; }
    });
    const files = built.filter(Boolean);
    if (!files.length) {
      setBundleMsg("Those files could not be read on this device. Open one to check it, then try again.");
      return;
    }
    // The letter and blurb list only what actually rides in the share.
    const sentDocs = docs.filter((_, i) => built[i]);

    // iOS Mail promotes the first text line to the subject and strips
    // newlines from a share that carries files: share a flowing blurb, and
    // put the formatted letter on the clipboard (the sender is told below).
    const { title, letter, blurb } = bundleShareText(data.settings, sentDocs);
    let letterCopied = false;
    try { letterCopied = await copyToClipboard(letter); } catch { /* clipboard unavailable */ }

    if (navigator.share && navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files, title, text: blurb });
      } catch (err) {
        if (err?.name === "AbortError") return;
        setBundleMsg("Sharing failed. Try fewer or smaller files.");
        return;
      }
    } else {
      setBundleMsg("This browser can't attach files to a share. Use the app on your phone, or send documents individually.");
      return;
    }
    addItem("shareLog", {
      id: generateId(),
      itemId: null,
      itemName: `Packet (${files.length} documents)`,
      section: "documents", method: "share", recipient: "",
      sentAt: new Date().toISOString(),
    });
    setBundleMsg(`Sent ${files.length} documents as one packet.${letterCopied ? " The formatted cover letter is on your clipboard if you want to paste it over the short intro." : ""}`);
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
    } catch {
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

  // Canonical labels, the same ones the cards use: a scanned Display Name is
  // often the physician's own name, which made every licence read alike here.
  const physicianName = data.settings?.name;
  const linkables = [
    ...data.licenses.map(l => ({ value: `licenses:${l.id}`, label: `License: ${plainLabel(l, physicianName, "licenses")}` })),
    ...data.privileges.map(p => ({ value: `privileges:${p.id}`, label: `Privilege: ${plainLabel(p, physicianName, "privileges")}` })),
    ...data.insurance.map(i => ({ value: `insurance:${i.id}`, label: `Insurance: ${plainLabel(i, physicianName, "insurance")}` })),
    ...data.cme.map(c => ({ value: `cme:${c.id}`, label: `CME: ${c.title || c.category}` })),
    ...(data.healthRecords || []).map(h => ({ value: `healthRecords:${h.id}`, label: `Health: ${h.name || h.type || h.category}` })),
    ...(data.education || []).map(e => ({ value: `education:${e.id}`, label: `Education: ${e.name || e.type || e.institution}` })),
    // Archived agreements stay linkable (an old agreement's paperwork still
    // belongs to it) but say so and come after the current ones.
    ...[...(data.locumContracts || [])].sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)))
      .map(c => ({ value: `locumContracts:${c.id}`, label: `Agreement: ${c.facility || "Contract"}${isArchived(c) ? " (archived)" : ""}` })),
    ...(data.travelExpenses || []).map(e => ({ value: `travelExpenses:${e.id}`, label: `Expense: ${e.category || "Expense"}${e.vendor ? ` - ${e.vendor}` : ""}${e.date ? ` (${e.date})` : ""}` })),
    ...(data.deductibles || []).map(d => ({ value: `deductibles:${d.id}`, label: `Deduction: ${d.merchant || d.description || d.category || "Deduction"}${d.date ? ` (${d.date})` : ""}` })),
  ];

  const handleFiles = useCallback(async (files) => {
    if (!requireApiKey()) return;
    setScanError(null);
    const MAX_BATCH = 10;
    const fileList = Array.from(files).slice(0, MAX_BATCH);
    // The whole batch against the account's 2 GB line, before anything is
    // read into memory or uploaded.
    const quota = checkStorageQuota(data.documents, fileList);
    if (!quota.ok) { setScanError(quota.message); return; }
    // Every file the pick did not store, said once and kept: one message
    // slot would let the next file's words replace a refusal before anyone
    // read it (spreadsheetGuard.withRefusals, as DocAttach and the record
    // forms do). Shown as they happen, and again ahead of whatever the last
    // file said once the pick is done.
    const refused = [];
    const refuse = (text) => { refused.push(text); setScanError(refused.join(" ")); };
    // A stop ends the pick: what it says follows every refusal, once.
    const stop = (text) => setScanError(withRefusals([...refused, text]));
    if (files.length > MAX_BATCH) refuse(`Only the first ${MAX_BATCH} files will be processed.`);
    for (const file of fileList) {
      const gate = await checkBeforeRead(file);
      if (gate.refused) { refuse(gate.refused); continue; }
      if (gate.warning) setScanError(gate.warning);
      const type = gate.type;

      const dataUrl = await readAsDataUrl(file, type);

      const docId = generateId();
      const dup = (data.documents || []).find(d =>
        (d.data && d.data.length === dataUrl.length && d.data === dataUrl) ||
        (d.name === file.name && d.size === file.size)
      );
      if (dup) {
        refuse(`"${file.name}" is already uploaded${dup.linkedTo ? " (and linked)" : ", find it below and use File with AI"}. Skipped duplicate.`);
        continue;
      }
      const candidate = {
        id: docId, name: file.name, type, size: file.size,
        data: dataUrl, uploadedAt: new Date().toISOString(), linkedTo: "",
      };
      const scannable = isScannable(file, type);
      // An image or a PDF can only be judged once it has been read, so it is
      // read BEFORE it is stored: a patient record found here never reaches
      // the bucket or the database at all. It used to be stored first and
      // deleted after the read, and that delete could run before the upload
      // landed (a slow connection) or before a queued re-upload replayed,
      // leaving the chart on the server behind a tombstone.
      let result = null;
      let text = "";
      let readError = null;
      if (scannable && aiOn) {
        // A file that could not be saved is never sent to be read: the
        // reading costs money and its result would have nowhere to go.
        // Nor on a membership answer that is only old: the check it needs
        // answers first, so a read is never paid for a save it then refuses.
        if ((canAddItem && !canAddItem("documents", candidate))
          || (confirmCanAddItem && !(await confirmCanAddItem("documents", candidate)))) {
          alertWriteRefused({ scope: scopesForWrite("documents", candidate), section: "documents" });
          stop(`"${file.name}" was not saved, so it was not read. Nothing was changed.`);
          return;
        }
        setScanning(true);
        try {
          ({ result, text } = await readScan(file, dataUrl, type, deg, apiKey, scanHints));
        } catch (err) {
          readError = err;
        }
        setScanning(false);
        const screened = screenScan(file, result);
        if (screened.refused) { refuse(screened.refused); continue; }
        if (screened.warning) setScanError(screened.warning);
      }

      // Refused (membership being re-checked; addItem has said why), the rest
      // of the pick stops.
      if (addItem("documents", candidate) === false) {
        stop(`"${file.name}" was not saved${result ? "" : ", so it was not read"}. Nothing was changed.`);
        return;
      }

      if (result) {
        // A CV holds many records across many sections, and this queue
        // files one record into one section. It goes to the CV import.
        if (result.documentType === CV_DOC_TYPE) {
          setCvOffer({ docId, dataUrl, fileName: file.name, mime: type });
          continue;
        }
        setScanQueue(q => [...q, { result, imageData: dataUrl, fileName: file.name, docId, text }]);
      } else if (readError) {
        setScanError(readError.message || "Analysis failed. Document has been saved to your files.");
      } else if (!aiOn && scannable) {
        setScanError(`Document saved but could not be analyzed. ${describeAiStatus(data.settings)}`);
      } else if (!scannable) {
        // Stored, never silently: say that nothing will read it.
        setScanError(`"${file.name}" was saved to your files, but it cannot be read automatically. Link it to a record below.`);
      }
    }
    if (refused.length) setScanError(withRefusals(refused));
  }, [apiKey, aiOn, deg, addItem, canAddItem, confirmCanAddItem, data.documents, data.settings, requireApiKey, scanHints]);

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

  const handleSave = (docType, fields, _imageData, _fileName, docId, scanText = "") => {
    const id = generateId();
    // A banner from an earlier card never describes this one.
    setFiled(null);
    if (docType === RECEIPT_DOC_TYPE) {
      // Same rows the Expenses form and the statement importer write; the
      // receipt file links to the row so it rides along on the expense invoice.
      const { destination, agency, ...rest } = fields;
      const receipt = normalizeReceipt(rest);
      const toExpense = destination === "expense";
      const section = toExpense ? "travelExpenses" : "deductibles";
      const entry = toExpense ? receiptToExpense(receipt, { id, agency }) : receiptToDeduction(receipt, { id });
      if (addItem(section, entry) === false) { setScanError("Could not save that receipt. Nothing was changed."); return; }
      const doc = data.documents.find(d => d.id === docId);
      if (doc) {
        noteIntakeCorrection(relinkCorrection(doc, `${section}:${id}`, { scanType: docType }));
        editItem("documents", { ...doc, ...leaveInbox(doc), linkedTo: `${section}:${id}` });
      }
      const money = `$${entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      setFiled(toExpense
        ? { text: `Saved ${entry.category}${entry.vendor ? `, ${entry.vendor}` : ""}, ${money} to Practice > Expenses, billable to ${entry.agency}. The receipt is attached and goes out with the expense invoice.`, label: "Open Expenses", tab: "locum", sub: "expenses" }
        : { text: `Saved ${money} to the deduction ledger as ${entry.category}${entry.taxYear ? ` for ${entry.taxYear}` : ""}. It is in the tax estimate now.`, label: "Open Deductions", tab: "more", sub: "finance:deductions" });
      setScanQueue(q => q.filter(item => item.docId !== docId));
      return;
    }
    if (docType === OTHER_DOC_TYPE) {
      const now = new Date().toISOString();
      let category = fields?.mode === "existing"
        ? (data.customCategories || []).find(c => c.id === fields.categoryId)
        // A card saved a moment ago may already have created it: reuse, never twin.
        : findCategory(data.customCategories, fields?.newCategory?.name);
      if (!category && fields?.mode !== "existing") {
        try { category = buildCategory(fields?.newCategory || {}, { id: generateId(), origin: "uploader", now }); }
        catch (e) { setScanError(e.message); return; }
        if (addItem("customCategories", category) === false) { setScanError("Could not create that category. Nothing was changed."); return; }
      }
      if (!category) { setScanError("That category no longer exists. Pick another one."); return; }
      // Filing into a category the physician hid brings it back, rather than
      // putting the record somewhere they cannot see it.
      if (category.archivedAt && editItem("customCategories", { ...category, archivedAt: null }) === false) {
        setScanError("Could not show that category again. Nothing was changed."); return;
      }
      const { record, withheld } = packRecord(category, { ...(fields?.record || {}), documentIds: docId ? [docId] : [] }, { id });
      if (addItem("customRecords", record) === false) { setScanError("Could not save this record. The file is still in Documents."); return; }
      const doc = data.documents.find(d => d.id === docId);
      if (doc) {
        noteIntakeCorrection(relinkCorrection(doc, `customRecords:${id}`, { scanType: docType }));
        editItem("documents", { ...doc, ...leaveInbox(doc), linkedTo: `customRecords:${id}` });
      }
      setFiled({
        text: `Filed in ${category.name}.${withheld.length ? " Patient identifiers, SSNs and full birth dates were left out." : ""}`,
        label: `Open ${category.name}`, tab: "credentials", sub: `custom:${category.id}`,
      });
      setScanQueue(q => q.filter(item => item.docId !== docId));
      return;
    }
    if (docType === CV_DOC_TYPE) {
      setScanError("A CV holds many records at once, so it is not filed as one. Use Start from your CV.");
      return;
    }
    const section = SECTION_META[docType]?.section;
    if (!section) {
      setScanError(`Cannot file "${docType}": this app version doesn't know that category. Update the app (reload) and re-scan.`);
      return;
    }
    // facts and suggestedCategory come only from an "other" read and are never
    // columns; written as keys they would reject the whole record.
    const { facts: _facts, suggestedCategory: _suggested, ...kept } = fields || {};
    const entry = { ...kept, id };
    // The review card already snapped the state; a caller that skipped it
    // still never stores "North Dakota" where every lookup expects "ND".
    if ((section === "licenses" || section === "privileges") && typeof entry.state === "string" && entry.state) {
      entry.state = canonicalState(entry.state) || entry.state;
    }
    if (section === "cme" && !entry.topics) entry.topics = [];
    if (section === "locumContracts") {
      // Contract terms drive billing math: numbers with defaults, and the
      // coverage blocks the way the Contracts form saves them, with any time
      // the model left out filled from an Office file's own words and this
      // device's zone on a block with times (docPrefill.js contractFromScan).
      const shaped = contractFromScan(entry, { text: scanText, zone: deviceZone() });
      if (shaped.problem) { setScanError(shaped.problem); return; }
      Object.assign(entry, shaped.entry);
    }

    // Add the credential entry. Refused, the review card stays to save again.
    if (addItem(section, entry) === false) { setScanError("Could not save this record. The file is still in Documents."); return; }
    // Link the document to it (an emailed certificate leaves the inbox here)
    const doc = data.documents.find(d => d.id === docId);
    if (doc) {
      noteIntakeCorrection(relinkCorrection(doc, `${section}:${id}`, { scanType: docType }));
      editItem("documents", { ...doc, ...leaveInbox(doc), linkedTo: `${section}:${id}` });
    }
    // Where it went, and a way to open it: a contract lives under Work, the
    // rest under Credentials (HomeSearch SECTIONS), and the record opens
    // itself when the section renders (App's navRecord).
    const home = SECTIONS.find(x => x.key === section);
    const kind = SECTION_META[docType]?.label || "record";
    setFiled({
      text: `Saved to ${home?.label || kind}.`, label: `Open ${kind}`,
      tab: home?.tab || "credentials", sub: home ? home.sub : section, record: { sec: section, id },
    });

    setScanQueue(q => q.filter(item => item.docId !== docId));
  };

  // "Keep as plain document": the file stays in Documents, unfiled. For a
  // document that came by email, that is a correction.
  const handleDiscard = (docId) => {
    const item = scanQueue.find(i => i.docId === docId);
    const doc = data.documents.find(d => d.id === docId);
    noteIntakeCorrection(keepCorrection(doc, {
      scanType: item?.result?.documentType || "",
      suggested: item?.result?.extracted?.suggestedCategory?.name || SECTION_META[item?.result?.documentType]?.section || "",
    }));
    setScanQueue(q => q.filter(i => i.docId !== docId));
  };

  // "Delete this file": the wrong upload taken back out, asked first with the
  // same words as the trash button. deleteItem removes the Storage object
  // and leaves the tombstone.
  const deleteFromReview = (docId) => {
    if (!window.confirm("Delete this document? This cannot be undone.")) return;
    deleteItemCtx("documents", docId);
    setScanQueue(q => q.filter(i => i.docId !== docId));
  };

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
      const text = isOfficeFile(doc) ? await extractOfficeText({ name: doc.name, type: mime, dataUrl: doc.data }) : "";
      const result = isOfficeFile(doc)
        ? await analyzeDocText(text, deg, apiKey, scanHints)
        : isPdf
          ? await analyzePDF(doc.data, deg, apiKey, scanHints)
          : await analyzeDocument(doc.data, deg, apiKey, scanHints);
      // The same screen the upload path runs once a file is read. A file
      // stored through a record form's attach control, or kept by email
      // intake for the physician to judge, reaches here unscreened. It is
      // already the physician's, so removing it is asked, not done; either
      // way a patient chart is never offered for filing.
      const screen = screenDocument(`${doc.name}\n${text ? `${text}\n` : ""}${JSON.stringify(result)}`);
      if (screen?.level === "clinical") {
        if (window.confirm(`"${doc.name}" looks like a patient record. CredentialDOMD holds your credentials, not patient charts. Delete it from your files?`)) {
          deleteItemCtx("documents", doc.id);
          setScanError(`"${doc.name}" was removed. ${phiWarningText(screen)}`);
        } else {
          setScanError(`"${doc.name}" was not filed. ${phiWarningText(screen)}`);
        }
        setScanning(false);
        return;
      }
      if (screen) setScanError(phiWarningText(screen));
      // Same branch as the upload path: a CV rescanned here would otherwise
      // render a fieldless review card whose Save has nowhere to file it.
      if (result.documentType === CV_DOC_TYPE) {
        setCvOffer({ docId: doc.id, dataUrl: doc.data, fileName: doc.name, mime: docMime(doc) });
      } else {
        setScanQueue(q => q.some(i => i.docId === doc.id) ? q : [...q, { result, imageData: doc.data, fileName: doc.name, docId: doc.id, text }]);
      }
    } catch (err) {
      setScanError(err.message || "Could not read this document.");
    }
    setScanning(false);
  }, [apiKey, deg, requireApiKey, scanHints, deleteItemCtx]);
  // A document whose file Storage does not have (fileMissing, set by
  // AppContext reconcileDocumentFiles) can be given its file again: same
  // document, same id, the file and the whole row written in one step.
  const reuploadRef = useRef(null);
  const [reuploadId, setReuploadId] = useState(null);
  // The new file passes the same gate as any upload before it is stored:
  // AI on, the 2 GB line and the size limit, the spreadsheet guard, the
  // patient-record screens (the Office text and the read), and not a file
  // already stored as another document.
  const reuploadFile = useCallback(async (docId, file) => {
    const doc = (data.documents || []).find(d => d.id === docId);
    if (!doc || !file) return;
    if (!requireApiKey()) return;
    setScanError(null);
    const others = (data.documents || []).filter(d => d.id !== docId);
    const quota = checkStorageQuota(others, [file]);
    if (!quota.ok) { setScanError(quota.message); return; }
    let dataUrl;
    let type;
    try {
      const gate = await checkBeforeRead(file);
      if (gate.refused) { setScanError(gate.refused); return; }
      if (gate.warning) setScanError(gate.warning);
      type = gate.type;
      dataUrl = await readAsDataUrl(file, type);
    } catch {
      setScanError(`"${file.name}" could not be read. Nothing was changed.`);
      return;
    }
    const dup = others.find(d => (d.data && d.data === dataUrl) || (d.name === file.name && d.size === file.size));
    if (dup) { setScanError(`"${file.name}" is already stored as another document. Pick the file that belongs to "${doc.name}".`); return; }
    if (isScannable(file, type) && aiOn) {
      const candidate = { ...doc, data: dataUrl, type, size: file.size };
      // A file that could not be saved is never sent to be read, nor on a
      // membership answer that is only old until its check has answered.
      if ((canAddItem && !canAddItem("documents", candidate))
        || (confirmCanAddItem && !(await confirmCanAddItem("documents", candidate)))) {
        alertWriteRefused({ scope: scopesForWrite("documents", candidate, doc), section: "documents" });
        setScanError(`"${file.name}" was not saved, so it was not read. Nothing was changed.`);
        return;
      }
      let result = null;
      setScanning(true);
      try { ({ result } = await readScan(file, dataUrl, type, deg, apiKey, scanHints)); } catch { /* unread, like any upload whose read failed */ }
      setScanning(false);
      const screened = screenScan(file, result);
      if (screened.refused) { setScanError(screened.refused); return; }
      if (screened.warning) setScanError(screened.warning);
    }
    // No storagePath: the upload below writes the new one, and until then
    // the cache keeps these bytes (they may be the only copy). Kept on this
    // device first, never sent as an edit: an edit that landed while the
    // upload failed made the cloud row look newer than these bytes, and the
    // next load then kept the row with no file. pendingUpload (a device note,
    // never sent) makes the next load upload them even if the document is
    // edited meanwhile, here or on another device.
    const next = { ...doc, data: dataUrl, type, size: file.size, fileMissing: undefined, storagePath: undefined, pendingUpload: true, updatedAt: new Date().toISOString() };
    if (!updateSection("documents", items => (items || []).map(x => (x.id === docId ? next : x)))) {
      alertWriteRefused({ scope: scopesForWrite("documents", next, doc), section: "documents" });
      return;
    }
    // Refused by the membership check this save waited for (the answer was
    // only old, and the membership is read-only now): the new file was taken
    // back off this device, and the member was told so then. It is not on
    // this device and nothing will send it, so nothing more is said here.
    let refused = false;
    const path = await uploadDocumentFile(next, user?.id, userIdRef?.current).catch((error) => {
      if (error?.code === "membership_read_only") refused = true;
      return null;
    });
    if (refused) return;
    if (path) {
      // Any screen warning above stays on screen.
      setData(d => ({ ...d, documents: (d.documents || []).map(x => (x.id === docId ? { ...x, storagePath: path, pendingUpload: undefined } : x)) }));
    } else {
      setScanError(`"${doc.name}" is back on this device. It goes to your account the next time the app opens online.`);
    }
  }, [data.documents, requireApiKey, aiOn, canAddItem, confirmCanAddItem, deg, apiKey, scanHints, updateSection, setData, user?.id, userIdRef]);
  // Full-screen viewing: images get a lightbox, PDFs open in a viewer sheet
  const [lightbox, setLightbox] = useState(null);
  // Escape must close the lightbox, not the modal underneath it: capture
  // phase so this runs before Modal's own document-level Escape handler.
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
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/pdf" }));
    window.open(url, "_blank");
  }, []);

  const deleteDoc = (id) => { if (window.confirm("Delete this document? This cannot be undone.")) deleteItemCtx("documents", id); };
  // Link, move or unlink. A file moved off one of the physician's own
  // records also leaves that record's documentIds, as Vera's update_document
  // does; otherwise reconcileDocumentLinks restores the old link on the next
  // load. Unlinking never changes the type (leaveInbox only on a real link).
  const linkDoc = (id, val) => {
    const doc = data.documents.find(d => d.id === id);
    if (!doc) return;
    const prev = String(doc.linkedTo || "");
    if (prev === val) return;
    noteIntakeCorrection(relinkCorrection(doc, val));
    editItem("documents", { ...doc, ...(val ? leaveInbox(doc) : {}), linkedTo: val });
    if (prev.startsWith("customRecords:")) {
      const owner = (data.customRecords || []).find(r => `customRecords:${r.id}` === prev);
      if (owner && Array.isArray(owner.documentIds) && owner.documentIds.includes(doc.id)) {
        editItem("customRecords", { ...owner, documentIds: owner.documentIds.filter(x => x !== doc.id) });
      }
    }
  };

  // Emailed files that were not filed on arrival first, everything else after.
  const inboxDocs = data.documents.filter(isInboxDoc);
  const storedDocs = data.documents.filter(d => !isInboxDoc(d));

  // One document card. Shared by the inbox group and the stored list.
  const renderDoc = (doc) => {
    const sectionKey = doc.linkedTo?.split(":")[0];
    const baseMeta = doc.linkedTo ? SECTION_META[LINKED_META_KEY[sectionKey] || "unknown"] : null;
    const customRec = sectionKey === "customRecords"
      ? (data.customRecords || []).find(r => `customRecords:${r.id}` === doc.linkedTo) : null;
    const customHome = customRec ? categoryLabelFor(data, customRec) : null;
    const linkedMeta = baseMeta && customHome ? { ...baseMeta, label: customHome } : baseMeta;

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
            <button aria-label={`Delete ${doc.name || "document"}`} onClick={() => deleteDoc(doc.id)} style={{ padding: "6px 8px", minWidth: 32, minHeight: 32, borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><TrashIcon /></button>
          )}
        </div>
        {doc.fileMissing && !doc.data ? (
          <div role="status" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: T.danger, flex: "1 1 200px" }}>This file is missing from your account. Upload it again or delete this entry.</span>
            {!selectMode && (
              <button onClick={() => { if (!requireApiKey()) return; setReuploadId(doc.id); reuploadRef.current?.click(); }} style={{
                padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input,
                color: T.text, fontSize: 16, fontWeight: 600, cursor: "pointer",
              }}>Upload it again</button>
            )}
          </div>
        ) : !doc.data && doc.storagePath && (
          <div style={{ marginTop: 6, fontSize: 12, color: T.textDim }}>
            {doc.linkedTo ? "Fetching the file from your account." : "Fetching the file from your account. File with AI appears when it is here."}
          </div>
        )}
        {/* The picker links, moves and unlinks. A file on Protected Identity
            is never offered a move into a section that can be shared. */}
        {!isIdentityLink(doc.linkedTo) && (
          <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            {!doc.linkedTo && doc.data && isReadableDoc(doc) && (
              <button onClick={() => rescanDoc(doc)} disabled={scanning} style={{
                flexShrink: 0, padding: "7px 12px", minHeight: 32, borderRadius: 8, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>
                {scanning ? "Reading…" : "File with AI"}
              </button>
            )}
            <select value={doc.linkedTo || ""} onChange={e => linkDoc(doc.id, e.target.value)} aria-label={doc.linkedTo ? "Move or unlink this file" : "Link this file to a record"}
              style={{ ...iS, padding: "6px 10px", appearance: "auto", flex: 1, minWidth: 0 }}>
              <option value="">{doc.linkedTo ? "Unlinked" : "Link to credential..."}</option>
              {/* A link the list does not offer (one of the physician's own
                  records, a screening) is still the one selected. */}
              {doc.linkedTo && !linkables.some(l => l.value === doc.linkedTo) && (
                <option value={doc.linkedTo}>{docAttachedLabel(doc, data) || "Current link"}</option>
              )}
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
            marginTop: 8, padding: "7px 12px", minHeight: 32, borderRadius: 8, border: `1px solid ${T.border}`,
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
        Upload, scan, or photograph any credential document or expense receipt. AI identifies what it is, extracts the fields, and files it where it belongs: credentials to their section, receipts (tolls, rental car, rideshare, airfare, lodging, parking, meals, fuel) to Practice &gt; Expenses to bill an agency or to the deduction ledger.
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
        <input type="file" ref={reuploadRef} data-reupload="" accept={UPLOAD_ACCEPT} style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f && reuploadId) reuploadFile(reuploadId, f); setReuploadId(null); e.target.value = ""; }} />
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
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{cameraError}</div>
          <button aria-label="Dismiss notice" onClick={() => setCameraError(null)} style={{ ...dismissButtonStyle(T.danger), margin: "-6px -8px -6px 0" }}>&times;</button>
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
          <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>AI is reading and classifying your document</div>
        </div>
      )}

      {filed && (
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`, marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 14, color: T.text, lineHeight: 1.45 }}>{filed.text}</div>
          <button onClick={() => { const { tab, sub, record } = filed; setFiled(null); navigate(tab, sub, record); }} style={{
            padding: "8px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0,
          }}>{filed.label}</button>
          <button aria-label="Dismiss notice" onClick={() => setFiled(null)} style={dismissButtonStyle(T.textMuted)}>&times;</button>
        </div>
      )}

      {cvOffer && !cvOpen && (
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`, marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 14, color: T.text, lineHeight: 1.45 }}>
            {`"${cvOffer.fileName}" looks like your CV. It is saved in your files. Read it and fill in your record?`}
          </div>
          <button onClick={() => setCvOpen(true)} style={{
            padding: "8px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0,
          }}>Read my CV</button>
          <button aria-label="Dismiss notice" onClick={() => setCvOffer(null)} style={dismissButtonStyle(T.textMuted)}>&times;</button>
        </div>
      )}

      <Modal open={cvOpen} onClose={() => setCvOpen(false)} title="Start from your CV" width={880}>
        <CvImportReview
          source={cvOffer}
          onSaved={() => { setCvOffer(null); }}
          onClose={() => { setCvOpen(false); setCvOffer(null); }}
        />
      </Modal>

      {scanError && (
        <div style={{ padding: "12px 16px", borderRadius: 12, backgroundColor: T.warningDim, color: T.warning, fontSize: 14, marginBottom: 14, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{scanError}</div>
          <button aria-label="Dismiss notice" onClick={() => setScanError(null)} style={{ ...dismissButtonStyle(T.warning), margin: "-6px -8px -6px 0" }}>&times;</button>
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
              reviewId={item.docId}
              result={item.result}
              imageData={item.imageData}
              fileName={item.fileName}
              onSave={(docType, fields, img, fn) => handleSave(docType, fields, img, fn, item.docId, item.text)}
              onDiscard={() => handleDiscard(item.docId)}
              onDeleteFile={() => deleteFromReview(item.docId)}
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
            Files you emailed to {DOCS_INBOX_ADDRESS} or {CME_INBOX_ADDRESS} that could not be filed on their own. Use File with AI, or link one to a record.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inboxDocs.map(doc => renderDoc(doc))}
          </div>
        </div>
      )}

      {data.documents.length === 0 && scanQueue.length === 0 ? (
        <EmptyState icon={"\ud83d\udcc1"} title="No documents" subtitle={`Upload, scan, or photograph your credentials and expense receipts. AI will read and file them automatically. You can also forward any credential document to ${DOCS_INBOX_ADDRESS}, and CME certificates to ${CME_INBOX_ADDRESS}.`} />
      ) : storedDocs.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>
              Stored Documents ({storedDocs.length})
            </div>
            <button onClick={() => { setSelectMode(m => !m); setSelectedIds(new Set()); setBundleMsg(null); }} style={{
              padding: "6px 14px", minHeight: 32, borderRadius: 16, fontSize: 13, fontWeight: 700, cursor: "pointer",
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
        <div role="dialog" aria-modal="true" aria-label={lightbox.name || "Picture"} onClick={() => setLightbox(null)} style={{
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
