// docs@, cme@ and contacts@ through supabase/functions/email-inbound/index.ts
// for an account made from an email typed into Stripe Checkout (pay-first
// sign-up, 20261120190000): nothing is stored or filed until its owner signs
// in once with the email code, and the sender is told how to turn docs@ on.
// Synthetic people only. Run: node --test scripts/email-inbound-pay-first.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";

const PROFILE = "6d1f9e3b-8a52-4e5c-8b68-4a0f8e2d3c21";
const ME = "new.buyer@clinic.example";
const rows = (t) => harness.db.rows(t);
const REPLY = /^Log in once with your email code to turn on docs@\.\n\nOpen the app: https:\/\/credentialdomd\.com\/app\/\n\nCredentialDOMD\nhttps:\/\/credentialdomd\.com$/;

before(async () => { await loadFunction(); });
beforeEach(() => {
  resetWorld();
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_payFirstSynthetic", email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: "New Buyer", degree_type: "DO" });
});

const pdf = { filename: "license.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 synthetic") };
let n = 0;
for (const [route, to] of [["docs", "docs@credentialdomd.com"], ["cme", "cme@credentialdomd.com"], ["contacts", "contacts@credentialdomd.com"]]) {
  test(`${route}@ files nothing for an unproven pay-first account and says how to turn it on`, async () => {
    harness.unproven.add(PROFILE);
    await deliver({ id: `p${++n}`, from: `New Buyer <${ME}>`, to, subject: "Forward", text: "Please see attached.", attachments: [pdf] });
    assert.equal(rows("documents").length, 0);
    assert.equal(rows("peer_references").length, 0);
    assert.equal(rows("document_requests").length, 0);
    const replies = harness.sent.filter(m => m.to?.[0] === ME);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, REPLY);
  });
}

test("once proven (or for any other account), docs@ works as before", async () => {
  await deliver({ id: `p${++n}`, from: `New Buyer <${ME}>`, to: "docs@credentialdomd.com", subject: "Forward", text: "Please see attached.", attachments: [pdf] });
  assert.ok(!harness.sent.some(m => REPLY.test(m.text || "")));
});
