import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExistingAccountImportPlan, selectedSubjectDigest, sha256 } from '../../scripts/clerk-existing-account-import.mjs';
import { canonicalMembers } from '../../scripts/clerk-continuity-plan.mjs';
import { executeReviewedReservedImport, importPayloadDigest } from '../../scripts/clerk-existing-account-executor.mjs';

const NOW = Date.parse('2026-09-20T20:00:00Z');
const clone = value => structuredClone(value);
const uuid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function setup({ selected = 2 } = {}) {
  let clock = NOW;
  const members = [1, 2].map(n => [uuid(n), `user_Source${n}`, `member${n}@synthetic.test`, NOW - 20_000, NOW - 100_000, true]);
  const manifest = { schemaVersion: 1, runId: uuid(100), sourceInstanceId: 'ins_Development',
    sourceIssuer: 'https://dev.clerk.accounts.dev', targetIssuer: 'https://clerk.synthetic.test', members,
    manifestSHA256: sha256(canonicalMembers(members)) };
  const selectedSourceSubjects = members.slice(0, selected).map(row => row[1]);
  const review = { schemaVersion: 1, runId: manifest.runId, manifestSHA256: manifest.manifestSHA256,
    sourceInstanceId: manifest.sourceInstanceId, targetInstanceId: 'ins_Production', sourceIssuer: manifest.sourceIssuer,
    targetIssuer: manifest.targetIssuer, expectedManifestAccounts: 2, expectedSelectedAccounts: selected,
    expectedProductionUsers: 0, selectedSourceSubjects, selectedSubjectSHA256: selectedSubjectDigest(selectedSourceSubjects),
    excluded: members.slice(selected).map(row => ({ sourceSubject: row[1], reason: 'deferred_batch' })) };
  const users = members.map((row, index) => ({ id: row[1], external_id: null, created_at: row[4], updated_at: row[3],
    primary_email_address_id: `email_${index}`, email_addresses: [{ id: `email_${index}`, email_address: row[2], reserved: false, verification: { status: 'verified' }, matches_sso_connection: false }],
    private_metadata: {}, banned: false, locked: false, two_factor_enabled: false, totp_enabled: false,
    backup_code_enabled: false, passkey_count: 0, enterprise_account_count: 0, saml_account_count: 0 }));
  const readAt = new Date(NOW - 1_000).toISOString();
  const evidence = { manifest,
    sourceSnapshot: { readAt, complete: true, instanceId: review.sourceInstanceId, users },
    targetSnapshot: { readAt, complete: true, instanceId: review.targetInstanceId, users: [] },
    accountSnapshot: { readAt, complete: true, runId: review.runId, manifestSHA256: review.manifestSHA256,
      sourceIssuer: review.sourceIssuer, targetIssuer: review.targetIssuer, enabled: true,
      accounts: members.map(row => ({ sourceSubject: row[1], profileId: row[0], verifiedPrimaryEmail: row[2],
        sourceCreatedMs: row[4], sourceUpdatedMs: row[3], lifetimeEligible: true, state: 'prepared', targetSubject: null,
        profileSubject: row[1], profileAccessStatus: 'active', closed: false, unexpectedSourceProfile: false })) },
    authConfig: { readAt, instanceId: review.targetInstanceId, emailCodeSignInEnabled: true, emailCodeVerificationEnabled: true } };
  const log = [], receipts = [], state = clone(evidence);
  const plan = buildExistingAccountImportPlan({ ...evidence, review }, { nowMs: NOW });
  const input = { review, reviewedEvidence: evidence, plan,
    approval: { confirmed: true, runId: review.runId, targetInstanceId: review.targetInstanceId,
      planSHA256: plan.planSHA256, payloadSHA256: importPayloadDigest(plan), reviewSHA256: plan.reviewSHA256,
      selectedSubjectSHA256: review.selectedSubjectSHA256, maxCreates: plan.counts.proposedCreates } };
  let queue = Promise.resolve();
  const adapters = {
    now: () => clock,
    withExclusiveLock: async (_key, action) => {
      const prior = queue; let release; queue = new Promise(resolve => { release = resolve; });
      await prior; try { return await action(); } finally { release(); }
    },
    readEvidence: async () => { log.push({ kind: 'read' }); return clone(state); },
    appendReceipt: async event => { receipts.push(clone(event)); log.push({ kind: 'receipt', receiptKind: event.kind }); },
    createReservedUser: async (payload, scope) => {
      log.push({ kind: 'create', payload: clone(payload), scope });
      const source = state.sourceSnapshot.users.find(user => user.id === payload.external_id), target = clone(source);
      target.id = `user_Target${state.targetSnapshot.users.length + 1}`; target.external_id = payload.external_id;
      target.created_at = clock; target.updated_at = clock; target.email_addresses[0].reserved = true;
      target.email_addresses[0].verification = null; target.private_metadata = clone(payload.private_metadata);
      state.targetSnapshot.users.push(target);
      return clone(target);
    },
  };
  return { input, adapters, state, log, receipts, advance: ms => { clock += ms; } };
}
const run = setupValue => executeReviewedReservedImport(setupValue.input, setupValue.adapters);
const creates = setupValue => setupValue.log.filter(item => item.kind === 'create');

