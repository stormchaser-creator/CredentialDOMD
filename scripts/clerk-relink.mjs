#!/usr/bin/env node
/** Read-only Clerk cutover readiness report. --apply deliberately fails closed.
 * Neither an email match nor this report proves a complete migration is safe.
 * Existing sign-ins, profiles, documents and billing are not changed here.
 */
import { execSync } from "node:child_process";

if (process.argv.includes("--apply")) {
  console.error("Account migration is disabled. A durable storage recovery journal and verified identity mapping must be reviewed before enabling writes. Existing accounts are unchanged.");
  process.exit(1);
}
const SK = process.env.CLERK_SECRET_KEY;
if (!SK || !SK.startsWith("sk_live_")) {
  console.error("Set CLERK_SECRET_KEY to the PRODUCTION secret (sk_live_...). Nothing was changed.");
  process.exit(1);
}
const SUPA = execSync('security find-generic-password -l "Supabase CLI" -w').toString().trim();
const PROJECT = "hkpnnsjcwprrwobmpqyy";
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${SUPA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error(j?.message || `Database request failed: ${r.status}`);
  return j;
}
async function clerk(path) {
  const r = await fetch(`https://api.clerk.com/v1${path}`, { headers: { Authorization: `Bearer ${SK}` } });
  if (!r.ok) throw new Error(`Clerk ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// 1) production users, verified primary email only
const prodUsers = [];
for (let offset = 0; ; offset += 100) {
  const page = await clerk(`/users?limit=100&offset=${offset}`);
  if (!Array.isArray(page)) throw new Error("Unexpected Clerk response");
  prodUsers.push(...page);
  if (page.length < 100) break;
}
const byEmail = new Map();
for (const u of prodUsers) {
  const primary = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id);
  if (!primary || primary.verification?.status !== "verified") continue;
  const email = primary.email_address.trim().toLowerCase();
  if (byEmail.has(email)) throw new Error("Ambiguous verified production email; reconcile identities before cutover");
  byEmail.set(email, u.id);
}
console.log(`production users with a verified email: ${byEmail.size}`);

// 2) profiles still keyed to a dev id
const profiles = await sql(
  `select id, name, email, auth_user_id, access_status from profiles
   where deleted_at is null order by created_at`
);
const plan = [];
const unmatchedActive = [];
for (const p of profiles) {
  const email = String(p.email || "").trim().toLowerCase();
  const prodId = byEmail.get(email);
  if (!prodId) {
    console.log(`  ${(email || "(missing email)").padEnd(32)} no production account yet, skip`);
    if (p.access_status === "active") unmatchedActive.push(email || p.id);
    continue;
  }
  if (p.auth_user_id === prodId) { console.log(`  ${(email || "(missing email)").padEnd(32)} already on production`); continue; }
  plan.push({ profile: p.id, email: p.email, from: p.auth_user_id, to: prodId, active: p.access_status === "active" });
}

// No storage reads, moves, profile deletion, or identity updates in this report.
console.log(`\nProfile mappings needing review: ${plan.length}`);
for (const item of plan) console.log(`  ${item.email}: ${item.from} -> ${item.to}`);
if (unmatchedActive.length) console.error(`Active profiles without a verified production match: ${unmatchedActive.join(", ")}`);
console.log("Read-only report. Storage paths, device settings, sessions, and identity ownership still require a coordinated cutover review.");
process.exitCode = unmatchedActive.length ? 1 : 0;
