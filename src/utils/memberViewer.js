// The read-only support viewer's model (ticket d45e857c, phase 2): the member's
// snapshot as their own screens show it, with nothing that can write.
//
// The viewer is fed a SNAPSHOT from admin-member-view, never the member's live
// context and never AppContext: nothing here can reach saveData, sync, the AI
// clients, Vera, share or send. Every write-shaped action the app's screens
// know is present and refuses, so a component handed this view cannot change
// anything even by mistake. The snapshot itself is deep-frozen.
//
// Pure: plain node tests import it (tests/member-view/viewer.test.mjs).
import { MEMBER_VIEW_SECTIONS, MEMBER_VIEW_PROFILE_FIELDS, memberViewSection } from "../../supabase/functions/_shared/memberView.mjs";
import { describeItem, getStatusColor, getStatusLabel, formatDate, isNonExpiring, plainDashes } from "./helpers.js";
import { LIFECYCLE_LABELS, LIFECYCLE_SECTIONS, isAlertable, isInactive, lifecycleNote } from "./lifecycle.js";
import { complianceFor, findStateLicense, trackedStates } from "./compliance.js";
import { cmeAssessmentLabel, totalHoursLabel, topicRecordLabel } from "./cmePresentation.js";

export const READ_ONLY_MESSAGE = "This is a read-only support view. Nothing can be changed here.";

// Every action the member's screens can take that changes, sends, shares,
// uploads or spends: AppContext's writers, the share and send sheets, the
// scanners and AI, exports and billing.
export const READ_ONLY_ACTIONS = Object.freeze([
  "setData", "updateSection", "updateSettings", "addItem", "editItem", "deleteItem", "toggleFavorite", "toggleTheme",
  "share", "shareMany", "sendEmail", "sendPacket", "sendText", "sendReminder", "notify",
  "upload", "uploadDocument", "attachDocument", "linkDocument", "scan", "import",
  "askVera", "runAi", "dictate", "exportData", "downloadRecords", "deleteAccount", "checkout", "manage",
]);

