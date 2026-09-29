import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from './clerkAuth.ts';

/**
 * admin-mailbox-repair's I/O. Deploy with --no-verify-jwt (scripts/deploy-clerk-functions.sh
 * finds it through clerkAuth.ts): the Clerk JWT and the app_admins row are checked in the
 * handler, and repair_account_mailboxes checks the admin again.
 *
 * CLERK_SECRET_KEY is read when a run starts and handed to the Clerk request only. It is
 * never returned, logged or put into an error message.
 */
export function mailboxRepairDependencies() {
  let client: ReturnType<typeof createClient>;
  const db = () => client ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  type Actor = { profileId: string; clerkSubject: string };
  type Row = { subject: string; email: string; updated_ms: number };
  return {
    origin: 'https://credentialdomd.com',
    authenticate: clerkProfile,
    issuer: Deno.env.get('CLERK_ISSUER') || '',
    clerkSecret: () => Deno.env.get('CLERK_SECRET_KEY') || '',
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    repair: async (actor: Actor, users: Row[], apply: boolean) => {
      const { data, error } = await db().rpc('repair_account_mailboxes', {
        p_actor: actor.profileId, p_actor_subject: actor.clerkSubject, p_users: users, p_apply: apply,
      });
      // The message may quote the input, which carries addresses: never passed on.
      if (error) throw Error('Mailbox repair unavailable');
      return data;
    },
    log: (line: string) => console.log(line),
  };
}
