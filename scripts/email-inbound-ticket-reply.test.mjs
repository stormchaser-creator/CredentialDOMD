// End to end through supabase/functions/email-inbound/index.ts: a member who
// hits Reply on a support email (reply_to support+<ticket id>@credentialdomd.com,
// set by send-ticket-reply) reaches the ticket, and anything that does not pass
// every check is relayed to the owner's inbox with the reason, never dropped.
//
// Review 2026-09-29: every reply_to was the owner's personal mailbox, so a
// member's emailed answer never entered support_messages, the ticket agent
// never saw it, and the ticket looked unanswered on the member's side.
//
// The function runs under node with its network edges replaced by
// scripts/email-inbound-harness.mjs. Synthetic ids, text and addresses only.
// Run: node --test scripts/email-inbound-ticket-reply.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";

const MEMBER = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const TICKET = "00000000-0000-4000-8000-0000000000c1";
const MEMBER_MAIL = "member@example.test";
const OTHER_MAIL = "other@example.test";
const OWNER_INBOX = "stormchaser@elryx.com";
const SUPPORT = `support+${TICKET}@credentialdomd.com`;
const EM_DASH = String.fromCodePoint(0x2014);
const GMAIL_REPLY = `Thanks, the export works now.\n\nSent from my iPhone\n\nOn Tue, Sep 29, 2026 at 10:29 AM CredentialDOMD Support <\nwhit@credentialdomd.com> wrote:\n> CredentialDOMD Support · Automated\n>\n> The export is fixed.\n>\n> Open this ticket in the app to reply: https://credentialdomd.com/app/#support/${TICKET}`;

const rows = (t) => harness.db.rows(t);
const toOwner = () => harness.sent.filter((m) => m.to?.[0] === OWNER_INBOX);
const ledger = () => rows("inbound_emails");

let n = 0;
const reply = (over = {}) => deliver({
  id: `r${++n}`, from: `Member Example <${MEMBER_MAIL}>`, to: SUPPORT, subject: "Re: Synthetic export question (CredentialDOMD)", text: GMAIL_REPLY, ...over,
});

function seed() {
  rows("mailbox_claims").push({ address: MEMBER_MAIL, profile_id: MEMBER, proof: "verified", terminal_at: null });
  rows("mailbox_claims").push({ address: OTHER_MAIL, profile_id: OTHER, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: MEMBER, auth_user_id: "user_member", email: MEMBER_MAIL, access_status: "active", verified_email: MEMBER_MAIL, deleted_at: null });
  rows("profiles").push({ id: OTHER, auth_user_id: "user_other", email: OTHER_MAIL, access_status: "active", verified_email: OTHER_MAIL, deleted_at: null });
  rows("support_tickets").push({ id: TICKET, user_id: MEMBER, subject: "Synthetic export question", archived_at: null });
}

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); seed(); });

// The relay the owner gets instead, with the reason on its first line.
function assertRelayed(r, why, label) {
  assert.equal(r.status, 200, label);
  assert.equal(r.body.route, "forward", label);
  assert.equal(rows("support_messages").length, 0, `${label}: nothing is added to the ticket`);
  assert.equal(harness.sent.length, 1, `${label}: one relay, nothing to the member`);
  const [relay] = toOwner();
  assert.ok(relay, `${label}: relayed to the owner`);
  assert.equal(relay.subject, `[credentialdomd.com support+${TICKET}] Re: Synthetic export question (CredentialDOMD)`, label);
  assert.deepEqual(relay.reply_to, [r.from], `${label}: the owner's plain reply goes back to the sender`);
  const first = relay.text.split("\n")[0];
  assert.equal(first, `Not added to ticket ${TICKET.slice(0, 8)}: ${why}.`, label);
  assert.ok(!relay.text.includes(EM_DASH), `${label}: no em dash`);
  assert.match(ledger().at(-1).detail, new RegExp(`^forwarded to ${OWNER_INBOX.replace(".", "\\.")}, .*; Not added to ticket`), label);
}

test("a member's reply from their confirmed, authenticated mailbox is added to the ticket as their own message", async () => {
  const r = await reply();
  assert.equal(r.status, 200);
  assert.equal(r.body.filed, true);
  assert.equal(r.body.ticket, TICKET);
  const [message] = rows("support_messages");
  assert.equal(rows("support_messages").length, 1);
  assert.equal(message.ticket_id, TICKET);
  assert.equal(message.author_id, MEMBER, "the member is the author");
  assert.equal(message.is_admin_reply, false, "not a support reply: the agent reads it as the member writing");
  assert.equal(message.body, "Thanks, the export works now.\n\nSent from my iPhone", "the quoted support email is cut");
  assert.equal(r.body.message_id, message.id);
  const [row] = ledger();
  assert.equal(message.client_request_id, row.id, "the ledger row is the request key");
  assert.equal(row.status, "done");
  assert.equal(row.detail, `filed on ticket ${TICKET.slice(0, 8)} as message ${message.id.slice(0, 8)}`);
  assert.equal(row.profile_id, MEMBER);
  assert.equal(harness.sent.length, 0, "nobody is emailed: the reply is in the thread");
});

