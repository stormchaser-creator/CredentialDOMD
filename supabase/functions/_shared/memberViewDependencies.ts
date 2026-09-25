import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from './clerkAuth.ts';

/**
 * I/O for admin-member-view. Identity is the Clerk token verified in
 * clerkAuth.ts (admin = a row in app_admins, never an address), and every
 * database function checks the administrator again from the verified profile
 * and subject. Reads use the service role with the column lists the handler
 * passes (memberView.mjs); nothing here selects "*".
 */
export function memberViewDependencies() {
  let client: ReturnType<typeof createClient>;
  const db = () => client ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw Error('Support view database unavailable'); // Never log member data or tokens.
    return data;
  };
  type Actor = { actor: string; subject: string };
  const rpc = (name: string, args: Record<string, unknown>) => checked(db().rpc(name, args));
  return {
    enabled: () => Deno.env.get('MEMBER_SUPPORT_VIEW_ENABLED') === 'true' && !!Deno.env.get('SUPABASE_URL') && !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    async authenticate(req: Request) {
      const profile = await clerkProfile(req);
      return profile ? { profileId: profile.profileId, clerkSubject: profile.clerkSubject, isAdmin: profile.isAdmin } : null;
    },
    async readFile(path: string, limit: number) {
      if (!/^user_[A-Za-z0-9]+\/[0-9a-f-]{36}$/.test(path)) throw Error('Invalid document path');
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/authenticated/documents/${path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}`, apikey: key }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok || Number(response.headers.get('content-length')) > limit || !response.body) { await response.body?.cancel(); throw Error('Document unavailable'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw Error('Document too large'); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
    store: {
      start: (p: Actor & { member: string; reason: string; requestId: string }) => rpc('member_view_session_start', { p_actor: p.actor, p_subject: p.subject, p_member: p.member, p_reason: p.reason, p_request: p.requestId }),
      check: (p: Actor & { session: string }) => rpc('member_view_session_check', { p_actor: p.actor, p_subject: p.subject, p_session: p.session }),
      recordFile: (p: Actor & { session: string; document: string; name: string }) => rpc('member_view_file_record', { p_actor: p.actor, p_subject: p.subject, p_session: p.session, p_document: p.document, p_name: p.name }),
      end: (p: Actor & { session: string }) => rpc('member_view_session_end', { p_actor: p.actor, p_subject: p.subject, p_session: p.session }),
      profile: (member: string, columns: string[]) => checked(db().from('profiles').select(columns.join(',')).eq('id', member).maybeSingle()),
      // PostgREST caps a response at 1,000 rows; page up to the handler's cap.
      async rows(table: string, columns: string[], member: string, max: number) {
        const PAGE = 1000; let rows: unknown[] = [];
        for (let start = 0; start < max; start += PAGE) {
          const page = await checked(db().from(table).select(columns.join(',')).eq('user_id', member)
            .order('created_at', { ascending: false }).order('id', { ascending: true }).range(start, Math.min(start + PAGE, max) - 1)) as unknown[];
          rows = rows.concat(page || []);
          if (!page || page.length < Math.min(PAGE, max - start)) return { rows, truncated: false };
        }
        return { rows, truncated: true };
      },
      document: (member: string, id: string) => checked(db().from('documents').select('id,name,mime_type,type,storage_path,linked_to').eq('user_id', member).eq('id', id).maybeSingle()),
      recordExists: async (table: string, member: string, id: string) => !!(await checked(db().from(table).select('id').eq('user_id', member).eq('id', id).maybeSingle())),
      storageSubjects: (member: string) => rpc('clerk_storage_subjects', { p_profile: member }),
    },
  };
}
