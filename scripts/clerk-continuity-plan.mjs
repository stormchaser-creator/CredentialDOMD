#!/usr/bin/env node
/** Offline plan only: authenticated-provider exports in, private manifest out.
 * No credential stores, network, identity creation, migration or activation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SUBJECT = /^user_[A-Za-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUER = /^https:\/\/[a-z0-9.-]+$/;
export const LIFETIME_CUTOFF = '2026-09-19T15:56:26.238Z';
// PostgreSQL jsonb array text uses spaces between array items. Fields here are
// scalars only; build the same canonical representation without regex rewrites.
export const canonicalMembers = members => '[' + [...members].sort((a,b)=>a[1]<b[1]?-1:a[1]>b[1]?1:0)
  .map(row=>'['+row.map(value=>JSON.stringify(value)).join(', ')+']').join(',') + ']';

export function buildContinuityPlan({ snapshot, profiles, sourceIssuer, targetIssuer, expectedInstanceId, lifetimeEligibleSubjects, runId = randomUUID() }) {
  if (!UUID.test(runId) || !ISSUER.test(sourceIssuer) || !ISSUER.test(targetIssuer) || sourceIssuer===targetIssuer
    || !expectedInstanceId || snapshot?.instance_id!==expectedInstanceId || !Array.isArray(snapshot?.records)
    || !Number.isFinite(Date.parse(snapshot.read_at)) || !Array.isArray(profiles) || !Array.isArray(lifetimeEligibleSubjects)) throw new Error('invalid reviewed snapshot input');
  const bySubject = new Map(), profileIds = new Set(), verifiedEmails = new Set(), seenSubjects = new Set();
  for (const profile of profiles) {
    if (!UUID.test(profile.id) || !SUBJECT.test(profile.auth_user_id) || bySubject.has(profile.auth_user_id) || profileIds.has(profile.id)) throw new Error('ambiguous profile snapshot');
    bySubject.set(profile.auth_user_id,profile); profileIds.add(profile.id);
  }
  const eligible = new Set(lifetimeEligibleSubjects);
  if (eligible.size!==lifetimeEligibleSubjects.length) throw new Error('duplicate eligibility identity');
  const members=[];
  for (const u of snapshot.records) {
    const email=typeof u.primary_email==='string'?u.primary_email.trim().toLowerCase():'';
    if (!SUBJECT.test(u.subject) || seenSubjects.has(u.subject) || u.primary_verified!==true || u.banned===true || u.locked===true
      || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length>320 || verifiedEmails.has(email)
      || !Number.isSafeInteger(u.created_at_ms) || !Number.isSafeInteger(u.updated_at_ms)
      || u.created_at_ms<=0 || u.updated_at_ms<u.created_at_ms) throw new Error('source identities require reconciliation');
    const profile=bySubject.get(u.subject);
    if (profile?.deleted_at) throw new Error('closed profile requires review');
    seenSubjects.add(u.subject); verifiedEmails.add(email);
    const lifetime=eligible.has(u.subject);
    if (lifetime && u.created_at_ms>Date.parse(LIFETIME_CUTOFF)) throw new Error('eligibility exceeds original registered-account cutoff');
    members.push([profile?.id??null,u.subject,email,u.updated_at_ms,u.created_at_ms,lifetime]);
  }
  if (!members.length || [...eligible].some(subject=>!seenSubjects.has(subject)) || [...bySubject.keys()].some(subject=>!seenSubjects.has(subject))) throw new Error('snapshot coverage incomplete');
  members.sort((a,b)=>a[1]<b[1]?-1:a[1]>b[1]?1:0);
  return {schemaVersion:1,runId,sourceIssuer,targetIssuer,sourceInstanceId:expectedInstanceId,observedAt:snapshot.read_at,
    lifetimeCutoffAt:LIFETIME_CUTOFF,manifestSHA256:createHash('sha256').update(canonicalMembers(members)).digest('hex'),
    members,enabled:false,counts:{accounts:members.length,existingProfiles:members.filter(x=>x[0]).length,lifetimeEligible:members.filter(x=>x[5]).length}};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--apply')) throw new Error('This tool only prepares a reviewed manifest; it never applies changes.');
  const flag=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
  const input=flag('--input'), output=flag('--output');
  if (!input||!output) throw new Error('Use --input reviewed-input.json --output private-manifest.json');
  const plan=buildContinuityPlan(JSON.parse(await readFile(input,'utf8')));
  await writeFile(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({state:'prepared_only',...plan.counts,manifestSHA256:plan.manifestSHA256}));
}
