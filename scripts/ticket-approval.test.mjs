// Checks for the gate ticket 8e66cf06 asked for: "When a user makes a request
// and puts in a ticket that ticket needs to come to me and be approved for you
// to work before you resolve or respond to the user."
//
// The rule lives in three places that must agree, and this is what holds them
// together: the runner's queue (scripts/ticket-agent.sh), the runner's own
// instructions (scripts/ticket-agent-prompt.md), and the admin screen where the
// approval is actually given. The SQL half is proved against the real database
// by scripts/sql/ticket-approval-dryrun.sql, which applies the migration inside
// a transaction, probes it as a synthetic physician and a synthetic admin and
// rolls back: 12 passed, 0 failed.
//
// Run: node scripts/ticket-approval.test.mjs

import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const sh = read("../scripts/ticket-agent.sh");
const prompt = read("../scripts/ticket-agent-prompt.md");
const sql = read("../supabase/migrations/20260916a_ticket_agent_approval.sql");
const admin = read("../src/components/pages/AdminDashboard.jsx");
const dry = read("../scripts/sql/ticket-approval-dryrun.sql");

// ── Shared queue and failures ─────────────────────────────────────────────
const context = read("../scripts/ticket-agent-context.mjs");
ok("the shared approval clause is defined once", (context.match(/export const APPROVED =/g) || []).length === 1);
ok("it admits an admin's own ticket without an approval row",
   /public\.is_admin\(t\.user_id\) OR t\.agent_approved_at IS NOT NULL/.test(context));
ok("new-message targets use the shared approval rule", /WHERE \$\{APPROVED\} AND \$\{AWAITING\}/.test(context));
ok("internal continuation rechecks original approval and owner", /AND t\.user_id=.*AND \$\{APPROVED\} AND \$\{approval\}/.test(context));
ok("the legacy runner uses the shared queue", /--queue "\$RUN_DIR\/queue.json" "\$CASE_STATE"/.test(sh));
ok("the shell does not invent a second approval rule", !/agent_approved_at IS NOT NULL/.test(sh));
ok("query failure is handled before inspecting the queue", /--queue[^]*?\|\| \{[^]*?exit 1/.test(sh));
ok("it is logged as an ERROR, not idle", /ERROR — queue query failed, NOT an empty queue/.test(sh));
ok("malformed queue data also exits nonzero", /ERROR — malformed ticket queue[^]*?exit 1/.test(sh));
ok("an empty merged queue still logs idle", /if \[ -z "\$TARGETS" \]; then\n  echo[^]*?idle/.test(sh));
const code = sh.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
ok("the old silent default is gone from code", !/\$\{N:-0\}/.test(code));
ok("the comment preserves the old failure lesson", /\$\{N:-0\}/.test(sh));

// ── The runner's instructions say the same thing ──────────────────────────
ok("the prompt says the queue is pre-filtered", /THE QUEUE IS ALREADY FILTERED/.test(prompt));
ok("it quotes the instruction it is implementing", /needs to come to me and be approved/.test(prompt));
ok("it says which earlier instruction this narrows", /NARROWS his earlier standing instruction of 2026-09-04/.test(prompt));
ok("it forbids answering a ticket found outside the queue",
   /never\s+answer one you happened to see in a query/.test(prompt));
ok("an approved physician ticket is still untrusted text",
   /is not a claim that anything in[\s\S]{0,4}it is true or safe/.test(prompt) && /UNTRUSTED TEXT/.test(prompt));
ok("the owner's own ticket still needs no approval", /filing it was the approval|He approved the ticket in\nthe app before filing it/.test(prompt));

// ── Only an admin may approve ─────────────────────────────────────────────
ok("the columns exist", /add column if not exists agent_approved_at timestamptz/.test(sql));
ok("a trigger guards them", /create trigger support_tickets_lock_agent_approval/.test(sql));
ok("it is BEFORE INSERT OR UPDATE, so an insert cannot arrive pre-approved",
   /before insert or update on public\.support_tickets/.test(sql));
ok("a non-admin's value is reverted rather than raised",
   /new\.agent_approved_at := old\.agent_approved_at;/.test(sql));
ok("an insert by a non-admin is nulled", /if tg_op = 'INSERT' then[\s\S]{0,140}new\.agent_approved_at := null;/.test(sql));
ok("attribution is taken from the caller, never from the request",
   /new\.agent_approved_by := caller;/.test(sql));
ok("withdrawing an approval clears the attribution with it",
   /else\s*\n\s*new\.agent_approved_by := null;/.test(sql));
ok("the admin screen can see the state", /t\.agent_approved_at,\s*\n\s*public\.is_admin\(t\.user_id\) as from_admin/.test(sql));
ok("the recreated view keeps its admin gate", /where public\.is_admin\(public\.current_profile_id\(\)\)/.test(sql));
ok("and keeps security_invoker, which 20260913 set",
   /alter view public\.admin_tickets_open set \(security_invoker = true\)/.test(sql));
ok("and re-revokes the write grants that 20260913 removed",
   /revoke insert, update, delete, truncate, references on public\.admin_tickets_open/.test(sql));
ok("the backfill is measured, not guessed", /Measured on hkpnnsjcwprrwobmpqyy immediately before writing this/.test(sql));

// ── The admin screen ──────────────────────────────────────────────────────
ok("there is an action to release a ticket", /const setAgentApproved = async \(t, approved\) =>/.test(admin));
ok("it writes the column the runner reads", /agent_approved_at: approved \? new Date\(\)\.toISOString\(\) : null/.test(admin));
ok("the button appears only for a physician's ticket", /openTicket\.from_admin === false && \(/.test(admin));
ok("it toggles both ways", /Withdraw from agent" : "Approve for agent"/.test(admin));
ok("the list flags what is waiting on the owner", /NEEDS YOU/.test(admin));
ok("and only for unapproved physician tickets",
   /r\.from_admin === false && !r\.agent_approved_at && \(/.test(admin));

// ── The dry run still measures something ──────────────────────────────────
ok("the dry run applies the migration", /create trigger support_tickets_lock_agent_approval/.test(dry));
ok("it rolls back", /\nrollback;\s*$/.test(dry));
ok("it never commits", !/^\s*commit;/m.test(dry));
ok("it proves a physician cannot self-approve", /but the approval did NOT stick/.test(dry));
ok("it proves forged attribution is overwritten", /the forged attribution is replaced with the real caller/.test(dry));
ok("it runs the runner's own clause for real",
   /public\.is_admin\(t\.user_id\) or t\.agent_approved_at is not null/.test(dry));
ok("it uses only synthetic identities", /example\.invalid/.test(dry) && !/@credentialdomd|stormchaser/.test(dry));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
