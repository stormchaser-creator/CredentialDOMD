import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Every synced collection is enumerated by hand in several places. Missing one
// has failed quietly in this project more than once: records that live on one
// device only (deductibles, answerBank), a monthly backup that left a table
// out (follow_ups). This pins them to one source of truth, TABLE_MAP.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const supabase = read("src/lib/supabase.js");
const block = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, `${start} not found`); return src.slice(i, src.indexOf("\n};", i) + 3); };
const tableMap = Object.fromEntries([...block(supabase, "const TABLE_MAP = {").matchAll(/^\s*(\w+):\s*"([a-z0-9_]+)"/gm)].map(m => [m[1], m[2]]));
const keys = Object.keys(tableMap);
const tables = Object.values(tableMap);

test("DEFAULT_DATA has every synced collection", () => {
  const defaults = block(read("src/constants/defaults.js"), "export const DEFAULT_DATA = {");
  for (const k of keys) {
    assert.match(defaults, new RegExp(`\\b${k}:\\s*\\[`), `${k} is synced but missing from DEFAULT_DATA; an offline load leaves it undefined and the account load refuses it`);
  }
});

test("account deletion covers every synced table, in TABLE_MAP order", () => {
  const lib = read("supabase/functions/delete-account/lib.ts");
  const i = lib.indexOf("COLLECTION_TABLES");
  const list = [...lib.slice(i, lib.indexOf("];", i)).matchAll(/"([a-z0-9_]+)"/g)].map(m => m[1]);
  assert.deepEqual(list, tables, "deleting an account must remove every table the app syncs");
});

test("the monthly backup covers every synced table", () => {
  const lib = read("supabase/functions/build-backup/lib.ts");
  const i = lib.indexOf("SECTIONS");
  const inBackup = new Set([...lib.slice(i, lib.indexOf("];", i)).matchAll(/table:\s*"([a-z0-9_]+)"/g)].map(m => m[1]));
  const missing = tables.filter(t => !inBackup.has(t));
  assert.deepEqual(missing, [], `left out of the monthly backup: ${missing.join(", ")}`);
});

test("every synced table is created by some migration or pre-dates the repo's migrations", () => {
  // The CI preflight (scripts/check-tables-exist.mjs) checks production itself.
  // This catches the common mistake earlier: a new key with no migration at all.
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const created = new Set();
  for (const f of readdirSync(dir).filter(n => n.endsWith(".sql"))) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/gi)) created.add(m[1].toLowerCase());
  }
  // Tables that predate the migrations directory (created in the original
  // schema, supabase-schema.sql or the dashboard). Frozen: a NEW table must
  // come with a migration.
  const LEGACY = new Set(["licenses", "cme", "privileges", "insurance", "health_records", "education", "case_logs",
    "work_history", "peer_references", "malpractice_history", "documents", "share_log", "notification_log",
    "locum_contracts", "work_log", "encounters", "screenings", "alert_acks", "follow_ups", "professional_photos",
    "publications", "travel_docs", "travel_expenses", "tax_payments", "schedule_days", "task_notes", "duty_days",
    "professional_memberships", "invoices", "deductibles", "rotations"]);
  const orphan = tables.filter(t => !created.has(t) && !LEGACY.has(t));
  assert.deepEqual(orphan, [], `synced with no migration that creates it: ${orphan.join(", ")}`);
});

test("custom categories stay credential scope, not Practice", () => {
  const access = read("src/utils/limitedLaunchAccess.js");
  const practice = access.slice(access.indexOf("PRACTICE_COLLECTIONS"), access.indexOf("]);", access.indexOf("PRACTICE_COLLECTIONS")));
  for (const k of ["customCategories", "customRecords"]) {
    assert.ok(!practice.includes(`"${k}"`), `${k} moved to Practice scope; the SQL write policies and document scope would disagree`);
  }
});


test("BUILT_IN_SECTIONS is exactly TABLE_MAP, so Vera can tell a real section from an invented one", async () => {
  const { BUILT_IN_SECTIONS } = await import("../src/utils/sectionFields.js");
  assert.deepEqual([...BUILT_IN_SECTIONS], keys);
});

test("the scanner's 'other' type never swallows certificates that belong in Licenses or Education", () => {
  const scan = read("src/utils/documentScanner.js");
  const line = scan.split("\n").find(l => l.startsWith('- "other":')) || "";
  assert.ok(line, "the other type is described in the prompt");
  assert.doesNotMatch(line, /course certificate WITHOUT|fellowship or course/i);
  assert.match(line, /course-completion certificate without CME credit is still "license"/);
  assert.match(line, /fellowship, residency or internship certificate is still "education"/);
});
