import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExistingAccountImportPlan, selectedSubjectDigest, sha256 } from '../../scripts/clerk-existing-account-import.mjs';
import { canonicalMembers } from '../../scripts/clerk-continuity-plan.mjs';

const NOW = Date.parse('2026-09-20T19:00:00Z');
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => structuredClone(value);
function fixture(now = NOW) {
  const members = Array.from({ length: 12 }, (_, i) => [i < 10 ? uuid(i + 1) : null, `user_Source${i + 1}`,
    i === 11 ? 'fixture+clerk_test@synthetic.test' : `person${i + 1}@synthetic.test`, now - 60_000, now - 100_000, i < 11]);
  const manifest = { schemaVersion: 1, runId: uuid(100), sourceInstanceId: 'ins_Development',
    sourceIssuer: 'https://development.clerk.accounts.dev', targetIssuer: 'https://clerk.synthetic.test', members,
    manifestSHA256: sha256(canonicalMembers(members)) };
  const selectedSourceSubjects = members.slice(0, 11).map(row => row[1]);
  const review = { schemaVersion: 1, runId: manifest.runId, manifestSHA256: manifest.manifestSHA256,
    sourceInstanceId: manifest.sourceInstanceId, targetInstanceId: 'ins_Production',
    sourceIssuer: manifest.sourceIssuer, targetIssuer: manifest.targetIssuer,
    expectedManifestAccounts: 12, expectedSelectedAccounts: 11, expectedProductionUsers: 0,
    selectedSourceSubjects, selectedSubjectSHA256: selectedSubjectDigest(selectedSourceSubjects),
    excluded: [{ sourceSubject: members[11][1], reason: 'synthetic_test' }] };
  const users = members.map((row, i) => ({ id: row[1], external_id: null, created_at: row[4], updated_at: row[3],
    primary_email_address_id: `id_${i}`, email_addresses: [{ id: `id_${i}`, email_address: row[2],
      reserved: false, verification: { status: 'verified' }, matches_sso_connection: false }],
    banned: false, locked: false, deleted: false, two_factor_enabled: false, totp_enabled: false,
    backup_code_enabled: false, passkey_count: 0, saml_account_count: 0, enterprise_account_count: 0,
    private_metadata: {}, oauth_providers: [] }));
  const readAt = new Date(now - 1_000).toISOString();
  return { review, manifest,
    sourceSnapshot: { readAt, complete: true, instanceId: review.sourceInstanceId, users },
    targetSnapshot: { readAt, complete: true, instanceId: review.targetInstanceId, users: [] },
    authConfig: { readAt, instanceId: review.targetInstanceId, emailCodeSignInEnabled: true, emailCodeVerificationEnabled: true },
    accountSnapshot: { readAt, complete: true, runId: review.runId, manifestSHA256: review.manifestSHA256,
      sourceIssuer: review.sourceIssuer, targetIssuer: review.targetIssuer, enabled: true,
      accounts: members.map(row => ({ profileId: row[0], sourceSubject: row[1], verifiedPrimaryEmail: row[2],
        sourceCreatedMs: row[4], sourceUpdatedMs: row[3], lifetimeEligible: row[5], state: 'prepared', targetSubject: null,
        profileSubject: row[0] ? row[1] : null, profileAccessStatus: row[0] ? 'active' : null, closed: false, unexpectedSourceProfile: false })) } };
}
const plan = input => buildExistingAccountImportPlan(input, { nowMs: NOW });
function existingTarget(input, index = 0, verified = false) {
  const source = input.sourceSnapshot.users[index];
  const target = clone(source);
  target.id = `user_Target${index + 1}`; target.external_id = source.id;
  target.email_addresses[0].reserved = !verified;
  target.email_addresses[0].verification.status = verified ? 'verified' : 'unverified';
  target.private_metadata = { credentialdomd_continuity: { schemaVersion: 1, runId: input.review.runId,
    manifestSHA256: input.review.manifestSHA256, sourceSubject: source.id } };
  input.targetSnapshot.users.push(target); input.review.expectedProductionUsers++;
  return target;
}
function mustHold(input, expected) {
  const result = plan(input);
  assert.equal(result.readyForReview, false);
  assert.ok([...result.globalHolds, ...result.entries.flatMap(entry => entry.holds ?? [])].includes(expected));
  assert.equal(result.counts.executableCreates, 0); assert.equal(result.applyAuthorized, false);
}

