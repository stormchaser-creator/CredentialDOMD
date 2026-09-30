// The records the cloud refused, as the physician should read them.
//
// src/lib/supabase.js lists a record whose write the database refused for a
// reason that retrying cannot fix (a blank required field, a value of the
// wrong type). Such a record is on this device only: missing on every other
// device and from the monthly backup. This turns that list into lines a
// physician can act on, with only the records that still exist here.
//
// Pure: plain node tests import it.

import { describeWriteError } from "./syncRules.js";
import { describeItem } from "./helpers.js";
import { plainDashes } from "./outgoingText.js";

// Where each kind of record is opened. Matches HomeSearch's SECTIONS.
const ROUTES = {
  licenses: ["credentials", "licenses", "License"],
  privileges: ["credentials", "privileges", "Privileges"],
  cme: ["credentials", "cme", "CME"],
  insurance: ["credentials", "insurance", "Insurance"],
  healthRecords: ["credentials", "healthRecords", "Health record"],
  screenings: ["credentials", "screenings", "Screening"],
  education: ["credentials", "education", "Education"],
  workHistory: ["credentials", "workHistory", "Work history"],
  peerReferences: ["credentials", "peerReferences", "Reference"],
  memberships: ["credentials", "memberships", "Membership"],
  malpracticeHistory: ["credentials", "malpracticeHistory", "Malpractice"],
  publications: ["credentials", "publications", "Publication"],
  professionalPhotos: ["credentials", "professionalPhotos", "Photo"],
  travelDocs: ["credentials", "travelDocs", "Travel document"],
  caseLogs: ["credentials", "caseLogs", "Case"],
  documents: ["documents", null, "Document"],
  locumContracts: ["locum", "contracts", "Contract"],
  invoices: ["locum", "invoices", "Invoice"],
  workLog: ["locum", "work", "Work log"],
  encounters: ["locum", "rvus", "RVU entry"],
  travelExpenses: ["locum", "expenses", "Expense"],
  deductibles: ["more", "finance", "Deduction"],
  taskNotes: ["locum", "todo", "To-do"],
};

const humanize = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (c) => c.toUpperCase());

function titleOf(collectionKey, record, physicianName) {
  const own = record.title || record.name || record.number || record.organization || record.merchant || record.description;
  if (["cme", "documents", "caseLogs", "publications"].includes(collectionKey) && own) return String(own).trim();
  const described = describeItem(record, physicianName, collectionKey);
  return plainDashes(String(described || own || "Untitled").trim());
}

/**
 * [{ collectionKey, id, code, section, title, reason, tab, sub }] for each
 * refused record that is still in `data`, in the order the issues came.
 */
export function describeSyncIssues(issues, data) {
  const out = [];
  const seen = new Set();
  for (const issue of issues || []) {
    const key = `${issue?.collectionKey}:${issue?.id}`;
    if (!issue?.collectionKey || !issue?.id || seen.has(key)) continue;
    const record = (data?.[issue.collectionKey] || []).find((r) => r?.id === issue.id);
    if (!record) continue; // deleted since: nothing left to fix
    seen.add(key);
    const [tab, sub, section] = ROUTES[issue.collectionKey] || [null, null, humanize(issue.collectionKey)];
    out.push({
      collectionKey: issue.collectionKey, id: issue.id, code: issue.code || "",
      section, title: titleOf(issue.collectionKey, record, data?.settings?.name),
      reason: describeWriteError(issue.code || ""), tab, sub,
    });
  }
  return out;
}
