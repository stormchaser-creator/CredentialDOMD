// The support receipt names the menu item as it reads now ("Get help"), and
// the migration that says so changes nothing else in support_complete_job.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../supabase/migrations/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const fnOf = (sql) => {
  const start = sql.indexOf("create or replace function public.support_complete_job(");
  assert.ok(start >= 0, "support_complete_job is defined");
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
};

test("the receipt says More > Get help > Your tickets, and nothing else changes", () => {
  const foundation = fnOf(read("20260918090000_autonomous_support_foundation.sql"));
  const fix = fnOf(read("20261001100000_support_receipt_get_help.sql"));
  assert.match(fix, /More > Get help > Your tickets/);
  assert.doesNotMatch(fix, /More > Support/);
  assert.equal(fix, foundation.replace("More > Support > Your tickets", "More > Get help > Your tickets"));
});

test("the receipt migration is the last to define support_complete_job and keeps it service_role only", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const defining = files.filter((f) => /create\s+or\s+replace\s+function\s+public\.support_complete_job\(/i.test(read(f)));
  assert.equal(defining.at(-1), "20261001100000_support_receipt_get_help.sql");
  const sql = read("20261001100000_support_receipt_get_help.sql");
  assert.match(sql, /revoke all on function public\.support_complete_job\(uuid,uuid,text,text\) from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.support_complete_job\(uuid,uuid,text,text\) to service_role;/);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
});
