import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5';
import { CREDENTIAL_PORTAL_POLICY, createPortalCrypto } from './credentialPortalCrypto.mjs';

/** Dedicated subject-only verifier: email/isAdmin never confer owner access. */
export function credentialPortalDependencies() {
  let database: ReturnType<typeof createClient>;
  let jwks: ReturnType<typeof createRemoteJWKSet>;
  let encryption: ReturnType<typeof createPortalCrypto>;
  const issuer = Deno.env.get('CLERK_ISSUER') || '';
  const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query; if (error) throw Error('Private portal database unavailable'); return data;
  };
  const rpc = (name: string, args: Record<string, unknown>) => checked(db().rpc(`credential_portal_${name}`, args));
  const cryptoBox = () => encryption ||= createPortalCrypto(Deno.env.get('CREDENTIAL_PORTAL_SECRET'));
  const publicInvite = async (row: Record<string, any>) => {
    const [docs, mail, audit] = await Promise.all([
      checked(db().from('credential_portal_documents').select('document_id').eq('invite_id', row.id)),
      checked(db().from('credential_portal_outbox').select('state').eq('invite_id', row.id).eq('kind', 'invite').maybeSingle()),
      checked(db().from('credential_portal_audit').select('event,document_id,intent,bytes_prepared,created_at').eq('invite_id', row.id).order('created_at', { ascending: false }).limit(20)),
    ]);
    const status = row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= Date.now() ? 'expired' : row.redeemed_at ? 'redeemed' : 'pending';
    return { id: row.id, recipientEmail: row.recipient_email, expiresAt: row.expires_at, createdAt: row.created_at, status, deliveryState: (mail as any)?.state || 'unavailable', documentCount: (docs as any[])?.length || 0, audit };
  };
  const ownerInviteQuery = (owner: string, subject: string) => db().from('credential_portal_invites').select('id,recipient_email,created_at,expires_at,revoked_at,redeemed_at').eq('owner_profile_id', owner).eq('owner_subject', subject);
  return {
    assertConfigured() {
      if (Deno.env.get('CREDENTIAL_PORTAL_ENABLED') !== 'true' || Deno.env.get('CREDENTIAL_PORTAL_PRIVACY_READY') !== 'true' || !/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(issuer)
        || !Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || !Deno.env.get('RESEND_API_KEY')) throw Error('Private portal is not configured');
      cryptoBox();
    },
    async authenticateOwner(req: Request) {
      const matched = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
      if (!matched || !issuer) return null;
      try {
        jwks ||= createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
        const { payload } = await jwtVerify(matched[1], jwks, { issuer, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '1 hour' });
        if (typeof payload.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub) || (payload.azp && payload.azp !== CREDENTIAL_PORTAL_POLICY.origin)) return null;
        const profile = await checked(db().from('profiles').select('id,auth_user_id').eq('auth_user_id', payload.sub).maybeSingle()) as { id: string; auth_user_id: string } | null;
        return profile ? { profileId: profile.id, subject: payload.sub } : null;
      } catch { return null; } // Never log token, claim values, email or verification payload.
    },
    crypto: {
      seal: (id: string, payload: unknown) => cryptoBox().seal(id, payload),
      open: (id: string, envelope: string) => cryptoBox().open(id, envelope),
      otpDigest: (id: string, version: string, code: string) => cryptoBox().otpDigest(id, version, code),
      recipientLimitKey: (email: string) => cryptoBox().recipientLimitKey(email),
    },
    async sendMail(payload: { to: string; subject: string; text: string }, idempotencyKey: string) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ from: 'CredentialDOMD <docs@credentialdomd.com>', to: [payload.to], subject: payload.subject, text: payload.text }), signal: AbortSignal.timeout(20000),
        });
        if (response.ok) { const result = await response.json(); return typeof result.id === 'string' && result.id.trim().length > 0 && result.id.length <= 200 ? { state: 'sent', providerId: result.id } : { state: 'unknown' }; }
        // Timeout, conflict/in-progress, rate limit and server errors are uncertain. Retry the SAME encrypted body/key.
        return { state: [400, 401, 403, 404, 422].includes(response.status) ? 'failed' : 'unknown' };
      } catch { return { state: 'unknown' }; }
    },
    async readFile(path: string, limit: number) {
      if (!/^user_[A-Za-z0-9]+\/[0-9a-f-]{36}$/.test(path)) throw Error('Invalid private document path');
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/authenticated/documents/${path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > limit || !response.body) { await response.body?.cancel(); throw Error('Private document unavailable'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw Error('Private document too large'); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
    store: {
      profile: (id: string) => checked(db().from('profiles').select('id,auth_user_id,access_status').eq('id', id).maybeSingle()),
      creationCapacity: (owner: string, subject: string) => rpc('creation_capacity', { p_owner: owner, p_subject: subject }),
      ownerDocuments: (owner: string, ids: string[]) => checked(db().from('documents').select('id,user_id,name,mime_type,size_bytes,storage_path').eq('user_id', owner).in('id', ids)),
      ownerRequest: (owner: string, request: string) => checked(db().from('credential_portal_invites').select('id,request_fingerprint,owner_subject').eq('owner_profile_id', owner).eq('request_id', request).maybeSingle()),
      ownerInvite: async (owner: string, subject: string, id: string) => { const row = await checked(ownerInviteQuery(owner, subject).eq('id', id).maybeSingle()); return row ? publicInvite(row as any) : null; },
      ownerInvites: async (owner: string, subject: string) => { const rows = await checked(ownerInviteQuery(owner, subject).order('created_at', { ascending: false }).limit(100)) as any[]; return Promise.all(rows.map(publicInvite)); },
      inviteMailId: async (id: string) => (await checked(db().from('credential_portal_outbox').select('id').eq('invite_id', id).eq('kind', 'invite').maybeSingle()) as any)?.id,
      inviteByToken: (token: string, email: string) => checked(db().from('credential_portal_invites').select('id,otp_version').eq('token_digest', token).eq('recipient_email', email).maybeSingle()),
      createInvite: (p: any) => rpc('create', { p_id: p.id, p_owner: p.owner, p_subject: p.subject, p_email: p.email, p_request: p.request, p_fingerprint: p.fingerprint, p_token_digest: p.tokenDigest, p_documents: p.documents, p_mail_id: p.mailId, p_encrypted_payload: p.encrypted }),
      claimOtp: (p: any) => rpc('claim_otp', { p_token_digest: p.tokenDigest, p_email: p.email, p_version: p.version, p_digest: p.otpDigest, p_mail_id: p.mailId, p_encrypted_payload: p.encrypted, p_recipient_limit_key: p.recipientLimitKey }),
      claimMail: (id: string, lease: string) => rpc('claim_mail', { p_id: id, p_lease: lease }),
      finishMail: (id: string, lease: string, state: string, providerId: string | null) => rpc('finish_mail', { p_id: id, p_lease: lease, p_state: state, p_provider_id: providerId }),
      redeem: (token: string, email: string, version: string, otpDigest: string, session: string) => rpc('redeem', { p_token_digest: token, p_email: email, p_version: version, p_otp_digest: otpDigest, p_session_digest: session }),
      access: (session: string, document: string | null, count: boolean) => rpc('access', { p_session_digest: session, p_document_id: document, p_count: count }),
      manifest: (id: string) => checked(db().from('credential_portal_documents').select('document_id,name,mime_type,size_bytes').eq('invite_id', id)),
      record: (session: string, document: string | null, event: string, intent: string | null, bytes: number | null) => rpc('record', { p_session_digest: session, p_document_id: document, p_event: event, p_intent: intent, p_bytes: bytes }),
      revoke: (owner: string, subject: string, invite: string) => rpc('revoke', { p_owner: owner, p_subject: subject, p_invite: invite }),
    },
  };
}
