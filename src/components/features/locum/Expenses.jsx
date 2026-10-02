import { memo, useEffect, useMemo, useRef, useState } from "react";
import { editOverCurrent } from "../../../utils/formEdits";
import { cardActionSize, dismissButtonStyle, TAP_MIN } from "../../shared/actionButton";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import { useInputStyle } from "../../shared/useInputStyle";
import { generateId, formatDate, nextInvoiceNumber, deleteConfirmText, localDay, sentDay } from "../../../utils/helpers";
import { reserveInvoiceNumber, invoiceNumberUsed } from "../../../utils/invoiceNumber";
import { MARKED_SENT, SHARE_CONFIRMED, recordOnlyLine, onAnyInvoice, confirmedFromNoteNotice, noteTotalMatches, markedSentAt, markSentProblem, notRecordedMessage, closeUnrecordedQuestion, recordRefusedNotice, unrecordedHint, serverNoteRecordQuestion, pickFromNoteHint, noteTotalQuestion, markSentFromNote, noteTotalDiffers, itemsFromNote, heldByNotes, heldPickNotice, heldMark, heldCheckedNotice } from "../../../utils/invoiceRecord";
import { handOffInvoice, keepSentInvoiceNote, watchUnanswered, shareAnswered, reportHandoffEvent } from "../../../utils/invoiceHandoff";
import { markInvoiceBusy } from "../../../utils/invoiceBusy";
import useHeldSync from "../../shared/useHeldSync";
import InvoiceMarkSent, { UnrecordedNotes } from "../../shared/InvoiceMarkSent";
import useUnrecordedInvoices, { useUnloadWarning } from "../../shared/useUnrecordedInvoices";
import { invoicePdfFile } from "../../../utils/invoicePdf";
import {
  money, INVOICE_COVER_ON_CLIPBOARD, INVOICE_COVER_FOR_EMAIL, EXPENSE_INVOICE_TERMS, expenseLineDetail, expenseReceiptLines,
} from "../../../utils/invoiceCover";
import { sendExpenseInvoiceFiles } from "../../../utils/expenseInvoiceSend";
import { confirmWriteAllowed, prepareWriteCheck, SENT_WORK, writeRefusalMessage, accessAuthority } from "../../../utils/limitedLaunchAccess.js";
import { checkStorageQuota } from "../../../utils/storageQuota";
import { TrashIcon, SendIcon, CameraIcon, UploadIcon } from "../../shared/Icons";
import { EXPENSE_CATEGORIES as CATEGORIES } from "../../../constants/expenseCategories";
import { resolveDocuments, missingReceiptMessage, attachedExpenseIds } from "../../../utils/receiptFiles";
import { downloadDocumentBlob, allocateInvoiceNumberRpc, readInvoiceRecordState } from "../../../lib/supabase";
import { checkBeforeRecord, beginRecordCheck, whenChecked, alreadyRecordedNotice, alreadyBilledNotice, uncheckedRecordNotice, uncheckedMarkNotice, sendCheckingLabel, uncheckedSendQuestion, billedElsewhereSheetNotice } from "../../../utils/invoiceRecordCheck";
import { serverBilledIn, billedOnOf, requestRecordsRefresh } from "../../../utils/serverBilling";
import { docMime } from "../../../utils/inboxDocs";
import { agencyOptions, agencyForDate, sameAgency, agencyKey } from "../../../utils/contractsForDate";
import { localDate } from "../../../utils/billing";
import { physicianLabel } from "../../../utils/invoiceArgs";
import { outgoingFileNames, renameFiles } from "../../../utils/docLabel";
import InvoiceEmailModal from "./InvoiceEmailModal";
import InvoiceEmailIt from "../../shared/InvoiceEmailIt";
import useOnline from "../../../hooks/useOnline";
import { isEmailAddress, normalizeAddress } from "../../../utils/invoiceEmail";
import { EMAILED, invoiceEmailKeys, emailDraftBody, checkBeforeEmail, emailAskNotice, emailedRecordedNotice } from "../../../utils/invoiceEmailDraft";
import { emailSendStarted, emailSendFailed, emailSendUnconfirmed, emailSendConfirmed } from "../../../utils/invoiceHandoff";

const MAX_RECEIPT_SIZE = 10 * 1024 * 1024;

// Desktop fallback when the share sheet cannot take files.
const downloadFiles = (files) => {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url; a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
};

/**
 * Travel expenses — billed to the LOCUMS AGENCY, not the hospital. Each
 * expense carries receipt photos/PDFs (stored as linked documents), and
 * "Invoice expenses" builds an expense invoice per agency and shares it
 * WITH every receipt attached, so proof travels with the bill.
 */
