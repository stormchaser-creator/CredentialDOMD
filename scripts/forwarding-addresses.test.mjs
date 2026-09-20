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
  sortAddresses, forwardingSenders, routableSenders, rowForAddress, joinAddresses,
  cooldownRemainingMs, sentAgoLabel, pendingLine, resendBlockedReason, LINK_TTL_HOURS,
  accountMailboxVerified, CONFIRM_FIRST_SENTENCE,
} = await import("../src/utils/forwardingAddresses.js");

const server = await import("../supabase/functions/forwarding-address/lib.ts");
const { readFileSync } = await import("node:fs");
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

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
// addProblem no longer takes the account email: the account address stopped
// being a special case, so there is nothing left for it to be compared to.
// `account` still stands in below for "this is the physician's own address".
const P = (email, rows = []) => addProblem({ email, rows });
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

// ── The account address is an ordinary address now ──────────────────────────
// email-inbound stopped falling back to the user-editable profiles.email, so
// "mail forwarded from it already reaches you" became false and the refusal
// that said it was the only thing standing between a physician and the
// control that restores their routing. Adding it has to be allowed.
eq("the account address may be added", P(account), null);
eq("the account address in another case may be added", P("NAME@Gmail.com"), null);
eq("the account address with a display name may be added", P("Whit <name@gmail.com>"), null);
ok("the branch that refused it is gone from the module (the sentence survives only in the comment saying why)",
  !/return "That is already the email on your account/.test(read("../src/utils/forwardingAddresses.js")));

// One branch was removed, not the file. Every other refusal still fires.
eq("still refused: malformed", P("nope"), "That does not look like an email address.");
ok("still refused: our own domain", /CredentialDOMD address/.test(P("me@credentialdomd.com") || ""));
ok("still refused: a subdomain of ours", /CredentialDOMD address/.test(P("me@mail.credentialdomd.com") || ""));
eq("still refused: an address already confirmed on this account",
  P("name@hospital.org", [{ id: "1", email: "name@hospital.org", verified_at: "2026-09-01T00:00:00Z" }]),
  "You have already confirmed that address.");
eq("still refused: an address already waiting",
  P("name@clinic.org", [{ id: "2", email: "name@clinic.org", verified_at: null }]),
  "That address is already waiting to be confirmed. Send the confirmation email again if it did not arrive.");

// The account address earns no exemption from the rest of the rules either.
// These compare against the literal sentences rather than serverSays(),
// because the server's own_profile_email refusal (being deleted alongside
// this change) would preempt them while it is still there.
const acctConfirmedRow = { id: "av", email: account, verified_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z" };
const acctWaitingRow = { id: "ap", email: account, verified_at: null, created_at: "2026-09-10T00:00:00Z" };
eq("the account address, once confirmed, cannot be added again",
  P(account, [acctConfirmedRow]), "You have already confirmed that address.");
eq("the account address, already waiting, says so",
  P(account, [acctWaitingRow]),
  "That address is already waiting to be confirmed. Send the confirmation email again if it did not arrive.");

// ── Client and server may not disagree in the direction that hurts ──────────
// This file's promise is that its refusals are the server's refusals, so the
// own_profile_email branch had to come out of both halves at once
// (supabase/functions/forwarding-address/lib.ts). A disagreement here is a
// bug in whichever side moved last, which is why it is asserted rather than
// tolerated: if the server ever refuses the account address again, this panel
// offers a Confirm button that can only fail.
eq("the server dropped its matching refusal too", server.refuseAdd({
  email: normalizeAddress(account), ownProfileEmail: account, ownRowVerified: null,
  usedByAnotherAccount: false, pendingCount: 0, sendsLast24h: 0,
}), null);
eq("client and server agree the account address is addable", P(account), null);

// And a client that refuses what the server would accept is a field blocking
// a working control, which is exactly the bug this change fixes. The reverse
// costs a round trip and nothing else, so the gate is one-directional.
for (const e of [account, "NAME@Gmail.com", "name@hospital.org", "someone.else@hospital.org", "first.last+cme@sub.hospital.co.uk"]) {
  const allowed = server.refuseAdd({
    email: normalizeAddress(e), ownProfileEmail: account, ownRowVerified: null,
    usedByAnotherAccount: false, pendingCount: 0, sendsLast24h: 0,
  }) === null;
  ok(`the client never refuses what the server allows: ${e}`, !allowed || P(e) === null);
}


const verifiedRow = { id: "1", email: "name@hospital.org", verified_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" };
const pendingRow = { id: "2", email: "name@clinic.org", verified_at: null, last_sent_at: "2026-09-03T12:00:00Z", created_at: "2026-09-02T00:00:00Z" };
eq("already confirmed on this account", P("name@hospital.org", [verifiedRow]), serverSays({ ownRowVerified: true }));
eq("already waiting on this account", P("NAME@Clinic.org", [pendingRow]), serverSays({ ownRowVerified: false }));

const fivePending = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, email: `p${n}@x.org`, verified_at: null }));
eq("five already waiting", P("new@hospital.org", fivePending), serverSays({ pendingCount: 5 }));
eq("a sixth confirmed row does not count toward the pending cap",
  P("new@hospital.org", [...fivePending.slice(0, 4), { id: "v", email: "v@x.org", verified_at: "2026-09-01T00:00:00Z" }]), null);
