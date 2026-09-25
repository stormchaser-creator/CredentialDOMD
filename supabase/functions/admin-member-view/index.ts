// admin-member-view: an administrator's read-only view of a member's account,
// only while the member has allowed it (ticket d45e857c, phase 2). The rules
// are in _shared/memberViewHandler.mjs and _shared/memberView.mjs, tested in
// tests/member-view/.
//
// Deploy with gateway JWT checks off; the handler verifies the Clerk token
// itself (_shared/clerkAuth.ts), like send-packet-email:
//   supabase functions deploy admin-member-view --no-verify-jwt
// Off until MEMBER_SUPPORT_VIEW_ENABLED is "true" (answers 503).
import { createMemberViewHandler } from '../_shared/memberViewHandler.mjs';
import { memberViewDependencies } from '../_shared/memberViewDependencies.ts';

Deno.serve(createMemberViewHandler(memberViewDependencies()));
