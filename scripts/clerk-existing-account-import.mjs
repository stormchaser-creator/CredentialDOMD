#!/usr/bin/env node
/** Offline preparation only. This module has no provider, credential or apply path. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalMembers } from './clerk-continuity-plan.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
const HASH = /^[a-f0-9]{64}$/;
const INSTANCE = /^ins_[A-Za-z0-9]+$/;
const ISSUER = /^https:\/\/[a-z0-9.-]+$/;
const MAX_AGE_MS = 5 * 60_000;
const FUTURE_ALLOWANCE_MS = 10_000;
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value) && !/[\x00-\x1f\x7f]/.test(value);
const syntheticEmail = value => /\+clerk_test(?:[+@])|@(?:example\.(?:com|org|net)|[^@]*\.invalid)$/i.test(value);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestObject = value => sha256(JSON.stringify(value));
const fail = code => { throw new Error(code); };
const fresh = (value, now) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + FUTURE_ALLOWANCE_MS && Date.parse(value) >= now - MAX_AGE_MS;
const sorted = values => [...values].sort();
export const selectedSubjectDigest = subjects => digestObject(sorted(subjects));

function reviewInput(review, manifest) {
  if (review?.schemaVersion !== 1 || !UUID.test(review.runId) || !HASH.test(review.manifestSHA256)
    || !INSTANCE.test(review.sourceInstanceId) || !INSTANCE.test(review.targetInstanceId)
    || review.sourceInstanceId === review.targetInstanceId || !ISSUER.test(review.sourceIssuer)
    || !ISSUER.test(review.targetIssuer) || review.sourceIssuer === review.targetIssuer
    || !Number.isSafeInteger(review.expectedManifestAccounts) || review.expectedManifestAccounts < 1
    || !Number.isSafeInteger(review.expectedProductionUsers) || review.expectedProductionUsers < 0
    || !Number.isSafeInteger(review.expectedSelectedAccounts) || review.expectedSelectedAccounts < 1 || !HASH.test(review.selectedSubjectSHA256)
    || !Array.isArray(review.selectedSourceSubjects) || !Array.isArray(review.excluded)) fail('invalid_review');
  if (manifest?.schemaVersion !== 1 || manifest.runId !== review.runId || manifest.manifestSHA256 !== review.manifestSHA256
    || manifest.sourceInstanceId !== review.sourceInstanceId || manifest.sourceIssuer !== review.sourceIssuer
    || manifest.targetIssuer !== review.targetIssuer || !Array.isArray(manifest.members)
    || manifest.members.length !== review.expectedManifestAccounts) fail('manifest_pin_mismatch');
  const seenSubjects = new Set(), seenEmails = new Set(), seenProfiles = new Set();
  for (const row of manifest.members) {
    if (!Array.isArray(row) || row.length !== 6 || (row[0] !== null && !UUID.test(row[0])) || !SUBJECT.test(row[1])
      || !validEmail(row[2]) || row[2] !== normalizeEmail(row[2]) || !Number.isSafeInteger(row[3])
      || !Number.isSafeInteger(row[4]) || row[4] <= 0 || row[3] < row[4] || typeof row[5] !== 'boolean'
      || seenSubjects.has(row[1]) || seenEmails.has(row[2]) || (row[0] && seenProfiles.has(row[0]))) fail('invalid_manifest_members');
    seenSubjects.add(row[1]); seenEmails.add(row[2]); if (row[0]) seenProfiles.add(row[0]);
  }
  if (sha256(canonicalMembers(manifest.members)) !== review.manifestSHA256) fail('manifest_digest_mismatch');
  const selected = new Set(review.selectedSourceSubjects);
  if (selected.size !== review.expectedSelectedAccounts || selected.size !== review.selectedSourceSubjects.length
    || [...selected].some(subject => !seenSubjects.has(subject))
    || selectedSubjectDigest(selected) !== review.selectedSubjectSHA256) fail('invalid_reviewed_subset');
  const excluded = new Set();
  for (const entry of review.excluded) {
    if (!seenSubjects.has(entry?.sourceSubject) || selected.has(entry.sourceSubject) || excluded.has(entry.sourceSubject)
      || !['synthetic_test', 'owner_excluded', 'deferred_batch'].includes(entry.reason)) fail('invalid_reviewed_exclusion');
    excluded.add(entry.sourceSubject);
  }
  if (excluded.size + selected.size !== seenSubjects.size) fail('reviewed_subset_incomplete');
  return selected;
}

function snapshotUsers(snapshot, instance, expectedCount, now, hold, label) {
  if (!snapshot || snapshot.instanceId !== instance || snapshot.complete !== true || !Array.isArray(snapshot.users)
    || snapshot.users.length !== expectedCount || (snapshot.totalCount !== undefined && snapshot.totalCount !== expectedCount)
    || snapshot.nextCursor || snapshot.failedPages || !fresh(snapshot.readAt, now)
    || (snapshot.completedAt !== undefined && (!fresh(snapshot.completedAt, now) || Date.parse(snapshot.completedAt) < Date.parse(snapshot.readAt)))) {
    hold.add(`${label}_snapshot_unavailable`); return [];
  }
  const ids = new Set();
  for (const user of snapshot.users) {
    if (!SUBJECT.test(user?.id) || ids.has(user.id)) { hold.add(`${label}_snapshot_ambiguous`); return []; }
    ids.add(user.id);
  }
  return snapshot.users;
}

function identity(user) {
  if (!user || !Array.isArray(user.email_addresses) || !Number.isSafeInteger(user.created_at)
    || !Number.isSafeInteger(user.updated_at) || user.created_at <= 0 || user.updated_at < user.created_at
    || user.banned !== false || user.locked !== false || user.deleted === true
    || user.two_factor_enabled !== false || user.totp_enabled !== false || user.backup_code_enabled !== false
    || user.passkey_count !== 0 || user.saml_account_count !== 0 || user.enterprise_account_count !== 0) return null;
  const emails = new Map(), ids = new Set();
  for (const email of user.email_addresses) {
    const address = normalizeEmail(email?.email_address);
    if (typeof email?.id !== 'string' || ids.has(email.id) || !validEmail(address) || emails.has(address)
      || email.matches_sso_connection === true) return null;
    ids.add(email.id); emails.set(address, email);
  }
  const primary = user.email_addresses.find(email => email.id === user.primary_email_address_id);
  if (!primary) return null;
  return { primary, email: normalizeEmail(primary.email_address), emails };
}

function marker(review, subject) {
  return { schemaVersion: 1, runId: review.runId, manifestSHA256: review.manifestSHA256, sourceSubject: subject };
}
function markerMatches(actual, expected) {
  return actual && Object.keys(actual).length === 4 && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Inputs are private reviewed files. No assertion here grants account access. */
