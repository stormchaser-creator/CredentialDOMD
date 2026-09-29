/**
 * invite-to-join, the I/O: Clerk identity, the service-role database and
 * Resend. Every decision is in inviteToJoin.mjs; this file only answers its
 * questions, so the rules are tested without any of this.
 *
 * Tables and functions touched (service role):
 *   profiles                         read: the administrator's own name, degree and mailbox
 *   public_membership_offer()        read: the live public offer (what the website shows)
 *   invite_to_join_status()          read: when this address was last invited, today's count
 *   reserve_invite_to_join()         the cooldown and cap, and the 'sending' row, under one lock
 *   finish_invite_to_join()          the provider's answer
 *   list_invite_to_join_sends()      the recent sends
 * (migration 20260929131500). Nothing here writes an account, a grant,
 * beta_access or billing.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "./clerkAuth.ts";

export function inviteToJoinDependencies() {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const resendApi = (env("RESEND_API_BASE") || "https://api.resend.com").replace(/\/$/, "");
  let client: SupabaseClient | null = null;
  const db = () => client ||= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>, what: string): Promise<unknown> => {
    const { data, error } = await query;
    if (error) throw new Error(`${what} failed: ${(error as { message?: string })?.message ?? String(error)}`);
    return data;
  };

  return {
    origin: "https://credentialdomd.com",
    configured: () => !!(env("RESEND_API_KEY") && env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")),

    async authenticate(req: Request) {
      const who = await clerkProfile(req);
      return who ? { profileId: who.profileId, clerkSubject: who.clerkSubject, isAdmin: who.isAdmin === true } : null;
    },

    store: {
      inviter: (profileId: string) => checked(db().from("profiles")
        .select("id, name, degree_type, email, verified_email").eq("id", profileId).maybeSingle(), "inviter read"),
      offer: () => checked(db().rpc("public_membership_offer"), "public offer read"),
      status: (actor: string, email: string) => checked(db().rpc("invite_to_join_status", { p_actor: actor, p_email: email }), "invite status read"),
      reserve: (actor: string, email: string, name: string | null, resend: boolean, templateVersion: string, phase: string, cents: number) =>
        checked(db().rpc("reserve_invite_to_join", {
          p_actor: actor, p_email: email, p_name: name, p_explicit_resend: resend,
          p_template_version: templateVersion, p_offer_phase: phase, p_offer_annual_cents: cents,
        }), "invite reservation"),
      finish: (id: string, status: string, providerId: string | null) =>
        checked(db().rpc("finish_invite_to_join", { p_id: id, p_status: status, p_provider_id: providerId }), "invite finish"),
      list: (actor: string, limit: number) => checked(db().rpc("list_invite_to_join_sends", { p_actor: actor, p_limit: limit }), "invite list"),
    },

    /**
     * One POST to Resend. "sent" with the id, "failed" when Resend answered
     * that it did not take the message, "unknown" when it may have (no answer,
     * a timeout, a server error, an idempotency conflict).
     */
    async sendMail(payload: Record<string, unknown>, idempotencyKey: string) {
      let response: Response;
      try {
        response = await fetch(`${resendApi}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env("RESEND_API_KEY")}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        console.error("invite-to-join: Resend gave no answer:", err instanceof Error ? err.message : String(err));
        return { state: "unknown" };
      }
      let text = "";
      try { text = await response.text(); } catch { /* the status still says what happened */ }
      if (response.ok) {
        let id: string | null = null;
        try { id = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* body not JSON */ }
        return { state: "sent", providerId: id };
      }
      console.error("invite-to-join: Resend refused:", response.status, text.slice(0, 300));
      return { state: [400, 401, 403, 404, 422, 429].includes(response.status) ? "failed" : "unknown" };
    },
  };
}
