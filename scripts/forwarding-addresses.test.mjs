// Checks for src/utils/forwardingAddresses.js: what Settings > Email refuses
// before it spends a round trip, and the text that names the addresses a
// physician may forward from. The refusal wording is deliberately identical
// to supabase/functions/forwarding-address/lib.ts, and that agreement is
// asserted here against the real server file, so the two cannot drift into
// saying different things about the same address.
// Run: node scripts/forwarding-addresses.test.mjs

const {
  INBOX_DOMAIN, REQUESTS_INBOX, CME_INBOX, MAX_PENDING_PER_ACCOUNT, SEND_COOLDOWN_MINUTES,
  normalizeAddress, isAddressShaped, domainOf, addProblem, pendingCount,
  sortAddresses, forwardingSenders, joinAddresses,
  cooldownRemainingMs, sentAgoLabel, pendingLine, resendBlockedReason, LINK_TTL_HOURS,
} = await import("../src/utils/forwardingAddresses.js");

const server = await import("../supabase/functions/forwarding-address/lib.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

// ── The client mirrors the server, it does not invent ────────────────────────
eq("same inbox domain", INBOX_DOMAIN, server.INBOX_DOMAIN);
eq("same pending cap", MAX_PENDING_PER_ACCOUNT, server.MAX_PENDING_PER_ACCOUNT);
eq("same send cooldown", SEND_COOLDOWN_MINUTES, server.SEND_COOLDOWN_MINUTES);
eq("the requests inbox", REQUESTS_INBOX, "docs@credentialdomd.com");
eq("the cme inbox", CME_INBOX, "cme@credentialdomd.com");

for (const raw of ["Eric Whitney <Eric@Hospital.ORG>", "  NAME@Hospital.org \n", "<a@b.co>", "", null, "nope"]) {
  eq(`normalizes like the server: ${JSON.stringify(raw)}`, normalizeAddress(raw), server.normalizeEmail(raw));
}
for (const e of ["name@hospital.org", "first.last+cme@sub.hospital.co.uk", "a_b-c@x-y.io",
  "", "nope", "a@b", "a@b.", "@hospital.org", "a b@hospital.org",
  "a@hospital.org, b@hospital.org", "a@-hospital.org", "x".repeat(250) + "@hospital.org"]) {
  eq(`shape agrees with the server: ${JSON.stringify(e)}`, isAddressShaped(e), server.isEmailShaped(e));
}
eq("domainOf", domainOf("a@sub.hospital.org"), "sub.hospital.org");

// ── addProblem: every local refusal, in the server's own words ───────────────
const account = "name@gmail.com";
const P = (email, rows = []) => addProblem({ email, accountEmail: account, rows });
const serverSays = (over) => server.refuseAdd({
  email: "x@hospital.org", ownProfileEmail: account, ownRowVerified: null,
  usedByAnotherAccount: false, pendingCount: 0, sendsLast24h: 0, ...over,
}).message;

eq("an empty box is not a complaint", P(""), null);
eq("whitespace only is not a complaint", P("   "), null);
eq("a good address passes", P("name@hospital.org"), null);
eq("a display name is accepted and normalized", P("Whit <name@hospital.org>"), null);

eq("malformed", P("nope"), serverSays({ email: "nope" }));
eq("our own domain", P("me@credentialdomd.com"), serverSays({ email: "me@credentialdomd.com" }));
eq("a subdomain of ours", P("me@mail.credentialdomd.com"), serverSays({ email: "me@mail.credentialdomd.com" }));
eq("the account address itself", P(account), serverSays({ email: account }));
eq("the account address in another case", P("NAME@Gmail.com"), serverSays({ email: account }));

const verifiedRow = { id: "1", email: "name@hospital.org", verified_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" };
const pendingRow = { id: "2", email: "name@clinic.org", verified_at: null, last_sent_at: "2026-09-03T12:00:00Z", created_at: "2026-09-02T00:00:00Z" };
eq("already confirmed on this account", P("name@hospital.org", [verifiedRow]), serverSays({ ownRowVerified: true }));
eq("already waiting on this account", P("NAME@Clinic.org", [pendingRow]), serverSays({ ownRowVerified: false }));

const fivePending = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, email: `p${n}@x.org`, verified_at: null }));
eq("five already waiting", P("new@hospital.org", fivePending), serverSays({ pendingCount: 5 }));
eq("a sixth confirmed row does not count toward the pending cap",
  P("new@hospital.org", [...fivePending.slice(0, 4), { id: "v", email: "v@x.org", verified_at: "2026-09-01T00:00:00Z" }]), null);
eq("pendingCount ignores confirmed rows", pendingCount([...fivePending, verifiedRow]), 5);

// The local check must never be the only thing standing between two accounts
// and the same address: it cannot see other accounts at all, and says so by
// passing an address someone else may well hold.
eq("an address another account holds is not refused locally (the server decides)", P("someone.else@hospital.org"), null);

