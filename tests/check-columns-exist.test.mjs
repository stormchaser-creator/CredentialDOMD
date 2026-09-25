import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyColumn, checkColumns, REQUIRED_COLUMNS } from "../scripts/check-tables-exist.mjs";
import { LIFECYCLE_COLUMNS } from "../src/utils/lifecycle.js";

// The deploy preflight also refuses a client whose new keys have no column in
// production: one unknown column rejects the WHOLE row on save. Offline here;
// CI runs it against production before the build.

test("only a definite 42703 counts as a missing column", () => {
  assert.equal(classifyColumn(400, { code: "42703", message: "column licenses.lifecycle_status does not exist" }), "missing");
  assert.equal(classifyColumn(200, []), "present");
  assert.equal(classifyColumn(401, { code: "42501" }), "present", "Postgres resolves columns before privileges");
  for (const [s, b] of [[400, { code: "PGRST100" }], [404, { code: "PGRST205" }], [500, null], [502, { message: "bad gateway" }]]) {
    assert.equal(classifyColumn(s, b), "unknown", `${s} ${JSON.stringify(b)}`);
  }
});

test("the lifecycle columns are required, exactly as the migration adds them", () => {
  assert.deepEqual(REQUIRED_COLUMNS.licenses, LIFECYCLE_COLUMNS.licenses);
  assert.deepEqual(REQUIRED_COLUMNS.insurance, LIFECYCLE_COLUMNS.insurance);
  assert.deepEqual(REQUIRED_COLUMNS.privileges, LIFECYCLE_COLUMNS.privileges);
  const sql = readFileSync(new URL("../supabase/migrations/20260925040000_credential_lifecycle.sql", import.meta.url), "utf8");
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const block = sql.slice(sql.indexOf(`alter table public.${table}\n`), sql.indexOf(";", sql.indexOf(`alter table public.${table}\n`)));
    for (const col of cols) assert.match(block, new RegExp(`add column if not exists ${col} `), `${table}.${col} is added by the migration`);
  }
});

const fakeFetch = (answers) => async (url) => {
  const u = new URL(url);
  const id = `${u.pathname.split("/").pop()}.${u.searchParams.get("select")}`;
  const [status, body] = answers[id] || [200, []];
  return { status, json: async () => body };
};

test("each missing column is reported by name", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", fetchImpl: fakeFetch({
    "licenses.no_expiration": [400, { code: "42703" }],
    "privileges.date_unknown": [400, { code: "42703" }],
  }) });
  assert.deepEqual(r.missing, ["licenses.no_expiration", "privileges.date_unknown"]);
  assert.deepEqual(r.unsure, []);
  assert.equal(r.columns.length, 13);
});

test("columns production has, including ones anon may not read, pass", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", fetchImpl: fakeFetch({ "insurance.status_source": [401, { code: "42501" }] }) });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unsure, []);
});

test("an unreachable database fails closed instead of passing", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", required: { licenses: ["lifecycle_status"] },
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unsure, ["licenses.lifecycle_status (unreachable)"]);
});
