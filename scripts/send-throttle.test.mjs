// Checks for the two things ITEM 6 changed:
//
//   1. send-packet-email's hourly cap now counts public.send_reservations, a
//      table the physician it bounds cannot read, write or delete, instead of
//      share_log, whose only policy is FOR ALL to authenticated on the
//      caller's own rows. DELETE was in that FOR ALL, so the subject of the
//      cap could delete the evidence and start the hour over.
//
//   2. the shared Gemini path bounds the SHAPE of a request (model, size,
//      requested output) the way the Anthropic path already did. Not the
//      volume: there is deliberately no per-physician quota on Gemini.
//
// Both files are edge functions: they import from deno.land and call serve()
// at module scope, so they are loaded the way scripts/send-invite-consent.
// test.mjs loads send-invite, by stripping the import lines and injecting the
// names as globals. The exported helpers under test are the REAL ones from
// the real files, not copies.
//
// Run: node scripts/send-throttle.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { transformSync } from "esbuild";

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Load a Deno edge function in node: drop its https / .ts imports and hand it
// the names they would have bound. Nothing is stubbed that the tested helpers
// touch; the stubs exist only so module scope can run.
let loaded = 0;
async function loadEdgeFunction(rel, globals) {
  const key = `__sendThrottleTest${loaded++}`;
  globalThis[key] = globals;
  let source = read(rel).replace(/^import .*;\n/gm, "");
  source = `const { ${Object.keys(globals).join(", ")} } = globalThis.${key};\n${source}`;
  const js = transformSync(source, { loader: "ts", format: "esm" }).code;
  return await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const noop = () => {};
const denoStub = { env: { get: () => "" } };

const sendPacket = await loadEdgeFunction("../supabase/functions/send-packet-email/index.ts", {
  serve: noop, Deno: denoStub, encodeBase64: noop, clerkProfile: noop,
  isOwnStorageObject: noop, approveRequestBody: noop, longDate: noop, replySubject: noop,
});
// ai-proxy's bounds live in a sibling module. It is imported for real, not
// stubbed: the byte counter and the admission verdict under test are its code,
// and a stub here would be a test of the stub.
const limits = await import("../supabase/functions/ai-proxy/limits.ts");
const aiProxy = await loadEdgeFunction("../supabase/functions/ai-proxy/index.ts", {
  serve: noop, Deno: denoStub, clerkProfile: noop, meterUsage: () => ({}),
  utf8ByteLength: limits.utf8ByteLength,
  requestByteLength: limits.requestByteLength,
  readTextBounded: limits.readTextBounded,
  aiAdmissionVerdict: limits.aiAdmissionVerdict,
  AI_CODES: limits.AI_CODES,
});

const { SENDS_PER_HOUR, SEND_WINDOW_MS, sendWindowStart, sendReservationVerdict,
        SEND_CAP_CODE, SEND_LEDGER_UNAVAILABLE_CODE } = sendPacket;
const {
  GEMINI_MODEL_ALLOWLIST, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MAX_BODY_BYTES,
  geminiRequestProblem, requestByteLength,
} = aiProxy;

const sendSource = read("../supabase/functions/send-packet-email/index.ts");
const proxySource = read("../supabase/functions/ai-proxy/index.ts");
const sql = read("../supabase/migrations/20260915e_send_reservations.sql");
const sqlFlat = sql.replace(/\s+/g, " ");
// The executable half only: the header quotes the old share_log query it
// replaces, and a comment must not satisfy a structural assertion.
const sqlCode = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

console.log("\n== The window the cap counts over ==");
ok("the cap is still 30 per hour", SENDS_PER_HOUR === 30);
ok("the window is exactly one hour in ms", SEND_WINDOW_MS === 60 * 60 * 1000);
const noonMs = Date.parse("2026-09-15T12:00:00.000Z");
eq("an hour back from noon", sendWindowStart(noonMs), "2026-09-15T11:00:00.000Z");
eq("a Date works the same", sendWindowStart(new Date(noonMs)), "2026-09-15T11:00:00.000Z");
eq("an ISO string works the same", sendWindowStart("2026-09-15T12:00:00.000Z"), "2026-09-15T11:00:00.000Z");
eq("an explicit shorter window", sendWindowStart(noonMs, 60_000), "2026-09-15T11:59:00.000Z");
eq("the window crosses midnight without special casing",
  sendWindowStart(Date.parse("2026-09-15T00:30:00.000Z")), "2026-09-14T23:30:00.000Z");
ok("the result is an ISO 8601 UTC instant", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sendWindowStart()));
// A window that came out NaN or Infinity would be sent to Postgres as p_since
// and the count would match nothing or everything. Neither may happen.
ok("an unparseable instant still yields a real timestamp", /^\d{4}-/.test(sendWindowStart("not a date")));
ok("a zero window does not widen the cap to all time", sendWindowStart(noonMs, 0) === "2026-09-15T11:00:00.000Z");
ok("a negative window does not move the boundary forward", sendWindowStart(noonMs, -5000) === "2026-09-15T11:00:00.000Z");
ok("a NaN window falls back to the hour", sendWindowStart(noonMs, Number.NaN) === "2026-09-15T11:00:00.000Z");
ok("the default window is one hour before now",
  Math.abs(Date.parse(sendWindowStart()) - (Date.now() - SEND_WINDOW_MS)) < 2000);

