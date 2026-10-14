// email-unsubscribe: the unsubscribe link in reminder emails. The token, the
// pages and the request handling are _shared/emailUnsubscribe.mjs (tested in
// node); this file only connects them to the secret and the database.
//
//   GET  ?t=<token>                  a page with one button; records nothing.
//   POST t=<token> (the button)      records the opt out, answers with a page.
//   POST ?t=<token>, body List-Unsubscribe=One-Click
//                                    RFC 8058 one click from the mail provider.
//
// People reach it through https://credentialdomd.com/api/unsubscribe (the
// Worker relay in cloudflare/credentialdomd-api), because the Supabase gateway
// serves HTML from *.supabase.co as text/plain. EMAIL_UNSUBSCRIBE_BASE
// overrides the form's action (the QA lab).
//
// The opt out is public.record_email_opt_out (migration
// 20261014130000_email_opt_outs.sql), service role only, once per profile and
// list however often the link is used. Senders ask public.email_opted_out
// before every message.
//
// Secrets: EMAIL_UNSUBSCRIBE_SECRET (new, at least 32 characters; it signs
// the tokens and nothing else, so rotating the hook secret never breaks a
// link already sent). To rotate it, set the old value as
// EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS and a new one as EMAIL_UNSUBSCRIBE_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are automatic.
//
// Deploy with --no-verify-jwt: the person opening the link and the mail
// provider's one click POST carry no session. The token is the proof.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createEmailUnsubscribeHandler, UNSUBSCRIBE_BASE } from '../_shared/emailUnsubscribe.mjs';

// Untyped, as in forwarding-address: the client's generated types know no RPC here.
// deno-lint-ignore no-explicit-any
let database: any;
const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

serve(createEmailUnsubscribeHandler({
  secrets: () => [Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') || '', Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS') || ''],
  actionUrl: Deno.env.get('EMAIL_UNSUBSCRIBE_BASE') || UNSUBSCRIBE_BASE,
  store: {
    record: async (profileId: string, list: string, source: string) => {
      const { data, error } = await db().rpc('record_email_opt_out', { p_profile_id: profileId, p_list: list, p_source: source });
      if (error) throw Error(`record_email_opt_out failed: ${error.code ?? 'unknown'}`);
      return data;
    },
  },
}));
