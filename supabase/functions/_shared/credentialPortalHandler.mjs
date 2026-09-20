import { CREDENTIAL_PORTAL_POLICY, digest, token, otp, normalizePortalEmail, safeInlineMime } from './credentialPortalCrypto.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
class PortalError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new PortalError(status, code); };
const publicDocument = d => ({ id: d.document_id ?? d.id, name: d.name, mimeType: d.mime_type ?? d.mimeType, sizeBytes: d.size_bytes ?? d.sizeBytes });
const genericCodeResponse = { message: 'If this invitation is available, a code has been sent.' };

export function createCredentialPortalHandler(deps, policy = CREDENTIAL_PORTAL_POLICY) {
  const origin = policy.origin;
  const headers = {
    'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
  };
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  async function body(req) {
    if (Number(req.headers.get('content-length')) > 8192) fail(413, 'request_too_large');
    const reader = req.body?.getReader(); const chunks = []; let length = 0;
    if (reader) try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 8192) { await reader.cancel(); fail(413, 'request_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let input; try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'invalid_request'); }
    if (!input || Array.isArray(input) || typeof input !== 'object') fail(400, 'invalid_request');
    return input;
  }
  function fields(input, allowed) { if (Object.keys(input).some(k => !['action', ...allowed].includes(k))) fail(400, 'invalid_request'); }
  async function owner(req, active = false) {
    const identity = await deps.authenticateOwner(req);
    if (!identity?.profileId || !/^user_[A-Za-z0-9]+$/.test(identity.subject || '')) fail(401, 'unauthorized');
    const profile = await deps.store.profile(identity.profileId);
    if (!profile || profile.auth_user_id !== identity.subject) fail(401, 'unauthorized');
    if (active && profile.access_status !== 'active') fail(403, 'active_membership_required');
    return { ...identity, profile };
  }
  function bearer(req) {
    const matched = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization') || '');
    if (!matched) fail(401, 'session_unavailable'); return matched[1];
  }
  async function deliver(mailId) {
    if (!mailId) return;
    const lease = crypto.randomUUID();
    const mail = await deps.store.claimMail(mailId, lease);
    if (!mail) return;
    let outcome;
    try {
      const payload = await deps.crypto.open(mail.id, mail.encryptedPayload);
      outcome = await deps.sendMail(payload, `credential-portal:${mail.id}`);
    } catch { outcome = { state: 'unknown' }; }
    if (!['sent', 'failed', 'unknown'].includes(outcome?.state)) outcome = { state: 'unknown' };
    if (outcome.state === 'sent' && (typeof outcome.providerId !== 'string' || !outcome.providerId.trim() || outcome.providerId.length > 200)) outcome = { state: 'unknown' };
    await deps.store.finishMail(mailId, lease, outcome.state, outcome.providerId || null);
  }
  async function ownerResult(id, identity) {
    const row = await deps.store.ownerInvite(identity.profileId, identity.subject, id);
    if (!row) fail(404, 'invitation_unavailable');
    return row;
  }
  async function listDocuments(sessionDigest, initialAccess) {
    const access = initialAccess || await deps.store.access(sessionDigest, null, true);
    if (!access) fail(401, 'session_unavailable');
    const documents = [];
    for (const d of await deps.store.manifest(access.inviteId)) {
      if (await deps.store.access(sessionDigest, d.document_id, false)) documents.push(publicDocument(d));
    }
    if (!await deps.store.record(sessionDigest, null, 'documents_listed', null, null)) fail(401, 'session_unavailable');
    return { documents, expiresAt: access.expiresAt };
  }
  return async req => {
    if (req.method === 'OPTIONS') return json(200, {});
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }); // GET/link previews never touch storage.
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return json(403, { error: 'origin_not_allowed' });
    try {
      if (!policy.enabled) fail(503, 'credential_portal_disabled');
      deps.assertConfigured?.();
      const input = await body(req);
      if (input.action === 'create') {
        fields(input, ['recipientEmail', 'documentIds', 'requestId']);
        const identity = await owner(req, true);
        const email = normalizePortalEmail(input.recipientEmail);
        if (!email || !UUID.test(input.requestId || '') || !Array.isArray(input.documentIds) || input.documentIds.length < 1 || input.documentIds.length > policy.maxDocuments
          || input.documentIds.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(input.documentIds).size !== input.documentIds.length) fail(400, 'invalid_invitation');
        const ids = [...input.documentIds].sort();
        const fingerprint = await digest(JSON.stringify({ email, ids }));
        const previous = await deps.store.ownerRequest(identity.profileId, input.requestId);
        if (previous) {
          if (previous.request_fingerprint !== fingerprint || previous.owner_subject !== identity.subject) fail(409, 'request_conflict');
          await deliver(await deps.store.inviteMailId(previous.id));
          return json(200, { invite: await ownerResult(previous.id, identity) });
        }
        if (!await deps.store.creationCapacity(identity.profileId, identity.subject)) fail(429, 'invitation_limit');
        const docs = await deps.store.ownerDocuments(identity.profileId, ids);
        if (docs.length !== ids.length) fail(409, 'document_unavailable');
        const snapshots = []; let total = 0;
        for (const id of ids) {
          const d = docs.find(doc => doc.id === id);
          const path = `${identity.subject}/${id}`;
          if (!d || d.user_id !== identity.profileId || d.storage_path !== path) fail(409, 'document_not_synced');
          const bytes = await deps.readFile(path, policy.maxFileBytes);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > policy.maxFileBytes) fail(413, 'document_too_large');
          total += bytes.byteLength; if (total > policy.maxTotalBytes) fail(413, 'selection_too_large');
          snapshots.push({ id, name: d.name, mimeType: d.mime_type || 'application/octet-stream', sizeBytes: bytes.byteLength, storagePath: path, digest: await digest(bytes) });
        }
        const id = crypto.randomUUID(), mailId = crypto.randomUUID(), inviteToken = token();
        const encrypted = await deps.crypto.seal(mailId, { to: email, subject: 'Private credential document invitation', text: `A physician has invited you to access selected credential documents privately.\n\nOpen ${origin}/credential-access/#invite=${inviteToken}\n\nThe link expires in 7 days and can be verified once. You must receive a fresh code at this exact email address. Do not forward the link. No documents are attached.\n\nIf you did not expect this invitation, ignore it.` });
        const created = await deps.store.createInvite({ id, owner: identity.profileId, subject: identity.subject, email, request: input.requestId, fingerprint, tokenDigest: await digest(inviteToken), documents: snapshots, mailId, encrypted });
        if (created.state === 'limited') fail(429, 'invitation_limit');
        if (created.state === 'conflict') fail(409, 'request_conflict');
        if (!['created', 'existing'].includes(created.state)) fail(503, 'credential_portal_unavailable');
        await deliver(await deps.store.inviteMailId(created.id));
        return json(created.state === 'created' ? 201 : 200, { invite: await ownerResult(created.id, identity) });
      }
      if (input.action === 'list') {
        fields(input, []); const identity = await owner(req);
        return json(200, { invites: await deps.store.ownerInvites(identity.profileId, identity.subject) });
      }
      if (input.action === 'revoke') {
        fields(input, ['inviteId']); const identity = await owner(req);
        if (!UUID.test(input.inviteId || '')) fail(400, 'invalid_request');
        if (!await deps.store.revoke(identity.profileId, identity.subject, input.inviteId)) fail(404, 'invitation_unavailable');
        return json(200, { revoked: true });
      }
      if (input.action === 'request-code') {
        fields(input, ['inviteToken', 'email']);
        const email = normalizePortalEmail(input.email);
        if (!email || !TOKEN.test(input.inviteToken || '')) return json(202, genericCodeResponse);
        const tokenDigest = await digest(input.inviteToken);
        const invite = await deps.store.inviteByToken(tokenDigest, email);
        if (!invite) return json(202, genericCodeResponse);
        const code = otp(), version = crypto.randomUUID(), mailId = crypto.randomUUID();
        const encrypted = await deps.crypto.seal(mailId, { to: email, subject: 'Your private credential access code', text: `Your CredentialDOMD verification code is ${code}.\n\nIt expires in 10 minutes. Use it only on the private credential invitation page. Never share this code. If you did not request it, ignore this email.` });
        const result = await deps.store.claimOtp({ tokenDigest, email, version, otpDigest: await deps.crypto.otpDigest(invite.id, version, code), mailId, encrypted, recipientLimitKey: await deps.crypto.recipientLimitKey(email) });
        await deliver(result.mailId);
        return json(202, genericCodeResponse);
      }
      if (input.action === 'verify') {
        fields(input, ['inviteToken', 'email', 'code']);
        const email = normalizePortalEmail(input.email);
        if (!email || !TOKEN.test(input.inviteToken || '') || !/^\d{6}$/.test(input.code || '')) fail(401, 'verification_failed');
        const tokenDigest = await digest(input.inviteToken);
        const invite = await deps.store.inviteByToken(tokenDigest, email);
        if (!invite?.otp_version) fail(401, 'verification_failed');
        const sessionToken = token();
        const verified = await deps.store.redeem(tokenDigest, email, invite.otp_version, await deps.crypto.otpDigest(invite.id, invite.otp_version, input.code), await digest(sessionToken));
        if (!verified) fail(401, 'verification_failed');
        return json(200, { sessionToken, expiresAt: verified.expiresAt, documents: (verified.documents || []).map(publicDocument) });
      }
      if (input.action === 'documents') {
        fields(input, []); const sessionDigest = await digest(bearer(req));
        return json(200, await listDocuments(sessionDigest));
      }
      if (['view', 'download'].includes(input.action)) {
        fields(input, ['documentId']); if (!UUID.test(input.documentId || '')) fail(400, 'invalid_request');
        const sessionDigest = await digest(bearer(req));
        const access = await deps.store.access(sessionDigest, input.documentId, true);
        if (!access?.document) fail(401, 'document_unavailable');
        const d = access.document;
        if (d.storage_path !== `${access.ownerSubject}/${input.documentId}`) fail(401, 'document_unavailable');
        const bytes = await deps.readFile(d.storage_path, policy.maxFileBytes);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== d.size_bytes || await digest(bytes) !== d.content_digest) {
          await deps.store.record(sessionDigest, input.documentId, 'document_unavailable', input.action, null);
          fail(409, 'document_changed_request_new_invitation');
        }
        // Recheck after storage I/O so revocation or row changes during download fail closed.
        if (!await deps.store.record(sessionDigest, input.documentId, 'document_response_prepared', input.action, bytes.byteLength)) fail(401, 'document_unavailable');
        const mime = input.action === 'view' ? safeInlineMime(bytes, d.mime_type) : null;
        const filename = String(d.name || 'credential').replace(/[\r\n"\\/\u0000-\u001f\u007f-\uffff]/g, '_').slice(0, 160) || 'credential';
        return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': mime || 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `${mime ? 'inline' : 'attachment'}; filename="${filename}"` } });
      }
      fail(400, 'invalid_action');
    } catch (error) {
      return json(error instanceof PortalError ? error.status : 503, { error: error instanceof PortalError ? error.message : 'credential_portal_unavailable' });
    }
  };
}
