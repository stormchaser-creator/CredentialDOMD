// The email that carries a ticket reply: who it is from, how it is signed, and
// where it links. Pure, so node tests import it directly
// (scripts/share-format.test.mjs, tests/ticket-fix/edge-functions.test.mjs).
//
// A support reply is from CredentialDOMD Support and never signed with a
// person's name (owner decision, ticket 821d2f76). It is either an automated
// reply (the host prefixes every one with the label below) or, from
// 20260929134100, any verified reply send-ticket-reply emails to a member
// (support: true). A reply the owner typed in Admin > Tickets carries no
// label and keeps his signature. The sending address is the same either way,
// so domain verification and reply routing do not change.
//
// Every reply email links to its own ticket in the app: /app/#support/<id>
// opens the Support sheet on that ticket (src/utils/supportDeepLink.js).

export const AUTOMATED_REPLY_LABEL = "CredentialDOMD Support \u{b7} Automated";
export const SUPPORT_APP_URL = "https://credentialdomd.com/app/";
export const REPLY_FROM_ADDRESS = "whit@credentialdomd.com";
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAutomatedReply(body: string): boolean {
  return String(body || "").trimStart().startsWith(AUTOMATED_REPLY_LABEL);
}

// The app link for one ticket; the Support sheet's ticket list without an id.
export function ticketAppLink(ticketId?: string | null): string {
  const id = String(ticketId || "");
  return TICKET_ID.test(id) ? `${SUPPORT_APP_URL}#support/${id.toLowerCase()}` : `${SUPPORT_APP_URL}#support`;
}

export function ticketReplyEmail(reply: string, attachment: boolean, { support = false, ticketId = null }: { support?: boolean; ticketId?: string | null } = {}) {
  const automated = support || isAutomatedReply(reply);
  const signature = automated
    ? ["CredentialDOMD Support", "--\nCredentialDOMD: credential tracking for physicians\nhttps://credentialdomd.com"]
    : ["Eric", "--\nEric Whitney, DO\nCredentialDOMD: credential tracking for physicians, by a physician\nhttps://credentialdomd.com"];
  const text = [
    reply,
    attachment ? "A file is attached to this reply. Open the ticket in the app to see it." : "",
    `Open this ticket in the app to reply: ${ticketAppLink(ticketId)} (More > Support > Your tickets)`,
    ...signature,
  ].filter(Boolean).join("\n\n");
  const fromName = automated ? "CredentialDOMD Support" : "Eric Whitney, DO";
  return { automated, from: `${fromName} <${REPLY_FROM_ADDRESS}>`, text };
}
