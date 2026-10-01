// The read-only records view (ReadOnlyRecords.jsx) as data: each record with
// a readable title, a short line under it, its details as label and value,
// and the files filed to it. Files not filed to a listed record come last.
// Shown only when the server's answer keeps a scope read-only (an expired
// membership), never while membership is being re-checked (ticket fe321c16).
//
// Protected Identity, and files filed to it, are never part of this view.
import { memberViewSection } from "../../supabase/functions/_shared/memberView.mjs";
import { recordCard } from "./memberViewer.js";
import { describeItem, formatDate, plainDashes } from "./helpers.js";
import { docAttachedLabel, docBytes, fmtBytes } from "./docLabel.js";
import { money, invoicePeriod } from "./invoiceCover.js";
import { scopeForCollection } from "./limitedLaunchAccess.js";
import { isIdentityLink, isIdentitySection } from "./pausedApplicationRecords.js";

const SECTION_LABELS = {
  invoices: "Invoices", travelExpenses: "Expenses", deductibles: "Deductions", encounters: "RVU entries",
  taxPayments: "Tax payments", locumContracts: "Contracts", workLog: "Work log", documents: "Other documents",
};
// What a file filed to a record of this kind is, when its own name says nothing.
const FILE_WORDS = {
  travelExpenses: "Receipt", deductibles: "Receipt", invoices: "Invoice file", locumContracts: "Agreement",
  cme: "Certificate", licenses: "License document", insurance: "Policy document", education: "Diploma or certificate",
};
const HIDDEN_FIELDS = new Set(["id", "userId", "data", "storagePath", "favorite", "fieldLabels", "splitGroupId", "invoiceId", "workLogId", "categoryId", "linkedTo"]);
const MONEY_FIELD = /amount|total|rate|stipend|cost|price|paid|balance|fee|expected/i;

// Labels for fields the member-view list does not name.
const FIELD_LABELS = {
  contractId: "Contract", totalAmount: "Total", totalMinutes: "Total minutes", sentAt: "Sent", paidAt: "Paid",
  writeOffAt: "Written off", lastEmailedAt: "Last emailed", lastEmailedTo: "Last emailed to", taxYear: "Tax year",
};
const humanize = value => String(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/^./, ch => ch.toUpperCase());
const text = value => (value == null ? "" : String(value).trim());
const day = value => (/^\d{4}-\d{2}-\d{2}/.test(text(value)) ? formatDate(text(value).slice(0, 10)) : "");
const unique = parts => parts.map(text).filter(Boolean).filter((part, index, all) => all.indexOf(part) === index);

export function sectionLabel(key) {
  return SECTION_LABELS[key] || memberViewSection(key)?.label || humanize(key);
}

function contractName(data, id) {
  const contract = (data.locumContracts || []).find(item => item.id === id);
  return contract ? text(contract.shortName || contract.facility || contract.agency) : "";
}

/** The card's two lines for one record. */
export function recordHeading(key, record, data) {
  const name = data.settings?.name || "";
  switch (key) {
    case "invoices": {
      const status = record.writeOffAt ? "Written off" : record.paidAt ? "Paid" : record.sentAt ? "Sent" : "Not sent";
      return { title: record.number ? `Invoice ${record.number}` : "Invoice",
        subtitle: unique([record.totalAmount != null ? money(record.totalAmount) : "", invoicePeriod(record), status]).join(" \u{B7} ") };
    }
    case "travelExpenses":
    case "deductibles":
      return { title: plainDashes(describeItem(record, name, key)),
        subtitle: unique([day(record.date), record.amount != null ? money(record.amount) : "", contractName(data, record.contractId)]).join(" \u{B7} ") };
    case "encounters": {
      const codes = (Array.isArray(record.codes) ? record.codes : []).map(code => text(code?.code)).filter(Boolean);
      return { title: codes.length ? `CPT ${codes.join(", ")}` : "RVU entry",
        subtitle: unique([day(record.date), contractName(data, record.contractId)]).join(" \u{B7} ") };
    }
    case "workLog": {
      const minutes = Number(record.billedMin || record.durationMin) || 0;
      return { title: unique([humanize(record.type || "Work"), contractName(data, record.contractId)]).join(" \u{B7} "),
        subtitle: unique([day(record.date || record.callDay), minutes > 0 ? `${Math.round(minutes / 6) / 10} h` : ""]).join(" \u{B7} ") };
    }
    case "taxPayments":
      return { title: `${text(record.jurisdiction) || "Tax"} payment`,
        subtitle: unique([day(record.date), record.amount != null ? money(record.amount) : "", record.taxYear ? `Tax year ${record.taxYear}` : ""]).join(" \u{B7} ") };
    default: break;
  }
  if (memberViewSection(key)) {
    const card = recordCard(key, record, { sections: data, member: { name } });
    // The title with its type once ("State Medical License, CO").
    const title = plainDashes(card.headline);
    return { title: title || sectionLabel(key), subtitle: plainDashes(card.subLine) };
  }
  return { title: plainDashes(describeItem(record, name, key)) || sectionLabel(key), subtitle: day(record.date) };
}

