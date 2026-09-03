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
  refuseAddressClaim, refuseAdd, refuseResend, refuseUniqueViolation, cooldownRemainingMs, since24hIso,
  base64url, mintToken, isTokenShaped, hashToken, expiryFrom, isExpired,
  confirmLink, confirmationEmail, escapeHtml, confirmPage, resultPage, publicRow,
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
// Two hours, not twenty-four. The link is the whole proof of mailbox control
// and it rides a query string through Resend, Cloudflare and browser history.
eq("token lives 2 hours", TOKEN_TTL_HOURS, 2);
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
// A column can be null, and a resend now runs this on what the column holds.
for (const notAString of [null, undefined, 12345, {}, ["a@b.co"]]) {
  ok(`a non-string is not an address: ${JSON.stringify(notAString) ?? "undefined"}`, !isEmailShaped(notAString));
}
for (const bad of ["", "nope", "a@b", "a@b.", "@hospital.org", "a b@hospital.org",
  "a@hospital.org, b@hospital.org", "a@hospital.org;b@x.org", "a@-hospital.org", "x".repeat(250) + "@hospital.org"]) {
  ok(`refused as malformed: ${JSON.stringify(bad)}`, !isEmailShaped(bad));
}
eq("domainOf", domainOf("a@hospital.org"), "hospital.org");

// ── The ilike wildcard oracle ───────────────────────────────────────────────
// PostgREST rewrites * to % on its way to ilike, so an unescaped * turned every
// address lookup into a prefix search: a caller could ask whether any verified
// forwarding address starts with "chief" and read the answer off the refusal.
// Two defences, and the test wants both: the pattern escapes it, and the shape
// check refuses an address carrying one before it ever reaches a query.
eq("ilike wildcards are escaped", ilikeLiteral("a_b%c@x.org"), "a\\_b\\%c@x.org");
eq("the PostgREST wildcard is escaped too", ilikeLiteral("chief*@x.org"), "chief\\*@x.org");
eq("a backslash is escaped before anything else", ilikeLiteral("a\\b@x.org"), "a\\\\b@x.org");
eq("all three wildcards at once", ilikeLiteral("a*b%c_d@x.org"), "a\\*b\\%c\\_d@x.org");
eq("an ordinary address is left alone", ilikeLiteral("first.last+cme@x.org"), "first.last+cme@x.org");
ok("an address carrying a * is refused outright", !isEmailShaped("chief*@hospital.org"));
ok("a bare * is refused", !isEmailShaped("*@hospital.org"));


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
eq("a * address never reaches a query, it is refused as malformed", code({ email: "chief*@hospital.org" }), "invalid");
eq("rate limits answer 429", [status({ pendingCount: 9 }), status({ sendsLast24h: 99 })], [429, 429]);

// Ownership beats convenience: someone else's address is refused even when
// this account has room for it and has sent nothing today.
eq("ownership is checked before any limit",
  code({ usedByAnotherAccount: true, pendingCount: 0, sendsLast24h: 0 }), "other_account");
// And a refusal never says WHICH kind of account holds it.
ok("the other-account message does not distinguish profile email from verified address",
  refuseAdd({ ...base, usedByAnotherAccount: true }).message === "That address is already in use by another CredentialDOMD account.");

