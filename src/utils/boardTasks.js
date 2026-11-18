// Board certification tasks: the non-CME duties a board sets (an annual
// assessment, a license check, a QI attestation), each with its next due
// date and a status from the physician's own "Done" marks.
//
// Data: BOARD_TASKS in src/constants/boardRequirements.js, only cadences an
// official page states. Marks: one date per task per period, on the board's
// Board Certification record (customFields), or on data.settings
// (boardTaskMarks) when no record is on file. The physician marks a task done
// and can undo it; nothing is marked automatically.
//
// Extensions spelled out so pure-node test scripts can import this module.
import { BOARD_TASKS } from "../constants/boardRequirements.js";
import { aoaCycle, boardRecordFor } from "./boardCompliance.js";
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

/** The customFields key that holds one task's Done date for one period. */
export function boardTaskField(boardId, task, periodLabel) {
  return `${certName(boardId)} ${task.label} done for ${periodLabel}`;
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

/** Every mark the physician has made for this board: settings first, the record's own win. */
export function boardTaskMarks(data, record) {
  return { ...(data?.settings?.boardTaskMarks || {}), ...(record?.customFields || {}) };
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
 *   status: "done" (marked in this period), "overdue" (past the due date),
 *           "upcoming" (the window has not opened), "not-yet" (the board has
 *           not started it for this certificate), or "due"
 *   due, daysLeft (null when the board has not published a date), doneOn,
 *   field (where a mark is stored), period label.
 * Null when the board has no task data.
 */
export function boardTasksFor(data, board, now = new Date()) {
  const boardId = board?.id;
  const set = boardTaskSet(boardId);
  if (!set) return null;
  const record = boardRecordFor(data?.licenses, boardId);
  const marks = boardTaskMarks(data, record);
  const today = localToday(now);
  const tasks = set.tasks.map(task => {
    const period = taskPeriod(task, now);
    const field = boardTaskField(boardId, task, period.label);
    const mark = marks[field];
    const doneOn = typeof mark === "string" && ISO.test(mark) ? mark : null;
    const begins = startsYear(task, boardId, record);
    let status = "due";
    if (doneOn) status = "done";
    else if (begins && begins > now.getFullYear()) status = "not-yet";
    else if (period.due && today > period.due) status = "overdue";
    else if (period.opens && today < period.opens) status = "upcoming";
    return {
      id: task.id, label: task.label, detail: task.detail || "", cost: task.cost ?? null, source: task.source || set.sourceUrl,
      every: task.every, period: period.label, due: period.due, opens: period.opens,
      daysLeft: period.due ? daysUntilDate(period.due, now) : null,
      doneOn, status, field, startsYear: begins && begins > now.getFullYear() ? begins : null,
    };
  });
  return { boardId, recordId: record?.id || null, tasks, noExpiration: noExpirationFor(boardId, record), checked: set.checked, sourceUrl: set.sourceUrl };
}

/**
 * A mark written as the physician chose it: on the Board Certification
 * record when one is on file, otherwise in settings. `date` null removes it
 * (Undo). Returns { record } or { settings } for the caller to save.
 */
export function applyBoardTaskMark(data, boardId, field, date) {
  const record = boardRecordFor(data?.licenses, boardId);
  const set = (obj) => {
    const out = { ...(obj || {}) };
    if (date && ISO.test(date)) out[field] = date;
    else delete out[field];
    return out;
  };
  if (record) return { record: { ...record, customFields: set(record.customFields) } };
  return { settings: { boardTaskMarks: set(data?.settings?.boardTaskMarks) } };
}

/**
 * Board tasks that belong in the alerts (the bell, the banner, the reminder
 * message): overdue, or due inside the reminder lead window. A task with no
 * published date, already done, or not started yet raises nothing.
 */
export function boardTaskAlerts(data, boards, lead, now = new Date()) {
  const out = [];
  for (const b of boards || []) {
    if (b.followsParent || b.source === "CERT" || b.body) continue;
    const t = boardTasksFor(data, b, now);
    if (!t) continue;
    const open = t.tasks.filter(x => (x.status === "overdue" || x.status === "due") && x.daysLeft != null && x.daysLeft <= lead);
    if (!open.length) continue;
    const issues = open.map(x => x.status === "overdue" ? `${x.label}: overdue since ${x.due}` : `${x.label}: due ${x.due}`);
    const soonest = open.reduce((a, x) => (x.due < a.due ? x : a), open[0]);
    out.push({ state: b.code, issues, daysLeft: soonest.daysLeft, renewal: soonest.due, key: `board:${b.id}`, kind: "board", label: b.label });
  }
  return out;
}