test('exact reviewed eleven retain sealed twelve, ten profile UUIDs and lifetime evidence without execution', () => {
  const input = fixture(), before = clone(input), result = plan(input);
  assert.equal(result.readyForReview, true);
  assert.deepEqual(result.counts, { manifest: 12, selected: 11, excluded: 1, proposedCreates: 11, existing: 0, held: 0, executableCreates: 0 });
  assert.equal(result.providerWrites, 0); assert.equal(result.applyAuthorized, false);
  assert.equal(result.manifestSHA256, input.manifest.manifestSHA256);
  assert.equal(result.selectedSubjectSHA256, input.review.selectedSubjectSHA256);
  assert.deepEqual(input, before);
  for (const entry of result.entries.filter(entry => entry.action === 'create_reserved')) {
    assert.deepEqual(Object.keys(entry.payload).sort(), ['email_address', 'email_address_identification_status', 'external_id', 'private_metadata', 'skip_password_requirement']);
    assert.deepEqual(entry.payload.email_address_identification_status, ['reserved']);
    assert.equal(entry.payload.skip_password_requirement, true);
    assert.equal(entry.payload.external_id, entry.sourceSubject);
    assert.deepEqual(entry.payload.private_metadata.credentialdomd_continuity,
      { schemaVersion: 1, runId: input.review.runId, manifestSHA256: input.review.manifestSHA256, sourceSubject: entry.sourceSubject });
  }
  assert.equal(result.entries.find(entry => entry.sourceSubject === 'user_Source11').profileId, null);
});

for (const [name, change, code] of [
  ['changed manifest row', x => { x.manifest.members[0][5] = false; }, 'manifest_digest_mismatch'],
  ['changed manifest hash', x => { x.manifest.manifestSHA256 = '0'.repeat(64); }, 'manifest_pin_mismatch'],
  ['eleven manifest rows', x => { x.manifest.members.pop(); }, 'manifest_pin_mismatch'],
  ['duplicate manifest subject', x => { x.manifest.members[1][1] = x.manifest.members[0][1]; }, 'invalid_manifest_members'],
  ['duplicate manifest profile', x => { x.manifest.members[1][0] = x.manifest.members[0][0]; }, 'invalid_manifest_members'],
  ['unreviewed subset mutation', x => { x.review.selectedSourceSubjects[0] = 'user_Source12'; }, 'invalid_reviewed_subset'],
  ['unaccounted exclusion', x => { x.review.excluded = []; }, 'reviewed_subset_incomplete'],
]) test(name, () => { const input = fixture(); change(input); assert.throws(() => plan(input), { message: code }); });

