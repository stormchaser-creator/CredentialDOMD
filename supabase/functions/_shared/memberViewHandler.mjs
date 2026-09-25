// admin-member-view: the server half of the member-granted support view
// (ticket d45e857c, phase 2). Pure request handling with every I/O passed in,
// so plain node tests drive it end to end (tests/member-view/).
//
//   POST { action: "start", profileId, reason, requestId }
//     Checks that the caller is an administrator, that the member has an
//     active grant and that the reason is 10 to 500 characters, opens a
//     session of at most 15 minutes that never outlives the grant, logs the
//     view for the member, and returns an ALLOWLISTED snapshot
//     (memberView.mjs). No file bytes are in it.
//   POST { action: "check", sessionId }
//     Is the session still open? Refused once it has expired, been ended, or
//     the member's grant ended or expired.
//   POST { action: "file", sessionId, documentId }
//     One file, opened one at a time: re-checks the session and the grant,
//     that the file is filed to a record the snapshot shows and that its
//     bytes are the type it claims, then logs the open for the member and
//     returns the bytes for inline viewing. Refused types are never read.
//   POST { action: "end", sessionId }
//     Ends the session.
//
// Authorization: the Clerk JWT is verified by the dependencies
// (_shared/clerkAuth.ts, deployed with --no-verify-jwt), and the database
// functions check administrator membership again from the verified profile
// and subject on every call. Nothing here trusts a client flag.
import { MEMBER_VIEW_POLICY, MEMBER_VIEW_SECTIONS, PROFILE_COLUMNS, DOCUMENT_COLUMNS, sectionColumns, shapeSnapshot, normalizeReason, documentShownFor, memberViewSection } from './memberView.mjs';
import { safeInlineMime } from './credentialPortalCrypto.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
// The types the viewer can show inline. safeInlineMime then checks the bytes.
export const MEMBER_VIEW_INLINE_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
const ACTIONS = { start: ['profileId', 'reason', 'requestId'], check: ['sessionId'], file: ['sessionId', 'documentId'], end: ['sessionId'] };

class ViewError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new ViewError(status, code); };

// Database states that refuse, and how each is answered.
const REFUSALS = {
  admin_required: [403, 'admin_required'],
  invalid_request: [400, 'invalid_request'],
  request_conflict: [409, 'request_conflict'],
  member_unavailable: [404, 'member_unavailable'],
  no_grant: [403, 'no_active_grant'],
  not_found: [404, 'session_not_found'],
  ended: [409, 'session_ended'],
  expired: [409, 'session_expired'],
  grant_ended: [409, 'grant_ended'],
  grant_expired: [409, 'grant_expired'],
  document_unavailable: [404, 'document_unavailable'],
};
function requireActive(result) {
  const state = result?.state;
  if (state === 'active') return result;
  const [status, code] = REFUSALS[state] || [503, 'support_view_unavailable'];
  fail(status, code);
}
const secondsUntil = (value, now) => { const at = Date.parse(value); return Number.isFinite(at) ? Math.max(0, Math.floor((at - now) / 1000)) : 0; };

