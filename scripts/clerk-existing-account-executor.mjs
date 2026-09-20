/** Reviewed execution core only. No CLI, network client or credentials.
 * The operator supplies reviewed transports, an exclusive lock and durable
 * private receipts. Importing this module cannot contact a provider.
 */
import { buildExistingAccountImportPlan, sha256 } from './clerk-existing-account-import.mjs';

const digest = value => sha256(JSON.stringify(value));
const copy = value => structuredClone(value);
const sameSet = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
export const importPayloadDigest = plan => digest(plan.entries.filter(entry => entry.action === 'create_reserved')
  .map(entry => ({ sourceSubject: entry.sourceSubject, payload: entry.payload })));

function assertApproval({ review, reviewedEvidence, plan, approval }) {
  const rebuilt = buildExistingAccountImportPlan({ ...reviewedEvidence, review }, { nowMs: Date.parse(plan?.generatedAt) });
  const { planSHA256, ...body } = plan;
  if (!plan.readyForReview || plan.mode !== 'offline_dry_run' || plan.providerWrites !== 0 || plan.applyAuthorized !== false
    || planSHA256 !== digest(body) || rebuilt.planSHA256 !== planSHA256
    || approval?.planSHA256 !== planSHA256 || approval?.payloadSHA256 !== importPayloadDigest(plan)
    || approval?.reviewSHA256 !== plan.reviewSHA256 || approval?.selectedSubjectSHA256 !== review.selectedSubjectSHA256
    || approval?.targetInstanceId !== review.targetInstanceId || approval?.runId !== review.runId
    || approval?.maxCreates !== plan.counts.proposedCreates || approval?.confirmed !== true) throw new Error('import_approval_mismatch');
}

