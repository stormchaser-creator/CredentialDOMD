// Gift free lifetime access to a mailbox before its owner has an account.
// Authorization is decided in SQL (app_admins); this layer authenticates the
// caller, bounds the input and refuses anything the database did not confirm.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFUSALS = { admin_required: 403, invalid_request: 400, account_exists: 409, already_claimed: 409, not_found: 404, test_mode_unsupported: 409 };

class Refusal extends Error { constructor(status, code) { super(code); this.status = status; } }
const refuse = (status, code) => { throw new Refusal(status, code); };
const plain = value => typeof value === 'string' && ![...value].some(c => { const n = c.charCodeAt(0); return (n < 32 && ![9, 10, 13].includes(n)) || n === 127; });

async function input(req) {
  const text = await req.text();
  if (text.length > 4096) refuse(413, 'invalid_request');
  let body; try { body = JSON.parse(text); } catch { refuse(400, 'invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'invalid_request');
  const allowed = { reserve: ['action', 'email', 'reason'], revoke: ['action', 'id'], list: ['action'] }[body.action];
  if (!allowed || Object.keys(body).some(key => !allowed.includes(key))) refuse(400, 'invalid_request');
  if (body.action === 'reserve') {
    // The owner types this address; normalizing it is a convenience, never an identity proof.
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (email.length < 6 || email.length > 254 || !EMAIL.test(email) || !plain(email)) refuse(400, 'invalid_request');
    if (reason.length < 10 || reason.length > 500 || !plain(reason)) refuse(400, 'invalid_reason');
    return { action: 'reserve', email, reason };
  }
  if (body.action === 'revoke') { if (!UUID.test(body.id || '')) refuse(400, 'invalid_request'); return { action: 'revoke', id: body.id }; }
  return { action: 'list' };
}
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function settle(result) {
  if (!result || typeof result !== 'object' || typeof result.state !== 'string') refuse(503, 'lifetime_gift_unavailable');
  if (Object.hasOwn(REFUSALS, result.state)) refuse(REFUSALS[result.state], result.state);
  return result;
}

export function createLifetimeGiftHandler(deps) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  return async req => {
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    if (!['test', 'live'].includes(deps.mode)) return reply(503, { error: 'lifetime_gift_unavailable' });
    try {
      const body = await input(req), actor = await deps.authenticate(req);
      if (!actor || actor.errorResponse || !UUID.test(actor.profileId || '') || !SUBJECT.test(actor.clerkSubject || '')) refuse(401, 'unauthorized');
      if (actor.isAdmin !== true) refuse(403, 'admin_required');
      const live = deps.mode === 'live';
      // The switch stops NEW gifts only. Seeing and withdrawing existing ones must keep working, or turning
      // gifting off during an incident would also remove the only way to neutralize an open reservation.
      if (body.action === 'reserve' && deps.enabled !== true) refuse(503, 'feature_disabled');
      if (body.action === 'reserve') {
        const result = settle(await deps.store.reserve(actor, body.email, body.reason, live));
        if (!['reserved', 'already_reserved'].includes(result.state) || !UUID.test(result.id || '') || result.email !== body.email || !stamp(result.createdAt)
          || !stamp(result.expiresAt) || Date.parse(result.expiresAt) <= Date.parse(result.createdAt)) refuse(503, 'lifetime_gift_unavailable');
        return reply(200, { schemaVersion: 1, state: result.state, id: result.id, email: result.email, createdAt: result.createdAt, expiresAt: result.expiresAt, emailSent: false, cardRequired: false });
      }
      if (body.action === 'revoke') {
        const result = settle(await deps.store.revoke(actor, body.id));
        if (result.state !== 'revoked' || result.id !== body.id || !stamp(result.revokedAt)) refuse(503, 'lifetime_gift_unavailable');
        return reply(200, { schemaVersion: 1, state: 'revoked', id: result.id, revokedAt: result.revokedAt });
      }
      const result = settle(await deps.store.list(actor, live));
      if (result.state !== 'ready' || !Array.isArray(result.reservations)) refuse(503, 'lifetime_gift_unavailable');
      const reservations = result.reservations.map(r => {
        if (!UUID.test(r?.id || '') || !EMAIL.test(r.email || '') || !plain(r.reason) || !stamp(r.createdAt) || !stamp(r.expiresAt)
          || (r.claimedAt !== null && !stamp(r.claimedAt)) || (r.revokedAt !== null && !stamp(r.revokedAt))
          || typeof r.signedUp !== 'boolean' || !(r.claimedName == null || (plain(r.claimedName) && r.claimedName.length <= 300))) refuse(503, 'lifetime_gift_unavailable');
        return { id: r.id, email: r.email, reason: r.reason, createdAt: r.createdAt, expiresAt: r.expiresAt, claimedAt: r.claimedAt, revokedAt: r.revokedAt,
          signedUp: r.signedUp, claimedName: r.claimedName || '' };
      });
      return reply(200, { schemaVersion: 1, reservations });
    } catch (error) {
      return reply(error instanceof Refusal ? error.status : 503, { error: error instanceof Refusal ? error.message : 'lifetime_gift_unavailable' });
    }
  };
}
