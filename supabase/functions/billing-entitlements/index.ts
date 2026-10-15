import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from '../_shared/clerkAuth.ts';
import { createAccessPolicyHandler } from '../_shared/accessPolicyHandler.mjs';

serve(createAccessPolicyHandler({
  authenticate: async (req: Request) => {
    const identity = await clerkProfile(req);
    if (!identity) return null;
    const { data, error } = await identity.db.from('profiles').select('id,auth_user_id,access_status').eq('id', identity.profileId).maybeSingle();
    if (error || data?.auth_user_id !== identity.clerkSubject) throw Error('Profile unavailable');
    return data;
  },
  readOwnSnapshot: async (req: Request) => {
    // The user's verified JWT reaches RLS; no service-role impersonation or email match.
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('authorization') || '' } },
    });
    let result = await db.rpc('credentialdo_access_snapshot');
    // This STABLE RPC only reads the caller's access state. Retry one explicit
    // gateway refusal with the same JWT; never replay authentication or writes.
    if (result.error && [502, 503, 504].includes(result.status)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      result = await db.rpc('credentialdo_access_snapshot');
    }
    if (result.error) throw Error('Access snapshot unavailable');
    return result.data;
  },
}));
