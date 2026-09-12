/**
 * The decisions and the texts of the automated request flow, away from I/O.
 *
 * A credentialer emails the physician a list of documents; the physician
 * forwards it to docs@ and that is the last thing they type. email-inbound
 * builds the packet proposal (the matcher in requestPacket.ts), writes it on
 * the document_requests row, tells the physician what was found, and
 * acknowledges the REQUESTER from docs@ on the physician's behalf. The app
 * then shows one button, "Approve and send", and send-packet-email turns the
 * stored proposal into the reply.
 *
 * Everything in this file is a rule or a sentence, not a fetch, so
 * scripts/request-flow.test.mjs runs it under plain node (Node 22.18+ strips
 * the type annotations on import). The rules that matter most are the ack
 * refusals: that acknowledgement is mail sent to a third party from our
 * domain with the physician's name on it, and every way it could go to the
 * wrong place is a reason it is not sent.
 *
 * The evidence those refusals read is also decided here. Resend hands the
 * function a header map in which duplicate headers collapse to one value,
 * and which occurrence wins is undocumented; a sender who writes their own
 * Authentication-Results line into a message could be the one that
 * survives. topAuthenticationResults reads the raw RFC 5322 message
 * instead and returns the top-most header, which is the one the receiving
 * MTA prepended above anything the sender wrote. senderPositivelyAuthenticated
 * can additionally insist that the header was written by an authserv-id the
 * operator trusts (INBOUND_AUTHSERV_IDS in email-inbound). authEvidence keeps
 * that raw reading apart from the header map, so the map can refuse a
 * forward and never authorise one. Both readers take their verdicts from
 * authVerdicts, which reads the method=result token that opens each clause
 * and nothing after it: the MTA copies sender-chosen identifiers in beside
 * its verdicts, and a substring test once found "dmarc=pass" inside one.
 *
 * Pure by design: no Deno, no Supabase, no imports.
 */

export interface ProposalItem {
  ask: string;
  kind: string;
  status: "found" | "missing" | "report" | string;
  docIds: string[];
  labels: string[];
}

export interface Proposal {
  v: number;
  method: string;
  items: ProposalItem[];
  docIds: string[];
  missing: string[];
  coverNote: string;
}

export interface AckInput {
  requesterAddr: string | null | undefined;   // the parsed From: of the original request
  requesterName?: string | null;              // carried for the caller; no rule reads it yet
  forwarderAddr: string | null | undefined;   // who forwarded the mail to docs@
  physicianEmail: string | null | undefined;  // the address the ack's reply_to points at
  ownAddresses?: Iterable<string> | null;     // every confirmed forwarding address of this physician
  requesterFound: boolean;                    // parseForwarded located a From: line
  ackRequests: boolean | null | undefined;    // profiles.ack_requests; only an explicit false turns it off
  senderAuthenticated: boolean;               // senderPositivelyAuthenticated on the forward; only true is a yes
}

export interface AckDecision {
  ok: boolean;
  why: string;   // "" when ok; otherwise the reason, ready for the ledger detail
}

const EMAIL_SHAPE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;
const OUR_DOMAIN = "credentialdomd.com";
// Local parts that belong to machines. Mail to them bounces or lands in a
// queue nobody reads, and a bounce of an ack is one more email to the
// physician about nothing.
const MACHINE_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)/i;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function norm(addr: string | null | undefined): string {
  return String(addr ?? "").trim().toLowerCase();
}

function localPart(addr: string): string {
  const i = addr.indexOf("@");
  return i > 0 ? addr.slice(0, i) : addr;
}

function domainPart(addr: string): string {
  const i = addr.indexOf("@");
  return i > 0 ? addr.slice(i + 1) : "";
}

// The same two lists the matcher's cover note uses (requestPacket.ts). A
// name that carries one of these words is an office, not a person, and an
// office is greeted "there"; an earlier version here split on spaces only and
// opened the acknowledgement with "Hello Medical," to Medical Staff Services.
const ORG_WORD_RE = /\b(?:office|department|dept|credentialing|credentials|team|services|staff|hospital|health|medical|center|centre|group|clinic|system|university|llc|inc|corp|hr|admin|administration|support|noreply|no-reply|privileging|enrollment|verification|onboarding)\b/i;
const HONORIFIC_RE = /^(?:dr|doctor|mr|mrs|ms|miss|mx|prof|rn|md|do|np|pa|cpcs|cpmsm|mba|phd|jr|sr|ii|iii)\.?,?$/i;

