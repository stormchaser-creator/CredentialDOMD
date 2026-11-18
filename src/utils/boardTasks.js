// Board certification tasks: the non-CME duties a board sets (an annual
// assessment, a license check, a QI attestation), each with its next due
// date and a status from the physician's own "Done" marks.
//
// Data: BOARD_TASKS in src/constants/boardRequirements.js, only cadences an
// official page states. Marks: one date per task per period, on the board's
// Board Certification record (customFields). Marking a task with no record on
// file first creates that record (applyBoardTaskMark `create`), because
// settings.boardTaskMarks is not a synced setting and an online load dropped
// it. A mark already in settings from before is still read and Undo clears
// it. The physician marks a task done and can undo it; nothing is marked
// automatically.
//
// Extensions spelled out so pure-node test scripts can import this module.
import { ABMS_MOC, AOA_OCC, BOARD_TASKS } from "../constants/boardRequirements.js";
import { aoaCycle, boardRecordFor, effectiveBoardSpecialties } from "./boardCompliance.js";
import { daysUntilDate, localToday } from "./dateDays.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "AOA:AOBS" for "AOA:AOBS", "AOA-SUB:AOBS:Neurological Surgery"; "ABMS:ABNS" for an ABMS id. */
export function boardTaskKey(boardId) {
  const [kind, code] = String(boardId || "").split(":");
  return `${String(kind || "").replace(/-SUB$/, "")}:${code}`;
}

/** The task set for a board card, or null when the board has none. */
export function boardTaskSet(boardId) {
  return BOARD_TASKS[boardTaskKey(boardId)] || null;
}

/** The certificate's short name in a mark: "AOBS", "AOBS Neurological Surgery", "ABNS". */
function certName(boardId) {
  const [, code, ...rest] = String(boardId || "").split(":");
  const sub = rest.join(":").trim();
  return sub ? `${code} ${sub}` : code;
}

/** A task's name with its certificate: "AOBS Neurological Surgery Longitudinal Assessment". */
export function boardTaskName(boardId, task) {
  return `${certName(boardId)} ${task.label}`;
}

/** The customFields key that holds one task's Done date for one period. */
export function boardTaskField(boardId, task, periodLabel) {
  return `${boardTaskName(boardId, task)} done for ${periodLabel}`;
}

/** The period a task is in today, its due date (null when not published) and when it opens. */
export function taskPeriod(task, now = new Date()) {
  const y = now.getFullYear();
  if (task.every && typeof task.every === "object" && task.every.anchor === "aoaCycle") {
    const c = aoaCycle(now);
    return { label: `${c.start}-${c.end}`, start: `${c.start}-01-01`, end: `${c.end}-12-31`, due: `${c.end}-12-31`, opens: null };
  }
  const win = task.windows?.[y];
  const due = win?.to || (task.due ? `${y}-${task.due}` : null);
  return { label: String(y), start: `${y}-01-01`, end: `${y}-12-31`, due, opens: win?.from || null };
}

/** Every mark the physician has made for this board: legacy settings first, the records' own win. */
export function boardTaskMarks(data, ...records) {
  const out = { ...(data?.settings?.boardTaskMarks || {}) };
  for (const r of records) Object.assign(out, r?.customFields || {});
  return out;
}

/**
 * An AOA board whose discipline is also picked (AOA:AOBS beside
 * AOA-SUB:AOBS:Neurological Surgery) shows its tasks once, on the discipline
 * card: the same Longitudinal Assessment twice with separate marks and two
 * alerts was one duty counted twice. Returns the parent board id the
 * discipline card shares marks with, or null.
 */
function sharedParentId(data, boardId) {
  const [kind, code] = String(boardId || "").split(":");
  if (kind !== "AOA-SUB") return null;
  return effectiveBoardSpecialties(data).includes(`AOA:${code}`) ? `AOA:${code}` : null;
}
function shadowedByDiscipline(data, boardId) {
  const [kind, code] = String(boardId || "").split(":");
  if (kind !== "AOA") return false;
  return effectiveBoardSpecialties(data).some(id => id.startsWith(`AOA-SUB:${code}:`));
}

