// Where a support reply email lands in the app. send-ticket-reply links every
// reply to /app/#support/<ticket id> (ticketAppLink in
// supabase/functions/_shared/ticketReplyEmail.ts); emails sent before
// 2026-09-29 link to /app/#support. Both open the Support sheet on "Your
// tickets"; the first also opens that ticket when it is one of the member's.
const TICKET_LINK = /^#support\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// { ticketId } for a support link (ticketId null: the list only); null for
// any other hash.
export function supportDeepLink(hash) {
  if (hash === "#support") return { ticketId: null };
  const match = TICKET_LINK.exec(String(hash || ""));
  return match ? { ticketId: match[1].toLowerCase() } : null;
}