export class ReadOnlyViewError extends Error {
  constructor(action) { super(READ_ONLY_MESSAGE); this.name = "ReadOnlyViewError"; this.code = "read_only"; this.action = action; }
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** The view a support session renders: a frozen copy of the snapshot and actions that all refuse. */
export function createReadOnlyView(snapshot) {
  const data = deepFreeze(structuredClone(snapshot && typeof snapshot === "object" ? snapshot : {}));
  const actions = {};
  for (const action of READ_ONLY_ACTIONS) actions[action] = () => { throw new ReadOnlyViewError(action); };
  return Object.freeze({ readOnly: true, data, ...actions });
}

// ─── Presentation, the way the member's own cards read ──────────────────

const TITLE_SECTIONS = new Set(["licenses", "insurance", "privileges", "workHistory", "education", "healthRecords", "malpracticeHistory", "memberships", "peerReferences", "publications", "caseLogs", "customRecords"]);

function contractLabel(snapshot, id) {
  const contract = (snapshot?.sections?.locumContracts || []).find(item => item.id === id);
  return contract ? (contract.shortName || contract.facility || contract.agency || "Contract") : "";
}

function plainTitle(sectionKey, item, snapshot) {
  if (TITLE_SECTIONS.has(sectionKey)) return describeItem(item, snapshot?.member?.name || "", sectionKey) || "Untitled";
  switch (sectionKey) {
    case "cme": return item.title || item.category || "CME";
    case "customCategories": return item.name || "Category";
    case "locumContracts": return item.shortName || item.facility || item.agency || "Contract";
    case "workLog": return [item.type || "Work", contractLabel(snapshot, item.contractId)].filter(Boolean).join(" · ");
    case "dutyDays": return [item.date ? formatDate(item.date) : "Duty day", contractLabel(snapshot, item.contractId)].filter(Boolean).join(" · ");
    case "scheduleDays": return [item.kind || "Scheduled", contractLabel(snapshot, item.contractId)].filter(Boolean).join(" · ");
    case "rotations": return item.hospital || "Rotation";
    case "taskNotes": return String(item.text || "Task").slice(0, 90);
    case "shareLog": return item.itemName || "Shared item";
    case "followUps": return item.itemName || "Follow-up";
    case "alertAcks": return "Snoozed alert";
    case "notificationLog": return `${item.method || "Alert"} notification`;
    default: return describeItem(item, snapshot?.member?.name || "") || "Record";
  }
}

/**
 * One list card: the green type header, the main line, the dim line with the
 * countdown, and the status dot colour, as CrudSection draws them. No star,
 * share, edit or delete: the viewer has none.
 */
export function recordCard(sectionKey, item, snapshot) {
  const title = plainTitle(sectionKey, item, snapshot);
  let mainLine = title;
  if (item.type && title.toLowerCase().startsWith(String(item.type).toLowerCase())) {
    mainLine = title.slice(String(item.type).length).replace(/^\s*\u{2014}\s*/u, "");
  }
  const said = value => value != null && (title.toLowerCase().includes(String(value).toLowerCase()) || String(item.type || "").toLowerCase() === String(value).toLowerCase());
  const nonExpiring = isNonExpiring(item, sectionKey);
  const lifecycled = LIFECYCLE_SECTIONS.includes(sectionKey);
  const alertable = isAlertable(item);
  const note = lifecycled ? lifecycleNote(item) : null;
  const dated = item.expirationDate || null;
  const color = !alertable ? "gray" : nonExpiring ? "green" : dated ? getStatusColor(dated) : "gray";
  const subLine = [
    ...[item.state, item.facility, item.provider, item.institution, item.licenseNumber, item.policyNumber, item.number, item.agency]
      .filter(Boolean).filter(value => !said(value)),
    item.hours != null && sectionKey === "cme" ? `${item.hours} h` : null,
    item.date && !dated && !["dutyDays"].includes(sectionKey) ? formatDate(String(item.date).slice(0, 10)) : null,
    item.graduationDate && !dated ? `Graduated ${formatDate(String(item.graduationDate).slice(0, 10))}` : null,
    dated ? (alertable ? getStatusLabel(dated) : `Exp ${formatDate(dated)}`) : null,
    nonExpiring ? "Does not expire" : null,
    note,
  ].filter(Boolean).map(String).filter((value, index, all) => all.indexOf(value) === index).join(" \u{B7} ");
  return {
    id: item.id,
    type: item.type ? String(item.type) : "",
    mainLine: mainLine || title,
    subLine,
    color,
    showDot: !!(dated || note),
    inactive: lifecycled && isInactive(item),
    favorite: item.favorite === true,
  };
}

function formatValue(field, value, snapshot) {
  if (value === undefined || value === null || value === "") return "";
  switch (field.kind) {
    case "hidden": return "";
    case "date": return formatDate(String(value).slice(0, 10));
    case "datetime": { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : String(value); }
    case "yes": return value === true ? "Yes" : value === false ? "No" : String(value);
    case "number": return String(value);
    case "list": return Array.isArray(value) ? value.map(String).join(", ") : String(value);
    case "lifecycle": return LIFECYCLE_LABELS[value] || String(value);
    case "contract": return contractLabel(snapshot, value);
    case "periods": return Array.isArray(value) ? value.map(period => [period.start || period.startDate || period.from, period.end || period.endDate || period.to].filter(Boolean).join(" to ") || [period.hospital, period.role, period.kind].filter(Boolean).join(", ")).filter(Boolean).join("; ") : "";
    case "doses": return Array.isArray(value) ? value.map(dose => [dose.doseNumber ? `Dose ${dose.doseNumber}` : "", dose.date ? formatDate(String(dose.date).slice(0, 10)) : "", dose.manufacturer, dose.lotNumber ? `lot ${dose.lotNumber}` : "", dose.facility].filter(Boolean).join(", ")).filter(Boolean).join("; ") : "";
    case "components": return Array.isArray(value) ? value.map(part => [part.name, part.scope, part.status, part.date].filter(Boolean).join(", ")).filter(Boolean).join("; ") : "";
    case "fieldDefs": return Array.isArray(value) ? value.map(def => def?.label || def?.key).filter(Boolean).join(", ") : "";
    case "values": return "";
    case "custom": return "";
    default: return typeof value === "object" ? "" : String(value);
  }
}

/** Label and value pairs for the detail view, in the section's field order. */
export function recordDetails(sectionKey, item, snapshot) {
  const section = memberViewSection(sectionKey);
  if (!section) return [];
  const out = [];
  for (const field of section.fields) {
    if (field.kind === "values") {
      const labels = item.fieldLabels && typeof item.fieldLabels === "object" ? item.fieldLabels : {};
      for (const [key, value] of Object.entries(item.fieldValues || {})) {
        if (value === null || value === undefined || value === "" || typeof value === "object") continue;
        out.push({ label: String(labels[key] || key), value: String(value) });
      }
      continue;
    }
    if (field.kind === "custom") {
      for (const [key, value] of Object.entries(item.customFields || {})) {
        if (value === null || value === undefined || value === "") continue;
        const shown = Array.isArray(value) ? value.map(entry => (entry && typeof entry === "object" ? Object.values(entry).filter(v => typeof v !== "object").join(" ") : String(entry))).join("; ") : typeof value === "object" ? "" : String(value);
        if (shown) out.push({ label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, ch => ch.toUpperCase()), value: shown });
      }
      continue;
    }
    const value = formatValue(field, item[field.key], snapshot);
    if (value) out.push({ label: field.label, value });
  }
  return out;
}

