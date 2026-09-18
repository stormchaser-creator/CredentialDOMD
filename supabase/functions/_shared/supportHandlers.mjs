import { responseDecision, validateApprovalAction, resendReceipt, normalizeSupportCategory } from './supportPolicy.mjs';

class SupportError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new SupportError(status, code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const jsonResponse = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function boundedText(req) {
  if (Number(req.headers.get('content-length')) > 65536) fail(413, 'request_too_large');
  if (!req.body) return '';
  const reader = req.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); fail(413, 'request_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'invalid_request'); }
}
const fields = (input, permitted) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !permitted.includes(key))) fail(400, 'invalid_request');
};

/** Scoped customer intake and internal operations; no generic RPC, recipient or code input. */
export function createSupportHandler(deps) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const json = (status, value) => {
    const response = jsonResponse(status, value);
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return response;
  };
  return async req => {
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return json(403, { error: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') return json(200, {});
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    try {
      const raw = await boundedText(req);
      if (new URL(req.url).pathname.endsWith('/provider-receipt')) {
        let event;
        try { event = await deps.verifyReceipt(raw, req.headers); } catch { fail(400, 'invalid_signature'); }
        const receipt = resendReceipt(event, req.headers.get('svix-id'));
        if (!receipt) return json(200, { state: 'ignored' });
        return json(200, { state: await deps.store.recordReceipt(receipt) });
      }
      let input;
      try { input = JSON.parse(raw); } catch { fail(400, 'invalid_request'); }
      fields(input, ['operation', 'ticketId', 'messageId', 'kind', 'approvalId', 'approve', 'capability', 'action', 'requestId', 'subject', 'body', 'category', 'priority', 'beforeMessageId']);
      const permissions = { list_tickets: 'customer_read', read_ticket: 'customer_read', create_ticket: 'customer', reply_ticket: 'customer', ingest: 'intake', process_one: 'worker', deliver_one: 'delivery', request_approval: 'worker', decide_approval: 'owner' };
      const required = permissions[input.operation];
      if (!required) fail(400, 'invalid_operation');
      const principal = await deps.authorize(req, required);
      if (!principal || principal.role !== required) fail(401, 'unauthorized');
      if (input.operation === 'list_tickets' || input.operation === 'read_ticket') {
        if (!uuid(principal.profileId)) fail(401, 'unauthorized');
        if (input.operation === 'list_tickets') {
          fields(input, ['operation']);
          return json(200, await deps.store.listTickets(principal.profileId));
        }
        fields(input, ['operation', 'ticketId', 'beforeMessageId']);
        if (!uuid(input.ticketId) || (input.beforeMessageId !== undefined && !uuid(input.beforeMessageId))) fail(400, 'invalid_request');
        const result = await deps.store.readTicket(principal.profileId, input.ticketId, input.beforeMessageId || null);
        if (!result) fail(404, 'ticket_unavailable');
        return json(200, result);
      }
      if (input.operation === 'create_ticket' || input.operation === 'reply_ticket') {
        const create = input.operation === 'create_ticket';
        const category = create ? normalizeSupportCategory(input.category) : 'other';
        const priority = create ? input.priority ?? 'normal' : 'normal';
        fields(input, create ? ['operation', 'requestId', 'subject', 'body', 'category', 'priority'] : ['operation', 'requestId', 'ticketId', 'body']);
        if (!uuid(principal.profileId) || !uuid(input.requestId) || typeof input.body !== 'string' || input.body.trim().length < (create ? 10 : 1) || input.body.length > 10000) fail(400, 'invalid_request');
        if (create && (typeof input.subject !== 'string' || input.subject.trim().length < 3 || input.subject.length > 200 || category === null || !['low','normal','high','urgent'].includes(priority))) fail(400, 'invalid_request');
        if (!create && !uuid(input.ticketId)) fail(400, 'invalid_request');
        return json(200, await deps.store.submit(principal.profileId, input.requestId, create ? null : input.ticketId, create ? input.subject : null, input.body, category, priority));
      }
      if (input.operation === 'ingest') {
        fields(input, ['operation', 'ticketId', 'messageId']);
        if (!uuid(input.ticketId) || (input.messageId !== undefined && !uuid(input.messageId))) fail(400, 'invalid_request');
        return json(200, await deps.store.ingest(input.ticketId, input.messageId || null));
      }
      if (input.operation === 'process_one') {
        fields(input, ['operation', 'kind']);
        if (!['receipt', 'answer'].includes(input.kind)) fail(400, 'invalid_request');
        if (!['shadow', 'active'].includes(deps.mode)) return json(200, { state: 'disabled' });
        const job = await deps.store.claimJob(input.kind);
        if (job.state !== 'claimed') return json(200, job);
        // A deployment/config mismatch cannot accidentally publish from shadow.
        if (job.mode !== deps.mode) fail(503, 'support_mode_mismatch');
        const entries = job.kind === 'answer' ? await deps.store.knowledge() : [];
        const decision = responseDecision(job, entries, deps.now?.() ?? Date.now());
        return json(200, await deps.store.completeJob(job.id, job.token, decision.knowledgeId, decision.knowledgeRevision));
      }
      if (input.operation === 'deliver_one') {
        fields(input, ['operation']);
        if (deps.mode !== 'active' || deps.outboundEnabled !== true || deps.canaryVerified !== true) return json(200, { state: 'disabled' });
        const claim = await deps.store.claimOutbox();
        if (claim.state !== 'claimed') return json(200, claim);
        const envelope = await deps.store.beginSend(claim.id, claim.token);
        if (envelope.state !== 'sending') return json(200, envelope);
        let outcome;
        try { outcome = await deps.send(envelope); } catch { outcome = { outcome: 'unknown', providerId: null }; }
        if (!outcome || !['accepted', 'unknown', 'failed'].includes(outcome.outcome)
          || (outcome.outcome === 'accepted' && (typeof outcome.providerId !== 'string' || !outcome.providerId))) outcome = { outcome: 'unknown', providerId: null };
        const state = await deps.store.finishSend(envelope.id, envelope.attempt_id, outcome.outcome, outcome.providerId || null);
        return json(200, { state, outboxId: envelope.id });
      }
      if (input.operation === 'request_approval') {
        fields(input, ['operation', 'ticketId', 'capability', 'action']);
        if (!uuid(input.ticketId)) fail(400, 'invalid_request');
        try { validateApprovalAction(input.capability, input.action); } catch { fail(400, 'invalid_action'); }
        return json(200, { state: 'awaiting_owner', approvalId: await deps.store.requestApproval(input.ticketId, input.capability, input.action) });
      }
      fields(input, ['operation', 'approvalId', 'approve']);
      if (!uuid(input.approvalId) || typeof input.approve !== 'boolean' || !principal.clerkSub?.startsWith('user_')) fail(400, 'invalid_request');
      return json(200, { state: await deps.store.decideApproval(input.approvalId, principal.clerkSub, input.approve) });
    } catch (error) {
      return json(error instanceof SupportError ? error.status : 503, { error: error instanceof SupportError ? error.message : 'support_unavailable' });
    }
  };
}
