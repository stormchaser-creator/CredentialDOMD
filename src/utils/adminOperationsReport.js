export const ADMIN_REPORT_DAYS = Object.freeze([7, 30, 90]);
export const ADMIN_REPORT_FRESH_MS = 5 * 60 * 1000;

export const ADMIN_REPORT_DEFINITIONS = Object.freeze({
  accounts: "Account profiles excluding deleted or closed profiles. Includes administrators and incomplete signup profiles; this is not a paid membership count.",
  active: "Profiles excluding deleted or closed accounts, with active account status. Account status does not establish paid membership or current product access.",
  signups: "Profiles excluding deleted or closed accounts and administrators, created in the selected window with a linked sign-in identity and nonblank email. This is not proof of mailbox verification or payment.",
  open: "Current tickets excluding archived, resolved and closed tickets, regardless of their creation date.",
  urgent: "Current open tickets marked urgent.",
  approval: "Current open customer tickets waiting for administrative approval.",
  page_views: "Recorded page-load events in the selected window. Repeated visits count again; this is not a unique visitor count.",
  tickets: "Tickets created in the selected window, including tickets later resolved or archived.",
  errors: "Retained client error reports in the selected window. Reports are pruned after 7 days and can be cleared by administrators; older days are incomplete. Zero does not prove that no errors occurred.",
  unread_replies: "Your messages with a physician reply newer than the last time you opened Messages.",
  new_errors: "Retained error reports newer than the last time you opened Errors.",
  waitlist_waiting: "Waitlist signups whose email has no active account yet. Guide-only requests are not counted.",
  fields_pending: "Fields Vera proposed that are waiting for your approve or dismiss.",
});

const ATTENTION_KEYS = ["unread_replies", "new_errors_since_seen", "waitlist_waiting", "fields_pending"];

/** The attention counts behind the tab labels and Overview cards, or null when absent or malformed. */
export function normalizeAdminAttention(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const result = {};
  for (const key of ATTENTION_KEYS) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) return null;
    result[key] = input[key];
  }
  return result;
}

const invalidReport = () => new Error("The reporting service returned an incomplete report. Refresh to try again; counts are unavailable until a valid report is received.");
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidReport();
  return value;
};
const timestamp = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalidReport();
  return new Date(value).toISOString();
};

/** Accept only the aggregate contract. Extra server fields can never enter exports. */
export function normalizeAdminReport(input, expectedDays) {
  if (!input || input.schema_version !== 1 || !ADMIN_REPORT_DAYS.includes(expectedDays) || input.days !== expectedDays) throw invalidReport();
  const generated_at = timestamp(input.generated_at);
  const period_start = timestamp(input.period_start);
  const period_end = timestamp(input.period_end);
  const firstDay = new Date(period_end);
  firstDay.setUTCHours(0, 0, 0, 0);
  firstDay.setUTCDate(firstDay.getUTCDate() - expectedDays + 1);
  if (period_start !== firstDay.toISOString() || generated_at !== period_end || Date.parse(period_start) > Date.parse(period_end)) throw invalidReport();
  const accounts = { total: count(input.accounts?.total), active: count(input.accounts?.active), new_in_period: count(input.accounts?.new_in_period) };
  const support = { open: count(input.support?.open), urgent: count(input.support?.urgent), waiting_approval: count(input.support?.waiting_approval), oldest_open_at: input.support?.oldest_open_at === null ? null : timestamp(input.support?.oldest_open_at) };
  const errors = { in_period: count(input.errors?.in_period) };
  // Additive and optional within schema 1: a server without the attention
  // block still yields a complete report; a malformed block does not.
  // (null is the normalized form of "absent", so a report can be re-checked.)
  const attention = input.attention == null ? null : normalizeAdminAttention(input.attention);
  if (input.attention != null && !attention) throw invalidReport();
  if (accounts.active > accounts.total || support.urgent > support.open || support.waiting_approval > support.open
    || (support.open === 0) !== (support.oldest_open_at === null)
    || (support.oldest_open_at && Date.parse(support.oldest_open_at) > Date.parse(generated_at))) throw invalidReport();
  if (!Array.isArray(input.daily) || input.daily.length !== expectedDays) throw invalidReport();
  const daily = input.daily.map((row, index) => {
    const date = new Date(firstDay);
    date.setUTCDate(date.getUTCDate() + index);
    if (!row || row.day !== date.toISOString().slice(0, 10)) throw invalidReport();
    return { day: row.day, signups: count(row.signups), page_views: count(row.page_views), tickets: count(row.tickets), errors: count(row.errors) };
  });
  if (daily.reduce((sum, row) => sum + row.signups, 0) !== accounts.new_in_period
    || daily.reduce((sum, row) => sum + row.errors, 0) !== errors.in_period) throw invalidReport();
  return { schema_version: 1, generated_at, period_start, period_end, days: expectedDays, accounts, support, errors, attention, daily };
}

