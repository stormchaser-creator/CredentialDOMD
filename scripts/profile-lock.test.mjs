// Checks for the two guards added on 2026-09-15 (audit item 3):
//
//   supabase/migrations/20260915a_lock_profile_insert.sql
//     a BEFORE INSERT trigger on profiles, so a fresh Clerk account cannot
//     insert itself with access_status = 'active' (which is what ai-proxy
//     checks before handing out the shared AI keys) or with a founding
//     number it never earned.
//
//   supabase/migrations/20260915c_ticket_admission.sql
//     the create-ticket eligibility gate restated on the TABLE, so the same
//     account cannot POST a ticket straight to PostgREST and have the
//     unattended agent read it an hour later.
//
//   scripts/ticket-agent.sh
//     the same eligibility condition on both of the runner's queries, so an
//     ineligible row cannot reach the prompt even if the policy above is
//     missed or rolled back.
//
// A plpgsql trigger cannot run under node, and there is no scratch Postgres
// in this repo, so these are text invariants over the real files: the shape
// the guard must have, checked against the shape it does have. The behaviour
// the text cannot prove is listed in MANUAL_CASES at the bottom and printed
// with the results, so a reviewer sees exactly what was not machine-checked.
//
// Run: node scripts/profile-lock.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const read = (rel) => readFileSync(join(repo, rel), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

// A guard that only exists in a comment is not a guard. Everything below that
// asks "does the code say X" is asked of the file with its -- comments
// stripped, never of the raw text.
const stripComments = (sql) =>
  sql.split("\n").map((line) => {
    const i = line.indexOf("--");
    return i === -1 ? line : line.slice(0, i);
  }).join("\n");

// The body of one create-or-replace function, from its header to the $$; that
// closes it. Returns "" when the function is absent, so every assertion about
// it fails rather than passing vacuously.
const functionBody = (sql, name) => {
  const start = sql.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = sql.indexOf("$$;", start);
  return end === -1 ? "" : sql.slice(start, end + 3);
};

const LOCK_INSERT = "supabase/migrations/20260915a_lock_profile_insert.sql";
const ADMISSION  = "supabase/migrations/20260915c_ticket_admission.sql";
const ATTRIBUTION = "supabase/migrations/20260915f_ticket_update_and_attribution.sql";
const AGENT      = "scripts/ticket-agent.sh";
const ACCESS_GRANT_MIGRATION = "supabase/migrations/20260902h_access_grant_flag.sql";
const FOUNDING_MIGRATION     = "supabase/migrations/20260902g_founding_members.sql";

const lockRaw  = read(LOCK_INSERT);
const lockSql  = stripComments(lockRaw).toLowerCase();
const admitRaw = read(ADMISSION);
const admitSql = stripComments(admitRaw).toLowerCase();
const attribRaw = read(ATTRIBUTION);
const attribSql = stripComments(attribRaw).toLowerCase();
const agentRaw = read(AGENT);

console.log("\n── The INSERT lock exists and is a BEFORE INSERT on profiles ──");

// The whole defect was that lock_profile_identity is BEFORE UPDATE only. An
// AFTER trigger cannot rewrite NEW, and a BEFORE UPDATE one never fires for
// a row that arrives already active, so both the timing and the event matter.
const triggerStmt = (() => {
  const m = lockSql.match(/create\s+trigger\s+profiles_lock_insert([\s\S]*?);/);
  return m ? m[0].replace(/\s+/g, " ") : "";
})();
ok("a trigger named profiles_lock_insert is created", triggerStmt !== "");
ok("it fires BEFORE, not AFTER (an AFTER trigger cannot rewrite NEW)", /before/.test(triggerStmt));
ok("it fires on INSERT", /before\s+insert/.test(triggerStmt));
ok("it is on public.profiles", /on\s+public\.profiles/.test(triggerStmt));
ok("it is FOR EACH ROW, not a statement trigger", /for\s+each\s+row/.test(triggerStmt));
ok("it executes lock_profile_insert()", /execute\s+function\s+public\.lock_profile_insert\(\)/.test(triggerStmt));
ok("the trigger is dropped by name first, so re-applying cannot leave two",
  /drop\s+trigger\s+if\s+exists\s+profiles_lock_insert\s+on\s+public\.profiles/.test(lockSql));
