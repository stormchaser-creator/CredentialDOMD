import { CREDENTIAL_PORTAL_POLICY, digest, token, otp, normalizePortalEmail, safeInlineMime } from './credentialPortalCrypto.mjs';
import {
  ADMIN_ACCESS_POLICY, ownerAllowed, normalizeStandingInput, normalizeScopeInput, ownedDocumentPath, physicianDisplayName,
  standingInvitationEmail, standingCodeEmail, shapeView, shapeGrant, flatDocuments,
} from './credentialPortalView.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
class PortalError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new PortalError(status, code); };
const publicDocument = d => ({ id: d.document_id ?? d.id, name: d.name, mimeType: d.mime_type ?? d.mimeType, sizeBytes: d.size_bytes ?? d.sizeBytes });
const genericCodeResponse = { message: 'If this invitation is available, a code has been sent.' };
const physicianOf = profile => ({ name: profile?.name, degreeType: profile?.degree_type });
const clientAddress = req => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 100);

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
  // Work that must not change how long a response takes (closes the
  // request-code timing signal) or must outlive it (invitation mail). Failures
  // are swallowed: nothing here may surface to a caller.
  const background = task => {
    const work = Promise.resolve().then(task).catch(() => {});
    if (deps.waitUntil) deps.waitUntil(work);
    return work;
  };
  // The first-release gate: CREDENTIAL_PORTAL_OWNER_PROFILES. It also governs
  // live grants, so removing an owner from the list stops their administrators.
  const allowedOwner = profileId => ownerAllowed(deps.ownerProfiles?.(), profileId);
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
    if (active && (profile.access_status !== 'active' || profile.deleted_at)) fail(403, 'active_membership_required');
    return { ...identity, profile };
  }
  // Active, not closed (account_is_closed: tombstone or deleted_at) and allowlisted.
  const ownerReady = async identity => identity.profile.access_status === 'active' && !identity.profile.deleted_at
    && allowedOwner(identity.profileId) && (!deps.store.ownerReady || await deps.store.ownerReady(identity.profileId, identity.subject) === true);
  async function administratorOwner(req) {
    const identity = await owner(req, true);
    if (!await ownerReady(identity)) fail(403, 'administrator_access_unavailable');
    return identity;
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
    const row = await deps.store.ownerGrant(identity.profileId, identity.subject, id);
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
    if (!await deps.store.record(sessionDigest, null, 'documents_listed', null, null, null)) fail(401, 'session_unavailable');
    return { documents, expiresAt: access.expiresAt };
  }
  async function sessionView(sessionDigest, event) {
    const raw = await deps.store.sessionView(sessionDigest, event);
    if (!raw || !allowedOwner(raw.ownerId)) fail(401, 'session_unavailable');
    return { grant: shapeGrant(raw.grant), ...shapeView(raw.view), expiresAt: raw.expiresAt };
  }
  async function invitationPayload(identity, email, accessEndsAt, allowDownload, purpose, inviteToken) {
    const profile = await deps.store.ownerProfile(identity.profileId);
    // Administrators treat an unnamed invitation as phishing; the name is required.
    if (!physicianDisplayName(physicianOf(profile))) fail(409, 'profile_name_required');
    const replyTo = normalizePortalEmail(profile.verified_email) || null;
    const message = standingInvitationEmail({ physician: physicianOf(profile), purpose, accessEndsAt, allowDownload, link: `${origin}/credential-access/#invite=${inviteToken}`, replyTo });
    return { to: email, subject: message.subject, text: message.text, ...(replyTo ? { replyTo } : {}) };
  }
  async function createStanding(req, input) {
    fields(input, ['kind', 'recipientEmail', 'purpose', 'accessDays', 'allowDownload', 'sections', 'customCategories', 'requestId']);
    const identity = await administratorOwner(req);
    const email = normalizePortalEmail(input.recipientEmail);
    const request = normalizeStandingInput(input);
    if (!email || !request) fail(400, 'invalid_invitation');
    const fingerprint = await digest(JSON.stringify({ kind: 'standing', email, purpose: request.purpose, days: request.accessDays, allowDownload: request.allowDownload, scope: request.scope }));
    const previous = await deps.store.ownerRequest(identity.profileId, request.requestId);
    if (previous) {
      if (previous.request_fingerprint !== fingerprint || previous.owner_subject !== identity.subject) fail(409, 'request_conflict');
      background(async () => deliver(await deps.store.inviteMailId(previous.id)));
      return json(200, { invite: await ownerResult(previous.id, identity) });
    }
    if (!await deps.store.creationCapacity(identity.profileId, identity.subject)) fail(429, 'invitation_limit');
    const id = crypto.randomUUID(), mailId = crypto.randomUUID(), inviteToken = token();
    const accessEndsAt = new Date(Date.now() + request.accessDays * 86400000).toISOString();
    const payload = await invitationPayload(identity, email, accessEndsAt, request.allowDownload, request.purpose, inviteToken);
    const encrypted = await deps.crypto.seal(mailId, payload);
    const created = await deps.store.createStanding({
      id, owner: identity.profileId, subject: identity.subject, email, request: request.requestId, fingerprint, tokenDigest: await digest(inviteToken),
      purpose: request.purpose, days: request.accessDays, allowDownload: request.allowDownload, scope: request.scope, mailId, encrypted,
    });
    if (created?.state === 'limited') fail(429, 'invitation_limit');
    if (created?.state === 'conflict') fail(409, 'request_conflict');
    if (!['created', 'existing'].includes(created?.state)) fail(503, 'credential_portal_unavailable');
    // Sent after the response: the owner sees "queued" and the list shows the outcome.
    background(async () => deliver(await deps.store.inviteMailId(created.id)));
    return json(created.state === 'created' ? 201 : 200, { invite: await ownerResult(created.id, identity) });
  }
  async function requestCode(req, input) {
    const email = normalizePortalEmail(input.email);
    if (!email || !TOKEN.test(input.inviteToken || '')) return;
    const tokenDigest = await digest(input.inviteToken);
    // Cheap-load guards for unknown tokens: per client address and per token.
    const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const address = clientAddress(req);
    if (address && deps.store.limit && !await deps.store.limit('code_address', await deps.crypto.recipientLimitKey(`address:${address}`), hour, 60)) return;
    if (deps.store.limit && !await deps.store.limit('code_token', tokenDigest, hour, 20)) return;
    const invite = await deps.store.inviteByToken(tokenDigest, email);
    if (!invite || (invite.owner_profile_id && !allowedOwner(invite.owner_profile_id))) return;
    const code = otp(), version = crypto.randomUUID(), mailId = crypto.randomUUID();
    let message = { subject: 'Your private credential access code', text: `Your CredentialDOMD verification code is ${code}.\n\nIt expires in 10 minutes. Use it only on the private credential invitation page. Never share this code. If you did not request it, ignore this email.` };
    if (invite.kind === 'standing') message = standingCodeEmail({ physician: physicianOf(await deps.store.ownerProfile(invite.owner_profile_id)), code });
    const encrypted = await deps.crypto.seal(mailId, { to: email, subject: message.subject, text: message.text });
    const result = await deps.store.claimOtp({ tokenDigest, email, version, otpDigest: await deps.crypto.otpDigest(invite.id, version, code), mailId, encrypted, recipientLimitKey: await deps.crypto.recipientLimitKey(email) });
    await deliver(result?.mailId);
  }
  async function fileResponse(req, input) {
    fields(input, ['documentId']); if (!UUID.test(input.documentId || '')) fail(400, 'invalid_request');
    const sessionDigest = await digest(bearer(req));
    const access = await deps.store.access(sessionDigest, input.documentId, true);
    if (!access?.document || (access.kind === 'standing' && !allowedOwner(access.ownerId))) fail(401, 'document_unavailable');
    const d = access.document;
    const subjects = Array.isArray(access.storageSubjects) ? access.storageSubjects : [access.ownerSubject];
    if (!ownedDocumentPath(subjects, d.storage_path, input.documentId)) fail(401, 'document_unavailable');
    const standing = access.kind === 'standing';
    if (standing && input.action === 'download' && access.allowDownload !== true) {
      await deps.store.record(sessionDigest, input.documentId, 'download_refused', 'download', null, null);
      fail(403, 'download_disabled');
    }
    let bytes;
    try { bytes = await deps.readFile(d.storage_path, policy.maxFileBytes); } catch { bytes = null; }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > policy.maxFileBytes
      || (!standing && (bytes.byteLength !== d.size_bytes || await digest(bytes) !== d.content_digest))) {
      await deps.store.record(sessionDigest, input.documentId, 'document_unavailable', input.action, null, null);
      if (standing) fail(409, 'document_unreadable');
      fail(409, 'document_changed_request_new_invitation');
    }
    // Recheck after storage I/O so revocation, re-filing or row changes during the read fail closed.
    if (!await deps.store.record(sessionDigest, input.documentId, 'document_response_prepared', input.action, bytes.byteLength, await digest(bytes))) fail(401, 'document_unavailable');
    const mime = input.action === 'view' ? safeInlineMime(bytes, d.mime_type) : null;
    // eslint-disable-next-line no-control-regex
    const filename = String(d.name || 'credential').replace(/[\r\n"\\/\u{0}-\u{1f}\u{7f}-\u{10ffff}]/gu, '_').slice(0, 160) || 'credential';
    return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': mime || 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `${mime ? 'inline' : 'attachment'}; filename="${filename}"` } });
  }
  return async req => {
    if (req.method === 'OPTIONS') return json(200, {});
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }); // GET/link previews never touch storage.
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return json(403, { error: 'origin_not_allowed' });
    try {
      if (!policy.enabled) fail(503, 'credential_portal_disabled');
      deps.assertConfigured?.();
      const input = await body(req);
      if (input.action === 'status') {
        fields(input, []);
        const identity = await owner(req);
        return json(200, { available: await ownerReady(identity), durations: ADMIN_ACCESS_POLICY.durations, defaultDays: ADMIN_ACCESS_POLICY.defaultDays });
      }
      if (input.action === 'create' && input.kind === 'standing') return await createStanding(req, input);
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
        // Legacy Clerk subjects own files too (the bound pre-production subject).
        const subjects = await deps.store.storageSubjects(identity.profileId);
        const snapshots = []; let total = 0;
        for (const id of ids) {
          const d = docs.find(doc => doc.id === id);
          if (!d || d.user_id !== identity.profileId || !ownedDocumentPath(subjects, d.storage_path, id)) fail(409, 'document_not_synced');
          const bytes = await deps.readFile(d.storage_path, policy.maxFileBytes);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > policy.maxFileBytes) fail(413, 'document_too_large');
          total += bytes.byteLength; if (total > policy.maxTotalBytes) fail(413, 'selection_too_large');
          snapshots.push({ id, name: d.name, mimeType: d.mime_type || 'application/octet-stream', sizeBytes: bytes.byteLength, storagePath: d.storage_path, digest: await digest(bytes) });
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
        // Always open to the owner, even outside the allowlist, so a grant can be reviewed and revoked.
        fields(input, []); const identity = await owner(req);
        return json(200, { invites: await deps.store.ownerGrants(identity.profileId, identity.subject) });
      }
      if (input.action === 'revoke') {
        fields(input, ['inviteId']); const identity = await owner(req);
        if (!UUID.test(input.inviteId || '')) fail(400, 'invalid_request');
        if (!await deps.store.revoke(identity.profileId, identity.subject, input.inviteId)) fail(404, 'invitation_unavailable');
        return json(200, { revoked: true });
      }
      if (input.action === 'update') {
        fields(input, ['inviteId', 'accessDays', 'allowDownload', 'sections', 'customCategories']);
        const identity = await administratorOwner(req);
        if (!UUID.test(input.inviteId || '')) fail(400, 'invalid_request');
        const days = input.accessDays ?? null;
        const allowDownload = input.allowDownload ?? null;
        const scopeGiven = input.sections !== undefined || input.customCategories !== undefined;
        const scope = scopeGiven ? normalizeScopeInput(input) : null;
        if ((days !== null && !ADMIN_ACCESS_POLICY.durations.includes(days)) || (allowDownload !== null && typeof allowDownload !== 'boolean')
          || (scopeGiven && !scope) || (days === null && allowDownload === null && !scopeGiven)) fail(400, 'invalid_update');
        const result = await deps.store.update({ owner: identity.profileId, subject: identity.subject, invite: input.inviteId, days, allowDownload, scope });
        if (result?.state === 'widening') fail(409, 'widening_requires_new_grant');
        if (result?.state === 'ended') fail(409, 'grant_ended');
        if (result?.state !== 'updated') fail(404, 'invitation_unavailable');
        return json(200, { invite: await ownerResult(input.inviteId, identity) });
      }
      if (input.action === 'resend-link') {
        fields(input, ['inviteId']);
        const identity = await administratorOwner(req);
        if (!UUID.test(input.inviteId || '')) fail(400, 'invalid_request');
        const grant = await ownerResult(input.inviteId, identity);
        if (grant.kind !== 'standing') fail(404, 'invitation_unavailable');
        if (grant.status === 'revoked' || grant.status === 'expired') fail(409, 'grant_ended');
        const mailId = crypto.randomUUID(), inviteToken = token();
        const payload = await invitationPayload(identity, grant.recipientEmail, grant.expiresAt, grant.allowDownload, grant.purpose, inviteToken);
        const result = await deps.store.resendLink({ owner: identity.profileId, subject: identity.subject, invite: input.inviteId, tokenDigest: await digest(inviteToken), mailId, encrypted: await deps.crypto.seal(mailId, payload) });
        if (result?.state === 'limited') fail(429, 'invitation_limit');
        if (result?.state === 'ended') fail(409, 'grant_ended');
        if (result?.state !== 'created') fail(404, 'invitation_unavailable');
        background(() => deliver(result.mailId));
        return json(200, { invite: await ownerResult(input.inviteId, identity) });
      }
      if (input.action === 'preview') {
        fields(input, ['inviteId', 'sections', 'customCategories']);
        const identity = await administratorOwner(req);
        let raw;
        if (input.inviteId !== undefined) {
          if (!UUID.test(input.inviteId || '') || input.sections !== undefined || input.customCategories !== undefined) fail(400, 'invalid_request');
          raw = await deps.store.preview({ owner: identity.profileId, subject: identity.subject, invite: input.inviteId });
        } else {
          const scope = normalizeScopeInput(input);
          if (!scope) fail(400, 'invalid_request');
          raw = await deps.store.preview({ owner: identity.profileId, subject: identity.subject, scope });
        }
        if (!raw?.view) fail(404, 'invitation_unavailable');
        // Exactly the shaping the administrator's summary uses.
        return json(200, { ...(raw.grant ? { grant: shapeGrant(raw.grant) } : {}), ...shapeView(raw.view) });
      }
      if (input.action === 'request-code') {
        fields(input, ['inviteToken', 'email']);
        // Answer first, identically for every input; the lookup, the code and
        // the mail happen after the response (portal report S2).
        background(() => requestCode(req, input));
        return json(202, genericCodeResponse);
      }
      if (input.action === 'verify') {
        fields(input, ['inviteToken', 'email', 'code']);
        const email = normalizePortalEmail(input.email);
        if (!email || !TOKEN.test(input.inviteToken || '') || !/^\d{6}$/.test(input.code || '')) fail(401, 'verification_failed');
        const tokenDigest = await digest(input.inviteToken);
        const invite = await deps.store.inviteByToken(tokenDigest, email);
        if (!invite?.otp_version || (invite.owner_profile_id && !allowedOwner(invite.owner_profile_id))) fail(401, 'verification_failed');
        const sessionToken = token();
        const verified = await deps.store.redeem(tokenDigest, email, invite.otp_version, await deps.crypto.otpDigest(invite.id, invite.otp_version, input.code), await digest(sessionToken));
        if (!verified) fail(401, 'verification_failed');
        if (verified.kind === 'standing') return json(200, { sessionToken, expiresAt: verified.expiresAt, kind: 'standing', documents: [] });
        return json(200, { sessionToken, expiresAt: verified.expiresAt, documents: (verified.documents || []).map(publicDocument) });
      }
      if (input.action === 'summary') {
        fields(input, []);
        return json(200, await sessionView(await digest(bearer(req)), 'summary_listed'));
      }
      if (input.action === 'documents') {
        fields(input, []); const sessionDigest = await digest(bearer(req));
        const access = await deps.store.access(sessionDigest, null, true);
        if (!access) fail(401, 'session_unavailable');
        if (access.kind === 'standing') {
          const view = await sessionView(sessionDigest, 'documents_listed');
          return json(200, { documents: flatDocuments(view), expiresAt: view.expiresAt });
        }
        return json(200, await listDocuments(sessionDigest, access));
      }
      if (['view', 'download'].includes(input.action)) return await fileResponse(req, input);
      fail(400, 'invalid_action');
    } catch (error) {
      return json(error instanceof PortalError ? error.status : 503, { error: error instanceof PortalError ? error.message : 'credential_portal_unavailable' });
    }
  };
}