export function profileDetails(snapshot) {
  const member = snapshot?.member || {};
  return MEMBER_VIEW_PROFILE_FIELDS.map(field => ({ label: field.label, value: formatValue(field, member[field.key], snapshot) })).filter(row => row.value);
}

/** Files filed to one record, in name order. */
export function documentsFor(snapshot, sectionKey, id) {
  const link = `${sectionKey}:${id}`;
  return (snapshot?.documents || []).filter(doc => doc.linkedTo === link).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export const VIEWER_GROUPS = Object.freeze([
  { key: "home", label: "Home" },
  { key: "credentials", label: "Credentials" },
  { key: "documents", label: "Documents" },
  { key: "work", label: "Work" },
  { key: "activity", label: "Activity" },
  { key: "profile", label: "Profile" },
]);

/** The sections under one tab, with their record counts, in the member's order. */
export function groupSections(snapshot, group) {
  return MEMBER_VIEW_SECTIONS.filter(section => section.group === group)
    .map(section => ({ key: section.key, label: section.label, count: (snapshot?.sections?.[section.key] || []).length }));
}

/** Records of one section, sorted the way the member's list sorts them: needs attention first, retired last. */
export function sectionRecords(snapshot, sectionKey) {
  const records = [...(snapshot?.sections?.[sectionKey] || [])];
  const rank = item => {
    if (LIFECYCLE_SECTIONS.includes(sectionKey) && isInactive(item)) return 3;
    const color = recordCard(sectionKey, item, snapshot).color;
    return color === "red" ? 0 : color === "orange" || color === "amber" ? 1 : 2;
  };
  const when = item => String(item.expirationDate || item.date || item.startDate || item.createdAt || "");
  return records.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? when(a).localeCompare(when(b)) : when(b).localeCompare(when(a))) || String(a.id).localeCompare(String(b.id)));
}

// ─── Home: the member's CME cards, from the member's own helpers ──────────

/**
 * The snapshot in the shape the app's pure helpers read (data.licenses,
 * data.cme, data.settings), with the settings those helpers depend on taken
 * from the member's profile. Nothing here recomputes a rule: the viewer calls
 * the very functions the member's Home calls.
 */
export function snapshotData(snapshot) {
  const member = snapshot?.member || {};
  const lead = Number(member.reminderLeadDays);
  return {
    licenses: [...(snapshot?.sections?.licenses || [])],
    cme: [...(snapshot?.sections?.cme || [])],
    settings: {
      name: typeof member.name === "string" ? member.name : "",
      degreeType: typeof member.degreeType === "string" ? member.degreeType : "",
      primaryState: typeof member.primaryState === "string" ? member.primaryState : "",
      additionalStates: Array.isArray(member.additionalStates) ? member.additionalStates : [],
      reminderLeadDays: Number.isFinite(lead) && lead > 0 ? lead : 90,
    },
  };
}

/**
 * Per-state CME as the member's Home shows it (App.jsx stateComps and
 * renderStateCard): the tracked states, complianceFor on each, soonest
 * renewal first, with the same labels. So "CA: Total logged: 38/50h" in the
 * viewer is the number on the member's card, counted over the current cycle
 * only, never an all-time sum. Em dashes in the shared labels read as
 * commas here, as they do in everything the app sends.
 */
