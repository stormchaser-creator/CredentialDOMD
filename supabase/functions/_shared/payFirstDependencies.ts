// The provider and database adapters for payFirstSignup.mjs. Reads only the
// configuration the other billing and identity functions already use; adds no
// secret. Nothing here runs unless a pay-first route is called.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decodeJwt } from 'https://esm.sh/jose@5';
import { clerkProfile } from './clerkAuth.ts';
import { CLERK_API_BASE, PRODUCTION_CLERK_ISSUER, readProductionIdentity, initializeProductionProfile } from './clerkContinuity.ts';

type Base = { mode: string; stripe: () => unknown; welcome?: unknown };
type Settle = (stripe: unknown, live: boolean, sub: unknown, event: { id: string; created: number }) => Promise<unknown>;

export function payFirstDependencies(base: Base, settle: Settle) {
  let database: ReturnType<typeof createClient>;
  const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw Error('Pay-first database operation failed');
    return data;
  };
  const row = (column: string, value: string) => checked(db().from('pay_first_signups')
    .select('signup_id,livemode,state,session_id,subscription_id,clerk_subject,nonce_digest,price_id,token_issued_at')
    .eq(column, value).maybeSingle());

  // Clerk Backend API: the same key, key-prefix check and base URL as
  // bootstrap-launch-access (clerkContinuity.ts CLERK_API_BASE).
  const clerkMode = Deno.env.get('CLERK_IDENTITY_MODE') || base.mode;
  const clerkKey = () => {
    const key = Deno.env.get('CLERK_SECRET_KEY') || '';
    if (!['test', 'live'].includes(clerkMode) || !key.startsWith(`sk_${clerkMode}_`)) throw Error('Clerk backend mode mismatch');
    return key;
  };
  const clerk = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${CLERK_API_BASE}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${clerkKey()}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const text = await response.text();
    if (!response.ok || text.length > 524288) throw Object.assign(Error('Clerk request failed'), { code: `clerk_${response.status}` });
    return JSON.parse(text);
  };
  type ClerkUser = { id: string; external_id?: string | null; email_addresses?: { email_address?: string }[] };
  const listed = (value: unknown): ClerkUser[] => Array.isArray(value) ? value : Array.isArray((value as { data?: unknown })?.data) ? (value as { data: ClerkUser[] }).data : [];

  return {
    mode: base.mode,
    stripe: base.stripe,
    welcome: base.welcome,
    settle,
    hookSecret: () => Deno.env.get('WELCOME_HOOK_SECRET') || '',
    // A peppered hash of the caller's address for the per-address limit, the
    // way report-error makes one. Only a limit: the global caps in
    // hold_pay_first_founding hold even when the address is hidden or forged.
    ipHash: async (req: Request) => {
      const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
      if (!ip) return null;
      const pepper = Deno.env.get('ERROR_IP_PEPPER') || 'credentialdomd-client-errors';
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pay-first|${pepper}|${ip}`));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    },
    // A Clerk session token: who, whether an admin, and which session.
    authenticate: async (req: Request) => {
      const who = await clerkProfile(req);
      if (!who) return null;
      let sessionId = '';
      try { sessionId = String(decodeJwt((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')).sid || ''); } catch { /* None. */ }
      return { profileId: who.profileId, clerkSubject: who.clerkSubject, isAdmin: who.isAdmin, sessionId };
    },
    clerk: {
      // Clerk matches email_address case-insensitively; only an exact address on the user counts.
      findByEmail: async (email: string) => listed(await clerk(`/v1/users?email_address=${encodeURIComponent(email)}&limit=10`))
        .filter(u => (u.email_addresses || []).some(a => typeof a.email_address === 'string' && a.email_address.trim().toLowerCase() === email)),
      // Backend-created addresses are verified by default (Clerk createUser);
      // identity() below reads the user back and requires that.
      createUser: ({ email, externalId }: { email: string; externalId: string }) => clerk('/v1/users', { method: 'POST',
        body: JSON.stringify({ email_address: [email], skip_password_requirement: true, external_id: externalId }) }),
      identity: (subject: string) => readProductionIdentity(subject, clerkKey(), fetch, clerkMode === 'test'),
      signInToken: async (subject: string, seconds: number) => (await clerk('/v1/sign_in_tokens', { method: 'POST',
        body: JSON.stringify({ user_id: subject, expires_in_seconds: seconds }) }))?.token,
      sessions: async (subject: string) => listed(await clerk(`/v1/sessions?user_id=${encodeURIComponent(subject)}&limit=100`)),
    },
    // Exactly as clerk-webhook makes a profile for a new Clerk user.
    initProfile: async (identity: { subject: string; email: string; updatedMs: number; checkedAt: string }) => {
      if (Deno.env.get('CLERK_ISSUER') !== PRODUCTION_CLERK_ISSUER || Deno.env.get('CLERK_CONTINUITY_ENABLED') !== 'true') throw Error('continuity_unavailable');
      const receipt = await initializeProductionProfile(db(), identity, PRODUCTION_CLERK_ISSUER, {
        sourceSecret: Deno.env.get('CLERK_CONTINUITY_SOURCE_SECRET_KEY'), sourceIssuer: Deno.env.get('CLERK_CONTINUITY_SOURCE_ISSUER'),
      });
      return { profileId: String(receipt.profileId), subject: String(receipt.subject) };
    },
    store: {
      hold: (live: boolean, digest: string, price: string, ipHash: string | null) => checked(db().rpc('hold_pay_first_founding', { p_livemode: live, p_nonce_digest: digest, p_price_id: price, p_ip_hash: ipHash })),
      saveSession: (signup: string, session: string) => checked(db().rpc('save_pay_first_session', { p_signup_id: signup, p_session_id: session })),
      release: async (session: string, proof: unknown) => (await checked(db().rpc('release_pay_first_hold', { p_session_id: session, p_proof: proof }))) === true,
      sweepBatch: (live: boolean, limit: number) => checked(db().rpc('pay_first_sweep_batch', { p_livemode: live, p_limit: limit })),
      claim: (signup: string, session: string, via: string, eventId: string | null) => checked(db().rpc('claim_pay_first_provision', { p_signup_id: signup, p_session_id: session, p_via: via, p_event_id: eventId })),
      markPaid: (signup: string, token: string, sub: string, customer: string, email: string) => checked(db().rpc('mark_pay_first_paid', { p_signup_id: signup, p_token: token, p_subscription_id: sub, p_customer_id: customer, p_email: email })),
      adopt: (a: { signupId: string; token: string; profileId: string; subject: string; customerId: string; email: string; productId: string; priorAttempt?: string; priorProof?: unknown }) =>
        checked(db().rpc('adopt_pay_first_signup', { p_signup_id: a.signupId, p_token: a.token, p_profile_id: a.profileId, p_clerk_subject: a.subject, p_customer_id: a.customerId,
          p_verified_email: a.email, p_product_id: a.productId, p_prior_attempt: a.priorAttempt ?? null, p_prior_proof: a.priorProof ?? null })),
      finish: (signup: string, token: string, state: string | null, reason: string | null, createdUser: boolean | null) => checked(db().rpc('finish_pay_first_provision', { p_signup_id: signup, p_token: token, p_state: state, p_reason: reason, p_created_user: createdUser })),
      tokenGate: async (signup: string) => (await checked(db().rpc('pay_first_token_gate', { p_signup_id: signup }))) === true,
      emailUnproven: async (profile: string) => (await checked(db().rpc('pay_first_email_unproven', { p_profile_id: profile }))) === true,
      prove: (profile: string, subject: string) => checked(db().rpc('prove_pay_first_email', { p_profile_id: profile, p_clerk_subject: subject })),
      row: (signup: string) => /^[0-9a-f-]{36}$/.test(signup || '') ? row('signup_id', signup) : null,
      rowBySession: (session: string) => row('session_id', session),
      rowBySubscription: (sub: string) => row('subscription_id', sub),
      rowByProfile: async (profile: string) => {
        const rows = await checked(db().from('pay_first_signups').select('signup_id,clerk_subject,token_issued_at').eq('profile_id', profile).eq('created_user', true).order('created_at').limit(1));
        return Array.isArray(rows) ? rows[0] ?? null : null;
      },
    },
  };
}
