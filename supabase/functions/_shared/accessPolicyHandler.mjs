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
          purchasedOfferId: null, lifetime: { credential: false, practice: false }, practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
          capabilities: { credential: { read: access, write: access, export: access }, practice: { read: access, write: access, export: access } }, billingEnabled: false });
      }
      const snapshot = await deps.readOwnSnapshot(req);
      if (snapshot?.schemaVersion !== 1 || snapshot.policyVersion !== policy.version || snapshot.enforcementEnabled !== true || snapshot.billingEnabled !== false) throw Error('Policy cutover incomplete');
      return response(200, snapshot);
    } catch { return response(503, { error: 'access_policy_unavailable' }); }
  };
}
