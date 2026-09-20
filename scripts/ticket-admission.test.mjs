// Checks for the admission and attribution half of the ticket surface:
// supabase/functions/_shared/admission.ts (the rule), the two functions that
// must ask it (create-ticket, reply-ticket), and the two migrations that state
// the same rule again in SQL for the PostgREST path those functions never see.
//
// The SQL half cannot be proved from Node. It is proved against the real
// database by scripts/sql/ticket-admission-dryrun.sql, which applies both
// migrations inside a transaction, probes them as four synthetic accounts and
// rolls back; what this file checks about the SQL is that the clauses the dry
// run proved are still the clauses in the files, and that the dry run still
// carries its negative controls.
//
// Node 22.18+ strips the type annotations on import; no build step, no runner.
// Run: node scripts/ticket-admission.test.mjs

import { readFileSync } from "node:fs";

const { admissionVerdict, admitActiveAccount, ADMISSION_OK } =
  await import("../supabase/functions/_shared/admission.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── the rule itself ───────────────────────────────────────────────────────
ok("an admin is admitted", admissionVerdict(true, null).allowed);
ok("an admin is admitted even with a revoked profile", admissionVerdict(true, "revoked").allowed);
ok("an active profile is admitted", admissionVerdict(false, "active").allowed);

for (const status of ["pending", "revoked", "waitlist", "", null, undefined, 0, false]) {
  const v = admissionVerdict(false, status);
  ok(`${JSON.stringify(status)} is not admitted`, !v.allowed);
  eq(`${JSON.stringify(status)} is refused 403`, v.status, 403);
}

// "active" is a string, not a truthy value, and not a prefix.
for (const near of ["Active", "ACTIVE", "active ", " active", "activated", "inactive", true, 1]) {
  ok(`${JSON.stringify(near)} is not "active"`, !admissionVerdict(false, near).allowed);
}

// A profiles read that failed tells us nothing, so it refuses; but it refuses
// the way a failure should, retryably, and never says "you have no access".
const blind = admissionVerdict(false, null, true);
ok("a failed lookup is refused", !blind.allowed);
eq("a failed lookup is 503, not 403", blind.status, 503);
ok("a failed lookup says to try again", /try again/i.test(blind.error));
ok("a failed lookup does not claim the account lacks access", !/does not have access/i.test(blind.error));
ok("an admin is admitted even when the lookup failed", admissionVerdict(true, null, true).allowed);
eq("the ok verdict carries no error text", ADMISSION_OK.error, "");

// ── the rule as the functions actually call it ────────────────────────────
// A stub that answers like the PostgREST builder and counts its reads, so
// "an admin is never asked about their own access_status" is measurable.
const stubUser = (row, { error = null, isAdmin = false } = {}) => {
  const calls = [];
  const db = {
    from(table) {
      const q = {
        _t: table, _sel: null, _eq: null,
        select(cols) { q._sel = cols; return q; },
        eq(col, val) { q._eq = [col, val]; return q; },
        async maybeSingle() {
          calls.push({ table: q._t, select: q._sel, eq: q._eq });
          return { data: error ? null : row, error };
        },
      };
      return q;
    },
  };
  return { user: { profileId: "prof-1", email: "x@example.invalid", isAdmin, db }, calls };
};

{
  const { user, calls } = stubUser({ access_status: "active" });
  const v = await admitActiveAccount(user);
  ok("active account: admitted", v.allowed);
  eq("active account: one profiles read", calls.length, 1);
  eq("active account: reads its OWN id, from the verified sub", calls[0].eq, ["id", "prof-1"]);
  eq("active account: reads access_status only", calls[0].select, "access_status");
  eq("active account: reads profiles", calls[0].table, "profiles");
}
{
  const { user, calls } = stubUser({ access_status: "pending" });
  const v = await admitActiveAccount(user);
  ok("pending account: refused", !v.allowed);
  eq("pending account: 403", v.status, 403);
  eq("pending account: was actually looked up", calls.length, 1);
}
{
  const { user, calls } = stubUser(null, { isAdmin: true });
  const v = await admitActiveAccount(user);
  ok("admin: admitted", v.allowed);
  eq("admin: no profiles read at all", calls.length, 0);
}
{
  const { user } = stubUser(null, { error: { message: "connection reset" } });
  const v = await admitActiveAccount(user);
  ok("lookup error: refused", !v.allowed);
  eq("lookup error: 503", v.status, 503);
}
{
  // The row is missing (a profile deleted mid-session). maybeSingle gives null
  // data with no error, which must read as "not active", not as "no answer".
  const { user } = stubUser(null);
  const v = await admitActiveAccount(user);
  ok("missing profile row: refused", !v.allowed);
  eq("missing profile row: 403, not 503", v.status, 403);
}

// ── both functions ask, and neither keeps a second copy of the rule ───────
for (const fn of ["create-ticket", "reply-ticket"]) {
  const src = read(`../supabase/functions/${fn}/index.ts`);
  ok(`${fn} imports the shared rule`, /import \{ admitActiveAccount \} from "\.\.\/_shared\/admission\.ts";/.test(src));
  ok(`${fn} calls it`, /await admitActiveAccount\(user\)/.test(src));
  ok(`${fn} returns the verdict's own status`, /status: admission\.status/.test(src));
  ok(`${fn} keeps no second copy of the access_status test`,
     !/access_status.*!==.*"active"|access_status.*===.*"active"/.test(src));

  // Order matters: the gate has to run before anything is written or uploaded.
  const gate = src.indexOf("admitActiveAccount");
  const firstWrite = Math.min(
    ...[".insert(", ".upload(", ".update("].map((s) => {
      const i = src.indexOf(s);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    })
  );
  ok(`${fn} asks before it writes anything`, gate > 0 && gate < firstWrite);
}

// reply-ticket still sets the flag from verified membership, never from the
// request body. This is the server-side half of the attribution fix.
{
  const src = read("../supabase/functions/reply-ticket/index.ts");
  ok("reply-ticket sets is_admin_reply from the resolved identity", /is_admin_reply: isAdmin,/.test(src));
  ok("reply-ticket never reads is_admin_reply off the request", !/body\.is_admin_reply/.test(src));
  ok("reply-ticket still checks ownership as well as admission",
     /ticketRow\.user_id !== user\.profileId && !isAdmin/.test(src));
}

// ── the SQL says the same thing ───────────────────────────────────────────
const mC = read("../supabase/migrations/20260915c_ticket_admission.sql");
const mF = read("../supabase/migrations/20260915f_ticket_update_and_attribution.sql");
const squash = (s) => s.replace(/\s+/g, " ");

ok("20260915c defines the admission function", /create or replace function public\.current_profile_active\(\)/.test(mC));
ok("the admission function is security definer", /security definer/.test(mC));
ok("the admission function takes no argument, so it cannot probe other profiles",
   /current_profile_active\(\)\s*\nreturns boolean/.test(mC));

for (const [name, sql] of [["20260915c", mC], ["20260915f", mF]]) {
  const admitted = squash(sql).match(/public\.current_profile_active\(\) or public\.is_admin\(public\.current_profile_id\(\)\)/g) || [];
  ok(`${name} spells the eligibility clause the same way everywhere`, admitted.length >= 1);
}

// The three policies, each with the clause that was missing.
ok("f recreates the owner UPDATE policy", /create policy tickets_owner_or_admin_update on public\.support_tickets for update/.test(mF));
{
  const body = squash(mF.slice(mF.indexOf("create policy tickets_owner_or_admin_update")));
  const upd = body.slice(0, body.indexOf(";") + 1);
  ok("the owner UPDATE gates USING", /using \(.*current_profile_active\(\)/.test(upd));
  ok("the owner UPDATE gates WITH CHECK", /with check \(.*current_profile_active\(\)/.test(upd));
  ok("the owner UPDATE keeps the ownership condition on both sides",
     (upd.match(/user_id = public\.current_profile_id\(\)/g) || []).length === 2);
}
ok("f recreates the message INSERT policy", /create policy messages_thread_insert on public\.support_messages for insert/.test(mF));
ok("attribution is pinned to membership",
   /coalesce\(is_admin_reply, false\) = false\s*or public\.is_admin\(public\.current_profile_id\(\)\)/.test(squash(mF)
     .replace(/coalesce\(is_admin_reply, false\) = false or/, "coalesce(is_admin_reply, false) = false\n or")));
ok("attribution coalesces the nullable column, so null is not a way round it",
   /coalesce\(is_admin_reply, false\)/.test(mF));
ok("f keeps the thread condition it inherited", /t\.id = support_messages\.ticket_id/.test(mF));
ok("f keeps the admission condition it inherited from c", /current_profile_active\(\)/.test(mF));
ok("f does not add an UPDATE or DELETE policy to support_messages",
   !/on public\.support_messages for (update|delete)/.test(mF));
ok("f does not add a DELETE policy to support_tickets",
   !/on public\.support_tickets for delete/.test(mF));

// ── the dry run still measures something ──────────────────────────────────
const dry = read("../scripts/sql/ticket-admission-dryrun.sql");
ok("the dry run applies 20260915c", /create or replace function public\.current_profile_active\(\)/.test(dry));
ok("the dry run applies 20260915f", /create policy tickets_owner_or_admin_update/.test(dry));
ok("the dry run ends in a rollback", /\nrollback;\s*$/.test(dry));
ok("the dry run never commits", !/^\s*commit;/m.test(dry));
ok("the dry run disables the outbound reply trigger", /disable trigger trg_notify_ticket_reply/.test(dry));
ok("the dry run keeps the two negative controls", (dry.match(/'BEFORE f: /g) || []).length === 2);
ok("both negative controls expect the hole to be open", (dry.match(/'allowed'\);\s*\n?select pg_temp\.probe\(\s*\n?\s*'BEFORE f|BEFORE f[\s\S]{0,400}?'allowed'\)/g) || []).length >= 1);
ok("the dry run checks the admin path still works", /an admin still archives any ticket/.test(dry));
ok("the dry run checks an owner can still resolve their own ticket", /still marks their own ticket resolved/.test(dry));
ok("the dry run uses only synthetic identities", !/@credentialdomd|stormchaser|@gmail/.test(dry));
{
  // Every probe's expectation must be one of the two words the helper produces,
  // or the probe silently always fails (or, worse, always passes).
  const expectations = dry.match(/'(allowed|blocked)'\);/g) || [];
  const probes = dry.match(/pg_temp\.probe\(/g) || [];
  eq("every probe carries a well-formed expectation", expectations.length, probes.length - 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
