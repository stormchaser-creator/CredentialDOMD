import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cardActionSize, dismissButtonStyle, TAP_MIN } from "../../shared/actionButton";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import { useInputStyle } from "../../shared/useInputStyle";
import { generateId, formatDate, nextInvoiceNumber, deleteConfirmText, localDay, sentDay } from "../../../utils/helpers";
import { reserveInvoiceNumber, invoiceNumberUsed } from "../../../utils/invoiceNumber";
import { MARKED_SENT, markedSentAt, markSentProblem, shareClosedNotice, notRecordedMessage, closeUnrecordedQuestion, recordRefusedNotice, unrecordedHint, shareUnansweredNotice } from "../../../utils/invoiceRecord";
import { handOffInvoice, watchUnanswered } from "../../../utils/invoiceHandoff";
import { markInvoiceBusy } from "../../../utils/invoiceBusy";
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
import { downloadDocumentBlob, allocateInvoiceNumberRpc } from "../../../lib/supabase";
import { docMime } from "../../../utils/inboxDocs";
import { agencyOptions, agencyForDate, sameAgency, agencyKey } from "../../../utils/contractsForDate";
import { localDate } from "../../../utils/billing";


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

  const openEdit = (exp) => {
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
    setViewer({ url, name: d.name || "Receipt", file, isImage: docMime(d).startsWith("image/") });
  };

  const closeViewer = () => { if (viewer) URL.revokeObjectURL(viewer.url); setViewer(null); };

  // Hand the file to the operating system. Must stay synchronous from the tap:
  // the bytes are already resolved, so the user gesture is still live.
  const shareReceipt = () => {
    if (!viewer) return;
    if (navigator.canShare?.({ files: [viewer.file] })) {
      navigator.share({ files: [viewer.file], title: viewer.name }).catch(err => {
        if (err?.name !== "AbortError") showNotice("Your device would not open that file. Use Download instead.");
      });
      return;
    }
    const a = document.createElement("a");
    a.href = viewer.url; a.download = viewer.name; a.click();
  };
  useDeskAddShortcut(openNew);

  const stageFiles = async (files) => {
    // The account's 2 GB line, counting receipts already staged on this
    // expense (each carries only its data URL, which the helper measures).
    const staged = pendingFiles.map((f) => ({ name: f.name, data: f.dataUrl }));
    const quota = checkStorageQuota(data.documents, [...staged, ...Array.from(files)]);
    if (!quota.ok) { showNotice(quota.message); return; }
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/") && f.type !== "application/pdf") continue;
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
    const saved = editing === "new" ? addItem("travelExpenses", rec) : editItem("travelExpenses", rec);
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
  const unbilled = useMemo(() => expenses.filter(e => !e.invoiceId), [expenses]);
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
  // That invoice, kept until Record as sent saves it ({ number, record,
  // outcome, tries, why }: the row as it went, what the send came to for the
  // notice a first-try send shows, and the refused Record as sent taps); what
  // the last send came to when it recorded nothing ({ text, shared }); the
  // Mark as sent form (utils/invoiceRecord.js).
  const [unrecorded, setUnrecorded] = useState(null);
  const [sendNote, setSendNote] = useState(null);
  const [markSent, setMarkSent] = useState(null);
  // One left behind (the sheet closed, the page reloaded) is kept on the
  // device until it is on the Invoices tab; leaving the page while one is on
  // screen asks first.
  // Handed to the share sheet too (WorkLog's; utils/invoiceHandoff.js).
  // The Clerk user id: the same offline and online (WorkLog's).
  const account = user?.id || "";
  const { list: leftUnrecorded, remember: rememberUnrecorded, forget: forgetUnrecorded } = useUnrecordedInvoices(data.invoices, { kind: "EXP", account });
  useUnloadWarning(!!unrecorded);
  // The app never reloads itself for an update while the invoice sheet is open.
  useEffect(() => { markInvoiceBusy("expenses", !!invOpen); }, [invOpen]);
  useEffect(() => () => markInvoiceBusy("expenses", false), []);
  const [invAgency, setInvAgency] = useState("");
  const [checked, setChecked] = useState({});
  // Bill-to chips: the contract agencies plus any agency an unbilled expense
  // names, one per agency. Picking one checks every expense billed to that
  // agency under either spelling.
  const invAgencies = useMemo(() => agencyOptions(contracts, { extra: unbilled.map(e => e.agency) }), [contracts, unbilled]);
  // A blank bill-to still gathers the expenses that name no agency.
  const billsTo = (e, ag) => (agencyKey(ag) ? sameAgency(e.agency, ag) : !agencyKey(e.agency));
  const openInvoice = () => {
    const first = unbilled[0]?.agency || "";
    const ag = invAgencies.find(a => sameAgency(a, first)) || first || invAgencies[0] || "";
    setInvAgency(ag);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, billsTo(e, ag)])));
    setInvOpen(true);
    wentOutRef.current = null;
    recordedRef.current = null;
    sheetRef.current += 1;
    // A send from an earlier sheet whose share sheet never answered holds
    // nothing here (its own finally is for its own sheet).
    setBusy(false);
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    // Send waits for a membership answer that is only old (confirmWriteAllowed):
    // asked now, while the expenses are picked, so the tap finds it back.
    prepareWriteCheck("practice");
    const reserved = reserveInvoiceNumber(data.invoices, "EXP", { rpc: allocateInvoiceNumberRpc, account: userIdRef?.current || user?.id, online: typeof navigator === "undefined" || navigator.onLine !== false });
    setExpNumber({ number: reserved.number, pending: reserved.pending });
    if (reserved.pending) reserved.done.then(n => setExpNumber(cur => (cur?.number === reserved.number ? { number: n, pending: false } : cur)));
    // Fetch the proof now, while the physician is still choosing. Downloading
    // inside the Send tap would spend the user gesture and make the OS refuse
    // the share sheet, which is worse than the bug being fixed.
    setReceiptState("idle");
    hydrateReceipts(unbilled.flatMap(receiptsOf));
  };
  const pickAgency = (ag) => {
    setInvAgency(ag);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, billsTo(e, ag)])));
  };

  // A send in progress: false, "checking" (waiting for the membership check,
  // confirmWriteAllowed) or "building" (the file on its way). Send and Mark
  // as sent wait for it.
  const [busy, setBusy] = useState(false);
  // The invoice for the checked expenses: the document's arguments and the
  // period it covers. Lines say "receipt on file"; a send marks "attached"
  // only for the receipts that ride in it (expenseReceiptLines).
  const expenseInvoiceFor = (sel, number) => {
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
      physician: s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician",
      npi: s.npi, email: s.email,
      facility: invAgency || "Locums agency", // BILL TO: the agency itself
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
  const recordExpenseInvoice = (record, { retry = false, outcome = null } = {}) => {
    // Recorded already from this sheet: a second record would bill the same
    // expenses on a second invoice.
    if (recordedRef.current) return false;
    const recorded = addItem("invoices", record, SENT_WORK);
    // Out of the device, so its number is spent even when the record was
    // refused: reopening the sheet asks for a new one. This sheet keeps it
    // for a resend of these same expenses only. A number typed into Mark as
    // sent is spent for this account too.
    invoiceNumberUsed(record.number, record.number === expNumber?.number ? undefined : (userIdRef?.current || user?.id || ""));
    if (recorded === false) {
      const why = writeRefusalMessage(accessAuthority, "practice");
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
        });
        window.alert(notRecordedMessage(record.number, "these expenses"));
      }
      return false;
    }
    recordedRef.current = record.number;
    wentOutRef.current = null;
    // Recorded: the share stamp goes from the server too (WorkLog's).
    forgetUnrecorded(record.number, { unstamp: true });
    if (expNumber?.number && expNumber.number !== record.number) forgetUnrecorded(expNumber.number, { unstamp: true });
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    setExpNumber(null);
    const invoiceId = record.id;
    const billedIds = new Set(record.entryIds);
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
  const expenseRecord = (inv, sel, lines, sentAt, extra = {}) => ({
    id: generateId(), number: inv.number, contractId: null, kind: "expenses",
    billToLabel: invAgency || "Locums agency",
    periodStart: inv.periodStart, periodEnd: inv.periodEnd,
    // The lines of the PDF that went, so a resend starts from the truth.
    lines, totalAmount: inv.total, totalMinutes: 0,
    entryIds: sel.map(e => e.id),
    sentAt,
    text: `Invoice ${inv.number}: ${invAgency || "Locums agency"}, ${money(inv.total)} (${sel.length} item${sel.length > 1 ? "s" : ""})`,
    ...extra,
  });

  // Mark as sent: the checked expenses on an invoice that went out some other
  // way, under the number and date on the copy that was sent. No receipt is
  // claimed attached. Nothing is sent.
  const recordMarkedSent = () => {
    if (!markSent) return;
    const sel = unbilled.filter(e => checked[e.id]);
    if (!sel.length) { setMarkSent(f => (f ? { ...f, problem: "Check the expenses that invoice billed." } : f)); return; }
    const number = String(markSent.number ?? "").trim();
    const problem = markSentProblem({ number, day: markSent.day, invoices: data.invoices, today: localDay() });
    if (problem) { setMarkSent(f => (f ? { ...f, problem } : f)); return; }
    const inv = expenseInvoiceFor(sel, number);
    if (recordExpenseInvoice(expenseRecord(inv, sel, expenseReceiptLines(inv.lines), markedSentAt(markSent), { method: MARKED_SENT }))) {
      showNotice(`${number} is on the Invoices tab as sent ${formatDate(markSent.day)}, and its expenses are billed.`);
    }
  };

  // What Mark as sent opens with (WorkLog's markSentStart): this sheet's
  // number only when its file went to a share sheet, else the newest expense
  // invoice that went out unrecorded, else nothing.
  const markSentStart = () => {
    if (expNumber?.number && (sendNote?.shared === expNumber.number || busy === "building")) return { number: expNumber.number, day: localDay() };
    const last = leftUnrecorded[leftUnrecorded.length - 1];
    if (last) return { number: last.number, day: sentDay(last.sentAt), from: unrecordedHint(last), at: last.sentAt };
    return { number: "", day: localDay() };
  };

  // Not while the file is on its way. A send still waiting for the
  // membership check is dropped instead: nothing goes out once the sheet is
  // closed. A share sheet that never answered (the preview says so) no
  // longer holds the sheet open: its number stays noted (useUnrecordedInvoices).
  const closeInvoiceSheet = () => {
    if (busy && busy !== "checking" && !(expNumber?.number && sendNote?.shared === expNumber.number)) return;
    if (unrecorded && !window.confirm(closeUnrecordedQuestion(unrecorded.number))) return;
    sheetRef.current += 1;
    setBusy(false);
    setInvOpen(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
  };

  const sendExpenseInvoice = async () => {
    if (busy) return; // one send at a time
    const sel = unbilled.filter(e => checked[e.id]);
    if (!sel.length) { showNotice("Nothing selected."); return; }
    if (expNumber?.pending) return; // the button waits for the number
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
      const attached = [];
      const missingDocs = [];
      for (const d of receiptDocs) {
        const f = receiptCache[d.id];
        if (f) attached.push(f);
        else missingDocs.push({ id: d.id, name: d.name || "receipt", reason: d.storagePath ? "unavailable" : "never_uploaded" });
      }
      // Clipboard letter (count-free), share text and PDF each claim only the
      // receipts that ride in that attempt; the invoice goes alone if the OS
      // refuses the bundle, and downloads when files cannot be shared.
      // Noted (device and server) before the share sheet opens: the record
      // is written only once it answers (WorkLog's handOff).
      handOffInvoice(account, {
        number, sentAt: new Date().toISOString(), kind: "EXP", contractId: null,
        total: inv.total, periodStart: inv.periodStart || null, periodEnd: inv.periodEnd || null,
      });
      const stopWatch = watchUnanswered(() => {
        if (recordedRef.current || sheetRef.current !== opened) return;
        setSendNote({ text: shareUnansweredNotice(number), shared: number });
      });
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
      }
      // Closed without reporting a send: record nothing, and say how to
      // record one that did go out. Answered after the sheet was closed or a
      // new one opened: the note stays for the banner to decide.
      if (!sent) {
        if (sheetRef.current !== opened) return;
        forgetUnrecorded(number, { unstamp: true });
        setSendNote({ text: shareClosedNotice(number), shared: number });
        return;
      }
      // Answered only after this sheet was closed or a new one opened (Mark
      // as sent recorded it, and the next invoice is being picked): nothing is
      // recorded from the old one, which would bill its expenses a second time.
      if (sheetRef.current !== opened) return;
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
      setSendNote({ text: msg, shared: null });
    } finally {
      // A sheet opened since has its own send.
      if (sheetRef.current === opened) setBusy(false);
    }
  };

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
      {!invOpen && UnrecordedNotes({ T, isDesktop, list: leftUnrecorded, what: "its expenses", onForget: forgetUnrecorded })}

      {unbilled.length > 0 && (
        <button onClick={openInvoice} style={{
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
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>{money(e.amount)}</span>
          </label>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, fontWeight: 800, color: T.text }}>
          <span>Total</span>
          <span>{money(unbilled.filter(e => checked[e.id]).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0))}</span>
        </div>
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
        <button onClick={sendExpenseInvoice} disabled={!!busy || !!expNumber?.pending} style={{
          width: "100%", marginTop: 6, padding: "13px", borderRadius: 12, border: "none",
          background: busy || expNumber?.pending ? T.textDim : "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          fontSize: 14.5, fontWeight: 800, cursor: busy || expNumber?.pending ? "wait" : "pointer",
        }}>{busy === "checking" ? "Checking your membership…" : busy ? "Building…" : expNumber?.pending ? "Reserving the invoice number…" : "Create & send with receipts"}</button>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 8, textAlign: "center" }}>
          The share includes the invoice PDF plus every attached receipt.
        </div>
        {InvoiceMarkSent({
          T, iS, pending: unrecorded, note: sendNote?.text, start: markSentStart(),
          form: markSent, setForm: setMarkSent, today: localDay(), waiting: busy === "checking" || !!expNumber?.pending,
          onRecordPending: recordPending,
          onRecordMarked: recordMarkedSent, unbilled: "these expenses",
        })}
      </Modal>
    </div>
  );
}

export default memo(Expenses);