// ── Order and the sender list ────────────────────────────────────────────────
const rows = [
  { id: "b", email: "b@x.org", verified_at: null, created_at: "2026-09-02T00:00:00Z" },
  { id: "a", email: "a@x.org", verified_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" },
  { id: "c", email: "c@x.org", verified_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
];
eq("confirmed first, oldest first inside each group", sortAddresses(rows).map((r) => r.id), ["c", "a", "b"]);
eq("sortAddresses does not mutate its input", rows.map((r) => r.id), ["b", "a", "c"]);
eq("empty is empty", sortAddresses([]), []);

eq("senders: the account address leads, then confirmed rows",
  forwardingSenders(account, rows), [account, "c@x.org", "a@x.org"]);
eq("senders: a waiting address is not a sender",
  forwardingSenders(account, [{ id: "b", email: "b@x.org", verified_at: null }]), [account]);
eq("senders: the account address is not listed twice",
  forwardingSenders("A@X.org", [{ id: "a", email: "a@x.org", verified_at: "2026-09-03T00:00:00Z" }]), ["a@x.org"]);
eq("senders: no account email yet", forwardingSenders("", rows), ["c@x.org", "a@x.org"]);

eq("join one", joinAddresses(["a@x.org"]), "a@x.org");
eq("join two", joinAddresses(["a@x.org", "b@x.org"]), "a@x.org or b@x.org");
eq("join three", joinAddresses(["a@x.org", "b@x.org", "c@x.org"]), "a@x.org, b@x.org or c@x.org");
eq("join none", joinAddresses([]), "");

// ── The clock ────────────────────────────────────────────────────────────────
const t0 = Date.parse("2026-09-03T12:00:00.000Z");
const at = (mins) => new Date(t0 - mins * 60_000).toISOString();
eq("just sent", sentAgoLabel(at(0), t0), "just now");
eq("one minute", sentAgoLabel(at(1), t0), "1 minute ago");
eq("four minutes", sentAgoLabel(at(4), t0), "4 minutes ago");
eq("one hour", sentAgoLabel(at(60), t0), "1 hour ago");
eq("five hours", sentAgoLabel(at(300), t0), "5 hours ago");
eq("two days", sentAgoLabel(at(60 * 24 * 2), t0), "2 days ago");
eq("nothing to say", sentAgoLabel(null, t0), "");
eq("unreadable timestamp says nothing", sentAgoLabel("not a date", t0), "");
eq("a clock skewed into the future does not read as negative", sentAgoLabel(at(-5), t0), "just now");

eq("cooldown matches the server", cooldownRemainingMs(at(3), t0), server.cooldownRemainingMs(at(3), t0));
eq("cooldown is over after ten minutes", cooldownRemainingMs(at(10), t0), 0);
eq("no send yet, no cooldown", cooldownRemainingMs(null, t0), 0);

// Opening the link no longer confirms anything: it renders a page with one
// Confirm button, so a hospital link scanner fetching the URL cannot attach the
// address. A physician watching a waiting row has to know that a colleague who
// merely clicked has not finished, which is why the line says "and presses
// Confirm" rather than stopping at "opens the link".
const inert = "Nothing is routed here until someone opens the link from that mailbox and presses Confirm.";
eq("the waiting line names when the link went out",
  pendingLine({ last_sent_at: at(4) }, t0), `Link sent 4 minutes ago. ${inert}`);
eq("the waiting line without a send time still says the address is inert",
  pendingLine({ last_sent_at: null }, t0), inert);
ok("the waiting line never implies a waiting address already routes mail",
  pendingLine({ last_sent_at: at(4) }, t0).includes("Nothing is routed here until"));
ok("the waiting line says opening the link is not the finish",
  pendingLine({ last_sent_at: at(4) }, t0).includes("presses Confirm"));

// ── The client mirrors the server's link lifetime ───────────────────────────
// The hint under the Add field quotes this number. It has to be the server's,
// or the field promises a lifetime the token does not have.
eq("the client quotes the server's link lifetime", LINK_TTL_HOURS, server.TOKEN_TTL_HOURS);
eq("that lifetime is two hours", LINK_TTL_HOURS, 2);

// ── The ilike wildcard the server refuses, the client refuses too ───────────
ok("an address carrying a * is refused here as well", !isAddressShaped("chief*@hospital.org"));
eq("the client and the server agree about *",
  isAddressShaped("chief*@hospital.org"), server.isEmailShaped("chief*@hospital.org"));
eq("a * address gets the malformed message, not a round trip",
  addProblem({ email: "chief*@hospital.org", accountEmail: "me@gmail.com", rows: [] }),
  "That does not look like an email address.");

eq("resend is blocked inside the ten minutes",
  resendBlockedReason({ verified_at: null, last_sent_at: at(3) }, t0),
  "A link went out a moment ago. You can send another in 7 minutes.");
eq("the last minute reads as one minute, not one minutes",
  resendBlockedReason({ verified_at: null, last_sent_at: at(9.5) }, t0),
  "A link went out a moment ago. You can send another in 1 minute.");
eq("resend is free after the floor", resendBlockedReason({ verified_at: null, last_sent_at: at(11) }, t0), null);
eq("a confirmed row has nothing to resend", resendBlockedReason({ verified_at: "x", last_sent_at: at(1) }, t0), null);
eq("no row, no reason", resendBlockedReason(null, t0), null);

// ── House rules ──────────────────────────────────────────────────────────────
const everyString = [
  P("nope"), P("me@credentialdomd.com"), P(account), P("name@hospital.org", [verifiedRow]),
  P("name@clinic.org", [pendingRow]), P("new@hospital.org", fivePending),
  pendingLine({ last_sent_at: at(4) }, t0), pendingLine({}, t0),
  resendBlockedReason({ verified_at: null, last_sent_at: at(3) }, t0),
  sentAgoLabel(at(4), t0), joinAddresses(["a@x.org", "b@x.org", "c@x.org"]),
].filter(Boolean);
ok("every line a physician reads is free of em dashes", everyString.every((t) => !t.includes("—")));
ok("nothing claims a compliance standard",
  everyString.every((t) => !/HIPAA|SOC ?2|bank-level|military-grade/i.test(t)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
