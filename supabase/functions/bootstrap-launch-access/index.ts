import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from '../_shared/clerkAuth.ts';
import { createSelfServiceSignupHandler } from '../_shared/selfServiceSignup.mjs';

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
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw Error('Clerk identity unavailable');
    return response.json();
  },
  enroll: (profile: string, subject: string, live: boolean, mailbox: string) => checked(database().rpc('bootstrap_limited_signup', {
    p_profile_id: profile, p_clerk_subject: subject, p_livemode: live, p_verified_primary_email: mailbox,
  })),
}));