test('two explicit reserved creates have durable intents, fresh complete readback and bounded receipts', async () => {
  const s = setup(), result = await run(s);
  assert.equal(result.state, 'complete'); assert.equal(result.confirmedCreated, 2); assert.equal(result.providerCreateCalls, 2);
  assert.equal(creates(s).length, 2);
  for (const request of creates(s)) {
    assert.deepEqual(request.scope, { targetInstanceId: s.input.review.targetInstanceId });
    assert.deepEqual(request.payload.email_address_identification_status, ['reserved']);
    assert.equal(request.payload.skip_password_requirement, true);
    assert.equal(s.log[s.log.indexOf(request) - 1].receiptKind, 'create_intent');
  }
  assert.equal(s.receipts.filter(event => event.kind === 'created_reserved').length, 2);
  assert.ok(s.receipts.every(event => event.planSHA256 === s.input.plan.planSHA256));
  assert.doesNotMatch(JSON.stringify(s.receipts), /member1@|password|verification|secret|token/);
});
test('owner-only pilot creates one even when the sealed manifest has other real users', async () => {
  const s = setup({ selected: 1 }), result = await run(s);
  assert.equal(result.state, 'complete'); assert.equal(creates(s).length, 1); assert.equal(s.state.targetSnapshot.users.length, 1);
});
for (const [name, mutation] of [
  ['unconfirmed approval', s => { s.input.approval.confirmed = false; }],
  ['payload hash', s => { s.input.approval.payloadSHA256 = '0'.repeat(64); }],
  ['plan hash', s => { s.input.approval.planSHA256 = '0'.repeat(64); }],
  ['changed target instance', s => { s.input.approval.targetInstanceId = 'ins_Wrong'; }],
  ['higher create allowance', s => { s.input.approval.maxCreates++; }],
  ['tampered plan request', s => { s.input.plan.entries[0].payload.email_address_identification_status = ['verified']; }],
  ['tampered original evidence', s => { s.input.reviewedEvidence.accountSnapshot.accounts[0].closed = true; }],
]) test(`reject ${name} before provider reads/writes`, async () => {
  const s = setup(); mutation(s); await assert.rejects(run(s)); assert.equal(s.log.length, 0);
});
test('missing exclusive lock prevents execution', async () => {
  const s = setup(); delete s.adapters.withExclusiveLock; await assert.rejects(run(s), /invalid_import_adapters/); assert.equal(s.log.length, 0);
});
for (const [name, mutation] of [
  ['source primary change', s => { s.state.sourceSnapshot.users[0].email_addresses[0].email_address = 'changed@synthetic.test'; }],
  ['source factor changed', s => { s.state.sourceSnapshot.users[0].two_factor_enabled = true; }],
  ['profile closed', s => { s.state.accountSnapshot.accounts[0].closed = true; }],
  ['profile revoked', s => { s.state.accountSnapshot.accounts[0].profileAccessStatus = 'revoked'; }],
  ['email-code turned off', s => { s.state.authConfig.emailCodeSignInEnabled = false; }],
  ['stale read', s => { s.advance(300_001); }],
  ['incomplete target read', s => { s.state.targetSnapshot.complete = false; }],
]) test(`fresh preflight ${name} stops before POST`, async () => {
  const s = setup(); mutation(s); const result = await run(s);
  assert.equal(result.state, 'held'); assert.equal(creates(s).length, 0);
});
test('slow intent receipt does not extend freshness into provider write', async () => {
  const s = setup(), append = s.adapters.appendReceipt;
  s.adapters.appendReceipt = async event => { await append(event); if (event.kind === 'create_intent') s.advance(300_001); };
  const result = await run(s); assert.equal(result.state, 'held'); assert.equal(result.reason, 'intent_or_freshness_failed'); assert.equal(creates(s).length, 0);
});
test('intent receipt failure stops before create', async () => {
  const s = setup(); s.adapters.appendReceipt = async event => { if (event.kind === 'create_intent') throw new Error('synthetic'); };
  const result = await run(s); assert.equal(result.state, 'held'); assert.equal(creates(s).length, 0);
});
test('timeout after successful create reconciles exact reserved identity with no duplicate POST', async () => {
  const s = setup(), create = s.adapters.createReservedUser;
  s.adapters.createReservedUser = async (...args) => { await create(...args); throw new Error('synthetic uncertain response'); };
  const result = await run(s); assert.equal(result.state, 'complete'); assert.equal(result.confirmedCreated, 2);
  assert.equal(creates(s).length, 2); assert.equal(s.receipts.filter(event => event.kind === 'created_reconciled').length, 2);
});
test('timeout without confirmed identity stops, never retries or attempts remaining user', async () => {
  const s = setup(); let calls = 0;
  s.adapters.createReservedUser = async () => { calls++; throw new Error('synthetic lost response'); };
  const result = await run(s); assert.equal(result.state, 'unresolved'); assert.equal(result.reason, 'readback_unproved'); assert.equal(calls, 1);
});
test('wrong or already-verified create response stops remaining batch without cleanup', async () => {
  const s = setup(), create = s.adapters.createReservedUser;
  s.adapters.createReservedUser = async (...args) => { const target = await create(...args); target.email_addresses[0].verification = { status: 'verified' }; return target; };
  const result = await run(s); assert.equal(result.state, 'unresolved'); assert.equal(result.reason, 'unexpected_create_response');
  assert.equal(creates(s).length, 1); assert.equal(s.state.targetSnapshot.users.length, 1);
});
test('response success but fresh provider state unproved never continues', async () => {
  const s = setup(), create = s.adapters.createReservedUser;
  s.adapters.createReservedUser = async (...args) => { const response = await create(...args); s.state.targetSnapshot.users[0].private_metadata = {}; return response; };
  const result = await run(s); assert.equal(result.state, 'unresolved'); assert.equal(result.reason, 'readback_unproved'); assert.equal(creates(s).length, 1);
});
test('uncertain create plus unrelated production identity cannot be silently accepted', async () => {
  const s = setup(), create = s.adapters.createReservedUser;
  s.adapters.createReservedUser = async (...args) => {
    await create(...args); const unrelated = clone(s.state.targetSnapshot.users[0]); unrelated.id = 'user_Unrelated';
    unrelated.external_id = 'unrelated'; unrelated.email_addresses[0].email_address = 'unrelated@synthetic.test';
    s.state.targetSnapshot.users.push(unrelated); throw new Error('synthetic timeout');
  };
  const result = await run(s); assert.equal(result.state, 'unresolved'); assert.equal(creates(s).length, 1);
});
test('confirmation receipt failure retains known created identity and stops', async () => {
  const s = setup(), append = s.adapters.appendReceipt;
  s.adapters.appendReceipt = async event => { if (event.kind === 'created_reserved') throw new Error('synthetic disk error'); await append(event); };
  const result = await run(s); assert.equal(result.state, 'unresolved'); assert.equal(result.confirmedCreated, 1);
  assert.equal(result.reason, 'confirmation_receipt_unavailable'); assert.equal(creates(s).length, 1);
});
test('source changes after first confirmed identity stop subsequent create', async () => {
  const s = setup(), append = s.adapters.appendReceipt;
  s.adapters.appendReceipt = async event => { await append(event); if (event.kind === 'created_reserved') s.state.sourceSnapshot.users[1].locked = true; };
  const result = await run(s); assert.equal(result.state, 'held'); assert.equal(result.confirmedCreated, 1); assert.equal(creates(s).length, 1);
});
test('same old plan concurrent execution serializes; second observes changed inventory and creates nothing', async () => {
  const s = setup(); const outcomes = await Promise.all([run(s), run(s)]);
  assert.deepEqual(outcomes.map(outcome => outcome.state), ['complete', 'held']); assert.equal(creates(s).length, 2);
});
test('reviewed partial retry with exact reserved or bound identity performs zero duplicate creates', async () => {
  const s = setup(); const first = await run(s); assert.equal(first.state, 'complete');
  const target = s.state.targetSnapshot.users[0], account = s.state.accountSnapshot.accounts[0];
  target.email_addresses[0].reserved = false; target.email_addresses[0].verification = { status: 'verified' };
  account.state = 'bound'; account.targetSubject = target.id; account.profileSubject = target.id;
  const review = { ...s.input.review, expectedProductionUsers: 2 }, evidence = clone(s.state);
  const plan = buildExistingAccountImportPlan({ ...evidence, review }, { nowMs: NOW });
  s.input = { review, reviewedEvidence: evidence, plan, approval: { ...s.input.approval, planSHA256: plan.planSHA256,
    payloadSHA256: importPayloadDigest(plan), reviewSHA256: plan.reviewSHA256, maxCreates: 0 } };
  const result = await run(s); assert.equal(result.state, 'complete'); assert.equal(result.providerCreateCalls, 0);
  assert.equal(result.confirmedCreated, 0); assert.equal(result.completed.filter(entry => entry.state === 'existing').length, 2);
  assert.equal(creates(s).length, 2);
});