ok("it carries no WHEN clause: an insert cannot opt itself out", !/\bwhen\s*\(/.test(triggerStmt));

console.log("\n── Every server-owned column is forced, not merely mentioned ──");

const body = functionBody(lockSql, "public.lock_profile_insert");
ok("lock_profile_insert() has a body", body.length > 0);
ok("the function is SECURITY DEFINER, like the UPDATE lock", /security\s+definer/.test(body));
ok("its search_path is pinned to public", /set\s+search_path\s+to\s+'public'/.test(body));
ok("it returns trigger", /returns\s+trigger/.test(body));

// Read off the live public.profiles on 2026-09-15: these are the columns a
// caller must not be able to seed. profiles carries no billing column at all
// (stripe ids live on public.subscriptions, which has no INSERT policy), so
// there is no fourth name here; if one is ever added, add it to this list and
// the test will fail until the trigger covers it.
const SERVER_OWNED = ["access_status", "founding_number", "is_founding_member"];
for (const col of SERVER_OWNED) {
  ok(`${col} is assigned on NEW inside the function`,
    new RegExp(`new\\.${col}\\s*:=`).test(body));
}
ok("access_status is forced to pending, not to anything else",
  /new\.access_status\s*:=\s*'pending'/.test(body));
ok("founding_number is nulled (numbers come from assign_founding_number)",
  /new\.founding_number\s*:=\s*null/.test(body));
ok("is_founding_member is forced false, not null (the column default is false)",
  /new\.is_founding_member\s*:=\s*false/.test(body));
ok("the forcing is inside an 'if not privileged' branch, not unconditional",
  /if\s+not\s+privileged\s+then/.test(body));
ok("the branch closes before the function returns NEW",
  /end\s+if;[\s\S]*return\s+new;/.test(body));
ok("no column is forced by raising instead of rewriting (ensureProfile must keep working)",
  !/raise\s+exception/.test(body));
ok("the profiles table is not dropped or recreated to add the trigger",
  !/create\s+table\s+public\.profiles/.test(lockSql));

console.log("\n── The privileged escape mirrors the UPDATE lock ──");

// 20260902h is the live definition of lock_profile_identity. Whatever counts
// as privileged there must count as privileged here, or the webhook, the
// admin RPC or a direct SQL fix would behave differently on INSERT than on
// UPDATE, which is how the first hole opened.
const updateLock = functionBody(stripComments(read(ACCESS_GRANT_MIGRATION)).toLowerCase(), "public.lock_profile_identity");
ok("the UPDATE lock was found to compare against", updateLock.length > 0);

const ESCAPES = [
  ["direct SQL (auth.jwt() is null)", /auth\.jwt\(\)\s+is\s+null/],
  ["the service_role JWT", /'service_role'/],
  ["the credentialdomd.access_grant transaction flag", /credentialdomd\.access_grant/],
];
for (const [label, re] of ESCAPES) {
  ok(`the UPDATE lock recognises ${label}`, re.test(updateLock));
  ok(`the INSERT lock recognises ${label} too`, re.test(body));
}
ok("both read the role out of the JWT the same way",
  /auth\.jwt\(\)\s*->>\s*'role'/.test(body) && /auth\.jwt\(\)\s*->>\s*'role'/.test(updateLock));
ok("the INSERT lock adds no escape the UPDATE lock does not have (no founding_assign, no is_admin)",
  !/founding_assign/.test(body) && !/is_admin/.test(body));

console.log("\n── The header cites the two migrations that stated the intent ──");
ok("it cites 20260819_lock_access_status.sql", lockRaw.includes("20260819_lock_access_status.sql"));
ok("it cites 20260902g_founding_members.sql", lockRaw.includes("20260902g_founding_members.sql"));
ok("20260902g really does call founding_number server-owned",
  read(FOUNDING_MIGRATION).includes("Server-owned; never written by the app"));

console.log("\n── Ticket admission: ownership AND eligibility, one policy each ──");

const policyStmt = (sql, name) => {
  const m = sql.match(new RegExp(`create\\s+policy\\s+${name}[\\s\\S]*?;`));
  return m ? m[0].replace(/\s+/g, " ") : "";
};
// Which FILE owns each policy. messages_thread_insert used to be defined in
// both c and f, and only f's copy carried the attribution clause, so whichever
// file ran last decided the policy: replaying c alone -- which every file in
// this batch is written to allow, since they are hand-applied -- silently
// reopened the forged-operator-reply hole. There is now exactly one definition
// of each policy in the batch, and the loop below reads each one where it
// lives. The count check under it is what keeps it that way.
const OWNERSHIP = {
  tickets_user_insert:    [admitSql,  /user_id\s*=\s*public\.current_profile_id\(\)/],
  messages_thread_insert: [attribSql, /author_id\s*=\s*public\.current_profile_id\(\)/],
};
for (const [name, [sql, ownRe]] of Object.entries(OWNERSHIP)) {
  const stmt = policyStmt(sql, name);
  ok(`${name} is created`, stmt !== "");
  ok(`${name} is an INSERT policy with a WITH CHECK`, /for\s+insert/.test(stmt) && /with\s+check/.test(stmt));
  ok(`${name} keeps its ownership term`, ownRe.test(stmt));
  ok(`${name} adds the eligibility term (active profile)`, /public\.current_profile_active\(\)/.test(stmt));
  ok(`${name} lets an admin through`, /public\.is_admin\(public\.current_profile_id\(\)\)/.test(stmt));
  ok(`${name} ANDs the two rather than ORing them`,
    / and \(\s*public\.current_profile_active\(\) or public\.is_admin/.test(stmt));
  ok(`${name} is dropped by name first, so there is one policy and not two`,
    new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${name}\\s+on`).test(sql));
  // Across the WHOLE batch, not just this file: two files creating one policy
  // is the defect, and whichever applied last would win.
  const acrossBatch = [admitSql, attribSql]
    .map((f) => (f.match(new RegExp(`create\\s+policy\\s+${name}\\b`, "g")) || []).length)
    .reduce((a, b) => a + b, 0);
  eq(`${name} is created exactly once in the whole batch`, acrossBatch, 1);
}
ok("messages_thread_insert still requires the row to belong to a thread the caller can see",
  /from public\.support_tickets t where t\.id = support_messages\.ticket_id/.test(policyStmt(attribSql, "messages_thread_insert")));
// The clause the duplicate definition was dropping. It is only ever safe
// while messages_thread_insert has exactly one definition, which is what the
// count above holds.
ok("messages_thread_insert pins attribution to app_admins membership",
  /coalesce\(is_admin_reply, false\) = false or public\.is_admin\(public\.current_profile_id\(\)\)/
    .test(policyStmt(attribSql, "messages_thread_insert")));
ok("and 20260915c no longer defines that policy at all",
  !/create\s+policy\s+messages_thread_insert/.test(admitSql));

console.log("\n── current_profile_active() is the eligibility test ──");
const activeFn = functionBody(admitSql, "public.current_profile_active");
ok("current_profile_active() is defined", activeFn.length > 0);
ok("it asks for access_status = 'active'", /access_status\s*=\s*'active'/.test(activeFn));
ok("it is SECURITY DEFINER (a policy expression runs as the caller)", /security\s+definer/.test(activeFn));
ok("it pins search_path", /set\s+search_path\s+to\s+'public'/.test(activeFn));
ok("it takes no argument, so it cannot probe another physician's status",
  /function\s+public\.current_profile_active\(\)/.test(activeFn));
ok("it defaults to false rather than null when there is no profile", /coalesce\(/.test(activeFn));
ok("execute is granted to the roles that evaluate the policy",
  /grant\s+execute\s+on\s+function\s+public\.current_profile_active\(\)\s+to\s+[^;]*authenticated/.test(admitSql));

console.log("\n── The runner's queue goes through one approval rule ──");

// This section used to parse two printf-built queries out of the shell and
// check that each carried ELIGIBLE and then GATE as its last argument. PR11
// deleted those queries: the shell now delegates to ticket-agent-context.mjs,
// so there is no printf to miscount and no second spelling to drift. The
// property worth keeping is that nothing reaches the agent except through
// APPROVED, and that the table itself refuses an ineligible filer.
const contextRaw = read("scripts/ticket-agent-context.mjs");
ok("the shell no longer builds ticket SQL", !/FROM support_tickets/i.test(agentRaw));
ok("the shell defines no approval or eligibility clause of its own",
  !/^(ELIGIBLE|APPROVED|GATE)=/m.test(agentRaw));
ok("the shared module defines APPROVED exactly once",
  (contextRaw.match(/export const APPROVED\s*=/g) || []).length === 1);
ok("APPROVED admits the owner or an owner-released ticket, nothing else",
  /\(public\.is_admin\(t\.user_id\) OR t\.agent_approved_at IS NOT NULL\)/.test(contextRaw));
{
  const fn = (name) => { const i = contextRaw.indexOf(`export function ${name}(`); return i < 0 ? "" : contextRaw.slice(i, contextRaw.indexOf("\nexport function", i + 10)); };
  for (const name of ["queueSQL", "continuationSQL", "targetSQL"]) {
    ok(`${name} selects targets only through APPROVED`, /\$\{APPROVED\}/.test(fn(name)), name);
  }
  for (const name of ["historySQL", "messagesSQL"]) {
    ok(`${name} loads history only for the approved target's owner`, /t\.user_id='\$\{id\(ownerId\)\}'::uuid/.test(fn(name)), name);
  }
}
ok("a failed queue read is an ERROR and a non-zero exit, never an empty queue",
  /NOT an empty queue/.test(agentRaw) && /exit 1/.test(agentRaw));

console.log("\n── The runner's autonomy is untouched ──");
// The owner chose the model, the permission flag and the workflow. This item
// was allowed to add a filter and nothing else.
ok("still runs headless claude on the prompt file", agentRaw.includes("scripts/ticket-agent-prompt.md"));
ok("model is still claude-sonnet-5", agentRaw.includes("--model claude-sonnet-5"));
ok("still --dangerously-skip-permissions (deliberate, unchanged)", agentRaw.includes("--dangerously-skip-permissions"));
ok("still single-instance via the lock directory", agentRaw.includes('mkdir "$LOCK"'));
// PR11 shortened the cap when it split the run into one session per ticket.
// The number is the runner owner's to choose; that a cap exists is the property.
ok("still capped by a perl alarm", /perl -e 'alarm \d+; exec @ARGV'/.test(agentRaw));
ok("no credential is echoed", !/echo[^\n]*\$TOKEN|echo[^\n]*ANTHROPIC_API_KEY/.test(agentRaw));

console.log("\n── Both migrations are additive ──");
for (const [name, sql] of [[LOCK_INSERT, lockSql], [ADMISSION, admitSql]]) {
  ok(`${name} contains no DROP TABLE`, !/drop\s+table/.test(sql));
  ok(`${name} contains no ALTER COLUMN ... TYPE`, !/alter\s+column[\s\S]{0,80}?\btype\b/.test(sql));
  ok(`${name} drops no column`, !/drop\s+column/.test(sql));
  ok(`${name} deletes no rows`, !/\bdelete\s+from\b/.test(sql));
  ok(`${name} does not disturb the existing UPDATE locks`,
    !/drop\s+trigger\s+if\s+exists\s+profiles_lock_identity/.test(sql) &&
    !/drop\s+trigger\s+if\s+exists\s+profiles_lock_founding/.test(sql));
}
ok("neither migration touches the AFTER INSERT founding trigger from 20260902g",
  !/profiles_founding_number/.test(lockSql) && !/profiles_founding_number/.test(admitSql));

console.log("\n── House style ──");
// Built from its code point rather than typed, so this file can check itself
// without holding the character it is looking for.
const EM_DASH = String.fromCharCode(0x2014);
for (const [name, text] of [[LOCK_INSERT, lockRaw], [ADMISSION, admitRaw], ["scripts/profile-lock.test.mjs", read("scripts/profile-lock.test.mjs")]]) {
  ok(`${name} has no em dash`, !text.includes(EM_DASH));
}
// What the text checks above cannot prove.
//
// No text invariant proves that a trigger fires or that a policy refuses a
// row. These are the cases to run against a scratch database (supabase db
// reset on a local project, or a branch), never against production.
//
// The 'ran' field records what happened when the case was executed on
// 2026-09-15 against a throwaway PostgreSQL 17 cluster loaded with a stub of
// the live schema plus 20260819, 20260902g, 20260902h and both new
// migrations. Nothing in this node run repeats that: it is a record, not an
// assertion, and a reviewer who changes the SQL has to run them again. The
// counterfactual was run first. With profiles_lock_insert dropped, case 1's
// row landed access_status 'active', is_founding_member true and
// founding_number 7, which is the defect this migration closes.
export const MANUAL_CASES = [
  { id: 1, against: "profiles", as: "a fresh authenticated Clerk token",
    action: "INSERT {id, auth_user_id: <my sub>, access_status: 'active', is_founding_member: true, founding_number: 1}",
    expect: "row lands with access_status 'pending', is_founding_member false, founding_number null",
    ran: "ran: pending / false / null" },
  { id: 2, against: "profiles", as: "a fresh authenticated Clerk token",
    action: "INSERT {id, auth_user_id: <my sub>} (what ensureProfile sends)",
    expect: "succeeds unchanged; no regression for a real first sign-in",
    ran: "ran: accepted unchanged" },
  { id: 3, against: "profiles", as: "a fresh authenticated Clerk token",
    action: "INSERT with auth_user_id set to someone else's Clerk sub",
    expect: "refused by profiles_owner_insert, as before this change",
    ran: "ran: refused by RLS" },
  { id: 4, against: "profiles", as: "service_role",
    action: "INSERT the clerk-webhook seed row",
    expect: "succeeds; every column written as sent",
    ran: "ran: accepted as sent" },
  { id: 5, against: "profiles", as: "service_role",
    action: "INSERT a row with access_status 'active'",
    expect: "stays 'active'; the privileged escape works",
    ran: "ran: stayed active" },
  { id: 6, against: "profiles", as: "direct SQL (no JWT)",
    action: "INSERT a row with a founding_number",
    expect: "kept; a psql fix is still a fix",
    ran: "ran: kept founding_number 42" },
  { id: 7, against: "profiles", as: "an authenticated token",
    action: "INSERT a self-activated row, then check founding_number",
    expect: "no founding number assigned: the AFTER trigger's WHEN saw 'pending'",
    ran: "ran: no number assigned" },
  { id: 8, against: "profiles", as: "an authenticated token whose profile is active",
    action: "UPDATE name and email",
    expect: "still works; the INSERT lock does not touch UPDATE",
    ran: "ran: both fields updated" },
  { id: 9, against: "support_tickets", as: "an authenticated token, profile access_status 'pending'",
    action: "POST /rest/v1/support_tickets with user_id = my profile id",
    expect: "refused by tickets_user_insert (new row violates row-level security)",
    ran: "ran: refused" },
  { id: 10, against: "support_tickets", as: "an authenticated token, profile access_status 'active'",
    action: "the same POST",
    expect: "accepted; an eligible physician is unaffected",
    ran: "ran: accepted" },
  { id: 11, against: "support_tickets", as: "an admin profile that is not 'active'",
    action: "the same POST",
    expect: "accepted; is_admin is the second half of the eligibility term",
    ran: "ran: accepted" },
  { id: 12, against: "support_tickets", as: "an active physician",
    action: "POST with user_id = another physician's profile id",
    expect: "refused; the ownership term is unchanged",
    ran: "ran: refused" },
  { id: 13, against: "support_messages", as: "a 'pending' profile",
    action: "POST a reply into a thread it owns",
    expect: "refused by messages_thread_insert",
    ran: "ran: refused" },
  { id: 14, against: "support_messages", as: "an active physician",
    action: "POST a reply into a thread owned by someone else",
    expect: "refused; the thread term is unchanged",
    ran: "ran: refused" },
  { id: 15, against: "support_messages", as: "an active physician",
    action: "POST a reply into a thread it owns",
    expect: "accepted; the must-pass companion to 13 and 14",
    ran: "ran: accepted" },
  { id: 16, against: "create-ticket / reply-ticket", as: "an active physician through the app",
    action: "open a ticket with a screenshot, then reply",
    expect: "both succeed; the edge functions write with the service role and never see RLS",
    ran: "NOT RUN: needs the deployed edge functions" },
  { id: 17, against: "scripts/ticket-agent.sh", as: "the runner, on a scratch database",
    action: "insert one ticket from an active profile and one from a 'pending' profile, run the pre-check query",
    expect: "count is 1, and the full fetch returns only the active profile's ticket",
    ran: "ran on a larger seed: 3 eligible rows returned, the pending profile's 1 dropped" },
  { id: 18, against: "scripts/ticket-agent.sh", as: "the runner",
    action: "run the script with an empty queue",
    expect: "logs 'idle' and exits 0 without starting a Claude run",
    ran: "NOT RUN: needs the launchd job" },
];

const pad = (s, n) => String(s).padEnd(n);
const wTarget = Math.max(6, ...MANUAL_CASES.map((c) => c.against.length));
const wAs = Math.max(7, ...MANUAL_CASES.map((c) => c.as.length));
console.log("\n── Not machine-checked: run these against a scratch database ──");
console.log(`${pad("#", 3)} ${pad("target", wTarget)} ${pad("as", wAs)} expected`);
for (const c of MANUAL_CASES) {
  console.log(`${pad(c.id, 3)} ${pad(c.against, wTarget)} ${pad(c.as, wAs)} ${c.expect}`);
  console.log(`${" ".repeat(3)} ${" ".repeat(wTarget)} ${pad("action:", wAs)} ${c.action}`);
  console.log(`${" ".repeat(3)} ${" ".repeat(wTarget)} ${pad("2026-09-15:", wAs)} ${c.ran}`);
}
const notRun = MANUAL_CASES.filter((c) => c.ran.startsWith("NOT RUN"));
console.log(`\n${MANUAL_CASES.length - notRun.length} of ${MANUAL_CASES.length} were executed once against a scratch PostgreSQL 17 cluster.`);
console.log(`Still unexecuted: ${notRun.map((c) => `#${c.id}`).join(", ")}.`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
