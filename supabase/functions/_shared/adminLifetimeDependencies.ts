import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingDependencies } from './billingDependencies.ts';
import { verifiedPrimaryMailbox } from './selfServiceSignup.mjs';

/** Only read-only provider methods are used by the gift handler. */
export function adminLifetimeDependencies() {
  const base = billingDependencies();
  let client: ReturnType<typeof createClient>;
  const db = () => client ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw Error('Lifetime access state unavailable');
    return data;
  };
  type Actor = { profileId: string; clerkSubject: string };
  type Context = { target: { profileId: string; clerkSubject: string } };
  type Review = { reviewId: string };
  return {
    enabled: Deno.env.get('CREDENTIALDOMD_ADMIN_LIFETIME_ENABLED') === 'true',
    mode: base.mode, origin: base.origin, authenticate: base.authenticate, stripe: base.stripe,
    verifiedPrimary: async (subject: string) => {
      if (!/^user_[A-Za-z0-9]+$/.test(subject)) throw Error('Invalid target identity');
      const key = Deno.env.get('CLERK_SECRET_KEY') || '';
      if (!['test', 'live'].includes(base.mode) || !key.startsWith(`sk_${base.mode}_`)) throw Error('Clerk backend mode mismatch');
      const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw Error('Target identity unavailable');
      return verifiedPrimaryMailbox(await response.json(), subject);
    },
    store: {
      prepareReview: (actorId: string, actorSubject: string, targetId: string, targetSubject: string, live: boolean) => checked(db().rpc('admin_lifetime_context', {
        p_actor: actorId, p_actor_subject: actorSubject, p_target: targetId, p_subject: targetSubject, p_live: live,
      })),
      saveReview: (actor: Actor, context: Context, email: string, proof: unknown) => checked(db().rpc('save_admin_lifetime_review', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_context: context, p_live: base.mode === 'live', p_email: email, p_proof: proof,
      })),
      review: (reviewId: string, actorId: string, actorSubject: string) => checked(db().rpc('read_admin_lifetime_review', {
        p_review: reviewId, p_actor: actorId, p_actor_subject: actorSubject,
      })),
      grant: (actor: Actor, review: Review, requestId: string, reason: string, email: string, proof: unknown) => checked(db().rpc('grant_admin_lifetime_access', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_review: review.reviewId, p_request: requestId, p_reason: reason, p_email: email, p_proof: proof,
      })),
    },
  };
}
