// Checks for the decision that says whose account receives a forwarded
// credentialing document: inboundMatch / chooseInboundAccount, plus the two
// transition rules
// that decide who may confirm a mailbox in the first place
// (provenByAnotherAccount and refuseAddressClaim). All three live in
// supabase/functions/forwarding-address/lib.ts, which touches no network, so
// node runs them directly. Node 22.18+ strips the type annotations on import;
// no build step, no runner.
// Run: node scripts/inbound-routing.test.mjs
//
// What went wrong, and why these checks are worth having:
//
// email-inbound's matchProfile matched a confirmed forwarding_addresses row
// first and then fell back to lower(profiles.email). profiles.email is a text
// box in Settings, and the unique index on it is PARTIAL, so any address no
// profile currently held was free to claim by typing it. The genuine physician
// then forwards a real credential document from that mailbox; SPF, DKIM and
// DMARC all pass, because the mail IS genuine; the matcher picks the account
// that typed the address; the file is written under that account's
// auth_user_id and documents_owner RLS hands it over. That is disclosure of the
// victim's document. Sender authentication cannot catch it: it proves the
// mailbox sent the mail, never that the account we chose owns the mailbox.

import { readFileSync } from "node:fs";

const {
  chooseInboundAccount, inboundMatch, provenByAnotherAccount, refuseAddressClaim, normalizeEmail,
} = await import("../supabase/functions/forwarding-address/lib.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const ADDR = "name@hospital.org";
const VICTIM = { id: "victim", auth_user_id: "user_victim", access_status: "active", matched_email: ADDR };
const ATTACKER = { id: "attacker", auth_user_id: "user_attacker", access_status: "active", matched_email: ADDR };
const chosenId = (input) => (chooseInboundAccount(input) || { id: null }).id;
const reasonOf = (input) => inboundMatch(input).reason;

// ── Pass 1: a confirmed forwarding row ──────────────────────────────────────
// Somebody opened a link sent to that mailbox and pressed Confirm, which is the
// only thing in this system that proves an account can read a mailbox.
eq("a confirmed forwarding row routes the message",
  chosenId({ from: ADDR, confirmed: [VICTIM] }), "victim");
// Two ACCOUNTS each holding proof is the case a review reproduced: a confirmed
// forwarding row on one and a provider-verified column on the other resolved
// silently to the confirmed one, which is the older claim and never re-tested.
// Both proofs are real, taken at different times, and together they say we do
// not know who reads the mailbox now, so nobody gets the mail.
eq("a confirmed row does NOT win over a verified column on another account",
  chosenId({ from: ADDR, confirmed: [VICTIM], verified: [ATTACKER] }), null);
eq("and the refusal is reported as ambiguity, not as no-match",
  reasonOf({ from: ADDR, confirmed: [VICTIM], verified: [ATTACKER] }), "ambiguous");
eq("the refusal names both accounts so a person can resolve it",
  inboundMatch({ from: ADDR, confirmed: [VICTIM], verified: [ATTACKER] }).claimants, ["attacker", "victim"]);
// Ordering the arguments the other way must not change the answer.
eq("ambiguity is symmetric",
  chosenId({ from: ADDR, confirmed: [ATTACKER], verified: [VICTIM] }), null);
// One account holding BOTH proofs is the ordinary case, not a disagreement.
eq("one account with both kinds of proof still routes",
  chosenId({ from: ADDR, confirmed: [VICTIM], verified: [VICTIM] }), "victim");
eq("and that is a match, not ambiguity",
  reasonOf({ from: ADDR, confirmed: [VICTIM], verified: [VICTIM] }), "matched");
eq("a confirmed row wins over a typed profile email on another account",
  chosenId({ from: ADDR, confirmed: [VICTIM], typed: [ATTACKER] }), "victim");
eq("the sender is compared case-insensitively",
  chosenId({ from: "Name@Hospital.ORG", confirmed: [VICTIM] }), "victim");
eq("a display name on the sender is stripped",
  chosenId({ from: "Eric Whitney <name@hospital.org>", confirmed: [VICTIM] }), "victim");

// ── Pass 2: profiles.verified_email ─────────────────────────────────────────
// The identity provider says the address is verified for this account, and only
// clerk-webhook writes the column (migration 20260915d locks it against every
// user token).
eq("the verified column routes the message when no forwarding row matches",
  chosenId({ from: ADDR, confirmed: [], verified: [VICTIM] }), "victim");
eq("an absent confirmed list is the same as an empty one",
  chosenId({ from: ADDR, verified: [VICTIM] }), "victim");
eq("a null confirmed list is the same as an empty one",
  chosenId({ from: ADDR, confirmed: null, verified: [VICTIM] }), "victim");

// ── profiles.email routes nothing. This is the defect. ──────────────────────
eq("a typed profile email alone yields NO account",
  chooseInboundAccount({ from: ADDR, typed: [VICTIM] }), null);
eq("a typed profile email yields no account even for an active one",
  chooseInboundAccount({ from: ADDR, confirmed: [], verified: [], typed: [VICTIM] }), null);
// The whole scenario, end to end: the attacker typed the victim's hospital
// address into their own profile, and the victim then forwarded a genuine
// document from that mailbox. Authentication passes because the mail is real.
eq("the attacker who typed the address gets nothing",
  chooseInboundAccount({ from: ADDR, confirmed: [], verified: [], typed: [ATTACKER] }), null);
eq("and the document is not handed to the attacker by preferring an active account",
  chooseInboundAccount({ from: ADDR, typed: [ATTACKER, VICTIM] }), null);
// Two accounts both typing one address (which the partial index permits as soon
// as one of them clears theirs) is an ambiguity with no right answer, so there
// is no answer: the sender gets the unregistered reply.
eq("two accounts claiming the same unverified address yield no account",
  chooseInboundAccount({ from: ADDR, typed: [VICTIM, ATTACKER] }), null);
ok("nothing in the typed list can ever be returned",
  [[VICTIM], [ATTACKER], [VICTIM, ATTACKER], []].every((typed) =>
    chooseInboundAccount({ from: ADDR, typed }) === null));

// ── Two accounts never resolve by preference any more ───────────────────────
// This block used to encode the tie-breaks: active beats pending, a confirmed
// row beats a verified column. Every one of those was a rule for choosing
// between two DIFFERENT accounts that both hold proof, and choosing is the
// defect. Ranking claims is how the original disclosure worked, one rung up:
// it picks a winner from evidence that only establishes that we cannot tell.
// The database says the same thing in two places -- one confirmed row per
// address (forwarding_addresses_verified_email_key) and one verified column
// per address (profiles_verified_email_key) -- so a live disagreement means
// something is already wrong, and routing a document on it is the wrong way to
// find that out.
const PENDING = { id: "pending", auth_user_id: "user_pending", access_status: "pending", matched_email: ADDR };
const REVOKED = { id: "revoked", auth_user_id: "user_revoked", access_status: "revoked", matched_email: ADDR };
eq("an active account does not beat a pending one on the confirmed pass",
  chosenId({ from: ADDR, confirmed: [PENDING, VICTIM] }), null);
eq("an active account does not beat a revoked one on the verified pass",
  chosenId({ from: ADDR, verified: [REVOKED, VICTIM] }), null);
eq("two non-active accounts are just as ambiguous",
  chosenId({ from: ADDR, confirmed: [PENDING, REVOKED] }), null);
eq("a pending confirmed row does not beat an active verified column",
  chosenId({ from: ADDR, confirmed: [PENDING], verified: [VICTIM] }), null);
for (const input of [
  { from: ADDR, confirmed: [PENDING, VICTIM] },
  { from: ADDR, verified: [REVOKED, VICTIM] },
  { from: ADDR, confirmed: [PENDING], verified: [VICTIM] },
]) eq("every two-account case reports ambiguity", reasonOf(input), "ambiguous");

// What survives of the preference: it only ever chooses between rows naming
// the SAME account, which is what two lookups returning one account look like.
// It cannot pick an account, only a row.
eq("duplicate rows for one account still route to it",
  chosenId({ from: ADDR, confirmed: [VICTIM, { ...VICTIM }] }), "victim");
eq("access_status is still compared case-insensitively, within one account",
  (inboundMatch({ from: ADDR, confirmed: [{ ...VICTIM, access_status: "pending" }, { ...VICTIM, access_status: " Active " }] }).profile || {}).access_status,
  " Active ");
eq("a single account is a match however many rows carry it",
  reasonOf({ from: ADDR, confirmed: [VICTIM, { ...VICTIM }], verified: [{ ...VICTIM }] }), "matched");

// The reasons are distinct, because the caller logs them differently: nobody
// proved anything is routine, two people proving it needs a human.
eq("nobody at all is no_match", reasonOf({ from: ADDR }), "no_match");
eq("an unusable sender is bad_sender", reasonOf({ from: "not an address" }), "bad_sender");
eq("a row that cannot own a document does not create ambiguity",
  reasonOf({ from: ADDR, confirmed: [VICTIM], verified: [{ ...ATTACKER, auth_user_id: null }] }), "matched");
eq("a row for a different address does not create ambiguity",
  reasonOf({ from: ADDR, confirmed: [VICTIM], verified: [{ ...ATTACKER, matched_email: "someone@else.org" }] }), "matched");

// ── Rows that cannot be a match ─────────────────────────────────────────────
// The row's own address is re-checked here because every lookup that feeds this
// runs through ilike, and ilike folds more than case.
eq("a row holding a different address is not a match",
  chooseInboundAccount({ from: ADDR, confirmed: [{ ...VICTIM, matched_email: "someone@else.org" }] }), null);
eq("a row with no address is not a match",
  chooseInboundAccount({ from: ADDR, verified: [{ ...VICTIM, matched_email: null }] }), null);
// storeAsDocuments writes to `${auth_user_id}/${docId}`; a profile without one
// has no Storage prefix to write into.
eq("a profile with no auth_user_id is not a match",
  chooseInboundAccount({ from: ADDR, confirmed: [{ ...VICTIM, auth_user_id: null }] }), null);
eq("a profile with a blank auth_user_id is not a match",
  chooseInboundAccount({ from: ADDR, confirmed: [{ ...VICTIM, auth_user_id: "  " }] }), null);
eq("an unusable confirmed row does not fall through to a verified one on another account",
  chosenId({ from: ADDR, confirmed: [{ ...VICTIM, auth_user_id: null }], verified: [ATTACKER] }), "attacker");

// ── Null, empty and malformed inputs do not throw ───────────────────────────
for (const [label, input] of [
  ["null input", null],
  ["undefined input", undefined],
  ["empty object", {}],
  ["empty sender", { from: "" }],
  ["null sender", { from: null }],
  ["numeric sender", { from: 12345 }],
  ["malformed sender", { from: "not-an-address", confirmed: [VICTIM] }],
  ["sender carrying an ilike wildcard", { from: "chief*@hospital.org", confirmed: [VICTIM] }],
  ["null lists", { from: ADDR, confirmed: null, verified: null, typed: null }],
  ["non-array lists", { from: ADDR, confirmed: "rows", verified: 7 }],
  ["a null row inside a list", { from: ADDR, confirmed: [null, undefined] }],
]) {
  let threw = false, out;
  try { out = chooseInboundAccount(input); } catch { threw = true; }
  ok(`${label} answers null instead of throwing`, !threw && out === null);
}

// ── The transition: who may confirm a mailbox ───────────────────────────────
// Removing the profiles.email fallback with nothing in its place strands every
// current user, because all six profiles that hold an address were relying on
// it. The safe path is confirming the address by the emailed challenge, and
// until 2026-09-15 the one address a physician would confirm was the one the
// function refused: their own profile email.
const claim = (over) => refuseAddressClaim({ email: ADDR, usedByAnotherAccount: false, ...over });
eq("the address on your own profile is confirmable", claim({ email: "name@gmail.com" }), null);
eq("there is no own_profile_email refusal left to hit",
  (claim({ email: normalizeEmail("NAME@Gmail.com") }) || { code: null }).code, null);
eq("an address another account has PROVEN is still refused",
  (claim({ usedByAnotherAccount: true }) || {}).code, "other_account");

// provenByAnotherAccount is what fills that flag. It counts proof, not claims.
const proven = (over) => provenByAnotherAccount({ email: ADDR, callerId: "victim", ...over });
ok("another account's CONFIRMED forwarding row blocks the claim",
  proven({ forwarding: [{ owner_id: "attacker", email: ADDR, verified_at: "2026-09-01T00:00:00Z" }] }));
ok("another account's verified mailbox blocks the claim",
  proven({ verifiedMailboxes: [{ owner_id: "attacker", email: ADDR }] }));
// The reservation attack, from the other side: a stranger parks a pending row
// on a mailbox they cannot read, and the person who reads it every day can
// never confirm it. Asking for a link is not receiving one.
ok("another account's PENDING row does not block the true owner",
  !proven({ forwarding: [{ owner_id: "attacker", email: ADDR, verified_at: null }] }));
ok("a pending row with no verified_at field at all does not block either",
  !proven({ forwarding: [{ owner_id: "attacker", email: ADDR }] }));
ok("another account's TYPED profile email does not block the true owner",
  !proven({ typedProfileEmails: [{ owner_id: "attacker", email: ADDR }] }));
ok("a typed email cannot block even alongside the caller's own rows",
  !proven({
    typedProfileEmails: [{ owner_id: "attacker", email: ADDR }],
    forwarding: [{ owner_id: "victim", email: ADDR, verified_at: "2026-09-01T00:00:00Z" }],
  }));
ok("the caller's own confirmed row is not another account",
  !proven({ forwarding: [{ owner_id: "victim", email: ADDR, verified_at: "2026-09-01T00:00:00Z" }] }));
ok("the caller's own verified mailbox is not another account",
  !proven({ verifiedMailboxes: [{ owner_id: "victim", email: ADDR }] }));
ok("a row for a different address does not block",
  !proven({ verifiedMailboxes: [{ owner_id: "attacker", email: "someone@else.org" }] }));
ok("case does not defeat the block",
  proven({ verifiedMailboxes: [{ owner_id: "attacker", email: "Name@Hospital.ORG" }] }));
ok("a row with no owner does not block",
  !proven({ verifiedMailboxes: [{ owner_id: null, email: ADDR }] }));
ok("a malformed address is never reported as held elsewhere",
  !provenByAnotherAccount({ email: "not-an-address", callerId: "victim", verifiedMailboxes: [{ owner_id: "attacker", email: "not-an-address" }] }));
for (const [label, input] of [
  ["null facts", null],
  ["undefined facts", undefined],
  ["no caller", { email: ADDR, verifiedMailboxes: [{ owner_id: "attacker", email: ADDR }] }],
  ["null lists", { email: ADDR, callerId: "victim", forwarding: null, verifiedMailboxes: null }],
  ["a null row inside a list", { email: ADDR, callerId: "victim", verifiedMailboxes: [null] }],
]) {
  let threw = false, out;
  try { out = provenByAnotherAccount(input); } catch { threw = true; }
  ok(`${label} answers false instead of throwing`, !threw && out === false);
}

// ── Confirming, removing and deleting are each ONE transaction ─────────────
// A review with real PostgreSQL found the same shape five times: a decision
// spanning an account, its addresses and a mirror, carried out in more than
// one statement. Each of these is now a single call.
{
  const src = readFileSync(new URL("../supabase/functions/forwarding-address/index.ts", import.meta.url), "utf8");
  const confirm = src.slice(src.indexOf("async function handleConfirm("), src.indexOf("// ─── Entry"));
  ok("confirming is one call", /rpc\("confirm_forwarding_claim"/.test(confirm));
  ok("the challenge and the claim go together", /p_token_hash: hash/.test(confirm));
  ok("there is no compensating revoke left to get wrong", !/revoke_mailbox|remove_forwarding_claim/.test(confirm));
  ok("a duplicate POST is idempotent, not a failure page",
     /r\.outcome !== "confirmed" && r\.outcome !== "already_confirmed"/.test(confirm));
  ok("anything else refuses", /console\.warn\(`confirm: refused/.test(confirm));
  ok("a ledger that cannot answer refuses rather than confirming blind",
     /the claims ledger could not answer/.test(confirm));
  ok("the reader still gets one uniform page, so nothing is disclosed",
     !/already confirmed on another account|in use by another/i.test(confirm));

  const remove = src.slice(src.indexOf("async function handleRemove("), src.indexOf("// ─── Confirming: GET renders"));
  ok("removing is one call", /rpc\("remove_forwarding_claim"/.test(remove));
  ok("it no longer deletes the row on its own", !/\.delete\(\)\.eq\("id", id\)/.test(remove));
  ok("a 404 is still a 404", /code: "not_found"/.test(remove));
  ok("and the caller is told whether a route survived on other evidence",
     /route_kept_on/.test(remove));
}
{
  const del = readFileSync(new URL("../supabase/functions/delete-account/index.ts", import.meta.url), "utf8");
  ok("deletion closes every claim in one call", /rpc\("apply_account_mailbox"/.test(del));
  ok("terminally", /p_terminal: true/.test(del));
  ok("it no longer walks the claims one at a time", !/from\("mailbox_claims"\)[\s\S]{0,200}?\.eq\("profile_id", userId\)/.test(del));
  ok("before the profile is tombstoned",
     del.indexOf('rpc("apply_account_mailbox"') < del.indexOf("tombstonePatch(now)"));
  ok("and anything but a clean terminal stops the deletion",
     /refusing to tombstone with live routing/.test(del));
}
{
  const vm = readFileSync(new URL("../supabase/functions/clerk-webhook/verifiedMailbox.ts", import.meta.url), "utf8");
  ok("the webhook is one call too", /rpc\("apply_account_mailbox"/.test(vm));
  ok("the three separate writes are gone",
     !/async function writeMailbox|async function mailboxHolder|async function forwardingHolder/.test(vm));
  ok("and the file says why", /per-ADDRESS locks cannot order ACCOUNT events/.test(vm));
}

// ── The router reads ONE row, so there is nothing to adjudicate ────────────
// This block used to check that email-inbound told ambiguity apart from a
// no-match and logged it separately. It did, and that was correct, and it was
// also the symptom: the ambiguous state was reachable, and when it happened
// every forward from that mailbox was refused for BOTH accounts, permanently
// and silently, with no way to clear it from inside the app.
//
// public.mailbox_claims has the address as its PRIMARY KEY. Two accounts
// holding one mailbox is not a state that can exist, so the router does not
// decide between candidates any more: it reads the row, or there is no row.
{
  const src = readFileSync(new URL("../supabase/functions/email-inbound/index.ts", import.meta.url), "utf8");
  ok("routing reads the claims table", /from\("mailbox_claims"\)/.test(src));
  ok("by the address, which is its primary key", /\.eq\("address", address\)/.test(src));
  ok("one row, not a list", /\.maybeSingle\(\)/.test(src.slice(src.indexOf('from("mailbox_claims")'), src.indexOf('from("mailbox_claims")') + 400)));
  ok("a claims lookup that FAILS throws rather than routing nothing quietly",
     /throw new Error\(`mailbox claim lookup/.test(src));
  ok("a revoked claim routes nothing", /!claim\.profile_id/.test(src));
  ok("a terminal claim routes nothing", /claim\.terminal_at/.test(src));
  ok("the two-candidate-set reads are gone",
     !/confirmedForwardingCandidates|verifiedMailboxCandidates/.test(src));
  ok("and so is the ambiguity branch", !/ambiguous/.test(src));
  ok("a claim pointing at a missing or deleted profile refuses rather than guessing",
     /is gone or deleted\. Refusing\./.test(src));
  ok("a profile with no storage prefix is still not a candidate",
     /storeAsDocuments writes to/.test(src) && /auth_user_id/.test(src));
}

// inboundMatch itself is kept and still tested above: it is no longer the
// router, but it is the one place the old two-proof rule is written down, and
// forwarding-address still asks provenByAnotherAccount from the same file.

// ── A deleted account is not a place to file a document ────────────────────
// forwarding_addresses rows are deleted outright when an account is deleted,
// so before 20260915d added profiles.verified_email there was no way for mail
// to still reach a deleted account. That column arrived without the deletion
// path learning about it, leaving exactly one input that survived: a forward
// from that mailbox would be filed under the deleted user's storage prefix,
// against a profile the physician asked us to erase. Two independent layers
// now, because relying on remembering to null a column is what failed.
{
  const del = readFileSync(new URL("../supabase/functions/delete-account/lib.ts", import.meta.url), "utf8");
  const patch = del.slice(del.indexOf("PROFILE_TOMBSTONE_PATCH"), del.indexOf("cancelled_at: null"));
  for (const f of ["verified_email", "verified_email_at", "verified_email_event_ms"]) {
    ok(`deletion nulls ${f}`, new RegExp(`\\n  ${f}: null,`).test(patch));
  }
  ok("and it still nulls the typed contact address", /\n  email: null,/.test(patch));
  ok("forwarding rows are still deleted outright",
     /\{ table: "forwarding_addresses", column: "user_id" \}/.test(del));

  const inb = readFileSync(new URL("../supabase/functions/email-inbound/index.ts", import.meta.url), "utf8");
  ok("the profile select carries deleted_at", /PROFILE_COLUMNS = "[^"]*deleted_at"/.test(inb));
  // There is ONE profile read now, not two candidate queries: the claim says
  // which profile, and this loads it.
  eq("and the single profile read refuses a tombstoned one",
     (inb.match(/\.is\("deleted_at", null\)/g) || []).length, 1);
  ok("it is the read that follows the claim",
     /claim\.profile_id\)[\s\S]{0,160}\.is\("deleted_at", null\)/.test(inb));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
