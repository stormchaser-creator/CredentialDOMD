// Checks for supabase/functions/_shared/requestFlow.ts: the rules that decide
// whether docs@ may acknowledge a credentialer on the physician's behalf, the
// two emails that flow produces, and the shape of an "Approve and send" call.
//
// The ack is mail sent to a third party from our domain with the physician's
// name on it, so every refusal below is a way it would have gone to the wrong
// place: back to the physician, to a no-reply queue, or into a loop with our
// own address. Node 22.18+ strips the type annotations on import; no build
// step, no runner.
// Run: node scripts/request-flow.test.mjs
import {
  ackAllowed, ackText, physicianSummaryText, approveRequestBody, firstName, longDate, replySubject, senderPositivelyAuthenticated,
  topAuthenticationResults, authservId, authEvidence, authVerdicts, senderAuthFailure,
  MAX_APPROVE_SUBJECT, MAX_APPROVE_TEXT, MAX_REPLY_SUBJECT,
} from "../supabase/functions/_shared/requestFlow.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const noEmDash = (name, s) => ok(`${name}: no em dash`, !String(s).includes("\u2014"), JSON.stringify(s));

// ── ackAllowed: the one good case, then every refusal ────────────────────────
const good = {
  requesterAddr: "madeline.castorena@ruhealth.org",
  requesterName: "Madeline Castorena",
  forwarderAddr: "stormchaser@elryx.com",
  physicianEmail: "stormchaser@elryx.com",
  requesterFound: true,
  ackRequests: true,
  senderAuthenticated: true,
};
eq("a real credentialer, found in the forward, may be acknowledged", ackAllowed(good), { ok: true, why: "" });
eq("ack_requests null (column not yet filled) still means on", ackAllowed({ ...good, ackRequests: null }).ok, true);
eq("ack_requests undefined still means on", ackAllowed({ ...good, ackRequests: undefined }).ok, true);

const refused = (name, patch, whyPart) => {
  const d = ackAllowed({ ...good, ...patch });
  ok(`refused: ${name}`, d.ok === false && d.why.includes(whyPart), JSON.stringify(d));
};
refused("requester not found (address on the row is the physician's own)", { requesterFound: false }, "not found");
refused("acknowledgements switched off", { ackRequests: false }, "off");
refused("empty requester address", { requesterAddr: "" }, "no requester address");
refused("requester is not an email address", { requesterAddr: "madeline" }, "no requester address");
refused("our own domain", { requesterAddr: "docs@credentialdomd.com" }, "credentialdomd.com");
refused("a subdomain of ours", { requesterAddr: "x@mail.credentialdomd.com" }, "credentialdomd.com");
ok("a lookalike domain is not ours", ackAllowed({ ...good, requesterAddr: "a@notcredentialdomd.com" }).ok);
refused("requester is the forwarder", { requesterAddr: "stormchaser@elryx.com" }, "forwarding address");
refused("requester is the forwarder, any case", { requesterAddr: "StormChaser@Elryx.com", physicianEmail: "other@x.org" }, "forwarding address");
refused("requester is the physician's profile address", { requesterAddr: "eric@hospital.org", physicianEmail: "ERIC@hospital.org" }, "physician's own address");
// The forward itself must be positively authenticated. This is the one send
// that leaves our domain addressed by the forwarded text, so "no failure
// recorded" (the rule that files a certificate) is not enough here.
refused("forward not positively authenticated", { senderAuthenticated: false }, "authenticated");
refused("authentication unknown is not authenticated", { senderAuthenticated: undefined }, "authenticated");
refused("authentication as a truthy non-boolean is not authenticated", { senderAuthenticated: "pass" }, "authenticated");
// Any other confirmed address of the physician: they mailed themselves the
// checklist from the hospital account and forwarded it from the personal one.
refused("requester is one of the physician's confirmed forwarding addresses",
  { requesterAddr: "whit@hospital.org", forwarderAddr: "eric@gmail.com", physicianEmail: "eric@gmail.com", ownAddresses: ["Whit@Hospital.org"] }, "confirmed addresses");
ok("ownAddresses accepts a Set", ackAllowed({ ...good, requesterAddr: "whit@hospital.org", ownAddresses: new Set(["whit@hospital.org"]) }).ok === false);
ok("an unrelated confirmed address changes nothing", ackAllowed({ ...good, ownAddresses: ["whit@hospital.org"] }).ok);
ok("no ownAddresses at all is fine", ackAllowed({ ...good, ownAddresses: null }).ok);
for (const local of ["no-reply", "noreply", "do-not-reply", "donotreply", "mailer-daemon", "postmaster", "bounce", "bounces", "notification", "notifications", "NoReply"]) {
  refused(`machine mailbox ${local}@`, { requesterAddr: `${local}@hospital.org` }, "automated");
}
// A prefix match, the same convention email-inbound's isAutomatedSender uses:
// bounce-handler@, bounces@ and noreply-hr@ are all machines. The cost is a
// person whose local part starts with one of those words, which is rarer than
// the variants the prefix catches.
refused("a machine word as a prefix still counts", { requesterAddr: "bounce-handler@hospital.org" }, "automated");
ok("a local part that merely contains 'bounce' later is fine", ackAllowed({ ...good, requesterAddr: "jane.bounce@hospital.org" }).ok);
ok("the refusal order puts 'not found' first, so a not-found self-address reads as not found",
  ackAllowed({ ...good, requesterFound: false, requesterAddr: good.physicianEmail }).why.includes("not found"));

