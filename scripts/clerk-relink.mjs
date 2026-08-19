#!/usr/bin/env node
/**
 * Clerk dev -> production re-link.
 *
 * Every profile row is keyed by Clerk's user id (profiles.auth_user_id), and
 * dev and production instances have separate user lists with different ids.
 * After someone signs up on production with the SAME email, this script
 * points their existing profile (and therefore all their data, which hangs
 * off profiles.id) at the new Clerk id, and moves their storage objects to
 * the new folder name.
 *
 * Match rule: production user email === profiles.email (case-insensitive),
 * and the email is VERIFIED on the production side. Nothing is merged on a
 * guess. Dry run by default; pass --apply to write.
 *
 *   CLERK_SECRET_KEY=sk_live_... node scripts/clerk-relink.mjs            # report only
 *   CLERK_SECRET_KEY=sk_live_... node scripts/clerk-relink.mjs --apply    # write
 */
import { execSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
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
  if (j?.message) throw new Error(j.message);
  return j;
}
async function clerk(path) {
  const r = await fetch(`https://api.clerk.com/v1${path}`, { headers: { Authorization: `Bearer ${SK}` } });
  if (!r.ok) throw new Error(`Clerk ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// 1) production users, verified primary email only
const prodUsers = await clerk("/users?limit=100");
const byEmail = new Map();
for (const u of prodUsers) {
  const primary = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id);
  if (!primary || primary.verification?.status !== "verified") continue;
  byEmail.set(primary.email_address.toLowerCase(), u.id);
}
console.log(`production users with a verified email: ${byEmail.size}`);

// 2) profiles still keyed to a dev id
const profiles = await sql(`select id, name, email, auth_user_id from profiles where email is not null and email <> '' order by created_at`);
const plan = [];
for (const p of profiles) {
  const prodId = byEmail.get(String(p.email).toLowerCase());
  if (!prodId) { console.log(`  ${p.email.padEnd(32)} no production account yet, skip`); continue; }
  if (p.auth_user_id === prodId) { console.log(`  ${p.email.padEnd(32)} already on production`); continue; }
  plan.push({ profile: p.id, email: p.email, from: p.auth_user_id, to: prodId });
}
console.log(`\nre-links planned: ${plan.length}`);
for (const x of plan) console.log(`  ${x.email.padEnd(32)} ${x.from} -> ${x.to}`);
if (!plan.length) process.exit(0);
if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); process.exit(0); }

// 3) apply: profile id stays the same, so every data row follows automatically;
//    only auth_user_id, and the storage folder named after it, need to move.
for (const x of plan) {
  await sql(`update profiles set auth_user_id = '${x.to}', updated_at = now() where id = '${x.profile}'`);
  const moved = await sql(`
    update storage.objects set name = replace(name, '${x.from}/', '${x.to}/')
    where bucket_id in ('documents','backups') and name like '${x.from}/%' returning id`);
  await sql(`update documents set storage_path = replace(storage_path, '${x.from}/', '${x.to}/') where user_id = '${x.profile}' and storage_path like '${x.from}/%'`);
  await sql(`update backups set storage_path = replace(storage_path, '${x.from}/', '${x.to}/') where user_id = '${x.profile}' and storage_path like '${x.from}/%'`);
  console.log(`  re-linked ${x.email}: profile ${x.profile}, ${moved.length} storage object(s) moved`);
}
console.log("\nDone. Each person signs in on production with the same email and sees their data.");