for (const [name, change, code] of [
  ['stale source read', x => { x.sourceSnapshot.readAt = new Date(NOW - 300_001).toISOString(); }, 'source_snapshot_unavailable'],
  ['future target read', x => { x.targetSnapshot.readAt = new Date(NOW + 10_001).toISOString(); }, 'target_snapshot_unavailable'],
  ['unfinished pagination', x => { x.targetSnapshot.nextCursor = 'next'; }, 'target_snapshot_unavailable'],
  ['failed page', x => { x.sourceSnapshot.failedPages = 1; }, 'source_snapshot_unavailable'],
  ['missing source row', x => { x.sourceSnapshot.users.pop(); }, 'source_snapshot_unavailable'],
  ['wrong instance', x => { x.targetSnapshot.instanceId = x.review.sourceInstanceId; }, 'target_snapshot_unavailable'],
  ['counter mismatch', x => { x.targetSnapshot.totalCount = 1; }, 'target_snapshot_unavailable'],
  ['unknown completeness', x => { delete x.sourceSnapshot.complete; }, 'source_snapshot_unavailable'],
  ['duplicate source snapshot', x => { x.sourceSnapshot.users[1] = clone(x.sourceSnapshot.users[0]); }, 'source_snapshot_ambiguous'],
  ['unrelated row replaces excluded source', x => { x.sourceSnapshot.users[11].id = 'user_Unrelated'; }, 'source_snapshot_scope_mismatch'],
  ['unrelated continuity row replaces excluded source', x => { x.accountSnapshot.accounts[11].sourceSubject = 'user_Unrelated'; }, 'continuity_account_scope_mismatch'],
  ['email-code disabled', x => { x.authConfig.emailCodeSignInEnabled = false; }, 'email_code_configuration_unproved'],
  ['configuration stale', x => { x.authConfig.readAt = new Date(NOW - 300_001).toISOString(); }, 'email_code_configuration_unproved'],
  ['missing current DB evidence', x => { delete x.accountSnapshot; }, 'continuity_account_state_unproved'],
  ['continuity disabled', x => { x.accountSnapshot.enabled = false; }, 'continuity_account_state_unproved'],
  ['tombstone or soft deletion', x => { x.accountSnapshot.accounts[0].closed = true; }, 'continuity_account_requires_review'],
  ['revoked profile', x => { x.accountSnapshot.accounts[0].profileAccessStatus = 'revoked'; }, 'continuity_account_requires_review'],
  ['profile switched', x => { x.accountSnapshot.accounts[0].profileSubject = 'user_Other'; }, 'continuity_account_requires_review'],
  ['unexpected new source profile', x => { x.accountSnapshot.accounts[10].unexpectedSourceProfile = true; }, 'continuity_account_requires_review'],
]) test(name, () => { const input = fixture(); change(input); mustHold(input, code); });

for (const [name, change] of [
  ['changed primary', u => { u.email_addresses[0].email_address = 'changed@synthetic.test'; }],
  ['unverified primary', u => { u.email_addresses[0].verification.status = 'unverified'; }],
  ['missing source primary', u => { u.primary_email_address_id = 'absent'; }],
  ['creation date drift', u => { u.created_at++; }],
  ['update clock regression', u => { u.updated_at--; }],
  ['banned', u => { u.banned = true; }], ['locked', u => { u.locked = true; }], ['deleted', u => { u.deleted = true; }],
  ['MFA', u => { u.two_factor_enabled = true; }], ['TOTP', u => { u.totp_enabled = true; }],
  ['backup codes', u => { u.backup_code_enabled = true; }], ['passkey', u => { u.passkey_count = 1; }],
  ['enterprise', u => { u.enterprise_account_count = 1; }], ['SAML', u => { u.saml_account_count = 1; }],
  ['unknown passkey inventory', u => { delete u.passkey_count; }],
  ['SSO-matched address', u => { u.email_addresses[0].matches_sso_connection = true; }],
]) test(`source ${name}`, () => { const input = fixture(); change(input.sourceSnapshot.users[0]); mustHold(input, 'source_identity_requires_review'); });

