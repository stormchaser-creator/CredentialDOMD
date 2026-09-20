import { PUBLIC_BILLING_POLICY } from './accessPolicy.mjs';

/** Optional adapter for rollout. Disabled source never queries unapplied tables. */
export function createAccessPolicyHandler(deps, policy = PUBLIC_BILLING_POLICY) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const response = (status, data) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  return async req => {
    if (req.method === 'OPTIONS') return response(200, {});
    if (req.method !== 'POST') return response(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return response(403, { error: 'origin_not_allowed' });
    try {
      const profile = await deps.authenticate(req);
      if (!profile?.id || !/^user_[A-Za-z0-9]+$/.test(profile.auth_user_id || '')) return response(401, { error: 'unauthorized' });
      if (!policy.enforcementEnabled) {
        const access = profile.access_status === 'active';
        return response(200, { schemaVersion: 1, policyVersion: policy.version, evaluatedAt: new Date(deps.now?.() ?? Date.now()).toISOString(), enforcementEnabled: false, accessStatus: profile.access_status,
          purchasedOfferId: null, lifetime: { credential: false, practice: false }, freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false }, practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
          checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
          capabilities: { credential: { read: access, write: access, export: access }, practice: { read: access, write: access, export: access } }, billingEnabled: false });
      }
      const snapshot = await deps.readOwnSnapshot(req);
      if (snapshot?.schemaVersion !== 1 || snapshot.policyVersion !== policy.version || snapshot.enforcementEnabled !== true || typeof snapshot.billingEnabled !== 'boolean') throw Error('Policy cutover incomplete');
      if (snapshot.checkoutEligible != null && (typeof snapshot.checkoutEligible !== 'boolean' || (snapshot.checkoutEligible && (!snapshot.billingEnabled || !['founding','earlybird','standard'].includes(snapshot.pricePhase))))) throw Error('Checkout eligibility unavailable');
      if (snapshot.checkoutResumeAvailable != null && (typeof snapshot.checkoutResumeAvailable !== 'boolean' || (snapshot.checkoutResumeAvailable ? !snapshot.billingEnabled || !['core','core_locum'].includes(snapshot.checkoutResumeOfferId) : snapshot.checkoutResumeOfferId != null))) throw Error('Checkout resume unavailable');
      if (snapshot.freeBeta != null) {
        const beta = snapshot.freeBeta;
        if (!['none','active','expired'].includes(beta.state) || beta.autoCharges !== false || (beta.state === 'none' ? beta.startsAt !== null || beta.endsAt !== null : !Number.isFinite(Date.parse(beta.startsAt)) || Date.parse(beta.endsAt) - Date.parse(beta.startsAt) !== 30 * 86400000)) throw Error('Free beta grant unavailable');
      }
      return response(200, snapshot);
    } catch { return response(503, { error: 'access_policy_unavailable' }); }
  };
}