eq("pendingCount ignores confirmed rows", pendingCount([...fivePending, verifiedRow]), 5);
eq("the pending cap counts against the account address too",
  P(account, fivePending), `You can have ${MAX_PENDING_PER_ACCOUNT} addresses waiting to be confirmed. Confirm or remove one first.`);

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

// The provider-verified mailbox. profiles.verified_email is server-owned and
// is, for most live accounts, the address the physician actually reads mail
// at, while profiles.email is whatever they typed into Settings. It was not in
// this answer, so a physician who mails themselves a credentialing checklist
// from that mailbox and forwards it in saw a green Approve button, and the tap
// mailed the DEA, licence and CV packet to their own inbox and stamped the
// request 'replied'. send-packet-email refuses that send now; this is the same
// refusal one screen earlier.
eq("senders: the provider-verified mailbox is mine too",
  forwardingSenders(account, [], { verifiedEmail: "hosp@x.org" }), [account, "hosp@x.org"]);
eq("senders: it is normalized like everything else",
  forwardingSenders("", [], { verifiedEmail: "  HOSP@X.Org " }), ["hosp@x.org"]);
eq("senders: it is not listed twice when it is also the account address",
  forwardingSenders("hosp@x.org", [], { verifiedEmail: "hosp@x.org" }), ["hosp@x.org"]);
eq("senders: it is not listed twice when it is also a confirmed row",
  forwardingSenders(account, [{ id: "h", email: "hosp@x.org", verified_at: "2026-09-03T00:00:00Z" }], { verifiedEmail: "hosp@x.org" }),
  [account, "hosp@x.org"]);
eq("senders: omitting it changes nothing, so every old caller is unaffected",
  forwardingSenders(account, rows), forwardingSenders(account, rows, {}));
eq("senders: an empty verified mailbox adds nothing",
  forwardingSenders(account, rows, { verifiedEmail: "" }), [account, "c@x.org", "a@x.org"]);
// It answers "mine", not "routes": this must NOT leak into routableSenders,
// which has its own accountVerified input and a different rule.
eq("routable is untouched by it",
  routableSenders(account, rows, { accountVerified: false }), ["c@x.org", "a@x.org"]);

