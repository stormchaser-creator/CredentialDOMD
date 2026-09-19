import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5';
import { createVeraSourceHandler, createPublicSourceFetcher } from '../_shared/veraSources.mjs';
import { VERA_SOURCE_ORIGIN } from '../_shared/veraSourceRegistry.mjs';

const issuer = Deno.env.get('CLERK_ISSUER') || '';
let jwks: ReturnType<typeof createRemoteJWKSet>;
let database: ReturnType<typeof createClient>;
const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
});

// Deploy with gateway JWT verification off only because this handler verifies
// Clerk RS256 itself. No alternate email/admin/legacy-Supabase identity path.
Deno.serve(createVeraSourceHandler({
  enabled: () => Deno.env.get('VERA_SOURCE_RETRIEVAL_ENABLED') === 'true'
    && /^https:\/\/[A-Za-z0-9.-]+\/?$/.test(issuer)
    && !!Deno.env.get('SUPABASE_URL') && !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  async authenticate(req: Request) {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
    if (!bearer) return null;
    try {
      jwks ||= createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(bearer[1], jwks, { issuer, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '1 hour' });
      if (typeof payload.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub) || (payload.azp && payload.azp !== VERA_SOURCE_ORIGIN)) return null;
      const { data, error } = await db().from('profiles').select('id').eq('auth_user_id', payload.sub).eq('access_status', 'active').maybeSingle();
      return !error && data ? { profileId: data.id, subject: payload.sub } : null;
    } catch { return null; }
  },
  async admit(owner: { profileId: string; subject: string }, sourceId: string) {
    const { data, error } = await db().rpc('admit_vera_source', { p_profile: owner.profileId, p_subject: owner.subject, p_source_id: sourceId });
    if (error) throw Error('Source admission unavailable');
    return data;
  },
  read: createPublicSourceFetcher(),
}));