function createdResponseMatches(response, entry) {
  if (!response || typeof response.id !== 'string' || response.external_id !== entry.sourceSubject
    || !Array.isArray(response.email_addresses)) return false;
  const primary = response.email_addresses.find(email => email.id === response.primary_email_address_id);
  const expected = entry.payload.private_metadata.credentialdomd_continuity;
  const actual = response.private_metadata?.credentialdomd_continuity;
  return primary?.email_address?.trim().toLowerCase() === entry.email && primary.reserved === true
    && (primary.verification === null || primary.verification?.status === 'unverified')
    && actual && Object.keys(actual).length === 4 && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Never invokes create twice for an uncertain identity in this execution.
 * A new execution requires fresh reviewed evidence and count after partial work.
 * Callers must keep receipts private and must never print provider responses.
 */
export async function executeReviewedReservedImport(input, adapters) {
  for (const name of ['readEvidence', 'createReservedUser', 'appendReceipt', 'withExclusiveLock']) {
    if (typeof adapters?.[name] !== 'function') throw new Error('invalid_import_adapters');
  }
  const fixed = copy(input);
  assertApproval(fixed);
  const now = adapters.now ?? Date.now;
  const key = `clerk-existing-import:${fixed.review.targetInstanceId}:${fixed.review.runId}`;
  return adapters.withExclusiveLock(key, async () => {
    const { review, plan, approval, reviewedEvidence } = fixed;
    const baselineIds = new Set(reviewedEvidence.targetSnapshot.users.map(user => user.id));
    const createdIds = new Set(), completed = [];
    let calls = 0;
    const result = (state, reason = null) => ({ schemaVersion: 1, state, reason,
      planSHA256: plan.planSHA256, payloadSHA256: approval.payloadSHA256, providerCreateCalls: calls,
      confirmedCreated: createdIds.size, completed: copy(completed) });
    const receipt = async event => {
      await adapters.appendReceipt({ schemaVersion: 1, runId: review.runId, targetInstanceId: review.targetInstanceId,
        planSHA256: plan.planSHA256, payloadSHA256: approval.payloadSHA256, at: new Date(now()).toISOString(), ...event });
    };
    function validateEvidence(evidence, expectedIds) {
      const ids = new Set(evidence?.targetSnapshot?.users?.map(user => user.id) ?? []);
      if (!sameSet(ids, expectedIds)) throw new Error('production_inventory_changed');
      const currentReview = { ...review, expectedProductionUsers: expectedIds.size };
      const fresh = buildExistingAccountImportPlan({ ...evidence, review: currentReview }, { nowMs: now() });
      if (!fresh.readyForReview) throw new Error('current_evidence_held');
      return fresh;
    }
    const expectedIds = () => new Set([...baselineIds, ...createdIds]);
    try { await receipt({ kind: 'execution_started', maximumCreates: approval.maxCreates }); }
    catch { return result('held', 'receipt_unavailable'); }
    for (const original of plan.entries.filter(entry => entry.action !== 'excluded')) {
      let evidence, fresh, current;
      try {
        evidence = await adapters.readEvidence();
        fresh = validateEvidence(evidence, expectedIds());
        current = fresh.entries.find(entry => entry.sourceSubject === original.sourceSubject);
        if (!current || current.action !== original.action || (original.action === 'skip_existing' && current.targetSubject !== original.targetSubject)
          || (original.action === 'create_reserved' && digest(current.payload) !== digest(original.payload))) return result('held', 'reviewed_operation_changed');
      } catch { return result('held', 'fresh_preflight_failed'); }
      if (current.action === 'skip_existing') {
        try { await receipt({ kind: 'existing_confirmed', sourceSubject: current.sourceSubject, targetSubject: current.targetSubject }); }
        catch { return result('held', 'receipt_unavailable'); }
        completed.push({ sourceSubject: current.sourceSubject, targetSubject: current.targetSubject, state: 'existing' });
        continue;
      }
      if (calls >= approval.maxCreates) return result('held', 'create_limit_reached');
      try {
        await receipt({ kind: 'create_intent', sourceSubject: current.sourceSubject, requestSHA256: digest(current.payload) });
        // A slow durable write must not extend the validity of provider/DB proof.
        validateEvidence(evidence, expectedIds());
      } catch { return result('held', 'intent_or_freshness_failed'); }
      let response, uncertain = false;
      calls++;
      try { response = await adapters.createReservedUser(copy(current.payload), { targetInstanceId: review.targetInstanceId }); }
      catch { uncertain = true; }
      if (!uncertain && !createdResponseMatches(response, current)) {
        try { await receipt({ kind: 'create_unresolved', sourceSubject: current.sourceSubject, reason: 'unexpected_create_response' }); } catch { /* stop regardless */ }
        return result('unresolved', 'unexpected_create_response');
      }
      // Even a successful response must be checked against fresh complete reads.
      // A timeout is reconciled once. There is no second create or deletion.
      let newTarget;
      try {
        const after = await adapters.readEvidence();
        const matches = after?.targetSnapshot?.users?.filter(user => user.external_id === current.sourceSubject) ?? [];
        if (matches.length !== 1) throw new Error('created_identity_unresolved');
        newTarget = matches[0];
        if (expectedIds().has(newTarget.id) || (!uncertain && response.id !== newTarget.id)
          || !createdResponseMatches(newTarget, current)) throw new Error('created_identity_unresolved');
        const afterPlan = validateEvidence(after, new Set([...expectedIds(), newTarget.id]));
        const matched = afterPlan.entries.find(entry => entry.sourceSubject === current.sourceSubject);
        if (matched?.action !== 'skip_existing' || matched.targetSubject !== newTarget.id || matched.emailVerified !== false) throw new Error('created_identity_unresolved');
      } catch {
        try { await receipt({ kind: 'create_unresolved', sourceSubject: current.sourceSubject, reason: 'readback_unproved' }); } catch { /* stop regardless */ }
        return result('unresolved', 'readback_unproved');
      }
      // Count the known provider identity even if recording the receipt now fails.
      createdIds.add(newTarget.id);
      try {
        await receipt({ kind: uncertain ? 'created_reconciled' : 'created_reserved', sourceSubject: current.sourceSubject,
          targetSubject: newTarget.id, emailVerified: false, requestSHA256: digest(current.payload) });
      } catch { return result('unresolved', 'confirmation_receipt_unavailable'); }
      completed.push({ sourceSubject: current.sourceSubject, targetSubject: newTarget.id, state: uncertain ? 'created_reconciled' : 'created_reserved' });
    }
    try { await receipt({ kind: 'execution_complete', confirmedCreated: createdIds.size, providerCreateCalls: calls }); }
    catch { return result('unresolved', 'completion_receipt_unavailable'); }
    return result('complete');
  });
}
