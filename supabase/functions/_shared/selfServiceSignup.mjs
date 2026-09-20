import { PUBLIC_BILLING_POLICY } from './accessPolicy.mjs';

export const SELF_SERVICE_SIGNUP = Object.freeze({ enabled: false, policyVersion: PUBLIC_BILLING_POLICY.version });

// Only a fresh Clerk backend response is evidence. No editable profile email,
// secondary mailbox, JWT email label or browser-selected address can enroll.
export function verifiedPrimaryMailbox(user, subject) {
  if (!user || user.id !== subject || user.banned || user.locked || !Array.isArray(user.email_addresses)) return null;
  const matches = user.email_addresses.filter(address => address?.id === user.primary_email_address_id);
  if (matches.length !== 1 || matches[0].verification?.status !== 'verified') return null;
  const email = matches[0].email_address;
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function validEnrollment(enrollment) {
  if (enrollment?.state !== 'enrolled' || !['lifetime', 'grandfathered_beta', 'paid'].includes(enrollment.kind)
    || !['active', 'pending'].includes(enrollment.access_status)) return false;
  const beta = enrollment.free_beta;
  if (!beta || beta.autoCharges !== false) return false;
  if (enrollment.kind === 'lifetime') return enrollment.price_phase === null && beta.state === 'none' && beta.startsAt === null && beta.endsAt === null;
  if (!['founding', 'earlybird', 'standard'].includes(enrollment.price_phase)) return false;
  if (enrollment.kind === 'paid') return beta.state === 'none' && beta.startsAt === null && beta.endsAt === null;
  return ['active', 'expired'].includes(beta.state) && typeof beta.startsAt === 'string' && typeof beta.endsAt === 'string'
    && Number.isFinite(Date.parse(beta.startsAt)) && Date.parse(beta.endsAt) - Date.parse(beta.startsAt) === 30 * 24 * 60 * 60 * 1000;
}

export function createSelfServiceSignupHandler(deps, policy = SELF_SERVICE_SIGNUP) {
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
    if (policy.enabled !== true || !['test', 'live'].includes(deps.mode)) return reply(503, { error: 'signup_disabled' });
    try {
      if (Number(req.headers.get('content-length')) > 1024) return reply(413, { error: 'request_too_large' });
      let raw = '', size = 0;
      if (req.body) {
        const reader = req.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 1024) { await reader.cancel(); return reply(413, { error: 'request_too_large' }); }
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
      }
      let input;
      try { input = JSON.parse(raw || '{}'); } catch { return reply(400, { error: 'invalid_request' }); }
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return reply(400, { error: 'invalid_request' });
      const identity = await deps.authenticate(req);
      if (!identity?.profileId || !/^user_[A-Za-z0-9]+$/.test(identity.clerkSubject || '')) return reply(401, { error: 'unauthorized' });
      // Identity continuity is resolved before this route. It never inserts a
      // profile, rebinds a subject, or guesses ownership from matching email.
      const profile = await deps.profile(identity.profileId);
      if (!profile || profile.id !== identity.profileId || profile.auth_user_id !== identity.clerkSubject
        || !['active', 'pending'].includes(profile.access_status) || profile.deleted_at) return reply(403, { error: 'membership_unavailable' });
      const mailbox = verifiedPrimaryMailbox(await deps.clerkUser(identity.clerkSubject), identity.clerkSubject);
      if (!mailbox) return reply(409, { error: 'verified_primary_email_required' });
      const enrollment = await deps.enroll(profile.id, identity.clerkSubject, deps.mode === 'live', mailbox);
      if (enrollment?.state === 'disabled') return reply(503, { error: 'signup_disabled' });
      if (enrollment?.state === 'membership_unavailable') return reply(403, { error: 'membership_unavailable' });
      if (!validEnrollment(enrollment)) return reply(409, { error: 'signup_unavailable' });
      return reply(200, { schemaVersion: 1, policyVersion: policy.policyVersion, enrollmentKind: enrollment.kind,
        accessStatus: enrollment.access_status, freeBeta: enrollment.free_beta,
        pricePhase: enrollment.price_phase, cardRequired: enrollment.kind === 'paid', subscriptionCreated: false });
    } catch { return reply(503, { error: 'signup_unavailable' }); }
  };
}