function Expenses() {
  const { data, addItem, editItem, deleteItem, theme: T, user, userIdRef, isDesktop } = useApp();
  const iS = useInputStyle();
  const expenses = useMemo(
    () => [...(data.travelExpenses || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [data.travelExpenses]
  );
  const contracts = useMemo(() => data.locumContracts || [], [data.locumContracts]);
  // One chip per agency: no archived or long-ended contracts, and one chip
  // for "Mossbank Healthcare" and "Mossbank Healthcare, LLC." (stored names are left
  // as they are).
  const agencies = useMemo(() => agencyOptions(contracts), [contracts]);

  const receiptsOf = (exp) => (data.documents || []).filter(d => d.linkedTo === `travelExpenses:${exp.id}`);

  // ── add / edit ──
  const [editing, setEditing] = useState(null); // "new" | expense id
  const [form, setForm] = useState({});
  // True while a new expense's agency is still the one assumed from its date:
  // changing the date then re-picks it. Kept out of `form`, which is saved
  // as the row (an unknown key would reject the whole row).
  const [agencyAuto, setAgencyAuto] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]); // receipts staged before save
  const [notice, setNotice] = useState(null);
  // Receipt bytes, resolved ahead of the tap. The tap itself must stay
  // synchronous: awaiting a download inside a click handler spends the
  // browser's user gesture, after which iOS blocks both window.open and
  // navigator.share.
  const [receiptCache, setReceiptCache] = useState({});   // docId -> File
  const [receiptState, setReceiptState] = useState("idle"); // idle | loading | ready
  const [viewer, setViewer] = useState(null);               // { url, name, file, isImage }
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);
  const showNotice = (t) => { setNotice(t); setTimeout(() => setNotice(null), 6000); };

  // The agency defaults to the one on the contract in force on the expense
  // date, not whichever contract happens to be listed first (the form used to
  // offer one agency for a trip billed to another).
  const openNew = () => {
    setEditing("new");
    setPendingFiles([]);
    const date = localDate(new Date());
    setForm({ date, category: "Airfare", agency: agencyForDate(contracts, date) });
    setAgencyAuto(true);
  };
  const setDate = (date) => setForm(f => ({ ...f, date, ...(agencyAuto ? { agency: agencyForDate(contracts, date) } : {}) }));
  const setAgency = (agency) => { setAgencyAuto(false); setForm(f => ({ ...f, agency })); };
  // Pull the receipt bytes in as soon as the editor opens, so tapping a receipt
  // is instant and, more importantly, synchronous.
  const hydrateReceipts = async (docs) => {
    if (!docs.length) { setReceiptState("ready"); return; }
    setReceiptState("loading");
    const { byId } = await resolveDocuments(docs, { download: downloadDocumentBlob });
    const next = {};
    for (const [id, r] of byId) if (r.file) next[id] = r.file;
    setReceiptCache(c => ({ ...c, ...next }));
    setReceiptState("ready");
  };

  // The expense as the edit form opened it: Save lays only what the form
  // changed over the expense as it is then (utils/formEdits.js), so one
  // billed on another device meanwhile keeps its invoice.
  const openedRef = useRef(null);
  const openEdit = (exp) => {
    openedRef.current = { ...exp };
    setEditing(exp.id); setPendingFiles([]); setForm({ ...exp }); setAgencyAuto(false);
    setReceiptState("idle");
    hydrateReceipts(receiptsOf(exp));
  };

  // Tap a receipt to open it. No await here on purpose: the File is already
  // resolved, so the gesture is still live for window.open and share.
  const openReceipt = (d) => {
    const file = receiptCache[d.id];
    if (!file) {
      showNotice(receiptState === "loading"
        ? "Still fetching this receipt, try again in a moment."
        : missingReceiptMessage([{ name: d.name || "receipt", reason: d.storagePath ? "unavailable" : "never_uploaded" }]));
      return;
    }
    // Always open a viewer rather than calling window.open. In an installed
    // PWA, window.open on a blob URL does nothing AND can still return a
    // truthy window, so a "did it work" check silently reports success while
    // the physician sees no response at all. A visible sheet cannot fail that
    // way, and it gives iOS a real button to hand the file to Files or Mail.
    const url = URL.createObjectURL(file);
    setViewer({ url, name: d.name || "Receipt", file, doc: d, isImage: docMime(d).startsWith("image/") });
  };

  const closeViewer = () => { if (viewer) URL.revokeObjectURL(viewer.url); setViewer(null); };

  // Hand the file to the operating system. Must stay synchronous from the tap:
  // the bytes are already resolved, so the user gesture is still live.
  const shareReceipt = () => {
    if (!viewer) return;
    // Named for what it is when it leaves the device (outgoingFileNames).
    const [out] = viewer.doc ? renameFiles([viewer.file], outgoingFileNames([viewer.doc], data)) : [viewer.file];
    if (navigator.canShare?.({ files: [viewer.file] })) {
      navigator.share({ files: [out], title: out.name }).catch(err => {
        if (err?.name !== "AbortError") showNotice("Your device would not open that file. Use Download instead.");
      });
      return;
    }
    const a = document.createElement("a");
    a.href = viewer.url; a.download = out.name || viewer.name; a.click();
  };
  useDeskAddShortcut(openNew);

  const stageFiles = async (files) => {
    const picked = Array.from(files || []).filter(f => f.type.startsWith("image/") || f.type === "application/pdf");
    // The Documents tab's 10 MB line, before the file is read. The documents
    // bucket refuses anything over 15 MB, and a refused upload stays queued on
    // this device with its whole data URL, so a large receipt never reached
    // the cloud and nothing said so. The other picked receipts are still staged.
    const refused = picked.filter(f => f.size > MAX_RECEIPT_SIZE).map(f => `"${f.name || "receipt"}" exceeds the 10 MB size limit.`);
    const fits = picked.filter(f => f.size <= MAX_RECEIPT_SIZE);
    // The account's 2 GB line, counting receipts already staged on this
    // expense (each carries only its data URL, which the helper measures).
    const staged = pendingFiles.map((f) => ({ name: f.name, data: f.dataUrl }));
    const quota = fits.length ? checkStorageQuota(data.documents, [...staged, ...fits]) : { ok: true, message: "" };
    // One notice per tap: a second showNotice in the same tap replaced the
    // first, so a receipt refused for size went unmentioned when the quota
    // also refused the rest.
    const said = [...refused, quota.message].filter(Boolean).join(" ");
    if (said) showNotice(said);
    if (!fits.length || !quota.ok) return;
    for (const f of fits) {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(f);
      });
      setPendingFiles(p => [...p, { name: f.name || "receipt", type: f.type, dataUrl }]);
    }
  };

  const saveExpense = () => {
    const amount = parseFloat(form.amount);
    if (!form.date || !amount || amount <= 0) { showNotice("Date and a dollar amount are the minimum."); return; }
    const id = editing === "new" ? generateId() : editing;
    const rec = {
      ...form, id, amount: Math.round(amount * 100) / 100,
      vendor: (form.vendor || "").trim(), agency: (form.agency || "").trim(),
    };
    const opened = openedRef.current?.id === editing ? openedRef.current : null;
    const now = editing === "new" ? null : (data.travelExpenses || []).find(x => x?.id === editing) || null;
    const saved = editing === "new" ? addItem("travelExpenses", rec)
      : editItem("travelExpenses", opened ? editOverCurrent(opened, rec, now) : rec);
    // Refused (membership being re-checked): the form and its staged receipt
    // photos stay, to save again; addItem has said why.
    if (saved === false) return;
    for (const f of pendingFiles) {
      addItem("documents", {
        id: generateId(), name: f.name, type: f.type,
        size: Math.round((f.dataUrl.split(",")[1] || "").length * 0.75),
        data: f.dataUrl, uploadedAt: new Date().toISOString(),
        linkedTo: `travelExpenses:${id}`,
      });
    }
    setEditing(null); setPendingFiles([]);
  };

  const removeExpense = (exp) => {
    if (exp.invoiceId) { showNotice("This expense is on an invoice. Delete the invoice first (Invoices tab) to release it."); return; }
    // Deleting an expense deletes its receipts with it (AppContext deleteItem
    // cascades to linked files: the row, the stored file and a tombstone), so
    // the confirm counts them rather than promising they stay in Files.
    if (!window.confirm(deleteConfirmText("expense", receiptsOf(exp).length, { one: "receipt", many: "receipts" }))) return;
    deleteItem("travelExpenses", exp.id);
  };

  // ── invoicing ──
  // Expenses the server has on an invoice since this copy was read (another
  // device recorded them; serverBilling.js) are billed here too: never
  // offered or sent again (2026-10-02).
  const elsewhere = serverBilledIn("travelExpenses");
  const unbilled = useMemo(() => expenses.filter(e => !e.invoiceId && !elsewhere.has(String(e.id))), [expenses, elsewhere]);
  // The server's answer about these expenses, read through the member's token.
  const readExpenses = (n, list) => readInvoiceRecordState(n, "travelExpenses", list, userIdRef?.current || null);
  // The sheet's check that its expenses are still unbilled on the server:
  // { seq, state: "checking" | "free" | "unknown" | "confirmed", billedOn }.
  // Send and Email it for me wait for it; with no answer they ask once.
  const [sheetCheck, setSheetCheck] = useState(null);
  const unbilledTotal = unbilled.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const [invOpen, setInvOpen] = useState(false);
  // The expense invoice's number, asked of the server when the sheet opens:
  // the send cannot wait for the network inside the tap (the OS would refuse
  // the share sheet). { number, pending } (utils/invoiceNumber.js).
  const [expNumber, setExpNumber] = useState(null);
  // An invoice from this sheet that went out but whose record was refused:
  // its number and what it billed. Sending again resends that same invoice;
  // other expenses or another agency under its number would be a second,
  // different invoice with the same number (PRAC-030).
  const wentOutRef = useRef(null);
  // The number this sheet's invoice was recorded under, read and set
  // synchronously (WorkLog's recordedRef): a send that waited for the
  // membership check while Mark as sent recorded the invoice sends nothing,
  // and a second record for the same sheet is refused. Which opening of the
  // sheet a send was tapped in: one that closed while the send waited sends
  // nothing either.
  const recordedRef = useRef(null);
  const sheetRef = useRef(0);
  // Notes recorded from the screen's reminder on this page (Yes, it was
  // sent), so a second tap before the reminder goes records nothing more.
  const recordedNotesRef = useRef(new Set());
  // Every number recorded on this page, whichever sheet or path recorded it
  // (Mark as sent with a number typed in records an earlier sheet's number),
  // and the account's invoices as of the last render: a send an earlier
  // sheet reports late keeps no note for a number either one holds, as that
  // note would stamp the server again and drop the record's waiting unstamp.
  const recordedNumbersRef = useRef(new Set());
  const invoicesRef = useRef(data.invoices);
  useEffect(() => { invoicesRef.current = data.invoices; });
  const recordedHere = (number) => recordedNumbersRef.current.has(number) || onAnyInvoice(invoicesRef.current, number);
  // The openings of the sheet (sheetRef) that recorded their invoice, or
  // found it recorded elsewhere (WorkLog's recordedSeqsRef): a send their
  // share sheet reports after they closed keeps no note.
  const recordedSheetsRef = useRef(new Set());
  // A Yes waiting for the check that it is still unrecorded (stillUnrecorded):
  // a second tap meanwhile does nothing. `checking` (the number) shows it on
  // the Yes button, which can take seconds on a slow network.
  const checkingRef = useRef(false);
  const [checking, setChecking] = useState(null);
  // How many times No was answered for each number (the sheet's, the
  // reminder's): a Yes still checking when No is tapped for its number
  // records nothing, as No was the last answer.
  const noCountsRef = useRef(new Map());
  const noCount = (number) => noCountsRef.current.get(number) || 0;
  // The sheet (its sheetRef) whose Yes found some of its expenses on another
  // invoice: a send its share sheet reports late records nothing.
  const billedSheetRef = useRef(null);
  // That invoice, kept until Record as sent saves it ({ number, record,
  // outcome, tries, why }: the row as it went, what the send came to for the
  // notice a first-try send shows, and the refused Record as sent taps); what
  // the last send came to when it recorded nothing ({ text, shared }); the
  // Mark as sent form (utils/invoiceRecord.js).
  const [unrecorded, setUnrecorded] = useState(null);
  const [sendNote, setSendNote] = useState(null);
  const [markSent, setMarkSent] = useState(null);
  // "Email it for me" (WorkLog's; utils/invoiceEmailDraft.js): the email
  // screen's invoice as the sheet had it checked, the check before it opens,
  // a send on its way, and the share sheet holding this sheet's file.
  const online = useOnline();
  const [emailFor, setEmailFor] = useState(null);
  const [emailChecking, setEmailChecking] = useState(false);
  const emailCheckRef = useRef(false);
  const emailSendingRef = useRef(null);
  const shareOutRef = useRef(null);
  // One left behind (the sheet closed, the page reloaded) is kept on the
  // device until it is on the Invoices tab; leaving the page while one is on
  // screen asks first.
  // Handed to the share sheet too (WorkLog's; utils/invoiceHandoff.js).
  // The Clerk user id: the same offline and online (WorkLog's).
  const account = user?.id || "";
  const { list: leftUnrecorded, repeats: repeatNotes, dismissRepeat, remember: rememberUnrecorded, forget: forgetUnrecorded } = useUnrecordedInvoices(data.invoices, { kind: "EXP", account, records: data });
  useUnloadWarning(!!unrecorded);
  // The sheet asks whether its file went out (WorkLog's): the share sheet
  // has it and has not reported a send ({ ask: true, shared, at, sel, agency }
  // in sendNote: what went, to whom, and when). Send waits for the answer.
  const asking = !!(invOpen && expNumber?.number && sendNote?.ask && sendNote.shared === expNumber.number && !recordedRef.current);
  // The app never reloads itself for an update while the invoice sheet is open.
  useEffect(() => { markInvoiceBusy("expenses", !!invOpen); }, [invOpen]);
  useEffect(() => () => markInvoiceBusy("expenses", false), []);
  const [invAgency, setInvAgency] = useState("");
  const [checked, setChecked] = useState({});
  // Record it: the note the sheet was opened for ({ number, matched }), said
  // at the top of the sheet (WorkLog's day picker line).
  const [invFrom, setInvFrom] = useState(null);
  // Expenses an invoice that went out (or may have) and is not recorded yet
  // may bill (heldByNotes: id to its number). They start unchecked, picking
  // an agency leaves them unchecked, and each says so: "Did it go out?"
  // unanswered, they were checked, and a second invoice billed them again.
  const [invHeld, setInvHeld] = useState(() => new Map());
  // Bill-to chips: the contract agencies plus any agency an unbilled expense
  // names, one per agency. Picking one checks every expense billed to that
  // agency under either spelling.
  const invAgencies = useMemo(() => agencyOptions(contracts, { extra: unbilled.map(e => e.agency) }), [contracts, unbilled]);
  // A blank bill-to still gathers the expenses that name no agency.
  const billsTo = (e, ag) => (agencyKey(ag) ? sameAgency(e.agency, ag) : !agencyKey(e.agency));
  const heldNow = () => heldByNotes(leftUnrecorded, unbilled.map(e => e.id), {
    itemsOf: (n) => n.expenseIds, dateOf: (id) => unbilled.find(e => e.id === id)?.date,
  });
  // `from`: a note of an expense invoice that went out unrecorded (Record it,
  // WorkLog's openInvoicePicker): Mark as sent opens with its number and date.
  // Its expenses are checked only when the note lists them and every one is
  // still unbilled; otherwise none is (a server note lists none, and one
  // deleted or billed since means the copy that was sent is the only guide).
  // The bill-to is the agency it went to, when the note says.
  const openInvoice = (from = null) => {
    const first = unbilled[0]?.agency || "";
    const noted = from && typeof from.billTo === "string" ? from.billTo : null;
    const ag = noted !== null
      ? invAgencies.find(a => sameAgency(a, noted)) || noted
      : invAgencies.find(a => sameAgency(a, first)) || first || invAgencies[0] || "";
    setInvAgency(ag);
    const fromNote = from ? itemsFromNote(from.expenseIds, unbilled.map(e => e.id)) : null;
    // Record it checks what its note billed; any other open leaves out what
    // an unrecorded invoice may bill.
    const held = from ? new Map() : heldNow();
    setInvHeld(held);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, fromNote ? fromNote.keys.includes(e.id) : billsTo(e, ag) && !held.has(e.id)])));
    setInvFrom(from?.number ? { number: from.number, matched: fromNote.matched } : null);
    // A sheet replaced while its share sheet never answered: that number is
    // no longer with the sheet (it shows as unrecorded).
    if (expNumber?.number) shareAnswered(expNumber.number);
    setInvOpen(true);
    setEmailFor(null);
    wentOutRef.current = null;
    recordedRef.current = null;
    sheetRef.current += 1;
    // A send from an earlier sheet whose share sheet never answered holds
    // nothing here (its own finally is for its own sheet).
    setBusy(false);
    setUnrecorded(null); setSendNote(null);
    // Record it: Mark as sent opens with the note's number and date, to check
    // against the copy that was sent; its total is checked on Record.
    setMarkSent(from?.number ? markSentFromNote(from, localDay()) : null);
    // Send waits for a membership answer that is only old (confirmWriteAllowed):
    // asked now, while the expenses are picked, so the tap finds it back.
    prepareWriteCheck("practice");
    // Record it, and Yes when its expenses changed: the invoice that went
    // out, under its own number, never a new one (2026-10-02: Record it got
    // a new number with Send beside it). That sheet only records.
    if (from?.number) {
      setExpNumber({ number: String(from.number).trim(), pending: false, fromNote: true });
      setSheetCheck({ seq: sheetRef.current, state: "free", billedOn: {} });
    } else {
      const reserved = reserveInvoiceNumber(data.invoices, "EXP", { rpc: allocateInvoiceNumberRpc, account: userIdRef?.current || user?.id, online: typeof navigator === "undefined" || navigator.onLine !== false });
      setExpNumber({ number: reserved.number, pending: reserved.pending });
      if (reserved.pending) reserved.done.then(n => setExpNumber(cur => (cur?.number === reserved.number ? { ...cur, number: n, pending: false } : cur)));
      // The server is asked which of these expenses another device has
      // billed since this copy was read: they leave the sheet (and are
      // never sent); Send waits for the answer, so its tap never does.
      const seq = sheetRef.current;
      const answer = beginRecordCheck({ number: "", invoices: data.invoices, items: expenses, ids: unbilled.map(e => e.id), read: readExpenses, collection: "travelExpenses" });
      const settle = (res) => setSheetCheck(c => (c && c.seq === seq
        ? { seq, state: res.state === "unknown" ? "unknown" : "free", billedOn: res.state === "billed" ? res.billedOn : {} }
        : c));
      if (answer && typeof answer.then === "function") { setSheetCheck({ seq, state: "checking", billedOn: {} }); answer.then(settle); }
      else setSheetCheck({ seq, state: answer.state === "unknown" ? "unknown" : "free", billedOn: {} });
    }
    // Fetch the proof now, while the physician is still choosing. Downloading
    // inside the Send tap would spend the user gesture and make the OS refuse
    // the share sheet, which is worse than the bug being fixed.
    setReceiptState("idle");
    hydrateReceipts(unbilled.flatMap(receiptsOf));
  };
  // What an unrecorded invoice may bill, from the notes as they are now
  // (WorkLog's pickHeld): one that arrives after the sheet opened is marked
  // and said too, and its expenses are unchecked (useHeldSync). Never this
  // sheet's own invoice, whose note goes with its file. Nothing for a sheet
  // opened by Record it, which checks what its note billed.
  const sheetHeld = invOpen && !invFrom
    ? heldByNotes(leftUnrecorded.filter(n => !expNumber?.number || String(n.number).toLowerCase() !== String(expNumber.number).toLowerCase()),
      unbilled.map(e => e.id), { itemsOf: (n) => n.expenseIds, dateOf: (id) => unbilled.find(e => e.id === id)?.date })
    : new Map();
  useHeldSync(invOpen && !invFrom ? sheetHeld : null, invHeld, (live, fresh) => {
    setInvHeld(live);
    if (fresh.length) setChecked(c => ({ ...c, ...Object.fromEntries(fresh.map(id => [id, false])) }));
  });
  const pickAgency = (ag) => {
    setInvAgency(ag);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, billsTo(e, ag) && !sheetHeld.has(e.id)])));
  };

  // A send in progress: false, "checking" (waiting for the membership check,
  // confirmWriteAllowed) or "building" (the file on its way). Send and Mark
  // as sent wait for it.
  const [busy, setBusy] = useState(false);
  // The invoice for the checked expenses: the document's arguments and the
  // period it covers. Lines say "receipt on file"; a send marks "attached"
  // only for the receipts that ride in it (expenseReceiptLines).
  const expenseInvoiceFor = (sel, number, agency = invAgency) => {
    const s = data.settings || {};
    const lines = [...sel].sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => ({
      date: e.date,
      label: `${e.category || "Expense"}${e.vendor ? `: ${e.vendor}` : ""}`,
      // "on file" here; the send marks "attached" only for the expenses
      // whose receipts actually ride in it (expenseReceiptLines).
      detail: expenseLineDetail(e.notes, receiptsOf(e).length),
      amount: e.amount,
      expenseId: e.id,
    }));
    const total = sel.reduce((t, e) => t + (parseFloat(e.amount) || 0), 0);
    const dates = sel.map(e => e.date).sort();
    return {
      number,
      kind: "expenses", // the cover says travel expenses, not physician services
      physician: physicianLabel(s),
      npi: s.npi, email: s.email, phone: s.phone,
      facility: agency || "Locums agency", // BILL TO: the agency itself
      periodStart: dates[0], periodEnd: dates[dates.length - 1],
      terms: EXPENSE_INVOICE_TERMS,
      lines, totalMin: 0, total,
    };
  };

  // What a send came to, said once the invoice is recorded: where the cover
  // letter is, and which receipts did not go with it. `outcome` is
  // { how, coverCopied, droppedForSize, attached, missingDocs }.
  const sentNotice = (number, { how, coverCopied, droppedForSize, attached = 0, missingDocs = [] }) => {
    // Same clipboard notice as every other invoice send (ticket e8cc2a02).
    const pasteNote = how === "share" && coverCopied ? ` ${INVOICE_COVER_ON_CLIPBOARD}` : "";
    if (how === "download") {
      // Nothing was sent: the files are on the device for an email.
      return `Invoice ${number}${attached ? ` and ${attached} receipt${attached === 1 ? "" : "s"}` : ""} downloaded, ready to attach to your email.`
        + (missingDocs.length ? ` ${missingReceiptMessage(missingDocs)}` : "")
        + (coverCopied ? ` ${INVOICE_COVER_FOR_EMAIL}` : "")
        + " Tracked on the Invoices tab.";
    }
    if (droppedForSize) {
      return `Invoice ${number} sent on its own. The ${droppedForSize} receipt${droppedForSize === 1 ? "" : "s"} were too large for one message, so send them from the expense, or resend from the Invoices tab.${pasteNote}`;
    }
    if (missingDocs.length) {
      return `Invoice ${number} sent. ${missingReceiptMessage(missingDocs)} Resend from the Invoices tab once they are available.${pasteNote}`;
    }
    return `Invoice ${number} sent with ${attached} receipt${attached === 1 ? "" : "s"} attached. Tracked on the Invoices tab.${pasteNote}`;
  };

  // Record an expense invoice that went out and mark its expenses billed.
  // `record` is the invoice row as it went; `method` is set only for Mark as
  // sent; `outcome` is what the send came to (sentNotice), kept with a
  // refused record so Record as sent can say it. True once recorded; false
  // when refused (an invoice that went out is kept on screen for Record as
  // sent; Mark as sent keeps its form). Every refusal is said in the sheet.
  // Gone out (sent here or marked sent), the record and the expenses it billed
  // are kept even if a membership check they wait for answers read-only
  // (SENT_WORK); false only for a save refused at once.
  // `fromNote`: recorded from the screen's reminder (Yes, it was sent), with
  // the sheet closed.
  const recordExpenseInvoice = (record, { retry = false, outcome = null, fromNote = false } = {}) => {
    // Recorded already from this sheet: a second record would bill the same
    // expenses on a second invoice.
    if (fromNote ? recordedNotesRef.current.has(record.number) : recordedRef.current) return false;
    const recorded = addItem("invoices", record, SENT_WORK);
    // Out of the device, so its number is spent even when the record was
    // refused: reopening the sheet asks for a new one. This sheet keeps it
    // for a resend of these same expenses only. A number typed into Mark as
    // sent is spent for this account too.
    invoiceNumberUsed(record.number, !fromNote && record.number === expNumber?.number ? undefined : (userIdRef?.current || user?.id || ""));
    if (recorded === false) {
      const why = writeRefusalMessage(accessAuthority, "practice");
      // From the reminder: said there, which keeps the note for another try.
      if (fromNote) { window.alert(recordRefusedNotice(1, why)); return false; }
      if (record.method === MARKED_SENT) {
        setMarkSent(f => (f ? { ...f, tries: (f.tries || 0) + 1, problem: recordRefusedNotice((f.tries || 0) + 1, why) } : f));
        return false;
      }
      setUnrecorded(u => ({
        number: record.number, record, outcome: outcome || u?.outcome || null,
        tries: retry ? (u?.tries || 0) + 1 : 0, why,
      }));
      if (!retry) {
        rememberUnrecorded({
          number: record.number, sentAt: record.sentAt, kind: "EXP", contractId: null, total: record.totalAmount,
          periodStart: record.periodStart || null, periodEnd: record.periodEnd || null,
          // What it billed, for Record it (on this device only).
          expenseIds: record.entryIds || [], billTo: invAgency,
        });
        window.alert(notRecordedMessage(record.number, "these expenses"));
      }
      return false;
    }
    if (record.method === SHARE_CONFIRMED) reportHandoffEvent("invoice_share_confirmed_by_member");
    recordedNumbersRef.current.add(record.number);
    const invoiceId = record.id;
    const billedIds = new Set(record.entryIds);
    if (fromNote) {
      recordedNotesRef.current.add(record.number);
      forgetUnrecorded(record.number, { unstamp: true, recordedAs: record.number });
      for (const e of expenses.filter(x => billedIds.has(x.id) && !x.invoiceId)) editItem("travelExpenses", { ...e, invoiceId }, SENT_WORK);
      return true;
    }
    recordedRef.current = record.number;
    recordedSheetsRef.current.add(sheetRef.current);
    wentOutRef.current = null;
    // Recorded: the share stamp goes from the server too (WorkLog's).
    // Cleared there only once this record is on the server (WorkLog's).
    forgetUnrecorded(record.number, { unstamp: true, recordedAs: record.number });
    if (expNumber?.number && expNumber.number !== record.number) forgetUnrecorded(expNumber.number, { unstamp: true, recordedAs: record.number });
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    setExpNumber(null);
    for (const e of expenses.filter(x => billedIds.has(x.id) && !x.invoiceId)) editItem("travelExpenses", { ...e, invoiceId }, SENT_WORK);
    setInvOpen(false);
    return true;
  };
  // Record as sent on an invoice from this sheet whose record was refused:
  // once saved, the notice the first try would have shown (receipts that
  // did not go with it included), since the sheet closes.
  const recordPending = () => {
    if (!unrecorded) return;
    const { record, outcome } = unrecorded;
    if (!recordExpenseInvoice(record, { retry: true })) return;
    showNotice(outcome ? sentNotice(record.number, outcome) : `Invoice ${record.number} recorded as sent. Tracked on the Invoices tab.`);
  };
  const expenseRecord = (inv, sel, lines, sentAt, extra = {}, agency = invAgency) => ({
    id: generateId(), number: inv.number, contractId: null, kind: "expenses",
    billToLabel: agency || "Locums agency",
    periodStart: inv.periodStart, periodEnd: inv.periodEnd,
    // The lines of the PDF that went, so a resend starts from the truth.
    lines, totalAmount: inv.total, totalMinutes: 0,
    entryIds: sel.map(e => e.id),
    sentAt,
    text: `Invoice ${inv.number}: ${agency || "Locums agency"}, ${money(inv.total)} (${sel.length} item${sel.length > 1 ? "s" : ""})`,
    ...extra,
  });

  // Mark as sent: the checked expenses on an invoice that went out some other
  // way, under the number and date on the copy that was sent. No receipt is
  // claimed attached. Nothing is sent.
  const recordMarkedSent = () => {
    if (!markSent || markSent.checking) return;
    const sel = unbilled.filter(e => checked[e.id]);
    if (!sel.length) { setMarkSent(f => (f ? { ...f, problem: "Check the expenses that invoice billed." } : f)); return; }
    const number = String(markSent.number ?? "").trim();
    const problem = markSentProblem({ number, day: markSent.day, invoices: data.invoices, today: localDay() });
    if (problem) { setMarkSent(f => (f ? { ...f, problem } : f)); return; }
    const inv = expenseInvoiceFor(sel, number);
    // Record it: the expenses checked must come to what that invoice went out for.
    if (noteTotalDiffers(markSent, number, inv.total)
      && !window.confirm(noteTotalQuestion(number, markSent.noteTotal, inv.total, "expenses"))) return;
    // Never recorded without the server's answer (2026-10-02; DutyLog's).
    const opened = sheetRef.current;
    const form = markSent;
    const answer = beginRecordCheck({ number, invoices: data.invoices, items: expenses, ids: sel.map(e => e.id), read: readExpenses, collection: "travelExpenses" });
    if (answer && typeof answer.then === "function") setMarkSent(f => (f ? { ...f, checking: true, problem: null } : f));
    whenChecked(answer, (res) => {
      if (sheetRef.current !== opened) return;
      setMarkSent(f => (f ? { ...f, checking: false } : f));
      if (res.state === "free") {
        if (recordExpenseInvoice(expenseRecord(inv, sel, expenseReceiptLines(inv.lines), markedSentAt(form), { method: MARKED_SENT }))) {
          showNotice(`${number} is on the Invoices tab as sent ${formatDate(form.day)}, and its expenses are billed.`);
        }
        return;
      }
      if (res.state === "unknown") { setMarkSent(f => (f ? { ...f, problem: uncheckedMarkNotice(number) } : f)); return; }
      if (res.state === "recorded" && !expNumber?.fromNote && number !== expNumber?.number) {
        setMarkSent(f => (f ? { ...f, problem: `${alreadyRecordedNotice(number)} Enter the number printed on the invoice you sent.` } : f));
        return;
      }
      if (res.state === "recorded") {
        forgetUnrecorded(number);
        sheetRef.current += 1;
        setBusy(false);
        setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setExpNumber(null);
      }
      requestRecordsRefresh();
      window.alert(res.state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "expenses", res.billedOn));
    });
  };

  // What Mark as sent opens with (WorkLog's markSentStart): this sheet's
  // number only when its file went to a share sheet, else the newest expense
  // invoice that went out unrecorded, else nothing.
  const markSentStart = () => {
    // Dated when its file went to the share sheet, once that is known.
    if (expNumber?.number && (sendNote?.shared === expNumber.number || busy === "building")) return { number: expNumber.number, day: localDay(), at: sendNote?.shared === expNumber.number ? sendNote.at || null : null };
    const last = leftUnrecorded[leftUnrecorded.length - 1];
    if (last) return { number: last.number, day: sentDay(last.sentAt), from: unrecordedHint(last), at: last.sentAt };
    return { number: "", day: localDay() };
  };

  // Closes whatever the send is doing (WorkLog's closePreview). A send still
  // waiting for the membership check is dropped: nothing goes out once the
  // sheet is closed. A file already handed to the share sheet stays noted
  // (useUnrecordedInvoices), and the screen's reminder asks about it; a send
  // the share sheet reports after the close records nothing here
  // (sendExpenseInvoice). Refused while the file was out, the sheet stayed
  // stuck open after No, for as long as iOS left the share unanswered.
  const closeInvoiceSheet = () => {
    // An email on its way: its answer records this sheet's invoice.
    if (emailSendingRef.current) return;
    if (unrecorded && !window.confirm(closeUnrecordedQuestion(unrecorded.number))) return;
    // A share sheet that never answered: its number shows as unrecorded now.
    if (expNumber?.number) shareAnswered(expNumber.number);
    sheetRef.current += 1;
    setBusy(false);
    setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
  };

  // Yes, it was sent: exactly the expenses that went, to the agency they
  // went to, dated when they went to the share sheet, in one tap. No receipt
  // is claimed attached: which ones rode along is not known.
  // Asked first, as on Work log (stillUnrecorded): another device may have
  // recorded it. "record", "recorded" (its note goes), "billed", "no" or
  // "dropped" (No tapped for it while it checked; `asked` is its noCount at
  // the Yes; or `live` says the sheet it was asked from was closed, replaced
  // or recorded meanwhile): nothing said or asked.
  const stillUnrecorded = async (number, ids, asked, live = null) => {
    setChecking(number);
    let state, billedOn;
    try {
      ({ state, billedOn } = await checkBeforeRecord({
        number, invoices: data.invoices, items: expenses, ids, read: readExpenses, collection: "travelExpenses",
      }));
    } finally { setChecking(null); }
    const saidNo = noCount(number) !== asked;
    if (saidNo || (live && !live())) {
      // Gone from the screen: nothing asked or said. One recorded elsewhere
      // still leaves the reminder (No forgot it already).
      if (!saidNo && state === "recorded") forgetUnrecorded(number);
      return "dropped";
    }
    if (state === "free") return "record";
    // No answer: never recorded on a guess (2026-10-02); the note stays.
    if (state === "unknown") { window.alert(uncheckedRecordNotice(number)); return "no"; }
    if (state === "recorded") forgetUnrecorded(number);
    requestRecordsRefresh();
    window.alert(state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "expenses", billedOn));
    return state;
  };
  // No: the note and its stamp go, and a Yes still checking is dropped.
  const forgetNote = (number, opts) => {
    noCountsRef.current.set(number, noCount(number) + 1);
    forgetUnrecorded(number, opts);
  };
  const answerYes = async () => {
    if (!asking || checkingRef.current) return;
    const { sel, agency, at } = sendNote;
    const number = sendNote.shared;
    const opened = sheetRef.current;
    const asked = noCount(number);
    checkingRef.current = true;
    let answer;
    const live = () => sheetRef.current === opened && !recordedRef.current;
    try { answer = await stillUnrecorded(number, sel.map(e => e.id), asked, live); } finally { checkingRef.current = false; }
    // Closed or replaced meanwhile, recorded meanwhile, or No tapped
    // meanwhile: nothing more here.
    if (sheetRef.current !== opened || recordedRef.current || noCount(number) !== asked) return;
    // Some expenses on another invoice: a send the sheet reports late
    // records nothing either.
    if (answer === "billed") billedSheetRef.current = opened;
    if (answer === "recorded") {
      // A late send the sheet reports records nothing, and the sheet closes.
      recordedRef.current = number;
      recordedSheetsRef.current.add(opened);
      sheetRef.current += 1;
      setBusy(false);
      setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setExpNumber(null);
      return;
    }
    if (answer !== "record") return; // still asking
    const inv = expenseInvoiceFor(sel, number, agency);
    // An email that could not be confirmed and did arrive (WorkLog's): as
    // emailed, under its send's id, with the lines its PDF had.
    const viaEmail = sendNote.via === "email";
    const lines = viaEmail && sendNote.lines ? sendNote.lines : expenseReceiptLines(inv.lines);
    if (recordExpenseInvoice(expenseRecord(inv, sel, lines, at || new Date().toISOString(), viaEmail ? { method: EMAILED, id: sendNote.id } : { method: SHARE_CONFIRMED }, agency))) {
      showNotice(confirmedFromNoteNotice(inv.number, at, "its expenses"));
    }
  };
  // No, it did not go out: nothing is recorded, and the note and its stamp
  // go. A Yes still checking records nothing.
  const answerNo = () => {
    if (!asking) return;
    forgetNote(sendNote.shared, { unstamp: true });
    setSendNote(null);
  };
  // The reminder's Yes, it was sent: the expenses a note this device handed
  // to the share sheet billed, to the agency it went to, under its number,
  // when every one is still unbilled and they come to what it went out for.
  // Otherwise the sheet opens with Mark as sent filled in (Record it).
  const confirmFromNote = async (n) => {
    if (recordedNotesRef.current.has(n?.number) || checkingRef.current) return; // a second tap
    const fromNote = !n.fromServer && !n.refused && typeof n.billTo === "string" ? itemsFromNote(n.expenseIds, unbilled.map(e => e.id)) : null;
    const sel = fromNote?.matched ? unbilled.filter(e => fromNote.keys.includes(e.id)) : [];
    const inv = sel.length ? expenseInvoiceFor(sel, n.number, n.billTo) : null;
    if (!inv || !noteTotalMatches(n, inv.total)) { openInvoice(n); return; }
    const asked = noCount(n.number);
    checkingRef.current = true;
    try {
      if (await stillUnrecorded(n.number, sel.map(e => e.id), asked) !== "record") return;
    } finally { checkingRef.current = false; }
    const sentAt = n.sentAt || new Date().toISOString();
    // A note an unconfirmed email left (WorkLog's): as emailed, under its send's id.
    const how = n.via === "email" ? { method: EMAILED, id: invoiceEmailKeys(account, n.number).invoiceId } : { method: SHARE_CONFIRMED };
    if (recordExpenseInvoice(expenseRecord(inv, sel, expenseReceiptLines(inv.lines), sentAt, how, n.billTo), { fromNote: true })) {
      showNotice(confirmedFromNoteNotice(n.number, sentAt, "its expenses"));
    }
  };

  // Send and Email wait while the expenses are checked; with no answer from
  // the server they ask once (inside the tap, before anything is built).
  const sheetWaits = !!invOpen && sheetCheck?.seq === sheetRef.current && sheetCheck.state === "checking";
  const sheetAllows = () => {
    if (sheetWaits) return false;
    if (sheetCheck?.seq !== sheetRef.current || sheetCheck.state !== "unknown") return true;
    if (!window.confirm(uncheckedSendQuestion("expenses"))) return false;
    setSheetCheck(c => (c ? { ...c, state: "confirmed" } : c));
    return true;
  };
  const sendExpenseInvoice = async () => {
    if (busy || asking) return; // one send at a time, and the last one answered
    // A sheet Record it opened only records: nothing goes out from it.
    if (expNumber?.fromNote) return;
    const sel = unbilled.filter(e => checked[e.id]);
    if (!sel.length) { showNotice("Nothing selected."); return; }
    if (expNumber?.pending) return; // the button waits for the number
    if (!sheetAllows()) return;
    const number = expNumber?.number || nextInvoiceNumber(data.invoices, "EXP");
    const billed = `${invAgency}|${sel.map(e => e.id).sort().join(",")}`;
    if (wentOutRef.current?.number === number && wentOutRef.current.billed !== billed) {
      window.alert(`Invoice ${number} already went out billing other expenses or another agency. Close this and tap Invoice again to send these under a new number.`);
      return;
    }
    // Send and Mark as sent wait while the membership check runs, which can
    // take a few seconds when the answer is old.
    const opened = sheetRef.current;
    setBusy("checking");
    try {
      // An invoice that goes out has to be recorded: never send one the record would refuse.
      if (!(await confirmWriteAllowed("practice"))) return;
      // Recorded while the check ran (Record as sent), or the sheet closed:
      // nothing goes out.
      if (recordedRef.current || sheetRef.current !== opened) return;
      setBusy("building");
      setSendNote(null);
      const inv = expenseInvoiceFor(sel, number);
      // Receipts ride along in the same share, proof travels with the bill.
      // They were resolved when this modal opened, so nothing is awaited here:
      // a download inside the tap would spend the user gesture and make the OS
      // refuse the share sheet.
      const receiptDocs = sel.flatMap(receiptsOf);
      const attachedFiles = [];
      const attachedDocs = [];
      const missingDocs = [];
      for (const d of receiptDocs) {
        const f = receiptCache[d.id];
        if (f) { attachedFiles.push(f); attachedDocs.push(d); }
        else missingDocs.push({ id: d.id, name: d.name || "receipt", reason: d.storagePath ? "unavailable" : "never_uploaded" });
      }
      // Each receipt goes out named for what it is, not "image.jpg" or
      // "IMG_0269.jpeg" (outgoingFileNames, as packets and credentials do).
      // Synchronous: the share sheet still has its tap.
      const attached = renameFiles(attachedFiles, outgoingFileNames(attachedDocs, data));
      // Clipboard letter (count-free), share text and PDF each claim only the
      // receipts that ride in that attempt; the invoice goes alone if the OS
      // refuses the bundle, and downloads when files cannot be shared.
      // Noted (device and server) before the share sheet opens: the record
      // is written only once it answers (WorkLog's handOff).
      const at = new Date().toISOString();
      const agency = invAgency;
      const handedNote = {
        number, sentAt: at, kind: "EXP", contractId: null,
        total: inv.total, periodStart: inv.periodStart || null, periodEnd: inv.periodEnd || null,
        // What it bills, for Record it (kept on this device; the server's
        // stamp holds the number only).
        expenseIds: sel.map(e => e.id), billTo: invAgency,
      };
      handOffInvoice(account, handedNote);
      // No answered for it from here on (the sheet's, or the reminder's once
      // the sheet closed) forgot its note and stamp (WorkLog's).
      const noAtHandoff = noCount(number);
      shareOutRef.current = { number, noAt: noAtHandoff, seq: opened };
      // Still unanswered once the page is back in front: the sheet asks.
      const ask = { ask: true, shared: number, at, sel, agency };
      const stopWatch = watchUnanswered(() => {
        if (recordedRef.current || sheetRef.current !== opened) return;
        setSendNote(ask);
      }, { number });
      let sent;
      try {
        sent = await sendExpenseInvoiceFiles({
          inv, files: attached, attachedExpenseIds: attachedExpenseIds(receiptDocs, missingDocs),
          nav: navigator, pdfFor: invoicePdfFile, download: downloadFiles,
        });
      } catch (err) {
        forgetUnrecorded(number, { unstamp: true });
        throw err;
      } finally {
        stopWatch();
        shareAnswered(number);
        if (shareOutRef.current?.seq === opened) shareOutRef.current = null;
      }
      // Closed without reporting a send, which iOS also answers after Mail
      // or Gmail sent it (WorkLog's sendInvoice): never taken to mean it did
      // not go. The note and its stamp stay and the sheet asks; closed or
      // replaced meanwhile, the banner asks. Recorded meanwhile: nothing more.
      if (!sent) {
        reportHandoffEvent("invoice_share_aborted_after_handoff");
        if (recordedRef.current || sheetRef.current !== opened) return;
        setSendNote(ask);
        return;
      }
      // Answered only after this sheet was closed or a new one opened (Mark
      // as sent recorded it, and the next invoice is being picked): nothing is
      // recorded from the old one, which would bill its expenses a second time.
      // Recorded already (Yes, it was sent): nothing twice. Not recorded yet,
      // its note stays; and when No was answered for it meanwhile (then the
      // sheet closed), which forgot the note and the stamp, both are kept
      // again: it went, and nothing else on any device would say so.
      if (sheetRef.current !== opened || recordedRef.current) {
        if (noCount(number) !== noAtHandoff && !recordedSheetsRef.current.has(opened) && !recordedNotesRef.current.has(number) && !recordedHere(number)) {
          keepSentInvoiceNote(account, handedNote);
        }
        return;
      }
      // Yes found some of these expenses on another invoice (another
      // device): recorded now, they would move off it. Nothing is recorded,
      // it is said again, and the sheet closes. It went out, so its note and
      // stamp are kept again (a No answered meanwhile removed them): the
      // screen's reminder holds it.
      if (billedSheetRef.current === opened) {
        keepSentInvoiceNote(account, handedNote);
        window.alert(alreadyBilledNotice(number, "expenses", billedOnOf("travelExpenses", sel.map(e => e.id))));
        sheetRef.current += 1;
        setBusy(false);
        setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setExpNumber(null);
        return;
      }
      const { how, coverCopied, droppedForSize } = sent;
      const outcome = { how, coverCopied, droppedForSize, attached: attached.length, missingDocs };
      const recorded = recordExpenseInvoice(expenseRecord(inv, sel, sent.lines, new Date().toISOString()), { outcome });
      // Refused while the share sheet was open: nothing is marked billed, and
      // the sheet keeps the invoice (and what the send came to) for Record
      // as sent.
      if (!recorded) {
        wentOutRef.current = { number, billed };
        return;
      }
      showNotice(sentNotice(number, outcome));
    } catch (err) {
      // Without this a throw looked exactly like a slow success: the button
      // came back and nothing was said. Said in the sheet too, which stays open.
      const msg = `The invoice could not be sent: ${err?.message || "unknown error"}. Nothing was recorded, so you can try again.`;
      showNotice(msg);
      if (sheetRef.current === opened) setSendNote({ text: msg, shared: null });
    } finally {
      // A sheet opened since has its own send.
      if (sheetRef.current === opened) setBusy(false);
    }
  };

  // ── Email it for me (WorkLog's; utils/invoiceEmailDraft.js) ──
  // Off while the number may already be out unanswered, a send is on its
  // way (a share sheet holding the file counts until No is answered for it),
  // nothing is checked, or offline (said why).
  const shareNoAnswered = !!(expNumber?.number && shareOutRef.current?.number === expNumber.number
    && noCount(expNumber.number) !== shareOutRef.current.noAt);
  const checkedNow = unbilled.filter(e => checked[e.id]);
  const emailOff = !invOpen || !expNumber?.number || !!expNumber.pending || asking || !!unrecorded || !!recordedRef.current
    || (!!busy && !shareNoAnswered) || !!emailFor || !checkedNow.length || !!expNumber.fromNote || sheetWaits;
  // The agency's invoice email, when the agreements billed through it hold
  // exactly one.
  const agencyAddress = (agency) => {
    const found = [...new Set(contracts.filter(c => agencyKey(agency) && sameAgency(c.agency, agency) && isEmailAddress(c.billTo))
      .map(c => normalizeAddress(c.billTo)))];
    return found.length === 1 ? found[0] : "";
  };
  const openEmail = async () => {
    if (emailOff || !online || emailCheckRef.current) return;
    const sel = checkedNow;
    const number = expNumber.number;
    const agency = invAgency;
    const billed = `${agency}|${sel.map(e => e.id).sort().join(",")}`;
    if (wentOutRef.current?.number === number && wentOutRef.current.billed !== billed) {
      window.alert(`Invoice ${number} already went out billing other expenses or another agency. Close this and tap Invoice again to send these under a new number.`);
      return;
    }
    const opened = sheetRef.current;
    emailCheckRef.current = true;
    setEmailChecking(true);
    let state;
    try {
      state = await checkBeforeEmail({
        number, invoices: data.invoices, items: expenses, ids: sel.map(e => e.id), what: "expenses",
        read: readExpenses, collection: "travelExpenses",
        confirm: (q) => window.confirm(q),
      });
    } finally { emailCheckRef.current = false; setEmailChecking(false); }
    if (sheetRef.current !== opened || recordedRef.current) return;
    if (state === "recorded") {
      forgetUnrecorded(number);
      window.alert(alreadyRecordedNotice(number));
      recordedRef.current = number;
      recordedSheetsRef.current.add(opened);
      sheetRef.current += 1;
      setBusy(false);
      setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setExpNumber(null);
      return;
    }
    if (state === "billed") {
      // Those expenses leave the sheet (serverBilling); the rest can still go.
      billedSheetRef.current = opened;
      requestRecordsRefresh();
      window.alert(alreadyBilledNotice(number, "expenses", billedOnOf("travelExpenses", sel.map(e => e.id))));
      return;
    }
    if (state !== "free") return;
    const keys = invoiceEmailKeys(account, number);
    const inv = expenseInvoiceFor(sel, number, agency);
    setEmailFor({
      seq: opened, inv, sel, agency, billed, keys, args: inv, receipts: sel.flatMap(receiptsOf), to: agencyAddress(agency),
      invoice: { id: keys.invoiceId, number },
      draft: { requestId: keys.requestId, body: emailDraftBody({ number, kind: "expenses", entryIds: sel.map(e => e.id), billToLabel: agency || "Locums agency" }) },
    });
  };
  const emailNoteOf = (e, sentAt) => ({
    number: e.inv.number, sentAt, kind: "EXP", contractId: null,
    total: e.inv.total, periodStart: e.inv.periodStart || null, periodEnd: e.inv.periodEnd || null,
    expenseIds: e.sel.map(x => x.id), billTo: e.agency,
  });
  // A Send again after one that got no answer keeps the first one's note.
  const emailStart = (e) => { if (!emailSendingRef.current) emailSendingRef.current = emailSendStarted(account, emailNoteOf(e, new Date().toISOString())); };
  // Confirmed: recorded once, as emailed, dated at the send, with the lines
  // its PDF had (a receipt reads "attached" only if it rode along).
  const emailSent = (e, sent) => {
    emailSendingRef.current = null;
    emailSendConfirmed(e.inv.number);
    setEmailFor(null);
    if (recordedHere(e.inv.number)) return;
    const lines = sent.docArgs?.lines || expenseReceiptLines(e.inv.lines);
    // Recorded even if its sheet is gone by now (the reminder's path).
    const recorded = recordExpenseInvoice(expenseRecord(e.inv, e.sel, lines, sent.at || new Date().toISOString(), { method: EMAILED, id: e.keys.invoiceId }, e.agency),
      sheetRef.current === e.seq ? {} : { fromNote: true });
    if (!recorded) { wentOutRef.current = { number: e.inv.number, billed: e.billed }; return; }
    showNotice(emailedRecordedNotice({ number: e.inv.number, ...sent }, "its expenses"));
  };
  const emailUnconfirmed = (e, sent) => {
    emailSendingRef.current = null;
    const at = new Date().toISOString();
    emailSendUnconfirmed(account, emailNoteOf(e, at));
    if (sheetRef.current === e.seq && !recordedRef.current) {
      setSendNote({ ask: true, shared: e.inv.number, at, sel: e.sel, agency: e.agency, via: "email", cc: sent.cc || "", id: e.keys.invoiceId, lines: sent.docArgs?.lines || null });
    }
  };
  const emailFailed = () => { emailSendFailed(account, emailSendingRef.current); emailSendingRef.current = null; };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Travel expenses</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>Billed to the locums agency, receipts attached.</div>
        </div>
        <button onClick={openNew} style={{
          padding: "10px 16px", borderRadius: 12, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
        }}>+ Expense</button>
      </div>

      {notice && (
        <div style={{ padding: "11px 14px", borderRadius: 12, marginBottom: 10, backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`, fontSize: 13, color: T.text }}>{notice}</div>
      )}

      {/* An expense invoice that went out without a record and was left
          behind: said here until it is recorded or forgotten. */}
      {!invOpen && UnrecordedNotes({
        T, isDesktop, list: leftUnrecorded, what: "its expenses", onForget: forgetNote, checking,
        // One whose expenses another recorded invoice bills: said, and gone in one tap.
        repeats: repeatNotes, onDismissRepeat: dismissRepeat, items: "expenses",
        // Record it (WorkLog's): the expense sheet, then Mark as sent filled
        // in. Known only from the server: asked first, as the device that
        // sent it may hold its record still on the way.
        onRecord: unbilled.length > 0
          ? (n) => { if (!n.fromServer || window.confirm(serverNoteRecordQuestion(n.number))) openInvoice(n); }
          : null,
        onConfirm: unbilled.length > 0 ? confirmFromNote : null,
      })}

      {unbilled.length > 0 && (
        <button onClick={() => openInvoice()} style={{
          width: "100%", padding: "13px", borderRadius: 12, border: "none", marginBottom: 12,
          background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          fontSize: 14.5, fontWeight: 800, cursor: "pointer",
        }}>Invoice {unbilled.length} expense{unbilled.length > 1 ? "s" : ""}: {money(unbilledTotal)}</button>
      )}

      {expenses.length === 0 ? (
        <EmptyState icon={"🧾"} title="No expenses yet"
          subtitle="Log each flight, hotel and rental car with a photo of the receipt, then invoice the agency in one tap." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {expenses.map(exp => {
            const rc = receiptsOf(exp).length;
            return (
              <div key={exp.id} onClick={() => openEdit(exp)} style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: T.text }}>
                    {exp.category}{exp.vendor ? ` · ${exp.vendor}` : ""}
                  </div>
                  <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 2 }}>
                    {formatDate(exp.date)}{exp.agency ? ` · ${exp.agency}` : ""}
                    {rc ? ` · 📎 ${rc}` : " · no receipt"}
                  </div>
                  {exp.invoiceId && (() => {
                    const inv = (data.invoices || []).find(i => i.id === exp.invoiceId);
                    if (!inv) return <div style={{ fontSize: 11.5, fontWeight: 800, marginTop: 3, color: T.textDim }}>billed</div>;
                    const total = parseFloat(inv.totalAmount) || 0;
                    const led = (inv.payments || []).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
                    const paid = led > 0 ? led : (inv.paidAt ? total : 0);
                    const isPaid = paid >= total - 0.005;
                    return (
                      <div style={{ fontSize: 11.5, fontWeight: 800, marginTop: 3, color: isPaid ? (T.success || "#22c55e") : T.warning }}>
                        {inv.number} · {isPaid ? "PAID" : "owed"}{inv.sentAt ? ` · sent ${formatDate(sentDay(inv.sentAt))}` : ""}
                      </div>
                    );
                  })()}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: exp.invoiceId ? T.textMuted : T.text }}>{money(exp.amount)}</div>
                {!exp.invoiceId && (
                  <button aria-label="Delete expense" onClick={(ev) => { ev.stopPropagation(); removeExpense(exp); }} style={{
                    padding: "7px 9px", borderRadius: 10, border: "none",
                    backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", ...cardActionSize,
                  }}><TrashIcon /></button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "New expense" : "Expense"}>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="date" aria-label="Date" value={form.date || ""} onChange={e => setDate(e.target.value)} style={{ ...iS, flex: 1 }} />
          <input type="number" inputMode="decimal" aria-label="$ amount" placeholder="$ amount" value={form.amount ?? ""} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ ...iS, flex: 1 }} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0" }}>
          {CATEGORIES.map(c => (
            <button key={c} aria-pressed={form.category === c} onClick={() => setForm(f => ({ ...f, category: c }))} style={{
              padding: "8px 12px", borderRadius: 14, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${form.category === c ? T.accent : T.border}`,
              backgroundColor: form.category === c ? T.accent : "transparent",
              color: form.category === c ? "#fff" : T.textMuted,
            }}>{c}</button>
          ))}
        </div>
        <input aria-label="Vendor" placeholder="Vendor (e.g. United, Marriott, Hertz)" value={form.vendor || ""} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        {agencies.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {agencies.map(a => (
              <button key={a} aria-pressed={sameAgency(form.agency, a)} onClick={() => setAgency(a)} style={{
                padding: "7px 11px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 14, fontSize: 12, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${sameAgency(form.agency, a) ? T.accent : T.border}`,
                backgroundColor: sameAgency(form.agency, a) ? T.accent : "transparent",
                color: sameAgency(form.agency, a) ? "#fff" : T.textMuted,
              }}>{a}</button>
            ))}
          </div>
        )}
        <input aria-label="Bill to agency" placeholder="Bill to agency (e.g. CompHealth)" value={form.agency || ""} onChange={e => setAgency(e.target.value)} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <textarea aria-label="Notes" placeholder="Notes (trip, assignment, confirmation #)" value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, width: "100%", boxSizing: "border-box", minHeight: 60, fontFamily: "inherit", marginBottom: 10 }} />

        {/* receipts */}
        <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Receipts</div>
        {editing !== "new" && receiptsOf({ id: editing }).map(d => {
          const file = receiptCache[d.id];
          const isImage = docMime(d).startsWith("image/");
          const thumb = isImage ? (d.data || (file ? URL.createObjectURL(file) : null)) : null;
          const pending = !file && receiptState === "loading";
          return (
            <button key={d.id} type="button" onClick={() => openReceipt(d)}
              title={file ? `Open ${d.name}` : "Fetching this receipt"}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", width: "100%", minHeight: TAP_MIN,
                borderBottom: `1px solid ${T.border}`, border: "none", borderBottomStyle: "solid",
                background: "none", textAlign: "left", cursor: file ? "pointer" : "default",
                fontFamily: "inherit", opacity: pending ? 0.6 : 1 }}>
              {thumb
                ? <img src={thumb} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8 }} />
                : <span style={{ fontSize: 20, width: 40, textAlign: "center" }}>{"\ud83d\udcc4"}</span>}
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: file ? T.accent : T.textDim, flexShrink: 0 }}>
                {file ? "Open" : pending ? "Loading" : "Unavailable"}
              </span>
            </button>
          );
        })}
        {pendingFiles.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
            {f.type.startsWith("image/")
              ? <img src={f.dataUrl} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8 }} />
              : <span style={{ fontSize: 20 }}>📄</span>}
            <span style={{ flex: 1, fontSize: 13, color: T.text }}>{f.name}</span>
            <button aria-label={`Remove ${f.name}`} onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))} style={{ ...dismissButtonStyle(T.danger), fontWeight: 800 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={() => cameraRef.current?.click()} style={{
            flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}><CameraIcon /> Photo</button>
          <button onClick={() => uploadRef.current?.click()} style={{
            flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}><UploadIcon /> Upload</button>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { stageFiles(e.target.files); e.target.value = ""; }} />
        <input ref={uploadRef} type="file" accept="image/*,application/pdf" multiple style={{ display: "none" }} onChange={e => { stageFiles(e.target.files); e.target.value = ""; }} />

        {/* The page-level notice sits behind this overlay, so a refusal from
            the quota check or the save validation is shown here as well. */}
        {notice && (
          <div style={{ padding: "11px 14px", borderRadius: 12, marginTop: 12, backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`, fontSize: 13, color: T.text }}>{notice}</div>
        )}

        <button onClick={saveExpense} style={{
          width: "100%", marginTop: 14, padding: "13px", borderRadius: 12, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
        }}>{editing === "new" ? "Add expense" : "Save"}</button>
      </Modal>

      {/* Invoice picker */}
      {/* Images open in the app. A PDF goes to the OS, which is the only thing
          that can render one here: there is no PDF viewer in this codebase. */}
      <Modal open={!!viewer} onClose={closeViewer} title={viewer?.name || "Receipt"}>
        {viewer && (viewer.isImage ? (
          <img src={viewer.url} alt={viewer.name} style={{ width: "100%", height: "auto", borderRadius: 10, display: "block" }} />
        ) : (
          <>
            {/* The preview renders on a desktop browser. On a phone it is
                often blank, which is why the button below is the real answer
                and is always offered rather than kept as a fallback. */}
            <iframe src={viewer.url} title={viewer.name} style={{ width: "100%", height: "60vh", border: `1px solid ${T.border}`, borderRadius: 10, background: "#fff" }} />
            <div style={{ fontSize: 12.5, color: T.textMuted, margin: "10px 0 8px", lineHeight: 1.5 }}>
              If the preview is blank, use the button below and pick a viewer. Nothing is uploaded, this is the file already on your account.
            </div>
          </>
        ))}
        {viewer && (() => {
          // Label by capability, not by guess. A phone can hand the file to
          // Quick Look, Files or Mail; a desktop browser generally cannot, and
          // promising "open" there would be another button that does nothing.
          const canHandOff = typeof navigator !== "undefined" && navigator.canShare?.({ files: [viewer.file] });
          return (
            <button onClick={shareReceipt} style={{
              width: "100%", marginTop: viewer.isImage ? 12 : 0, padding: "13px", borderRadius: 12, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
              fontSize: 14.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
            }}>{canHandOff ? "Open with\u2026" : "Download"}</button>
          );
        })()}
      </Modal>

      <Modal open={invOpen} onClose={closeInvoiceSheet} title="Invoice expenses">
        {invFrom && (
          <div role="status" style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginBottom: 10 }}>
            {pickFromNoteHint(invFrom.number, invFrom.matched, "expenses")}
          </div>
        )}
        {sheetCheck?.seq === sheetRef.current && Object.keys(sheetCheck.billedOn || {}).length > 0 && (
          <div role="alert" style={{ fontSize: 12.5, color: T.text, lineHeight: 1.45, marginBottom: 10, padding: "9px 11px", borderRadius: 10, backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}` }}>
            {billedElsewhereSheetNotice("expenses", sheetCheck.billedOn)}
          </div>
        )}
        {sheetHeld.size > 0 && (
          <div role="alert" style={{ fontSize: 12.5, color: T.text, lineHeight: 1.45, marginBottom: 10, padding: "9px 11px", borderRadius: 10, backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}` }}>
            {heldPickNotice([...sheetHeld.values()], "expenses")}
          </div>
        )}
        <div id="expense-invoice-bill-to" style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Bill to</div>
        {invAgencies.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {invAgencies.map(a => (
              <button key={a} aria-pressed={sameAgency(invAgency, a)} onClick={() => pickAgency(a)} style={{
                padding: "7px 11px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 14, fontSize: 12, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${sameAgency(invAgency, a) ? T.accent : T.border}`,
                backgroundColor: sameAgency(invAgency, a) ? T.accent : "transparent",
                color: sameAgency(invAgency, a) ? "#fff" : T.textMuted,
              }}>{a}</button>
            ))}
          </div>
        )}
        <input aria-labelledby="expense-invoice-bill-to" value={invAgency} onChange={e => pickAgency(e.target.value)} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} placeholder="Agency name" />
        {unbilled.map(e => (
          <label key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>
            <input type="checkbox" checked={!!checked[e.id]} onChange={ev => setChecked(c => ({ ...c, [e.id]: ev.target.checked }))} />
            <span style={{ flex: 1, fontSize: 13.5, color: T.text }}>
              {formatDate(e.date)} · {e.category}{e.vendor ? ` · ${e.vendor}` : ""}
              {e.agency && !sameAgency(e.agency, invAgency) ? ` (${e.agency})` : ""}
              {sheetHeld.has(e.id) && <span style={{ color: T.warning, fontWeight: 700 }}>{` · ${heldMark(sheetHeld.get(e.id))}`}</span>}
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>{money(e.amount)}</span>
          </label>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, fontWeight: 800, color: T.text }}>
          <span>Total</span>
          <span>{money(unbilled.filter(e => checked[e.id]).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0))}</span>
        </div>
        {/* Checked by hand: said before the send (a question inside the Send
            tap could cost the share sheet its tap on an iPhone). */}
        {(() => {
          const on = unbilled.filter(e => checked[e.id] && sheetHeld.has(e.id));
          if (!on.length) return null;
          return (
            <div role="alert" style={{ marginTop: 4, marginBottom: 6, padding: "9px 11px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              backgroundColor: T.dangerDim, color: T.danger, border: `1px solid ${T.danger}55` }}>
              {heldCheckedNotice(on.length, on.map(e => sheetHeld.get(e.id)), "expenses")}
            </div>
          );
        })()}
        {/* Say what will actually attach BEFORE the send. The invoice marks
            a receipt "attached" only when it rides in the message and "on
            file" otherwise, so the agency is never told it has proof it did
            not get; the physician still hears about a shortfall here. */}
        {(() => {
          const sel = unbilled.filter(e => checked[e.id]);
          const docs = sel.flatMap(receiptsOf);
          if (!docs.length) return null;
          const ready = docs.filter(d => receiptCache[d.id]).length;
          if (receiptState === "loading" && ready < docs.length) {
            return <div style={{ marginTop: 8, fontSize: 12.5, color: T.textMuted }}>Fetching receipts: {ready} of {docs.length} ready.</div>;
          }
          if (ready === docs.length) {
            return <div style={{ marginTop: 8, fontSize: 12.5, color: T.textMuted }}>{docs.length} receipt{docs.length === 1 ? "" : "s"} will be attached.</div>;
          }
          return (
            <div style={{ marginTop: 8, padding: "9px 11px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              backgroundColor: T.dangerDim, color: T.danger, border: `1px solid ${T.danger}55` }}>
              Only {ready} of {docs.length} receipts can be attached right now. The invoice marks the others "receipt on file", so send it once the rest are available, or tell the agency what is coming separately.
            </div>
          );
        })()}
        {expNumber?.fromNote ? (
          // Record it: the invoice that went out, under its number. Nothing
          // here sends it again.
          <div role="status" style={{ marginTop: 6, fontSize: 13, color: T.text, lineHeight: 1.45, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
            {recordOnlyLine(expNumber.number)}
          </div>
        ) : (
        <>
        {/* On a phone the server email comes first: no share sheet, no trip
            to Mail or Gmail, and its outcome is known. */}
        {!isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || sheetWaits, online, other: "Create & send", primary: true })}
        <button onClick={sendExpenseInvoice} disabled={!!busy || !!expNumber?.pending || asking || sheetWaits} style={{
          width: "100%", marginTop: 6, padding: "13px", borderRadius: 12, border: isDesktop ? "none" : `1px solid ${T.border}`,
          background: busy || expNumber?.pending || asking || sheetWaits ? T.textDim : isDesktop ? "linear-gradient(135deg, #10b981, #059669)" : "transparent", color: isDesktop || busy || expNumber?.pending || asking || sheetWaits ? "#fff" : T.text,
          fontSize: 14.5, fontWeight: 800, cursor: busy || expNumber?.pending || sheetWaits ? "wait" : "pointer",
        }}>{busy === "checking" ? "Checking your membership…" : busy ? "Building…" : expNumber?.pending ? "Reserving the invoice number…" : sheetWaits ? sendCheckingLabel("expenses") : "Create & send with receipts"}</button>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 8, textAlign: "center" }}>
          The share includes the invoice PDF plus every attached receipt.
        </div>
        {isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || sheetWaits, online, other: "Create & send" })}
        </>
        )}
        {InvoiceMarkSent({
          T, iS, pending: unrecorded, note: sendNote?.text, start: markSentStart(),
          ask: asking ? {
            number: expNumber.number, checking: checking === expNumber.number,
            text: sendNote.via === "email" ? emailAskNotice(expNumber.number, "these expenses", sendNote.cc) : undefined,
          } : null, onYes: answerYes, onNo: answerNo,
          form: markSent, setForm: setMarkSent, today: localDay(), waiting: busy === "checking" || !!expNumber?.pending || !!markSent?.checking,
          onRecordPending: recordPending,
          onRecordMarked: recordMarkedSent, unbilled: "these expenses",
          // A sheet that only records: Cancel closes it.
          onCancel: expNumber?.fromNote ? closeInvoiceSheet : null,
        })}
      </Modal>
      {emailFor && (
        <InvoiceEmailModal open invoice={emailFor.invoice} contract={null} billName={emailFor.agency || "Locums agency"}
          invoiceDraft={emailFor.draft} docArgs={emailFor.args} localReceipts={emailFor.receipts} prefillTo={emailFor.to} records="these expenses"
          toHint={`No invoice email is saved for ${emailFor.agency || "this agency"} on an agreement. Type the billing office's address.`}
          onClose={() => { if (!emailSendingRef.current) setEmailFor(null); }}
          onSendStart={() => emailStart(emailFor)} onSent={(r) => emailSent(emailFor, r)}
          onUnconfirmed={(r) => emailUnconfirmed(emailFor, r)} onFailed={emailFailed} />
      )}
    </div>
  );
}

export default memo(Expenses);
