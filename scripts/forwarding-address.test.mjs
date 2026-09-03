// Checks for supabase/functions/forwarding-address/lib.ts: the rules that
// decide who may claim a forwarding address, the token maths, and the two
// texts a person reads. These are the parts that carry the security property
// (a verified address routes another person's credentialing mail), so they
// live away from the network and are tested here. Node 22.18+ strips the type
// annotations on import; no build step, no runner.
// Run: node scripts/forwarding-address.test.mjs

const {
  TOKEN_TTL_HOURS, TOKEN_BYTES, MAX_PENDING_PER_ACCOUNT, MAX_SENDS_PER_DAY, SEND_COOLDOWN_MINUTES,
  normalizeEmail, isEmailShaped, domainOf, ilikeLiteral,
  refuseAdd, refuseResend, refuseUniqueViolation, cooldownRemainingMs, since24hIso,
  base64url, mintToken, isTokenShaped, hashToken, expiryFrom, isExpired,
  confirmLink, confirmationEmail, escapeHtml, resultPage, publicRow,
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

// ── The limits are the ones the design fixed ────────────────────────────────
eq("token lives 24 hours", TOKEN_TTL_HOURS, 24);
eq("token is 32 bytes", TOKEN_BYTES, 32);
eq("5 pending addresses per account", MAX_PENDING_PER_ACCOUNT, 5);
eq("10 sends per account per day", MAX_SENDS_PER_DAY, 10);
eq("one send per address per 10 minutes", SEND_COOLDOWN_MINUTES, 10);

// ── Normalization ───────────────────────────────────────────────────────────
eq("display name is stripped", normalizeEmail("Eric Whitney <Eric@Hospital.ORG>"), "eric@hospital.org");
eq("whitespace and case", normalizeEmail("  NAME@Hospital.org \n"), "name@hospital.org");
eq("null is empty", normalizeEmail(null), "");
eq("angle brackets only", normalizeEmail("<a@b.co>"), "a@b.co");

for (const good of ["name@hospital.org", "first.last+cme@sub.hospital.co.uk", "a_b-c@x-y.io"]) {
  ok(`valid: ${good}`, isEmailShaped(good));
}
for (const bad of ["", "nope", "a@b", "a@b.", "@hospital.org", "a b@hospital.org",
  "a@hospital.org, b@hospital.org", "a@hospital.org;b@x.org", "a@-hospital.org", "x".repeat(250) + "@hospital.org"]) {
  ok(`refused as malformed: ${JSON.stringify(bad)}`, !isEmailShaped(bad));
}
eq("domainOf", domainOf("a@hospital.org"), "hospital.org");
eq("ilike wildcards are escaped", ilikeLiteral("a_b%c@x.org"), "a\\_b\\%c@x.org");

// ── refuseAdd: every refusal, in order ──────────────────────────────────────
const base = {
  email: "name@hospital.org",
  ownProfileEmail: "name@gmail.com",
  ownRowVerified: null,
  usedByAnotherAccount: false,
  pendingCount: 0,
  sendsLast24h: 0,
};
const code = (over) => (refuseAdd({ ...base, ...over }) || { code: null }).code;
const status = (over) => (refuseAdd({ ...base, ...over }) || { status: 200 }).status;

eq("a work address on a gmail account is allowed", refuseAdd(base), null);
eq("malformed is refused", code({ email: "not-an-address" }), "invalid");
eq("our own inbox domain is refused", code({ email: "docs@credentialdomd.com" }), "own_domain");
eq("a subdomain of our inbox domain is refused", code({ email: "x@mail.credentialdomd.com" }), "own_domain");
eq("the account's own email is refused, not duplicated", code({ email: "name@gmail.com" }), "own_profile_email");
eq("case does not defeat the own-email check", code({ email: "name@gmail.com", ownProfileEmail: "NAME@Gmail.com" }), "own_profile_email");
eq("another account's address is refused", code({ usedByAnotherAccount: true }), "other_account");
eq("another account's address is a 409", status({ usedByAnotherAccount: true }), 409);
eq("this account already confirmed it", code({ ownRowVerified: true }), "already_verified");
eq("this account already has it pending", code({ ownRowVerified: false }), "already_pending");
eq("a sixth pending address is refused", code({ pendingCount: MAX_PENDING_PER_ACCOUNT }), "too_many_pending");
eq("five pending is still fine", refuseAdd({ ...base, pendingCount: MAX_PENDING_PER_ACCOUNT - 1 }), null);
eq("the eleventh send today is refused", code({ sendsLast24h: MAX_SENDS_PER_DAY }), "daily_limit");
eq("rate limits answer 429", [status({ pendingCount: 9 }), status({ sendsLast24h: 99 })], [429, 429]);

// Ownership beats convenience: someone else's address is refused even when
// this account has room for it and has sent nothing today.
eq("ownership is checked before any limit",
  code({ usedByAnotherAccount: true, pendingCount: 0, sendsLast24h: 0 }), "other_account");
// And a refusal never says WHICH kind of account holds it.
ok("the other-account message does not distinguish profile email from verified address",
  refuseAdd({ ...base, usedByAnotherAccount: true }).message === "That address is already in use by another CredentialDOMD account.");

// ── Which unique index refused the insert ───────────────────────────────────
// Both indexes raise 23505 on the same insert. The caller's own duplicate must
// not be reported as somebody else's address: that is wrong, and it tells a
// caller something about other accounts that their own row cannot support.
const OWNER_ERR = 'duplicate key value violates unique constraint "forwarding_addresses_owner_email_key"';
const VERIFIED_ERR = 'duplicate key value violates unique constraint "forwarding_addresses_verified_email_key"';
eq("the caller's own duplicate reads as pending", refuseUniqueViolation(OWNER_ERR).code, "already_pending");
eq("a verified duplicate reads as another account", refuseUniqueViolation(VERIFIED_ERR).code, "other_account");
eq("both answer 409", [refuseUniqueViolation(OWNER_ERR).status, refuseUniqueViolation(VERIFIED_ERR).status], [409, 409]);
ok("the caller's own duplicate is never blamed on another account",
  !/another CredentialDOMD account/.test(refuseUniqueViolation(OWNER_ERR).message));
ok("an unrecognised index discloses nothing about the caller",
  refuseUniqueViolation("some other constraint").code === "other_account");
ok("a missing error detail still returns a refusal, not a throw",
  refuseUniqueViolation(undefined).status === 409 && refuseUniqueViolation(null).status === 409);
eq("the pending message matches the one refuseAdd already uses",
  refuseUniqueViolation(OWNER_ERR).message, refuseAdd({ ...base, ownRowVerified: false }).message);
eq("the other-account message matches the one refuseAdd already uses",
  refuseUniqueViolation(VERIFIED_ERR).message, refuseAdd({ ...base, usedByAnotherAccount: true }).message);

// ── refuseResend ────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const rcode = (over) => (refuseResend({ found: true, verified: false, lastSentAt: null, sendsLast24h: 0, nowMs: NOW, ...over }) || { code: null }).code;
eq("a resend with no prior send is allowed", rcode({}), null);
eq("someone else's row is not found", rcode({ found: false }), "not_found");
eq("a confirmed address is not resent", rcode({ verified: true }), "already_verified");
eq("a send two minutes ago is on cooldown", rcode({ lastSentAt: new Date(NOW - 2 * 60_000).toISOString() }), "cooldown");
eq("a send eleven minutes ago is not", rcode({ lastSentAt: new Date(NOW - 11 * 60_000).toISOString() }), null);
eq("the daily cap applies to resends too", rcode({ sendsLast24h: MAX_SENDS_PER_DAY }), "daily_limit");
ok("the cooldown message counts the minutes left",
  refuseResend({ found: true, verified: false, lastSentAt: new Date(NOW - 60_000).toISOString(), sendsLast24h: 0, nowMs: NOW })
    .message.includes("9 minutes"));

eq("cooldown remaining, never negative", cooldownRemainingMs(new Date(NOW - 60 * 60_000).toISOString(), NOW), 0);
eq("cooldown remaining, four minutes in", cooldownRemainingMs(new Date(NOW - 6 * 60_000).toISOString(), NOW), 4 * 60_000);
eq("no prior send, no cooldown", cooldownRemainingMs(null, NOW), 0);
eq("an unparseable timestamp does not block a resend", cooldownRemainingMs("whenever", NOW), 0);
eq("the daily window is 24 hours", since24hIso(NOW), "2026-09-02T12:00:00.000Z");

// ── Token ───────────────────────────────────────────────────────────────────
eq("base64url has no padding or + /", base64url(new Uint8Array([251, 255, 190, 0])), "-_--AA");
const t1 = mintToken(), t2 = mintToken();
ok("a token is 43 base64url characters (32 bytes)", isTokenShaped(t1) && t1.length === 43);
ok("two tokens differ", t1 !== t2);
ok("a short token is rejected before any lookup", !isTokenShaped(t1.slice(0, 20)));
ok("a token with other characters is rejected", !isTokenShaped("a".repeat(42) + "!"));
ok("a non-string token is rejected", !isTokenShaped(undefined) && !isTokenShaped(12345));

eq("sha256 is the known vector for abc", await hashToken("abc"),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const h1 = await hashToken(t1);
ok("a hash is 64 hex characters", /^[0-9a-f]{64}$/.test(h1));
ok("the hash is not the token", h1 !== t1 && !h1.includes(t1));
ok("the same token hashes the same way twice", (await hashToken(t1)) === h1);
ok("a different token hashes differently", (await hashToken(t2)) !== h1);

eq("expiry is 24 hours out", expiryFrom(NOW), "2026-09-04T12:00:00.000Z");
ok("a fresh link is live", !isExpired(expiryFrom(NOW), NOW + 60_000));
ok("a link is dead one millisecond past 24 hours", isExpired(expiryFrom(NOW), NOW + TOKEN_TTL_HOURS * 3600_000 + 1));
ok("a link with no expiry is treated as expired", isExpired(null, NOW));
ok("a link with a junk expiry is treated as expired", isExpired("soon", NOW));
eq("the confirm link carries the token in the query",
  confirmLink("https://x.supabase.co/functions/v1/forwarding-address/", t1),
  `https://x.supabase.co/functions/v1/forwarding-address?token=${t1}`);

// ── The confirmation email ──────────────────────────────────────────────────
const mail = confirmationEmail({ address: "name@hospital.org", accountEmail: "name@gmail.com", link: "https://x/confirm?token=abc" });
ok("the email names the account that asked", mail.text.includes("name@gmail.com"));
ok("the email names the address being added", mail.text.includes("name@hospital.org"));
ok("the email says what confirming allows", /lets email forwarded from this address reach that account/.test(mail.text));
ok("the email says the link expires in 24 hours", mail.text.includes("expires in 24 hours"));
ok("the email says an ignored link does nothing", /ignore this email/.test(mail.text));
ok("the email carries the link once", mail.text.split("https://x/confirm?token=abc").length === 2);
ok("the subject says what it is", /Confirm this address/.test(mail.subject));
ok("no em dash in the email", !mail.text.includes("—") && !mail.subject.includes("—"));
ok("no compliance claims in the email", !/HIPAA|SOC 2|bank-level|military-grade/i.test(mail.text));

// ── The page ────────────────────────────────────────────────────────────────
eq("html is escaped", escapeHtml('<script>"x" & \'y\''), "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;");
const good = resultPage({ ok: true, address: "name@hospital.org", accountEmail: "name@gmail.com" });
const bad = resultPage({ ok: false });
ok("the success page names the address", good.includes("name@hospital.org"));
ok("the success page names the account", good.includes("name@gmail.com"));
ok("the failure page says expired or already used", /expired or has already been used/.test(bad));
ok("the failure page never says whether the token existed", !/not found|unknown|no such|never existed/i.test(bad));
ok("neither page carries a token", !good.includes("token=") && !bad.includes("token="));
ok("both pages are complete html", good.startsWith("<!doctype html>") && bad.startsWith("<!doctype html>"));
ok("no em dash on either page", !good.includes("—") && !bad.includes("—"));
// The panel exists now (More > Settings > Email in SettingsSection.jsx), so
// both pages say where the address is managed: one to remove it, one to send
// a fresh link. A page that names a screen nobody can open would be a promise,
// not guidance, which is why these two assertions move together with the UI.
ok("the confirmed page says where to remove the address",
  /More\s*&gt;\s*Settings\s*&gt;\s*Email/.test(good));
ok("the expired page says where to send a fresh link",
  /More\s*&gt;\s*Settings\s*&gt;\s*Email/.test(bad));
ok("neither page carries a raw unescaped angle bracket in that pointer",
  !/More\s*>\s*Settings/.test(good) && !/More\s*>\s*Settings/.test(bad));
ok("the failure page still says how long a link lives", /work once and last 24 hours/.test(bad));
ok("an address with markup in it cannot inject",
  !resultPage({ ok: true, address: '<img src=x onerror=alert(1)>@x.org', accountEmail: "a@b.co" }).includes("<img"));

// ── What comes back to the client ───────────────────────────────────────────
const row = {
  id: "11111111-2222-3333-4444-555555555555", user_id: "aaaa", email: "name@hospital.org",
  verified_at: null, last_sent_at: "2026-09-03T12:00:00.000Z", created_at: "2026-09-03T12:00:00.000Z",
  token_hash: "ba78" + "0".repeat(60), token_expires_at: "2026-09-04T12:00:00.000Z",
};
const shown = publicRow(row);
ok("the row that goes back has no token hash", !("token_hash" in shown));
ok("the row that goes back has no token expiry", !("token_expires_at" in shown));
ok("no token material survives serialization", !JSON.stringify(shown).includes("ba78"));
eq("the row that goes back", Object.keys(shown).sort(),
  ["created_at", "email", "id", "last_sent_at", "user_id", "verified_at"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
