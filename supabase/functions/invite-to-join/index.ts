/**
 * invite-to-join: an administrator emails one person an invitation to JOIN
 * CredentialDOMD (owner decision, 2026-09-29). The person signs up with that
 * address and pays like anyone else; nothing here grants access or changes an
 * account. Decisions: _shared/inviteToJoin.mjs. I/O: _shared/inviteToJoinDependencies.ts.
 *
 * Deploy with --no-verify-jwt (Clerk RS256 tokens fail the gateway check; the
 * token is verified in _shared/clerkAuth.ts). Needs RESEND_API_KEY,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CLERK_ISSUER, and migration
 * 20260929131500_invite_to_join_sends.sql applied first.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createInviteToJoinHandler } from "../_shared/inviteToJoin.mjs";
import { inviteToJoinDependencies } from "../_shared/inviteToJoinDependencies.ts";

serve(createInviteToJoinHandler(inviteToJoinDependencies()));
