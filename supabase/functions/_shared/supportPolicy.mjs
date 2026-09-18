export const SUPPORT_POLICY_VERSION = 'support-2026-09-v1';
export const HIGH_IMPACT_CAPABILITIES = Object.freeze(['release_code', 'refund_payment', 'change_identity', 'change_access', 'delete_data', 'change_clinical_rule', 'change_policy', 'new_spend']);

// Existing SupportModal maps feedback to other; Vera maps idea to feature_request.
// Accept those exact UI aliases without broadening the persisted category enum.
export function normalizeSupportCategory(value = 'other') {
  const canonical = value === 'feedback' ? 'other' : value === 'idea' ? 'feature_request' : value;
  return ['bug', 'billing', 'feature_request', 'data_issue', 'compliance', 'other'].includes(canonical) ? canonical : null;
}

export function approvedKnowledgeFor(input, entries, now = Date.now()) {
  if (typeof input !== 'string' || input.length > 10000) return null;
  const question = input.trim().toLowerCase();
  return entries.find(entry => entry.approved === true && Date.parse(entry.expires_at) > now
    && /^https:\/\/credentialdomd\.com\//.test(entry.source_url || '')
    && typeof entry.answer === 'string' && entry.answer.length > 0 && entry.answer.length <= 4000
    && Array.isArray(entry.questions) && entry.questions.includes(question)) || null;
}

// The first stage executes no model-proposed action and generates no free-form
// customer answer. Exact approved FAQ matches or an honest escalation only.
export function responseDecision(job, entries, now = Date.now()) {
  if (job.kind === 'receipt') return { kind: 'receipt', knowledgeId: null, knowledgeRevision: null };
  const knowledge = approvedKnowledgeFor(job.input, entries, now);
  return knowledge
    ? { kind: 'public_answer', knowledgeId: knowledge.id, knowledgeRevision: knowledge.revision }
    : { kind: 'escalation', knowledgeId: null, knowledgeRevision: null };
}

export function validateApprovalAction(capability, action) {
  if (!HIGH_IMPACT_CAPABILITIES.includes(capability) || !action || typeof action !== 'object' || Array.isArray(action)) throw Error('invalid_action');
  // Exact fields make the approval reviewable. The foundation records an
  // authorization; it does not implement any financial or deployment executor.
  const fields = {
    release_code: ['artifactSha', 'environment', 'summary'],
    refund_payment: ['paymentId', 'customerId', 'amountMinor', 'currency', 'mode', 'reason'],
    change_identity: ['profileId', 'change', 'reason'],
    change_access: ['profileId', 'change', 'reason'],
    delete_data: ['profileId', 'scope', 'reason'],
    change_clinical_rule: ['artifactSha', 'sourceUrl', 'effectiveDate', 'summary'],
    change_policy: ['artifactSha', 'summary'],
    new_spend: ['vendor', 'amountMinor', 'currency', 'period', 'reason'],
  }[capability];
  if (Object.keys(action).length !== fields.length || fields.some(key => !Object.hasOwn(action, key))) throw Error('invalid_action');
  for (const [key, value] of Object.entries(action)) {
    if (key === 'amountMinor') {
      if (!Number.isSafeInteger(value) || value < 1) throw Error('invalid_action');
    } else if (typeof value !== 'string' || !value.trim() || value.length > 1000
      || [...value].some(char => (char.codePointAt(0) < 32 && !'\t\n\r'.includes(char)) || char.codePointAt(0) === 127)) throw Error('invalid_action');
  }
  if (action.artifactSha && !/^[a-f0-9]{40,64}$/.test(action.artifactSha)) throw Error('invalid_action');
  if (action.currency && !/^[a-z]{3}$/.test(action.currency)) throw Error('invalid_action');
  if (action.mode && !['test', 'live'].includes(action.mode)) throw Error('invalid_action');
  if (action.environment && !['preview', 'production'].includes(action.environment)) throw Error('invalid_action');
  return action;
}

export function resendOutcome(response, payload) {
  if (response?.ok && typeof payload?.id === 'string' && payload.id.length > 0 && payload.id.length <= 200) return { outcome: 'accepted', providerId: payload.id };
  // A malformed success, a timeout or a server error is not evidence that no
  // email was accepted. Reconcile it, using the same stable outbox correlation.
  return { outcome: 'unknown', providerId: null };
}

export function resendReceipt(event, verifiedEventId) {
  const kinds = { 'email.sent': 'accepted', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained' };
  const kind = kinds[event?.type];
  if (!kind) return null;
  const tags = event.data?.tags;
  const outbox = Array.isArray(tags) ? tags.find(t => t.name === 'support_outbox')?.value : tags?.support_outbox;
  const providerId = event.data?.email_id;
  if (!/^[a-f0-9-]{36}$/.test(outbox || '') || typeof providerId !== 'string' || !providerId || providerId.length > 200
    || typeof verifiedEventId !== 'string' || !verifiedEventId || verifiedEventId.length > 200) return null;
  return { eventId: verifiedEventId, outboxId: outbox, providerId, kind };
}