test("the same message delivered twice is added once", async () => {
  const messageId = "<same@mail.test>";
  await reply({ messageId });
  const again = await reply({ messageId });
  assert.equal(again.body.duplicate, true);
  assert.equal(rows("support_messages").length, 1);
  // A stale attempt re-claimed after it had already inserted: the unique request key refuses the second row.
  harness.failInsert = (table) => (table === "support_messages" ? { message: "duplicate key value violates unique constraint \"support_messages_client_request_uniq\"", code: "23505" } : null);
  const reclaimed = await reply();
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.body.duplicate, true);
  assert.equal(ledger().at(-1).detail, `filed on ticket ${TICKET.slice(0, 8)} (already added)`);
  assert.equal(harness.sent.length, 0);
});

test("a signature logo inline does not stop the reply; its text still reaches the ticket", async () => {
  const r = await reply({ attachments: [{ filename: "logo.png", contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), disposition: "inline" }] });
  assert.equal(r.body.filed, true);
  assert.equal(rows("support_messages").length, 1);
});

test("anything that fails a check is relayed to the owner with the reason, never dropped and never added", async (t) => {
  const cases = [
    ["an unknown sender", { from: "stranger@example.test" }, null, "the sender is not a confirmed address of the ticket's owner"],
    ["another account's confirmed mailbox", { from: OTHER_MAIL }, null, "the sender is not a confirmed address of the ticket's owner"],
    ["a forward that is not positively authenticated", {}, () => { harness.rawAuth = "mx.resend.com; spf=pass smtp.mailfrom=attacker.example; dkim=none; dmarc=none"; },
      "the message is not authenticated (no DMARC pass, or aligned SPF and DKIM pass)"],
    ["an auto-reply", { headers: { "Auto-Submitted": "auto-replied" } }, null, "automated mail (an auto-reply, bounce or list message)"],
    ["an archived ticket", {}, () => { rows("support_tickets")[0].archived_at = "2026-09-29T00:00:00Z"; }, "the ticket is archived"],
    ["a ticket that does not exist", { to: `support+00000000-0000-4000-8000-0000000000c9@credentialdomd.com` }, null, "there is no such ticket"],
    ["an account without access", {}, () => { rows("profiles")[0].access_status = "revoked"; }, "the ticket owner's account is not active"],
    ["a ticket an admin owns", {}, () => { rows("app_admins").push({ profile_id: MEMBER }); }, "the ticket belongs to an admin"],
    ["a reply with a file", { attachments: [{ filename: "screen.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }] }, null, "it carries files, which are added in the app"],
    ["a reply that is only the quote", { text: `On Tue, Sep 29, 2026 at 10:29 AM CredentialDOMD Support <whit@credentialdomd.com> wrote:\n> The export is fixed.` }, null,
      "nothing was left once the quoted email was removed"],
    ["an insert the database refuses as a support reply", {}, () => { harness.failInsert = (table) => (table === "support_messages" ? { message: "support replies need a verified reply", code: "42501" } : null); },
      "the database refused it as a support reply"],
  ];
  for (const [label, over, arrange, why] of cases) {
    await t.test(label, async () => {
      resetWorld(); seed();
      arrange?.();
      const r = await reply(over);
      const to = over.to ?? SUPPORT;
      if (over.to) {
        // The relay subject names the address it came to.
        assert.equal(rows("support_messages").length, 0);
        assert.equal(toOwner()[0].subject, `[credentialdomd.com ${to.split("@")[0]}] Re: Synthetic export question (CredentialDOMD)`);
        assert.equal(toOwner()[0].text.split("\n")[0], `Not added to ticket ${to.slice(8, 16)}: ${why}.`);
        return;
      }
      assertRelayed({ ...r, from: over.from ?? MEMBER_MAIL }, why, label);
      if (label === "a reply with a file") assert.equal(toOwner()[0].attachments?.length, 1, "the file goes to the owner with it");
    });
  }
});

test("five replies by email a day reach one ticket; the sixth is relayed, so an auto-responder cannot loop with the agent", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await reply({ text: `Synthetic reply number ${i + 1}.` })).body.filed, true);
  const sixth = await reply({ text: "Synthetic reply number 6." });
  assert.equal(rows("support_messages").length, 5);
  assert.equal(sixth.body.route, "forward");
  assert.equal(toOwner()[0].text.split("\n")[0], `Not added to ticket ${TICKET.slice(0, 8)}: 5 replies already reached this ticket by email today.`);
});

test("plain support@ is relayed exactly as before, with no reason line", async () => {
  const r = await reply({ to: "support@credentialdomd.com", text: "A synthetic question for support." });
  assert.equal(r.body.route, "forward");
  assert.equal(rows("support_messages").length, 0);
  const [relay] = toOwner();
  assert.equal(relay.subject, "[credentialdomd.com support] Re: Synthetic export question (CredentialDOMD)");
  assert.match(relay.text, /^From: Member Example <member@example\.test>\n/);
  assert.deepEqual(relay.reply_to, [MEMBER_MAIL]);
});
