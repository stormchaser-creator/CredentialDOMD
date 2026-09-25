import { createCredentialPortalHandler } from '../_shared/credentialPortalHandler.mjs';
import { credentialPortalDependencies } from '../_shared/credentialPortalDependencies.ts';

// The Supabase JWT gateway cannot validate the Clerk or opaque recipient token.
// Future deployment must disable gateway JWT verification; the handler verifies both itself.
// The code-level policy is on; runtime env gates (CREDENTIAL_PORTAL_ENABLED,
// CREDENTIAL_PORTAL_PRIVACY_READY, the secret) keep it off until activation.
Deno.serve(createCredentialPortalHandler(credentialPortalDependencies()));