test('ordinary OAuth linkage, display updates and case normalization do not rewrite sealed proof', () => {
  const input = fixture(), source = input.sourceSnapshot.users[0];
  source.oauth_providers = ['oauth_google']; source.first_name = 'Updated'; source.updated_at++;
  source.email_addresses[0].email_address = ' Person1@Synthetic.test ';
  assert.equal(plan(input).readyForReview, true);
});
test('synthetic selected explicitly still held; lifetime flag is not a substitute for real-user review', () => {
  const input = fixture(); input.review.selectedSourceSubjects[0] = 'user_Source12';
  input.review.selectedSubjectSHA256 = selectedSubjectDigest(input.review.selectedSourceSubjects);
  input.review.excluded = [{ sourceSubject: 'user_Source1', reason: 'owner_excluded' }];
  mustHold(input, 'synthetic_identity_not_importable');
});
for (const verified of [false, true]) test(`exact ${verified ? 'verified' : 'reserved'} partial retry skips safely`, () => {
  const input = fixture(), target = existingTarget(input, 0, verified), result = plan(input);
  assert.equal(result.readyForReview, true); assert.equal(result.counts.proposedCreates, 10); assert.equal(result.counts.existing, 1);
  const entry = result.entries.find(item => item.targetSubject === target.id);
  assert.equal(entry.action, 'skip_existing'); assert.equal(entry.emailVerified, verified); assert.equal(entry.payload, undefined);
});
test('reserved target with explicit null verification safely skips without claiming verification', () => {
  const input = fixture(), target = existingTarget(input); target.email_addresses[0].verification = null;
  const result = plan(input); assert.equal(result.readyForReview, true); assert.equal(result.counts.existing, 1);
  assert.equal(result.entries.find(entry => entry.targetSubject === target.id).emailVerified, false);
  target.email_addresses[0].reserved = false; mustHold(input, 'existing_target_requires_review');
});
for (const [name, change, code] of [
  ['external ID differs', t => { t.external_id = 'user_Another'; }, 'target_mailbox_conflict'],
  ['external ID absent', t => { t.external_id = null; }, 'target_mailbox_conflict'],
  ['mailbox differs', t => { t.email_addresses[0].email_address = 'other@synthetic.test'; }, 'existing_target_requires_review'],
  ['missing protected marker', t => { t.private_metadata = {}; }, 'existing_target_requires_review'],
  ['changed marker run', t => { t.private_metadata.credentialdomd_continuity.runId = uuid(999); }, 'existing_target_requires_review'],
  ['unreserved unverified', t => { t.email_addresses[0].reserved = false; }, 'existing_target_requires_review'],
  ['missing reserved verification state', t => { delete t.email_addresses[0].verification; }, 'existing_target_requires_review'],
  ['blocked existing target', t => { t.locked = true; }, 'existing_target_requires_review'],
]) test(`existing ${name}`, () => { const input = fixture(), target = existingTarget(input); change(target); mustHold(input, code); });
test('secondary unverified mailbox collision is not ignored', () => {
  const input = fixture(), target = existingTarget(input, 1);
  target.email_addresses.push({ id: 'secondary', email_address: ' PERSON1@SYNTHETIC.TEST ', verification: { status: 'unverified' } });
  mustHold(input, 'target_mailbox_conflict');
});
for (const sourceSubject of ['user_Source1', 'user_Source2']) test(`production ID collision with ${sourceSubject} holds`, () => {
  const input = fixture(), target = existingTarget(input); target.id = sourceSubject;
  mustHold(input, 'target_subject_conflicts_with_legacy');
});
test('partial recovery cannot silently relax original reviewed production count', () => {
  const input = fixture(); existingTarget(input); input.review.expectedProductionUsers = 0;
  mustHold(input, 'target_snapshot_unavailable');
});
test('duplicate external IDs and cross-user duplicate addresses stop complete batch', () => {
  const input = fixture(), target = existingTarget(input), second = clone(target); second.id = 'user_Duplicate';
  input.targetSnapshot.users.push(second); input.review.expectedProductionUsers++;
  mustHold(input, 'target_external_id_ambiguous'); mustHold(input, 'target_email_ambiguous');
});
test('bound retry must agree with current target and retained profile ownership', () => {
  const input = fixture(), target = existingTarget(input, 0, true), account = input.accountSnapshot.accounts[0];
  account.state = 'bound'; account.targetSubject = target.id; account.profileSubject = target.id;
  assert.equal(plan(input).readyForReview, true);
  account.targetSubject = 'user_Conflict'; mustHold(input, 'bound_target_conflict');
});
test('bound previously profileless account preserves allocated profile without inventing one', () => {
  const input = fixture(), target = existingTarget(input, 10, true), account = input.accountSnapshot.accounts[10];
  account.state = 'bound'; account.targetSubject = target.id; account.profileSubject = target.id;
  account.profileId = uuid(500); account.profileAccessStatus = 'active';
  const result = plan(input); assert.equal(result.readyForReview, true);
  assert.equal(result.entries.find(entry => entry.targetSubject === target.id).profileId, null);
});
test('reviewed owner-only pilot and remaining ten keep sealed manifest; bound pilot is never recreated', () => {
  const input = fixture(), fullHash = input.manifest.manifestSHA256;
  input.review.selectedSourceSubjects = ['user_Source1']; input.review.expectedSelectedAccounts = 1;
  input.review.selectedSubjectSHA256 = selectedSubjectDigest(input.review.selectedSourceSubjects);
  input.review.excluded.push(...input.manifest.members.slice(1, 11).map(row => ({ sourceSubject: row[1], reason: 'deferred_batch' })));
  const pilot = plan(input); assert.equal(pilot.readyForReview, true); assert.equal(pilot.counts.proposedCreates, 1);
  const target = existingTarget(input, 0, true), account = input.accountSnapshot.accounts[0];
  account.state = 'bound'; account.targetSubject = target.id; account.profileSubject = target.id;
  assert.equal(plan(input).counts.existing, 1);
  input.review.selectedSourceSubjects = input.manifest.members.slice(1, 11).map(row => row[1]);
  input.review.expectedSelectedAccounts = 10; input.review.selectedSubjectSHA256 = selectedSubjectDigest(input.review.selectedSourceSubjects);
  input.review.excluded = [{ sourceSubject: 'user_Source1', reason: 'deferred_batch' }, { sourceSubject: 'user_Source12', reason: 'synthetic_test' }];
  const remaining = plan(input); assert.equal(remaining.readyForReview, true); assert.equal(remaining.counts.proposedCreates, 10);
  assert.equal(remaining.manifestSHA256, fullHash); assert.equal(remaining.entries.find(entry => entry.sourceSubject === target.external_id).action, 'excluded');
});
test('ordering does not change per-identity decisions or payloads', () => {
  const input = fixture(), original = plan(input); input.sourceSnapshot.users.reverse(); input.manifest.members.reverse();
  input.accountSnapshot.accounts.reverse(); input.review.selectedSourceSubjects.reverse();
  assert.deepEqual(plan(input).entries, original.entries);
});

