import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, tableMapTables, checkTables, CLIENT_READ_TABLES } from "../scripts/check-tables-exist.mjs";

// The deploy preflight that stops a client shipping before its migration.
// These run offline; the live check runs in CI against production.

test("only a definite PGRST205 counts as missing", () => {
  assert.equal(classify(404, { code: "PGRST205" }), "missing");
  assert.equal(classify(200, []), "present");
  assert.equal(classify(401, { code: "42501" }), "present", "permission denied means the table exists");
  assert.equal(classify(403, { code: "42501" }), "present");
  // Anything else is unknown, and unknown fails the deploy rather than passing it.
  for (const [s, b] of [[500, null], [404, { code: "PGRST000" }], [401, { code: "PGRST301" }], [502, { message: "bad gateway" }]]) {
    assert.equal(classify(s, b), "unknown", `${s} ${JSON.stringify(b)}`);
  }
});

test("it reads the real TABLE_MAP", () => {
  const tables = tableMapTables(readFileSync(new URL("../src/lib/supabase.js", import.meta.url), "utf8"));
  assert.ok(tables.length >= 31);
  assert.ok(tables.includes("licenses") && tables.includes("rotations"));
  assert.equal(new Set(tables).size, tables.length);
});

const fakeFetch = (answers) => async (url) => {
  const table = new URL(url).pathname.split("/").pop();
  const [status, body] = answers[table] || [200, []];
  return { status, json: async () => body };
};
const SRC = 'const TABLE_MAP = {\n  licenses: "licenses",\n  customRecords: "custom_records",\n};';

test("a table production lacks is reported by name", async () => {
  const r = await checkTables({ url: "https://x.test", key: "k", source: SRC,
    fetchImpl: fakeFetch({ custom_records: [404, { code: "PGRST205" }] }) });
  assert.deepEqual(r.missing, ["custom_records"]);
});

test("an unreachable database fails closed instead of passing", async () => {
  const r = await checkTables({ url: "https://x.test", key: "k", source: SRC,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(r.missing, []);
  assert.equal(r.unsure.length, 2, "both tables are unconfirmed, so the deploy must stop");
});

test("existing tables, including ones anon may not read, pass", async () => {
  const r = await checkTables({ url: "https://x.test", key: "k", source: SRC,
    fetchImpl: fakeFetch({ custom_records: [401, { code: "42501" }] }) });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unsure, []);
});

test("tables the client reads outside TABLE_MAP are checked too", async () => {
  assert.deepEqual([...CLIENT_READ_TABLES], ["member_view_grants", "member_view_events"]);
  const r = await checkTables({ url: "https://x.test", key: "k", source: SRC, extra: CLIENT_READ_TABLES,
    fetchImpl: fakeFetch({ member_view_events: [404, { code: "PGRST205" }], member_view_grants: [401, { code: "42501" }] }) });
  assert.deepEqual(r.missing, ["member_view_events"], "the view log must exist before Settings reads it");
  assert.ok(r.tables.includes("member_view_grants"));
  // A server-only table (RLS on, no anon grant) answers permission denied: present.
  assert.deepEqual(r.unsure, []);
});