/**
 * "Madeline Castorena" -> "Madeline"; "Castorena, Madeline" -> "Madeline";
 * "Dr. Jane Smith" -> "Jane"; "Medical Staff Services" -> "there"; "" ->
 * "there". Signature stars and quotes that Outlook leaves around a name are
 * stripped first. The rule is the cover note's rule, word for word, so the
 * two emails a requester reads greet them the same way.
 */
export function firstName(name: string | null | undefined): string {
  let s = String(name ?? "").replace(/["'`*_()<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.includes("@") || ORG_WORD_RE.test(s)) return "there";
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // "Castorena, Madeline" is surname first; "Tara Domalewski, CPCS" is a
    // name with credentials after it.
    s = parts[0].split(" ").length === 1 && !HONORIFIC_RE.test(parts[1].split(" ")[0]) ? `${parts[1]} ${parts[0]}` : parts[0];
  }
  const words = s.split(" ").filter((w) => !HONORIFIC_RE.test(w));
  const w = words[0] || "";
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(w) || w.length < 2) return "there";
  return w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w;
}

const RE_FWD_PREFIX = /^\s*(?:(?:re|fwd?|fw|tr|wg|vs|aw)\s*:\s*)+/i;
export const MAX_REPLY_SUBJECT = 150;

/**
 * "Re: Requested docs" from "RE: Requested docs", "Fwd: Re: Requested docs"
 * or nothing at all. One "Re:", whatever the stored subject starts with: the
 * requester's own subject was "RE: Requested docs" and both emails they got
 * back were titled "Re: RE: Requested docs".
 */
export function replySubject(subject: string | null | undefined, fallback = "your document request"): string {
  const base = String(subject ?? "").replace(RE_FWD_PREFIX, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `Re: ${(base || fallback).slice(0, MAX_REPLY_SUBJECT)}`;
}

/**
 * The top-most Authentication-Results header of a raw RFC 5322 message, or
 * null when the message carries none (or `raw` is not a non-empty string).
 *
 * The header block is everything before the first blank line, CRLF or LF;
 * continuation lines (starting with a space or a tab) are unfolded onto the
 * line above. Top-most wins because a receiving MTA prepends its own
 * Authentication-Results above whatever arrived, so a line the sender put in
 * the message sits below it. The collapsed header map Resend also returns
 * cannot tell the two apart, which is why email-inbound reads this first.
 * An "Authentication-Results:" that appears in the body (a pasted header, a
 * forwarded message) is past the blank line and never read.
 */
export function topAuthenticationResults(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const text = raw.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  const end = text.indexOf("\n\n");
  const block = end >= 0 ? text.slice(0, end) : text;
  const unfolded: string[] = [];
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  for (const line of unfolded) {
    const m = line.match(/^authentication-results\s*:\s*(.*)$/i);
    if (m) {
      const v = m[1].replace(/\s+/g, " ").trim();
      return v || null;
    }
  }
  return null;
}

export interface AuthEvidence {
  // The raw message's top-most Authentication-Results: "" when the message
  // carries none, null when the raw message was never read. The ONLY input
  // the acknowledgement may trust.
  positive: string | null;
  // Resend's collapsed header map (Authentication-Results, then
  // ARC-Authentication-Results). Enough to refuse an explicit failure, since
  // a sender gains nothing by forging one; never enough to authorise mail to
  // a third party.
  negative: string;
}

/**
 * The two pieces of authentication evidence email-inbound holds, kept apart.
 *
 * They used to be one string: the raw top-most header when raw could be
 * read, the header map otherwise. That fallback re-opened the hole the raw
 * read exists to close. Resend's header map collapses duplicate headers and
 * does not say which survives, so a sender who typed "Authentication-Results:
 * mx.resend.com; dmarc=pass" into a forged forward could be the one that was
 * read; and raw is unreadable on every transient failure (an expired signed
 * URL, a 4xx, a dropped connection) and simply absent when the API omits the
 * field, which made that path the ordinary one, not the exception. Here the
 * header map never reaches `positive`: when raw was not read, positive is
 * null and the caller acknowledges nobody. `negative` still carries the map,
 * ARC included, so a dmarc=fail recorded there refuses the filing as it did
 * before the raw read existed. `raw` counts as read only when it is a
 * non-empty string.
 */
export function authEvidence(raw: string | null | undefined, headers: Record<string, string> | null | undefined): AuthEvidence {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = String(v ?? "");
  return {
    positive: typeof raw === "string" && raw ? (topAuthenticationResults(raw) ?? "") : null,
    negative: h["authentication-results"] || h["arc-authentication-results"] || "",
  };
}

/**
 * "mx.resend.com 1; dkim=pass ..." -> "mx.resend.com". The authserv-id is the
 * token before the first semicolon (RFC 8601), lowercased, with the optional
 * version that follows it dropped. "" when the value has no such token.
 */
export function authservId(authResults: string | null | undefined): string {
  const head = String(authResults ?? "").split(";")[0].trim().toLowerCase();
  if (!head) return "";
  return head.split(/\s+/)[0].replace(/\/\d+$/, "");
}

export interface AuthVerdict {
  method: string;   // "dmarc", "spf", "dkim", ...
  result: string;   // "pass", "fail", "none", "softfail", ...
  clause: string;   // the whole clause, lowercased, comments dropped, whitespace collapsed
}

/**
 * The clauses of an Authentication-Results value: split on ";" outside
 * quoted strings, with comments (parentheses) dropped. RFC 8601 allows a
 * comment anywhere and a quoted reason="...", and either may carry a
 * semicolon or text shaped like a verdict, so a plain split read what was
 * inside them as clauses of their own.
 */
function resinfoClauses(value: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false, depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) { cur += value[++i]; continue; }
      if (c === "\"") quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "(") { depth++; cur += " "; continue; }
    if (c === "\"") { quoted = true; cur += c; continue; }
    if (c === ";") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