test('CLI accepts pinned review, creates private new file and emits counts only; no apply or overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'credentialdomd-import-plan-'));
  try {
    const input = fixture(Date.now()), review = input.review; delete input.review;
    const rawReview = JSON.stringify(review), inputPath = join(dir, 'input.json'), reviewPath = join(dir, 'review.json'), outputPath = join(dir, 'plan.json');
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 }); await writeFile(reviewPath, rawReview, { mode: 0o600 });
    const script = fileURLToPath(new URL('../../scripts/clerk-existing-account-import.mjs', import.meta.url));
    const args = ['--input', inputPath, '--review', reviewPath, '--expected-review-sha256', sha256(rawReview), '--output', outputPath];
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, 'prepared_only'); assert.equal(JSON.parse(result.stdout).proposedCreates, 11);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(result.stdout + result.stderr, /person1|user_Source|@synthetic/);
    const before = await readFile(outputPath, 'utf8');
    assert.notEqual(spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' }).status, 0);
    assert.equal(await readFile(outputPath, 'utf8'), before);
    const wrong = [...args]; wrong[5] = '0'.repeat(64);
    const rejected = spawnSync(process.execPath, [script, ...wrong], { encoding: 'utf8' });
    assert.equal(JSON.parse(rejected.stderr).code, 'review_file_digest_mismatch');
    for (const option of ['--apply', '--token', '--api-key']) {
      const denied = spawnSync(process.execPath, [script, ...args, option], { encoding: 'utf8' });
      assert.notEqual(denied.status, 0); assert.equal(JSON.parse(denied.stderr).code, 'offline_only_arguments_required');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