export function buildExistingAccountImportPlan({ review, manifest, sourceSnapshot, targetSnapshot, accountSnapshot, authConfig }, { nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(nowMs)) fail('invalid_clock');
  const selected = reviewInput(review, manifest);
  const globalHolds = new Set();
  const sources = snapshotUsers(sourceSnapshot, review.sourceInstanceId, review.expectedManifestAccounts, nowMs, globalHolds, 'source');
  const targets = snapshotUsers(targetSnapshot, review.targetInstanceId, review.expectedProductionUsers, nowMs, globalHolds, 'target');
  if (authConfig?.instanceId !== review.targetInstanceId || !fresh(authConfig.readAt, nowMs)
    || authConfig.emailCodeSignInEnabled !== true || authConfig.emailCodeVerificationEnabled !== true) globalHolds.add('email_code_configuration_unproved');
  if (accountSnapshot?.runId !== review.runId || accountSnapshot.manifestSHA256 !== review.manifestSHA256
    || accountSnapshot.sourceIssuer !== review.sourceIssuer || accountSnapshot.targetIssuer !== review.targetIssuer
    || accountSnapshot.enabled !== true || !fresh(accountSnapshot.readAt, nowMs)
    || accountSnapshot.complete !== true || !Array.isArray(accountSnapshot.accounts)
    || accountSnapshot.accounts.length !== review.expectedManifestAccounts) globalHolds.add('continuity_account_state_unproved');
  const sourceById = new Map(sources.map(user => [user.id, user]));
  if (sources.length && manifest.members.some(row => !sourceById.has(row[1]))) globalHolds.add('source_snapshot_scope_mismatch');
  const sealedSubjects = new Set(manifest.members.map(row => row[1]));
  const targetByExternal = new Map(), targetByEmail = new Map();
  for (const target of targets) {
    // Every address participates, including unverified or secondary addresses.
    // Malformed unrelated records prevent a complete absence/collision proof.
    if (sealedSubjects.has(target.id)) globalHolds.add('target_subject_conflicts_with_legacy');
    if (!Array.isArray(target.email_addresses)) { globalHolds.add('target_email_inventory_incomplete'); continue; }
    if (target.external_id !== null && target.external_id !== undefined && typeof target.external_id !== 'string') globalHolds.add('target_external_id_invalid');
    if (target.external_id) {
      if (targetByExternal.has(target.external_id)) globalHolds.add('target_external_id_ambiguous');
      targetByExternal.set(target.external_id, target);
    }
    for (const email of target.email_addresses) {
      const address = normalizeEmail(email?.email_address);
      if (!validEmail(address)) { globalHolds.add('target_email_inventory_incomplete'); continue; }
      if (targetByEmail.has(address)) globalHolds.add('target_email_ambiguous');
      targetByEmail.set(address, target);
    }
  }
  const accountBySource = new Map();
  for (const account of Array.isArray(accountSnapshot?.accounts) ? accountSnapshot.accounts : []) {
    if (!SUBJECT.test(account?.sourceSubject) || accountBySource.has(account.sourceSubject)) globalHolds.add('continuity_account_state_ambiguous');
    accountBySource.set(account?.sourceSubject, account);
  }
  if (accountBySource.size && manifest.members.some(row => !accountBySource.has(row[1]))) globalHolds.add('continuity_account_scope_mismatch');
  const entries = [];
  for (const row of [...manifest.members].sort((a, b) => a[1] < b[1] ? -1 : 1)) {
    const [profileId, sourceSubject, email, updatedMs, createdMs, lifetimeEligible] = row;
    if (!selected.has(sourceSubject)) {
      entries.push({ sourceSubject, profileId, action: 'excluded', reason: review.excluded.find(item => item.sourceSubject === sourceSubject).reason });
      continue;
    }
    const holds = new Set();
    const source = sourceById.get(sourceSubject), proof = identity(source);
    if (syntheticEmail(email)) holds.add('synthetic_identity_not_importable');
    if (!proof || proof.email !== email || proof.primary.verification?.status !== 'verified'
      || source.created_at !== createdMs || source.updated_at < updatedMs) holds.add('source_identity_requires_review');
    const account = accountBySource.get(sourceSubject);
    if (!account || (account.profileId !== profileId && !(profileId === null && account.state === 'bound' && UUID.test(account.profileId))) || account.verifiedPrimaryEmail !== email
      || account.sourceCreatedMs !== createdMs || account.sourceUpdatedMs !== updatedMs || account.lifetimeEligible !== lifetimeEligible
      || !['prepared', 'bound'].includes(account.state) || account.closed !== false
      || account.unexpectedSourceProfile !== false
      || (account.profileId && (!['active', 'pending'].includes(account.profileAccessStatus)
        || account.profileSubject !== (account.state === 'bound' ? account.targetSubject : sourceSubject)))
      || (!account.profileId && (account.profileAccessStatus !== null || account.profileSubject !== null))) holds.add('continuity_account_requires_review');
    const existing = targetByExternal.get(sourceSubject), collision = targetByEmail.get(email);
    if (collision && collision.id !== existing?.id) holds.add('target_mailbox_conflict');
    if (account?.state === 'bound' && (!existing || account.targetSubject !== existing.id)) holds.add('bound_target_conflict');
    if (account?.state === 'prepared' && account.targetSubject !== null) holds.add('prepared_target_conflict');
    let operation = null;
    if (existing) {
      const targetIdentity = identity(existing);
      const reservedOrVerified = targetIdentity && (targetIdentity.primary.verification?.status === 'verified'
        || (targetIdentity.primary.reserved === true && (targetIdentity.primary.verification === null
          || targetIdentity.primary.verification?.status === 'unverified')));
      if (!targetIdentity || targetIdentity.email !== email || !reservedOrVerified
        || !markerMatches(existing.private_metadata?.credentialdomd_continuity, marker(review, sourceSubject))) holds.add('existing_target_requires_review');
      if (account?.state === 'bound' && targetIdentity?.primary.verification?.status !== 'verified') holds.add('bound_target_not_verified');
      if (!holds.size) operation = { action: 'skip_existing', targetSubject: existing.id,
        emailVerified: targetIdentity.primary.verification?.status === 'verified' };
    } else if (!holds.size) {
      operation = { action: 'create_reserved', payload: {
        external_id: sourceSubject, email_address: [email], email_address_identification_status: ['reserved'],
        skip_password_requirement: true,
        private_metadata: { credentialdomd_continuity: marker(review, sourceSubject) },
      } };
    }
    entries.push({ sourceSubject, profileId, email, action: holds.size ? 'hold' : operation.action,
      holds: sorted(holds), ...(operation ?? {}) });
  }
  const held = entries.filter(entry => entry.action === 'hold').length;
  const readyForReview = globalHolds.size === 0 && held === 0;
  const body = {
    schemaVersion: 1, mode: 'offline_dry_run', generatedAt: new Date(nowMs).toISOString(),
    runId: review.runId, manifestSHA256: review.manifestSHA256, selectedSubjectSHA256: review.selectedSubjectSHA256, reviewSHA256: digestObject(review),
    evidenceSHA256: { source: digestObject(sourceSnapshot), target: digestObject(targetSnapshot),
      accounts: digestObject(accountSnapshot ?? null), authConfig: digestObject(authConfig ?? null) },
    sourceInstanceId: review.sourceInstanceId, targetInstanceId: review.targetInstanceId,
    readyForReview, applyAuthorized: false, providerWrites: 0,
    globalHolds: sorted(globalHolds),
    counts: { manifest: entries.length, selected: selected.size, excluded: entries.length - selected.size,
      proposedCreates: entries.filter(entry => entry.action === 'create_reserved').length,
      existing: entries.filter(entry => entry.action === 'skip_existing').length, held,
      executableCreates: 0 },
    entries,
  };
  return { ...body, planSHA256: digestObject(body) };
}

export async function runOfflineCli(argv) {
  const allowed = new Set(['--input', '--review', '--expected-review-sha256', '--output']);
  if (argv.length !== 8 || argv.some((value, index) => index % 2 === 0 && !allowed.has(value))) fail('offline_only_arguments_required');
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (flags.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('offline_only_arguments_required');
    flags.set(argv[i], argv[i + 1]);
  }
  const rawReview = await readFile(flags.get('--review'));
  if (!HASH.test(flags.get('--expected-review-sha256')) || sha256(rawReview) !== flags.get('--expected-review-sha256')) fail('review_file_digest_mismatch');
  const input = JSON.parse(await readFile(flags.get('--input'), 'utf8'));
  const plan = buildExistingAccountImportPlan({ ...input, review: JSON.parse(rawReview) });
  await writeFile(flags.get('--output'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { state: plan.readyForReview ? 'prepared_only' : 'held', ...plan.counts, planSHA256: plan.planSHA256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runOfflineCli(process.argv.slice(2)))); }
  catch (error) {
    // File/parser errors can contain private paths or input; emit only known codes.
    const code = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'offline_plan_failed';
    console.error(JSON.stringify({ state: 'rejected', code })); process.exitCode = 1;
  }
}