// ── ackText: what the credentialer reads ─────────────────────────────────────
const ack = ackText({ requesterName: "Madeline Castorena", physicianName: "Eric Whitney", degree: "DO", askCount: 1, receivedAtIso: "2026-09-11T17:03:12.000Z" });
eq("the ack, one ask, with degree", ack,
  "Hello Madeline,\n\nThis confirms that your request to Eric Whitney was received on September 11, 2026. Any documents will come from this address; a reply to this email reaches Eric Whitney directly.\n\nRegards,\nEric Whitney, DO");
// The ack is not a commitment. "will be sent once approved" read to a
// credentialer as a promise to send, and they chased it.
ok("the ack promises nothing about sending", !/will be sent|once approved|documents will follow/i.test(ack));
ok("the ack says where any documents would come from and where a reply lands", ack.includes("Any documents will come from this address; a reply to this email reaches Eric Whitney directly."));
ok("several asks say how many", ackText({ requesterName: "Tara Domalewski", physicianName: "Eric Whitney", degree: "DO", askCount: 4, receivedAtIso: "2026-08-05T16:57:00Z" })
  .includes("your request for 4 items to Eric Whitney was received on August 5, 2026"));
ok("no degree, no trailing comma", ackText({ requesterName: "Tara", physicianName: "Eric Whitney", degree: "", askCount: 1, receivedAtIso: "2026-08-05T16:57:00Z" }).endsWith("Regards,\nEric Whitney"));
ok("no requester name greets 'there'", ackText({ requesterName: "", physicianName: "Eric Whitney", degree: "DO", askCount: 1, receivedAtIso: "2026-08-05T16:57:00Z" }).startsWith("Hello there,"));
ok("an office as the requester greets 'there', not 'Hello Medical,'", ackText({ requesterName: "Medical Staff Services", physicianName: "Eric Whitney", degree: "DO", askCount: 1, receivedAtIso: "2026-08-05T16:57:00Z" }).startsWith("Hello there,"));
ok("an unparseable date drops the date rather than printing garbage",
  ackText({ requesterName: "T", physicianName: "E W", degree: "", askCount: 1, receivedAtIso: "not a date" }).includes("to E W was received. Any documents will come from this address"));
ok("no physician name signs as CredentialDOMD, not as a blank line",
  ackText({ requesterName: "T", physicianName: "", degree: "DO", askCount: 1, receivedAtIso: "2026-08-05T16:57:00Z" }).endsWith("Regards,\nCredentialDOMD"));
noEmDash("ack", ack);

// ── firstName / longDate, the two helpers the texts lean on ─────────────────
eq("first word of a plain name", firstName("Madeline Castorena"), "Madeline");
eq("Outlook's signature stars are stripped", firstName("*Madeline Castorena *"), "Madeline");
eq("Last, First is read the right way round", firstName("Castorena, Madeline"), "Madeline");
eq("First Last, Title keeps the given name", firstName("Tara Domalewski, CPCS"), "Tara");
eq("an honorific is skipped", firstName("Dr. Jane Smith"), "Jane");
eq("empty is 'there'", firstName(""), "there");
eq("null is 'there'", firstName(null), "there");
// The same rule as the cover note's firstName in requestPacket.ts, so the
// two emails a requester reads greet them the same way.
for (const org of ["Medical Staff Services", "RUHS Credentialing Department", "Credentialing Team", "noreply", "Provider Enrollment", "Hospital Privileging Office"]) {
  eq(`an office is 'there': ${org}`, firstName(org), "there");
}
eq("an address is 'there'", firstName("medstaff@hospital.org"), "there");
eq("a shouted name is calmed", firstName("MARISOL CASTELLANO"), "Marisol");
eq("a lone initial is 'there'", firstName("M. Castellano"), "there");
eq("longDate formats in full", longDate("2026-01-02T00:00:00Z"), "January 2, 2026");
eq("longDate on rubbish is empty", longDate("yesterday"), "");

// ── replySubject: one "Re:", whatever the stored subject starts with ─────────
eq("RE: is not doubled", replySubject("RE: Requested docs"), "Re: Requested docs");
eq("Fwd: Re: is peeled to one Re:", replySubject("Fwd: Re: Requested docs"), "Re: Requested docs");
eq("a plain subject gets Re:", replySubject("BOARD CERTIFICATE"), "Re: BOARD CERTIFICATE");
eq("no subject falls back", replySubject(""), "Re: your document request");
eq("null falls back", replySubject(null), "Re: your document request");
eq("a custom fallback", replySubject(undefined, "docs"), "Re: docs");
eq("line breaks cannot reach the header", replySubject("docs\r\nBcc: x@y.z"), "Re: docs Bcc: x@y.z");
ok("a long subject is capped", replySubject("s".repeat(400)).length === MAX_REPLY_SUBJECT + 4);
ok("a subject that is nothing but prefixes falls back", replySubject("Re: Fwd: FW:") === "Re: your document request");

