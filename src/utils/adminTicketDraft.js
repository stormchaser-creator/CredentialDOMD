/**
 * The admin "New ticket" form, held to what create-ticket accepts
 * (supabase/functions/create-ticket/index.ts: VALID_CATEGORIES, a subject of
 * at least 3 characters and details of at least 10). The form used to offer
 * a "Question" category the server and the support_tickets CHECK both
 * refuse, so choosing it always failed and the ticket and its screenshot
 * were never created (ticket 95e6425f).
 */
export const ADMIN_TICKET_CATEGORIES = Object.freeze([
  Object.freeze({ value: "feature_request", label: "Feature" }),
  Object.freeze({ value: "bug", label: "Bug" }),
  Object.freeze({ value: "data_issue", label: "Data issue" }),
  Object.freeze({ value: "other", label: "Question or other" }),
]);
export const TICKET_SUBJECT_MIN = 3;
export const TICKET_BODY_MIN = 10;

/** Why the draft cannot be sent yet, or "" when create-ticket will accept it. */
export function adminTicketDraftProblem({ subject = "", body = "", category = "" } = {}) {
  const s = subject.trim(), b = body.trim();
  if (!ADMIN_TICKET_CATEGORIES.some(option => option.value === category)) return "Choose a category.";
  if (s.length < TICKET_SUBJECT_MIN) return `Add a one-line summary (at least ${TICKET_SUBJECT_MIN} characters).`;
  if (b.length < TICKET_BODY_MIN) return `Add details: at least ${TICKET_BODY_MIN} characters (${TICKET_BODY_MIN - b.length} more).`;
  return "";
}