/**
 * The verdicts of an Authentication-Results value, one per clause.
 *
 * RFC 8601 lays the header out as an authserv-id, then clauses separated by
 * semicolons, each opening with method=result and continuing with what the
 * MTA saw: smtp.mailfrom=<envelope sender>, smtp.helo=<EHLO name>,
 * header.i=<DKIM i= tag>. Those are sender-chosen text the MTA copies in
 * beside its verdict, and each accepts "=" in the sender's part, so a
 * genuine header from the trusted MTA can read "spf=pass
 * smtp.mailfrom=dmarc=pass@attacker.example; dmarc=none". A substring test
 * over the whole value found "dmarc=pass" in exactly that and let docs@
 * acknowledge an address the message chose, under the physician's name, on
 * a header whose DMARC verdict was none. Only the token that opens a clause
 * is a verdict here; the rest of the clause travels as `clause` for the one
 * caller that needs a property (the DKIM signing domain), and it reads that
 * from the clause whose verdict it holds, with clauseProps.
 *
 * The first clause is the authserv-id and carries no verdict unless it is
 * itself a method=result token: a value with no authserv-id ("dmarc=pass")
 * is read from its first clause, and authservId() already refuses such a
 * value when the operator pinned the MTA. An ARC header's "i=1" lead-in
 * reads as a verdict for method "i", which nothing asks about.
 */
export function authVerdicts(authResults: string | null | undefined): AuthVerdict[] {
  const out: AuthVerdict[] = [];
  for (const clause of resinfoClauses(String(authResults ?? "").toLowerCase())) {
    const m = clause.match(/^([a-z][a-z0-9_-]*)(?: ?\/ ?\d+)? ?= ?([a-z0-9_-]+)(?= |$)/);
    if (m) out.push({ method: m[1], result: m[2], clause });
  }
  return out;
}

/**
 * The name=value properties of one clause, the verdict included, each value
 * running to the next space (or to the closing quote of a quoted value).
 * "header.i=header.d=hospital.org@attacker.example" is ONE property, header.i,
 * whose value happens to contain "header.d=": a search for header.d= across
 * the clause text would have read the sender's DKIM i= tag as the signing
 * domain.
 */
