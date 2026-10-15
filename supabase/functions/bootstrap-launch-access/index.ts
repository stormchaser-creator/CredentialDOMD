import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from '../_shared/clerkAuth.ts';
import { createSelfServiceSignupHandler } from '../_shared/selfServiceSignup.mjs';
import { CLERK_API_BASE } from '../_shared/clerkContinuity.ts';

const mode = Deno.env.get('CREDENTIALDOMD_BILLING_MODE') || 'disabled';
let db: ReturnType<typeof createClient>;
const database = () => db ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
  const { data, error } = await query;
  if (error) throw Error('Signup state unavailable');
  return data;
};
serve(createSelfServiceSignupHandler({
  mode, authenticate: clerkProfile,
  profile: (id: string) => checked(database().from('profiles').select('id,auth_user_id,access_status,deleted_at').eq('id', id).maybeSingle()),
  clerkUser: async (subject: string) => {
    const key = Deno.env.get('CLERK_SECRET_KEY') || '';
    if (!['test', 'live'].includes(mode) || !key.startsWith(`sk_${mode}_`)) throw Error('Clerk backend mode mismatch');
    const response = await fetch(`${CLERK_API_BASE}/v1/users/${encodeURIComponent(subject)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw Error('Clerk identity unavailable');
    return response.json();
  },
  enroll: async (profile: string, subject: string, live: boolean, mailbox: string) => {
    const client = database();
    const args = Object.freeze({ p_profile_id: profile, p_clerk_subject: subject, p_livemode: live, p_verified_primary_email: mailbox });
    let result = await client.rpc('bootstrap_limited_signup', args);
    // Only this transaction is replay-safe: profile/mailbox locks and unique
    // enrollment/grant keys preserve a committed first call without restarting
    // beta, claiming another gift or creating billing. Every attempt rechecks
    // current ownership, revocation and policy; consume the second answer.
    if (result.error && [502, 503, 504].includes(result.status)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      // Bound recovery lock/transport waiting without changing the first call.
      result = await client.rpc('bootstrap_limited_signup', args).abortSignal(AbortSignal.timeout(5000));
    }
    return checked(Promise.resolve(result));
  },
}));
