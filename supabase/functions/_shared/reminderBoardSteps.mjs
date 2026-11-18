// Board certification steps in the daily reminder email (send-reminders).
//
// The app alerts on a board step (an annual assessment, a QI attestation)
// due inside the reminder lead window until the physician marks it done
// (src/utils/boardTasks.js openBoardTasks, through boardTaskAlerts, called from
// src/utils/notifications.js generateAlerts). The email names the same steps
// by running that same code, copied verbatim into _shared/app/ by
// scripts/sync-shared-app-modules.mjs, on the same data shape the app builds:
//   licenses: the member's Board Certification records, as the app loads them
//             (src/lib/supabase.js toCamelObj: snake_case columns to
//             camelCase keys, so custom_fields, which holds the Done marks,
//             is customFields, and lifecycle_status is lifecycleStatus)
//   settings: { specialties: profiles.specialties, degreeType: profiles.degree_type }
//             (SETTINGS_TO_PROFILE in src/lib/supabase.js)
// A step whose date passed with no mark, one already done, one not opened or
// not started, and one past the lead window raise nothing, exactly as in the app.
//
// A mark kept only in the legacy device setting settings.boardTaskMarks has
// no profiles column, so the server cannot see it; the app writes every new
// mark on the board's record (boardTasks.js applyBoardTaskMark).
//
// The member's acknowledgements (alert_acks) never name a board step in the
// app (only a record's id), so none applies here; the banner snooze applies
// through reminderCadence.mjs, which reads the banner's "cme:board:..." parts.
//
// Plain JavaScript so the Deno function and the node tests share one copy.
import { boardComplianceFor } from './app/utils/boardCompliance.js';
import { openBoardTasks, boardTaskName } from './app/utils/boardTasks.js';

/** The section name the email's fingerprint gives a board step (reminderCadence.mjs). */
export const BOARD_SECTION = 'board';

/** "custom_fields" -> "customFields", the app's own rule (src/lib/supabase.js snakeToCamel). */
const snakeToCamel = (str) => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** A database row as the app's record (src/lib/supabase.js toCamelObj, userId dropped). */
export function appRecordOf(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[snakeToCamel(k)] = v;
  delete out.userId;
  return out;
}

/** profiles.specialties (JSONB) as the list of board ids Settings holds. */
export function specialtiesOf(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** The `data` the app's board code reads, from a recipient row and their Board Certification rows. */
export function boardDataFor(profile, boardRows) {
  return {
    settings: { specialties: specialtiesOf(profile?.specialties), degreeType: profile?.degree_type ?? '' },
    licenses: (boardRows || []).map(appRecordOf),
    cme: [],
  };
}

/** The stable id of one step in one period: "board:<boardId>:<taskId>:<period>". */
export const boardStepId = (boardId, step) => `board:${boardId}:${step.id}:${step.period}`;

/**
 * The reminder items for a member's board steps due within `lead` days of
 * `now`: { id, table: "board", label, name, exp, days, ... } in the shape
 * send-reminders lists its records in. Throws when the app code throws; the
 * caller leaves the steps out and keeps the credential digest.
 */
export function reminderBoardItems(profile, boardRows, { lead, now = new Date() }) {
  const data = boardDataFor(profile, boardRows);
  const items = [];
  for (const { board, tasks } of openBoardTasks(data, boardComplianceFor(data), lead, now)) {
    for (const step of tasks) {
      items.push({
        id: boardStepId(board.id, step), table: BOARD_SECTION, label: 'Board certification',
        name: boardTaskName(board.id, step), exp: step.due, days: step.daysLeft,
        state: null, type: null, isDea: false, isLicense: false,
      });
    }
  }
  return items;
}