/**
 * The Board Certification record a first mark creates when none is on file,
 * named so boardIdsFromLicenses and boardRecordFor find it again: type
 * "Board Certification (AOA)" or "(ABMS)", name "<code> <board or
 * discipline>". Dates are left blank for the physician to fill in.
 */
export function newBoardRecord(boardId, makeId = () => globalThis.crypto.randomUUID()) {
  const [kind, code, ...rest] = String(boardId || "").split(":");
  const sub = rest.join(":").trim();
  const aoa = kind.replace(/-SUB$/, "") === "AOA";
  const boardName = (aoa ? AOA_OCC : ABMS_MOC)[code]?.name || "";
  return {
    id: makeId(),
    type: aoa ? "Board Certification (AOA)" : "Board Certification (ABMS)",
    name: `${code} ${sub || boardName}`.trim(),
    // Made by the app to hold a step's Done mark, not by the physician: no
    // date is known, so it must not raise a "no expiration date" warning.
    // Continuous certification has no end date while its steps are met; a
    // certificate that does expire gets its date added on the record.
    issuedDate: "", expirationDate: "", noExpiration: true,
    notes: "Added when you marked a board step done. If your certificate shows an expiration date, add it here.",
    customFields: {},
  };
}

/**
 * Whether the board says this certificate has no expiration date: an AOA
 * certificate issued after 2018. A typed expiration date on the record is
 * left as the physician entered it and is not read as the certificate's end.
 */
export function noExpirationFor(boardId, record) {
  const set = boardTaskSet(boardId);
  const after = set?.noExpirationIssuedAfter;
  const issued = String(record?.issuedDate || "");
  if (!after || !ISO.test(issued.slice(0, 10)) || Number(issued.slice(0, 4)) <= after) return null;
  const typed = String(record?.expirationDate || "").slice(0, 10);
  return { issued: issued.slice(0, 10), typedExpiration: ISO.test(typed) ? typed : null, url: set.noExpirationUrl || set.sourceUrl };
}

/**
 * The year a task starts, for a task the board starts in the year a
 * time-limited certificate expires. Only a certificate issued in 2018 or
 * before carries a real expiration date; a later one never delays the task.
 */
function startsYear(task, boardId, record) {
  if (!task.startsYearOfExpiration || !record) return null;
  const issued = String(record.issuedDate || "");
  const exp = String(record.expirationDate || "");
  if (!ISO.test(issued.slice(0, 10)) || !ISO.test(exp.slice(0, 10))) return null;
  const after = boardTaskSet(boardId)?.noExpirationIssuedAfter;
  if (after && Number(issued.slice(0, 4)) > after) return null;
  return Number(exp.slice(0, 4));
}

/**
 * The tasks for one board card, each with:
 *   status: "done" (marked in this period), "unconfirmed" (the date passed
 *           with no mark: asked, never alerted),
 *           "upcoming" (the window has not opened), "not-yet" (the board has
 *           not started it for this certificate), or "due"
 *   due, daysLeft (null when the board has not published a date), doneOn,
 *   field (where a mark is stored), period label.
 * Null when the board has no task data.
 */
export function boardTasksFor(data, board, now = new Date()) {
  const boardId = board?.id;
  const set = boardTaskSet(boardId);
  if (!set || shadowedByDiscipline(data, boardId)) return null;
  const record = boardRecordFor(data?.licenses, boardId);
  const parentId = sharedParentId(data, boardId);
  const marks = boardTaskMarks(data, parentId ? boardRecordFor(data?.licenses, parentId) : null, record);
  const today = localToday(now);
  const tasks = set.tasks.map(task => {
    const period = taskPeriod(task, now);
    const field = boardTaskField(boardId, task, period.label);
    // The parent card's mark for the same duty counts here too (and Undo clears it).
    const alsoFields = parentId ? [boardTaskField(parentId, task, period.label)] : [];
    const mark = [field, ...alsoFields].map(f => marks[f]).find(m => typeof m === "string" && ISO.test(m));
    const doneOn = typeof mark === "string" && ISO.test(mark) ? mark : null;
    const begins = startsYear(task, boardId, record);
    let status = "due";
    if (doneOn) status = "done";
    else if (begins && begins > now.getFullYear()) status = "not-yet";
    // Past the date with no mark: the app cannot tell a missed step from one
    // done before it was tracked here, so it asks instead of alarming
    // (2026-11-18: every unmarked ABNS task read overdue on day one).
    else if (period.due && today > period.due) status = "unconfirmed";
    else if (period.opens && today < period.opens) status = "upcoming";
    return {
      id: task.id, label: task.label, detail: task.detail || "", cost: task.cost ?? null, source: task.source || set.sourceUrl,
      every: task.every, period: period.label, due: period.due, opens: period.opens,
      daysLeft: period.due ? daysUntilDate(period.due, now) : null,
      doneOn, status, field, alsoFields, startsYear: begins && begins > now.getFullYear() ? begins : null,
    };
  });
  return { boardId, recordId: record?.id || null, tasks, noExpiration: noExpirationFor(boardId, record), checked: set.checked, sourceUrl: set.sourceUrl };
}