// ── senderPositivelyAuthenticated: the gate on the third-party send ──────────
const FROM = "stormchaser@elryx.com";
ok("dmarc=pass is enough", senderPositivelyAuthenticated("mx.resend.com; dkim=pass header.d=elryx.com; spf=pass smtp.mailfrom=elryx.com; dmarc=pass", FROM));
ok("dmarc=pass in any case", senderPositivelyAuthenticated("DMARC=PASS", FROM));
ok("spf=pass with an aligned dkim=pass (header.d)", senderPositivelyAuthenticated("spf=pass smtp.mailfrom=elryx.com; dkim=pass header.d=elryx.com header.s=k1", FROM));
ok("spf=pass with an aligned dkim=pass (header.i)", senderPositivelyAuthenticated("dkim=pass header.i=@elryx.com; spf=pass", FROM));
ok("a subdomain signature aligns with the organisational domain", senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=mail.elryx.com", FROM));
ok("a sender on a subdomain aligns with the parent signature", senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=elryx.com", "eric@mail.elryx.com"));
ok("no header at all is a no", !senderPositivelyAuthenticated("", FROM));
ok("null is a no", !senderPositivelyAuthenticated(null, FROM));
ok("spf=none dmarc=none is a no", !senderPositivelyAuthenticated("spf=none; dkim=none; dmarc=none", FROM));
ok("spf=pass alone is a no", !senderPositivelyAuthenticated("spf=pass smtp.mailfrom=elryx.com", FROM));
ok("dkim=pass alone is a no", !senderPositivelyAuthenticated("dkim=pass header.d=elryx.com", FROM));
ok("spf=pass with a dkim=pass from another domain is a no", !senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=attacker.example", FROM));
ok("a lookalike signing domain does not align", !senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=notelryx.com", FROM));
ok("dkim=fail beside spf=pass is a no", !senderPositivelyAuthenticated("spf=pass; dkim=fail header.d=elryx.com", FROM));
ok("dmarc=fail beside passing spf and dkim is a no", !senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=elryx.com; dmarc=fail", FROM));
ok("no sender address cannot align", !senderPositivelyAuthenticated("spf=pass; dkim=pass header.d=elryx.com", ""));

// The MTA's own header echoes sender-chosen identifiers beside its verdicts
// (smtp.mailfrom=, smtp.helo=, header.i=), and each accepts "=" in the
// sender's part. A substring test read "dmarc=pass" out of the envelope
// sender below and authorised the acknowledgement on a genuine header whose
// DMARC verdict was none; the attacker needed only an SPF record of their
// own and a victim From domain without DMARC. Only the token that opens a
// clause is a verdict.
const HOSP = "physician@hospital.org";
const MX = ["mx.resend.com"];
ok("echoed 'dmarc=pass' in smtp.mailfrom is not a verdict",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=dmarc=pass@attacker.example; dkim=none; dmarc=none header.from=hospital.org", HOSP, MX));
ok("echoed 'dmarc=pass' in header.i is not a verdict",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=bounce@attacker.example; dkim=pass header.i=dmarc=pass@attacker.example header.d=attacker.example; dmarc=none header.from=hospital.org", HOSP, MX));
ok("echoed 'dmarc=pass' in smtp.helo is not a verdict",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=bounce@attacker.example smtp.helo=dmarc=pass.attacker.example; dkim=none; dmarc=none header.from=hospital.org", HOSP, MX));
ok("control: the same shape with an honest dmarc=none is a no",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=bounce@hospital.org; dkim=none; dmarc=none header.from=hospital.org", HOSP, MX));
ok("control: the same shape with a real dmarc=pass clause is a yes",
  senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=bounce@attacker.example; dkim=none; dmarc=pass header.from=hospital.org", HOSP, MX));
ok("'header.d=hospital.org' inside the sender's DKIM i= tag is not the signing domain",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=bounce@attacker.example; dkim=pass header.i=header.d=hospital.org@attacker.example header.d=attacker.example; dmarc=none", HOSP, MX));
ok("a verdict inside a comment or a quoted reason is not a verdict",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass; dkim=pass (see; dmarc=pass) header.d=attacker.example reason=\"x; dmarc=pass\"; dmarc=none", HOSP, MX));
ok("an aligned dkim=pass beside spf=pass still authenticates in the same MTA shape",
  senderPositivelyAuthenticated("mx.resend.com; spf=pass smtp.mailfrom=hospital.org; dkim=pass header.d=hospital.org header.i=@hospital.org; dmarc=none", HOSP, MX));
ok("header.d in a second, failing dkim clause does not align the passing one",
  !senderPositivelyAuthenticated("mx.resend.com; spf=pass; dkim=pass header.d=attacker.example; dkim=fail header.d=hospital.org; dmarc=none", HOSP, MX));
eq("authVerdicts reads one method=result per clause and nothing after it",
  authVerdicts("mx.resend.com; spf=pass smtp.mailfrom=dmarc=pass@attacker.example; dkim=none; dmarc=none header.from=hospital.org").map((v) => `${v.method}=${v.result}`),
  ["spf=pass", "dkim=none", "dmarc=none"]);
eq("authVerdicts: the authserv-id is not a verdict; a bare value is read from its first clause",
  [authVerdicts("mx.resend.com 1; dmarc=pass").map((v) => v.result), authVerdicts("dmarc=pass").map((v) => v.result)], [["pass"], ["pass"]]);
eq("authVerdicts: a comment and a quoted reason do not split or add clauses",
  authVerdicts("mx; dkim=pass (a; b) header.d=x reason=\"y; dmarc=fail\"; dmarc=none").map((v) => `${v.method}=${v.result}`), ["dkim=pass", "dmarc=none"]);
eq("authVerdicts on nothing", [authVerdicts(""), authVerdicts(null), authVerdicts("mx.resend.com; none")], [[], [], []]);

// ── senderAuthFailure: the filing check, on the same parser ────────────────
// email-inbound drops a message on dmarc=fail, or on spf and dkim both
// failing, and lets a missing header through (filing goes into the sender's
// own account). "dkim=pass" echoed in the envelope sender beside
// spf=softfail once rescued the filing; the text it returns is the lowercased
// header, for the ledger detail.
eq("dmarc=fail is a failure", senderAuthFailure("mx.resend.com; dmarc=fail header.from=elryx.com"), "mx.resend.com; dmarc=fail header.from=elryx.com");
eq("spf=softfail with no dkim=pass is a failure", senderAuthFailure("mx.resend.com; spf=softfail; dkim=none"), "mx.resend.com; spf=softfail; dkim=none");
ok("spf=fail with dkim=fail is a failure", senderAuthFailure("spf=fail; dkim=fail").length > 0);
eq("spf=softfail rescued by a real dkim=pass is ok", senderAuthFailure("mx.resend.com; spf=softfail smtp.mailfrom=x@y.example; dkim=pass header.d=y.example; dmarc=none"), "");
eq("spf=softfail is NOT rescued by 'dkim=pass' echoed in smtp.mailfrom",
  senderAuthFailure("mx.resend.com; spf=softfail smtp.mailfrom=dkim=pass@attacker.example; dkim=none; dmarc=none"),
  "mx.resend.com; spf=softfail smtp.mailfrom=dkim=pass@attacker.example; dkim=none; dmarc=none");
eq("echoed 'dmarc=fail' does not refuse an honest message", senderAuthFailure("mx.resend.com; spf=pass smtp.mailfrom=dmarc=fail@elryx.com; dkim=pass header.d=elryx.com; dmarc=pass"), "");
eq("the ARC header map value still refuses on its dmarc=fail", senderAuthFailure("i=1; mx.resend.com; dmarc=fail"), "i=1; mx.resend.com; dmarc=fail");
eq("a missing header passes (filing only)", [senderAuthFailure(""), senderAuthFailure(null), senderAuthFailure("mx.resend.com; none")], ["", "", ""]);
eq("the returned text is lowercased", senderAuthFailure("MX; DMARC=FAIL"), "mx; dmarc=fail");

// The third argument: authserv-ids whose verdict counts. A header written by
// anyone else, or by nobody (no authserv-id at all), is a no when the list is
// set; with the list empty nothing changes, and the top-most-header rule in
// email-inbound carries the protection alone.
const RESEND_AR = "mx.resend.com; dkim=pass header.d=elryx.com; spf=pass smtp.mailfrom=elryx.com; dmarc=pass";
ok("trusted list, matching authserv-id: yes", senderPositivelyAuthenticated(RESEND_AR, FROM, ["mx.resend.com"]));
ok("trusted list, another authserv-id: no, whatever the verdict", !senderPositivelyAuthenticated("mail.attacker.example; dmarc=pass", FROM, ["mx.resend.com"]));
ok("trusted list, no authserv-id at all: no", !senderPositivelyAuthenticated("dmarc=pass", FROM, ["mx.resend.com"]));
ok("trusted list, a version after the id is stripped", senderPositivelyAuthenticated("mx.resend.com 1; dmarc=pass", FROM, ["mx.resend.com"]));
ok("trusted list, case and whitespace in the list do not matter", senderPositivelyAuthenticated("MX.Resend.com; dmarc=pass", FROM, [" Mx.Resend.COM "]));
ok("trusted list, several ids, any one matches", senderPositivelyAuthenticated("inbound.example.net; dmarc=pass", FROM, ["mx.resend.com", "inbound.example.net"]));
ok("trusted list, a prefix of a trusted id is not it", !senderPositivelyAuthenticated("mx.resend.com.attacker.example; dmarc=pass", FROM, ["mx.resend.com"]));
ok("trusted list, a matching id still needs a passing verdict", !senderPositivelyAuthenticated("mx.resend.com; spf=none; dkim=none; dmarc=none", FROM, ["mx.resend.com"]));
ok("empty list: a bare dmarc=pass still counts (unchanged rule)", senderPositivelyAuthenticated("dmarc=pass", FROM, []));
ok("null list: unchanged rule", senderPositivelyAuthenticated("dmarc=pass", FROM, null));
ok("a list of blanks is an empty list", senderPositivelyAuthenticated("dmarc=pass", FROM, ["", "  "]));
ok("a Set is accepted as the list", senderPositivelyAuthenticated(RESEND_AR, FROM, new Set(["mx.resend.com"])));
eq("authservId reads the token before the first semicolon", authservId("mx.resend.com; dkim=pass"), "mx.resend.com");
eq("authservId drops a version token", authservId("mx.resend.com 1; dkim=pass"), "mx.resend.com");
eq("authservId drops a slash version", authservId("mx.resend.com/1; dkim=pass"), "mx.resend.com");
eq("authservId lowercases", authservId("MX.Resend.COM; dkim=pass"), "mx.resend.com");
eq("authservId on nothing is empty", authservId(""), "");
eq("authservId on null is empty", authservId(null), "");

// ── topAuthenticationResults: the header the MTA wrote, not the sender ──────
// Resend's header map collapses duplicate headers to one value and does not
// say which; the raw message keeps them in order and the receiving MTA's
// own line is prepended above anything the sender typed in.
const RAW_TWO = "Received: from mail.elryx.com by mx.resend.com\r\n"
  + "Authentication-Results: mx.resend.com; dmarc=fail header.from=elryx.com\r\n"
  + "From: Eric <stormchaser@elryx.com>\r\n"
  + "Authentication-Results: mx.resend.com; dmarc=pass header.from=elryx.com\r\n"
  + "Subject: Fwd: docs\r\n"
  + "\r\n"
  + "Authentication-Results: mx.resend.com; dmarc=pass\r\nbody text\r\n";
eq("the top-most header wins over one inserted lower", topAuthenticationResults(RAW_TWO), "mx.resend.com; dmarc=fail header.from=elryx.com");
eq("a folded value is unfolded onto one line",
  topAuthenticationResults("Authentication-Results: mx.resend.com;\r\n\tdkim=pass header.d=elryx.com;\r\n  spf=pass smtp.mailfrom=elryx.com\r\nFrom: x@y.z\r\n\r\nbody"),
  "mx.resend.com; dkim=pass header.d=elryx.com; spf=pass smtp.mailfrom=elryx.com");
eq("LF line endings read the same as CRLF",
  topAuthenticationResults("Received: x\nAuthentication-Results: mx.resend.com; dmarc=pass\nFrom: a@b.co\n\nbody"), "mx.resend.com; dmarc=pass");
eq("CRLF line endings", topAuthenticationResults("Authentication-Results: mx.resend.com; spf=pass\r\n\r\nbody"), "mx.resend.com; spf=pass");
eq("no header in the block is null", topAuthenticationResults("Received: x\r\nFrom: a@b.co\r\n\r\nbody"), null);
eq("a header only in the body is not read (past the first blank line)",
  topAuthenticationResults("From: a@b.co\r\n\r\nAuthentication-Results: mx.resend.com; dmarc=pass\r\n"), null);
eq("empty raw is null", topAuthenticationResults(""), null);
eq("null raw is null", topAuthenticationResults(null), null);
eq("undefined raw is null", topAuthenticationResults(undefined), null);
eq("a non-string raw (Resend's { download_url } object) is null", topAuthenticationResults({ download_url: "https://x" }), null);
eq("the header name is matched in any case", topAuthenticationResults("AUTHENTICATION-RESULTS: mx.resend.com; dmarc=pass\r\n\r\n"), "mx.resend.com; dmarc=pass");
eq("ARC-Authentication-Results is not Authentication-Results",
  topAuthenticationResults("ARC-Authentication-Results: i=1; mx.resend.com; dmarc=pass\r\nFrom: a@b.co\r\n\r\n"), null);
eq("a message with headers only (no blank line) is still read", topAuthenticationResults("Authentication-Results: mx.resend.com; dmarc=pass\r\nFrom: a@b.co"), "mx.resend.com; dmarc=pass");
eq("an empty value is null rather than empty", topAuthenticationResults("Authentication-Results:\r\nFrom: a@b.co\r\n\r\n"), null);
eq("a header whose name merely starts with the words is not it",
  topAuthenticationResults("Authentication-Results-Original: mx.resend.com; dmarc=pass\r\n\r\n"), null);
// The two pieces together: what email-inbound does with a raw message.
ok("raw top-most fail beats a pass the sender inserted lower", !senderPositivelyAuthenticated(topAuthenticationResults(RAW_TWO), FROM));
ok("raw top-most pass from the trusted MTA authenticates",
  senderPositivelyAuthenticated(topAuthenticationResults("Authentication-Results: mx.resend.com; dmarc=pass\r\n\r\n"), FROM, ["mx.resend.com"]));
ok("raw with no header is not authenticated (null is a no)", !senderPositivelyAuthenticated(topAuthenticationResults("From: a@b.co\r\n\r\n"), FROM));

// ── authEvidence: the header map refuses, the raw header authorises ─────────
// email-inbound used to hand the ack the header map whenever raw was absent
// or unreadable (an expired signed URL, a 4xx, a response without the
// field), which put the forgeable value back on the one path it had been
// removed from. Now the two readings never meet: `positive` is the raw
// top-most header or null, `negative` is the map.
const MAP_PASS = { "Authentication-Results": "mx.resend.com; dmarc=pass header.from=elryx.com" };
{
  const ev = authEvidence(null, MAP_PASS);
  eq("raw unavailable: positive is null, the map sits on the negative side only", ev, { positive: null, negative: "mx.resend.com; dmarc=pass header.from=elryx.com" });
  const authOk = ev.positive !== null && senderPositivelyAuthenticated(ev.positive, FROM);
  ok("raw unavailable: the ack is refused even though the header map says dmarc=pass",
    authOk === false && ackAllowed({ ...good, senderAuthenticated: authOk }).ok === false);
  eq("raw undefined is unavailable too", authEvidence(undefined, MAP_PASS).positive, null);
  eq("raw empty is unavailable too (an empty file was not read)", authEvidence("", MAP_PASS).positive, null);
  eq("a raw message with no header is read as '' (a no for the ack, a pass for filing), whatever the map says",
    authEvidence("From: a@b.co\r\n\r\nbody", MAP_PASS).positive, "");
  eq("a raw message's top-most header is the positive side", authEvidence(RAW_TWO, MAP_PASS).positive, "mx.resend.com; dmarc=fail header.from=elryx.com");
  ok("the raw top-most header authorises on its own, with an empty map", (() => {
    const e = authEvidence("Authentication-Results: mx.resend.com; dmarc=pass\r\nFrom: a@b.co\r\n\r\n", {});
    return e.positive !== null && senderPositivelyAuthenticated(e.positive, FROM) && e.negative === "";
  })());
  eq("the map's ARC header is the negative side when the plain one is absent",
    authEvidence(null, { "ARC-Authentication-Results": "i=1; mx.resend.com; dmarc=fail" }).negative, "i=1; mx.resend.com; dmarc=fail");
  eq("the plain map header wins over ARC on the negative side",
    authEvidence(null, { "arc-authentication-results": "i=1; x; dmarc=fail", "authentication-results": "mx; dmarc=pass" }).negative, "mx; dmarc=pass");
  eq("header names are matched in any case", authEvidence(null, { "AUTHENTICATION-RESULTS": "mx; spf=pass" }).negative, "mx; spf=pass");
  eq("no headers at all is an empty negative side", authEvidence(null, null).negative, "");
  eq("a null header value is an empty string, not 'null'", authEvidence(null, { "authentication-results": null }).negative, "");
}

// ── physicianSummaryText: what the physician reads ───────────────────────────
const proposal2 = {
  v: 1, method: "rules",
  items: [
    { ask: "MPLT COI", kind: "coi_malpractice", status: "found", docIds: ["d1"], labels: ["Professional Liability COI, ProAssurance Specialty Insurance"] },
    { ask: "MMR dose #2", kind: "mmr", status: "found", docIds: ["d2", "d3"], labels: ["MMR (Measles, Mumps, Rubella) vaccination", "MMR (Measles, Mumps, Rubella) vaccination"] },
    { ask: "TB form", kind: "tb", status: "missing", docIds: [], labels: [] },
    { ask: "Logs 12-months", kind: "case_logs", status: "report", docIds: [], labels: [] },
  ],
  docIds: ["d1", "d2", "d3"], missing: ["TB form", "Logs 12-months"], coverNote: "Hello Tara,",
};
const sum2 = physicianSummaryText({ requesterName: "Tara Domalewski", requesterAddr: "tara@mychg.com", requesterFound: true, proposal: proposal2, appUrl: "https://credentialdomd.com/app/" });
eq("the summary, four asks", sum2,
  "Got it. Tara Domalewski asked for 4 items:\n"
  + "- MPLT COI: Professional Liability COI, ProAssurance Specialty Insurance\n"
  + "- MMR dose #2: MMR (Measles, Mumps, Rubella) vaccination, MMR (Measles, Mumps, Rubella) vaccination\n"
  + "- TB form: not on file\n"
  + "- Logs 12-months: follows separately (the app exports it)\n"
  + "\n"
  + "Packet ready: 3 documents. Open the app and tap Approve and send.\n"
  + "https://credentialdomd.com/app/#requests (opens your requests)");
const proposal1 = { v: 1, method: "rules", items: [{ ask: "board certificate", kind: "board_cert", status: "found", docIds: ["d9"], labels: ["Board Certification (AOA)"] }], docIds: ["d9"], missing: [], coverNote: "x" };
const sum1 = physicianSummaryText({ requesterName: "Madeline Castorena", requesterAddr: "m@ruhealth.org", requesterFound: true, proposal: proposal1, appUrl: "https://credentialdomd.com/app/" });
ok("one ask is singular", sum1.startsWith("Got it. Madeline Castorena asked for 1 item:\n- board certificate: Board Certification (AOA)"));
ok("one document is singular", sum1.includes("Packet ready: 1 document. Open the app and tap Approve and send."));
ok("no name falls back to the address", physicianSummaryText({ requesterName: null, requesterAddr: "m@ruhealth.org", requesterFound: true, proposal: proposal1, appUrl: "u" }).startsWith("Got it. m@ruhealth.org asked for"));
const notFound = physicianSummaryText({ requesterName: null, requesterAddr: "stormchaser@elryx.com", requesterFound: false, proposal: proposal1, appUrl: "u" });
ok("requester not found: the physician's own address is not named as the asker", !notFound.includes("stormchaser@elryx.com asked"));
// The control named is the one on the screen: the request's detail view
// carries a "Requester's email" field above the send button. An earlier
// wording said "tap Review", and that screen has no Review.
ok("requester not found: says so and names the one control that works", notFound.includes("was not found in the forwarded text") && notFound.includes("enter their address under Requester's email and send"));
ok("requester not found: never 'tap Review' (that screen has no Review)", !notFound.includes("Review"));
ok("requester not found: does not tell the physician to tap a button the app has disabled", !notFound.includes("tap Approve and send") && !notFound.includes("before approving"));
ok("requester not found: the packet count is still there, without the not-found clause repeated", notFound.includes("\nPacket ready: 1 document. Open the request, enter their address under Requester's email and send.\n"));
// "The forwarded email asks for 1 item" made an email the asker, the shape
// the no-items branch was rewritten out of; the opening says what came in
// and, in the same breath, what was missing from it.
ok("requester not found: opens with the request, not 'The forwarded email asks'",
  notFound.startsWith("Got it. A document request came in for 1 item (the requester's address was not found in the forwarded text):\n- board certificate: Board Certification (AOA)\n") && !notFound.includes("forwarded email"));
ok("requester not found: said once, not twice", notFound.split("was not found in the forwarded text").length === 2);
const notFoundEmpty = physicianSummaryText({ requesterName: null, requesterAddr: "stormchaser@elryx.com", requesterFound: false, proposal: { ...proposal1, items: [{ ...proposal1.items[0], status: "missing", docIds: [], labels: [] }], docIds: [] }, appUrl: "u" });
ok("requester not found, nothing on file: the not-found fact is in the opening, not repeated on the next step",
  notFoundEmpty.includes("came in for 1 item (the requester's address was not found in the forwarded text):") && !notFoundEmpty.includes("Packet ready")
  && notFoundEmpty.split("was not found in the forwarded text").length === 2);
// Both nothing-on-file variants name the button that is live once the
// address is typed, "Send reply (nothing to attach)", by its first words.
ok("requester not found, nothing on file: names the field and the button", notFoundEmpty.includes("Nothing on file to attach yet. Open the request, enter their address under Requester's email and tap Send reply.") && !notFoundEmpty.includes("Review"));
const notFoundNoProposal = physicianSummaryText({ requesterName: null, requesterAddr: "stormchaser@elryx.com", requesterFound: false, proposal: null, appUrl: "u" });
ok("requester not found, no proposal: the not-found note still appears", notFoundNoProposal.includes("was not found in the forwarded text") && notFoundNoProposal.includes("under Requester's email") && !notFoundNoProposal.includes("Review"));
// Nobody to name and nothing to list. "The forwarded email sent a document
// request" read as if an email were a person.
ok("requester not found, no proposal: opens with what happened and what was missing",
  notFoundNoProposal.startsWith("Got it. A document request came in, but the requester's address was not found in the forwarded text.\n\n"));
ok("requester not found, no proposal: never 'The forwarded email sent'", !notFoundNoProposal.includes("The forwarded email sent") && !notFoundNoProposal.includes("forwarded email"));
ok("requester not found, no proposal: said once", notFoundNoProposal.split("was not found in the forwarded text").length === 2);
ok("requester not found, no proposal: says the packet could not be prepared", notFoundNoProposal.includes("could not be prepared automatically"));
const notFoundNoItems = physicianSummaryText({ requesterName: null, requesterAddr: "stormchaser@elryx.com", requesterFound: false, proposal: { ...proposal1, items: [], docIds: [] }, appUrl: "u" });
ok("requester not found, no items: the same opening", notFoundNoItems.startsWith("Got it. A document request came in, but the requester's address was not found in the forwarded text."));
ok("requester not found, no items: says no list could be read and names the next step", notFoundNoItems.includes("No list of documents could be read from it") && notFoundNoItems.includes("enter their address under Requester's email") && !notFoundNoItems.includes("Review"));
ok("requester not found, no items: said once", notFoundNoItems.split("was not found in the forwarded text").length === 2);
ok("requester found, no proposal: still names the asker", physicianSummaryText({ requesterName: "Tara", requesterAddr: "t@x.org", requesterFound: true, proposal: null, appUrl: "u" }).startsWith("Got it. Tara sent a document request."));
ok("requester found, no items: still names the asker and the missing list",
  physicianSummaryText({ requesterName: "Tara", requesterAddr: "t@x.org", requesterFound: true, proposal: { ...proposal1, items: [], docIds: [] }, appUrl: "u" }).startsWith("Got it. Tara sent a document request, but no list of documents could be read from it."));
const unclearSummary = physicianSummaryText({ requesterName: "Tara", requesterAddr: "t@x.org", requesterFound: true, proposal: { ...proposal2, items: [...proposal2.items, { ask: "attestation form", kind: "unknown", status: "missing", docIds: [], labels: [] }] }, appUrl: "u" });
ok("an ask the rules could not name is 'not recognised', not 'not on file'", unclearSummary.includes("- attestation form: not recognised, nothing attached") && unclearSummary.includes("- TB form: not on file"));
ok("null proposal: the request is still announced and the fallback is the old path",
  physicianSummaryText({ requesterName: "Tara", requesterAddr: "t@x.org", requesterFound: true, proposal: null, appUrl: "u" })
    .includes("The packet could not be prepared automatically; open the request to choose the documents."));
const nothing = physicianSummaryText({ requesterName: "Tara", requesterAddr: "t@x.org", requesterFound: true, proposal: { ...proposal2, items: proposal2.items.slice(2), docIds: [] }, appUrl: "u" });
ok("nothing found: does not say 'Packet ready: 0 documents'", !nothing.includes("Packet ready") && nothing.includes("Nothing on file to attach yet"));
// The button on the list card and on Home reads "Send reply (nothing to
// attach)"; "reply from the request" sent the physician into the card to
// find a button that was already on the list, one tap become three.
ok("nothing found: names the button that is on the card and on Home", nothing.includes("Nothing on file to attach yet. Open the app and tap Send reply.\n") && !nothing.includes("reply from the request"));
// The link opens the requests list itself (#requests); "(Home, or More >
// Requests)" described two routes and a physician on a phone followed neither.
ok("the app link is always there, with the #requests fragment, and it is the last line",
  [sum1, sum2, notFound, nothing].every((s) => s.endsWith("https://credentialdomd.com/app/#requests (opens your requests)") || s.includes("u#requests (opens your requests)")));
ok("the summary ends on the link when the requester was found", sum1.endsWith("#requests (opens your requests)") && sum2.endsWith("#requests (opens your requests)"));
ok("the old two-route hint is gone", ![sum1, sum2, notFound, notFoundNoProposal, notFoundNoItems, nothing].some((s) => s.includes("(Home, or More > Requests)")));
noEmDash("summary", sum2 + notFound + nothing);

// ── approveRequestBody: the one-tap call's shape ─────────────────────────────
const RID = "4de7181c-3a38-4fc1-a1e2-ff62d8005b8d";
eq("the minimal approve body", approveRequestBody({ request_id: RID, approve: true }),
  { ok: true, requestId: RID, ccSelf: true, subjectOverride: null, textOverride: null, docIds: null });
eq("cc_self false is honoured", approveRequestBody({ request_id: RID, approve: true, cc_self: false }).ccSelf, false);
eq("cc_self anything-but-false stays on", approveRequestBody({ request_id: RID, approve: true, cc_self: "no" }).ccSelf, true);
eq("overrides pass through trimmed", approveRequestBody({ request_id: RID, approve: true, subject: "  Re: docs ", text: "Hi\r\nthere\r\n" }),
  { ok: true, requestId: RID, ccSelf: true, subjectOverride: "Re: docs", textOverride: "Hi\nthere", docIds: null });
// The screen's packet travels with the tap: doc_ids are what was ticked,
// text is the note as it read in the box, an emptied box included.
const D1 = "11111111-1111-4111-8111-111111111111", D2 = "22222222-2222-4222-8222-222222222222";
eq("doc_ids pass through, deduplicated, in order", approveRequestBody({ request_id: RID, approve: true, doc_ids: [D2, D1, D2] }).docIds, [D2, D1]);
eq("an emptied note is an empty override, not 'no override'", approveRequestBody({ request_id: RID, approve: true, text: "" }).textOverride, "");
eq("a blank note is an empty override too", approveRequestBody({ request_id: RID, approve: true, text: "  \n " }).textOverride, "");
eq("an absent note is no override", approveRequestBody({ request_id: RID, approve: true }).textOverride, null);
eq("a null note is no override", approveRequestBody({ request_id: RID, approve: true, text: null }).textOverride, null);
// An empty list is a text-only reply (every ask "not on file"), not an
// error; refusing it broke the one button on exactly those requests.
// send-packet-email decides whether an empty list may go.
eq("an empty doc_ids list is an empty list, not a refusal and not 'absent'", approveRequestBody({ request_id: RID, approve: true, doc_ids: [] }).docIds, []);
ok("an empty doc_ids list is ok", approveRequestBody({ request_id: RID, approve: true, doc_ids: [] }).ok === true);
ok("an empty doc_ids with an empty note is the text-only shape the app sends", (() => {
  const v = approveRequestBody({ request_id: RID, approve: true, cc_self: true, doc_ids: [], text: "Hello Tara,\n\nNone of these are on file yet." });
  return v.ok && v.docIds.length === 0 && v.textOverride === "Hello Tara,\n\nNone of these are on file yet." && v.ccSelf === true;
})());
ok("a non-array doc_ids is refused", approveRequestBody({ request_id: RID, approve: true, doc_ids: D1 }).ok === false);
ok("a bad id inside doc_ids is refused", /invalid id/.test(approveRequestBody({ request_id: RID, approve: true, doc_ids: [D1, "nope"] }).error));
eq("absent doc_ids is null (an older client; the stored proposal stands in)", approveRequestBody({ request_id: RID, approve: true, doc_ids: null }).docIds, null);
ok("approve missing is refused", approveRequestBody({ request_id: RID }).ok === false);
ok("approve: 'true' (a string) is refused", approveRequestBody({ request_id: RID, approve: "true" }).ok === false);
ok("a bad request_id is refused", /valid id/.test(approveRequestBody({ request_id: "nope", approve: true }).error));
ok("a missing request_id is refused", approveRequestBody({ approve: true }).ok === false);
ok("a subject with a line break is refused (header injection)", /line break/.test(approveRequestBody({ request_id: RID, approve: true, subject: "Re: docs\nBcc: x@y.z" }).error));
ok("an over-long subject is refused", /limited/.test(approveRequestBody({ request_id: RID, approve: true, subject: "s".repeat(MAX_APPROVE_SUBJECT + 1) }).error));
ok("a subject at the cap passes", approveRequestBody({ request_id: RID, approve: true, subject: "s".repeat(MAX_APPROVE_SUBJECT) }).ok);
ok("an over-long text is refused", /limited/.test(approveRequestBody({ request_id: RID, approve: true, text: "t".repeat(MAX_APPROVE_TEXT + 1) }).error));
ok("a non-string subject is refused", approveRequestBody({ request_id: RID, approve: true, subject: 42 }).ok === false);
ok("a non-string text is refused", approveRequestBody({ request_id: RID, approve: true, text: ["a"] }).ok === false);
ok("an empty subject string means no override", approveRequestBody({ request_id: RID, approve: true, subject: "" }).subjectOverride === null);
ok("null body is refused", approveRequestBody(null).ok === false);
ok("an array body is refused", approveRequestBody([RID]).ok === false);

// ── House rules ──────────────────────────────────────────────────────────────
{
  const all = [ack, sum1, sum2, notFound, notFoundEmpty, notFoundNoProposal, notFoundNoItems, unclearSummary, nothing, replySubject("RE: x")]
    .concat(["x", "nope"].map((id) => approveRequestBody({ request_id: id, approve: true }).error))
    .concat(Object.values({
      a: ackAllowed({ ...good, requesterFound: false }).why, b: ackAllowed({ ...good, ackRequests: false }).why,
      c: ackAllowed({ ...good, senderAuthenticated: false }).why, d: ackAllowed({ ...good, requesterAddr: good.forwarderAddr }).why,
    }))
    .join("\n");
  ok("no em dash in anything this module says", !all.includes("\u2014"));
  ok("no compliance claims in anything this module says", !/HIPAA|SOC ?2|bank-level|military-grade/i.test(all));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