export function createMemberViewHandler(deps, policy = MEMBER_VIEW_POLICY) {
  const origin = policy.origin;
  const now = deps.now || (() => Date.now());
  const headers = {
    'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

  async function body(req) {
    const text = await req.text();
    if (text.length > 8192) fail(413, 'request_too_large');
    let input;
    try { input = JSON.parse(text); } catch { fail(400, 'invalid_request'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(ACTIONS, input.action)) fail(400, 'invalid_request');
    const allowed = new Set(['action', ...ACTIONS[input.action]]);
    if (Object.keys(input).some(key => !allowed.has(key))) fail(400, 'invalid_request');
    return input;
  }

  async function administrator(req) {
    let identity = null;
    try { identity = await deps.authenticate(req); } catch { identity = null; }
    if (!identity || !UUID.test(identity.profileId || '') || !SUBJECT.test(identity.clerkSubject || '')) fail(401, 'unauthorized');
    // The database checks membership again; this only saves it the trip.
    if (identity.isAdmin !== true) fail(403, 'admin_required');
    return identity;
  }

  const actorArgs = identity => ({ actor: identity.profileId, subject: identity.clerkSubject });

  async function readSnapshot(member) {
    const truncated = [];
    const read = async section => {
      const { rows, truncated: cut } = await deps.store.rows(section.table, sectionColumns(section), member, policy.maxRowsPerCollection);
      if (cut) truncated.push(section.key);
      return [section.key, rows];
    };
    const [profile, entries, documents] = await Promise.all([
      deps.store.profile(member, PROFILE_COLUMNS),
      Promise.all(MEMBER_VIEW_SECTIONS.map(read)),
      deps.store.rows('documents', DOCUMENT_COLUMNS, member, policy.maxRowsPerCollection).then(result => result.rows),
    ]);
    return shapeSnapshot({ profile, collections: Object.fromEntries(entries), documents, truncated });
  }

  const sessionOut = (state, at) => ({
    id: state.session.id,
    startedAt: state.session.started_at,
    expiresAt: state.session.expires_at,
    grantExpiresAt: state.grant.expires_at,
    expiresInSeconds: secondsUntil(state.session.expires_at, at),
  });

  async function start(identity, input) {
    if (!UUID.test(input.profileId || '') || !UUID.test(input.requestId || '')) fail(400, 'invalid_request');
    const reason = normalizeReason(input.reason);
    if (!reason) fail(400, 'invalid_reason');
    if (input.profileId.toLowerCase() === identity.profileId.toLowerCase()) fail(400, 'cannot_view_own_account');
    const opened = requireActive(await deps.store.start({ ...actorArgs(identity), member: input.profileId, reason, requestId: input.requestId }));
    let snapshot;
    try { snapshot = await readSnapshot(opened.session.profile_id); }
    catch {
      await deps.store.end({ ...actorArgs(identity), session: opened.session.id }).catch(() => {});
      fail(503, 'snapshot_unavailable');
    }
    // The grant can end while the records are read. Nothing leaves then.
    const still = requireActive(await deps.store.check({ ...actorArgs(identity), session: opened.session.id }));
    return json(200, {
      session: sessionOut(still, now()),
      member: { profileId: opened.session.profile_id, name: snapshot.member.name || '', degreeType: snapshot.member.degreeType || '' },
      snapshot,
    });
  }

  async function check(identity, input) {
    if (!UUID.test(input.sessionId || '')) fail(400, 'invalid_request');
    const state = requireActive(await deps.store.check({ ...actorArgs(identity), session: input.sessionId }));
    return json(200, { state: 'active', session: sessionOut(state, now()) });
  }

  async function file(identity, input) {
    if (!UUID.test(input.sessionId || '') || !UUID.test(input.documentId || '')) fail(400, 'invalid_request');
    const state = requireActive(await deps.store.check({ ...actorArgs(identity), session: input.sessionId }));
    const member = state.session.profile_id;
    const document = await deps.store.document(member, input.documentId);
    if (!document || document.id !== input.documentId) fail(404, 'document_unavailable');
    // Only a file filed to a record the snapshot shows, and that record must
    // still exist in the member's account.
    const link = documentShownFor(document.linked_to);
    const section = link && memberViewSection(link.section);
    if (!section || !await deps.store.recordExists(section.table, member, link.recordId)) fail(403, 'document_not_shown');
    const declared = String(document.mime_type || document.type || '').toLowerCase();
    if (!MEMBER_VIEW_INLINE_TYPES.includes(declared)) fail(415, 'not_viewable');
    const subjects = await deps.store.storageSubjects(member);
    const path = String(document.storage_path || '');
    const owned = /^(user_[A-Za-z0-9]+)\/([0-9a-f-]{36})$/.exec(path);
    if (!owned || owned[2] !== input.documentId || !Array.isArray(subjects) || !subjects.includes(owned[1])) fail(404, 'document_unavailable');
    let bytes;
    try { bytes = await deps.readFile(path, policy.maxFileBytes); } catch { bytes = null; }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > policy.maxFileBytes) fail(502, 'file_unreadable');
    const mime = safeInlineMime(bytes, declared);
    if (!mime) fail(415, 'not_viewable');
    // Logged for the member, and the session and grant checked again, after
    // the read: an access that ended during it sends nothing.
    requireActive(await deps.store.recordFile({ ...actorArgs(identity), session: input.sessionId, document: input.documentId, name: String(document.name || '') }));
    return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': mime, 'Content-Length': String(bytes.byteLength), 'Content-Disposition': 'inline' } });
  }

  async function end(identity, input) {
    if (!UUID.test(input.sessionId || '')) fail(400, 'invalid_request');
    await deps.store.end({ ...actorArgs(identity), session: input.sessionId });
    return json(200, { state: 'ended' });
  }

  const routes = { start, check, file, end };
  return async req => {
    if (req.method === 'OPTIONS') return json(200, {});
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return json(403, { error: 'origin_not_allowed' });
    try {
      if (!deps.enabled?.()) fail(503, 'support_view_disabled');
      const input = await body(req);
      const identity = await administrator(req);
      return await routes[input.action](identity, input);
    } catch (error) {
      if (error instanceof ViewError) return json(error.status, { error: error.message });
      return json(503, { error: 'support_view_unavailable' });
    }
  };
}
