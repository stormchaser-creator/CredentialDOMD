// owner-notify: the owner's activity, money and signup notices as one plain
// text email every 10 minutes (20261014110000_owner_notify_email.sql), so they
// no longer depend on the Mac Studio's launchd job, which stays as a backup.
// The composition and route are _shared/ownerNotify.mjs (tested in node).
//
// Deploy with --no-verify-jwt (the caller is pg_net, not a user). Auth is the
// x-hook-secret header against WELCOME_HOOK_SECRET, the same project-wide
// secret every pg_net caller presents (vault welcome_hook_secret).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createOwnerNotifyHandler } from '../_shared/ownerNotify.mjs';

let database: ReturnType<typeof createClient>;
const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await db().rpc(name, args);
  if (error) throw Error(`owner notify database call failed: ${name}`);
  return data;
};
const resendKey = () => Deno.env.get('RESEND_API_KEY') || '';

serve(createOwnerNotifyHandler({
  secret: () => Deno.env.get('WELCOME_HOOK_SECRET') || '',
  configured: () => resendKey().length > 0,
  store: {
    claim: (limit: number) => rpc('owner_notify_claim', { p_limit: limit }),
    prepare: (sendId: string, subject: string, body: string) => rpc('owner_notify_prepare', { p_send_id: sendId, p_subject: subject, p_body: body }),
    finish: (sendId: string, attempt: number, status: string, providerId: string | null, code: string | null) =>
      rpc('owner_notify_finish', { p_send_id: sendId, p_attempt: attempt, p_status: status, p_provider_id: providerId, p_error_code: code }),
  },
  deliver: async ({ from, to, subject, text, idempotencyKey }: { from: string; to: string; subject: string; text: string; idempotencyKey: string }) => {
    // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
    const response = await fetch(`${(Deno.env.get('RESEND_API_BASE') || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${resendKey()}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body?.id === 'string') return { status: 'sent', providerId: body.id };
    // A server error, a rate limit or an idempotency conflict may still have
    // delivered: unknown, and the same key covers the retry.
    return { status: response.status >= 500 || [409, 429].includes(response.status) ? 'unknown' : 'failed', code: `provider_${response.status}` };
  },
}));
