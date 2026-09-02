import { describeItem } from "./helpers";

// A document's identity comes from the record it is attached to, not from
// its filename (IMG_0269.jpeg says nothing). This is the same idea Vera's
// snapshot uses (attachedTo) and the Files screen's link picker uses
// (linkables), folded into one helper so every document list in the app
// describes a file the same way.

const SECTION_LABELS = {
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