function clauseProps(clause: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const re = /(?:^| )([a-z][a-z0-9._-]*) ?= ?("(?:[^"\\]|\\.)*"|[^ "]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause))) out.push({ name: m[1], value: m[2].replace(/^"|"$/g, "") });
  return out;
}

function domainsAlign(fromDomain: string, signing: string): boolean {
  const d = signing.replace(/\.$/, "");
  if (!d || !/^[a-z0-9.-]+$/.test(d)) return false;
  return fromDomain === d || fromDomain.endsWith(`.${d}`) || d.endsWith(`.${fromDomain}`);
}

/**
 * Positive authentication of the forwarder, for the one send that leaves our
 * domain with a third party's address on the To line. email-inbound's own
 * check (senderAuthFailure, below) refuses an explicit failure and passes a
 * missing header; that is enough to file a certificate into the sender's
 * own account, and not enough to let docs@ write to an address taken from
 * the forwarded text under the physician's name. Here dmarc=pass counts, or
 * spf=pass together with a dkim=pass whose signing domain is the sender's;
 * anything less, including no Authentication-Results header at all, is a no.
 * Verdicts are the clause-opening tokens only (authVerdicts), and the
 * signing domain is the header.d= or header.i=@ property of the dkim=pass
 * clause itself, never text found elsewhere in the value.
 *
 * trustedAuthserv, when non-empty, names the authserv-ids whose verdicts
 * count (the receiving MTA's, from INBOUND_AUTHSERV_IDS). A header written
 * by anyone else, including one with no authserv-id at all, is then a no,
 * whatever it says. When the list is empty the check is unchanged: the
 * caller's top-most-header rule is the protection against a sender-written
 * line, and this list is the second lock for an operator who knows their MTA.
 */
export function senderPositivelyAuthenticated(
  authResults: string | null | undefined,
  fromAddr: string | null | undefined,
  trustedAuthserv?: Iterable<string> | null,
): boolean {
  const auth = String(authResults ?? "").toLowerCase();
  if (!auth) return false;
  const trusted = Array.from(trustedAuthserv ?? [], (s) => String(s ?? "").trim().toLowerCase()).filter(Boolean);
  if (trusted.length > 0 && !trusted.includes(authservId(auth))) return false;
  const verdicts = authVerdicts(auth);
  const has = (method: string, result: string) => verdicts.some((v) => v.method === method && v.result === result);
  if (has("dmarc", "fail")) return false;
  if (has("dmarc", "pass")) return true;
  if (!has("spf", "pass")) return false;
  const fromDomain = domainPart(norm(fromAddr));
  if (!fromDomain) return false;
  for (const v of verdicts) {
    if (v.method !== "dkim" || v.result !== "pass") continue;
    for (const p of clauseProps(v.clause)) {
      if (p.name === "header.d" && domainsAlign(fromDomain, p.value)) return true;
      if (p.name === "header.i" && p.value.startsWith("@") && domainsAlign(fromDomain, p.value.slice(1))) return true;
    }
  }
  return false;
}

/**
 * Sender authentication for FILING: the From header is trusted only when the
 * inbound path's Authentication-Results do not say it failed. A forged From
 * with dmarc=fail (or spf and dkim both failed) is dropped silently by
 * email-inbound: no upload, no reply. A missing header is treated as pass
 * (residual risk noted in docs/EMAIL-INBOUND.md). Takes one header value
 * (Resend's header map, or either side of authEvidence) and returns the
 * offending text, or "" when ok. Lives here rather than in email-inbound so
 * the test can run it: it once read "dkim=pass" out of
 * "spf=softfail smtp.mailfrom=dkim=pass@attacker.example; dkim=none" and let
 * the filing through.
 */
