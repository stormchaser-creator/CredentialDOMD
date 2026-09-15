// Exercise the real request handler with in-memory database and mail adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
let handler, scenario, writes, emails;
const db = { from(table) {
  let op = "select", data;
  const q = {
    select() { return q; }, eq() { return q; }, ilike() { return q; }, maybeSingle() { return q; }, single() { return q; },
    insert(value) { op = "insert"; data = value; return q; }, update(value) { op = "update"; data = value; return q; },
    then(resolve, reject) {
      if (op !== "select") writes.push({ table, op, data });
      let value = null, error = null;
      if (table === "early_access_leads" && op === "select") { value = scenario.leads || []; error = scenario.error || null; }
      if (table === "beta_access" && op === "insert") value = { id: "beta", ...data };
      return Promise.resolve({ data: value, error }).then(resolve, reject);
    },
  };
  return q;
} };
globalThis.__inviteTest = {
  serve: fn => { handler = fn; },
  clerkProfile: async () => scenario.signedOut ? null : ({ isAdmin: !scenario.nonAdmin, profileId: "admin", db }),
  Deno: { env: { get: () => "test-value" } },
  fetch: async () => { emails++; return new Response(JSON.stringify({ id: "email" }), { status: 200 }); },
};
let source = readFileSync(new URL("../supabase/functions/send-invite/index.ts", import.meta.url), "utf8");
source = source.replace(/^import .*;\n/gm, "");
source = "const { serve, clerkProfile, Deno, fetch } = globalThis.__inviteTest;\n" + source;
const js = transformSync(source, { loader: "ts", format: "esm" }).code;
await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
async function check(config, body, status, sent) {
  scenario = config; writes = []; emails = 0;
  const response = await handler(new Request("https://test.invalid/send-invite", { method: "POST", body: JSON.stringify(body) }));
  assert.equal(response.status, status, await response.text());
  assert.equal(emails, sent);
  if (!sent) assert.equal(writes.length, 0, "Rejected invitations must not change access or lead status");
}
const body = { email: "READER@example.com", lead_id: "lead" };
await check({ leads: [{ id: "lead", email: "reader@example.com", waitlist: false }] }, body, 409, 0);
await check({ leads: [{ id: "lead", email: "reader@example.com", waitlist: false }] }, { email: body.email }, 409, 0);
await check({ leads: [{ id: "lead", email: "reader@example.com", waitlist: null }] }, body, 409, 0);
await check({ error: { message: "database unavailable" } }, body, 503, 0);
await check({ leads: [{ id: "wrong", email: "reader@example.com", waitlist: true }] }, body, 400, 0);
await check({ signedOut: true }, body, 401, 0);
await check({ nonAdmin: true }, body, 403, 0);
await check({}, { email: "*@example.com" }, 400, 0);
await check({ leads: [{ id: "lead", email: "Reader@example.com", waitlist: true }] }, body, 200, 1);
await check({ leads: [{ id: "lead", email: "reader@example.com", waitlist: true }] }, { email: body.email }, 200, 1);
assert.ok(writes.some(w => w.table === "early_access_leads" && w.data.status === "invited"));
await check({}, { email: "manual@example.com" }, 200, 1);
delete globalThis.__inviteTest;
console.log("Invitation handler: 11 consent/auth scenarios passed; no real messages sent.");