// ── "Mine" and "routes" are two questions with two answers ──────────────────
// forwardingSenders answers "which addresses are MINE": App.jsx feeds it to
// requesterMissing(), which uses it to notice that a request names the
// physician's own address as the requester, meaning the forward carried no
// From: line and there is nobody to reply to. True of the account address
// whether or not it is confirmed, so it stays in that answer.
//
// routableSenders answers "which addresses will inbound mail MATCH". Since
// email-inbound stopped falling back to profiles.email, an unconfirmed
// account address matches nothing, and a screen that names it sends a
// physician to forward real credentialing mail into the void.
const confirmedOnly = [
  { id: "a", email: "a@x.org", verified_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" },
  { id: "c", email: "c@x.org", verified_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
];
eq("routable: an unverified account address is not routable",
  routableSenders(account, rows), ["c@x.org", "a@x.org"]);
eq("routable: confirmed rows keep the display order sortAddresses gives them",
  routableSenders(account, confirmedOnly), ["c@x.org", "a@x.org"]);
eq("routable: nothing confirmed and an unverified account is an empty list",
  routableSenders(account, []), []);
eq("routable: a waiting address is not routable",
  routableSenders(account, [{ id: "b", email: "b@x.org", verified_at: null }]), []);
eq("routable: the account address routes once it has a confirmed row of its own",
  routableSenders(account, [...confirmedOnly, { id: "me", email: account, verified_at: "2026-09-05T00:00:00Z", created_at: "2026-09-05T00:00:00Z" }]),
  [account, "c@x.org", "a@x.org"]);
eq("routable: a confirmed row for the account address in another case still counts",
  routableSenders("NAME@Gmail.com", [{ id: "me", email: "name@gmail.com", verified_at: "2026-09-05T00:00:00Z" }]),
  ["name@gmail.com"]);
eq("routable: the caller may say the server verified the account mailbox",
  routableSenders(account, confirmedOnly, { accountVerified: true }), [account, "c@x.org", "a@x.org"]);
eq("routable: a verified account address that is also a confirmed row is listed once",
  routableSenders(account, [{ id: "me", email: account, verified_at: "2026-09-05T00:00:00Z" }], { accountVerified: true }),
  [account]);
eq("routable: no account email at all adds no empty entry",
  routableSenders("", confirmedOnly, { accountVerified: true }), ["c@x.org", "a@x.org"]);
eq("routable: a waiting row for the account address does not make it routable",
  routableSenders(account, [{ id: "me", email: account, verified_at: null }]), []);
eq("routable: does not mutate its input", confirmedOnly.map((r) => r.id), ["a", "c"]);
ok("the two answers differ for an unverified account, which is the whole point",
  JSON.stringify(forwardingSenders(account, confirmedOnly)) !== JSON.stringify(routableSenders(account, confirmedOnly)));
ok("and agree once the account address is confirmed", (() => {
  const withMine = [...confirmedOnly, { id: "me", email: account, verified_at: "2026-09-05T00:00:00Z", created_at: "2026-09-05T00:00:00Z" }];
  return JSON.stringify(forwardingSenders(account, withMine)) === JSON.stringify(routableSenders(account, withMine));
})());

// ── The server-verified account mailbox ─────────────────────────────────────
// profiles.verified_email is the other thing email-inbound routes on, and no
// screen could see it: routableSenders' accountVerified defaulted to false and
// nobody passed it, so a physician whose Clerk-verified mailbox was routing
// mail perfectly well was told by Settings and by Requests that nothing
// reached them, and offered a challenge email for a mailbox the server
// already trusts.
ok("the account mailbox is verified when the provider verified that same address",
  accountMailboxVerified("Whit <NAME@Gmail.com>", "name@gmail.com"));
ok("a different verified mailbox does not verify the account address",
  !accountMailboxVerified("other@hospital.org", "name@gmail.com"));
ok("no verified column, no claim", !accountMailboxVerified(null, "name@gmail.com"));
ok("an empty verified column proves nothing", !accountMailboxVerified("", "name@gmail.com"));
ok("two empties are not a match", !accountMailboxVerified("", ""));
ok("a verified address with no account address is not a match",
  !accountMailboxVerified("name@gmail.com", ""));
eq("and it is exactly what routableSenders' option wants",
  routableSenders(account, [], { accountVerified: accountMailboxVerified(account, account) }), [account]);
eq("a provider-verified mailbox that is NOT the account address adds nothing",
  routableSenders(account, [], { accountVerified: accountMailboxVerified("someone@else.org", account) }), []);

eq("rowForAddress finds the row whatever the case or display name",
  rowForAddress("Whit <NAME@Gmail.com>", [{ id: "me", email: "name@gmail.com", verified_at: null }])?.id, "me");
eq("rowForAddress has nothing to find", rowForAddress("nobody@x.org", confirmedOnly), undefined);
eq("rowForAddress with no address at all", rowForAddress("", confirmedOnly), undefined);

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
  addProblem({ email: "chief*@hospital.org", rows: [] }),
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

// ── The screens, read as text: which list each one actually uses ───────────
// These two lists are one letter apart at the call site and a swap in either
// direction is silent at runtime, so the calls themselves are asserted here.
const appSrc = read("../src/App.jsx");
const inboxSrc = read("../src/components/features/RequestsInbox.jsx");
const settingsSrc = read("../src/components/pages/SettingsSection.jsx");

ok("App.jsx ownSenders still asks the 'mine' question",
  /const ownSenders = useMemo\(\s*\(\) => forwardingSenders\(/.test(appSrc));
// The provider-verified mailbox is one of the physician's own addresses and
// was missing from both 'mine' lists. Without it a request whose From: is the
// mailbox Clerk verified reads as a real requester, and the Home banner offers
// a one-tap send that mails the packet back to the physician.
ok("App.jsx passes the provider-verified mailbox into the 'mine' list",
  /forwardingSenders\([^)]*\{ verifiedEmail: data\.settings\?\.verifiedEmail/.test(appSrc));
ok("App.jsx does not quietly switch ownSenders to the routable list",
  !/routableSenders\(/.test(appSrc) && appSrc.includes('import { forwardingSenders } from "./utils/forwardingAddresses"'));
ok("App.jsx names requesterMissing as the reason it stays that way",
  appSrc.slice(Math.max(0, appSrc.indexOf("const ownSenders") - 1400), appSrc.indexOf("const ownSenders")).includes("requesterMissing"));

const cmeSrc = read("../src/components/features/CMESection.jsx");
const crudSrc = read("../src/components/features/CrudSection.jsx");
// A "this used to say X" comment is not copy a physician reads, and quoting
// the old sentence in one is how you explain the fix. The absence checks below
// run against the code with its comments taken out, so they answer the
// question they claim to.
const copyOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const inboxCopy = copyOnly(inboxSrc);
const cmeCopy = copyOnly(cmeSrc);
const crudCopy = copyOnly(crudSrc);

ok("the inbox imports the routable list", inboxSrc.includes("routableSenders"));
ok("the inbox's forward-from copy names the routable addresses",
  /const sendersText = joinAddresses\(routable\)/.test(inboxSrc));
ok("the inbox no longer advertises the 'mine' list as the one to forward from",
  !inboxSrc.includes("joinAddresses(senders)"));
ok("the inbox still hands the 'mine' list to the approve button",
  inboxSrc.includes("ownAddresses={senders}") && /const senders = useMemo\(\s*\(\) => forwardingSenders\(/.test(inboxSrc));
ok("the inbox's 'mine' list carries the provider-verified mailbox too",
  /forwardingSenders\([^)]*\{ verifiedEmail: data\.settings\?\.verifiedEmail/.test(inboxSrc));
ok("the empty case sends the physician to confirm one rather than naming a dead address",
  /sendersText\s*\n?\s*\?/.test(inboxSrc) && inboxSrc.includes("CONFIRM_FIRST_SENTENCE"));

// The header is the copy a physician acts on, and it is on screen every
// visit; the empty state only renders when the list is empty. It printed
// `senders`, which always carries the account address, so it named an
// unconfirmed mailbox as a place to forward from while the empty state below
// it said the opposite. Nothing about the header's own text catches that, so
// the list it maps over is asserted here.
ok("the header names the routable addresses", /\{routable\.map\(/.test(inboxSrc));
ok("the header no longer maps over the 'mine' list", !/\{senders\.map\(/.test(inboxCopy));
ok("the header falls back to the same confirm-first sentence when nothing routes",
  /routable\.length > 0 \?/.test(inboxSrc) && inboxSrc.includes("CONFIRM_FIRST_SENTENCE"));
ok("the inbox tells routableSenders what the server verified",
  /routableSenders\(realEmail, forwarding, \{[\s\S]{0,80}accountVerified/.test(inboxSrc));

ok("Settings no longer promises the account address is always on",
  !settingsSrc.includes("Always on."));
ok("Settings offers the account address the same confirmation every address gets",
  settingsSrc.includes("Confirm this address") && settingsSrc.includes("onConfirmAccount"));
ok("Settings reads the account address's state from the rows it actually has",
  settingsSrc.includes("rowForAddress(accountEmail, rows)"));
ok("Settings reads the server-verified mailbox too",
  settingsSrc.includes("accountMailboxVerified(verifiedEmail, email)"));
ok("Settings does not offer a challenge for a mailbox the provider already verified",
  /\{!r && !providerVerified && \(/.test(settingsSrc));
ok("Settings stops claiming an unconfirmed account address always routes nothing",
  !settingsSrc.includes("including your account address, routes nothing"));

// cme@ and contacts@ go through the same matchProfile as docs@, so the same
// rule applies to their copy. The CME hint named data.settings.email, which is
// profiles.email, the column the matcher was deliberately stopped from
// reading; the contacts instruction said "the address on your account", which
// is the same claim without an interpolated variable to grep for.
ok("the CME hint no longer names profiles.email", !cmeCopy.includes("{data.settings.email"));
ok("the CME hint asks the routable question", cmeSrc.includes("routableSenders("));
ok("the CME hint falls back to the one confirm-first sentence",
  cmeSrc.includes("CONFIRM_FIRST_SENTENCE"));
ok("the contacts instruction no longer says to send from the account address",
  !/from the address on your\s+account/.test(crudCopy));
// PR9 rewrote this instruction on main. Its wording differs from the one this
// batch wrote, and the property is the same one: the sentence must point at a
// VERIFIED forwarding address, because contacts@ routes on confirmed
// forwarding rows and profiles.verified_email and on nothing else.
ok("the contacts instruction names a verified forwarding address instead",
  /from your verified forwarding address/.test(crudSrc));

// One sentence, three screens. Each of them carried its own copy of this and
// two of the three were wrong, so the constant is the only place it lives.
ok("the confirm-first sentence names the panel that fixes it",
  CONFIRM_FIRST_SENTENCE.includes("Settings, Email"));
ok("and says why there is no address to name",
  CONFIRM_FIRST_SENTENCE.includes("Nothing reaches this account from an unconfirmed address"));
for (const [where, src] of [["the inbox", inboxCopy], ["CME", cmeCopy]]) {
  ok(`${where} uses the shared sentence rather than a hand-copied one`,
    src.includes("CONFIRM_FIRST_SENTENCE") && !src.includes("Nothing reaches this account from an unconfirmed address."));
}

// ── The ticket agent's queue, after PR11 moved it out of the shell ──────────
// This block used to assert that the runner and the prompt each carried the
// same ELIGIBLE/GATE clause, spelled identically, because three hand-written
// copies of one query had already drifted once. PR11 removed the copies
// instead: the shell builds no SQL, the prompt carries no query, and every
// queue read goes through scripts/ticket-agent-context.mjs behind one APPROVED
// rule. That is a stronger fix for the drift than keeping three copies in step.
//
// What it changes for THIS batch: eligibility is no longer asked in the runner.
// It is enforced where the row is written (20260915c and 20260915f refuse a
// ticket or message from an account that is not active), and the owner's
// approval is what releases a physician's ticket to the agent at all. So the
// thing to pin here is that no path around APPROVED exists.
const runnerSrc = read("./ticket-agent.sh");
const promptSrc = read("./ticket-agent-prompt.md");
const contextSrc = read("./ticket-agent-context.mjs");
ok("the shell builds no ticket SQL of its own",
  !/FROM support_tickets/i.test(runnerSrc) && !/agent_approved_at/.test(runnerSrc));
ok("the prompt hands the agent no query to run",
  !/FROM support_tickets/i.test(promptSrc));
ok("the runner reads its queue through the shared context module",
  /ticket-agent-context\.mjs"?\s*\\?\s*\n?\s*--queue/.test(runnerSrc) || /ticket-agent-context\.mjs[^\n]*\n[^\n]*--queue/.test(runnerSrc));
ok("the approval rule is defined once, in the context module",
  (contextSrc.match(/export const APPROVED\s*=/g) || []).length === 1);
ok("it admits the owner, or a ticket the owner released",
  /public\.is_admin\(t\.user_id\) OR t\.agent_approved_at IS NOT NULL/.test(contextSrc));
{
  // Five reads, two kinds. The three that SELECT A TARGET for the agent must
  // carry APPROVED. The two that load history for an already-approved target
  // (historySQL, messagesSQL) are scoped to that ticket's owner instead, which
  // is PR11's cross-ticket memory working as designed. Worth knowing what that
  // means: approving one ticket brings the same customer's other ticket text
  // into the agent's context as history.
  const fn = (name) => { const i = contextSrc.indexOf(`export function ${name}(`); return i < 0 ? "" : contextSrc.slice(i, contextSrc.indexOf("\nexport function", i + 10)); };
  for (const name of ["queueSQL", "continuationSQL", "targetSQL"]) {
    ok(`${name} selects targets only through APPROVED`, /\$\{APPROVED\}/.test(fn(name)), name);
  }
  for (const name of ["historySQL", "messagesSQL"]) {
    ok(`${name} is scoped to the approved target's owner`, /t\.user_id='\$\{id\(ownerId\)\}'::uuid/.test(fn(name)), name);
  }
}
ok("eligibility is enforced where the ticket is written",
  /current_profile_active\(\)/.test(read("../supabase/migrations/20260915c_ticket_admission.sql")));

// ── House rules ──────────────────────────────────────────────────────────────
const everyString = [
  P("nope"), P("me@credentialdomd.com"), P(account), P("name@hospital.org", [verifiedRow]),
  P("name@clinic.org", [pendingRow]), P("new@hospital.org", fivePending),
  pendingLine({ last_sent_at: at(4) }, t0), pendingLine({}, t0),
  resendBlockedReason({ verified_at: null, last_sent_at: at(3) }, t0),
  sentAgoLabel(at(4), t0), joinAddresses(["a@x.org", "b@x.org", "c@x.org"]),
  CONFIRM_FIRST_SENTENCE,
].filter(Boolean);
ok("every line a physician reads is free of em dashes", everyString.every((t) => !t.includes("—")));
ok("nothing claims a compliance standard",
  everyString.every((t) => !/HIPAA|SOC ?2|bank-level|military-grade/i.test(t)));

// ── The provider-verified mailbox routes on its own footing ────────────────
// routableSenders used to take only a boolean, "is the account address the
// verified one". So when Settings held the physician's typed professional
// address and the sign-in provider had verified a DIFFERENT mailbox, the
// routable list came out empty: CME and Requests told them to confirm an
// address first, and Settings did not show the one that already worked, while
// the server was filing their forwarded documents from it the whole time.
{
  const ACCT = "typed@practice.example";
  const PROV = "verified@hospital.example";
  const OTHER = "clinic@hospital.example";
  const confirmedRow = (e) => ({ id: e, email: e, verified_at: "2026-09-01T00:00:00Z" });
  const pendingRow = (e) => ({ id: e, email: e, verified_at: null });

  eq("a distinct provider-verified mailbox is routable on its own",
    routableSenders(ACCT, [], { verifiedEmail: PROV }), [PROV]);
  ok("and the typed account address is NOT, because nothing proved it",
    !routableSenders(ACCT, [], { verifiedEmail: PROV }).includes(ACCT));
  eq("with no verified mailbox and no confirmed rows, still nothing routes",
    routableSenders(ACCT, [], {}), []);
  eq("a pending row does not make the typed address routable",
    routableSenders(ACCT, [pendingRow(ACCT)], { verifiedEmail: PROV }), [PROV]);

  // When they are the same address it appears once, not twice.
  eq("provider-verified account address routes, once",
    routableSenders(ACCT, [], { verifiedEmail: ACCT }), [ACCT]);
  eq("and the old accountVerified flag still works on its own",
    routableSenders(ACCT, [], { accountVerified: true }), [ACCT]);

  // Confirmed rows keep working alongside it, and nothing is duplicated.
  {
    const out = routableSenders(ACCT, [confirmedRow(OTHER)], { verifiedEmail: PROV });
    ok("a confirmed row and a distinct verified mailbox both route", out.includes(OTHER) && out.includes(PROV));
    eq("and neither is duplicated", out.length, new Set(out).size);
    ok("the typed address is still absent", !out.includes(ACCT));
  }
  {
    const out = routableSenders(ACCT, [confirmedRow(ACCT)], { verifiedEmail: PROV });
    ok("confirming the account address makes it routable too", out.includes(ACCT) && out.includes(PROV));
    eq("still no duplicates", out.length, new Set(out).size);
  }
  // Case and display names are normalized, so the same mailbox cannot appear twice.
  eq("a differently cased verified address is the same address",
    routableSenders(ACCT, [confirmedRow(PROV)], { verifiedEmail: PROV.toUpperCase() }), [PROV]);
  eq("a display name on the verified address is stripped",
    routableSenders(ACCT, [], { verifiedEmail: `Dr Reyes <${PROV}>` }), [PROV]);
  eq("a blank verified address adds nothing", routableSenders(ACCT, [], { verifiedEmail: "   " }), []);
  eq("a non-string verified address adds nothing", routableSenders(ACCT, [], { verifiedEmail: 42 }), []);

  // forwardingSenders answers a DIFFERENT question, "which addresses are
  // mine", and must keep including the verified one so the self-send guard
  // still recognises it.
  ok("forwardingSenders still claims the verified mailbox as ours",
    forwardingSenders(ACCT, [], { verifiedEmail: PROV }).includes(PROV));
}

// The three call sites, read from source.
{
  const cme = read("../src/components/features/CMESection.jsx");
  ok("CME passes the verified mailbox through", /routableSenders\([\s\S]{0,160}?verifiedEmail:/.test(cme));
  const inbox = read("../src/components/features/RequestsInbox.jsx");
  ok("Requests passes it too", /routableSenders\([\s\S]{0,200}?verifiedEmail:/.test(inbox));
  ok("and it is in the memo's dependencies, so the row appears when it lands",
    /routableSenders\([\s\S]{0,240}?\[[^\]]*verifiedEmail[^\]]*\]/.test(inbox));
  const settings = read("../src/components/pages/SettingsSection.jsx");
  ok("Settings computes a provider-only row", /const providerOnly = \(\) =>|const providerOnly = \(\(\) =>/.test(settings));
  ok("it only draws it when the address differs from the account address",
    /v === normalizeAddress\(accountEmail\)\) return null;/.test(settings));
  ok("it does not draw it twice when a forwarding row already covers it",
    /rowForAddress\(v, rows\) \? null : v/.test(settings));
  ok("the provider row is rendered", /\{providerOnly && \(/.test(settings));
  // The follow-on edge: a provider-verified mailbox that ALSO has a PENDING
  // forwarding row fell between the two. providerOnly suppresses the read-only
  // row because a row exists for that address, and addressRow then labelled it
  // Waiting, because the provider evidence was only ever applied to the
  // account row. The mailbox routes today. The address decides, not which row
  // happens to carry it.
  ok("provider evidence is decided per address, not per row position",
     /const providerVerified = accountMailboxVerified\(verifiedEmail, email\);/.test(settings));
  ok("the old account-only flag is gone", !/const acctVerified = accountMailboxVerified/.test(settings));
  {
    // Comments are allowed to name the old flag; code is not.
    const code = settings.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    ok("and no code still reads it", !/\bacctVerified\b/.test(code));
  }
  ok("a pending link on a provider-verified address says it is not what makes it work",
     /it is not what makes this address work/.test(settings));
  ok("removing that forwarding row is not described as stopping the mail",
     /This address keeps working: your sign-in provider verified it/.test(settings));
  ok("a non-account provider-verified row points at the sign-in provider, not Physician Profile",
     /Change it where you sign in, not here\./.test(settings));
  ok("it is read-only: no Resend and no Remove on it",
    !/providerOnly[\s\S]{0,900}?(onResend|onRemove)/.test(settings));
  ok("and it says where to change it", /Change it where you sign in, not here\./.test(settings));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