console.log("\n== Reading reserve_send's answer ==");
const reserved = { data: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", error: null };
ok("a reservation id means send", sendReservationVerdict(reserved).send === true);
eq("and it is not an error of any kind", [reserved].map((r) => {
  const v = sendReservationVerdict(r);
  return [v.send, v.overCap, v.infrastructure, v.status, v.code, v.error];
})[0], [true, false, false, 200, "reserved", ""]);
ok("a single-element array is also a reservation", sendReservationVerdict({ data: [{ id: "x" }], error: null }).send === true);
ok("and is not treated as over the cap", sendReservationVerdict({ data: [{ id: "x" }], error: null }).overCap === false);

const full = sendReservationVerdict({ data: null, error: null });
ok("no row means over the cap", full.overCap === true);
ok("and over the cap does not send", full.send === false);
ok("over the cap is not an infrastructure failure", full.infrastructure === false);
eq("over the cap answers 429", full.status, 429);
eq("over the cap carries a stable code", full.code, SEND_CAP_CODE);
ok("over the cap tells the caller the number", full.error.includes(String(SENDS_PER_HOUR)));
eq("over the cap has no Retry-After, because the wait is an hour", full.retryAfter, null);
const emptyRows = sendReservationVerdict({ data: [], error: null });
ok("an empty array is the same answer as null", emptyRows.overCap === true && emptyRows.send === false);

// ── The branch that used to send anyway ────────────────────────────────────
// An earlier draft of this function let an unavailable ledger through, on the
// reasoning that a physician answering a credentialer should not be stopped by
// our plumbing. Review was right that it inverted the control: the throttle
// bounds how much mail one account sends over our sending domain under a
// physician's name, Clerk sign-up is open, and the branch fires on ANY RPC
// error, so breaking the ledger was the cheapest route to an unmetered send
// budget. It now refuses retryably. Nothing is fetched, claimed or mailed.
//
// The status is 429, and it was 503 for one day. A 503 from an edge function
// is also what the platform answers when the function did not boot, so the
// caller cannot tell a refusal from an absence; and the batch rule this
// belongs to is that a refusal which clears by itself never answers 503,
// because in ai-proxy that is the one status an already-installed PWA bundle
// reads as "the shared key is not configured" and acts on by switching the
// feature off for good. The two refusals are still told apart by their codes,
// which is where a client should be looking.
const unavailable = [
  ["a missing function (migration not applied)", { data: null, error: { code: "PGRST202", message: "Could not find the function public.reserve_send" } }],
  ["a missing table", { data: null, error: { message: 'relation "public.send_reservations" does not exist' } }],
  ["a thrown error", { error: new Error("fetch failed") }],
  ["an undefined result", undefined],
  ["a null result", null],
  ["a permission error on the table", { data: null, error: { code: "42501", message: "permission denied for table send_reservations" } }],
];
for (const [name, result] of unavailable) {
  const v = sendReservationVerdict(result);
  ok(`${name} does NOT send`, v.send === false);
  ok(`${name} is flagged infrastructure, not over cap`, v.infrastructure === true && v.overCap === false);
  eq(`${name} answers 429, never 503`, v.status, 429);
  eq(`${name} carries the stable code`, v.code, SEND_LEDGER_UNAVAILABLE_CODE);
  ok(`${name} says nothing was sent`, /nothing was sent/i.test(v.error));
  ok(`${name} says to try again`, /try again/i.test(v.error));
  ok(`${name} is retryable, with a wait the client can honour`, typeof v.retryAfter === "number" && v.retryAfter > 0);
  ok(`${name} does not leak the internal reason to the caller`, !v.error.includes(v.why) || v.why === "");
}
ok("a missing function still carries its reason for the log",
  sendReservationVerdict({ data: null, error: { code: "PGRST202", message: "Could not find the function public.reserve_send" } }).why.includes("reserve_send"));
ok("a thrown error's message is carried", sendReservationVerdict({ error: new Error("fetch failed") }).why === "fetch failed");
eq("the two refusal codes are distinct, so a client can tell them apart",
  new Set([SEND_CAP_CODE, SEND_LEDGER_UNAVAILABLE_CODE]).size, 2);
// Both refusals now share a status, so the code is the ONLY thing that
// separates "you have sent thirty this hour" from "we could not record it".
ok("the two refusals share the status and differ only in the code",
  sendReservationVerdict({ data: null, error: null }).status
    === sendReservationVerdict({ error: new Error("boom") }).status);
ok("no refusal in send-packet-email answers 503", !/status: 503|json\(503/.test(sendSource));

// ── Zero provider calls on the refusal ─────────────────────────────────────
// The assertion that matters: a refused reservation must not have cost a
// Resend call, a Storage read or a claimed request row. That is structural in
// the handler -- the reservation is taken before any of them -- so it is
// checked by reading the order of the source rather than by a probe that would
// need a live Resend key to be meaningful.
{
  const src = sendSource;
  const body = src.slice(src.indexOf("serve(async"));
  const at = (needle) => {
    const i = body.indexOf(needle);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const refusal = at("if (!verdict.send)");
  ok("the handler refuses on !verdict.send", refusal < Number.MAX_SAFE_INTEGER);
  ok("the refusal returns the verdict's own status", /return json\(verdict\.status/.test(body));
  ok("the refusal carries the code to the client", /code: verdict\.code/.test(body));
  ok("the ledger refusal carries Retry-After", /"Retry-After": String\(verdict\.retryAfter\)/.test(body));
  for (const [what, needle] of [
    ["the Resend call", "api.resend.com"],
    ["the Resend send", "/emails"],
    ["any Storage download", ".download("],
    ["the share_log write", 'from("share_log")'],
  ]) {
    ok(`${what} comes after the refusal, so a refused send never reaches it`, refusal < at(needle));
  }
  ok("the reservation itself is taken before the documents are read",
    at('rpc("reserve_send"') < at(".download("));
  ok("no branch sends anyway on an infrastructure failure",
    !/sending anyway/i.test(src));
}

console.log("\n== Under, at and over the cap ==");
// A mirror of reserve_send's one statement:
//   insert ... select where (select count(*) ... >= p_since) < p_limit returning id
// The SQL text assertions below hold the mirror honest; this exercises the
// boundary through the real decision function.
function ledger(limit = SENDS_PER_HOUR, windowMs = SEND_WINDOW_MS) {
  const rows = [];
  let n = 0;
  return {
    seed(count, at) { for (let i = 0; i < count; i++) rows.push(at); },
    reserve(now) {
      const since = Date.parse(sendWindowStart(now, windowMs));
      const inWindow = rows.filter((t) => t >= since).length;
      if (inWindow < limit) { rows.push(now); return { data: `res-${++n}`, error: null }; }
      return { data: null, error: null };
    },
  };
}
const under = ledger();
under.seed(29, noonMs - 60_000);
ok("29 in the window: the 30th is reserved", sendReservationVerdict(under.reserve(noonMs)).send === true);
ok("now at 30: the 31st is refused", sendReservationVerdict(under.reserve(noonMs)).overCap === true);
const over = ledger();
over.seed(45, noonMs - 60_000);
ok("well over the cap is refused", sendReservationVerdict(over.reserve(noonMs)).overCap === true);
const empty = ledger();
ok("an empty ledger reserves", sendReservationVerdict(empty.reserve(noonMs)).send === true);
// The window is why a cap is not a lifetime limit: yesterday's sends must not
// count, or a busy physician is locked out for good.
const aged = ledger();
aged.seed(30, noonMs - 2 * SEND_WINDOW_MS);
ok("30 sends from two hours ago do not count", sendReservationVerdict(aged.reserve(noonMs)).send === true);
const edge = ledger();
edge.seed(30, noonMs - SEND_WINDOW_MS);
ok("a send exactly at the boundary still counts (>= p_since)", sendReservationVerdict(edge.reserve(noonMs)).overCap === true);
const justPast = ledger();
justPast.seed(30, noonMs - SEND_WINDOW_MS - 1);
ok("one millisecond before the boundary does not", sendReservationVerdict(justPast.reserve(noonMs)).send === true);

console.log("\n== Two taps at the boundary ==");
// The advisory lock makes the pair serial in the database; here they are run
// in the order the lock would impose, and the second must lose.
const race = ledger();
race.seed(29, noonMs - 30_000);
const first = sendReservationVerdict(race.reserve(noonMs));
const second = sendReservationVerdict(race.reserve(noonMs));
ok("exactly one of two concurrent sends at the boundary passes", first.send === true && second.send === false);
ok("the loser is refused as over cap, not as infrastructure", second.overCap === true && second.infrastructure === false);
ok("the SQL takes a per-user transaction advisory lock",
  /pg_advisory_xact_lock\(\s*hashtext\('public\.reserve_send'\)\s*,\s*hashtext\(p_user::text\)\s*\)/.test(sqlFlat));
ok("the lock is taken before the insert",
  sqlFlat.indexOf("pg_advisory_xact_lock") < sqlFlat.indexOf("insert into public.send_reservations"));
ok("the count and the insert are ONE statement",
  /insert into public\.send_reservations \(user_id, method\) select p_user, 'email' where \( select count\(\*\)/.test(sqlFlat));
ok("that statement compares the window count against the limit", /\) < p_limit/.test(sqlFlat));
ok("there is no second count for a caller to disagree with", (sqlCode.match(/count\(\*\)/g) || []).length === 1);
ok("no row returned is the over-cap answer", /returning id into v_id/.test(sqlFlat) && /return v_id;/.test(sqlFlat));
ok("the reservation is inserted before the send, not after",
  sendSource.indexOf('db.rpc("reserve_send"') < sendSource.indexOf("sendAttempted = true"));

console.log("\n== The ledger the sender cannot edit ==");
ok("the table is created", /create table if not exists public\.send_reservations/.test(sqlFlat));
ok("RLS is on", /alter table public\.send_reservations enable row level security/.test(sqlFlat));
ok("no policy is created for anyone", !/create policy/i.test(sql));
for (const role of ["public", "anon", "authenticated"]) {
  ok(`the table grant is revoked from ${role}`,
    new RegExp(`revoke all on table public\\.send_reservations from ${role};`).test(sqlFlat));
}
ok("execute on reserve_send is granted to service_role only",
  /grant execute on function public\.reserve_send\(uuid, integer, timestamptz\) to service_role;/.test(sqlFlat) &&
  (sql.match(/grant execute/g) || []).length === 1);
for (const role of ["public", "anon", "authenticated"]) {
  ok(`execute on reserve_send is revoked from ${role}`,
    new RegExp(`revoke all on function public\\.reserve_send\\(uuid, integer, timestamptz\\) from ${role};`).test(sqlFlat));
}
// share_log is the physician's own history and stays exactly as it is; the
// fix was to stop counting it, not to lock it down.
ok("share_log is not altered", !/alter table public\.share_log/i.test(sql));
ok("no policy on share_log is dropped", !/drop policy[^;]*share_log/i.test(sql));
// Additive only: another agent's migration runs in the same tree.
ok("nothing is dropped", !/\bdrop (table|column|constraint|index)\b/i.test(sql));
ok("nothing is renamed", !/\brename\b/i.test(sql));
ok("the schema cache is reloaded so PostgREST sees the function", /notify pgrst/.test(sql));

console.log("\n== The handler counts the ledger, not share_log ==");
ok("the cap calls reserve_send", /db\.rpc\("reserve_send", \{/.test(sendSource));
for (const arg of ["p_user:", "p_limit: SENDS_PER_HOUR", "p_since: sendWindowStart()"]) {
  ok(`reserve_send is called with ${arg.replace(/:.*/, "")}`, sendSource.includes(arg));
}
ok("the RPC call is wrapped so a throw becomes an infrastructure verdict",
  /try \{\s*reservation = await db\.rpc\("reserve_send"/.test(sendSource.replace(/\n\s*/g, "\n")) ||
  /catch \(e\) \{\s*reservation = \{ error: e \};/.test(sendSource.replace(/\s+/g, " ")));
ok("share_log is no longer counted for the cap",
  !/from\("share_log"\)[\s\S]{0,200}count: "exact"/.test(sendSource));
ok("share_log is still written as the physician's history", /db\.from\("share_log"\)\.insert\(/.test(sendSource));
ok("the over-cap message still names the limit and the hour",
  /Send limit reached \(\$\{SENDS_PER_HOUR\} emails per hour\)\. Try again later\./.test(sendSource));
ok("the over-cap status is not written by hand any more; it comes from the verdict",
  !/json\(429,/.test(sendSource) && /status: 429/.test(sendSource));
ok("an unavailable ledger is logged AND refused",
  /reservation unavailable, refusing/.test(sendSource));
ok("nothing in the file still says it sends anyway", !/sending anyway/i.test(sendSource));

console.log("\n== The physician's own mailboxes, on the send guard ==");
// The approve path refuses to mail a packet to an address that is the
// physician's own: that means email-inbound found no From: line in the forward
// and stored a placeholder, so there is nobody to reply to. The set was built
// from profiles.email plus confirmed forwarding rows, and profiles.verified_email
// was left out of it even though this batch made that column a first-class
// physician mailbox and email-inbound already folds it into the matching set
// it suppresses acknowledgements on. 20260915d measured five of six live
// accounts getting their only proven mailbox from the Clerk stamp, so this is
// the ordinary case: mail yourself the checklist from the hospital account,
// forward it in from the clinic account, tap Approve, and the DEA/licence/CV
// packet goes to your own inbox while the request is stamped 'replied' and the
// real credentialer gets nothing.
ok("the profile select carries verified_email",
  /select\("id, name, degree_type, email, verified_email, auth_user_id"\)/.test(sendSource));
ok("it is normalized the way every other address here is",
  /const verifiedEmail = String\(prof\.verified_email \?\? ""\)\.trim\(\)\.toLowerCase\(\);/.test(sendSource));
ok("it is folded into the own-address set", /if \(verifiedEmail\) ownAddresses\.add\(verifiedEmail\);/.test(sendSource));
ok("and it is added BEFORE the requester test reads the set",
  sendSource.indexOf("ownAddresses.add(verifiedEmail)") < sendSource.indexOf("ownAddresses.has(to)"));
ok("the test still covers the profile email and the forwarding address",
  /to === physEmail \|\| \(forwardedBy && to === forwardedBy\) \|\| ownAddresses\.has\(to\)/.test(sendSource));
ok("the refusal happens before a reservation is spent",
  sendSource.indexOf("ownAddresses.has(to)") < sendSource.indexOf('rpc("reserve_send"'));

console.log("\n== The Opus counter reads the ledger that binds the reader ==");
// anthropic_used_today moved from ai_usage to ai_reservations so a physician's
// counter and their refusal come from one place. Reservations are only taken
// inside `if (!user.isAdmin)`, so for the one uncapped account that number was
// a flat zero however much Opus the shared key had paid for -- and that is the
// account watching the shared key's spend.
ok("the counter picks its source by whether the caller is capped",
  /user\.isAdmin \? usedToday\("anthropic"\) : reservedIn\(ANTHROPIC_SCOPE, msSinceUtcMidnight\(\)\)/.test(proxySource));
ok("a capped physician still reads the exact ledger the refusal is decided from",
  /reserve_ai_call/.test(proxySource) && /from\("ai_reservations"\)/.test(proxySource));
ok("Gemini's number is unchanged and still comes from the cost ledger",
  /usedToday\("gemini"\)/.test(proxySource));

console.log("\n== The comments name the constants they are about ==");
// Both of these are comments an operator reads while deciding whether to raise
// GEMINI_BURST_LIMIT, so a wrong number in them is a wrong override.
{
  const burst = proxySource.slice(proxySource.indexOf("What there now is, is a bound on a BURST"), proxySource.indexOf("const admission = await reserve(\n      GEMINI_BURST_SCOPE"));
  ok("the burst comment was found", burst.length > 0 && burst.length < 4000);
  ok("it no longer states a ceiling of twenty while the constant is thirty",
    !/twenty calls/i.test(burst));
  ok("it names the constant instead of a literal", /GEMINI_BURST_LIMIT/.test(burst));
}
{
  const measured = proxySource.slice(proxySource.indexOf("// Measured before choosing the number"), proxySource.indexOf("const DEFAULT_GEMINI_BURST_LIMIT"));
  ok("the measurement note was found", measured.length > 0);
  ok("it no longer claims the only multi-file loops are download loops",
    !/the two\s*\n?\s*\/\/ multi-file loops that exist are download loops/.test(measured.replace(/\s+/g, " ")) &&
    !/multi-file loops that exist are download loops/.test(measured.replace(/\s+/g, " ")));
  ok("it names the fan-out loop that exists", /DocumentsSection\.jsx:223/.test(measured));
  ok("and the batch size that loop is bounded by", /MAX_BATCH = 10/.test(measured));
  ok("the Promise.all half of the claim, which was true, is kept",
    /no Promise\.all over files/.test(measured));
}
// The claim is only worth making if it is still true of the file it names.
{
  const docs = read("../src/components/features/DocumentsSection.jsx");
  ok("DocumentsSection really does loop files and scan each one",
    /for \(const file of fileList\)/.test(docs) &&
    /await analyzePDF\(|await analyzeDocument\(|await analyzeDocText\(/.test(docs));
  ok("and MAX_BATCH really is 10", /const MAX_BATCH = 10;/.test(docs));
  ok("and it is still not a Promise.all", !/Promise\.all\([\s\S]{0,120}fileList/.test(docs));
}

console.log("\n== The Gemini request envelope ==");
const genPath = (model) => `models/${model}:generateContent`;
const bodyWith = (maxOutputTokens) => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  ...(maxOutputTokens === undefined ? {} : { generationConfig: { maxOutputTokens } }),
});
const problem = (model, tokens, bytes = 1000) => geminiRequestProblem(genPath(model), bodyWith(tokens), bytes);
const codeOf = (p) => (p ? p.error : null);

// Output ceiling. These three numbers are what the app sends today; a bound
// below any of them silently breaks a scan that works.
eq("a document scan at 8192 is accepted", problem("gemini-2.5-flash", 8192), null);
eq("a statement scan at 16384 is accepted", problem("gemini-2.5-flash", 16384), null);
eq("a CV scan at 32768 is accepted", problem("gemini-2.5-flash", 32768), null);
eq("the ceiling itself, 65536, is accepted", problem("gemini-2.5-flash", 65536), null);
ok("the ceiling is 65536", GEMINI_MAX_OUTPUT_TOKENS === 65536);
eq("one token over the ceiling is refused", codeOf(problem("gemini-2.5-flash", 65537)), "max_output_tokens_out_of_range");
eq("a million tokens is refused", codeOf(problem("gemini-2.5-flash", 1_000_000)), "max_output_tokens_out_of_range");
eq("zero output is refused", codeOf(problem("gemini-2.5-flash", 0)), "max_output_tokens_out_of_range");
eq("a negative output is refused", codeOf(problem("gemini-2.5-flash", -1)), "max_output_tokens_out_of_range");
eq("a non-numeric output is refused", codeOf(problem("gemini-2.5-flash", "lots")), "max_output_tokens_out_of_range");
eq("the refusal names the ceiling so the client can say why",
  problem("gemini-2.5-flash", 99999).ceiling, GEMINI_MAX_OUTPUT_TOKENS);
eq("no generationConfig at all is accepted (Google's default applies)",
  problem("gemini-2.5-flash", undefined), null);
eq("a generationConfig without maxOutputTokens is accepted",
  geminiRequestProblem(genPath("gemini-2.5-flash"), { generationConfig: { temperature: 0 } }, 10), null);
eq("snake_case at the ceiling is accepted",
  geminiRequestProblem(genPath("gemini-2.5-flash"), { generation_config: { max_output_tokens: 65536 } }, 10), null);
eq("snake_case cannot slip past the ceiling",
  codeOf(geminiRequestProblem(genPath("gemini-2.5-flash"), { generation_config: { max_output_tokens: 200000 } }, 10)),
  "max_output_tokens_out_of_range");

// Body size. A 10 MiB binary is about 13.34 MiB once it is base64 inside JSON.
const MiB = 1024 * 1024;
ok("the size bound is 20 MiB", GEMINI_MAX_BODY_BYTES === 20 * MiB);
ok("the bound is above a 10 MiB upload as base64", GEMINI_MAX_BODY_BYTES > Math.ceil(10 * MiB * 4 / 3));
eq("a 14 MiB body is accepted", problem("gemini-2.5-flash", 8192, 14 * MiB), null);
eq("a 13.34 MiB body (a 10 MiB scan) is accepted", problem("gemini-2.5-flash", 8192, Math.ceil(10 * MiB * 4 / 3)), null);
eq("exactly 20 MiB is accepted", problem("gemini-2.5-flash", 8192, 20 * MiB), null);
eq("one byte over 20 MiB is refused", codeOf(problem("gemini-2.5-flash", 8192, 20 * MiB + 1)), "request_too_large");
eq("a 30 MiB body is refused", codeOf(problem("gemini-2.5-flash", 8192, 30 * MiB)), "request_too_large");
eq("the refusal names the limit", problem("gemini-2.5-flash", 8192, 30 * MiB).max_bytes, GEMINI_MAX_BODY_BYTES);

// Models. Every model the client actually names must be on the list.
eq("gemini-2.5-flash is accepted", problem("gemini-2.5-flash", 8192), null);
eq("gemini-2.5-pro is accepted", problem("gemini-2.5-pro", 8192), null);
eq("countTokens on an allowed model is accepted",
  geminiRequestProblem("models/gemini-2.5-flash:countTokens", { contents: [] }, 100), null);
eq("an unlisted model is refused", codeOf(problem("gemini-3-ultra", 8192)), "model_not_allowed");
eq("a retired model is refused", codeOf(problem("gemini-2.0-flash", 8192)), "model_not_allowed");
eq("a look-alike model is refused", codeOf(problem("gemini-2.5-flash-exp", 8192)), "model_not_allowed");
ok("the refusal lists what is allowed", Array.isArray(problem("gemini-3-ultra", 8192).allowed));

// Paths and bodies.
eq("a path with no models/ prefix is refused", codeOf(geminiRequestProblem("gemini-2.5-flash:generateContent", {}, 10)), "Unsupported path");
eq("an unknown method is refused", codeOf(geminiRequestProblem("models/gemini-2.5-flash:deleteModel", {}, 10)), "Unsupported path");
eq("a traversal path is refused", codeOf(geminiRequestProblem("models/../../v1/tunedModels:generateContent", {}, 10)), "Unsupported path");
eq("an absolute URL is refused", codeOf(geminiRequestProblem("https://evil.example/models/x:generateContent", {}, 10)), "Unsupported path");
eq("a non-string path is refused", codeOf(geminiRequestProblem(null, {}, 10)), "Unsupported path");
eq("an empty path is refused", codeOf(geminiRequestProblem("", {}, 10)), "Unsupported path");
eq("a null body is refused", codeOf(geminiRequestProblem(genPath("gemini-2.5-flash"), null, 10)), "body must be the Gemini request object");
eq("an array body is refused", codeOf(geminiRequestProblem(genPath("gemini-2.5-flash"), [], 10)), "body must be the Gemini request object");
eq("a string body is refused", codeOf(geminiRequestProblem(genPath("gemini-2.5-flash"), "contents", 10)), "body must be the Gemini request object");

console.log("\n== How the body size is measured ==");
eq("Content-Length is the real byte count and wins", requestByteLength("1048576", "short"), 1048576);
eq("a missing Content-Length falls back to the text read", requestByteLength(null, "abcdefgh"), 8);
eq("an empty Content-Length falls back too", requestByteLength("", "abcdefgh"), 8);
eq("a zero Content-Length falls back (a chunked body reports none)", requestByteLength("0", "abcdefgh"), 8);
eq("a junk Content-Length falls back", requestByteLength("not-a-number", "abcdefgh"), 8);
eq("a negative Content-Length falls back", requestByteLength("-5", "abcdefgh"), 8);
// Scoped to the Gemini half: the Anthropic path above reads its body too.
const geminiHalf = proxySource.slice(proxySource.indexOf("---- POST: forward one Gemini call ----"));
const geminiRequestProblemSource = proxySource.slice(
  proxySource.indexOf("export function geminiRequestProblem("), proxySource.indexOf("serve(async (req)"));
ok("the Gemini half is where this was measured", geminiHalf.length > 0 && geminiHalf.includes("declaredBytes"));
ok("the oversized case is refused from the header before the stream is read",
  geminiHalf.indexOf("declaredBytes") < geminiHalf.indexOf("readTextBounded(req"));
// The header check alone is not a bound: a chunked request declares no
// Content-Length, so it is skipped entirely. The read itself has to hold the
// same ceiling, which is what readTextBounded does.
ok("the body is never read with an unbounded req.text()", !/await req\.text\(\)/.test(proxySource));
ok("both request reads carry a ceiling",
  (proxySource.match(/readTextBounded\(req, [A-Z_]+_BYTES\)/g) || []).length === 2);
ok("and the Anthropic one is the tighter shared-key ceiling",
  /readTextBounded\(req, ANTHROPIC_MAX_SHARED_BODY_BYTES\)/.test(proxySource));
ok("the Anthropic path has a body ceiling of its own", /ANTHROPIC_MAX_BODY_BYTES/.test(proxySource));
ok("both upstream reads carry a ceiling too",
  /readTextBounded\(up, MAX_UPSTREAM_BYTES\)/.test(proxySource) && !/await up\.text\(\)/.test(proxySource));
ok("every upstream call goes through the one with a deadline",
  (proxySource.match(/await callUpstream\(/g) || []).length === 2 &&
  !/await fetch\((?!url)/.test(proxySource.slice(proxySource.indexOf("serve(async"))));
ok("the deadline is an AbortController, not a hope", /new AbortController\(\)[\s\S]{0,200}UPSTREAM_TIMEOUT_MS/.test(proxySource));
ok("the timer is always cleared", /finally \{\s*clearTimeout\(timer\);/.test(proxySource.replace(/\n\s*/g, "\n")) || /clearTimeout\(timer\)/.test(proxySource));

console.log("\n== What answers 503, and what the client may do about it ==");
// src/utils/aiClient.js maps a proxy 503 to shared_key_not_configured and then
// persistently disables shared AI on that device, so a 503 is a one-way
// switch. The shipped client reads the body code first now, but this app is a
// PWA with a precache service worker: an installed browser keeps running the
// PREVIOUS bundle after the functions are deployed, and the status is the only
// part of the answer that bundle acts on. So the rule is not "a transient 503
// must carry a distinguishable code", it is "a transient condition must not
// answer 503 at all". ONE thing may be a 503 here: the operator genuinely has
// not configured a key, which is what the old client already believed a 503
// meant.
const proxy503 = proxySource.match(/json\(\s*503[\s\S]{0,200}?\)/g) || [];
ok("there are 503 answers to check", proxy503.length >= 2);
ok("every 503 is the missing key and nothing else", proxy503.every((block) =>
  block.includes("shared_key_not_configured")));
eq("the missing-key 503 is still there, once per provider",
  proxy503.filter((b) => b.includes("shared_key_not_configured")).length, 2);
eq("nothing transient is answered with 503", proxy503.filter((b) =>
  b.includes("AI_CODES.accounting") || b.includes("AI_CODES.rateLimited")).length, 0);
ok("no shape refusal is returned with 503",
  ["model_not_allowed", "request_too_large", "max_output_tokens_out_of_range"]
    .every((code) => !proxy503.some((block) => block.includes(code))));
ok("the accounting code is the one the client is told not to disable on",
  limits.AI_CODES.accounting === "ai_accounting_unavailable");
// The accounting refusal, end to end: the verdict decides the status and the
// handler sends the verdict's own status, so the two cannot drift apart the
// way they did when the handler wrote 503 by hand next to a verdict that said
// something else.
for (const [name, marker] of [["anthropic", 'provider: "anthropic"'], ["gemini", 'provider: "gemini"']]) {
  const i = proxySource.indexOf(`error: AI_CODES.accounting, ${marker}`);
  ok(`the ${name} accounting refusal exists`, i > -1);
  ok(`the ${name} accounting refusal is sent with the verdict's own status, not a literal`,
    i > -1 && proxySource.slice(Math.max(0, i - 40), i).includes("json(admission.status, {"));
}
eq("and that status is 429",
  limits.aiAdmissionVerdict({ error: new Error("boom") }, limits.AI_CODES.quota, null).status, 429);
ok("it still carries Retry-After, because a minute IS a retry",
  /AI_CODES\.accounting[\s\S]{0,300}Retry-After/.test(proxySource));
ok("the burst refusal is a 429 with its own code, not a quota",
  /error: AI_CODES\.rateLimited, provider: "gemini"/.test(proxySource));
ok("the burst refusal carries Retry-After, because it clears in a minute",
  /AI_CODES\.rateLimited[\s\S]{0,300}Retry-After/.test(proxySource));
ok("Gemini still has NO daily cap", !/GEMINI_DAILY|usedToday\("gemini"\)\s*>=/.test(proxySource));
eq("the burst window is a minute, not a day", aiProxy.GEMINI_BURST_WINDOW_MS, 60_000);
ok("the burst ceiling is above a real multi-page scan", aiProxy.GEMINI_BURST_LIMIT >= 20);

console.log("\n== Admission is one statement, and a failure refuses ==");
ok("the daily Anthropic cap no longer counts and then decides",
  !/const used = await usedToday\("anthropic"\)/.test(proxySource));
ok("it reserves instead", /await reserve\(ANTHROPIC_SCOPE, ANTHROPIC_DAILY_LIMIT/.test(proxySource));
ok("the reservation is taken before the upstream call",
  proxySource.indexOf("await reserve(ANTHROPIC_SCOPE") < proxySource.indexOf("callUpstream(ANTHROPIC_MESSAGES_URL"));
ok("the Gemini burst reservation is taken before its upstream call",
  proxySource.indexOf("await reserve(\n      GEMINI_BURST_SCOPE") < proxySource.indexOf("callUpstream(`${GEMINI_BASE}") ||
  proxySource.indexOf("GEMINI_BURST_SCOPE,") < proxySource.indexOf("callUpstream(`${GEMINI_BASE}"));
for (const [name, over, retry] of [["quota", limits.AI_CODES.quota, null], ["burst", limits.AI_CODES.rateLimited, 60]]) {
  const okv = limits.aiAdmissionVerdict({ data: "res-1", error: null }, over, retry);
  ok(`${name}: a reservation id allows the call`, okv.allow === true);
  const full = limits.aiAdmissionVerdict({ data: null, error: null }, over, retry);
  ok(`${name}: no row refuses`, full.allow === false);
  eq(`${name}: no row is a 429`, full.status, 429);
  eq(`${name}: no row carries the caller's over-code`, full.code, over);
  const empty = limits.aiAdmissionVerdict({ data: [], error: null }, over, retry);
  ok(`${name}: an empty array is the same answer`, empty.allow === false && empty.status === 429);
  for (const bad of [undefined, null, { error: new Error("boom") }, { error: { message: "PGRST202" } }]) {
    const v = limits.aiAdmissionVerdict(bad, over, retry);
    ok(`${name}: an unavailable ledger refuses`, v.allow === false);
    // 429, never 503. A 503 is what an already-installed bundle reads as
    // "the shared key is not configured", and it persists that in
    // localStorage, so a ledger outage that lasts seconds would switch a
    // physician off shared AI until they cleared site storage.
    eq(`${name}: an unavailable ledger is a 429`, v.status, 429);
    eq(`${name}: with the accounting code, never the over-code`, v.code, limits.AI_CODES.accounting);
    ok(`${name}: and is retryable`, typeof v.retryAfter === "number" && v.retryAfter > 0);
  }
}

console.log("\n== Bytes are bytes ==");
eq("ASCII is one byte a character", limits.utf8ByteLength("abcdefgh"), 8);
eq("a two-byte character counts two", limits.utf8ByteLength("\u00e9"), 2);
eq("a three-byte character counts three", limits.utf8ByteLength("\u4e2d"), 3);
eq("an astral character counts four, not six", limits.utf8ByteLength("\u{1f600}"), 4);
eq("a lone surrogate counts three rather than throwing", limits.utf8ByteLength("\ud800"), 3);
eq("the empty string is zero", limits.utf8ByteLength(""), 0);
{
  // The bug this replaced: String.length counts UTF-16 units, so a body of
  // three-byte characters measured a third of its real size and a 20 MiB
  // ceiling was really 60 MiB.
  const cjk = "\u4e2d".repeat(1000);
  eq("String.length would have under-counted by 3x", cjk.length, 1000);
  eq("the byte count is the real one", limits.utf8ByteLength(cjk), 3000);
  eq("and requestByteLength uses it when there is no Content-Length",
    limits.requestByteLength(null, cjk), 3000);
  eq("a declared Content-Length still wins, because it is already bytes",
    limits.requestByteLength("3000", cjk), 3000);
}
{
  // The 10 MiB binary the app accepts becomes about 13.34 MiB of base64, and
  // that must still pass. This is the floor the ceiling has to clear.
  const base64MiB = 10 * 1024 * 1024 * 4 / 3;
  ok("a 10 MiB attachment's base64 is under the Gemini ceiling", base64MiB < aiProxy.GEMINI_MAX_BODY_BYTES);
  ok("and under the Anthropic ceiling", base64MiB < aiProxy.ANTHROPIC_MAX_BODY_BYTES);
  ok("with room left for the prompt and the JSON envelope",
    aiProxy.GEMINI_MAX_BODY_BYTES - base64MiB > 5 * 1024 * 1024);
}

// The refusal body is whatever geminiRequestProblem returned, and the Gemini
// half must hand it to json() with 400 and nothing else. Checking for the
// code strings alone would be satisfied by the Anthropic path, which has its
// own model_not_allowed.
ok("the shape refusal is answered with 400", /if \(problem\) return json\(400, problem\);/.test(geminiHalf));
ok("the shape refusal is never handed to another status",
  !/return json\((?!400, problem\))\d+, problem\)/.test(geminiHalf));
ok("the pre-read size refusal is also a 400",
  /return json\(400, \{ error: "request_too_large", max_bytes: GEMINI_MAX_BODY_BYTES \}\);/.test(geminiHalf));
for (const code of ["model_not_allowed", "request_too_large", "max_output_tokens_out_of_range"]) {
  ok(`${code} is a code geminiRequestProblem returns`, geminiRequestProblemSource.includes(`"${code}"`));
}
ok("no per-physician Gemini quota was added", !/gemini[^\n]*quota/i.test(proxySource.replace(/^\s*\*.*$/gm, "")));

console.log("\n== The bounds match what the client actually asks for ==");
// This is the compatibility guard. If someone lowers a bound, or the client
// raises a request, this fails here rather than in a physician's CV import.
// Scanned by DISCOVERY, not by a hand-kept file list. The Gemini upgrade
// centralised the model and the request policy into geminiModel.js and moved
// the output allowance into geminiJsonConfig(n) calls, and a fixed list of
// callers silently stopped finding either. A guard that quietly finds nothing
// is worse than no guard: it reports a pass.
const clientFiles = readdirSync(new URL("../src/utils/", import.meta.url))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ["../src/utils/" + f, read("../src/utils/" + f)]);

const askedModels = new Set();
for (const [, src] of clientFiles) {
  for (const m of src.matchAll(/GEMINI_MODEL\s*=\s*"([^"]+)"/g)) askedModels.add(m[1]);
  for (const m of src.matchAll(/\{\s*model:\s*"(gemini-[^"]+)"/g)) askedModels.add(m[1]);
  for (const m of src.matchAll(/"(gemini-[0-9][^"]*)"/g)) askedModels.add(m[1]);
}
ok("the scan found the model the client asks for at all", askedModels.size >= 1);
ok("and it is the upgraded one", askedModels.has("gemini-3.8-flash"));
for (const model of askedModels) {
  ok(`the allowlist covers the model the client asks for: ${model}`, GEMINI_MODEL_ALLOWLIST.has(model));
}

const askedTokens = new Set();
for (const [, src] of clientFiles) {
  for (const m of src.matchAll(/maxOutputTokens:\s*(\d+)/g)) askedTokens.add(Number(m[1]));
  for (const m of src.matchAll(/MAX_OUTPUT_TOKENS\s*=\s*(\d+)/g)) askedTokens.add(Number(m[1]));
  // The upgrade's shape: geminiJsonConfig(n) carries the allowance.
  for (const m of src.matchAll(/geminiJsonConfig\((\d+)\)/g)) askedTokens.add(Number(m[1]));
}
ok("the scan found output allowances at all", askedTokens.size >= 3);
ok("the CV reader's 32768 is still asked for", askedTokens.has(32768));
ok("the statement scanner's 16384 is still asked for", askedTokens.has(16384));
for (const n of [...askedTokens].sort((a, b) => a - b)) {
  ok(`the ceiling is above the client's ${n}`, n <= GEMINI_MAX_OUTPUT_TOKENS);
}

console.log("\n== The bound actually stops the read ==");
// The failure this closes is not theoretical and not visible in a Content-
// Length check: a chunked request declares no length, so the header check is
// skipped and the read runs to whatever the sender feels like sending. These
// drive the real function with a real stream.
const chunkOf = (n, byte = 97) => new Uint8Array(n).fill(byte);
const streamOf = (chunks, { afterCancel } = {}) => {
  let i = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() { cancelled = true; if (afterCancel) afterCancel(); },
  });
  return { body, text: async () => { throw new Error("text() must not be used when a stream is available"); }, wasCancelled: () => cancelled };
};

{
  const src = streamOf([chunkOf(10), chunkOf(10)]);
  const r = await limits.readTextBounded(src, 100);
  ok("a small body reads fine", r.ok && !r.tooLarge);
  eq("and reports its real byte count", r.bytes, 20);
  eq("and its text", r.text.length, 20);
}
{
  const src = streamOf([chunkOf(60), chunkOf(60), chunkOf(60)]);
  const r = await limits.readTextBounded(src, 100);
  ok("a body past the ceiling is refused", !r.ok && r.tooLarge);
  ok("and the text is not handed back half-read", r.text === "");
  ok("and the stream is cancelled rather than drained", src.wasCancelled());
  ok("it stopped at the ceiling, not at the body's size", r.bytes <= 60 * 2);
}
{
  // Exactly at the ceiling is allowed; one byte past is not.
  const at = await limits.readTextBounded(streamOf([chunkOf(100)]), 100);
  ok("exactly at the ceiling passes", at.ok && at.bytes === 100);
  const past = await limits.readTextBounded(streamOf([chunkOf(101)]), 100);
  ok("one byte past does not", !past.ok && past.tooLarge);
}
{
  // A multi-byte character split across two chunks must decode once.
  const euro = new TextEncoder().encode("\u20ac");   // 3 bytes
  const r = await limits.readTextBounded(streamOf([euro.slice(0, 2), euro.slice(2)]), 100);
  ok("a character split across chunks decodes correctly", r.ok && r.text === "\u20ac");
  eq("and is measured in bytes", r.bytes, 3);
}
{
  const failing = { body: new ReadableStream({ pull() { throw new Error("connection reset"); } }), text: async () => "" };
  const r = await limits.readTextBounded(failing, 100);
  ok("a stream error is reported, not thrown", !r.ok && !r.tooLarge);
  ok("and it says what happened", /connection reset/.test(r.error || ""));
}
{
  // No stream at all (an empty body) still works and is still bounded.
  const r = await limits.readTextBounded({ body: null, text: async () => "abc" }, 100);
  ok("a bodyless source reads", r.ok && r.text === "abc");
  const big = await limits.readTextBounded({ body: null, text: async () => "a".repeat(200) }, 100);
  ok("and is still refused when too large", !big.ok && big.tooLarge);
}

console.log("\n== The AI admission ledger's migration ==");
{
  const g = read("../supabase/migrations/20260915g_ai_reservations.sql");
  const code = g.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  ok("the table exists", /create table if not exists public\.ai_reservations/.test(code));
  ok("RLS is on", /alter table public\.ai_reservations enable row level security/.test(code));
  ok("no policy is created for it, so no user role can read or write it",
    !/create policy[^;]*on public\.ai_reservations/.test(code));
  ok("PUBLIC is revoked, not just the two role names",
    /revoke all on table public\.ai_reservations from public/.test(code));
  ok("anon and authenticated are revoked by name too",
    /from anon/.test(code) && /from authenticated/.test(code));
  ok("the service role's grant is explicit",
    /grant select, insert on table public\.ai_reservations to service_role/.test(code));
  ok("and it is append-only: the writer cannot delete the evidence",
    /revoke all on table public\.ai_reservations from service_role;\s*grant select, insert on table public\.ai_reservations to service_role;/.test(code));
  ok("the reservation counts and inserts in ONE statement",
    /insert into public\.ai_reservations[\s\S]{0,400}?where \(\s*select count\(\*\)/.test(code));
  ok("behind a per-user, per-scope advisory lock",
    /pg_advisory_xact_lock\(hashtext\('public\.reserve_ai_call:' \|\| p_scope\), hashtext\(p_user::text\)\)/.test(code));
  ok("the function is security invoker, not definer",
    /security invoker/.test(code) && !/create or replace function public\.reserve_ai_call[\s\S]{0,400}security definer/.test(code));
  ok("only the service role may execute it",
    /grant execute on function public\.reserve_ai_call\(uuid, text, integer, timestamptz\) to service_role/.test(code));
  ok("the edge function is not given a way to delete its own ledger",
    !/delete from public\.ai_reservations/.test(code.replace(/create or replace function public\.prune_ai_reservations[\s\S]*?\$\$;/, "")));
  ok("pruning is a scheduled server job, like the other prunes",
    /prune_ai_reservations/.test(code) && /cron\.schedule\('prune-ai-reservations'/.test(code));
  ok("applying it without pg_cron is not an error",
    /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/.test(code));
  ok("ai_usage is left alone as the cost ledger", !/alter table public\.ai_usage|drop .*ai_usage/.test(code));
  ok("the scope names match the ones the proxy sends",
    code.includes("scope") && proxySource.includes('GEMINI_BURST_SCOPE = "gemini_burst"') && proxySource.includes('ANTHROPIC_SCOPE = "anthropic"'));
}

ok("the send ledger is append-only for its writer too",
  /revoke all on table public\.send_reservations from service_role;\s*grant select, insert on table public\.send_reservations to service_role;/.test(sqlCode));
ok("and the send ledger still revokes PUBLIC, not just the two role names",
  /revoke all on table public\.send_reservations from public;/.test(sqlCode));

console.log("\n== A client that hangs up stops paying ==");
// The deadline bounded how long we would WAIT. Nothing connected the incoming
// request's signal to the outgoing one, so a physician who closed the tab left
// a paid provider call running to completion on the operator's key.
{
  const body = proxySource.slice(proxySource.indexOf("const callUpstream = async"));
  const fn = body.slice(0, body.indexOf("\n  };") + 5);
  ok("the upstream call reads the incoming request's signal", /const client = req\.signal;/.test(fn));
  ok("an already-aborted client aborts it immediately", /if \(client\?\.aborted\) abort\.abort\(\);/.test(fn));
  ok("and a later hangup relays through", /client\?\.addEventListener\("abort", relay, \{ once: true \}\)/.test(fn));
  ok("the listener is removed, so a long-lived signal does not accumulate them",
     /client\?\.removeEventListener\("abort", relay\)/.test(fn));
  ok("the deadline is still there as well", /UPSTREAM_TIMEOUT_MS/.test(fn));
  ok("and the timer is still always cleared", /clearTimeout\(timer\)/.test(fn));
  ok("both upstream calls go through it, so neither path is unlinked",
     (proxySource.match(/await callUpstream\(/g) || []).length === 2);
}

console.log("\n== The Gemini upgrade's envelope ==");
// The allowlist is the SERVER's permission list. It may lead the client and it
// must never lag it: if the client shipped a model this set does not carry,
// the proxy answers model_not_allowed to every scan on the shared key.
{
  const ok200 = (path, body) => geminiRequestProblem(path, body, 1000) === null;
  ok("gemini-3.8-flash is allowed", aiProxy.GEMINI_MODEL_ALLOWLIST.has("gemini-3.8-flash"));
  ok("and the models it replaces are still allowed, so a rollback works",
     ["gemini-2.5-flash", "gemini-2.5-pro"].every((m) => aiProxy.GEMINI_MODEL_ALLOWLIST.has(m)));
  ok("a 3.8-flash generateContent call passes the envelope",
     ok200("models/gemini-3.8-flash:generateContent", { contents: [{ parts: [{ text: "hi" }] }] }));
  ok("countTokens on it passes too",
     ok200("models/gemini-3.8-flash:countTokens", { contents: [{ parts: [{ text: "hi" }] }] }));
  // The upgrade's request shape, pinned so a later tightening cannot silently
  // start refusing it: thinkingConfig at LOW with includeThoughts false.
  ok("thinkingConfig LOW with includeThoughts false is permitted",
     ok200("models/gemini-3.8-flash:generateContent", {
       contents: [{ parts: [{ text: "hi" }] }],
       generationConfig: { thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } },
     }));
  ok("and alongside a maxOutputTokens the app actually asks for",
     ok200("models/gemini-3.8-flash:generateContent", {
       contents: [{ parts: [{ text: "hi" }] }],
       generationConfig: { maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } },
     }));
  ok("a systemInstruction is still permitted",
     ok200("models/gemini-3.8-flash:generateContent", {
       systemInstruction: { parts: [{ text: "you are" }] }, contents: [{ parts: [{ text: "hi" }] }],
     }));
  // The gate still gates.
  ok("an unlisted model is still refused",
     geminiRequestProblem("models/gemini-9.9-ultra:generateContent", { contents: [] }, 10)?.error === "model_not_allowed");
  ok("the output ceiling still applies to the new model",
     geminiRequestProblem("models/gemini-3.8-flash:generateContent",
       { contents: [], generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS + 1 } }, 10)?.error === "max_output_tokens_out_of_range");
  ok("the size ceiling still applies to the new model",
     geminiRequestProblem("models/gemini-3.8-flash:generateContent", { contents: [] }, GEMINI_MAX_BODY_BYTES + 1)?.error === "request_too_large");
}
{
  // Budget reservations must price through priceFor(model, date), never off
  // the raw table, because the upgrade introduces a 2027 step.
  const pricing = read("../supabase/functions/_shared/aiPricing.ts");
  ok("priceFor takes the request date", /export function priceFor\(model: unknown, at: Date/.test(pricing));
  ok("and it is honoured, not ignored", /AI_PRICE_CHANGES/.test(pricing) && /timestamp >= Date\.parse\(change\.effectiveAt\)/.test(pricing));
  ok("and the rule for budget reservations is written down where they will look",
     /never read[\s*]+AI_PRICES[\s*]+directly/.test(pricing));
  // The proxy prices a call from when it STARTED, so a call spanning a rate
  // change is priced once, at the rate it began under.
  ok("the proxy passes a request-start instant to meterUsage",
     /const requestStartedAt = new Date\(\);/.test(proxySource) &&
     (proxySource.match(/meterUsage\([\s\S]{0,120}?requestStartedAt\)/g) || []).length === 2);
}

console.log("\n== The monthly dollar cap is a cap ==");
// It was not one. monthSpentUsd wrapped its query in try/catch and returned 0
// on any error, so breaking the query was the cheapest route past the budget;
// and at $14.99 of $15 eight concurrent calls all passed, because the daily
// reservation made the COUNT atomic and did nothing for the DOLLARS.
{
  const { anthropicWorstCaseFromTokens, countedInputTokens, countPayload } = limits;
  const opus = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

  // There is no local estimate of input tokens any more. The byte bound that
  // used to live here assumed a token is at least two bytes of JSON, which was
  // an allowance written as though it were a measurement: nothing establishes
  // it, a compressed image breaks it by four orders of magnitude, and the
  // reviewer was right to refuse it as a basis for a cap. Every admitted
  // request is now counted by the provider instead, so the only arithmetic
  // left here is what to do with a count.
  eq("16k in and 16k out on Opus, at the cache-write rate",
     anthropicWorstCaseFromTokens(opus, 16_000, 16_000), 0.5);
  ok("input is priced at the HIGHER of input and cache-write",
     anthropicWorstCaseFromTokens({ input: 1, output: 0, cacheWrite: 9 }, 4_000, 0) >
     anthropicWorstCaseFromTokens({ input: 1, output: 0 }, 4_000, 0));
  eq("a malformed rate is NOT priced as zero", anthropicWorstCaseFromTokens({ input: NaN, output: 25 }, 1000, 10), null);
  eq("nor is a missing one", anthropicWorstCaseFromTokens({ output: 25 }, 1000, 10), null);
  eq("no price line means no estimate, and no estimate means no spending", anthropicWorstCaseFromTokens(null, 1000, 1000), null);
  eq("no count means no reservation", anthropicWorstCaseFromTokens(opus, null, 1000), null);
  eq("a free call is zero, not null", anthropicWorstCaseFromTokens({ input: 0, output: 0 }, 1000, 1000), 0);
  ok("the reservation rounds UP, so it never under-states itself",
     anthropicWorstCaseFromTokens({ input: 1, output: 0 }, 1, 0) > 0);
  ok("the byte bound is gone rather than merely unused",
     limits.BYTES_PER_TOKEN_FLOOR === undefined && limits.boundedInputTokens === undefined
     && limits.anthropicWorstCaseUsd === undefined);

  // The count is a non-negative safe integer or it is not a count. Number()
  // said otherwise about all four of these, and a malformed counter reply
  // reserved nothing while the paid request went out regardless.
  for (const bad of [null, false, "", [], "1296", {}, undefined, 12.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    eq(`a count of ${JSON.stringify(bad) ?? "undefined"} is not a count`, countedInputTokens(bad), null);
  }
  eq("a real count carries the stated margin", countedInputTokens(1000), 1100);
  eq("and zero is a legitimate count", countedInputTokens(0), 0);
  // The margin must not carry a count out of the safe range: a number that is
  // no longer exactly representable is not a count, whatever it would reserve.
  eq("a count whose margin would overflow the safe range is refused",
     countedInputTokens(Number.MAX_SAFE_INTEGER), null);
  ok("but a large, representable count still passes",
     countedInputTokens(1_000_000) === 1_100_000);
  eq("the margin is declared, not buried", limits.TOKEN_COUNT_MARGIN, 1.1);

  // The claim in the code has to match what the provider actually guarantees.
  // It guarantees nothing numeric: "a small amount" is the whole of it. Three
  // versions of this comment claimed a hard cap the code never had, so the
  // absence of that claim is now itself asserted.
  {
    const src = readFileSync(new URL("../supabase/functions/ai-proxy/limits.ts", import.meta.url), "utf8");
    ok("the comment says plainly that this is not a hard cap",
       /NOT A MATHEMATICALLY HARD CAP/.test(src));
    ok("and names the only documented hard bound, and why it is not used",
       /context window/.test(src) && /1,000,000 input tokens/.test(src) && /\$6\.25/.test(src));
    ok("and does not describe the margin as a provider guarantee",
       !/provider-backed hard guarantee|guaranteed within 10|hard bound of ten percent/i.test(src));
  }

  // Shapes the counter cannot describe are refused, not counted in part.
  eq("an MCP connector is refused", limits.uncountableOption({ mcp_servers: [{ url: "x" }] }), "mcp_servers");
  eq("so is a server tool", limits.uncountableOption({ tools: [{ type: "web_search_20260209", name: "web_search" }] }),
     "tools[].type=web_search_20260209");
  eq("and a container", limits.uncountableOption({ container: "c" }), "container");
  eq("a plain custom tool is fine", limits.uncountableOption({ tools: [{ name: "t", input_schema: { type: "object" } }] }), null);
  eq("and one that says so explicitly", limits.uncountableOption({ tools: [{ type: "custom", name: "t" }] }), null);
  eq("an ordinary body is fine", limits.uncountableOption({ model: "m", messages: [] }), null);

  // The count request is DERIVED from the request that will be paid for, so a
  // field that changes what the provider reads cannot reach one and not the
  // other. output_config adds billed instructions; thinking and cache_control
  // change what is read. The previous version copied five fields by name and
  // dropped exactly these three.
  {
    const body = {
      model: "claude-opus-5", max_tokens: 1024, temperature: 0.5, stream: false,
      metadata: { user_id: "x" }, top_p: 0.9, top_k: 4, stop_sequences: ["x"], service_tier: "auto",
      messages: [{ role: "user", content: "hi" }],
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t", input_schema: { type: "object" } }], tool_choice: { type: "auto" },
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
    };
    const counted = countPayload(body);
    for (const k of ["output_config", "thinking", "cache_control", "system", "tools", "tool_choice", "messages", "model"]) {
      ok(`the counter is told about ${k}`, Object.prototype.hasOwnProperty.call(counted, k));
    }
    for (const k of ["max_tokens", "stream", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "service_tier"]) {
      ok(`and not about ${k}, which it does not accept`, !Object.prototype.hasOwnProperty.call(counted, k));
    }
    // The endpoint documents exactly eight body parameters. Forwarding a ninth
    // is a 400, which refuses the request; the protection against a field
    // added later is uncountableOption, not the shape of this list.
    eq("the accepted set is the documented eight", limits.COUNT_ACCEPTED_FIELDS.length, 8);
    ok("an unknown field is NOT forwarded to an endpoint that would reject it",
       !Object.prototype.hasOwnProperty.call(countPayload({ ...body, some_future_option: 1 }), "some_future_option"));
    eq("a body with no model is not countable", countPayload({ messages: [] }), null);
    eq("nor one with no messages", countPayload({ model: "claude-opus-5" }), null);
    eq("nor a non-object", countPayload("nope"), null);
  }

  // The prompt ceiling still bounds what can be SENT, which is what keeps the
  // count request itself small; it no longer prices anything.
  const ceiling = aiProxy.ANTHROPIC_MAX_SHARED_BODY_BYTES;
  ok("there is a body ceiling at all", typeof ceiling === "number" && ceiling > 0);
  ok("and the ceiling is comfortably above anything the app sends", ceiling >= 256 * 1024);

  // Options the rate table cannot price are refused, not admitted at one price
  // and billed at another.
  eq("one-hour cache creation is refused",
     limits.unpricedOption({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] }),
     "cache_control.ttl=1h");
  eq("US-only inference is refused", limits.unpricedOption({ inference_geo: "us" }), "inference_geo");
  eq("the five-minute cache the table DOES price is allowed",
     limits.unpricedOption({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } }] }), null);
  eq("and an ordinary request is allowed", limits.unpricedOption({ messages: [{ role: "user", content: "hi" }] }), null);
}
{
  const src = proxySource;
  ok("the fail-open month query is gone from the cap", !/const spent = await monthSpentUsd\(\);/.test(src));
  ok("admission holds dollars instead", /await holdSpend\(worst\)/.test(src));
  ok("priced through priceFor with the request instant", /priceFor\(body\.model, requestStartedAt\)/.test(src));
  ok("never off the raw table", !/AI_PRICES/.test(src));
  ok("an unpriced model refuses rather than spending uncapped",
     /refusing rather than spending uncapped/.test(src));
  ok("a ledger that cannot answer refuses retryably, with 429 not 503",
     /spend\.outcome !== "held"[\s\S]{0,320}?json\(429, \{ error: AI_CODES\.accounting/.test(src));
  ok("over budget still routes to Gemini, so it is NO_RETRY not a hard stop",
     /error: "budget"[\s\S]{0,200}NO_RETRY/.test(src));
  eq("the hold settles on EVERY exit from the call, not only success",
     (src.match(/settleSpend\(spendHold/g) || []).length, 3);
  ok("an unknown cost settles at the worst case", /await settleSpend\(spendHold, null\)/.test(src));
  ok("a refused upstream settles at zero rather than holding the month",
     /upstreamOk \? null : 0/.test(src));
  ok("the body ceiling refuses before any of it", /error: "request_too_large", max_bytes: ANTHROPIC_MAX_SHARED_BODY_BYTES/.test(src));
  // Now spelled as a named code rather than a literal, so the client and the
  // proxy cannot drift on the string; the value itself is pinned below.
  ok("unpriced options are refused", /error: AI_CODES\.unpricedOption, option: unpriced/.test(src));
  ok("the reservation is taken from the provider's count, not from the body",
     /anthropicWorstCaseFromTokens\(line\?\.price, countedInputTokens\(counted\), maxTokens\)/.test(src));
  ok("and EVERY request is counted, not only the ones carrying media",
     !/hasMeteredMedia/.test(src));
  ok("the count payload is derived from the body that will be sent",
     /const toCount = countPayload\(body\)/.test(src) && /countInputTokens\(callUpstream, toCount/.test(src));
  ok("a count that does not answer refuses rather than falling back to an estimate",
     /counted === null[\s\S]{0,260}?AI_CODES\.countUnavailable/.test(src));
  ok("and the old walk is kept only as telemetry", /Telemetry only/.test(src));
  ok("Gemini is NOT coupled to dollars: its path never holds spend",
     !/holdSpend/.test(src.slice(src.indexOf("---- POST: forward one Gemini call ----"))));
  ok("and Gemini still has no daily cap", !/GEMINI_DAILY/.test(src));
  ok("the status figure reads the ledger the cap reads",
     /from\("ai_spend_holds"\)/.test(src));
}
{
  const sql = read("../supabase/migrations/20260916c_ai_spend_holds.sql");
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  ok("the cap test IS the WHERE of the insert that takes the money",
     /insert into public\.ai_spend_holds[\s\S]{0,400}?where \([\s\S]{0,260}?<= p_cap_usd/.test(code));
  ok("there is no null-budget escape in it", !/p_cap_usd is null or\s*\(/.test(code));
  ok("a null, zero or negative cap REFUSES", /p_cap_usd is null or p_cap_usd = 'NaN'::numeric or not \(p_cap_usd > 0\)/.test(code));
  ok("NaN is tested the way Postgres actually works", /= 'NaN'::numeric/.test(code));
  ok("and the constraint rejects it too", /<> 'NaN'::numeric/.test(code));
  ok("settlement records the truth, even above the reservation",
     !/p_actual_usd <= amount_usd/.test(code) && /set amount_usd = p_actual_usd/.test(code));
  ok("and an overspend is named rather than hidden", /over_reservation/.test(code) && /raise warning/.test(code));
  ok("the constraint no longer forbids recording it", !/amount_usd <= worst_case_usd\)/.test(code));
  ok("the cutover seeds this month's already-billed Anthropic calls",
     /seeded_from_usage/.test(code) && /from public\.ai_usage u/.test(code));
  ok("and seeding twice does not double-count", /on conflict \(seeded_from_usage\) where seeded_from_usage is not null do nothing/.test(code));
  ok("the month comes from the database clock, never the caller",
     /date_trunc\('month', now\(\) at time zone 'utc'\)/.test(code) && !/p_month/.test(code));
  ok("nothing prunes this table by age", !/delete from public\.ai_spend_holds/.test(code));
  ok("the writer cannot delete the month", /revoke all on table public\.ai_spend_holds from service_role/.test(code));
  ok("it holds only what it needs", /grant select, insert, update on table public\.ai_spend_holds to service_role/.test(code));
  ok("the worst case is kept as evidence beside the settled amount",
     /worst_case_usd numeric/.test(code) && /reserved_usd/.test(code));
}

console.log("\n== House rules ==");
for (const [name, text] of [
  ["send-packet-email/index.ts", sendSource],
  ["ai-proxy/index.ts", proxySource],
  ["20260915e_send_reservations.sql", sql],
  ["20260915g_ai_reservations.sql", read("../supabase/migrations/20260915g_ai_reservations.sql")],
  ["20260916c_ai_spend_holds.sql", read("../supabase/migrations/20260916c_ai_spend_holds.sql")],
  ["ai-proxy/limits.ts", read("../supabase/functions/ai-proxy/limits.ts")],
  ["send-throttle.test.mjs", read(import.meta.url)],
]) {
  ok(`${name} has no em dash`, !text.includes("\u2014"));
}

console.log("\n== Source forms the request body does not carry ==");
// Refusing url and file sources was the third of four repairs and is kept even
// though the reserve no longer comes from body size at all. Two reasons it
// still earns its place: the provider would fetch that content itself during
// counting, which makes admission depend on a third party's availability and
// on content nobody here has seen; and nothing in the app sends either form,
// so the refusal costs the product nothing. Every attachment is read in the
// browser and posted as base64 (src/utils/assistant.js).
{
  const { unboundedSource, AI_CODES } = limits;
  const urlImage = { model: "claude-opus-5", max_tokens: 0, messages: [
    { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }] }] };

  // So the shared key does not take the form at all.
  eq("a URL image is refused", unboundedSource(urlImage), "image.source.type=url");
  eq("a URL document too", unboundedSource({ messages: [{ role: "user", content: [
     { type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }] }] }),
     "document.source.type=url");
  eq("and a Files API reference", unboundedSource({ messages: [{ role: "user", content: [
     { type: "document", source: { type: "file", file_id: "file_123" } }] }] }),
     "document.source.type=file");
  eq("a source with no type is refused rather than walked past", unboundedSource({ messages: [
     { role: "user", content: [{ type: "image", source: { url: "https://example.invalid/a.png" } }] }] }),
     "image.source.type=(missing)");
  eq("an unknown future form is refused too, because the list is an allowlist",
     unboundedSource({ messages: [{ role: "user", content: [
       { type: "image", source: { type: "something_new", id: "x" } }] }] }),
     "image.source.type=something_new");

  // Negative controls: everything the app actually sends must still go.
  eq("a base64 image is admitted", unboundedSource({ messages: [{ role: "user", content: [
     { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }] }), null);
  eq("a base64 PDF is admitted", unboundedSource({ messages: [{ role: "user", content: [
     { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }] }] }), null);
  eq("a plain-text document is admitted", unboundedSource({ messages: [{ role: "user", content: [
     { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } }] }] }), null);
  eq("nested content blocks are admitted, and walked", unboundedSource({ messages: [{ role: "user", content: [
     { type: "document", source: { type: "content", content: [
       { type: "text", text: "hi" }] } }] }] }), null);
  eq("a nested URL source inside a content document is still caught",
     unboundedSource({ messages: [{ role: "user", content: [
       { type: "document", source: { type: "content", content: [
         { type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }] } }] }] }),
     "image.source.type=url");
  eq("an ordinary text-only call is admitted",
     unboundedSource({ model: "claude-opus-5", messages: [{ role: "user", content: "hello" }] }), null);
  eq("a body that is not an object is not an error", unboundedSource("nope"), null);

  eq("the refusal code is stable and named", AI_CODES.unboundedSource, "source_not_allowed");
  eq("and so is the option one it sits beside", AI_CODES.unpricedOption, "option_not_allowed");
}
{
  // And it happens BEFORE the money is reserved, not after.
  const src = proxySource;
  ok("the proxy refuses unbounded sources", /error: AI_CODES\.unboundedSource, source: unbounded/.test(src));
  ok("before it holds any spend",
     src.indexOf("unboundedSource(body)") < src.indexOf("holdSpend("));
  ok("and the exact measurement is written down next to the refusal",
     /178 bytes reserved/.test(src) && /\$15\.0055/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
