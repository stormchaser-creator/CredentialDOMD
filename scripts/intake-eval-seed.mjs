#!/usr/bin/env node
/**
 * intake-eval-seed: build the PRIVATE evaluation corpus for
 * scripts/intake-eval.mjs from one account's own recent mail to docs@ and
 * cme@. Run by the owner, on the owner's machine, for the owner's account.
 *
 *   node scripts/intake-eval-seed.mjs --profile <profiles.id> [--days 30] [--out <dir>] [--redact] [--dry-run]
 *
 * What it reads, and nothing else:
 *   production   SELECT only, through the Supabase management API with the
 *                token in the keychain item "Supabase CLI" (the one
 *                scripts/storage-orphans.mjs uses): this profile's
 *                inbound_emails rows on the docs and cme routes from the last
 *                --days days, and the document_requests row each one made.
 *                No secret, no other account, no write.
 *   Resend       with RESEND_API_KEY in the environment (optional): each
 *                email's text and its attachments' NAMES from the Receiving
 *                API. No attachment is downloaded. Without the key, or when
 *                Resend no longer holds the email, a request's stored body
 *                (document_requests.body_text) stands in, and a delivery with
 *                no stored body is written with an empty body and a note.
 *
 * What it writes: one JSON file per email into --out (default
 * ~/Library/Application Support/CredentialDOMD/intake-eval/), created 0700
 * with files 0600. It refuses any directory inside this repository, which is
 * public. It prints counts, never content.
 *
 * Every case is written UNLABELLED ("labelled": false) with what the system
 * did at the time under "observed" and a suggested "expected" from it (a
 * request that was dismissed suggests it was not one). The owner reads each
 * case, corrects "expected", and sets "labelled": true; intake-eval scores
 * only labelled cases. Attachments carry "scan": null; the owner may paste a
 * scanner result in from the app to make a case sharper.
 *
 * --redact replaces email addresses, links and phone numbers in the text
 * with placeholders. Use it before a corpus leaves this machine. Note that
 * `intake-eval --mode model` sends each case to Anthropic, as production
 * does, under the owner's own key.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { corpusAllowed, DEFAULT_CORPUS } from "./intake-eval.mjs";

const PROJECT = "hkpnnsjcwprrwobmpqyy";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arguments, checked. Returns { profile, days, out, redact, dryRun } or { error }. */
export function parseArgs(argv) {
  const args = [...argv];
  const take = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ""; };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const profile = take("--profile");
  const days = Number(take("--days") ?? 30);
  const out = resolve(take("--out") || DEFAULT_CORPUS);
  const redact = has("--redact");
  const dryRun = has("--dry-run");
  if (!profile || !UUID_RE.test(profile)) return { error: "--profile <profiles.id> is required, as a uuid" };
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: "--days must be a whole number from 1 to 90" };
  if (!corpusAllowed(out)) return { error: `refusing ${out}: the corpus must live outside this repository` };
  return { profile: profile.toLowerCase(), days, out, redact, dryRun };
}

/** The one statement sent to production. The profile is a checked uuid and the day count a checked integer. */
export function seedQuery(profile, days) {
  if (!UUID_RE.test(profile) || !Number.isInteger(days)) throw new Error("bad arguments");
  return `select e.id, e.email_id, e.route, e.subject, e.from_addr, e.detail, e.created_at,
       r.id as request_id, r.from_addr as requester_addr, r.from_name as requester_name, r.subject as request_subject,
       r.body_text, r.status as request_status, r.proposal
  from public.inbound_emails e
  left join public.document_requests r on r.inbound_ledger_id = e.id
 where e.profile_id = '${profile}'
   and e.route in ('docs', 'cme')
   and e.status = 'done'
   and e.created_at >= now() - interval '${days} days'
 order by e.created_at desc`;
}

/** Addresses, links and phone numbers out, for a corpus that may leave the machine. */
export function redactText(s) {
  return String(s ?? "")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/g, "<link>")
    .replace(/[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "someone@$1")
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "<phone>");
}