export function stateCmeCards(snapshot) {
  const data = snapshotData(snapshot);
  return trackedStates(data.settings.primaryState, data.settings.additionalStates, data.licenses)
    .map(st => ({ st, comp: complianceFor(data, st), lic: findStateLicense(data.licenses, st) }))
    .sort((a, b) => (a.comp.daysLeft ?? 9e9) - (b.comp.daysLeft ?? 9e9))
    .map(({ st, comp, lic }) => {
      const dl = comp.daysLeft;
      const oneAOnly = (comp.cat1Keywords || []).every(k => String(k).startsWith("AOA Category"));
      return {
        st,
        comp,
        primary: st === data.settings.primaryState,
        hoursLine: comp.noGeneralReq ? "Topic-specific" : totalHoursLabel(comp),
        status: comp.fullyCompliant ? "met" : comp.assessmentStatus === "needs-confirmation" ? "confirm" : "gaps",
        renews: comp.windowAnchored ? `License renews ${formatDate(lic.expirationDate)}` : `No ${st} license on file, tracking a rolling ${comp.cycle}-yr window`,
        daysLeft: dl,
        daysLabel: dl == null ? "" : dl <= 0 ? "OVERDUE" : `${dl} days`,
        urgency: dl == null ? null : dl <= 60 ? "danger" : dl <= 180 ? "warning" : "ok",
        window: `${comp.windowLabel}.${comp.windowSource === "custom" ? " Start set on this license." : ""}`,
        cycleStartIgnored: !!comp.cycleStartIgnored,
        assessment: plainDashes(cmeAssessmentLabel(comp)),
        unmetTopics: comp.topicResults.filter(t => !t.met).map(topicRecordLabel),
        cat1: !comp.cat1Met && comp.cat1Required > 0 ? `${oneAOnly ? "AOA Cat 1" : "Cat 1"}: ${comp.cat1Earned}/${comp.cat1Required}h recorded` : "",
        mate: comp.mate && !comp.mate.met ? `MATE Act (one-time): ${comp.mate.earned}/${comp.mate.required}h recorded` : "",
      };
    });
}

/** Home: what the member's dashboard would flag, their CME cards, and how much is on file. */
export function homeSummary(snapshot) {
  const attention = [];
  for (const sectionKey of ["licenses", "privileges", "insurance", "healthRecords", "screenings", "memberships", "customRecords"]) {
    for (const item of snapshot?.sections?.[sectionKey] || []) {
      const card = recordCard(sectionKey, item, snapshot);
      if (["red", "orange", "amber"].includes(card.color)) attention.push({ sectionKey, label: memberViewSection(sectionKey)?.label || sectionKey, ...card, expirationDate: item.expirationDate });
    }
  }
  attention.sort((a, b) => String(a.expirationDate).localeCompare(String(b.expirationDate)));
  const counts = MEMBER_VIEW_SECTIONS.filter(section => section.group === "credentials")
    .map(section => ({ key: section.key, label: section.label, count: (snapshot?.sections?.[section.key] || []).length }))
    .filter(row => row.count > 0);
  // A cut CME or license list would make the cards read lower than the member's.
  const cmePartial = (snapshot?.truncated || []).some(key => key === "cme" || key === "licenses");
  return { attention, cmeStates: stateCmeCards(snapshot), cmePartial, counts, documents: (snapshot?.documents || []).length };
}

/**
 * Whose account the banner names, never a blank: the member's name, else the
 * email on the account, else the email the Accounts row showed, else the
 * start of the account id. On 2026-09-25, 3 of 11 live profiles had no name
 * and no email at all, so the id is what tells two such accounts apart.
 */
export function memberDisplayName(opened, snapshot = opened?.snapshot, fallback = "") {
  const member = snapshot?.member || {};
  for (const value of [opened?.member?.name, member.name, member.email, member.verifiedEmail, fallback]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const id = String(opened?.member?.profileId || "");
  return /^[0-9a-f]{8}-/i.test(id) ? `member ${id.slice(0, 8)}` : "this member";
}

/** "14:05" for a countdown; "0:00" once over. */
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
