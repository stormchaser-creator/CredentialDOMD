import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingDependencies } from './billingDependencies.ts';

/** No provider call and no email: a reservation is a database record only. */
export function lifetimeGiftDependencies() {
  const base = billingDependencies();
  let client: ReturnType<typeof createClient>;
  const db = () => client ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw Error('Lifetime gift state unavailable');
    return data;
  };
  type Actor = { profileId: string; clerkSubject: string };
  return {
    // Same switch as the reviewed per-account gift: one owner decision enables both.
    enabled: Deno.env.get('CREDENTIALDOMD_ADMIN_LIFETIME_ENABLED') === 'true',
    mode: base.mode, origin: base.origin, authenticate: base.authenticate,
    store: {
      reserve: (actor: Actor, email: string, reason: string, live: boolean) => checked(db().rpc('reserve_lifetime_gift', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_email: email, p_reason: reason, p_live: live })),
      revoke: (actor: Actor, id: string) => checked(db().rpc('revoke_lifetime_gift_reservation', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_id: id })),
      list: (actor: Actor, live: boolean) => checked(db().rpc('list_lifetime_gift_reservations', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_live: live })),
    },
  };
}