// ── The four address rules, on their own ────────────────────────────────────
// refuseAdd and refuseResend both run these. They are exported separately
// because resend has to apply them to an address it did not receive: the one
// already stored on the row.
const claim = (over) => (refuseAddressClaim({
  email: "name@hospital.org", ownProfileEmail: "name@gmail.com", usedByAnotherAccount: false, ...over,
}) || { code: null }).code;
eq("a work address passes the claim rules", claim({}), null);
eq("malformed fails them", claim({ email: "not-an-address" }), "invalid");
eq("our own inbox domain fails them", claim({ email: "docs@credentialdomd.com" }), "own_domain");
eq("the account's own email fails them", claim({ email: "name@gmail.com" }), "own_profile_email");
eq("an address another account holds fails them", claim({ usedByAnotherAccount: true }), "other_account");
// refuseAdd is these four and then the rest, so they must answer identically.
for (const over of [{}, { email: "not-an-address" }, { email: "docs@credentialdomd.com" },
  { email: "name@gmail.com" }, { usedByAnotherAccount: true }]) {
  eq(`refuseAdd defers to the claim rules for ${JSON.stringify(over)}`, code(over), claim(over));
}

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
const rfacts = {
  found: true, verified: false, lastSentAt: null, sendsLast24h: 0, nowMs: NOW,
  email: "name@hospital.org", ownProfileEmail: "name@gmail.com", usedByAnotherAccount: false,
};
const rcode = (over) => (refuseResend({ ...rfacts, ...over }) || { code: null }).code;
eq("a resend with no prior send is allowed", rcode({}), null);
eq("someone else's row is not found", rcode({ found: false }), "not_found");
eq("a confirmed address is not resent", rcode({ verified: true }), "already_verified");
eq("a send two minutes ago is on cooldown", rcode({ lastSentAt: new Date(NOW - 2 * 60_000).toISOString() }), "cooldown");
eq("a send eleven minutes ago is not", rcode({ lastSentAt: new Date(NOW - 11 * 60_000).toISOString() }), null);
eq("the daily cap applies to resends too", rcode({ sendsLast24h: MAX_SENDS_PER_DAY }), "daily_limit");
// A resend mints a token and mails a link to the address ON THE ROW, so it is
// only ever as safe as the row. Until 2026-09-03 the table carried an INSERT
// grant for authenticated, so a caller could write a row directly through
// PostgREST with any address in it, skipping refuseAdd, and then call resend on
// it: an authenticated open mail relay wearing our From: address. The grant is
// revoked (migration 20260903d) AND resend re-checks the stored address, so
// neither half depends on the other holding.
eq("a resend refuses a malformed stored address", rcode({ email: "not-an-address" }), "invalid");
eq("a resend refuses a stored address with an ilike wildcard", rcode({ email: "chief*@hospital.org" }), "invalid");
eq("a resend refuses a stored address on our own inbox domain", rcode({ email: "docs@credentialdomd.com" }), "own_domain");
eq("a resend refuses a stored address on a subdomain of our inbox domain", rcode({ email: "x@mail.credentialdomd.com" }), "own_domain");
eq("a resend refuses a stored address that is the account's own email", rcode({ email: "name@gmail.com" }), "own_profile_email");
eq("a resend refuses a stored address another account verified", rcode({ usedByAnotherAccount: true }), "other_account");
// Order: a row that is not the caller's is refused before the address is looked
// at, so resend cannot be used to ask questions about somebody else's row.
eq("not-yours outranks every address rule",
  rcode({ found: false, email: "docs@credentialdomd.com", usedByAnotherAccount: true }), "not_found");
eq("already-confirmed outranks every address rule",
  rcode({ verified: true, email: "docs@credentialdomd.com", usedByAnotherAccount: true }), "already_verified");
// And an unvettable address is refused BEFORE any rate limit, so a caller
// cannot tell the two apart by burning the cooldown.
eq("the address rules run before the cooldown",
  rcode({ email: "docs@credentialdomd.com", lastSentAt: new Date(NOW - 60_000).toISOString() }), "own_domain");
eq("the address rules run before the daily cap",
  rcode({ usedByAnotherAccount: true, sendsLast24h: MAX_SENDS_PER_DAY }), "other_account");
// The wording is the same whichever entry point produced it.
eq("a resend refusal reads exactly like the add refusal",
  refuseResend({ ...rfacts, usedByAnotherAccount: true }).message,
  refuseAdd({ ...base, usedByAnotherAccount: true }).message);

