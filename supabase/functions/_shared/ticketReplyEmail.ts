// The email that carries a ticket reply: who it is from and how it is signed.
// Pure, so node tests import it directly (scripts/share-format.test.mjs).
//
// An automated reply (the ticket agent's; the host prefixes every one with the
// label below) is from CredentialDOMD Support and never signed with a person's
// name (owner decision, ticket 821d2f76). A reply the owner typed in
// Admin > Tickets carries no label and keeps his signature. The sending address
// is the same either way, so domain verification and reply routing do not
// change.

export const AUTOMATED_REPLY_LABEL = "CredentialDOMD Support \u{b7} Automated";
export const SUPPORT_APP_URL = "https://credentialdomd.com/app/";
export const REPLY_FROM_ADDRESS = "whit@credentialdomd.com";

export function isAutomatedReply(body: string): boolean {
  return String(body || "").trimStart().startsWith(AUTOMATED_REPLY_LABEL);
}

export function ticketReplyEmail(reply: string, attachment: boolean) {
  const automated = isAutomatedReply(reply);
  const signature = automated
    ? ["CredentialDOMD Support", "--\nCredentialDOMD: credential tracking for physicians\nhttps://credentialdomd.com"]
    : ["Eric", "--\nEric Whitney, DO\nCredentialDOMD: credential tracking for physicians, by a physician\nhttps://credentialdomd.com"];
  const text = [
    reply,
    attachment ? "A file is attached to this reply. Open the ticket in the app to see it." : "",
    `Reply here: ${SUPPORT_APP_URL}#support (More > Support > Your tickets)`,
    ...signature,
  ].filter(Boolean).join("\n\n");
  const fromName = automated ? "CredentialDOMD Support" : "Eric Whitney, DO";
  return { automated, from: `${fromName} <${REPLY_FROM_ADDRESS}>`, text };
}