export function senderAuthFailure(authResults: string | null | undefined): string {
  const auth = String(authResults ?? "").toLowerCase();
  if (!auth) return "";
  const verdicts = authVerdicts(auth);
  const has = (method: string, ...results: string[]) => verdicts.some((v) => v.method === method && results.includes(v.result));
  const dmarcFail = has("dmarc", "fail");
  const spfFail = has("spf", "fail", "softfail");
  const dkimFail = has("dkim", "fail") || !has("dkim", "pass");
  return dmarcFail || (spfFail && dkimFail) ? auth : "";
}

/** "2026-09-11T17:03:12.000Z" -> "September 11, 2026" (UTC). Unparseable input -> "". */
export function longDate(iso: string | null | undefined): string {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * May docs@ acknowledge the requester on the physician's behalf?
 *
 * Each refusal names a way the ack would be wrong mail:
 *   requester not found    the From: was never parsed, so the address on the
 *                          row is the physician's own, and "your request was
 *                          received" would go back to them;
 *   acknowledgements off   profiles.ack_requests is false;
 *   not authenticated      the forward did not carry dmarc=pass or an
 *                          aligned spf+dkim pass: a From header alone is
 *                          not proof the physician sent it, and this send
 *                          goes to an address the message itself chose;
 *   our own domain         a forward of one of our replies, or a loop;
 *   the forwarder          the physician forwarded their own email;
 *   the physician          same, via the profile address;
 *   another own address    same, via any other confirmed forwarding
 *                          address (they mailed themselves the checklist
 *                          from the hospital account);
 *   a machine mailbox      no-reply@, postmaster@, bounce@: nobody reads it
 *                          and the bounce comes back to us.
 */
export function ackAllowed(input: AckInput): AckDecision {
  const requester = norm(input.requesterAddr);
  const forwarder = norm(input.forwarderAddr);
  const physician = norm(input.physicianEmail);
  if (!input.requesterFound) return { ok: false, why: "requester not found in the forwarded text" };
  if (input.ackRequests === false) return { ok: false, why: "acknowledgements are off for this account" };
  if (input.senderAuthenticated !== true) return { ok: false, why: "forward not positively authenticated (no dmarc=pass or aligned spf+dkim)" };
  if (!requester || !EMAIL_SHAPE.test(requester)) return { ok: false, why: "no requester address" };
  const domain = domainPart(requester);
  if (domain === OUR_DOMAIN || domain.endsWith(`.${OUR_DOMAIN}`)) return { ok: false, why: "requester is a credentialdomd.com address" };
  if (forwarder && requester === forwarder) return { ok: false, why: "requester is the forwarding address" };
  if (physician && requester === physician) return { ok: false, why: "requester is the physician's own address" };
  for (const a of input.ownAddresses ?? []) {
    if (norm(a) && requester === norm(a)) return { ok: false, why: "requester is one of the physician's confirmed addresses" };
  }
  if (MACHINE_LOCAL.test(localPart(requester))) return { ok: false, why: "requester is an automated mailbox" };
  return { ok: true, why: "" };
}

export interface AckTextInput {
  requesterName: string | null | undefined;
  physicianName: string | null | undefined;
  degree?: string | null;
  askCount?: number | null;
  receivedAtIso: string | null | undefined;
}

/**
 * The acknowledgement the requester reads. It promises nothing: not which
 * documents, not when, not that any will come at all, because the physician
 * has not approved anything yet and may never. An earlier wording said "the
 * documents will be sent from this address once approved", which a
 * credentialer read as a commitment and chased. It does say where any
 * documents would come from (this address) and that a reply reaches the
 * physician, because reply_to is set to them.
 */
export function ackText(input: AckTextInput): string {
  const physician = String(input.physicianName ?? "").replace(/\s+/g, " ").trim() || "the physician";
  const degree = String(input.degree ?? "").trim();
  const count = Number(input.askCount ?? 0);
  const what = count > 1 ? `your request for ${count} items` : "your request";
  const when = longDate(input.receivedAtIso);
  const received = when ? `was received on ${when}` : "was received";
  const signature = input.physicianName && String(input.physicianName).trim()
    ? `${physician}${degree ? `, ${degree}` : ""}`
    : "CredentialDOMD";
  return `Hello ${firstName(input.requesterName)},\n\n`
    + `This confirms that ${what} to ${physician} ${received}. `
    + `Any documents will come from this address; a reply to this email reaches ${physician} directly.\n\n`
    + `Regards,\n${signature}`;
}

export interface SummaryInput {
  requesterName: string | null | undefined;
  requesterAddr: string | null | undefined;
  requesterFound: boolean;
  proposal: Proposal | null | undefined;
  appUrl: string;
}

// The next step names the control that is on the screen: the request's
// detail view carries a "Requester's email" field above the send button when
// the forward had no From: line. An earlier wording said "tap Review", and
// that screen has no Review; a physician opening the request from this email
// looked for a control that was not there.
const NOT_FOUND_NOTE = "The requester's address was not found in the forwarded text, so the request is addressed to you for now. Open it, enter their address under Requester's email and send.";
const NO_PROPOSAL_NOTE = "The packet could not be prepared automatically; open the request to choose the documents.";
// The opening when nobody could be named as the asker AND there is nothing
// to list. "The forwarded email sent a document request" read as if an
// email were a person; this says what happened and what was missing.
const NOT_FOUND_OPENING = "Got it. A document request came in, but the requester's address was not found in the forwarded text.";
const NOT_FOUND_NEXT_STEP = "Open the request, enter their address under Requester's email and choose the documents.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The email the PHYSICIAN gets: who asked, for what, what was found, and the
 * one thing left to do. A line per ask so a wrong match is visible in the
 * inbox without opening the app. The last line is the app link with the
 * #requests fragment, which opens the requests list directly; "(Home, or
 * More > Requests)" described two routes to it and a physician on a phone
 * followed neither. The caller appends its own footer.
 */
