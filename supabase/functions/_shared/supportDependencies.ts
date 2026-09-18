import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.97.0';
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5';
import { Webhook } from 'https://esm.sh/svix@1.40.0';
import { resendOutcome } from './supportPolicy.mjs';

/** No credential is exposed to the answer decision or an engineering worker. */
export function supportDependencies() {
  const env = (name: string) => Deno.env.get(name) || '';
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query; if (error) throw Error('Support database operation failed'); return data;
  };
  const rpc = (name: string, args: Record<string, unknown> = {}) => checked(db.rpc(name, args));
  const issuer = env('CLERK_ISSUER');
  const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : null;
  async function sameSecret(given: string, expected: string) {
    if (expected.length < 32 || !given || given.length > 512) return false;
    const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    const [a,b] = await Promise.all([hash(given), hash(expected)]); let diff=0;
    for (let i=0;i<a.length;i++) diff |= a[i]^b[i];
    return diff===0;
  }
  return {
    mode: env('SUPPORT_AUTOMATION_MODE') || 'disabled',
    outboundEnabled: env('SUPPORT_OUTBOUND_ENABLED') === 'true',
    canaryVerified: env('SUPPORT_CANARY_VERIFIED') === 'true',
    authorize: async (req: Request, required: string) => {
      const token=(req.headers.get('authorization') || '').replace(/^Bearer\s+/i,'');
      if (!['owner','customer','customer_read'].includes(required)) {
        const names: Record<string,string> = { intake:'SUPPORT_INTAKE_KEY',worker:'SUPPORT_WORKER_KEY',delivery:'SUPPORT_DELIVERY_KEY' };
        if (!names[required] || !await sameSecret(token,env(names[required]))) return null;
        // Do not permit accidental cross-capability reuse of the same secret.
        if (Object.entries(names).some(([role,name]) => role!==required && env(name)===env(names[required]))) return null;
        return { role:required };
      }
      if (!issuer || !jwks || !token) return null;
      try {
        const { payload } = await jwtVerify(token,jwks,{ issuer, algorithms:['RS256'],requiredClaims:['sub','exp','iat'],maxTokenAge:'1 hour' });
        if (typeof payload.sub!=='string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub)
          || (payload.azp && payload.azp!=='https://credentialdomd.com')) return null;
        const profile = await checked(db.from('profiles').select('id,access_status').eq('auth_user_id',payload.sub).maybeSingle()) as {id:string;access_status:string}|null;
        if (!profile) return null;
        if (required==='customer_read') return {role:required,profileId:profile.id,clerkSub:payload.sub};
        if (required==='customer') return profile.access_status==='active' ? {role:'customer',profileId:profile.id,clerkSub:payload.sub} : null;
        const admin = await checked(db.from('app_admins').select('profile_id').eq('profile_id',profile.id).maybeSingle());
        return admin ? { role:'owner',clerkSub:payload.sub } : null;
      } catch { return null; }
    },
    verifyReceipt: async (raw: string, headers: Headers) => {
      const secret=env('SUPPORT_RESEND_WEBHOOK_SECRET');
      if (!secret) throw Error('Webhook not configured');
      return new Webhook(secret).verify(raw, { 'svix-id':headers.get('svix-id') || '', 'svix-timestamp':headers.get('svix-timestamp') || '', 'svix-signature':headers.get('svix-signature') || '' });
    },
    send: async (envelope: { id:string;recipient:string;subject:string;body:string;idempotency_key:string }) => {
      // No fallback provider or credentials. This runs only after both DB and
      // runtime gates and the verified-recipient check have succeeded.
      const key=env('RESEND_API_KEY');
      if (!key) return { outcome:'failed',providerId:null }; // known pre-submission failure
      const response=await fetch('https://api.resend.com/emails', {
        method:'POST', signal:AbortSignal.timeout(20000),
        headers:{ Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':envelope.idempotency_key },
        body:JSON.stringify({ from:'CredentialDO Support <support@credentialdomd.com>',to:[envelope.recipient],reply_to:'support@credentialdomd.com',
          subject:envelope.subject,text:`${envelope.body}\n\nCredentialDO Support\nhttps://credentialdomd.com/app/#support`,tags:[{name:'support_outbox',value:envelope.id}] }),
      });
      const payload=await response.json().catch(()=>null);
      return resendOutcome(response,payload);
    },
    store: {
      listTickets:(profile:string)=>rpc('support_list_customer_tickets',{p_profile_id:profile}),
      readTicket:(profile:string,ticket:string,before:string|null)=>rpc('support_read_customer_ticket',{p_profile_id:profile,p_ticket_id:ticket,p_before_id:before}),
      submit:(profile:string,request:string,ticket:string|null,subject:string|null,body:string,category:string,priority:string)=>rpc('support_submit',{p_profile_id:profile,p_request_id:request,p_ticket_id:ticket,p_subject:subject,p_body:body,p_category:category,p_priority:priority}),
      ingest:(ticket:string,message:string|null)=>rpc('support_ingest',{p_ticket_id:ticket,p_message_id:message}),
      claimJob:(kind:string)=>rpc('support_claim_job',{p_kind:kind}),
      knowledge:()=>checked(db.from('support_knowledge').select('*').eq('approved',true).gt('expires_at',new Date().toISOString()).limit(200)),
      completeJob:(id:string,token:string,knowledge:string|null,revision:string|null)=>rpc('support_complete_job',{p_job_id:id,p_token:token,p_knowledge_id:knowledge,p_knowledge_revision:revision}),
      claimOutbox:()=>rpc('support_claim_outbox'),
      beginSend:(id:string,token:string)=>rpc('support_begin_send',{p_outbox_id:id,p_token:token}),
      finishSend:(id:string,attempt:string,outcome:string,providerId:string|null)=>rpc('support_finish_send',{p_outbox_id:id,p_attempt_id:attempt,p_outcome:outcome,p_provider_id:providerId}),
      recordReceipt:(r:{eventId:string;outboxId:string;providerId:string;kind:string})=>rpc('support_record_receipt',{p_event_id:r.eventId,p_outbox_id:r.outboxId,p_provider_id:r.providerId,p_kind:r.kind}),
      requestApproval:(ticket:string,capability:string,action:unknown)=>rpc('support_request_approval',{p_ticket_id:ticket,p_capability:capability,p_action:action}),
      decideApproval:(id:string,sub:string,approve:boolean)=>rpc('support_decide_approval',{p_id:id,p_clerk_sub:sub,p_approve:approve}),
    },
  };
}
