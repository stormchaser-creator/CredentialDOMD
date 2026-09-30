// What "Your Data" counts on Data & Backup, and the export's itemCount.
//
// The counts object was hand-written for 15 of the 33 synced collections, so
// a Practice-heavy account (work log, invoices, contracts, expenses, custom
// records...) saw a total far below what the export and the database held.
// Counts now come from the collection registry; the only collections left out
// are bookkeeping, named here, so a new collection cannot silently drop out.
//
// Pure: plain node tests import it.

/** Bookkeeping rows, not records the physician entered. */
export const COUNT_EXCLUDED = Object.freeze(["shareLog", "notificationLog", "alertAcks", "customCategories"]);

const LABELS = Object.freeze({
  licenses: "Licenses", cme: "CME", privileges: "Privileges", insurance: "Insurance", healthRecords: "Health records",
  education: "Education", caseLogs: "Case logs", workHistory: "Work history", peerReferences: "Peer references",
  malpracticeHistory: "Malpractice history", documents: "Documents", locumContracts: "Contracts", workLog: "Work log",
  encounters: "RVU entries", screenings: "Screenings", followUps: "Follow-ups", professionalPhotos: "Professional photos",
  publications: "Publications", travelDocs: "Travel & IDs", travelExpenses: "Expenses", taxPayments: "Tax payments",
  scheduleDays: "Schedule days", taskNotes: "To-do", dutyDays: "Duty days", memberships: "Memberships",
  invoices: "Invoices", deductibles: "Deductions", rotations: "Rotations", customRecords: "Your categories",
});

const humanize = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** [{ key, label, count }] for every counted collection, in registry order. */
export function recordCounts(data, collectionKeys) {
  return collectionKeys
    .filter((key) => !COUNT_EXCLUDED.includes(key))
    .map((key) => ({ key, label: LABELS[key] || humanize(key), count: Array.isArray(data?.[key]) ? data[key].length : 0 }));
}

export const totalOf = (counts) => counts.reduce((n, c) => n + c.count, 0);