/**
 * A mark written as the physician chose it, on the board's Board
 * Certification record. `date` null removes it (Undo) wherever it is: the
 * record, any record holding a shared parent-card mark (`alsoFields`), and a
 * legacy settings.boardTaskMarks copy. Returns, for the caller to save:
 *   records:  edited existing records (editItem)
 *   create:   a new Board Certification record carrying the mark, when none
 *             is on file (addItem)
 *   settings: { boardTaskMarks } with the legacy copy cleared, when it held one
 */
export function applyBoardTaskMark(data, boardId, field, date, { alsoFields = [], makeId } = {}) {
  const fields = [field, ...alsoFields];
  const marking = !!(date && ISO.test(date));
  const strip = (obj) => {
    const out = { ...(obj || {}) };
    for (const f of fields) delete out[f];
    return out;
  };
  const has = (obj) => !!obj && fields.some(f => Object.prototype.hasOwnProperty.call(obj, f));
  const own = boardRecordFor(data?.licenses, boardId);
  const records = [];
  for (const l of data?.licenses || []) {
    if (!l) continue;
    const mine = own && l.id === own.id;
    if (!(mine && marking) && !has(l.customFields)) continue;
    const customFields = strip(l.customFields);
    if (mine && marking) customFields[field] = date;
    records.push({ ...l, customFields });
  }
  const out = { records };
  if (marking && !own) {
    const rec = newBoardRecord(boardId, makeId);
    out.create = { ...rec, customFields: { [field]: date } };
  }
  const legacy = data?.settings?.boardTaskMarks;
  if (has(legacy)) out.settings = { boardTaskMarks: strip(legacy) };
  return out;
}

/**
 * Board tasks that belong in the alerts (the bell, the banner, the reminder
 * message, the reminder email): due inside the reminder lead window. A date
 * that passed with no mark is asked on the card, never alerted. A task with no
 * published date, already done, or not started yet raises nothing.
 * [{ board, tasks }] per board with any, tasks as boardTasksFor gives them.
 * boardTaskAlerts makes the app's one entry per board from it; the reminder
 * email (supabase/functions/_shared/reminderBoardSteps.mjs) names each task.
 */
export function openBoardTasks(data, boards, lead, now = new Date()) {
  const out = [];
  for (const b of boards || []) {
    if (b.followsParent || b.source === "CERT" || b.body) continue;
    const t = boardTasksFor(data, b, now);
    if (!t) continue;
    const open = t.tasks.filter(x => x.status === "due" && x.daysLeft != null && x.daysLeft >= 0 && x.daysLeft <= lead);
    if (open.length) out.push({ board: b, tasks: open });
  }
  return out;
}

/** The alert entries for openBoardTasks: one per board, as the CME gaps list them. */
export function boardTaskAlerts(data, boards, lead, now = new Date()) {
  return openBoardTasks(data, boards, lead, now).map(({ board: b, tasks: open }) => {
    const issues = open.map(x => `${x.label}: due ${x.due}`);
    const soonest = open.reduce((a, x) => (x.due < a.due ? x : a), open[0]);
    return { state: b.code, issues, daysLeft: soonest.daysLeft, renewal: soonest.due, key: `board:${b.id}`, kind: "board", label: b.label };
  });
}
