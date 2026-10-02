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
// so domain verification does not change.
//
// Where a reply to the email goes (review 2026-09-29). A support reply is
// reply_to support+<ticket id>@credentialdomd.com: email-inbound adds a reply
// from the ticket owner's confirmed, authenticated mailbox to that ticket, as
// the member's own message, and relays anything else to the owner's inbox as
// it relays every other address. Until then every reply went straight to the
// owner's personal mailbox and never reached the ticket, so the agent never
// saw it. A reply the owner typed keeps his mailbox: he answers those himself.
//
// Every reply email links to its own ticket in the app: /app/#support/<id>
// opens the Support sheet on that ticket (src/utils/supportDeepLink.js).

import { homeScreenHint } from "./homeScreenHint.ts";

export const AUTOMATED_REPLY_LABEL = "CredentialDOMD Support \u{b7} Automated";
export const SUPPORT_APP_URL = "https://credentialdomd.com/app/";
export const REPLY_FROM_ADDRESS = "whit@credentialdomd.com";
export const OWNER_REPLY_TO = "stormchaser@elryx.com";
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORT_TICKET_ADDRESS = /^support\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@credentialdomd\.com$/i;

export function isAutomatedReply(body: string): boolean {
  return String(body || "").trimStart().startsWith(AUTOMATED_REPLY_LABEL);
}

// The app link for one ticket; the Support sheet's ticket list without an id.
export function ticketAppLink(ticketId?: string | null): string {
  const id = String(ticketId || "");
  return TICKET_ID.test(id) ? `${SUPPORT_APP_URL}#support/${id.toLowerCase()}` : `${SUPPORT_APP_URL}#support`;
}

// The reply_to of a support reply: support+<ticket id>@, or the plain support
// mailbox (relayed to the owner) when there is no ticket id to put in it.
export function supportReplyAddress(ticketId?: string | null): string {
  const id = String(ticketId || "");
  return TICKET_ID.test(id) ? `support+${id.toLowerCase()}@credentialdomd.com` : "support@credentialdomd.com";
}

// The ticket a support+<ticket id>@ address names, lowercased; null for any
// other address. email-inbound routes on this.
export function ticketFromSupportAddress(address?: string | null): string | null {
  const m = SUPPORT_TICKET_ADDRESS.exec(String(address || "").trim());
  return m ? m[1].toLowerCase() : null;
}

// Where a quoted original starts in a reply: the attribution line of Gmail
// and Apple Mail ("On <date>, <name> wrote:", with a digit of the date in
// it), Outlook's separator and header block, or our own email's app link
// line quoted without markers.
const QUOTE_STARTS = [
  /^\s*On\b.*\d.*\bwrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*From:\s.*credentialdomd\.com/i,
  /^\s*Open this ticket in the app to reply:/i,
];

// The member's own words in a reply to one of these emails: the text above
// the quoted original, with quoted (">") lines between them dropped, at most
// `max` characters (reply-ticket's limit). "" when nothing is left.
export function replyTextWithoutQuote(text?: string | null, max = 10000): string {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "On <date>, <name> <address>" wrapped onto a second line ending "wrote:".
    const wrapped = /^\s*On\b.*\d/i.test(line) && i + 1 < lines.length && /\bwrote:\s*$/i.test(lines[i + 1]);
    if (wrapped || QUOTE_STARTS.some((re) => re.test(line))) { end = i; break; }
  }
  return lines.slice(0, end).filter((line) => !/^\s*>/.test(line)).join("\n")
    .replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
}

export function ticketReplyEmail(reply: string, attachment: boolean, { support = false, ticketId = null }: { support?: boolean; ticketId?: string | null } = {}) {
  const automated = support || isAutomatedReply(reply);
  const signature = automated
    ? ["CredentialDOMD Support", "--\nCredentialDOMD: credential tracking for physicians\nhttps://credentialdomd.com"]
    : ["Eric", "--\nEric Whitney, DO\nCredentialDOMD: credential tracking for physicians, by a physician\nhttps://credentialdomd.com"];
  const text = [
    reply,
    attachment ? "A file is attached to this reply. Open the ticket in the app to see it." : "",
    `Open this ticket in the app to reply: ${ticketAppLink(ticketId)} (More > Get help > Your tickets)`,
    homeScreenHint("More > Get help > Your tickets"),
    ...signature,
  ].filter(Boolean).join("\n\n");
  const fromName = automated ? "CredentialDOMD Support" : "Eric Whitney, DO";
  const replyTo = automated ? supportReplyAddress(ticketId) : OWNER_REPLY_TO;
  return { automated, from: `${fromName} <${REPLY_FROM_ADDRESS}>`, replyTo, text };
}