export function physicianSummaryText(input: SummaryInput): string {
  // Read only when the requester was found; with no requester nobody is
  // named as the asker (see the two not-found openings).
  const who = String(input.requesterName ?? "").trim() || String(input.requesterAddr ?? "").trim() || "The requester";
  const p = input.proposal;
  const lines: string[] = [];
  let saidNotFound = false;

  if (!p || !Array.isArray(p.items) || p.items.length === 0) {
    const noList = Boolean(p && Array.isArray(p.items));
    if (!input.requesterFound) {
      // Nobody to name and nothing to list: say both once, then the one
      // control that works (Approve is disabled for this request).
      lines.push(NOT_FOUND_OPENING, "",
        noList ? `No list of documents could be read from it either. ${NOT_FOUND_NEXT_STEP}` : `The packet could not be prepared automatically. ${NOT_FOUND_NEXT_STEP}`);
      saidNotFound = true;
    } else if (noList) {
      lines.push(`Got it. ${who} sent a document request, but no list of documents could be read from it.`, "", NO_PROPOSAL_NOTE);
    } else {
      lines.push(`Got it. ${who} sent a document request.`, "", NO_PROPOSAL_NOTE);
    }
  } else {
    const count = plural(p.items.length, "item", "items");
    if (input.requesterFound) {
      lines.push(`Got it. ${who} asked for ${count}:`);
    } else {
      // Nobody can be named as the asker. "The forwarded email asks for 4
      // items" made an email the asker, the shape the no-items branch was
      // rewritten out of; this says what came in and, once, what was
      // missing from it, so the "Packet ready" line below need not.
      lines.push(`Got it. A document request came in for ${count} (the requester's address was not found in the forwarded text):`);
      saidNotFound = true;
    }
    for (const it of p.items) {
      const ask = String(it.ask ?? "").trim() || "(unnamed)";
      if (it.status === "found") lines.push(`- ${ask}: ${(it.labels ?? []).filter(Boolean).join(", ") || plural((it.docIds ?? []).length, "document", "documents")}`);
      else if (it.status === "report") lines.push(`- ${ask}: follows separately (the app exports it)`);
      else if (it.kind === "unknown") lines.push(`- ${ask}: not recognised, nothing attached`);
      else lines.push(`- ${ask}: not on file`);
    }
    const n = Array.isArray(p.docIds) ? p.docIds.length : 0;
    lines.push("");
    if (!input.requesterFound) {
      // The Approve button is disabled in the app for this request, so
      // "tap Approve and send" would be an instruction that cannot be
      // followed; the one that works is the one given. The not-found fact
      // was said in the opening and is not repeated here.
      lines.push(n > 0
        ? `Packet ready: ${plural(n, "document", "documents")}. Open the request, enter their address under Requester's email and send.`
        : "Nothing on file to attach yet. Open the request, enter their address under Requester's email and tap Send reply.");
    } else if (n > 0) {
      lines.push(`Packet ready: ${plural(n, "document", "documents")}. Open the app and tap Approve and send.`);
    } else {
      // "Send reply" is the first words of the live button on the request's
      // card and on Home ("Send reply (nothing to attach)"). "Reply from the
      // request" sent the physician into the card to find a button that was
      // already on the list.
      lines.push("Nothing on file to attach yet. Open the app and tap Send reply.");
    }
  }

  lines.push(`${input.appUrl}#requests (opens your requests)`);
  if (!input.requesterFound && !saidNotFound) lines.push("", NOT_FOUND_NOTE);
  return lines.join("\n");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_APPROVE_SUBJECT = 200;
export const MAX_APPROVE_TEXT = 5000;

export type ApproveBody =
  | { ok: true; requestId: string; ccSelf: boolean; subjectOverride: string | null; textOverride: string | null; docIds: string[] | null }
  | { ok: false; error: string };

/**
 * The body of an "Approve and send" call: { request_id, approve: true,
 * cc_self?, subject?, text?, doc_ids? }. The recipient comes from the row.
 * doc_ids and text are what the screen showed: the app rebuilds a proposal
 * on the client when the file has changed since the server built one, and
 * saves it back without waiting, so the row can lag the screen by a round
 * trip or a failed write. Sending what was shown, not what was stored, is
 * the only way the packet the physician approved is the packet that goes.
 * When they are absent (an older client) the stored proposal supplies them.
 *
 * text is taken as given, an empty string included: a physician who clears
 * the note box means "no note", and treating "" as "not edited" sent the
 * generated note anyway. doc_ids is taken as given too, an empty list
 * included: a proposal whose every ask is "not on file" still deserves the
 * note that says so, and refusing [] here made the app's one button fail
 * with "Choose at least one document" on exactly the requests where there
 * was nothing to choose. send-packet-email decides whether an empty list
 * may go (it may when the stored proposal has at least one item). cc_self
 * defaults ON here (the physician wants a copy of what went out in their
 * own name); the hand-built path keeps its explicit checkbox.
 */
export function approveRequestBody(body: unknown): ApproveBody {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "Bad request" };
  if (b.approve !== true) return { ok: false, error: "approve must be true" };
  const requestId = String(b.request_id ?? "").trim();
  if (!UUID_RE.test(requestId)) return { ok: false, error: "request_id is not a valid id" };

  let subjectOverride: string | null = null;
  if (b.subject != null && b.subject !== "") {
    if (typeof b.subject !== "string") return { ok: false, error: "subject must be text" };
    const s = b.subject.trim();
    if (/[\r\n]/.test(s)) return { ok: false, error: "Subject cannot contain line breaks" };
    if (s.length > MAX_APPROVE_SUBJECT) return { ok: false, error: `Subject is limited to ${MAX_APPROVE_SUBJECT} characters` };
    subjectOverride = s || null;
  }

  let textOverride: string | null = null;
  if (b.text != null) {
    if (typeof b.text !== "string") return { ok: false, error: "text must be text" };
    const t = b.text.replace(/\r\n?/g, "\n").trim();
    if (t.length > MAX_APPROVE_TEXT) return { ok: false, error: `Cover note is limited to ${MAX_APPROVE_TEXT} characters` };
    textOverride = t;
  }

  let docIds: string[] | null = null;
  if (b.doc_ids != null) {
    if (!Array.isArray(b.doc_ids)) return { ok: false, error: "doc_ids must be an array" };
    docIds = [];
    for (const d of b.doc_ids) {
      const s = String(d ?? "").trim();
      if (!UUID_RE.test(s)) return { ok: false, error: "doc_ids contains an invalid id" };
      if (!docIds.includes(s)) docIds.push(s);
    }
  }

  return { ok: true, requestId, ccSelf: b.cc_self !== false, subjectOverride, textOverride, docIds };
}