/** What the system did with this email, from the ledger and the request row. */
export function observed(row) {
  const detail = String(row.detail || "");
  const intent = /^informational,/.test(detail) ? "informational"
    : /^delivery,/.test(detail) ? "delivery"
    : /\bintent (request|mixed|both)\b/.exec(detail)?.[1]?.replace("both", "mixed") || (row.request_id ? "request" : row.route === "cme" ? "delivery" : null);
  const items = Array.isArray(row.proposal?.items) ? row.proposal.items : [];
  return { intent, request_status: row.request_status || null, asks: items.map((i) => ({ ask: i.ask, kind: i.kind, status: i.status })) };
}

/** The suggested label, for the owner to confirm or correct. */
export function suggestExpected(obs) {
  if (obs.request_status === "dismissed") return { intent: "informational", asks: [] };
  return { intent: obs.intent || "informational", asks: obs.asks.filter((a) => a.kind && a.kind !== "unknown").map((a) => ({ kind: a.kind })) };
}

/** One case file, from a ledger row and whatever Resend still holds. */
export function caseFrom(row, email, attachments, { redact = false } = {}) {
  const clean = redact ? redactText : (s) => String(s ?? "");
  const obs = observed(row);
  const body = email?.text || row.body_text || "";
  return {
    id: `${String(row.created_at).slice(0, 10)}-${String(row.id).slice(0, 8)}`,
    about: `Seeded from inbound_emails ${row.id} (${row.route}). Label it: correct "expected", then set "labelled": true.${email ? "" : row.body_text ? " Body from the stored request; the email itself was not available." : " No body was available."}`,
    labelled: false,
    subject: clean(row.request_subject || row.subject || ""),
    from: { name: clean(row.requester_name || ""), address: clean(row.requester_addr || row.from_addr || "") },
    note: "",
    body: clean(body),
    attachments: (attachments || []).map((a) => ({ name: clean(a.filename || "attachment"), scan: null })),
    expected: suggestExpected(obs),
    observed: obs,
  };
}

async function main(argv) {
  const opts = parseArgs(argv.slice(2));
  if (opts.error) { console.error(opts.error); return 2; }
  let token = "";
  try { token = execSync('security find-generic-password -l "Supabase CLI" -w', { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* reported below */ }
  if (!token) { console.error('No Supabase management token in the keychain item "Supabase CLI". Nothing was read.'); return 1; }
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: seedQuery(opts.profile, opts.days) }),
  });
  const rows = await r.json();
  if (!r.ok || !Array.isArray(rows)) { console.error(`The query failed (HTTP ${r.status}). Nothing was written.`); return 1; }
  const resendKey = process.env.RESEND_API_KEY || "";
  const resend = async (path) => {
    if (!resendKey) return null;
    const res = await fetch(`https://api.resend.com/emails/receiving/${path}`, { headers: { Authorization: `Bearer ${resendKey}` } });
    return res.ok ? res.json() : null;
  };
  if (!opts.dryRun) {
    if (!existsSync(opts.out)) mkdirSync(opts.out, { recursive: true, mode: 0o700 });
    chmodSync(opts.out, 0o700);
  }
  let written = 0, withEmail = 0;
  for (const row of rows) {
    const email = row.email_id ? await resend(encodeURIComponent(row.email_id)) : null;
    const listed = email && row.email_id ? await resend(`${encodeURIComponent(row.email_id)}/attachments`) : null;
    if (email) withEmail++;
    const c = caseFrom(row, email, Array.isArray(listed?.data) ? listed.data : [], { redact: opts.redact });
    if (!opts.dryRun) {
      const file = join(opts.out, `${c.id}.json`);
      writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    written++;
  }
  console.log(`${opts.dryRun ? "Would write" : "Wrote"} ${written} case${written === 1 ? "" : "s"} (${withEmail} with the email from Resend) to ${opts.out}. None is labelled yet.`);
  return 0;
}

const isMain = (() => { try { return resolve(process.argv[1] || "") === resolve(fileURLToPath(new URL(import.meta.url))); } catch { return false; } })();
if (isMain) main(process.argv).then((code) => process.exit(code), (e) => { console.error(e?.message || e); process.exit(1); });
