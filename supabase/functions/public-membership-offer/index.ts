import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPublicMembershipOfferHandler } from '../_shared/publicMembershipOffer.mjs';

let database: ReturnType<typeof createClient>;
serve(createPublicMembershipOfferHandler({ readOffer: async () => {
  database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await database.rpc('public_membership_offer');
  if (error) throw Error('Public membership policy unavailable');
  return data;
} }));
