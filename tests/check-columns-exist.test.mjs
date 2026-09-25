import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { classify, checkColumns, REQUIRED_COLUMNS } from "../scripts/check-columns-exist.mjs";

// The deploy preflight that stops a client writing a column before its
// migration. These run offline; the live check runs in CI against production.
// The answers below are the ones production gave on 2026-09-25 for a missing
// column (work_log.split_group_id, before its migration) and a present one.

const MISSING = [400, { code: "42703", details: null, hint: null, message: "column work_log.split_group_id does not exist" }];
const PRESENT = [200, []];

test("only a definite 42703 counts as missing", () => {
  assert.equal(classify(...MISSING), "missing");
  assert.equal(classify(...PRESENT), "present");
  assert.equal(classify(401, { code: "42501" }), "present", "permission denied means the column resolved");
  assert.equal(classify(403, { code: "42501" }), "present");
  for (const [s, b] of [[500, null], [400, { code: "PGRST100" }], [404, { code: "PGRST205" }], [401, { code: "PGRST301" }], [502, { message: "bad gateway" }]]) {
    assert.equal(classify(s, b), "unknown", `${s} ${JSON.stringify(b)}`);
  }
});

const fakeFetch = (answers) => async (url) => {
  const u = new URL(url);
  const name = `${u.pathname.split("/").pop()}.${u.searchParams.get("select")}`;
  assert.equal(u.searchParams.get("limit"), "0", "never reads a row");
  const [status, body] = answers[name] || PRESENT;
  return { status, json: async () => body };
};

test("a column production lacks is reported by table and name", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", fetchImpl: fakeFetch({ "work_log.split_group_id": MISSING }) });
  assert.deepEqual(r.missing, ["work_log.split_group_id"]);
  assert.deepEqual(r.unsure, []);
});

test("every required column present passes", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", fetchImpl: fakeFetch({}) });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unsure, []);
  assert.ok(r.columns.includes("locum_contracts.split_at_day_start"));
});

test("an unreachable database fails closed instead of passing", async () => {
  const r = await checkColumns({ url: "https://x.test", key: "k", required: { work_log: ["split_group_id"] }, fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unsure, ["work_log.split_group_id (unreachable)"]);
});

test("every required column is created by a migration in this repo", () => {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const sql = readdirSync(dir).filter(f => f.endsWith(".sql")).map(f => readFileSync(new URL(f, dir), "utf8")).join("\n");
  // One statement may add several columns across lines.
  const statements = sql.split(";");
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const col of cols) {
      const ok = statements.some(st => new RegExp(`alter table public\\.${table}\\b`).test(st) && new RegExp(`add column if not exists ${col}\\b`).test(st));
      assert.ok(ok, `${table}.${col} is added by a migration`);
    }
  }
});

test("the lifecycle columns are required exactly as src/utils/lifecycle.js lists them", async () => {
  const { LIFECYCLE_COLUMNS } = await import("../src/utils/lifecycle.js");
  for (const [table, cols] of Object.entries(LIFECYCLE_COLUMNS)) assert.deepEqual(REQUIRED_COLUMNS[table], cols, table);
  // 13 lifecycle + 3 call-day split. The invoice email stamp is server-owned
  // and never written by the client, so it is not a client-written column.
  assert.equal(Object.values(REQUIRED_COLUMNS).flat().length, 16);
});

test("the client keys these columns stand for are the ones it writes", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  assert.match(read("components/features/locum/Contracts.jsx"), /entry\.splitAtDayStart =/);
  assert.match(read("components/features/locum/Contracts.jsx"), /entry\.dayStartHour =/);
  assert.match(read("utils/billing.js"), /splitGroupId/);
  // The invoice email stamp: written by send-invoice-email and mirrored into
  // the device cache by Invoices.jsx, but stripped from every client write,
  // so it is not required here (tests/limited-launch/persistence.test.mjs
  // proves the strip on each write path).
  assert.equal(REQUIRED_COLUMNS.invoices, undefined);
  assert.match(read("lib/supabase.js"), /invoices: Object\.freeze\(\["last_emailed_at", "last_emailed_to"\]\)/);
});

test("CI runs this check before it builds", () => {
  const ci = readFileSync(new URL("../.github/workflows/deploy-gh-pages.yml", import.meta.url), "utf8");
  const check = ci.indexOf("node scripts/check-columns-exist.mjs");
  assert.ok(check > 0, "the workflow runs the column check");
  assert.ok(check < ci.indexOf("name: Build the app"), "before the build step");
});
