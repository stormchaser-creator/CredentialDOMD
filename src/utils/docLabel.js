import { describeItem } from "./helpers.js";

// A document's identity comes from the record it is attached to, not from
// its filename (IMG_0269.jpeg says nothing). This is the same idea Vera's
// snapshot uses (attachedTo) and the Files screen's link picker uses
// (linkables), folded into one helper so every document list in the app
// describes a file the same way.

const SECTION_LABELS = {
  // A record in one of the physician's own categories
  customRecords: "Record",
  licenses: "License",
  privileges: "Privilege",
  insurance: "Insurance",
  cme: "CME",
  healthRecords: "Health",
  education: "Education",
  locumContracts: "Agreement",
  workHistory: "Work history",
  peerReferences: "Reference",
  malpracticeHistory: "Malpractice",
  screenings: "Screening",
  professionalPhotos: "Photo",
  publications: "Publication",
  memberships: "Membership",
  travelDocs: "Travel",
  caseLogs: "Case",
  travelExpenses: "Expense",
  deductibles: "Deduction",
};

/** "License: DEA Registration, FL" style label for a doc linked to licenses:<id>; null when unlinked. */
export function docAttachedLabel(doc, data) {
  const ref = doc?.linkedTo;
  if (!ref) return null;
  const [sec, id] = String(ref).split(":");
  const item = (data?.[sec] || []).find((x) => x?.id === id);
  const secLabel = SECTION_LABELS[sec] || sec;
  if (!item) return secLabel;
  const desc = sec === "cme"
    ? (item.title || item.category || "Course")
    : describeItem(item, data?.settings?.name, sec);
  return `${secLabel}: ${desc}`;
}

/** Bytes as a short human size: "240 KB", "1.3 MB". */
export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bytes for a document row: size, else size_bytes, else derived from the base64 data URL. */
export function docBytes(doc) {
  if (!doc) return 0;
  if (doc.size) return Number(doc.size) || 0;
  if (doc.sizeBytes) return Number(doc.sizeBytes) || 0;
  const b64 = String(doc.data || "").split(",")[1] || "";
  return Math.round(b64.length * 0.75);
}

// A name that says nothing about the document: a camera's "image.jpg",
// "IMG_0269.jpeg", "PXL_2026...", a scanner's "scan (3).pdf", "Untitled".
const GENERIC_NAME = /^(?:(?:image|img|photo|picture|pic|scan|scanned|document|doc|file|untitled|attachment|upload|camera)(?:[\s_-]*\(?\d*\)?)*|(?:IMG|PXL|DSC|DSCN|DCIM|MVIMG|PHOTO|SCAN|Screenshot|Screen Shot)[\s_-].*|\d+)$/i;
const extOf = (name) => (String(name || "").match(/(\.[A-Za-z0-9]{2,5})$/) || ["", ""])[1];
const stemOf = (name) => String(name || "").replace(/\.[A-Za-z0-9]{2,5}$/, "").trim();
// eslint-disable-next-line no-control-regex
const fileSafe = (s) => String(s || "").replace(/[\\/:*?"<>|\u{0}-\u{1f}]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * The names a set of documents goes out under in a share or a packet. A
 * meaningful name the physician gave a file is kept; a generic camera or
 * scanner name is replaced by what the document is, from the record it is
 * attached to, and the physician ("State Medical License, CO, Ana Li DO.jpg"),
 * with its real extension. Names that would repeat get "(2 of 2)". The
 * Gmail app takes the first file's name as the subject, so "image" told a
 * credentialing office nothing (and two "image.jpg" files could not be told
 * apart). Returns [{ name, label }]: label is the name without extension,
 * for the letter that lists the files.
 */
export function outgoingFileNames(docs = [], data = {}) {
  const who = fileSafe(String(data?.settings?.name || "").replace(/,/g, ""));
  const deg = fileSafe(data?.settings?.degreeType || "");
  const owner = who ? `${who}${deg && !new RegExp(`\\b${deg}$`, "i").test(who) ? ` ${deg}` : ""}` : "";
  const base = (docs || []).map((doc, i) => {
    const raw = String(doc?.name || "");
    const stem = stemOf(raw);
    const ext = extOf(raw) || (/pdf/i.test(doc?.type || doc?.mimeType || "") ? ".pdf" : "");
    if (stem && !GENERIC_NAME.test(stem)) return { stem: fileSafe(stem), ext };
    const label = docAttachedLabel(doc, data);
    const what = label ? label.replace(/^[^:]+:\s*/, "") : `Document ${i + 1}`;
    return { stem: fileSafe([what, owner].filter(Boolean).join(", ")).slice(0, 120), ext };
  });
  const counts = new Map();
  for (const b of base) counts.set(b.stem.toLowerCase(), (counts.get(b.stem.toLowerCase()) || 0) + 1);
  const seen = new Map();
  return base.map((b) => {
    const key = b.stem.toLowerCase();
    const total = counts.get(key);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const stem = total > 1 ? `${b.stem} (${n} of ${total})` : b.stem;
    return { name: `${stem}${b.ext}`, label: stem };
  });
}

/** The same Files under their outgoing names (outgoingFileNames). */
export function renameFiles(files = [], names = []) {
  return files.map((f, i) => (f && names[i] && f.name !== names[i].name ? new File([f], names[i].name, { type: f.type }) : f));
}
