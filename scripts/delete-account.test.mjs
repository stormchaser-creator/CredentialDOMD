// Checks for supabase/functions/delete-account/lib.ts: the table lists, the
// storage folders, and the profile tombstone behind account deletion. The
// lists are checked AGAINST src/lib/supabase.js (TABLE_MAP and
// SETTINGS_TO_PROFILE, read from the source text because that module needs
// a browser and Vite), so a collection or synced column added to the app
// cannot silently survive a deletion. Node 22.18+ strips the type
// annotations on import; no build step, no runner.
// Run: node scripts/delete-account.test.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const {
  COLLECTION_TABLES, USER_TABLES, DOCUMENTS_BUCKET, BACKUPS_BUCKET, TICKETS_FOLDER,
  PROFILE_TOMBSTONE_PATCH, PROFILE_KEEP_COLUMNS, HOOK_REQUESTER,
  isSafePrefix, storagePrefixes, chunk, tombstonePatch,
} = await import("../supabase/functions/delete-account/lib.ts");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same ? name : `${name}  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, same);
};

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, "..", "src", "lib", "supabase.js"), "utf8");

/** The string values of one `const NAME = { key: "value", ... };` block in supabase.js. */
function mapValues(constName) {
  const start = appSource.indexOf(`const ${constName} = {`);
  const end = appSource.indexOf("\n};", start);
  const block = appSource.slice(start, end);
  return [...block.matchAll(/^\s*\w+:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

// ── The 31 collections: exactly TABLE_MAP, no more, no less ─────────────────
const tableMap = mapValues("TABLE_MAP");
eq("TABLE_MAP parsed from supabase.js has 31 tables", tableMap.length, 31);
eq("COLLECTION_TABLES is TABLE_MAP, same order", COLLECTION_TABLES, tableMap);
eq("no duplicate collection table", new Set(COLLECTION_TABLES).size, COLLECTION_TABLES.length);

// ── The operating-record tables the client cannot reach ─────────────────────
const userTables = USER_TABLES.map((t) => t.table);
for (const t of ["assistant_log", "support_tickets", "support_messages", "feedback", "document_requests",
  "inbound_emails", "ai_usage", "client_errors", "backups", "deleted_items", "field_proposals", "user_events",
  "admin_messages", "admin_message_replies"]) {
  ok(`USER_TABLES covers ${t}`, userTables.includes(t));
}
ok("no table is in both lists", !userTables.some((t) => COLLECTION_TABLES.includes(t)));
eq("no duplicate user table", new Set(userTables).size, userTables.length);
eq("support_messages is matched by author_id", USER_TABLES.find((t) => t.table === "support_messages").column, "author_id");
eq("inbound_emails is matched by profile_id", USER_TABLES.find((t) => t.table === "inbound_emails").column, "profile_id");
eq("client_errors is matched by profile_id", USER_TABLES.find((t) => t.table === "client_errors").column, "profile_id");
eq("admin_messages is matched by recipient_id (the physician the note went to)",
  USER_TABLES.find((t) => t.table === "admin_messages").column, "recipient_id");
eq("admin_message_replies is matched by user_id (the thread owner, not the reply author)",
  USER_TABLES.find((t) => t.table === "admin_message_replies").column, "user_id");
ok("every other user table is matched by user_id",
  USER_TABLES.filter((t) => !["support_messages", "inbound_emails", "client_errors", "admin_messages"].includes(t.table))
    .every((t) => t.column === "user_id"));
ok("profiles is never in a delete list (it is tombstoned, not deleted)",
  !userTables.includes("profiles") && !COLLECTION_TABLES.includes("profiles"));

// ── Storage folders ─────────────────────────────────────────────────────────
eq("bucket names", [DOCUMENTS_BUCKET, BACKUPS_BUCKET], ["documents", "backups"]);
eq("ticket folder is a folder under documents", TICKETS_FOLDER, "tickets/");

const PID = "11111111-2222-3333-4444-555555555555";
const AUTH = "user_2abcDEF";
ok("every ticket prefix starts with the ticket folder",
  storagePrefixes(PID, AUTH, ["t1", "t2"]).filter((p) => p.prefix.includes("t1") || p.prefix.includes("t2"))
    .every((p) => p.bucket === DOCUMENTS_BUCKET && p.prefix.startsWith(TICKETS_FOLDER)));
eq("no tickets: the user's documents folder and both backup folders",
  storagePrefixes(PID, AUTH, []),
  [
    { bucket: "documents", prefix: `${AUTH}/` },
    { bucket: "backups", prefix: `${AUTH}/` },
    { bucket: "backups", prefix: `${PID}/` },
  ]);
eq("one folder per ticket, under documents/tickets/",
  storagePrefixes(PID, AUTH, ["t1", "t2"]).filter((p) => p.prefix.startsWith("tickets/")),
  [{ bucket: "documents", prefix: "tickets/t1/" }, { bucket: "documents", prefix: "tickets/t2/" }]);
eq("documents folder comes before ticket folders", storagePrefixes(PID, AUTH, ["t1"])[0].prefix, `${AUTH}/`);
eq("no auth_user_id: only the profile-id backup folder and the tickets remain",
  storagePrefixes(PID, null, ["t1"]),
  [{ bucket: "documents", prefix: "tickets/t1/" }, { bucket: "backups", prefix: `${PID}/` }]);
eq("blank auth_user_id is treated as missing", storagePrefixes(PID, "   ", []), [{ bucket: "backups", prefix: `${PID}/` }]);
eq("duplicate ticket ids collapse", storagePrefixes(PID, AUTH, ["t1", "t1"]).length, 4);
eq("empty ticket id is skipped", storagePrefixes(PID, AUTH, ["", "t1"]).length, 4);
ok("every prefix is a safe folder", storagePrefixes(PID, AUTH, ["t1"]).every((p) => isSafePrefix(p.prefix)));
eq("a dot-segment ticket id never becomes a folder",
  storagePrefixes(PID, AUTH, [".."]).filter((p) => p.prefix.startsWith("tickets/")), []);
eq("a slash inside a ticket id never widens the folder",
  storagePrefixes(PID, AUTH, ["a//b"]).filter((p) => p.prefix.startsWith("tickets/")), []);

// isSafePrefix: a folder, never the bucket root, never a dot segment.
for (const good of ["user_1/", "tickets/abc/", `${PID}/`, "a/b/c/"]) ok(`safe: ${good}`, isSafePrefix(good));
for (const bad of ["", "/", "//", "user_1", "/user_1/", "../", "a/../", "./", "a//b/", "a\\b/", null, 42]) {
  ok(`unsafe: ${JSON.stringify(bad)}`, !isSafePrefix(bad));
}

// chunk: what the storage remove() and `in (...)` batches are cut with.
eq("chunk splits evenly", chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
eq("chunk keeps the remainder", chunk([1, 2, 3], 2), [[1, 2], [3]]);
eq("chunk of nothing is nothing", chunk([], 100), []);
eq("chunk size below 1 still makes progress", chunk([1, 2], 0), [[1], [2]]);

// ── The profile tombstone ───────────────────────────────────────────────────
const synced = mapValues("SETTINGS_TO_PROFILE");
ok("SETTINGS_TO_PROFILE parsed from supabase.js", synced.length > 20);
for (const col of synced) {
  ok(`tombstone clears synced column ${col}`, col in PROFILE_TOMBSTONE_PATCH);
}
for (const col of ["email", "name", "npi", "phone", "address", "tax_prep", "profile_photo", "api_key", "anthropic_api_key"]) {
  eq(`tombstone nulls ${col}`, PROFILE_TOMBSTONE_PATCH[col], null);
}
eq("backup_monthly (NOT NULL) goes to false so no empty archive is ever built", PROFILE_TOMBSTONE_PATCH.backup_monthly, false);
ok("every patch value is null or false", Object.values(PROFILE_TOMBSTONE_PATCH).every((v) => v === null || v === false));
for (const col of PROFILE_KEEP_COLUMNS) {
  ok(`tombstone never touches ${col}`, !(col in PROFILE_TOMBSTONE_PATCH));
}
eq("kept columns are exactly the identity, the gate, and the billing facts",
  PROFILE_KEEP_COLUMNS, ["id", "auth_user_id", "created_at", "access_status", "is_founding_member", "founding_number"]);

const NOW = "2026-09-02T13:40:00.000Z";
const patch = tombstonePatch(NOW);
eq("tombstonePatch stamps deleted_at", patch.deleted_at, NOW);
eq("tombstonePatch stamps updated_at", patch.updated_at, NOW);
eq("tombstonePatch consumes the cancellation schedule", [patch.cancelled_at, patch.data_deletion_date], [null, null]);
ok("tombstonePatch carries every column of the base patch", Object.keys(PROFILE_TOMBSTONE_PATCH).every((k) => k in patch));
for (const col of PROFILE_KEEP_COLUMNS) ok(`tombstonePatch never touches ${col}`, !(col in patch));
ok("tombstonePatch does not mutate the base patch", !("deleted_at" in PROFILE_TOMBSTONE_PATCH));

// ── Hook labels ─────────────────────────────────────────────────────────────
for (const good of ["scheduled", "operator", "dry_run_check"]) ok(`hook label accepted: ${good}`, HOOK_REQUESTER.test(good));
for (const bad of ["", "Scheduled", "admin:abc", "a b", "_x", "x".repeat(33), "self;drop"]) {
  ok(`hook label refused: ${JSON.stringify(bad)}`, !HOOK_REQUESTER.test(bad));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