export function adminReportErrorMessage(error) {
  if (["PGRST202", "42883"].includes(error?.code)) return "Reports are not available in this environment yet. Apply the reporting database update before counts can be shown.";
  if (["42501", "PGRST301", "PGRST302"].includes(error?.code) || [401, 403].includes(error?.status)) return "The reporting service could not verify administrator access. Sign in again and refresh the report.";
  if (error?.message === invalidReport().message) return error.message;
  return "The report could not be loaded. Check your connection and refresh. Counts are unavailable until a complete report is received.";
}

export function formatReportTimestamp(value) {
  return timestamp(value).replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/** Quote every cell, double quotes, and neutralize spreadsheet formulas even after whitespace. */
export function reportCsvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\p{Cc}]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function adminReportCsv(input, exportedAt = new Date().toISOString()) {
  const report = normalizeAdminReport(input, input?.days);
  const rows = [["Section", "Metric", "UTC date", "Value", "Definition"]];
  const add = (section, metric, value, definition = "", day = "") => rows.push([section, metric, day, value, definition]);
  add("Report", "Name", "CredentialDOMD administrative operations");
  add("Report", "Schema version", report.schema_version);
  add("Report", "Generated at", report.generated_at, "Database snapshot timestamp.");
  add("Report", "Exported at", timestamp(exportedAt));
  add("Report", "Window start inclusive", report.period_start);
  add("Report", "Window end exclusive", report.period_end);
  add("Report", "UTC calendar days", report.days, "Includes the current, partial UTC day.");
  add("Report", "Scope", "All records available to the server report; independent of directory display limits.", "Aggregate operational counts only. No personal information or payment/revenue calculation.");
  add("Snapshot", "Account profiles", report.accounts.total, ADMIN_REPORT_DEFINITIONS.accounts);
  add("Snapshot", "Active account profiles", report.accounts.active, ADMIN_REPORT_DEFINITIONS.active);
  add("Window", "New signup profiles", report.accounts.new_in_period, ADMIN_REPORT_DEFINITIONS.signups);
  add("Snapshot", "Open tickets", report.support.open, ADMIN_REPORT_DEFINITIONS.open);
  add("Snapshot", "Urgent open tickets", report.support.urgent, ADMIN_REPORT_DEFINITIONS.urgent);
  add("Snapshot", "Tickets awaiting approval", report.support.waiting_approval, ADMIN_REPORT_DEFINITIONS.approval);
  add("Snapshot", "Oldest open ticket created at", report.support.oldest_open_at ?? "None", ADMIN_REPORT_DEFINITIONS.open);
  add("Window", "Retained error reports", report.errors.in_period, ADMIN_REPORT_DEFINITIONS.errors);
  if (report.attention) {
    add("Attention", "Unread message replies", report.attention.unread_replies, ADMIN_REPORT_DEFINITIONS.unread_replies);
    add("Attention", "New error reports since last opened", report.attention.new_errors_since_seen, ADMIN_REPORT_DEFINITIONS.new_errors);
    add("Attention", "Waiting on the waitlist", report.attention.waitlist_waiting, ADMIN_REPORT_DEFINITIONS.waitlist_waiting);
    add("Attention", "Field proposals awaiting review", report.attention.fields_pending, ADMIN_REPORT_DEFINITIONS.fields_pending);
  }
  for (const row of report.daily) {
    add("Daily", "New signup profiles", row.signups, ADMIN_REPORT_DEFINITIONS.signups, row.day);
    add("Daily", "Recorded page loads", row.page_views, ADMIN_REPORT_DEFINITIONS.page_views, row.day);
    add("Daily", "Tickets created", row.tickets, ADMIN_REPORT_DEFINITIONS.tickets, row.day);
    add("Daily", "Retained error reports", row.errors, ADMIN_REPORT_DEFINITIONS.errors, row.day);
  }
  return "\uFEFF" + rows.map(row => row.map(reportCsvCell).join(",")).join("\r\n") + "\r\n";
}