function detailValue(field, value, data) {
  if (value == null || value === "") return "";
  if (field === "contractId") return contractName(data, value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return MONEY_FIELD.test(field) ? money(value) : String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const at = new Date(value);
      return Number.isFinite(at.getTime()) ? at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every(item => item == null || typeof item !== "object")) return value.filter(item => item != null && item !== "").map(String).join(", ");
    return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  }
  return "";
}

/** Everything saved on the record, as label and value, in the order it was saved. */
export function recordDetails(key, record, data) {
  const labels = new Map((memberViewSection(key)?.fields || []).map(field => [field.key, field.label]));
  const rows = [];
  for (const [field, value] of Object.entries(record || {})) {
    if (HIDDEN_FIELDS.has(field)) continue;
    if ((field === "fieldValues" || field === "customFields") && value && typeof value === "object" && !Array.isArray(value)) {
      const named = field === "fieldValues" && record.fieldLabels && typeof record.fieldLabels === "object" ? record.fieldLabels : {};
      for (const [inner, innerValue] of Object.entries(value)) {
        const shown = detailValue(inner, innerValue, data);
        if (shown) rows.push({ label: text(named[inner]) || humanize(inner), value: shown });
      }
      continue;
    }
    const shown = detailValue(field, value, data);
    if (shown) rows.push({ label: labels.get(field) || FIELD_LABELS[field] || humanize(field), value: shown });
  }
  return rows;
}

/** "PDF", "Photo", "Word document": what kind of file this is. */
export function documentKind(doc) {
  const type = text(doc?.type).toLowerCase();
  const ext = (text(doc?.name).match(/\.([a-z0-9]{1,5})$/i)?.[1] || "").toLowerCase();
  if (type.includes("pdf") || ext === "pdf") return "PDF";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].includes(ext)) return "Photo";
  if (type.includes("word") || ["doc", "docx"].includes(ext)) return "Word document";
  if (type.includes("sheet") || type.includes("excel") || ["xls", "xlsx", "csv"].includes(ext)) return "Spreadsheet";
  if (type.startsWith("text/") || ["txt", "rtf"].includes(ext)) return "Text";
  return "File";
}

// A camera or scanner name ("IMG_9740.jpeg", "process (2).pdf") says nothing.
const GENERIC_NAME = /^(img|image|photo|pxl|dsc|dcim|scan|scanned|screenshot|screen shot|process|document|doc|file|untitled|attachment|download)?[\s_\-().\d]*$/i;

/** A readable name for a file, from the record it is filed to when its own name says nothing. */
export function documentLabel(doc, data) {
  const own = text(doc?.name).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/_+/g, " ").trim();
  if (own && !GENERIC_NAME.test(own)) return own;
  const section = text(doc?.linkedTo).split(":")[0];
  if (section && FILE_WORDS[section]) return FILE_WORDS[section];
  const attached = doc?.linkedTo ? docAttachedLabel(doc, data) : null;
  return attached ? plainDashes(attached) : "Document";
}

/** "Photo · Added Sep 3, 2026 · 240 KB · IMG_9740.jpeg" */
export function documentDetail(doc) {
  const added = day(doc?.uploadedAt || doc?.createdAt || doc?.date);
  const bytes = docBytes(doc);
  return unique([documentKind(doc), added ? `Added ${added}` : "", bytes > 0 ? fmtBytes(bytes) : "", doc?.name]).join(" \u{B7} ");
}

/**
 * The scope's records in section order, each with its files, then files filed
 * to nothing listed here. `saved` is the plain export of the same records.
 */
export function archiveSections(data, scope, collectionKeys = []) {
  const keys = [...new Set([...collectionKeys, ...Object.keys(data || {}).filter(key => Array.isArray(data[key]))])]
    .filter(key => !isIdentitySection(key));
  const inScope = key => (data[key] || []).filter(record => record && scopeForCollection(key, record) === scope
    && !(key === "documents" && isIdentityLink(record?.linkedTo)));
  const documents = inScope("documents");
  const filedTo = new Map();
  for (const doc of documents) {
    if (typeof doc.linkedTo !== "string" || !doc.linkedTo) continue;
    if (!filedTo.has(doc.linkedTo)) filedTo.set(doc.linkedTo, []);
    filedTo.get(doc.linkedTo).push(doc);
  }
  const placed = new Set();
  const sections = [], saved = {};
  for (const key of keys) {
    if (key === "documents") continue;
    const records = inScope(key);
    if (!records.length) continue;
    saved[key] = records;
    sections.push({
      key, label: sectionLabel(key),
      records: records.map(record => {
        const files = record.id != null ? filedTo.get(`${key}:${record.id}`) || [] : [];
        files.forEach(doc => placed.add(doc));
        return { key, record, ...recordHeading(key, record, data), details: recordDetails(key, record, data), files };
      }),
    });
  }
  if (documents.length) saved.documents = documents;
  const loose = documents.filter(doc => !placed.has(doc));
  if (loose.length) sections.push({ key: "documents", label: sectionLabel("documents"), records: [], files: loose });
  return { sections, saved };
}