ok("the cooldown message counts the minutes left",
  refuseResend({ ...rfacts, lastSentAt: new Date(NOW - 60_000).toISOString() })
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

eq("expiry is 2 hours out", expiryFrom(NOW), "2026-09-03T14:00:00.000Z");
ok("a fresh link is live", !isExpired(expiryFrom(NOW), NOW + 60_000));
ok("a link is dead one millisecond past its life", isExpired(expiryFrom(NOW), NOW + TOKEN_TTL_HOURS * 3600_000 + 1));
ok("a link is still live one millisecond before", !isExpired(expiryFrom(NOW), NOW + TOKEN_TTL_HOURS * 3600_000 - 1));
ok("a link that would still be live under the old 24 hour window is dead",
  isExpired(expiryFrom(NOW), NOW + 3 * 3600_000));
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
ok("the email says how long the link lasts, in the server's own number",
  mail.text.includes(`expires in ${TOKEN_TTL_HOURS} hours`));
ok("the email no longer promises a day", !mail.text.includes("24 hours"));
// The link is not the confirmation any more, and the email has to say so: a
// physician whose mail passed a link scanner needs to know the scan did not
// spend it, and one who opened it by accident needs to know nothing happened.
ok("the email says opening the link is not confirming",
  /Nothing changes until you press Confirm/.test(mail.text));
ok("the email says the link shows a page with a button", /page with one button/.test(mail.text));
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
ok("the failure page still says how long a link lives",
  bad.includes(`work once and last ${TOKEN_TTL_HOURS} hours`));
ok("the failure page no longer promises a day", !bad.includes("24 hours"));
ok("an address with markup in it cannot inject",
  !resultPage({ ok: true, address: '<img src=x onerror=alert(1)>@x.org', accountEmail: "a@b.co" }).includes("<img"));

// ── The page the link lands on: it must not confirm anything ────────────────
// Hospital mailboxes sit behind Microsoft Safe Links, Proofpoint, Mimecast and
// Barracuda, which FETCH a link to judge it, often at delivery and before a
// human reads the message. While confirming was a GET that fetch was the
// confirmation, which handed the address to the requesting account with the
// mailbox owner doing nothing. So the page the GET renders acts only when a
// form is submitted, and scanners do not submit forms.
const CONFIRM_ACTION = "https://credentialdomd.com/api/confirm-forwarding";
const cpage = confirmPage({
  address: "name@hospital.org", accountEmail: "name@gmail.com", token: t1, action: CONFIRM_ACTION,
});
ok("the confirm page is complete html", cpage.startsWith("<!doctype html>"));
ok("the confirm page names the address being confirmed", cpage.includes("name@hospital.org"));
ok("the confirm page names the account that asked", cpage.includes("name@gmail.com"));
ok("the confirm page posts, it does not get", /<form method="post"/.test(cpage));
ok("the confirm page posts to the first-party relay",
  cpage.includes(`action="${CONFIRM_ACTION}"`));
ok("the token rides the form body, not a link", cpage.includes(`name="token" value="${t1}"`));
ok("the only control on the page is the confirm button",
  (cpage.match(/<button/g) || []).length === 1 && /Confirm this address<\/button>/.test(cpage));
ok("nothing on the confirm page is a link that carries the token",
  !/<a [^>]*token=/.test(cpage));
ok("the confirm page says pressing the button is what acts",
  /Nothing is confirmed until you press the button/.test(cpage));
ok("the confirm page runs no script", !/<script/i.test(cpage));
ok("no em dash on the confirm page", !cpage.includes("\u2014"));
ok("no compliance claims on the confirm page", !/HIPAA|SOC 2|bank-level|military-grade/i.test(cpage));
// A hostile address cannot break out of either the visible text or the field.
const injected = confirmPage({
  address: '"><script>alert(1)</script>@x.org', accountEmail: 'a"b@c.co',
  token: '"><script>alert(2)</script>', action: '"><script>alert(3)</script>',
});
ok("an address with markup in it cannot inject", !injected.includes("<script>"));
ok("a token with markup in it cannot escape the value attribute",
  !/value="">/.test(injected) && !injected.includes("alert(2)</script>"));
ok("an action with markup in it cannot escape the attribute", !injected.includes("alert(3)</script>"));

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
